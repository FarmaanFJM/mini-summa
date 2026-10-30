// Derived facts about projects, sessions and reports. Pure functions over store data, so components can memoise them.
import { sessionsNeedingAttention } from '@minisumma/shared';
import type { ClientState, Conversation, DeliveryState, Project, ReportSummary, SessionView } from '@minisumma/shared';

/** Delivery states in which the person still has to do something to get the report into ChatGPT. */
export const HANDOFF_PENDING: ReadonlySet<DeliveryState> = new Set<DeliveryState>([
  'report_captured', 'destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send',
]);

export function isAwaitingHandoff(report: ReportSummary): boolean {
  return report.delivery === null ? true : HANDOFF_PENDING.has(report.delivery.state);
}

/** A session that needs the person: permission, input, an error, a lost presence or an abnormal end (not a plain report). */
export const needsAttention = (session: SessionView): boolean => session.attention !== null && session.attention.kind !== 'report';

export const isLiveSession = (session: SessionView): boolean => session.availability === 'live';

export interface ProjectStats {
  liveSessions: number;
  needsAttention: boolean;
  waitingReports: number;
}

const EMPTY_STATS: ProjectStats = { liveSessions: 0, needsAttention: false, waitingReports: 0 };

export function statsByProject(projects: readonly Project[], sessions: readonly SessionView[], reports: readonly ReportSummary[]): Map<string, ProjectStats> {
  const stats = new Map<string, ProjectStats>(projects.map((p) => [p.id, { ...EMPTY_STATS }]));
  for (const s of sessions) {
    const entry = s.projectId ? stats.get(s.projectId) : undefined;
    if (!entry) continue;
    if (isLiveSession(s)) entry.liveSessions += 1;
    if (needsAttention(s)) entry.needsAttention = true;
  }
  for (const r of reports) {
    const entry = r.projectId ? stats.get(r.projectId) : undefined;
    if (entry && isAwaitingHandoff(r)) entry.waitingReports += 1;
  }
  return stats;
}

/** Projects the person works with: not archived, in the order they chose. */
export function activeProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => p.archivedAt === null).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function archivedProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => p.archivedAt !== null).sort((a, b) => a.name.localeCompare(b.name));
}

export function conversationsOf(conversations: readonly Conversation[], projectId: string): Conversation[] {
  return conversations.filter((c) => c.projectId === projectId).sort((a, b) => a.position - b.position);
}

/** The project to show: the chosen one if it still exists and is active, else the first active project. */
export function resolveProject(projects: readonly Project[], projectId: string | null): Project | null {
  const active = activeProjects(projects);
  return active.find((p) => p.id === projectId) ?? active[0] ?? null;
}

/** Counts shown in the sidebar footer. The core's own numbers are authoritative; these only fill in until they arrive. */
export function footerCounts(state: Pick<ClientState, 'counts' | 'sessions'>): { unreadActivity: number; reportsAwaitingHandoff: number; attention: number } {
  return {
    unreadActivity: state.counts.unreadActivity,
    reportsAwaitingHandoff: state.counts.reportsAwaitingHandoff,
    attention: sessionsNeedingAttention(state as ClientState).length,
  };
}
