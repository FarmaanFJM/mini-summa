// Wording and time formatting. Everything here is a pure function so it can be tested without a renderer.
// UI text avoids em dashes (Summa-UI principle 13) and says what is known and what is only suspected.
import { shortSessionId } from '@minisumma/shared';
import type {
  ActivityEvent, AttentionKind, DeclaredStatus, Delivery, DeliveryState, EnvId, PendingAction, ReportSummary, Scope,
  SessionAvailability, SessionOrigin, SessionState, SessionView,
} from '@minisumma/shared';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:32" today, "Yesterday 21:05", "3 Oct 09:10" this year, "3 Oct 2025" before. Local time. */
export function formatWhen(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff === 0) return clock;
  if (dayDiff === 1) return `Yesterday ${clock}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "in 12 min", "in 2 h", "expired". Used for pending actions that lapse. */
export function formatExpiry(expiresAt: string, now: Date = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'Expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `Expires in ${min} min`;
  const h = Math.round(min / 60);
  return `Expires in ${h} h`;
}

export const originLabel: Record<SessionOrigin, string> = {
  managed: 'Managed by Mini-Summa',
  external: 'External, observed only',
  background: 'Background, observed only',
};

export const availabilityLabel: Record<SessionAvailability, string> = {
  live: 'Live',
  resumable: 'Not running, can be resumed',
  disconnected: 'Disconnected',
  ended: 'Ended',
};

const STATE_FALLBACK: Record<SessionState, string> = {
  unknown: 'State unknown', idle: 'Idle', working: 'Working', needs_permission: 'Waiting for your permission',
  needs_input: 'Waiting for your input', waiting_for_you: 'Waiting for you', turn_ended: 'Turn ended',
  background_wait: 'Waiting on background work', report_ready: 'Report ready', error: 'Error', ended: 'Ended',
  presence_lost: 'No longer visible',
};

export const stateLabel = (s: Pick<SessionView, 'state' | 'stateLabel'>): string => s.stateLabel || STATE_FALLBACK[s.state];

/**
 * Suspected termination is worded as "may have ended" and observed termination as "ended". The reducer keeps the two
 * apart and the phone must not blur them.
 */
export function terminationLine(s: Pick<SessionView, 'termination' | 'availability'>): string | null {
  if (s.termination) {
    const why = s.termination.reason ? `: ${s.termination.reason}` : '';
    return s.termination.kind === 'suspected'
      ? `May have ended. Claude Code stopped listing it, which is not confirmation${why}`
      : `Ended${why}`;
  }
  if (s.availability === 'ended') return 'Ended';
  if (s.availability === 'disconnected') return 'Mini-Summa lost the terminal connection. The process may or may not still be running.';
  return null;
}

export function sessionTitle(s: Pick<SessionView, 'name' | 'key'>): string {
  return s.name?.trim() ? s.name.trim() : `Session ${shortSessionId(s.key)}`;
}

/** "GitManager, session a1b2c3d4": what is shown when the user must be sure which session an action targets. */
export function sessionTarget(s: Pick<SessionView, 'projectName' | 'key'>): string {
  return `${s.projectName ?? 'No project'}, session ${shortSessionId(s.key)}`;
}

export function envName(env: EnvId): string {
  if (env === 'win') return 'Windows';
  if (env === 'posix') return 'Linux';
  return `WSL (${env.slice(4)})`;
}

/** One plain line of metadata for a session row. No decorative tags. */
export function sessionMeta(s: SessionView): string {
  const origin = s.origin === 'managed' ? 'Managed' : s.origin === 'external' ? 'External' : 'Background';
  const avail = s.availability === 'live' ? 'Live' : s.availability === 'resumable' ? 'Resumable' : s.availability === 'disconnected' ? 'Disconnected' : 'Ended';
  return `${origin} · ${avail} · ${stateLabel(s)}`;
}

export const declaredStatusText: Record<DeclaredStatus, string> = {
  complete: 'Declared complete by Claude, not verified',
  partial: 'Declared partial by Claude, not verified',
  blocked: 'Declared blocked by Claude, not verified',
};

export const attentionText: Record<AttentionKind, string> = {
  permission: 'Waiting for your permission',
  input: 'Waiting for your input',
  error: 'Reported an error',
  report: 'Report ready',
  presence_lost: 'No longer visible, may have ended',
  abnormal_end: 'Ended unexpectedly',
};

const DELIVERY_TEXT: Record<DeliveryState, string> = {
  report_captured: 'Captured, no ChatGPT handoff yet',
  destination_missing: 'No ChatGPT conversation is set for this project',
  destination_unverified: 'ChatGPT conversation not verified',
  ready_for_handoff: 'Ready to hand off on your PC',
  copied: 'Copied on your PC',
  awaiting_user_send: 'Waiting for you to send it in ChatGPT',
  user_confirmed_sent: 'You confirmed it was sent to ChatGPT',
  delivery_uncertain: 'Not sure it reached ChatGPT',
  user_discarded: 'Handoff discarded',
};

export const deliveryText = (d: Pick<Delivery, 'state'> | { state: DeliveryState } | null | undefined): string =>
  d ? DELIVERY_TEXT[d.state] : 'No ChatGPT handoff yet';

export function reportMeta(r: ReportSummary, now: Date = new Date()): string {
  return `${formatWhen(r.capturedAt, now)} · ${deliveryText(r.delivery)}`;
}

export function actionKindLabel(a: Pick<PendingAction, 'kind'>): string {
  return a.kind === 'permission' ? 'Permission request' : 'Prompt for Claude';
}

export const scopeText: Record<Scope, string> = {
  desktop: 'Full control (owner)',
  read: 'View status, reports and activity',
  notify: 'Receive notifications',
  prompt: 'Send prompts to Claude (needs approval on your PC)',
  approve: 'Approve or reject requests',
  extension: 'Browser extension bridge',
};

export const activityTitle = (a: Pick<ActivityEvent, 'title'>): string => a.title;

export const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
