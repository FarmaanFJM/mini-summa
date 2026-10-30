// Plain-language facts about a session, in one place so the banner, the tabs and the panels always agree.
import { envLabel, shortSessionId } from '@minisumma/shared';
import type { PendingAction, ProjectResolution, SessionOrigin, SessionState, SessionView } from '@minisumma/shared';

export const ORIGIN_LABEL: Record<SessionOrigin, string> = { managed: 'managed', external: 'external', background: 'background' };

export type DotTone = 'busy' | 'idle' | 'attention' | 'error' | 'off';

/** The colour family of a session's state dot. Colour never carries the meaning alone: the state label always sits beside it. */
export function dotTone(session: Pick<SessionView, 'state' | 'availability'>): DotTone {
  // Anything without a live process is not doing anything now, whatever state it was last in.
  if (session.availability !== 'live') return session.state === 'error' ? 'error' : 'off';
  switch (session.state) {
    case 'working': return 'busy';
    case 'needs_permission': case 'needs_input': return 'attention';
    case 'error': return 'error';
    case 'ended': case 'presence_lost': case 'unknown': return 'off';
    default: return 'idle';
  }
}

/** "a1b2c3d4": what people see and say aloud. The full key stays the identity. */
export const shortId = (session: Pick<SessionView, 'key'>): string => shortSessionId(session.key);

/** "managed, Windows" / "external, WSL (Ubuntu)". */
export const originAndEnv = (session: Pick<SessionView, 'origin' | 'env'>): string => `${ORIGIN_LABEL[session.origin]}, ${envLabel(session.env)}`;

/** Accessible name and tooltip of a session tab. */
export const tabTitle = (session: SessionView): string =>
  `Session ${shortId(session)}, ${originAndEnv(session)}. ${session.stateLabel}.`;

/** Why the session belongs (or does not belong) to its project, as a phrase that follows the project name. */
export const RESOLUTION_TEXT: Record<ProjectResolution, string> = {
  managed: 'started by Mini-Summa',
  manual: 'assigned by you',
  matched: 'matched by its folder',
  unregistered_directory: 'its folder is not in any project',
  ambiguous: 'its folder matches more than one project',
  no_cwd: 'its folder is unknown',
};

// ---------------------------------------------------------------------------------------------------------------
// Where typing goes

export type InputTarget =
  /** Keystrokes in the terminal reach this managed, live session. */
  | { kind: 'managed'; text: string }
  /** Managed and live, but the link to the core is down. */
  | { kind: 'paused'; text: string }
  /** The terminal runs, but its conversation was replaced (/clear, /resume) and the new session is not known: it is the terminal that gets the keystrokes. */
  | { kind: 'replaced'; text: string }
  /** A managed session that is not running. */
  | { kind: 'not_running'; text: string }
  /** Observed only. Mini-Summa cannot type into it, whatever the person does. */
  | { kind: 'observed'; text: string };

/**
 * The exact statement shown above the terminal. It names the project, the session and how it was started, because a
 * keystroke in the wrong session is the one mistake this app must make impossible to overlook.
 */
export function describeInputTarget(session: SessionView, projectName: string | null, live: boolean): InputTarget {
  const where = `${projectName ?? 'No project'} / Session ${shortId(session)}`;
  const how = originAndEnv(session);
  if (session.origin !== 'managed') {
    return { kind: 'observed', text: `No input: ${where} (${how}) is observed. Mini-Summa cannot type into it.` };
  }
  if (session.availability !== 'live') {
    // A lost terminal is not the same as an ended one: its process may still be running, just out of reach.
    const why = session.availability === 'disconnected' ? 'is not connected to Mini-Summa' : 'is not running';
    return { kind: 'not_running', text: `No input: ${where} (${how}) ${why}.` };
  }
  if (!live) {
    return { kind: 'paused', text: `Input is paused while reconnecting. It would go to ${where} (${how}).` };
  }
  if (isReplacedUnidentified(session)) {
    // What the person types reaches the terminal, but that terminal is no longer the session this banner would name.
    return { kind: 'replaced', text: `Input goes to: the terminal of ${projectName ?? 'No project'}. Its conversation was replaced and the new session is not identified, so Mini-Summa will not type into it for you.` };
  }
  return { kind: 'managed', text: `Input goes to: ${where} (${how})` };
}

/** What Claude is waiting for, in words, from the open permission request when there is one. */
export function waitingFor(session: SessionView, actions: readonly PendingAction[]): string | null {
  if (session.state === 'needs_permission') {
    const open = actions.find((a) => a.kind === 'permission' && a.status === 'pending' && a.sessionKey === session.key);
    return open ? `Claude is asking for permission: ${open.summary}. Answer it in the terminal.` : 'Claude is asking for permission. Answer it in the terminal.';
  }
  if (session.state === 'needs_input') return 'Claude is waiting for your answer. Reply in the terminal.';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Time, in the units people use

export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export type SessionStateName = SessionState;

// ---------------------------------------------------------------------------------------------------------------
// The calm notice above a managed session's terminal

export interface Notice { tone: 'info' | 'attention' | 'error'; text: string; canResume: boolean }

/**
 * A running terminal whose conversation was replaced (/clear, /resume inside it) while Mini-Summa has not learned which session the
 * terminal runs now. The core says why in `termination.reason`, and nothing may type into it from here. (The terminal itself works.)
 */
export const isReplacedUnidentified = (session: Pick<SessionView, 'origin' | 'availability' | 'termination'>): boolean =>
  session.origin === 'managed' && session.availability === 'live' && session.termination !== null;

/** What happened to (or is being asked by) a managed session, in words. Observed sessions have their own panel. */
export function noticeFor(session: SessionView, actions: readonly PendingAction[]): Notice | null {
  if (session.origin !== 'managed') return null;
  if (session.availability === 'disconnected') {
    return {
      tone: 'info', canResume: session.resumable,
      text: 'Mini-Summa lost its connection to this terminal, for example after a restart. The Claude process may or may not still be running.',
    };
  }
  if (session.availability === 'ended' || session.availability === 'resumable') {
    const t = session.termination;
    const reason = t ? t.reason.replace(/\.$/, '') : 'the session is no longer running';
    const guess = t?.kind === 'suspected' ? ' This is a guess: the session disappeared from Claude\'s list and nothing confirmed that it ended.' : '';
    return { tone: session.state === 'error' ? 'error' : 'info', canResume: session.resumable, text: `This session ended: ${reason}.${guess}` };
  }
  // Running, but its conversation was replaced and the new session is not identified: the core's own words say what is paused.
  if (isReplacedUnidentified(session)) return { tone: 'attention', text: session.termination!.reason, canResume: false };
  const waiting = waitingFor(session, actions);
  if (waiting) return { tone: 'attention', text: waiting, canResume: false };
  if (session.state === 'error') return { tone: 'error', text: 'Claude reported an error. Check the terminal.', canResume: false };
  if (session.state === 'presence_lost') return { tone: 'attention', text: 'Mini-Summa can no longer see this session. It may have ended.', canResume: false };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// A terminal that has not finished starting

/**
 * A freshly started or resumed Claude Code shows its theme and security screens, and "Do you trust the files in this
 * folder?" with "No, exit" selected, before any hook runs. Until the first hook arrives the core reports the session as
 * state "unknown" labelled "Starting". The terminal is the only place to answer, so the person is pointed to it.
 */
export const STARTING_HINT = 'Claude may be waiting for you to answer a question in the terminal, such as whether you trust this folder.';

/** How long a session stays in "Starting" before the hint appears. Most starts finish well inside it. */
export const STARTING_HINT_AFTER_MS = 6000;

/** A managed, running terminal that has not shown a state yet. */
export function isStartingUp(session: Pick<SessionView, 'origin' | 'availability' | 'state'>): boolean {
  return session.origin === 'managed' && session.availability === 'live' && session.state === 'unknown';
}

/**
 * May Mini-Summa offer to type for the person into this session (send a prompt, answer a permission request)? Only into a
 * managed, running terminal that has shown a state. While it is still starting, a blind Enter can land on the trust
 * dialog, whose default is "No, exit", and end the session, so no automated typing is offered at all. This does not
 * restrict the person: what they type themselves in the terminal always reaches it.
 */
export function canOfferTyping(session: Pick<SessionView, 'origin' | 'availability' | 'state'> & Partial<Pick<SessionView, 'termination'>>): boolean {
  return session.origin === 'managed' && session.availability === 'live' && session.state !== 'unknown'
    && session.state !== 'ended' && session.state !== 'presence_lost'
    // a terminal whose conversation was replaced and not identified: typing for the person could land in the wrong session
    && !(session.termination ?? null);
}

export const OBSERVED_WHY: Record<'external' | 'background', string> = {
  external: 'This session was started outside Mini-Summa, in another terminal. Mini-Summa sees it through Claude Code hooks, so it can show its state but cannot type into it.',
  background: 'This is a background session. It has no terminal that Mini-Summa could type into; it is observed through Claude Code hooks.',
};
