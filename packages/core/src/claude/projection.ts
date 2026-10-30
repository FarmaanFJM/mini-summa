// Reducer host and attribution.
//
// Holds the verified Reducer over the CURRENT project registry and feeds it from the SQLite raw log:
//   applyNew()  reads every entry after lastAppliedSeq, IN SEQ ORDER, and applies it. It never applies "what was just
//               appended": takeSnapshot appends hook entries itself while it drains a spool, so only the log position is
//               a safe cursor.
//   rebuild()   replays the whole log into a fresh Reducer built over a fresh registry (project roots changed, or startup)
//               and swaps it in when done, so readers never see a half-replayed state. Everything it produces is `replay`.
// After each entry it converts what the Reducer newly produced (derived events by index, reports and candidates by
// insertion order) into the contract types. Time stamps always come from the raw entries (never from the clock), so a
// replay reproduces the same values. Attribution (project) is: the session binding (managed, then manual), then the
// registry match the Reducer made from the working directory. It never looks at what is focused.
import { Reducer, redactString } from '@minisumma/claude-integration';
import type { Candidate, DerivedEvent, RawEntry, ReducerEntry, ReducerSession, RegistryResolver, Report, SessionEnv } from '@minisumma/claude-integration';
import { makeSessionKey } from '@minisumma/shared';
import type { EnvId, ProjectResolution, SessionKey, SessionState } from '@minisumma/shared';
import type { Db } from '@minisumma/storage';
import type { CapturedCandidate, CapturedReport, Clock, ClaudeDerivedEvent, Logger, ProjectsService } from '../contracts.ts';
import type { RawStore } from './rawStore.ts';
import { readBindings } from './sessionBindings.ts';
import type { BindingRow } from './sessionBindings.ts';

export interface ProjectionDeps {
  db: Db;
  rawStore: Pick<RawStore, 'since' | 'get'>;
  projects: Pick<ProjectsService, 'registry' | 'get'>;
  hostEnv: EnvId;
  clock: Clock;
  log?: Pick<Logger, 'warn' | 'error'>;
  /** Entries per replay step (the event loop gets a turn between steps). */
  chunkSize?: number;
}

export interface Attribution {
  projectId: string | null;
  projectName: string | null;
  resolution: ProjectResolution;
}

export interface AttributionContext {
  bindings: Map<string, BindingRow>;
  project(id: string): { id: string; name: string } | null;
}

/** What the observer remembers about a session beyond the Reducer's state. All of it comes from the raw log. */
export interface SessionFacts {
  /** First and latest hook receipt time (the hook process's own clock; display only, never used for ordering). */
  firstAt: string | null;
  lastHookAt: string | null;
  /** How many hook receipts were applied for this session (a counter, so "did anything new arrive" needs no clock). */
  hookCount: number;
  /** Raw-log position of the newest hook receipt applied for this session (0 = none). Order in the log, not wall time. */
  lastHookSeq: number;
  /** Time of the latest startup/resume/fork SessionStart. */
  startedAtHook: string | null;
  /** Name `claude agents` reported. */
  name: string | null;
  /** `reason` of the latest SessionEnd hook. */
  sessionEndReason: string | null;
  /** When the current state began (the derived event that put the session in it). */
  stateSince: { state: SessionState; at: string } | null;
  /** The latest end was a SessionEnd while working or waiting, with no Stop seen. */
  abnormalEnd: boolean;
  /** When the session was last seen ending or disappearing. */
  endedAt: string | null;
}

export interface ApplyResult {
  /** Raw entries applied in this call. */
  applied: number;
  derived: ClaudeDerivedEvent[];
  reports: CapturedReport[];
  candidates: CapturedCandidate[];
  /** Sessions whose Reducer-derived data may have changed. */
  touched: Set<SessionKey>;
  /** The Reducer was replaced: every view has to be refreshed. */
  rebuilt: boolean;
}

export interface Projection {
  applyNew(opts?: { replay?: boolean }): ApplyResult;
  rebuild(): Promise<ApplyResult>;
  readonly lastAppliedSeq: number;
  /** The Reducer's session for a key (live object: read it, do not change it). */
  session(key: SessionKey): ReducerSession | undefined;
  sessionKeys(): SessionKey[];
  facts(key: SessionKey): SessionFacts | undefined;
  /** The Reducer saw a UserPromptSubmit for this session (so Claude saved a transcript and --resume can work). */
  isPrompted(key: SessionKey): boolean;
  /** Reads the session bindings now. Cheap; call once per pass. */
  attributionContext(): AttributionContext;
  attribute(key: SessionKey, ctx: AttributionContext): Attribution;
  stats(): { lastAppliedSeq: number; sessions: number; derived: number; reports: number; candidates: number; applyErrors: number };
}

const DEFAULT_CHUNK = 1000;
const EXCERPT_MAX = 200;
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * The part of a tool's input a person needs to recognise the request, at most `max` characters, whitespace collapsed.
 * Secrets are already redacted at capture; they are scrubbed once more here because this text reaches the screen.
 */
export function excerptOf(input: unknown, max = EXCERPT_MAX): string | null {
  if (input === undefined || input === null) return null;
  let text: string;
  if (typeof input === 'string') text = input;
  else if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const pick = ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']
      .map((k) => o[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (pick !== undefined) text = pick;
    else { try { text = JSON.stringify(input); } catch { text = String(input); } }
  } else text = String(input);
  text = redactString(text.replace(/\s+/g, ' ').trim(), { n: 0 });
  if (text === '') return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Binding first (managed, then manual: one row per session), then the registry match. Pure. */
export function attribute(
  binding: BindingRow | undefined,
  reducerSession: Pick<ReducerSession, 'project' | 'project_reason'> | null | undefined,
  lookup: (id: string) => { id: string; name: string } | null,
): Attribution {
  if (binding?.projectId) {
    const project = lookup(binding.projectId);
    if (project) return { projectId: project.id, projectName: project.name, resolution: binding.source };
  }
  if (reducerSession?.project) {
    // The Reducer remembers the name the project had when the session was first seen; a rename shows up at once.
    const current = lookup(reducerSession.project.id);
    return { projectId: reducerSession.project.id, projectName: current ? current.name : reducerSession.project.name, resolution: 'matched' };
  }
  const reason = reducerSession?.project_reason;
  return { projectId: null, projectName: null, resolution: reason && reason !== 'matched' ? reason : 'no_cwd' };
}

interface State {
  reducer: Reducer;
  lastSeq: number;
  derivedIndex: number;
  reportCount: number;
  candidateCount: number;
  sessionCount: number;
  facts: Map<SessionKey, SessionFacts>;
  byKey: Map<SessionKey, ReducerSession>;
  applyErrors: number;
}

interface Accumulator {
  applied: number;
  derived: ClaudeDerivedEvent[];
  reports: CapturedReport[];
  candidates: CapturedCandidate[];
  touched: Set<SessionKey>;
  touchedEnvs: Set<EnvId>;
}

export function createProjection(deps: ProjectionDeps): Projection {
  const { db, rawStore, projects, hostEnv, log } = deps;
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK;

  const envOf = (env: SessionEnv | undefined | null): EnvId => (!env || env === 'local' ? hostEnv : env);
  const keyOf = (env: SessionEnv | undefined | null, sessionId: string): SessionKey => makeSessionKey(envOf(env), sessionId);
  const atOf = (entry: RawEntry | null): string => {
    if (!entry) return deps.clock.now().toISOString();
    return (entry.transport as { received_at?: string } | undefined)?.received_at ?? entry.ingested_at;
  };

  function newState(): State {
    // ProjectRegistry is the same matcher as the library's; only its result type is less precise.
    const registry = projects.registry() as unknown as RegistryResolver;
    return {
      reducer: new Reducer({ registry }), lastSeq: 0, derivedIndex: 0, reportCount: 0, candidateCount: 0, sessionCount: 0,
      facts: new Map(), byKey: new Map(), applyErrors: 0,
    };
  }

  let state = newState();

  const factsFor = (s: State, key: SessionKey): SessionFacts => {
    let f = s.facts.get(key);
    if (!f) {
      f = { firstAt: null, lastHookAt: null, hookCount: 0, lastHookSeq: 0, startedAtHook: null, name: null, sessionEndReason: null, stateSince: null, abnormalEnd: false, endedAt: null };
      s.facts.set(key, f);
    }
    return f;
  };

  function attributionContext(): AttributionContext {
    const cache = new Map<string, { id: string; name: string } | null>();
    return {
      bindings: readBindings(db),
      project(id) {
        if (!cache.has(id)) {
          const p = projects.get(id);
          cache.set(id, p ? { id: p.id, name: p.name } : null);
        }
        return cache.get(id) ?? null;
      },
    };
  }

  const attributeKey = (s: State, key: SessionKey, ctx: AttributionContext): Attribution =>
    attribute(ctx.bindings.get(key), s.byKey.get(key), ctx.project);

  function permissionOf(entry: RawEntry | null): { toolName: string | null; inputExcerpt: string | null } {
    if (!entry || entry.kind !== 'hook' || entry.payload?.hook_event_name !== 'PermissionRequest') return { toolName: null, inputExcerpt: null };
    const p = entry.payload;
    return { toolName: typeof p.tool_name === 'string' && p.tool_name !== '' ? p.tool_name : null, inputExcerpt: excerptOf(p.tool_input) };
  }

  function convertDerived(d: DerivedEvent, entry: RawEntry | null, replay: boolean): ClaudeDerivedEvent {
    // A derived event always belongs to the entry being applied. If that ever changes, read the entry named by raw_seq.
    const source = entry && entry.seq === d.raw_seq ? entry : rawStore.get(d.raw_seq) ?? entry;
    const event: ClaudeDerivedEvent = {
      derivedId: d.derived_id, kind: d.kind, sessionKey: keyOf(d.env, d.session_id), generation: d.generation,
      notify: d.notify, requiresUser: d.requires_user, rawSeq: d.raw_seq ?? null, at: atOf(source), replay,
    };
    switch (d.kind) {
      case 'transition':
        event.from = d.from;
        event.to = d.to;
        event.evidence = d.evidence;
        if (d.text !== undefined) event.text = d.text;
        if (d.abnormal) event.abnormal = true;
        if (d.to === 'needs_permission') event.permission = permissionOf(source);
        break;
      case 'report_ready':
        event.to = 'report_ready';
        event.text = d.text;
        event.reportId = d.report_id;
        break;
      case 'report_duplicate':
        event.reportId = d.report_id;
        break;
      case 'session_discovered':
        event.text = d.text; // the Reducer's `to: 'discovered'` is not a SessionState, so it is not carried
        break;
      case 'generation':
        event.text = d.why;
        break;
      case 'late_event':
        event.text = `A late ${d.hook_event} was kept as history`;
        break;
      case 'unresolved_ordering':
        event.text = d.why;
        break;
      case 'unhandled_event':
        event.text = `Unknown hook event ${d.hook_event}`;
        break;
    }
    return event;
  }

  function convertReport(s: State, r: Report, at: string, ctx: AttributionContext): CapturedReport {
    const key = keyOf(r.env, r.session_id);
    const att = attributeKey(s, key, ctx);
    return {
      reportId: r.report_id, sessionKey: key, env: envOf(r.env), sessionId: r.session_id, generation: r.generation,
      projectId: att.projectId, projectName: att.projectName, cwd: r.cwd, promptId: r.prompt_id, taskId: r.task_id,
      taskTitle: r.task_title, declaredStatus: r.declared_status, body: r.body, bodySha256: r.body_sha256,
      stopHookActive: r.stop_hook_active, late: r.late, capturedSeq: r.captured_seq, note: r.note, capturedAt: at,
      redactions: count((r as { redactions?: unknown }).redactions), truncations: count((r as { truncations?: unknown }).truncations),
    };
  }

  function convertCandidate(s: State, c: Candidate, at: string, ctx: AttributionContext): CapturedCandidate {
    const key = keyOf(c.env, c.session_id);
    const att = attributeKey(s, key, ctx);
    return {
      candidateId: c.candidate_id, sessionKey: key, env: envOf(c.env), sessionId: c.session_id, generation: c.generation,
      projectId: att.projectId, projectName: att.projectName, promptId: c.prompt_id, reason: c.reason,
      declaredStatus: c.declared_status, taskTitle: c.task_title, body: c.body, bodySha256: c.body_sha256, late: c.late, capturedAt: at,
      redactions: count((c as { redactions?: unknown }).redactions), truncations: count((c as { truncations?: unknown }).truncations),
    };
  }

  function factsFromEntry(s: State, entry: RawEntry): void {
    const at = atOf(entry);
    if (entry.kind === 'hook') {
      const p = entry.payload;
      if (!p?.session_id || !p.hook_event_name) return;
      const f = factsFor(s, keyOf(entry.transport?.env_id, p.session_id));
      f.firstAt ??= at;
      f.hookCount++;
      f.lastHookSeq = entry.seq;
      if (!f.lastHookAt || at > f.lastHookAt) f.lastHookAt = at;
      if (p.hook_event_name === 'SessionStart' && ['startup', 'resume', 'fork'].includes(p.source ?? 'startup')) f.startedAtHook = at;
      if (p.hook_event_name === 'SessionEnd') f.sessionEndReason = typeof p.reason === 'string' && p.reason !== '' ? p.reason : null;
    } else if (entry.kind === 'discovery') {
      const env = entry.transport?.env_id;
      for (const o of entry.payload?.sessions ?? []) {
        if (!o.name) continue;
        factsFor(s, keyOf(env, o.sessionId ?? `nosid:${o.pid ?? 'x'}:${o.startedAt ?? 'x'}`)).name = o.name;
      }
    }
  }

  function factsFromDerived(s: State, d: DerivedEvent, event: ClaudeDerivedEvent): void {
    const f = factsFor(s, event.sessionKey);
    if (d.kind === 'transition') {
      f.stateSince = { state: d.to, at: event.at };
      f.abnormalEnd = d.to === 'ended' && d.abnormal === true;
      if (d.to === 'ended' || d.to === 'presence_lost') f.endedAt = event.at;
      else { f.endedAt = null; f.sessionEndReason = null; }
    } else if (d.kind === 'report_ready' && !d.late) {
      f.stateSince = { state: 'report_ready', at: event.at };
    } else if (d.kind === 'generation') {
      f.endedAt = null;
      f.sessionEndReason = null;
      f.abnormalEnd = false;
    }
  }

  function applyEntries(s: State, entries: RawEntry[], out: Accumulator, ctx: AttributionContext, replay: boolean): void {
    const reducer = s.reducer;
    for (const entry of entries) {
      try {
        reducer.apply(entry as ReducerEntry);
      } catch (err) {
        // A reducer bug on one odd entry must not wedge the pipeline: the entry stays in the log, and the failure is visible.
        s.applyErrors++;
        log?.error('The Claude event reducer failed on a raw event; it was skipped.', { seq: entry.seq, error: err instanceof Error ? err.message : String(err) });
      }
      s.lastSeq = entry.seq;
      out.applied++;
      // A new session must be indexed before anything of this entry is attributed to it.
      if (reducer.sessions.size !== s.sessionCount) indexSessions(s);
      factsFromEntry(s, entry);

      if (entry.kind === 'hook') {
        const p = entry.payload;
        if (p?.session_id) out.touched.add(keyOf(entry.transport?.env_id, p.session_id));
      } else if (entry.kind === 'discovery') {
        out.touchedEnvs.add(envOf(entry.transport?.env_id));
      }

      for (; s.derivedIndex < reducer.derived.length; s.derivedIndex++) {
        const d = reducer.derived[s.derivedIndex];
        const event = convertDerived(d, entry, replay);
        factsFromDerived(s, d, event);
        out.derived.push(event);
        out.touched.add(event.sessionKey);
      }
      if (reducer.reports.size > s.reportCount) {
        const at = atOf(entry);
        let i = 0;
        for (const r of reducer.reports.values()) { if (i++ >= s.reportCount) out.reports.push(convertReport(s, r, at, ctx)); }
        s.reportCount = reducer.reports.size;
      }
      if (reducer.candidates.size > s.candidateCount) {
        const at = atOf(entry);
        let i = 0;
        for (const c of reducer.candidates.values()) { if (i++ >= s.candidateCount) out.candidates.push(convertCandidate(s, c, at, ctx)); }
        s.candidateCount = reducer.candidates.size;
      }
    }
  }

  function indexSessions(s: State): void {
    for (const rs of s.reducer.sessions.values()) s.byKey.set(keyOf(rs.env, rs.session_id), rs);
    s.sessionCount = s.reducer.sessions.size;
  }

  const newAccumulator = (): Accumulator => ({ applied: 0, derived: [], reports: [], candidates: [], touched: new Set(), touchedEnvs: new Set() });

  function finish(s: State, out: Accumulator, rebuilt: boolean): ApplyResult {
    indexSessions(s);
    // A discovery snapshot can change any session of its environment (including the ones it no longer lists).
    for (const env of out.touchedEnvs) {
      for (const [key, rs] of s.byKey) if (envOf(rs.env) === env) out.touched.add(key);
    }
    return { applied: out.applied, derived: out.derived, reports: out.reports, candidates: out.candidates, touched: out.touched, rebuilt };
  }

  return {
    get lastAppliedSeq() { return state.lastSeq; },

    applyNew(opts) {
      const s = state;
      let chunk = rawStore.since(s.lastSeq, chunkSize);
      // The common case (a poll with nothing new) costs one indexed query.
      if (chunk.length === 0) return { applied: 0, derived: [], reports: [], candidates: [], touched: new Set(), rebuilt: false };
      const out = newAccumulator();
      const ctx = attributionContext();
      for (;;) {
        applyEntries(s, chunk, out, ctx, opts?.replay === true);
        if (chunk.length < chunkSize) break;
        chunk = rawStore.since(s.lastSeq, chunkSize);
        if (chunk.length === 0) break;
      }
      return finish(s, out, false);
    },

    async rebuild() {
      const s = newState();
      const out = newAccumulator();
      const ctx = attributionContext();
      for (;;) {
        const chunk = rawStore.since(s.lastSeq, chunkSize);
        if (chunk.length === 0) break;
        applyEntries(s, chunk, out, ctx, true);
        if (chunk.length < chunkSize) break;
        await new Promise<void>((resolve) => setImmediate(resolve)); // let the event loop breathe between chunks
      }
      const result = finish(s, out, true);
      state = s; // swap only when the replay is complete
      return result;
    },

    session: (key) => state.byKey.get(key),
    sessionKeys: () => [...state.byKey.keys()],
    facts: (key) => state.facts.get(key),
    isPrompted(key) {
      const rs = state.byKey.get(key);
      return Boolean(rs && (rs.tasks.size > 0 || rs.current_prompt_id !== null));
    },
    attributionContext,
    attribute: (key, ctx) => attributeKey(state, key, ctx),
    stats: () => ({
      lastAppliedSeq: state.lastSeq, sessions: state.reducer.sessions.size, derived: state.reducer.derived.length,
      reports: state.reducer.reports.size, candidates: state.reducer.candidates.size, applyErrors: state.applyErrors,
    }),
  };
}
