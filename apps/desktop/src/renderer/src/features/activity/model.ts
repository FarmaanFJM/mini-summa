// The words and the grouping of the activity feed. Pure functions, tested without React.
import type { ActivityEvent, ActivitySeverity, LinkTarget, NotificationChannelResult, NotificationRecord } from '@minisumma/shared';

/** What a severity is called. Information is the ordinary case and carries no word; the others never rely on colour alone. */
export const SEVERITY_WORDS: Record<ActivitySeverity, string | null> = { info: null, attention: 'Needs attention', error: 'Error' };

export interface DayGroup<T> { key: string; label: string; items: T[] }

const WEEKDAY = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' });
const WITH_YEAR = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** "Today", "Yesterday", then the weekday and date, in the person's local time. */
export function dayLabel(iso: string, now: number = Date.now()): { key: string; label: string } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { key: 'unknown', label: 'Earlier' };
  const key = localDay(t);
  if (key === localDay(now)) return { key, label: 'Today' };
  if (key === localDay(now - 86_400_000)) return { key, label: 'Yesterday' };
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return { key, label: (sameYear ? WEEKDAY : WITH_YEAR).format(new Date(t)) };
}

/** Consecutive items of the same day share a heading; the order the list came in is kept. */
export function groupByDay<T extends { at: string }>(items: readonly T[], now: number = Date.now()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const { key, label } = dayLabel(item.at, now);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item); else groups.push({ key, label, items: [item] });
  }
  return groups;
}

export const isOpen = (a: Pick<ActivityEvent, 'requiresAction' | 'resolvedAt'>): boolean => a.requiresAction && a.resolvedAt === null;

/** The phrase that says what the entry asks of the person, or null when it asks nothing. */
export function demandWords(a: Pick<ActivityEvent, 'requiresAction' | 'resolvedAt'>): string | null {
  if (!a.requiresAction) return null;
  return a.resolvedAt === null ? 'Needs you' : 'Handled';
}

const LINK_ORDER: LinkTarget['kind'][] = ['report', 'delivery', 'action', 'session', 'conversation', 'settings', 'project'];

/** Where a click on the entry goes: the most specific thing it is about. */
export function primaryLink(links: readonly LinkTarget[]): LinkTarget | null {
  for (const kind of LINK_ORDER) {
    const hit = links.find((l) => l.kind === kind);
    if (hit) return hit;
  }
  return null;
}

export const linkKey = (l: LinkTarget): string => `${l.kind}:${l.kind === 'session' ? l.key : l.kind === 'settings' ? l.section : l.id}`;

export function linkWords(l: LinkTarget): string {
  switch (l.kind) {
    case 'project': return 'Open the project';
    case 'session': return 'Open the session';
    case 'report': return 'Open the report';
    case 'delivery': return 'Open the handoff';
    case 'conversation': return 'Open the conversation';
    case 'action': return 'Open the request';
    case 'settings': return 'Open the settings';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Notifications: what happened to each one

const NATIVE: Record<NotificationChannelResult, string | null> = {
  sent: 'Shown on this PC',
  suppressed_quiet: 'Not shown: quiet mode was on',
  suppressed_project: 'Not shown: notifications are off for this project',
  suppressed_duplicate: 'Not shown: it was a duplicate',
  suppressed_disabled: 'Not shown: desktop notifications are turned off',
  unavailable: 'Could not be shown: this PC cannot show notifications',
  failed: 'Could not be shown: the system refused it',
  not_applicable: null,
};

const PUSH: Record<NotificationChannelResult, string | null> = {
  sent: 'Sent to your phone',
  suppressed_quiet: 'Not sent to your phone: quiet mode was on',
  suppressed_project: 'Not sent to your phone: turned off for this project',
  suppressed_duplicate: 'Not sent to your phone: it was a duplicate',
  suppressed_disabled: 'Not sent to your phone: turned off',
  unavailable: 'Not sent to your phone: push is not available',
  failed: 'Could not be sent to your phone',
  not_applicable: null,
};

export function notificationOutcome(n: Pick<NotificationRecord, 'native' | 'push'>): string[] {
  return [NATIVE[n.native], PUSH[n.push]].filter((s): s is string => s !== null);
}

/** What a screen reader says for an entry: the parts as sentences, without doubled full stops. */
export function spoken(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim().replace(/\.+$/, '')).join('. ');
}
