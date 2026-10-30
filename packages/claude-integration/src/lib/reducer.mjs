import { createHash } from 'node:crypto';
import { parseMarker } from './marker.mjs';
import { markerOf, compareMarkers } from './clock.mjs';

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
// GENERATIONS AND ORDERING
//   A session id can outlive a process (resume). Each process incarnation is a generation.
//   Termination is "observed" (SessionEnd hook, or a listed pid that is dead on this host) or "suspected" (absent
//   from a full discovery snapshot).
//
//   Closing a generation and opening the next are both TERMINAL transitions, so both need affirmative evidence:
//     * A generic hook (tool use, permission, notification, Stop, prompt...) never opens a generation. It says the
//       session id is active, not that a new process exists. After a termination it is kept as history and listed
//       as unresolved activity.
//     * A generation opens only on (a) a startup/resume/fork SessionStart that is ORDERED after the termination or
//       after the previous start, or (b) discovery listing a live process whose identity (pid, start time) differs
//       from the closed generation's known process.
//   "Ordered after" comes only from: a snapshot's interval classification (a hook that landed after the snapshot's
//   completion), or two hooks of the same environment inside one trusted monotonic clock domain. Wall clocks never
//   establish order. Everything else is "uncertain", and uncertain stays uncertain.
//
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

const NEW_PROCESS_SOURCES = new Set(['startup', 'resume', 'fork']); // clear and compact happen inside a live process
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
    this.ordering_ambiguous = 0;   // hooks withheld from state because their order is not established
    this.stale_listings = 0;
    this.discovery_errors = 0;
    this.snapshots = new Map();    // raw seq -> {interval: bool, uncertain: Set<transport id>}
  }

  // ---- sessions and generations ----
  #session(env, sid, cwd, projectDir) {
    const key = sessionKey(env, sid);
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        key, session_id: sid, env: env ?? 'local', cwd: null, project: null, project_reason: 'no_cwd',
        state: 'unknown', evidence: 'none', current_prompt_id: null, hook_seen: false, weak_identity: false,
        occ: new Map(), tasks: new Map(), observed: null, in_prev_snapshot: false, last_prompt_mark: null,
        gen: { n: 0, phase: 'none', proc: null, start: null, open: null, term: null },
        generations: [], unresolved: [],
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

  // `open` records the evidence that justified this generation: {kind:'hook', marker} or {kind:'discovery', snapshot_seq}.
  #openGeneration(s, cause, why, proc = null, open = null) {
    if (s.gen.n > 0) s.generations.push({ ...s.gen, phase: s.gen.phase === 'live' ? 'superseded' : s.gen.phase, unresolved: s.unresolved });
    s.unresolved = [];
    s.gen = { n: s.gen.n + 1, phase: 'live', proc, start: null, open, term: null };
    // A new incarnation has not been listed by any snapshot yet. What discovery saw of the previous one must not carry over,
    // or a full snapshot that does not list the new process would declare it "lost" on the strength of the old one
    // (docs/CHANGES-FROM-POC.md, change 4). When discovery itself opens the generation it records the listing right after.
    s.in_prev_snapshot = false; s.observed = null;
    if (s.gen.n > 1) this.#emit('generation', s, { cause_key: cause.key, raw_seq: cause.seq, generation: s.gen.n, why });
  }

  #terminate(s, cause, phase, term) {
    s.gen.phase = phase;
    s.gen.term = { ...term, seq: cause.seq };
  }

  // How does a hook receipt relate to a snapshot interval? 'after' only if it landed after the snapshot completed.
  #relationToSnapshot(snapshotSeq, mk) {
    const snap = this.snapshots.get(snapshotSeq);
    if (!snap || !snap.interval) return 'uncertain';              // no interval metadata: nothing can be claimed
    if (!mk.tid || snap.uncertain.has(mk.tid)) return 'uncertain'; // in flight while the call ran
    return 'after';                                                // landed after the call had returned
  }

  // Relation of a hook receipt to the event that closed the current generation.
  #relationToTermination(s, mk) {
    const term = s.gen.term;
    if (!term) return 'uncertain';
    if (term.kind === 'hook_session_end') return compareMarkers(term.marker, mk);
    return this.#relationToSnapshot(term.snapshot_seq, mk);
  }

  // Relation of a hook receipt to the evidence that opened the current generation.
  #relationToOpening(s, mk) {
    const o = s.gen.open;
    if (!o) return 'uncertain';
    return o.kind === 'hook' ? compareMarkers(o.marker, mk) : this.#relationToSnapshot(o.snapshot_seq, mk);
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
    if (entry.kind === 'discovery_error') { this.discovery_errors++; return; } // observed nothing: infers nothing
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
    const mk = markerOf(t);
    const NEW_PROCESS = ev === 'SessionStart' && NEW_PROCESS_SOURCES.has(p.source ?? 'startup');
    let stale = false; let unresolved = null;
    if (s.gen.n === 0) this.#openGeneration(s, cause, 'first sight', null, { kind: 'hook', marker: mk });
    else if (s.gen.phase !== 'live') {
      if (ev === 'SessionEnd') stale = true;                              // redundant history, never a new incarnation
      else {
        const rel = this.#relationToTermination(s, mk);
        if (NEW_PROCESS && rel === 'after') this.#openGeneration(s, cause, 'startup/resume ordered after the termination', null, { kind: 'hook', marker: mk });
        else {
          stale = true;
          unresolved = { relation: rel, why: NEW_PROCESS ? 'startup/resume SessionStart whose order relative to the termination is not established'
            : 'a generic hook after termination is activity, not evidence of a new process' };
        }
      }
    } else if (NEW_PROCESS && s.gen.start) {                              // a second startup/resume inside a live generation
      const rel = compareMarkers(s.gen.start, mk);
      if (rel === 'after') this.#openGeneration(s, cause, 'second startup/resume ordered after the first', null, { kind: 'hook', marker: mk });
      else { stale = true; unresolved = { relation: rel, why: rel === 'before' ? 'SessionStart of an older process delivered late' : 'second startup/resume whose order is not established' }; }
    } else if (ev === 'SessionEnd' && s.gen.n > 1) {                      // may belong to an earlier generation
      const rel = this.#relationToOpening(s, mk);
      if (rel !== 'after') { stale = true; unresolved = { relation: rel, why: 'SessionEnd not shown to belong to the current generation' }; }
    }
    if (NEW_PROCESS && !stale) s.gen.start = s.gen.start ?? mk;
    if (unresolved) {
      if (unresolved.relation === 'uncertain') { this.ordering_ambiguous++; s.unresolved.push({ seq: entry.seq, hook_event: ev, relation: 'uncertain', why: unresolved.why });
        this.#emit('unresolved_ordering', s, { cause_key: key, hook_event: ev, relation: 'uncertain', why: unresolved.why, raw_seq: entry.seq }); }
    }

    const late = stale || Boolean(p.prompt_id && s.current_prompt_id && p.prompt_id !== s.current_prompt_id
      && !['SessionStart', 'SessionEnd', 'UserPromptSubmit'].includes(ev));
    if (late) this.#emit('late_event', s, { cause_key: key, hook_event: ev, prompt_id: p.prompt_id, raw_seq: entry.seq, stale_generation: stale });

    switch (ev) {
      case 'SessionStart':
        if (!stale && p.source !== 'compact') this.#transition(s, 'idle', cause, { text: `Idle (${p.source ?? 'start'})` });
        break;
      case 'UserPromptSubmit': {
        if (stale) break;
        if (s.last_prompt_mark && compareMarkers(s.last_prompt_mark, mk) === 'before') {
          this.#emit('late_event', s, { cause_key: key, hook_event: ev, prompt_id: p.prompt_id, raw_seq: entry.seq });
          break; // a prompt known to be older, delivered late, must not become the current one
        }
        if (mk.domain) s.last_prompt_mark = mk;
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
        this.#terminate(s, cause, 'ended_observed', { kind: 'hook_session_end', marker: mk });
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
    // How much the hook had to hide or cut when it captured this Stop (never what). Counts for the whole hook payload, as the
    // capture script records them in its transport; 0 when the entry carries none (docs/CHANGES-FROM-POC.md, change 8).
    const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    const base = {
      session_id: s.session_id, env: s.env, generation: s.gen.n, project_id: s.project?.id ?? null,
      project_name: s.project?.name ?? null, cwd: s.cwd, prompt_id: p.prompt_id ?? null, task_id: taskId,
      body: msg, body_sha256: bodyHash, stop_hook_active: Boolean(p.stop_hook_active), late, captured_seq: entry.seq,
      redactions: count(entry.transport?.redactions), truncations: count(entry.transport?.truncations),
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
    // Remember how this snapshot's interval classified hook receipts (see snapshot.mjs). Without interval metadata
    // (a legacy or hand-made snapshot) every later hook is "uncertain" relative to it.
    this.snapshots.set(entry.seq, { interval: Boolean(snap.interval?.complete), uncertain: new Set(snap.interval?.uncertain ?? []) });
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
          this.#terminate(s, cause, 'ended_observed', { kind: 'process_exit', snapshot_seq: entry.seq });
          this.#transition(s, 'ended', cause, { text: `Process exited (observed, pid ${o.pid})`, notify: s.state === 'working' || s.state === 'needs_permission' });
        } else this.stale_listings++;
        continue;
      }
      if (s.gen.n === 0) this.#openGeneration(s, cause, 'discovered', proc, { kind: 'discovery', snapshot_seq: entry.seq });
      else if (s.gen.phase === 'live') {
        if (s.gen.proc && !procMatch(s.gen.proc, proc)) this.#openGeneration(s, cause, 'different process now serves this session id', proc, { kind: 'discovery', snapshot_seq: entry.seq });
        else if (!s.gen.proc) s.gen.proc = proc;
      } else { // terminated generation
        const same = procMatch(s.gen.proc, proc);
        if (same && s.gen.phase === 'ended_observed') { this.stale_listings++; continue; }   // lingering entry of a process known to be dead
        if (same && s.gen.phase === 'lost_suspected') { s.gen.phase = 'live'; s.gen.term = null; s.state = 'unknown'; } // the SAME process reappeared: revise
        else if (s.gen.proc && !same) {                                                     // a distinguishable live process identity
          this.#openGeneration(s, cause, 'discovery lists a different live process for this session id', proc, { kind: 'discovery', snapshot_seq: entry.seq });
        } else {
          // The closed generation never had a known process, so this listing cannot be told apart from the dying tail of
          // the old process. Keep it as visible, unresolved evidence; do not invent an incarnation.
          this.ordering_ambiguous++;
          s.unresolved.push({ seq: entry.seq, hook_event: 'discovery_listing', relation: 'uncertain', why: 'live listing but the closed generation has no known process identity' });
          this.#emit('unresolved_ordering', s, { cause_key: cause.key, hook_event: 'discovery_listing', relation: 'uncertain',
            why: 'live listing but the closed generation has no known process identity', raw_seq: entry.seq });
          continue;
        }
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
          this.#terminate(s, cause, 'lost_suspected', { kind: 'absent_from_snapshot', snapshot_seq: entry.seq });
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
