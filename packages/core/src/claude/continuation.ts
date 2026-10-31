// Follow the process, not the id.
//
// Claude Code keeps running in the SAME process when the conversation is replaced: `/clear` (SessionEnd reason "clear", then
// SessionStart source "clear" with a brand-new session id), `/resume <id>` (reason "resume", source "resume", an older id), and
// "clear context and proceed" after a plan. A terminal Mini-Summa started was bound to the id it was started with, so without
// this module the managed session "ended" while its terminal went on, and the new id showed up as a stranger that cannot be
// typed into. This module decides, as a pure function of facts, when a new session id PROVABLY belongs to a terminal Mini-Summa
// owns, so the managed record can follow it (ManagedManagerExtras.rekey). sessions.ts gathers the facts and acts on the verdict.
//
// EVIDENCE, strongest first
//   1. pid (authenticated). Mini-Summa spawned the terminal, so it knows the process id; `claude agents --json` is asked by
//      Mini-Summa itself and lists every session with the pid that serves it. A session listed with the terminal's pid (or the
//      pid of a process the terminal started: a launcher script that did not exec) is served by that terminal. Nothing that is
//      written into the spool can change this. When the listing is usable, it DECIDES, in both directions: it adopts, and it
//      refuses (a session listed with another process' pid is a stranger, whatever the hooks say).
//   2. hooks (only as trustworthy as the spool, which every process of the same user can write to). Used ONLY when the pid
//      cannot be compared at all (the core runs on another side of Windows/WSL than the terminal, the pid is not known yet, the
//      listing never shows this process, discovery fails) and only with all of: the terminal is live, its current session ended
//      with reason clear/resume and that end came through the managed hook registration, the new session announced itself with
//      SessionStart source clear/resume through the same registration, in the same folder, the id is brand new (a "clear" start
//      is the first hook ever seen for it), and the pairing is unique: exactly one such terminal and exactly one such session in
//      that environment and folder. Anything else is ambiguous and is NOT guessed.
//
// Never adopted, whatever the evidence: a session of another environment (win and wsl:X are never merged), a session another
// live terminal of Mini-Summa runs, a session a healthy listing shows under another process.
import { makeSessionKey, rootKey, UUID_RE } from '@minisumma/shared';
import type { EnvId, SessionKey } from '@minisumma/shared';

/** The hook registration that managed settings files use (settingsFile.ts MANAGED_HANDLER_ID). */
export const MANAGED_HANDLER = 'ms-managed';

/** SessionEnd reasons / SessionStart sources that mean "the conversation was replaced inside the running process". */
export const REPLACEMENT_REASONS: readonly string[] = ['clear', 'resume'];
export const isReplacementReason = (reason: unknown): boolean => typeof reason === 'string' && REPLACEMENT_REASONS.includes(reason);

export type ReplacementCause = 'clear' | 'resume' | 'other';

// ---------------------------------------------------------------------------------------------------------------
// Facts (all plain data; sessions.ts builds them from the Reducer host, the managed records and the discovery listing)

/** One delivery of a SessionStart / SessionEnd hook. */
export interface HookMark {
  /** Position in the raw log. */
  seq: number;
  /** SessionStart `source` / SessionEnd `reason`. */
  value: string | null;
  /** The hook registration that delivered it (transport.handler_id). */
  handler: string | null;
  cwd: string | null;
}

/** What the log says about the SessionStart / SessionEnd hooks of one session id. */
export interface SessionTrace {
  /** The first hook ever applied for the id. A brand-new id from /clear has a SessionStart "clear" here. */
  first: { event: string; value: string | null; seq: number } | null;
  starts: HookMark[];
  ends: HookMark[];
}

/** One row of `claude agents --json` as recorded in a full snapshot. */
export interface ListedProcess {
  sessionId: string | null;
  pid: number | null;
  /** false = the process is verifiably dead on this host; null = cannot be checked. */
  pidAlive: boolean | null;
  kind: string | null;
  cwd: string | null;
}

export interface EnvEvidence {
  env: EnvId;
  /** Process ids of this environment can be compared with the ids of the terminals (the core runs in it). */
  comparable: boolean;
  /** The newest full snapshot, or null when there is none or the newest discovery call failed. */
  listing: ListedProcess[] | null;
}

export type Phase = 'none' | 'live' | 'ended_observed' | 'lost_suspected';

export interface TerminalFact {
  key: SessionKey;
  env: EnvId;
  sessionId: string;
  /** Folders the session is known to run in (where the terminal was started, where the Reducer saw it). */
  cwds: string[];
  /** The process id of the terminal (null = not known yet). */
  pid: number | null;
  phase: Phase;
  trace: SessionTrace | null;
  /** Fresh listings did not show this process although they were asked for: pid evidence is treated as unavailable. */
  listingBlind: boolean;
}

export interface CandidateFact {
  key: SessionKey;
  env: EnvId;
  sessionId: string;
  cwd: string | null;
  phase: Phase;
  trace: SessionTrace | null;
  /** A live terminal of Mini-Summa runs this id already. */
  managedRunning: boolean;
}

export interface ContinuationInput {
  terminals: TerminalFact[];
  candidates: CandidateFact[];
  envs: ReadonlyMap<EnvId, EnvEvidence>;
  /** true: `pid` is `of` or a process it started. false: known not to be. null: cannot be told. */
  ancestry: (pid: number, of: number) => boolean | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Verdict

export interface Adoption {
  terminal: SessionKey;
  to: SessionKey;
  toSessionId: string;
  via: 'pid' | 'hooks';
  cause: ReplacementCause;
  why: string;
}

export interface Unresolved {
  terminal: SessionKey;
  /** Sessions that could be the one. */
  candidates: SessionKey[];
  text: string;
}

export interface ContinuationDecision {
  adopt: Adoption[];
  /** Terminals whose current session ended by replacement and whose successor is expected to show up in a fresh listing. */
  pending: SessionKey[];
  unresolved: Unresolved[];
}

const AMBIGUOUS_HOOKS_TEXT = 'The conversation in this terminal was replaced (/clear or /resume), but Mini-Summa cannot tell which new session the terminal runs: '
  + 'more than one terminal or session in this folder could be it, and the process ids cannot settle it. Typing from Mini-Summa is paused here; the terminal itself still works.';
const AMBIGUOUS_PID_TEXT = 'The conversation in this terminal was replaced (/clear or /resume), but Claude lists several sessions for this terminal\'s process, '
  + 'so Mini-Summa cannot tell which one it is. Typing from Mini-Summa is paused here; the terminal itself still works.';

export const PENDING_TEXT = 'Conversation replaced (/clear or /resume): learning the new session id';

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const lastOf = <T>(list: readonly T[]): T | undefined => list[list.length - 1];
const viaManaged = (m: HookMark): boolean => m.handler === MANAGED_HANDLER;

/** The folder spellings are compared in the namespace of the environment (case on Windows, /mnt/c in WSL). */
function sameFolder(env: EnvId, a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try { return rootKey(env, a) === rootKey(env, b); } catch { return a === b; }
}

/** Newest start of the terminal's current session (any source) — the end must come after it to be this life's end. */
function lastStartSeq(trace: SessionTrace | null): number {
  return lastOf(trace?.starts ?? [])?.seq ?? 0;
}

/** How the terminal's current session ended, if it ended by replacement through the managed hook registration. */
function replacementEnd(t: TerminalFact): { cause: ReplacementCause; seq: number } | null {
  const end = lastOf((t.trace?.ends ?? []).filter((e) => viaManaged(e) && isReplacementReason(e.value)));
  if (!end) return null;
  // An end that predates the latest start belongs to an earlier life of the same id (it was resumed back into this terminal).
  if (end.seq < lastStartSeq(t.trace)) return null;
  return { cause: end.value === 'resume' ? 'resume' : 'clear', seq: end.seq };
}

type PidEvidence =
  | { kind: 'serves_current' }
  | { kind: 'proves'; sessionId: string }
  | { kind: 'ambiguous' }
  | { kind: 'not_listed' }
  | { kind: 'unavailable'; why: string };

/** What the listing says about the process of a terminal. */
function pidEvidence(t: TerminalFact, ev: EnvEvidence | undefined, ancestry: ContinuationInput['ancestry']): PidEvidence {
  if (!ev || !ev.comparable) return { kind: 'unavailable', why: 'the process ids of this environment cannot be compared with the terminal\'s' };
  if (t.pid === null || !(t.pid > 0)) return { kind: 'unavailable', why: 'the terminal\'s process id is not known' };
  if (!ev.listing) return { kind: 'unavailable', why: 'no usable listing of Claude\'s sessions' };
  // A listed process that IS the terminal's process settles it. Only when none is, processes the terminal started count (a
  // launcher script that did not exec): otherwise a `claude -p` that a tool of the session started would be mistaken for it.
  const alive = ev.listing.filter((row) => row.pid !== null && row.pidAlive !== false);
  const mine: ListedProcess[] = alive.filter((row) => row.pid === t.pid);
  let unknown = false;
  if (mine.length === 0) {
    for (const row of alive) {
      const related = ancestry(row.pid as number, t.pid);
      if (related === true) mine.push(row);
      else if (related === null) unknown = true;
    }
  }
  if (mine.length === 0) {
    if (unknown) return { kind: 'unavailable', why: 'the listed process ids cannot be traced back to the terminal' };
    return t.listingBlind ? { kind: 'unavailable', why: 'the listing does not show this process' } : { kind: 'not_listed' };
  }
  const ids = [...new Set(mine.map((r) => r.sessionId).filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return { kind: 'unavailable', why: 'the listing names no session for this process' };
  if (ids.includes(t.sessionId.toLowerCase())) return { kind: 'serves_current' };
  if (ids.length === 1) return { kind: 'proves', sessionId: ids[0] };
  return { kind: 'ambiguous' };
}

const causeOf = (c: CandidateFact | undefined, end: { cause: ReplacementCause } | null): ReplacementCause => {
  const start = lastOf((c?.trace?.starts ?? []).filter((s) => isReplacementReason(s.value)));
  if (start) return start.value === 'resume' ? 'resume' : 'clear';
  return end?.cause ?? 'other';
};

/** Is a listed process of a session that is NOT the terminal's own (known: different, comparable)? */
function listedElsewhere(c: CandidateFact, t: TerminalFact, ev: EnvEvidence | undefined, ancestry: ContinuationInput['ancestry']): boolean {
  if (!ev || !ev.comparable || !ev.listing || t.pid === null || !(t.pid > 0)) return false;
  for (const row of ev.listing) {
    if (row.pid === null || row.pidAlive === false || (row.sessionId ?? '').toLowerCase() !== c.sessionId.toLowerCase()) continue;
    const related = row.pid === t.pid ? true : ancestry(row.pid, t.pid);
    if (related === false) return true;
  }
  return false;
}

/** May this session be the successor of the terminal according to its hooks alone? */
function announcedBy(c: CandidateFact, t: TerminalFact): { cause: ReplacementCause } | null {
  const terminalStart = lastStartSeq(t.trace);
  const starts = (c.trace?.starts ?? []).filter((s) => viaManaged(s) && isReplacementReason(s.value) && s.seq > terminalStart);
  const start = lastOf(starts);
  if (!start || c.phase !== 'live') return null;
  // "clear" creates a brand-new id: the announcement is the very first thing ever heard of it. A claim of "clear" for an id
  // that already has a history is not a /clear.
  if (start.value === 'clear' && !(c.trace?.first?.event === 'SessionStart' && c.trace.first.value === 'clear')) return null;
  if (!t.cwds.some((cwd) => sameFolder(t.env, cwd, start.cwd ?? c.cwd))) return null;
  return { cause: start.value === 'resume' ? 'resume' : 'clear' };
}

// ---------------------------------------------------------------------------------------------------------------

export function decideContinuations(input: ContinuationInput): ContinuationDecision {
  const adopt: Adoption[] = [];
  const pending: SessionKey[] = [];
  const unresolved: Unresolved[] = [];
  const claimed = new Set<SessionKey>();
  const byKey = new Map(input.candidates.map((c) => [c.key, c]));
  const needHooks: TerminalFact[] = [];

  // ---- 1. the process id decides wherever it can
  for (const t of input.terminals) {
    const ev = input.envs.get(t.env);
    const p = pidEvidence(t, ev, input.ancestry);
    switch (p.kind) {
      case 'serves_current':
        // The listing says the process still serves the old id. If the hooks say it ended by replacement, the listing is older
        // than the hooks: ask for a fresh one. Otherwise nothing happened.
        if (replacementEnd(t)) pending.push(t.key);
        break;
      case 'proves': {
        const to = makeSessionKey(t.env, p.sessionId);
        const c = byKey.get(to);
        if (c?.managedRunning || claimed.has(to)) {
          unresolved.push({ terminal: t.key, candidates: [to], text: 'Claude lists a session for this terminal that another Mini-Summa terminal already runs, so Mini-Summa cannot tell which terminal it is. Typing from Mini-Summa is paused here.' });
          break;
        }
        claimed.add(to);
        adopt.push({
          terminal: t.key, to, toSessionId: p.sessionId, via: 'pid', cause: causeOf(c, replacementEnd(t)),
          why: `Claude Code lists session ${p.sessionId} for process ${t.pid}, the process of this terminal`,
        });
        break;
      }
      case 'ambiguous':
        unresolved.push({ terminal: t.key, candidates: [], text: AMBIGUOUS_PID_TEXT });
        break;
      case 'not_listed':
        // Healthy listing, comparable ids, but this process is not in it (yet). If the hooks say the conversation was
        // replaced, the successor is expected in the next listing: ask for one. Otherwise nothing happened.
        if (replacementEnd(t) || input.candidates.some((c) => c.env === t.env && !c.managedRunning && announcedBy(c, t))) pending.push(t.key);
        break;
      case 'unavailable':
        needHooks.push(t);
        break;
    }
  }

  // ---- 2. hooks, for terminals whose process cannot be matched (strict, and never a guess)
  const needing = needHooks.filter((t) => replacementEnd(t) !== null);
  const groups = new Map<string, TerminalFact[]>();
  for (const t of needing) {
    const g = `${t.env}|${rootKey(t.env, t.cwds[0] ?? '')}`;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  for (const terminals of groups.values()) {
    const sample = terminals[0];
    const ev = input.envs.get(sample.env);
    // Candidates are the sessions that announced themselves in this folder; each terminal looks at them through its own eyes.
    const pool = input.candidates.filter((c) => c.env === sample.env && !c.managedRunning && !claimed.has(c.key) && c.phase === 'live');
    const perTerminal = terminals.map((t) => ({
      t,
      list: pool.filter((c) => c.key !== t.key && announcedBy(c, t) !== null && !listedElsewhere(c, t, ev, input.ancestry)),
    }));
    const union = new Set(perTerminal.flatMap((e) => e.list.map((c) => c.key)));
    if (union.size === 0) {
      // The old session ended, the new one has not announced itself yet.
      for (const { t } of perTerminal) pending.push(t.key);
      continue;
    }
    if (terminals.length === 1 && union.size === 1) {
      const t = terminals[0];
      const c = perTerminal[0].list[0];
      claimed.add(c.key);
      adopt.push({
        terminal: t.key, to: c.key, toSessionId: c.sessionId, via: 'hooks', cause: announcedBy(c, t)!.cause,
        why: `the terminal's session ended with /clear or /resume and exactly one new session announced itself through the managed hooks in the same folder`,
      });
      continue;
    }
    for (const { t, list } of perTerminal) unresolved.push({ terminal: t.key, candidates: list.map((c) => c.key), text: AMBIGUOUS_HOOKS_TEXT });
  }

  return { adopt, pending, unresolved };
}

// ---------------------------------------------------------------------------------------------------------------
// The words the left-behind record carries (managed_sessions.exit_reason), shared by the writer and sessionView.ts

const REPLACED_RE = /^replaced:([a-z]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const replacedReason = (cause: ReplacementCause, sessionId: string): string => `replaced:${cause}:${sessionId.toLowerCase()}`;

export function parseReplacedReason(reason: string | null | undefined): { cause: ReplacementCause; sessionId: string } | null {
  const m = reason ? REPLACED_RE.exec(reason) : null;
  if (!m) return null;
  return { cause: m[1] === 'clear' ? 'clear' : m[1] === 'resume' ? 'resume' : 'other', sessionId: m[2].toLowerCase() };
}

/** The session key a left-behind record went on as, if it was replaced. */
export function successorOf(env: EnvId, reason: string | null | undefined): SessionKey | null {
  const r = parseReplacedReason(reason);
  return r ? makeSessionKey(env, r.sessionId) : null;
}

