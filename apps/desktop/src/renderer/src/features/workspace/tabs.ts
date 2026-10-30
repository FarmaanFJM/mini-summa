// Which sessions have a tab in a project's Claude pane. Pure, so the rules are tested without React.
//
// A tab is a VIEW onto a session. Closing it never stops anything; it only stops showing it. Managed sessions that are live
// get a tab on their own; anything else (an observed session, a resumable one) gets a tab when the person opens it.
import type { SessionKey, SessionView } from '@minisumma/shared';

export interface TabModel {
  /** Per project, in the order the tabs were opened. */
  openTabs: Record<string, SessionKey[]>;
  /** Tabs the person closed. A live managed session in this list is not reopened automatically. */
  dismissed: SessionKey[];
}

export const emptyTabs = (): TabModel => ({ openTabs: {}, dismissed: [] });

/**
 * A managed session the person should see without asking: it is running, it just ended badly, or Mini-Summa lost its
 * terminal (after a restart, say) and the person has to decide what to do about it.
 */
const deservesTab = (s: SessionView): boolean =>
  s.origin === 'managed' && (s.availability === 'live' || s.availability === 'disconnected' || s.attention?.kind === 'abnormal_end' || s.attention?.kind === 'error');

/** Open a tab for every managed session worth showing (live, lost, or ended with an error) that has none yet and was not closed on purpose. */
export function withAutoTabs(model: TabModel, sessions: readonly SessionView[]): TabModel {
  let next = model;
  for (const s of sessions) {
    if (!s.projectId || !deservesTab(s)) continue;
    if (model.dismissed.includes(s.key)) continue;
    const list = next.openTabs[s.projectId] ?? [];
    if (list.includes(s.key)) continue;
    next = { ...next, openTabs: { ...next.openTabs, [s.projectId]: [...list, s.key] } };
  }
  return next;
}

export function openTab(model: TabModel, projectId: string, key: SessionKey): TabModel {
  const list = model.openTabs[projectId] ?? [];
  return {
    openTabs: list.includes(key) ? model.openTabs : { ...model.openTabs, [projectId]: [...list, key] },
    dismissed: model.dismissed.filter((k) => k !== key),
  };
}

export function closeTab(model: TabModel, projectId: string, key: SessionKey): TabModel {
  return {
    openTabs: { ...model.openTabs, [projectId]: (model.openTabs[projectId] ?? []).filter((k) => k !== key) },
    dismissed: model.dismissed.includes(key) ? model.dismissed : [...model.dismissed, key],
  };
}

/** A resumed session continues an earlier one: the new tab takes the old one's place. */
export function replaceTab(model: TabModel, projectId: string, oldKey: SessionKey, newKey: SessionKey): TabModel {
  const list = model.openTabs[projectId] ?? [];
  const at = list.indexOf(oldKey);
  const next = at < 0 ? [...list, newKey] : list.map((k) => (k === oldKey ? newKey : k));
  return {
    openTabs: { ...model.openTabs, [projectId]: next.filter((k, i) => next.indexOf(k) === i) },
    dismissed: model.dismissed.filter((k) => k !== newKey),
  };
}

const rank = (s: SessionView): number => (s.origin === 'managed' ? (s.availability === 'live' ? 0 : 1) : 2);

/** The sessions to show as tabs, managed live first. A session attributed to another project is never shown here. */
export function visibleTabs(model: TabModel, projectId: string, sessions: readonly SessionView[]): SessionView[] {
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  const opened = model.openTabs[projectId] ?? [];
  return opened
    .map((key, order) => ({ session: byKey.get(key), order }))
    .filter((e): e is { session: SessionView; order: number } => e.session !== undefined && (e.session.projectId === projectId || e.session.projectId === null))
    .sort((a, b) => rank(a.session) - rank(b.session) || a.order - b.order)
    .map((e) => e.session);
}

/** Which tab to select after the selected one closed: its neighbour, preferring the one on the left. */
export function selectionAfterClose(tabs: readonly SessionView[], closed: SessionKey): SessionKey | null {
  const i = tabs.findIndex((s) => s.key === closed);
  if (i < 0) return tabs[0]?.key ?? null;
  const rest = tabs.filter((s) => s.key !== closed);
  return (rest[i - 1] ?? rest[i] ?? null)?.key ?? null;
}
