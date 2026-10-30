import { createHash } from 'node:crypto';
import { parseMarker } from './marker.mjs';

// Deterministic reducer: derived state is a pure function of the ordered raw log.
// See docs/DESIGN.md for the rules. In short:
//
// IDENTITIES (kept apart on purpose)
//   receipt     transport_id: one hook process invocation. Handled by the store, idempotent across restarts.
//   logical     one real Claude event. Native id when Claude provides one, otherwise
//               (content hash, occurrence) where occurrence counts identical deliveries FROM THE SAME
//               HANDLER. Two registered handlers delivering one event both reach occurrence N, so they
//               collapse. Two identical real events from one handler are occurrence 1 and 2, so they never do.
//   task        (session, prompt_id). Without a prompt_id a task cannot be identified; see report identity.
//   report      (task, body hash). With no prompt_id: (logical event, body hash).
//   notification  the derived transition id: a notification exists only for a state change.
//   delivery    (report, destination). Not implemented in this PoC.
//
// GENERATIONS
//   A session id can outlive a process (resume). Each process incarnation is a generation. Termination is
//   "observed" (SessionEnd hook, or the listed pid is dead on this host) or "suspected" (absent from a full
//   discovery snapshot). A stale hook must not revive a terminated generation; a later one may open a new one.

const sha = (s) => createHash('sha256').update(s).digest('hex');
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const stable = (v) => JSON.stringify(sortKeys(v));
const short = (sid) => String(sid).slice(0, 8);

export const LABELS = {
  idle: 'Idle', working: 'Working', needs_permission: 'Needs permission', needs_input: 'Needs input',
  waiting_for_you: 'Waiting for you (inferred)', turn_ended: 'Turn ended',
  background_wait: 'Turn ended, background work pending', report_ready: 'Report ready', error: 'Error',
  ended: 'Session ended', presence_lost: 'Presence lost (suspected)',
};

const NATIVE_ID = {
  UserPromptSubmit: (p) => p.prompt_id,
  PreToolUse: (p) => p.tool_use_id,
  PostToolUse: (p) => p.tool_use_id,
  PostToolUseFailure: (p) => p.tool_use_id,
};
const CONTENT = {
  SessionStart: (p) => ({ source: p.source, model: p.model }),
  SessionEnd: (p) => ({ reason: p.reason }),
  PermissionRequest: (p) => ({ tool_name: p.tool_name, tool_input: p.tool_input }),
  Notification: (p) => ({ type: p.notification_type, message: p.message, title: p.title }),
  Stop: (p) => ({ active: p.stop_hook_active, msg: p.last_assistant_message }),
  StopFailure: (p) => ({ error: p.error, details: p.error_details, msg: p.last_assistant_message }),
};

const sessionKey = (env, sid) => (!env || env === 'local' ? sid : `${env}|${sid}`);
const procMatch = (a, b) => Boolean(a && b && a.pid === b.pid && a.startedAt === b.startedAt);

export class Reducer {
  constructor({ registry }) {
    this.registry = registry;
    this.sessions = new Map();
    this.logical = new Map();      // logical id -> {seq, ev, key, occurrence, basis}
    this.duplicates = [];          // {seq, logical, duplicate_of_seq, basis}  (raw is never dropped)
    this.reports = new Map();
    this.candidates = new Map();
    this.derived = [];
    this.unattributed = 0;
    this.ordering_ambiguous = 0;
    this.stale_listings = 0;
  }

  // ---- sessions and generations ----
  #session(env, sid, cwd, projectDir) {
    const key = sessionKey(env, sid);
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        key, session_id: sid, env: env ?? 'local', cwd: null, project: null, project_reason: 'no_cwd',
        state: 'unknown', evidence: 'none', current_prompt_id: null, hook_seen: false, weak_identity: false,
        occ: new Map(), tasks: new Map(), observed: null, in_prev_snapshot: false, last_prompt_mono: null,
        gen: { n: 0, phase: 'none', proc: null, start_seen: false, term: null },
        generations: [],
      };
      this.sessions.set(key, s);
    }
    if (!s.project && (projectDir || cwd)) {
      s.cwd = cwd ?? projectDir; // sticky: resolved once from the first usable directory
      const r = this.registry.resolve(projectDir || cwd, s.env === 'local' ? undefined : s.env);
      s.project = r.project; s.project_reason = r.reason;
    }
    return s;
  }

  #openGeneration(s, cause, why, proc = null) {
    if (s.gen.n > 0 && s.gen.phase === 'live') s.generations.push({ ...s.gen, phase: 'superseded' });
    else if (s.gen.n > 0) s.generations.push(s.gen);
    s.gen = { n: s.gen.n + 1, phase: 'live', proc, start_seen: false, term: null };
    if (s.gen.n > 1) this.#emit('generation', s, { cause_key: cause.key, raw_seq: cause.seq, generation: s.gen.n, why });
  }

  #terminate(s, cause, phase, term) {
    s.gen.phase = phase;
    s.gen.term = { ...term, seq: cause.seq };
  }

  // Is this hook older than the termination that closed the current generation?
  #stale(s, t, entry) {
    const term = s.gen.term;
    if (!term) return false;
    const sameEnvMono = term.end_mono != null && t.monotonic_ns != null;
    if (sameEnvMono) return BigInt(t.monotonic_ns) < BigInt(term.end_mono);       // hook vs hook, same host clock
    if (term.ordering === 'barrier') return false;                                 // log order is causal
    if (term.at_ms != null && t.wall_ms != null) return t.wall_ms <= term.at_ms;   // fallback: wall clock
    this.ordering_ambiguous++;
    return true;                                                                   // unknown order: do not revive
  }

  #emit(kind, s, extra) {
    const d = {
      kind, session_id: s.session_id, env: s.env, generation: s.gen.n,
      project_id: s.project?.id ?? null,
      project_name: s.project?.name ?? `(unregistered ${s.cwd ?? 'unknown cwd'})`,
      registered: Boolean(s.project), notify: false, requires_user: false, ...extra,
    };
    d.derived_id = sha(`${kind}|${s.key}|${extra.cause_key ?? ''}|${extra.to ?? ''}`).slice(0, 16);
    if (extra.to) d.label = `${d.project_name} / Session ${short(s.session_id)} / ${extra.text ?? LABELS[extra.to]}`;
    this.derived.push(d);
    return d;
  }

  #transition(s, to, cause, extra = {}) {
    if (s.state === to) return null; // idempotent: no repeated transition, so no repeated notification
    const from = s.state; s.state = to; s.evidence = cause.evidence;
    return this.#emit('transition', s, {
      from, to, cause_key: cause.key, evidence: cause.evidence, raw_seq: cause.seq,
      notify: ['needs_permission', 'needs_input', 'error', 'presence_lost'].includes(to) && !extra.quiet,
      requires_user: ['needs_permission', 'needs_input'].includes(to), ...extra,
    });
  }

  apply(entry) {
    return entry.kind === 'discovery' ? this.#discovery(entry) : this.#hook(entry);
  }

  // ---- hook events ----
  #hook(entry) {
    const p = entry.payload ?? {}; const t = entry.transport ?? {};
    const ev = p.hook_event_name; const sid = p.session_id;
    if (!sid || !ev) { this.unattributed++; return; }
    const s = this.#session(t.env_id, sid, p.cwd, t.claude_project_dir);
    s.hook_seen = true;

    // logical identity
    const handler = t.handler_id ?? 'unknown';
    let key; let basis; let occurrence = 1;
    const nativeId = NATIVE_ID[ev]?.(p);
    if (nativeId) { key = `${ev}|${s.key}|${nativeId}`; basis = 'native'; }
    else {
      const h = sha(stable({ ev, prompt: p.prompt_id ?? null, c: (CONTENT[ev] ?? (() => p))(p) }));
      const ok = `${h}|${handler}`;
      occurrence = (s.occ.get(ok) ?? 0) + 1; s.occ.set(ok, occurrence);
      key = `${ev}|${s.key}|${h.slice(0, 24)}|${occurrence}`; basis = 'occurrence';
    }
    if (this.logical.has(key)) {
      this.duplicates.push({ seq: entry.seq, logical: key, duplicate_of_seq: this.logical.get(key).seq, basis, handler });
      return;
    }
    this.logical.set(key, { seq: entry.seq, ev, session: s.key, occurrence, basis });
    const cause = { key, seq: entry.seq, evidence: `hook:${ev}` };

    // generation handling
    let stale = false;
    if (s.gen.n === 0) this.#openGeneration(s, cause, 'first sight');
    else if (s.gen.phase !== 'live') {
      // A SessionEnd for a generation that is already closed is redundant history, never a new incarnation.
      if (ev === 'SessionEnd' || this.#stale(s, t, entry)) stale = true;
      else this.#openGeneration(s, cause, `resumed (${ev})`);
    } else if (ev === 'SessionStart' && ['startup', 'resume', 'fork', undefined].includes(p.source) && s.gen.start_seen) {
      this.#openGeneration(s, cause, 'new process announced itself with a second startup/resume');
    }
    if (ev === 'SessionStart' && !stale) s.gen.start_seen = true;

    const late = stale || Boolean(p.prompt_id && s.current_prompt_id && p.prompt_id !== s.current_prompt_id
      && !['SessionStart', 'SessionEnd', 'UserPromptSubmit'].includes(ev));
    if (late) this.#emit('late_event', s, { cause_key: key, hook_event: ev, prompt_id: p.prompt_id, raw_seq: entry.seq, stale_generation: stale });

    switch (ev) {
      case 'SessionStart':
        if (!stale && p.source !== 'compact') this.#transition(s, 'idle', cause, { text: `Idle (${p.source ?? 'start'})` });
        break;
      case 'UserPromptSubmit': {
        if (stale) break;
        const mono = t.monotonic_ns ? BigInt(t.monotonic_ns) : null;
        if (mono !== null && s.last_prompt_mono !== null && mono < s.last_prompt_mono) {
          this.#emit('late_event', s, { cause_key: key, hook_event: ev, prompt_id: p.prompt_id, raw_seq: entry.seq });
          break; // an older prompt arriving late must not become the current one
        }
        if (mono !== null) s.last_prompt_mono = mono;
        s.current_prompt_id = p.prompt_id ?? null;
        const tk = `${s.key}:${p.prompt_id ?? 'none'}`;
        if (!s.tasks.has(tk)) s.tasks.set(tk, { prompt_id: p.prompt_id ?? null, started_seq: entry.seq });
        this.#transition(s, 'working', cause);
        break;
      }
      case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure':
        if (!late) this.#transition(s, 'working', cause);
        break;
      case 'PermissionRequest':
        if (!late) this.#transition(s, 'needs_permission', cause);
        break;
      case 'Notification': {
        if (late) break;
        const nt = p.notification_type;
        if (nt === 'idle_prompt' && s.state === 'turn_ended') this.#transition(s, 'waiting_for_you', cause);
        else if (nt === 'elicitation_dialog' || nt === 'elicitation_url_dialog') this.#transition(s, 'needs_input', cause);
        break; // permission_prompt is a delayed echo of PermissionRequest
      }
      case 'Stop': this.#stop(s, p, entry, cause, late); break;
      case 'StopFailure':
        if (!late) this.#transition(s, 'error', cause, { text: `Error (${p.error ?? 'unknown'})` });
        break;
      case 'SessionEnd': {
        if (stale) break;
        const abnormal = ['working', 'needs_permission', 'needs_input'].includes(s.state);
        this.#terminate(s, cause, 'ended_observed', { kind: 'hook_session_end', end_mono: t.monotonic_ns ?? null,
          at_ms: t.wall_ms ?? null, ordering: 'hook' });
        this.#transition(s, 'ended', cause, abnormal
          ? { text: `Session ended while ${LABELS[s.state].toLowerCase()}, no Stop seen (${p.reason ?? 'unknown'})`, abnormal: true, notify: true }
          : { text: `Session ended (${p.reason ?? 'unknown'})` });
        break;
      }
      default:
        this.#emit('unhandled_event', s, { cause_key: key, hook_event: ev, raw_seq: entry.seq });
    }
  }

  #stop(s, p, entry, cause, late) {
    const msg = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
    const m = parseMarker(p.last_assistant_message);
    const bg = (p.background_tasks?.length ?? 0) + (p.session_crons?.length ?? 0);
    const taskId = `${s.key}:${p.prompt_id ?? 'none'}`;
    const bodyHash = sha(msg);
    const base = {
      session_id: s.session_id, env: s.env, generation: s.gen.n, project_id: s.project?.id ?? null,
      project_name: s.project?.name ?? null, cwd: s.cwd, prompt_id: p.prompt_id ?? null, task_id: taskId,
      body: msg, body_sha256: bodyHash, stop_hook_active: Boolean(p.stop_hook_active), late, captured_seq: entry.seq,
    };
    // Same prompt + same text is one report. With no prompt_id a task cannot be identified, so each
    // distinct logical Stop is its own report rather than risk merging two tasks.
    const id = sha(p.prompt_id ? `${taskId}|${bodyHash}` : `${cause.key}|${bodyHash}`).slice(0, 16);

    if (m.valid && bg === 0) {
      const report = { ...base, report_id: id, source: 'marker', declared_status: m.status, task_title: m.task,
        has_heading: m.has_heading, verified: false,
        note: 'The marker is a declaration written by the model, not evidence that the work or its tests succeeded.' };
      if (this.reports.has(id)) this.#emit('report_duplicate', s, { cause_key: cause.key, report_id: id, raw_seq: entry.seq });
      else {
        this.reports.set(id, report);
        this.#emit('report_ready', s, { cause_key: cause.key, report_id: id, declared_status: m.status, task_title: m.task,
          late, raw_seq: entry.seq, notify: true, to: 'report_ready', text: `Report ready, declared ${m.status}: ${m.task}` });
      }
      if (!late) { s.state = 'report_ready'; s.evidence = cause.evidence; }
      return;
    }
    const reason = m.valid ? 'marker_present_but_background_work_pending' : m.reason;
    if (!this.candidates.has(id)) {
      this.candidates.set(id, { ...base, candidate_id: id, reason, declared_status: m.valid ? m.status : null,
        task_title: m.valid ? m.task : null, promoted: false });
    }
    if (late) return;
    this.#transition(s, bg > 0 ? 'background_wait' : 'turn_ended', cause);
  }

  // ---- discovery snapshots ----
  #discovery(entry) {
    const snap = entry.payload; const t = entry.transport ?? {};
    const env = t.env_id ?? 'local';
    const full = !snap.scope?.cwd;
    const ordering = snap.barrier ? 'barrier' : (t.wall_ms != null || t.received_at ? 'clock' : 'arrival');
    const at_ms = t.wall_ms ?? (Date.parse(t.received_at) || null);
    const present = new Set();

    for (const o of snap.sessions) {
      const sid = o.sessionId ?? `nosid:${o.pid ?? 'x'}:${o.startedAt ?? 'x'}`;
      const known = this.sessions.has(sessionKey(env, sid));
      const s = this.#session(env, sid, o.cwd, null);
      present.add(s.key);
      s.weak_identity = !o.sessionId;
      const proc = { pid: o.pid ?? null, startedAt: o.startedAt ?? null };
      const cause = { key: `discovery:${entry.seq}:${s.key}`, seq: entry.seq, evidence: 'discovery' };

      if (o.pid_alive === false) { // listed, but its process is gone on this host: observed exit
        if (s.gen.phase === 'live' && (!s.gen.proc || procMatch(s.gen.proc, proc))) {
          this.#terminate(s, cause, 'ended_observed', { kind: 'process_exit', ordering, at_ms });
          this.#transition(s, 'ended', cause, { text: `Process exited (observed, pid ${o.pid})`, notify: s.state === 'working' || s.state === 'needs_permission' });
        } else this.stale_listings++;
        continue;
      }
      if (s.gen.n === 0) this.#openGeneration(s, cause, 'discovered', proc);
      else if (s.gen.phase === 'live') {
        if (s.gen.proc && !procMatch(s.gen.proc, proc)) this.#openGeneration(s, cause, 'different process now serves this session id', proc);
        else if (!s.gen.proc) s.gen.proc = proc;
      } else { // terminated generation
        const same = procMatch(s.gen.proc, proc);
        if (same && s.gen.phase === 'ended_observed') { this.stale_listings++; continue; }              // lingering entry
        if (same && s.gen.phase === 'lost_suspected') { s.gen.phase = 'live'; s.gen.term = null; s.state = 'unknown'; } // listing flapped
        else if (!same && !s.gen.proc && ordering !== 'barrier' && s.gen.term?.at_ms != null && at_ms != null && at_ms <= s.gen.term.at_ms) { this.stale_listings++; continue; }
        else this.#openGeneration(s, cause, 'listed alive after the previous generation ended', proc);
      }
      s.observed = { status: o.status ?? null, waitingFor: o.waitingFor ?? null, kind: o.kind, pid: o.pid ?? null };
      s.in_prev_snapshot = true;
      if (!known) this.#emit('session_discovered', s, { cause_key: cause.key, raw_seq: entry.seq, observed: s.observed,
        to: 'discovered', text: `Discovered (${o.kind}, ${o.status ?? 'status unknown'})` });

      // hooks say busy, the process says idle, and no Stop arrived: interrupts fire no Stop. Inferred only.
      if (s.hook_seen && o.status === 'idle' && ['working', 'needs_permission', 'needs_input'].includes(s.state)) {
        this.#transition(s, 'idle', cause, { text: 'Idle, no Stop seen (observed; likely interrupted)' });
      }
      if (!s.hook_seen) { // no hooks from this session: discovery is the only evidence
        const to = o.status === 'busy' ? 'working'
          : o.status === 'waiting' ? (o.waitingFor === 'permission prompt' ? 'needs_permission' : 'needs_input')
          : o.status === 'idle' ? 'idle' : null;
        if (to) this.#transition(s, to, cause, { text: `${LABELS[to]} (observed only)` });
      }
    }
    if (full) {
      for (const s of this.sessions.values()) {
        if (s.env !== env || present.has(s.key)) continue;
        if (s.in_prev_snapshot && s.gen.phase === 'live') {
          const cause = { key: `lost:${entry.seq}:${s.key}`, seq: entry.seq, evidence: 'discovery:absent' };
          this.#terminate(s, cause, 'lost_suspected', { kind: 'absent_from_snapshot', ordering, at_ms });
          this.#transition(s, 'presence_lost', cause);
        }
      }
    }
  }
}

export function replay(entries, registry) {
  const r = new Reducer({ registry });
  for (const e of entries) r.apply(e);
  return r;
}
