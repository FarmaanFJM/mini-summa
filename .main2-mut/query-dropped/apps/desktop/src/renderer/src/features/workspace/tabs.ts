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
 * terminal (after a restart, say) and the person has to decide what to do about it. Not one whose terminal went on as
 * another session (/clear, /resume inside it): that session is history, and the tab belongs to its successor.
 */
const deservesTab = (s: SessionView): boolean =>
  s.origin === 'managed' && !s.replacedBy && (s.availability === 'live' || s.availability === 'disconnected' || s.attention?.kind === 'abnormal_end' || s.attention?.kind === 'error');

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

/**
 * The tab to show. The one the person chose, if it is there. A choice whose session no longer exists anywhere (it was remembered
 * from an earlier run, and the session was removed since) falls back to the newest session, because that is the one the person is
 * most likely to want; with no choice at all the first tab is shown, as it always was. A session that exists but has no tab yet
 * is about to get one (see ClaudePane), so the first tab is shown for that moment.
 */
export function pickSelectedTab(tabs: readonly SessionView[], chosen: SessionKey | undefined, sessions: readonly SessionView[]): SessionView | null {
  const hit = tabs.find((t) => t.key === chosen);
  if (hit) return hit;
  if (chosen !== undefined && !sessions.some((s) => s.key === chosen)) return newestSession(tabs) ?? null;
  return tabs[0] ?? null;
}

/** The session that started last (ties: the later tab). */
export function newestSession(tabs: readonly SessionView[]): SessionView | undefined {
  let best: SessionView | undefined;
  for (const tab of tabs) if (best === undefined || (tab.startedAt ?? '') >= (best.startedAt ?? '')) best = tab;
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// A terminal that went on as another session

/**
 * The live managed session that owns the terminal of `key` now, following `replacedBy` through any number of /clear and
 * /resume. Null when `key` was not replaced, when the next session is not (yet) known to this window, when it is not managed, or
 * when the one at the end of the chain is not running: there is nothing to move to, and nothing is guessed.
 */
export function successorOf(key: SessionKey, sessions: readonly SessionView[]): SessionView | null {
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  const seen = new Set<SessionKey>([key]);
  let current = byKey.get(key);
  while (current && current.origin === 'managed' && current.replacedBy) {
    const next = byKey.get(current.replacedBy);
    if (!next || next.origin !== 'managed' || seen.has(next.key)) return null;
    seen.add(next.key);
    if (!next.replacedBy) return next.availability === 'live' ? next : null;
    current = next;
  }
  return null;
}

export interface TabMove { projectId: string; from: SessionKey; to: SessionKey }

/**
 * The tabs and remembered choices that must move on: every tab, and every remembered selection, of a managed session whose terminal
 * went on as another live managed session of the same project. `kept` are sessions the person opened on purpose as history (from the
 * Sessions menu): they stay where they are. A move is listed once per project and session.
 */
export function replacementMoves(
  model: TabModel, chosen: Readonly<Record<string, SessionKey>>, sessions: readonly SessionView[], kept: readonly SessionKey[] = [],
): TabMove[] {
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  const moves: TabMove[] = [];
  const seen = new Set<string>();
  const consider = (projectId: string, key: SessionKey): void => {
    if (kept.includes(key)) return;
    const from = byKey.get(key);
    if (!from || from.origin !== 'managed' || !from.replacedBy) return;
    const to = successorOf(key, sessions);
    if (!to) return;
    // A session the person assigned to another project in the meantime is not this project's to move to.
    if (from.projectId !== null && to.projectId !== null && from.projectId !== to.projectId) return;
    const id = `${projectId}\u0000${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    moves.push({ projectId, from: key, to: to.key });
  };
  for (const [projectId, keys] of Object.entries(model.openTabs)) for (const key of keys) consider(projectId, key);
  for (const [projectId, key] of Object.entries(chosen)) consider(projectId, key);
  return moves;
}
