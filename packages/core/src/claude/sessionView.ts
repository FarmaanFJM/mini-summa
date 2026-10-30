// Builds one SessionView from what the observer knows about a session: the Reducer's session (hooks and discovery), the
// managed-session record (Mini-Summa's own terminal), the attribution and, for sessions nothing else remembers, the last
// persisted view. A pure function, so the rules in sessions.ts can be tested as a table.
import { LABELS } from '@minisumma/claude-integration';
import type { ReducerSession } from '@minisumma/claude-integration';
import type {
  AttentionKind, EnvId, SessionAvailability, SessionKey, SessionOrigin, SessionState, SessionTermination, SessionView,
} from '@minisumma/shared';
import type { ManagedSessionRecord } from '../contracts.ts';
import type { Attribution, SessionFacts } from './projection.ts';

/** The fields of the Reducer's session this module reads. */
export type ReducerFields = Pick<ReducerSession, 'state' | 'evidence' | 'cwd' | 'hook_seen' | 'observed' | 'gen' | 'unresolved' | 'tasks' | 'current_prompt_id'>;

export interface SessionViewInput {
  key: SessionKey;
  env: EnvId;
  sessionId: string;
  reducer: ReducerFields | null;
  facts: SessionFacts | null;
  managed: ManagedSessionRecord | null;
  attribution: Attribution;
  /** The attributed project's default session, if it has one. */
  projectDefaultKey: SessionKey | null;
  /** The last persisted view: all that is left of a session the Reducer and the managed manager no longer know. */
  history: SessionView | null;
}

export const EXTERNAL_REMOTE_CONTROL_HINT = 'Type /remote-control inside that Claude session to control it from the Claude app';
const NOT_RUNNING_RC_HINT = 'Remote Control is only available while the session is running.';

const SESSION_END_REASONS: Record<string, string> = {
  prompt_input_exit: 'The session was closed from inside Claude Code.',
  clear: 'The conversation was cleared with /clear.',
  logout: 'You logged out of Claude Code.',
  resume: 'Another session was resumed in the same window.',
  bypass_permissions_disabled: 'Bypass permissions mode was turned off.',
  other: 'The session ended.',
};

const endReasonText = (reason: string | null | undefined): string =>
  !reason ? 'The session ended.' : SESSION_END_REASONS[reason] ?? `The session ended (${reason}).`;

export function labelOf(state: SessionState): string {
  return state === 'unknown' ? 'Status unknown' : LABELS[state];
}

const isoOrNull = (ms: number | null | undefined): string | null => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const latest = (...times: (string | null | undefined)[]): string | null =>
  times.reduce<string | null>((best, t) => (t && (!best || t > best) ? t : best), null);

function attentionFor(state: SessionState, availability: SessionAvailability, facts: SessionFacts | null): SessionView['attention'] {
  let kind: AttentionKind | null = null;
  switch (state) {
    case 'needs_permission': kind = 'permission'; break;
    case 'needs_input': kind = 'input'; break;
    case 'error': kind = 'error'; break;
    case 'presence_lost': kind = 'presence_lost'; break;
    case 'report_ready': kind = 'report'; break;
    case 'ended': kind = facts?.abnormalEnd ? 'abnormal_end' : null; break;
    default: break;
  }
  // Nobody can answer a permission or input prompt of a process that is gone.
  if (kind === null || ((kind === 'permission' || kind === 'input') && availability !== 'live')) return null;
  const since = facts?.stateSince && facts.stateSince.state === state ? facts.stateSince.at : (facts?.lastHookAt ?? null);
  return { kind, since };
}

function managedExit(m: ManagedSessionRecord): SessionTermination {
  const reason = m.exitReason
    ?? (m.exitCode !== null ? `The terminal process exited with code ${m.exitCode}.`
      : m.exitSignal !== null ? `The terminal process was stopped by signal ${m.exitSignal}.` : 'The terminal was closed.');
  return { kind: 'observed', reason, at: m.exitedAt };
}

function reducerTermination(r: ReducerFields, facts: SessionFacts | null): SessionTermination | null {
  const at = facts?.endedAt ?? null;
  if (r.gen.phase === 'lost_suspected') {
    return { kind: 'suspected', reason: 'Claude Code no longer lists this session. It may have ended, or the listing may be incomplete.', at };
  }
  if (r.gen.phase === 'ended_observed') {
    return { kind: 'observed', reason: r.gen.term?.kind === 'process_exit' ? 'The Claude process is no longer running.' : endReasonText(facts?.sessionEndReason), at };
  }
  return null;
}

function remoteControlFor(managed: ManagedSessionRecord | null, availability: SessionAvailability): SessionView['remoteControl'] {
  if (availability !== 'live') return { state: 'not_enabled', hint: NOT_RUNNING_RC_HINT };
  if (managed) {
    return managed.remoteControl
      ? { state: 'enabled', hint: 'Remote Control is on for this session. Open it in the Claude app to continue from your phone.' }
      : { state: 'not_enabled', hint: 'Remote Control is off for this session. Type /remote-control inside it to turn it on.' };
  }
  return { state: 'unknown', hint: EXTERNAL_REMOTE_CONTROL_HINT };
}

/** What is left of a session the Reducer and the managed manager no longer know: its last view, never shown as live. */
function fromHistory(i: SessionViewInput, h: SessionView): SessionView {
  const a = i.attribution;
  const bound = a.resolution === 'managed' || a.resolution === 'manual';
  const wasLive = h.availability === 'live';
  const availability: SessionAvailability = wasLive ? 'disconnected' : h.availability;
  return {
    ...h,
    availability,
    termination: h.termination,
    projectId: bound ? a.projectId : h.projectId,
    projectName: bound ? a.projectName : h.projectName,
    projectResolution: bound ? a.resolution : h.projectResolution,
    stateLabel: wasLive && h.state !== 'ended' && h.state !== 'presence_lost' ? `${labelOf(h.state)} (last known)` : h.stateLabel,
    pid: wasLive ? null : h.pid,
    attention: h.attention && (h.attention.kind === 'permission' || h.attention.kind === 'input') && availability !== 'live' ? null : h.attention,
    terminal: h.terminal ? { ...h.terminal, exited: true } : null,
    isProjectDefault: i.projectDefaultKey === i.key,
    remoteControl: remoteControlFor(null, availability),
  };
}

export function buildSessionView(i: SessionViewInput): SessionView | null {
  const { key, env, sessionId, reducer: r, facts: f, managed: m, attribution: a, history: h } = i;
  if (!r && !m) return h ? fromHistory(i, h) : null;

  const phase = r?.gen.phase ?? 'none';
  const prompted = Boolean(m?.prompted) || Boolean(r && (r.tasks.size > 0 || r.current_prompt_id !== null));

  // ---- origin ----
  const origin: SessionOrigin = m ? 'managed' : r?.observed?.kind === 'background' ? 'background' : 'external';

  // ---- availability, resumable, termination ----
  let availability: SessionAvailability;
  let resumable = false;
  let termination: SessionTermination | null = null;
  if (m) {
    if (m.status === 'running') {
      availability = 'live';
    } else if (m.status === 'disconnected') {
      // The terminal link is gone. The process may be gone too, so this is never "ended" and never an observed exit.
      availability = 'disconnected';
      resumable = prompted;
      termination = r ? reducerTermination(r, f) : null;
    } else {
      // Mini-Summa owned the terminal and saw it exit: an observed end.
      availability = prompted ? 'resumable' : 'ended';
      resumable = prompted;
      termination = managedExit(m);
    }
  } else if (phase === 'live') {
    availability = 'live';
  } else if (phase === 'lost_suspected') {
    availability = 'disconnected'; // suspected only: the process may still exist
    resumable = prompted;
    termination = reducerTermination(r!, f);
  } else if (phase === 'ended_observed') {
    availability = 'ended';
    resumable = prompted;
    termination = reducerTermination(r!, f);
  } else {
    // Listed, but its process was already dead on this host when first seen.
    availability = 'ended';
    resumable = prompted;
    termination = { kind: 'observed', reason: 'The Claude process is no longer running.', at: null };
  }

  // ---- state ----
  const reducerState: SessionState = r?.state ?? 'unknown';
  let state: SessionState = reducerState;
  let stateLabel: string;
  let stateEvidence: string = r && r.evidence !== 'none' ? r.evidence : m ? 'managed:pty' : 'none';
  if (m?.status === 'exited' && reducerState !== 'ended') {
    state = 'ended'; // the terminal exit was observed by Mini-Summa itself
    stateLabel = labelOf('ended');
    stateEvidence = 'managed:pty';
  } else if (state === 'unknown' && m?.status === 'running') {
    stateLabel = 'Starting';
    stateEvidence = 'managed:pty';
  } else if (m?.status === 'disconnected' && state !== 'unknown' && state !== 'ended' && state !== 'presence_lost') {
    stateLabel = `${labelOf(state)} (last known)`;
  } else {
    stateLabel = labelOf(state);
  }

  // ---- the rest ----
  const proc = r?.gen.proc ?? null;
  const generation = r ? (m && r.gen.n === 0 ? 1 : r.gen.n) : 1; // a managed terminal is a process incarnation before any hook says so
  const lastActivityAt = latest(f?.lastHookAt, m?.lastOutputAt) ?? (m ? m.startedAt : null) ?? h?.lastActivityAt ?? null;

  return {
    key, env, sessionId, origin, availability, termination, resumable,
    projectId: a.projectId, projectName: a.projectName, projectResolution: a.resolution,
    cwd: r?.cwd ?? m?.cwd ?? h?.cwd ?? null,
    name: m?.name ?? f?.name ?? h?.name ?? null,
    state, stateLabel, stateEvidence, generation,
    pid: availability === 'live' ? (proc?.pid ?? r?.observed?.pid ?? m?.pid ?? null) : null,
    startedAt: m?.startedAt ?? isoOrNull(proc?.startedAt) ?? f?.startedAtHook ?? h?.startedAt ?? null,
    lastActivityAt,
    attention: attentionFor(state, availability, f),
    unresolvedOrdering: r?.unresolved.length ?? h?.unresolvedOrdering ?? 0,
    terminal: m ? { cols: m.cols, rows: m.rows, exited: m.status !== 'running' } : null,
    isProjectDefault: i.projectDefaultKey === key,
    remoteControl: remoteControlFor(m, availability),
  };
}
