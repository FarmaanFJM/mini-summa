// SessionsService: what Mini-Summa knows about Claude Code sessions, and what it lets a person do with them.
//
// HOW A SESSION VIEW IS DECIDED  (one SessionView per session key `<env>|<uuid>`; the rules live in sessionView.ts)
//
//   Sources, in the order they are trusted: the managed-session record (Mini-Summa owns that terminal), the Reducer's
//   session (hooks and discovery, a pure function of the raw log) and, for sessions nothing else remembers any more, the
//   last persisted view (history, never shown as live). Two environments with the same session uuid are two sessions.
//
//   origin        managed     a managed record exists
//                 background  else, `claude agents` lists it with kind "background"
//                 external    else
//
//   availability  managed, terminal running ............................. live
//                 managed, terminal exited, a prompt was submitted ....... resumable   (resumable = true)
//                 managed, terminal exited, never prompted ............... ended
//                 managed, link lost (the app restarted) ................. disconnected (resumable = prompted)
//                 external/background, generation live .................. live
//                 external/background, generation lost_suspected ........ disconnected (resumable = prompted)
//                 external/background, generation ended_observed ........ ended        (resumable = prompted)
//                 "prompted" = the managed record says so, or the Reducer saw a UserPromptSubmit
//
//   termination   managed exit ........ observed (Mini-Summa saw the terminal exit)
//                 SessionEnd hook, or a listed pid that is verifiably dead on this host ... observed
//                 absent from a full discovery listing .................................... suspected
//                 A suspected end is never shown as observed, and an observed end never as suspected.
//
//   state         the Reducer's state and label (a failed discovery call changes nothing). A managed terminal that has not
//                 shown a sign of life since it was started (no hook after the start; the older hooks of a resumed session
//                 do not count) is "unknown / Starting" with no attention, and the target check, typeInto and
//                 answerPermission refuse it ("Claude has not finished starting. If it is asking whether you trust this
//                 folder, answer in the terminal."): at a startup or trust dialog a blind Enter can end the session. A person
//                 typing at the desktop terminal is never held back. A managed terminal that exited is "ended" (observed by
//                 us). A disconnected managed session keeps its last known state, labelled "(last known)".
//   attention     needs_permission -> permission, needs_input -> input (only while live: nobody can answer a gone
//                 process), error -> error, ended abnormally -> abnormal_end, presence_lost -> presence_lost,
//                 report_ready -> report.
//   project       the session binding first (managed, then manual), then the registry match on the working directory.
//                 Never the focused window or tab.
//   remote ctrl   managed: enabled or not as started; external: unknown, with a hint to type /remote-control there.
//
// A view that differs from the last one (deep compare of its JSON) is persisted to sessions_projection, emitted as the bus
// event `session.upserted` and passed to the subscribers' onSession.
//
// PIPELINE   spool files -> raw_events (rawStore) -> Reducer (projection) -> views + derived events/reports/candidates
//            One serial queue runs every pass (spool drain, discovery call, rebuild), so passes never overlap and
//            "apply everything after lastAppliedSeq" is always the whole story.
//
// Contract notes (decisions where contracts.ts was silent):
//  - init() calls managed.init() and shutdown() calls managed.shutdown(): the composition root must not call them again.
//  - "Has shown a sign of life" is a hook receipt of the session at a raw-log position after the one noticed when the run
//    began (no wall clock, so a lagging WSL clock cannot hold a session in "Starting"); a running record found at startup
//    falls back to comparing its startedAt with the newest hook's received_at.
//  - typeInto / answerPermission refuse a second send until a hook shows Claude reacted (or 4 s pass): a double click must
//    not type twice, and a second "approve" must not land on the next dialog.
//  - Hook files already waiting when the app starts are ingested before the replay and are reported as `replay: true`.
//  - Resuming a session starts Claude in the session's own working directory (Claude finds the transcript through it);
//    the chosen project folder only decides the project attribution.
//  - APPROVE WHAT YOU SEE. Every PermissionRequest hook the Reducer accepted (not a duplicate delivery, not late or stale) is
//    handed to onPermissionRequest, also a second one that arrives while the session already waits and so changes no state.
//    currentPermission(key) is the newest one since the session last left needs_permission (null otherwise, for a terminal
//    that is starting or restarted after it, and for sessions that are not managed). answerPermission(.., expectRequestKey)
//    sends nothing when that key is not the open one. Its correlationKey is `perm_<transport id of the hook receipt>`.
//  - UNSENT INPUT. A person typed at the desktop terminal and has not pressed Enter (ManagedManager.hasUnsentInput, a
//    heuristic): typeInto and targetCheck refuse, whatever the caller, because the text would be appended to that line.
//    answerPermission is not held back (the permission dialog takes the keys, and the person may have to answer it there).
//  - FOLLOW THE PROCESS, NOT THE ID. /clear and /resume change the session id inside the SAME Claude process, so the terminal
//    Mini-Summa started would otherwise "end" while it keeps running, and the new id would be a stranger it cannot type into.
//    After every apply (before the views are built) continuation.ts decides from facts whether a new id PROVABLY belongs to a
//    live terminal of ours (the process id Claude lists for it, else strictly corroborated managed hooks; ambiguity is never
//    guessed), and the managed record is re-keyed (ManagedManagerExtras.rekey): the terminal, its scrollback, the project binding,
//    the name, the default flag and the remote-control state move to the new key; the old key stays behind as an ordinary
//    ended/resumable record that says what happened. While the successor is being learned the terminal says so
//    ("Conversation replaced, learning the new session"); if it cannot be settled, it says that, and typing is paused.
//    A hook that announces a replacement also makes the next discovery call run at once, so the answer takes a second, not 15.
//  - ManagedManager has no method for "a prompt reached Claude", so the sessions layer calls the optional extra
//    ManagedManagerExtras.promptSubmitted(key, hook time) when it exists (the real manager has it): it clears the unsent flag.
import { tidOfSpoolName } from '@minisumma/claude-integration';
import { envLabel, parseSessionKey, shortSessionId } from '@minisumma/shared';
import type { EnvId, Project, SessionKey, SessionState, SessionView } from '@minisumma/shared';
import { fromJson } from '@minisumma/storage';
import type {
  ClaudeEventHandlers, CoreBase, CoreOptions, EnvironmentsService, ManagedManager, ManagedSessionRecord, PermissionRequestInfo, ProjectsService,
  SessionsService, SettingsService, StartSessionRequest, TypeIntoResult,
} from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { CoreError, badRequest, notFound, unprocessable } from '../errors.ts';
import { PENDING_TEXT, decideContinuations, parseReplacedReason, replacedReason, successorOf } from './continuation.ts';
import type { Adoption, CandidateFact, ContinuationDecision, EnvEvidence, TerminalFact } from './continuation.ts';
import { createDiscovery } from './discovery.ts';
import type { AgentsRunner } from './discovery.ts';
import { createIngestion } from './ingestion.ts';
import type { ManagedManagerExtras } from './managed.ts';
import { defaultParentPid, isSameOrBelow } from './processTree.ts';
import type { ParentPid } from './processTree.ts';
import { attribute } from './projection.ts';
import type { ApplyResult } from './projection.ts';
import { createProjection } from './projection.ts';
import { createRawStore } from './rawStore.ts';
import type { RawStore } from './rawStore.ts';
import { createRegistryFileWriter } from './registryFile.ts';
import { SerialQueue } from './serialQueue.ts';
import { clearManualBinding, conversationOf, setManualBinding } from './sessionBindings.ts';
import type { BindingRow } from './sessionBindings.ts';
import { STARTING_PROBLEM, buildSessionView, isStarting, labelOf } from './sessionView.ts';
import type { RunBaseline } from './sessionView.ts';

/** What the sessions layer needs from ProjectsService (a real ProjectsService satisfies it). */
export type ProjectsPort = Pick<ProjectsService, 'get' | 'require' | 'list' | 'registry' | 'registryFileContents' | 'onRootsChanged' | 'setDefaultSession'>
  & { conversations: Pick<ProjectsService['conversations'], 'require'> };

export interface SessionsDeps {
  base: CoreBase;
  settings: Pick<SettingsService, 'get' | 'onChange'>;
  projects: ProjectsPort;
  environments: EnvironmentsService;
  managed: ManagedManager;
  rawStore?: RawStore;
  /** Replaces `claude agents --json` (tests). */
  run?: AgentsRunner;
  overrides?: CoreOptions['overrides'];
  /** Test seam: the core's environment variables (CLAUDE_CONFIG_DIR). */
  env?: Record<string, string | undefined>;
  /** Test seams of the "follow the process" logic. */
  continuation?: {
    /** Pauses before the fresh discovery calls asked for while a replaced conversation's successor is not listed yet. */
    retryDelaysMs?: number[];
    /** Parent links of processes (default: /proc on Linux, ps on macOS, nothing elsewhere). */
    parentPid?: ParentPid;
  };
}

/** The contract plus two maintenance hooks the composition root and the tests use. */
export interface ObserverSessionsService extends SessionsService {
  /** Runs one ingestion pass now (after everything already queued) and resolves when it has been applied and published. */
  flush(): Promise<void>;
  /** Replays the whole raw log into a fresh Reducer over the current registry. */
  rebuild(): Promise<void>;
}

const DEFAULT_SPOOL_POLL_MS = 700;
/**
 * After text or an answer was sent to a terminal, Claude needs a moment to react, and its hooks arrive later still. Until a
 * new hook for that session is seen (or this long has passed) a second send is refused: a double click must not type the
 * text twice, and a second "approve" must not land on the next dialog.
 */
const SETTLE_WINDOW_MS = 4000;
/** How long a user action waits for a fresh look at the spool before it goes on with what it knows. */
const FRESHEN_MAX_WAIT_MS = 1500;
const SHUTDOWN_WAIT_MS = 3000;
// C0 controls except tab, line feed and carriage return, and DEL. An ESC could end a bracketed paste early.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSENT_INPUT_PROBLEM = 'Someone typed in that terminal and has not pressed Enter yet. Finish or clear that line first.';
const STALE_PERMISSION_PROBLEM = 'That permission request is no longer the one that is open. Look at the terminal.';

/** One line a person can read: which tool, and what it was asked to do. */
function permissionSummary(info: PermissionRequestInfo): string {
  if (info.toolName && info.inputExcerpt) return `${info.toolName}: ${info.inputExcerpt}`;
  return info.toolName ?? info.inputExcerpt ?? 'A permission request';
}

interface ViewChange { view: SessionView; previous: SessionView | null }

const sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const clampInt = (v: number | undefined, fallback: number, min: number, max: number): number =>
  Number.isInteger(v) ? Math.min(max, Math.max(min, v as number)) : fallback;

export function createSessionsService(deps: SessionsDeps): ObserverSessionsService {
  const { base, settings, projects, environments, managed } = deps;
  const { db, bus, clock, log } = base;
  const overrides = deps.overrides ?? {};
  const hostEnv = environments.hostEnv();
  const rawStore = deps.rawStore ?? createRawStore(db, clock, log);
  const queue = new SerialQueue();
  const projection = createProjection({ db, rawStore, projects, hostEnv, clock, log });
  const registryFile = createRegistryFileWriter({ projects, file: async () => (await environments.layout(hostEnv)).registryFileHost, log });

  const handlers = new Set<ClaudeEventHandlers>();
  const views = new Map<SessionKey, SessionView>();
  const viewJson = new Map<SessionKey, string>();
  // What has already been handed to subscribers in this process (a rebuild must not hand the same thing over again).
  const deliveredDerived = new Set<string>();
  const deliveredPermissions = new Set<string>();
  const deliveredReports = new Map<string, string | null>();
  const deliveredCandidates = new Map<string, string | null>();
  const offs: (() => void)[] = [];
  let initPromise: Promise<void> | null = null;
  let initialized = false;
  let shuttingDown = false;
  let rebuildQueued = false;

  // Managed terminals that have not shown a sign of life since they were started (see isStarting in sessionView.ts), and the
  // log position at which each running terminal was first noticed.
  const startingKeys = new Set<SessionKey>();
  const runBaselines = new Map<SessionKey, RunBaseline>();

  /** Remembers where the log stood when a run of a managed terminal began, so its first hook can be told from older ones. */
  function observeRun(record: ManagedSessionRecord): void {
    if (record.status !== 'running') {
      runBaselines.delete(record.key);
      return;
    }
    const known = runBaselines.get(record.key);
    if (known && known.startedAt === record.startedAt) return;
    runBaselines.set(record.key, { startedAt: record.startedAt, seq: rawStore.maxSeq(), waiting: waitingReceipts() });
  }

  /** The hook files lying in the spools right now. */
  function waitingReceipts(): Set<string> {
    const tids = new Set<string>();
    for (const layout of ingestion.layouts()) {
      try {
        for (const name of rawStore.pendingSpool(layout.spoolDirHost)) tids.add(tidOfSpoolName(name));
      } catch { /* an unreadable spool has nothing to exclude */ }
    }
    return tids;
  }

  const inFlight = new Map<SessionKey, { hooks: number; at: number; what: 'text' | 'answer' }>();
  const hooksSeen = (key: SessionKey): number => projection.facts(key)?.hookCount ?? 0;

  /** The session has been sent something and has not reacted yet. */
  function unsettled(key: SessionKey): 'text' | 'answer' | null {
    const pending = inFlight.get(key);
    if (!pending) return null;
    if (hooksSeen(key) > pending.hooks || clock.now().getTime() - pending.at > SETTLE_WINDOW_MS) {
      inFlight.delete(key);
      return null;
    }
    return pending.what;
  }

  const markSent = (key: SessionKey, what: 'text' | 'answer'): void => {
    inFlight.set(key, { hooks: hooksSeen(key), at: clock.now().getTime(), what });
  };

  const discoveryIntervalMs = (): number => overrides.discoveryIntervalMs ?? settings.get().sessions.discoveryIntervalSec * 1000;

  function callHandlers(fn: (h: ClaudeEventHandlers) => void): void {
    for (const h of [...handlers]) {
      try { fn(h); } catch (err) { log.error('A Claude event subscriber failed.', { error: err instanceof Error ? err.message : String(err) }); }
    }
  }

  // ---- following the process (continuation.ts) ----------------------------------------------------------------------------

  const extras = managed as ManagedManager & Partial<ManagedManagerExtras>;
  const retryDelays = deps.continuation?.retryDelaysMs ?? [0, 600, 1500, 3000, 6000];
  // only the process itself or one it started directly (a launcher): a deeper descendant may be a `claude -p` that a tool started
  const ancestry = (pid: number, of: number): boolean | null => isSameOrBelow(pid, of, deps.continuation?.parentPid ?? defaultParentPid(), 1);
  /** Terminals whose session was replaced and whose successor is not settled: pending (a fresh listing is on its way) or unresolved. */
  const continuations = new Map<SessionKey, { status: 'pending' | 'unresolved'; text: string }>();
  /** Old key -> the key its terminal went on as, in this run. Lets a client that was attached to the old key keep typing. */
  const replacedBy = new Map<SessionKey, SessionKey>();
  interface Wait { tries: number; timer: NodeJS.Timeout | null; blind: boolean }
  const waits = new Map<SessionKey, Wait>();
  /** Moves the manager refused, by "from>to" -> when: not tried again for a while, so a refusal does not repeat on every pass. */
  const refusedMoves = new Map<string, number>();
  const REFUSED_RETRY_MS = 30_000;
  const NOT_LEARNED_TEXT = 'The conversation in this terminal was replaced (/clear or /resume), but Claude Code has not told Mini-Summa which session the terminal runs now. '
    + 'Typing from Mini-Summa is paused here; the terminal itself still works.';

  const continuationProblem = (c: { status: 'pending' | 'unresolved'; text: string }): string =>
    (c.status === 'pending' ? `${PENDING_TEXT}. Try again in a moment.` : c.text);

  function clearWait(key: SessionKey): void {
    const w = waits.get(key);
    if (w?.timer) clearTimeout(w.timer);
    waits.delete(key);
  }

  /** Asks for a fresh listing soon; gives up after the configured delays and lets the hooks have their say. */
  function scheduleWait(key: SessionKey): void {
    const env = parseSessionKey(key)?.env;
    if (!env || shuttingDown) return;
    let w = waits.get(key);
    if (!w) { w = { tries: 0, timer: null, blind: false }; waits.set(key, w); }
    if (w.timer || w.blind) return;
    const delay = retryDelays[w.tries];
    if (delay === undefined) {
      w.blind = true;
      queue.run(() => { const touched = new Set<SessionKey>(); settleContinuations(touched); refreshAndCommit(touched); })
        .catch((err) => log.warn('Re-checking a replaced conversation failed.', { error: String(err) }));
      return;
    }
    const wait = w;
    wait.timer = setTimeout(() => {
      wait.timer = null;
      wait.tries++;
      if (shuttingDown) return;
      discovery.runNow(env).catch((err) => log.warn('Asking Claude Code for its sessions after a replaced conversation failed.', { error: String(err) }));
    }, delay);
    wait.timer.unref?.();
  }

  function continuationFacts(): { terminals: TerminalFact[]; candidates: CandidateFact[]; envs: Map<EnvId, EnvEvidence> } {
    const running = managed.list().filter((r) => r.status === 'running');
    const runningKeys = new Set(running.map((r) => r.key));
    const terminals: TerminalFact[] = running.map((r) => {
      const rs = projection.session(r.key);
      return {
        key: r.key, env: r.env, sessionId: r.sessionId, cwds: [r.cwd, ...(rs?.cwd ? [rs.cwd] : [])], pid: r.pid,
        phase: rs?.gen.phase ?? 'none', trace: projection.trace(r.key) ?? null, listingBlind: waits.get(r.key)?.blind ?? false,
      };
    });
    const envs = new Map<EnvId, EnvEvidence>();
    for (const t of terminals) {
      if (envs.has(t.env)) continue;
      const listing = projection.listing(t.env);
      envs.set(t.env, { env: t.env, comparable: t.env === hostEnv, listing: listing && listing.usable ? listing.rows : null });
    }
    const candidates: CandidateFact[] = [];
    if (terminals.length > 0) {
      for (const key of projection.sessionKeys()) {
        const parsed = parseSessionKey(key);
        if (!parsed || !envs.has(parsed.env)) continue;
        const rs = projection.session(key);
        candidates.push({
          key, env: parsed.env, sessionId: parsed.sessionId, cwd: rs?.cwd ?? null, phase: rs?.gen.phase ?? 'none',
          trace: projection.trace(key) ?? null, managedRunning: runningKeys.has(key),
        });
      }
    }
    return { terminals, candidates, envs };
  }

  /** Re-keys the terminal to the session it was proven to run now. Returns false when the manager refused. */
  function performAdoption(a: Adoption, touched: Set<SessionKey>): boolean {
    const record = managed.get(a.terminal);
    if (!extras.rekey || !record || record.status !== 'running') return false;
    const pair = `${a.terminal}>${a.to}`;
    const refusedAt = refusedMoves.get(pair);
    if (refusedAt !== undefined && clock.now().getTime() - refusedAt < REFUSED_RETRY_MS) return false;
    // The terminal has been up all along: what counts as its sign of life moves with it (the new session's first hook is
    // already in the log, and must not make a running terminal "Starting" again).
    const baseline = runBaselines.get(a.terminal);
    const hadBaseline = runBaselines.has(a.to);
    if (baseline) runBaselines.set(a.to, { ...baseline });
    const prompted = a.cause === 'resume' || projection.isPrompted(a.to);
    let next: ManagedSessionRecord | null = null;
    try {
      next = extras.rekey({ from: a.terminal, toSessionId: a.toSessionId, leftBehindReason: replacedReason(a.cause, a.toSessionId), prompted });
    } catch (err) {
      log.error('Re-keying a managed terminal failed.', { from: a.terminal, to: a.to, error: String(err) });
    }
    if (!next) {
      if (baseline && !hadBaseline) runBaselines.delete(a.to);
      refusedMoves.set(pair, clock.now().getTime());
      log.warn('Mini-Summa could not follow a terminal to its new session.', { from: a.terminal, to: a.to });
      return false;
    }
    refusedMoves.delete(pair);
    inFlight.delete(a.terminal);
    startingKeys.delete(a.terminal);
    continuations.delete(a.terminal);
    clearWait(a.terminal);
    replacedBy.set(a.terminal, a.to);
    replacedBy.delete(a.to);
    // The default session of the project is a property of the terminal people work in, not of one conversation id.
    if (record.projectId) {
      try {
        if (projects.get(record.projectId)?.defaultSessionKey === a.terminal) projects.setDefaultSession(record.projectId, a.to);
      } catch (err) { log.warn('Moving the default session to the new session failed.', { error: String(err) }); }
    }
    log.info('A managed terminal went on as another Claude session.', { from: a.terminal, to: a.to, via: a.via, cause: a.cause, why: a.why });
    touched.add(a.terminal);
    touched.add(a.to);
    return true;
  }

  function applyVerdicts(decision: ContinuationDecision, touched: Set<SessionKey>): void {
    const next = new Map<SessionKey, { status: 'pending' | 'unresolved'; text: string }>();
    for (const key of decision.pending) {
      next.set(key, waits.get(key)?.blind ? { status: 'unresolved', text: NOT_LEARNED_TEXT } : { status: 'pending', text: PENDING_TEXT });
    }
    for (const u of decision.unresolved) next.set(u.terminal, { status: 'unresolved', text: u.text });
    for (const [key, verdict] of next) {
      const before = continuations.get(key);
      if (!before || before.status !== verdict.status || before.text !== verdict.text) touched.add(key);
    }
    for (const key of continuations.keys()) if (!next.has(key)) touched.add(key);
    continuations.clear();
    for (const [key, verdict] of next) continuations.set(key, verdict);
    for (const key of decision.pending) scheduleWait(key);
    for (const key of [...waits.keys()]) if (!next.has(key)) clearWait(key);
  }

  /**
   * Looks at the evidence after something new was applied and, before any view is built from it, lets terminals follow the
   * sessions they were proven to run. Adds every key whose view may have changed to `touched`.
   */
  function settleContinuations(touched: Set<SessionKey>): void {
    if (!extras.rekey || shuttingDown) return;
    for (let round = 0; round < 4; round++) {
      const facts = continuationFacts();
      if (facts.terminals.length === 0) {
        for (const key of continuations.keys()) touched.add(key);
        continuations.clear();
        for (const key of [...waits.keys()]) clearWait(key);
        return;
      }
      const decision = decideContinuations({ ...facts, ancestry });
      let moved = false;
      for (const a of decision.adopt) moved = performAdoption(a, touched) || moved;
      if (moved) continue; // the facts changed: look again
      applyVerdicts(decision, touched);
      return;
    }
  }

  /** The key a client that was attached to `key` should write to: the same terminal, under the id it has now. */
  function terminalKeyFor(key: SessionKey): SessionKey {
    if (managed.get(key)?.status === 'running') return key;
    const next = replacedBy.get(key);
    return next && managed.get(next)?.status === 'running' ? next : key;
  }

  // ---- views -----------------------------------------------------------------------------------------------------------

  function allKeys(): Set<SessionKey> {
    const keys = new Set<SessionKey>(projection.sessionKeys());
    for (const r of managed.list()) keys.add(r.key);
    for (const k of views.keys()) keys.add(k);
    return keys;
  }

  function refreshViews(keys: Iterable<SessionKey>): ViewChange[] {
    const ctx = projection.attributionContext();
    const managedByKey = new Map<SessionKey, ManagedSessionRecord>();
    for (const r of managed.list()) managedByKey.set(r.key, r);
    const projectsById = new Map<string, Project>();
    for (const p of projects.list({ includeArchived: true })) projectsById.set(p.id, p);
    const lookup = (id: string): { id: string; name: string } | null => {
      const p = projectsById.get(id);
      return p ? { id: p.id, name: p.name } : null;
    };

    const changes: ViewChange[] = [];
    for (const key of keys) {
      const parsed = parseSessionKey(key);
      if (!parsed) continue;
      const m = managedByKey.get(key) ?? null;
      const stored = ctx.bindings.get(key);
      // The managed record names the project it was started for even if its binding row is missing.
      const binding: BindingRow | undefined = stored?.projectId ? stored
        : m?.projectId ? { sessionKey: key, projectId: m.projectId, conversationId: m.conversationId, source: 'managed' } : stored;
      const reducerSession = projection.session(key) ?? null;
      const att = attribute(binding, reducerSession, lookup);
      const facts = projection.facts(key) ?? null;
      const starting = isStarting(m, facts, runBaselines.get(key));
      if (starting) startingKeys.add(key); else startingKeys.delete(key);
      const view = buildSessionView({
        key, env: parsed.env, sessionId: parsed.sessionId, reducer: reducerSession, facts, managed: m, starting,
        attribution: att, projectDefaultKey: att.projectId ? (projectsById.get(att.projectId)?.defaultSessionKey ?? null) : null,
        history: views.get(key) ?? null, continuation: m?.status === 'running' ? continuations.get(key) ?? null : null,
      });
      if (!view) continue;
      const json = JSON.stringify(view);
      if (viewJson.get(key) === json) continue;
      const previous = views.get(key) ?? null;
      views.set(key, view);
      viewJson.set(key, json);
      changes.push({ view, previous });
    }
    return changes;
  }

  function commitViews(changes: ViewChange[]): void {
    if (changes.length === 0) return;
    const at = nowIso(clock);
    db.tx(() => {
      for (const { view } of changes) {
        db.run(
          `INSERT INTO sessions_projection (session_key, env, session_id, project_id, origin, availability, state, last_activity_at, view_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET env = excluded.env, session_id = excluded.session_id, project_id = excluded.project_id,
             origin = excluded.origin, availability = excluded.availability, state = excluded.state, last_activity_at = excluded.last_activity_at,
             view_json = excluded.view_json, updated_at = excluded.updated_at`,
          [view.key, view.env, view.sessionId, view.projectId, view.origin, view.availability, view.state, view.lastActivityAt, JSON.stringify(view), at],
        );
      }
    });
    for (const { view, previous } of changes) {
      bus.emit({ type: 'session.upserted', session: view });
      callHandlers((h) => h.onSession?.(view, previous));
    }
  }

  const refreshAndCommit = (keys: Iterable<SessionKey>): void => commitViews(refreshViews(keys));

  // ---- apply and publish -------------------------------------------------------------------------------------------------

  /** Hands what an apply produced to the subscribers, once per thing (a rebuild repeats ids it already delivered). */
  function deliver(result: ApplyResult): void {
    for (const event of result.derived) {
      if (deliveredDerived.has(event.derivedId)) continue;
      deliveredDerived.add(event.derivedId);
      // A conversation replaced by /clear drops out of Claude's listing in the same instant: that is not a lost session.
      if (event.kind === 'transition' && event.to === 'presence_lost' && (replacedBy.has(event.sessionKey) || parseReplacedReason(managed.get(event.sessionKey)?.exitReason))) continue;
      const view = views.get(event.sessionKey);
      if (view) callHandlers((h) => h.onDerived?.(event, view));
    }
    // Every permission request, not only the one that moved the session into needs_permission; each at most once.
    for (const info of result.permissions) {
      if (deliveredPermissions.has(info.correlationKey)) continue;
      deliveredPermissions.add(info.correlationKey);
      const view = views.get(info.sessionKey);
      if (view) callHandlers((h) => h.onPermissionRequest?.(info, view));
    }
    // A report is handed over again only when its project attribution changed (a registry change re-attributes).
    for (const report of result.reports) {
      if (deliveredReports.has(report.reportId) && deliveredReports.get(report.reportId) === report.projectId) continue;
      deliveredReports.set(report.reportId, report.projectId);
      callHandlers((h) => h.onReport?.(report));
    }
    for (const candidate of result.candidates) {
      if (deliveredCandidates.has(candidate.candidateId) && deliveredCandidates.get(candidate.candidateId) === candidate.projectId) continue;
      deliveredCandidates.set(candidate.candidateId, candidate.projectId);
      callHandlers((h) => h.onCandidate?.(candidate));
    }
  }

  /** Tells the managed manager when the Reducer first saw a prompt in one of its sessions (so --resume can work later). */
  function syncPrompted(keys: Iterable<SessionKey>): void {
    for (const key of keys) {
      const record = managed.get(key);
      if (record && !record.prompted && projection.isPrompted(key)) managed.markPrompted(key);
    }
  }

  /** A prompt reached Claude: whatever was typed on the desktop input line before it has been submitted. */
  function noteSubmissions(result: ApplyResult): void {
    const extras = managed as ManagedManager & Partial<ManagedManagerExtras>;
    if (!extras.promptSubmitted) return;
    for (const submission of result.submissions) {
      if (submission.replay) continue;
      // The hook's own clock is comparable with the keystroke time only on this computer; WSL clocks can drift.
      const sameClock = parseSessionKey(submission.sessionKey)?.env === hostEnv;
      extras.promptSubmitted(submission.sessionKey, sameClock ? submission.at : undefined);
    }
  }

  function publish(result: ApplyResult): void {
    const keys = result.rebuilt ? allKeys() : new Set(result.touched);
    commitViews(refreshViews(keys));
    deliver(result);
    syncPrompted(keys);
    noteSubmissions(result);
  }

  function applyAndPublish(opts: { replay: boolean }): void {
    if (shuttingDown) return;
    const result = projection.applyNew({ replay: opts.replay });
    if (result.applied > 0) {
      settleContinuations(result.touched);
      publish(result);
    }
  }

  async function rebuildAndPublish(): Promise<void> {
    if (shuttingDown) return;
    const result = await projection.rebuild();
    settleContinuations(result.touched);
    publish(result);
  }

  // ---- parts ----------------------------------------------------------------------------------------------------------------

  const ingestion = createIngestion({
    queue, rawStore, hostEnv, environments, pollMs: overrides.spoolPollMs ?? DEFAULT_SPOOL_POLL_MS, log,
    apply: (opts) => applyAndPublish(opts),
  });

  const discovery = createDiscovery({
    queue, rawStore, environments, run: deps.run, clock, log, env: deps.env,
    intervalMs: discoveryIntervalMs,
    apply: (opts) => applyAndPublish(opts),
    beforePass: () => ingestion.syncEnvironments(),
  });

  /** A user action looks at the spool once more first, so it acts on what Claude did a moment ago. Bounded wait. */
  async function freshen(): Promise<void> {
    if (!initialized || shuttingDown) return;
    await Promise.race([ingestion.pass().catch(() => undefined), sleep(FRESHEN_MAX_WAIT_MS)]);
  }

  // ---- target checks ----------------------------------------------------------------------------------------------------------

  function availabilityProblem(view: SessionView): string {
    const successor = successorOf(view.env, managed.get(view.key)?.exitReason);
    if (successor) {
      return `This conversation was replaced inside its terminal (/clear or /resume); the terminal went on as session ${shortSessionId(successor)}. `
        + 'Text written for the old conversation is not sent to the new one: send it to the new session if you still want it.';
    }
    switch (view.availability) {
      case 'resumable': return 'This session is not running. Resume it first, then try again.';
      case 'disconnected': return 'Mini-Summa lost the connection to this session\'s terminal. Resume the session to type into it.';
      case 'ended': return 'This session has ended.';
      default: return 'This session is not running.';
    }
  }

  /** The target check, whether the terminal has not finished starting, and whether a person left text on its input line. */
  function inspect(key: SessionKey, expectGeneration: number | null): { check: ReturnType<SessionsService['targetCheck']>; starting: boolean; unsent: boolean } {
    const view = views.get(key);
    if (!view) {
      return { starting: false, unsent: false, check: { managed: false, live: false, generation: null, generationMatches: false, state: null, problem: 'Mini-Summa does not know this session.' } };
    }
    const isManaged = view.origin === 'managed';
    const live = view.availability === 'live';
    const generationMatches = expectGeneration === null || expectGeneration === view.generation;
    const starting = isManaged && live && startingKeys.has(key);
    const unsent = isManaged && live && !starting && managed.hasUnsentInput(key);
    let problem: string | null = null;
    const replaced = isManaged && live ? continuations.get(key) : undefined;
    if (!isManaged) problem = 'Mini-Summa only types into sessions it started itself. This session is observed only.';
    else if (!live) problem = availabilityProblem(view);
    else if (!generationMatches) problem = `This session restarted after the request was made (it is on run ${view.generation} now, the request was for run ${expectGeneration}).`;
    else if (starting) problem = STARTING_PROBLEM;
    else if (unsent) problem = UNSENT_INPUT_PROBLEM;
    else if (replaced) problem = continuationProblem(replaced);
    return { starting, unsent, check: { managed: isManaged, live, generation: view.generation, generationMatches, state: view.state, problem } };
  }

  const targetCheck = (key: SessionKey, expectGeneration: number | null): ReturnType<SessionsService['targetCheck']> => inspect(key, expectGeneration).check;

  /**
   * The permission request that is open now, with the PTY it came from: the projection's newest request since the session last
   * left needs_permission, unless it was logged before the terminal (re)started or is a hook of the earlier process that was
   * still waiting in a spool when it did.
   */
  function openPermission(key: SessionKey): PermissionRequestInfo | null {
    const view = views.get(key);
    if (!view || view.origin !== 'managed' || view.availability !== 'live' || view.state !== 'needs_permission' || startingKeys.has(key)) return null;
    const open = projection.currentPermission(key);
    if (!open) return null;
    const baseline = runBaselines.get(key);
    if (baseline && (open.info.rawSeq <= baseline.seq || (open.transportId !== null && baseline.waiting.has(open.transportId)))) return null;
    return open.info;
  }

  function refusal(check: ReturnType<typeof targetCheck>): TypeIntoResult | null {
    const problem = check.problem ?? 'The session cannot receive text right now.';
    if (!check.managed) return { ok: false, code: 'not_managed', problem };
    if (!check.live) return { ok: false, code: 'not_live', problem };
    if (!check.generationMatches) return { ok: false, code: 'generation_changed', problem };
    return null;
  }

  const stateWords = (states: readonly SessionState[]): string => states.map((s) => labelOf(s)).join(', ');

  // ---- starting ----------------------------------------------------------------------------------------------------------------

  function pickRoot(project: Project, req: StartSessionRequest, wantedEnv: EnvId) {
    const roots = [...project.roots].sort((a, b) => a.position - b.position);
    if (req.rootId) {
      const root = roots.find((r) => r.id === req.rootId);
      if (!root) throw unprocessable('That folder does not belong to this project.', 'root_not_in_project');
      if (req.env && req.env !== root.env) throw unprocessable(`That folder is in ${envLabel(root.env)}, not ${envLabel(req.env)}.`, 'root_env_mismatch');
      return root;
    }
    const root = roots.find((r) => r.env === wantedEnv);
    if (!root) {
      throw unprocessable(`This project has no folder in ${envLabel(wantedEnv)}. Add one in the project settings, then start the session again.`, 'no_root_for_env');
    }
    return root;
  }

  function resumeProblem(view: SessionView): string {
    if (view.availability === 'live') return 'That session is still running. Mini-Summa can resume a session only after it has ended; close it where it runs first.';
    return 'That session never received a prompt, so Claude Code has nothing to resume.';
  }

  // ---- the service ----------------------------------------------------------------------------------------------------------------

  const service: ObserverSessionsService = {
    list(opts) {
      let out = [...views.values()];
      if (opts?.projectId) out = out.filter((v) => v.projectId === opts.projectId);
      if (!opts?.includeEnded) out = out.filter((v) => v.availability !== 'ended');
      const when = (v: SessionView): string => v.lastActivityAt ?? v.startedAt ?? '';
      out.sort((a, b) => when(b).localeCompare(when(a)) || a.key.localeCompare(b.key));
      return out.map((v) => structuredClone(v));
    },

    get(key) {
      const v = views.get(key);
      return v ? structuredClone(v) : null;
    },

    async start(projectId, req, actor) {
      const project = projects.require(projectId);
      if (project.archivedAt) throw unprocessable('This project is archived. Restore it before starting a session.', 'project_archived');

      let resumeTarget: SessionView | null = null;
      if (req.mode === 'resume') {
        if (!req.resumeKey) throw badRequest('Say which session to resume.', undefined, 'resume_key_required');
        resumeTarget = views.get(req.resumeKey) ?? null;
        if (!resumeTarget) throw unprocessable('Mini-Summa does not know that session, so it cannot resume it.', 'resume_unknown');
      } else if (req.resumeKey) {
        throw badRequest('A new session cannot name a session to resume.', undefined, 'resume_key_unexpected');
      }

      const wantedEnv = req.env ?? resumeTarget?.env ?? project.defaultEnv;
      const root = pickRoot(project, req, wantedEnv);
      const env = root.env;
      if (resumeTarget && resumeTarget.env !== env) {
        throw unprocessable(`That session ran in ${envLabel(resumeTarget.env)}, so it can only be resumed there. Choose a folder in ${envLabel(resumeTarget.env)}.`, 'resume_env_mismatch');
      }
      // A folder typed as \\wsl$\ubuntu\... names the distribution in lower case; Windows lists it as "Ubuntu". The names are the
      // same distribution, so the listed spelling is the one that is used from here on (session keys, resume checks).
      const sameWsl = (a: EnvId, b: EnvId): boolean => a.startsWith('wsl:') && b.startsWith('wsl:') && a.slice(4).toLowerCase() === b.slice(4).toLowerCase();
      const info = (await environments.list()).find((e) => e.id === env || sameWsl(e.id, env));
      if (!info) throw unprocessable(`${envLabel(env)} is not available on this computer.`, 'environment_unavailable');
      if (!info.available) throw unprocessable(info.notes[0] ?? `Claude Code is not available in ${info.label}.`, 'environment_unavailable');
      if (resumeTarget && !resumeTarget.resumable) throw unprocessable(resumeProblem(resumeTarget), 'not_resumable');
      if (req.conversationId) {
        const conversation = projects.conversations.require(req.conversationId);
        if (conversation.projectId !== projectId) throw unprocessable('That ChatGPT conversation belongs to another project.', 'conversation_not_in_project');
      }

      const record = await managed.start({
        projectId, rootId: root.id, env: info.id,
        // Claude finds a transcript through the directory it runs in, so a resume goes back to where the session ran.
        cwd: resumeTarget?.cwd ?? root.path,
        name: req.name?.trim() ? req.name.trim() : null,
        remoteControl: req.remoteControl ?? settings.get().sessions.remoteControlByDefault,
        cols: clampInt(req.cols, 120, 20, 500), rows: clampInt(req.rows, 32, 5, 200),
        mode: req.mode,
        resumeSessionId: resumeTarget ? parseSessionKey(resumeTarget.key)?.sessionId : undefined,
        conversationId: req.conversationId ?? null,
      });
      observeRun(record); // normally noticed already, when the manager announced the record (before the process existed)
      log.info('Started a Claude session in a Mini-Summa terminal.', { key: record.key, project: projectId, env: info.id, mode: req.mode, by: actor.kind });
      refreshAndCommit(resumeTarget ? [record.key, resumeTarget.key] : [record.key]);
      const view = views.get(record.key);
      if (!view) throw new CoreError(500, 'session_missing', 'The session was started but Mini-Summa could not describe it.');
      return structuredClone(view);
    },

    async stop(key, opts) {
      if (!views.has(key) && !managed.get(key)) throw notFound('Session');
      if (!managed.get(key)) {
        throw unprocessable('Mini-Summa can only stop sessions it started itself. This one was started elsewhere, so it is only observed. Close it in the terminal where it runs.', 'not_managed');
      }
      await managed.stop(key, opts);
      refreshAndCommit([key]);
      return structuredClone(views.get(key)!);
    },

    bind(key, projectId) {
      const view = views.get(key);
      if (!view) throw notFound('Session');
      if (view.origin === 'managed' || managed.get(key)) {
        throw unprocessable('Mini-Summa started this session for a project, so its project cannot be changed here.', 'managed_session');
      }
      if (projectId === null) {
        clearManualBinding(db, key, nowIso(clock));
      } else {
        const project = projects.require(projectId);
        if (project.archivedAt) throw unprocessable('That project is archived. Restore it first, or choose another one.', 'project_archived');
        setManualBinding(db, key, projectId, nowIso(clock));
      }
      refreshAndCommit([key]);
      return structuredClone(views.get(key)!);
    },

    setDefault(key, isDefault) {
      const view = views.get(key);
      if (!view) throw notFound('Session');
      if (!view.projectId) throw unprocessable('Assign this session to a project first. Only a project\'s own session can be its default.', 'no_project');
      let project: Project;
      if (isDefault) project = projects.setDefaultSession(view.projectId, key);
      else {
        project = projects.require(view.projectId);
        // Clearing must not remove a different session's default.
        if (project.defaultSessionKey === key) project = projects.setDefaultSession(view.projectId, null);
      }
      refreshAndCommit([...views.values()].filter((v) => v.projectId === view.projectId).map((v) => v.key));
      return project;
    },

    conversationBinding: (key) => conversationOf(db, key),

    refreshDiscovery: (env) => discovery.runNow(env),

    discoveryStatus: () => discovery.status().map(({ env, ok, lastRunAt, error }) => ({ env, ok, lastRunAt, error })),

    targetCheck,

    async typeInto(key, req) {
      if (UNSAFE_TEXT.test(req.text)) {
        throw unprocessable('The text contains control characters (for example from copying terminal output). They cannot be typed safely, so nothing was sent. Remove them and try again.', 'unsafe_text');
      }
      await freshen();
      const { check, starting, unsent } = inspect(key, req.expectGeneration);
      const refused = refusal(check);
      if (refused) return refused;
      // Not even allowedStates can open this door: a terminal that is still starting may be showing a dialog where Enter means "no".
      if (starting) return { ok: false, code: 'state_not_allowed', problem: STARTING_PROBLEM };
      // Nor can the caller: this text would be appended to what a person typed at the terminal and submitted together with it.
      if (unsent) return { ok: false, code: 'state_not_allowed', problem: UNSENT_INPUT_PROBLEM };
      // The conversation was replaced and the new session is not settled: the text could land in a conversation nobody chose.
      if (check.problem && continuations.has(key)) return { ok: false, code: 'state_not_allowed', problem: check.problem };
      if (!req.allowedStates.includes(check.state as SessionState)) {
        return { ok: false, code: 'state_not_allowed', problem: `Claude is "${labelOf(check.state as SessionState)}" right now. Text can only be sent when it is: ${stateWords(req.allowedStates)}.` };
      }
      const pending = unsettled(key);
      if (pending) {
        return { ok: false, code: 'state_not_allowed', problem: pending === 'text'
          ? 'Text was sent to this session a moment ago and Claude has not picked it up yet. Wait until it starts working, then try again.'
          : 'An answer was sent to this session a moment ago and Claude has not reacted yet. Wait a moment, then try again.' };
      }
      if (req.submit) markSent(key, 'text'); // before the first await: two calls at once cannot both pass the check above
      const typed = await managed.typeText(key, req.text, { submit: req.submit });
      if (!typed) {
        inFlight.delete(key);
        return { ok: false, code: 'no_terminal', problem: 'The terminal for this session is not available any more, so nothing was typed.' };
      }
      return { ok: true, submitted: req.submit };
    },

    currentPermission(key) {
      const open = openPermission(key);
      return open ? { correlationKey: open.correlationKey, summary: permissionSummary(open) } : null;
    },

    async answerPermission(key, decision, expectGeneration, expectRequestKey) {
      await freshen();
      const { check, starting } = inspect(key, expectGeneration);
      const refused = refusal(check);
      if (refused) return refused;
      if (starting) return { ok: false, code: 'state_not_allowed', problem: STARTING_PROBLEM };
      if (check.problem && continuations.has(key)) return { ok: false, code: 'state_not_allowed', problem: check.problem };
      if (check.state !== 'needs_permission') {
        return { ok: false, code: 'state_not_allowed', problem: 'Claude is not waiting for a permission answer right now, so nothing was sent.' };
      }
      // The person decided on the request they were shown. If a newer one has arrived since, Enter would answer THAT dialog.
      if (expectRequestKey !== undefined && openPermission(key)?.correlationKey !== expectRequestKey) {
        return { ok: false, code: 'state_not_allowed', problem: STALE_PERMISSION_PROBLEM };
      }
      const pending = unsettled(key);
      if (pending) {
        return { ok: false, code: 'state_not_allowed', problem: 'An answer was sent to this session a moment ago and Claude has not reacted yet, so a second one was not sent.' };
      }
      markSent(key, 'answer');
      const sent = await managed.sendKeys(key, decision);
      if (!sent) {
        inFlight.delete(key);
        return { ok: false, code: 'no_terminal', problem: 'The terminal for this session is not available any more, so nothing was sent.' };
      }
      return { ok: true, submitted: true };
    },

    terminal: {
      attach(key, size, sink) {
        if (!managed.get(key)) return { error: 'Mini-Summa did not start this session, so there is no terminal to show. Sessions started elsewhere can only be observed.' };
        return managed.attach(key, size, sink);
      },
      // A client attached to a key that was replaced keeps working: it reaches the same terminal under its new id.
      input(key, data) {
        const k = terminalKeyFor(key);
        return managed.get(k) ? managed.write(k, data) : false;
      },
      resize(key, cols, rows) {
        const k = terminalKeyFor(key);
        if (managed.get(k)) managed.resize(k, cols, rows);
      },
    },

    subscribe(h) {
      handlers.add(h);
      return () => { handlers.delete(h); };
    },

    init() {
      initPromise ??= (async () => {
        managed.init(); // terminals of earlier runs died with their process; this marks them before any view is built
        for (const row of db.all<{ session_key: string; view_json: string }>('SELECT session_key, view_json FROM sessions_projection')) {
          const view = fromJson<SessionView | null>(row.view_json, null);
          if (view && parseSessionKey(row.session_key)) {
            views.set(row.session_key as SessionKey, view);
            viewJson.set(row.session_key as SessionKey, JSON.stringify(view));
          }
        }
        await ingestion.prepare();
        await registryFile.write();
        ingestion.drainKnown(); // the backlog happened while nobody was watching: it joins the replay below
        await queue.run(() => rebuildAndPublish());
        initialized = true;

        offs.push(managed.onChange((record, previous) => {
          if (shuttingDown) return;
          observeRun(record);
          // Terminal output alone changes lastOutputAt over and over; the view only needs the changes that mean something.
          if (previous && JSON.stringify({ ...record, lastOutputAt: null }) === JSON.stringify({ ...previous, lastOutputAt: null })) return;
          refreshAndCommit([record.key]);
          if (previous?.status === 'running' && record.status !== 'running') void ingestion.pass().catch((err) => log.warn('Spool pass after a terminal exit failed.', { error: String(err) }));
        }));
        offs.push(projects.onRootsChanged(() => {
          if (shuttingDown || rebuildQueued) return;
          rebuildQueued = true;
          queue.run(async () => {
            rebuildQueued = false;
            await registryFile.write();
            await rebuildAndPublish();
          }).catch((err) => log.error('Rebuilding after a project folder change failed.', { error: String(err) }));
        }));
        offs.push(bus.subscribe((_seq, event) => {
          if (event.type !== 'project.upserted' && event.type !== 'project.removed') return;
          // Names, default sessions and archived flags show up in views; the registry file lists the projects.
          queueMicrotask(() => {
            if (shuttingDown) return;
            void registryFile.write();
            refreshAndCommit(allKeys());
          });
        }));
        offs.push(settings.onChange((next, prev) => {
          if (next.sessions.discoveryIntervalSec !== prev.sessions.discoveryIntervalSec) discovery.reschedule();
          if (next.sessions.claudeCommand !== prev.sessions.claudeCommand) {
            void environments.list({ refresh: true })
              .then(() => ingestion.syncEnvironments())
              .then(() => discovery.runNow())
              .catch((err) => log.warn('Re-checking Claude Code after a settings change failed.', { error: String(err) }));
          }
        }));

        ingestion.start();
        discovery.start();
        void ingestion.syncEnvironments().catch((err) => log.warn('Looking for other environments failed.', { error: String(err) }));
      })();
      return initPromise;
    },

    async shutdown() {
      shuttingDown = true;
      for (const key of [...waits.keys()]) clearWait(key);
      discovery.stop();
      ingestion.stop();
      for (const off of offs.splice(0)) off();
      await Promise.race([queue.idle(), sleep(SHUTDOWN_WAIT_MS)]);
      await managed.shutdown();
    },

    async flush() {
      await ingestion.pass();
      await queue.idle();
    },

    rebuild: () => queue.run(() => rebuildAndPublish()),
  };

  return service;
}
