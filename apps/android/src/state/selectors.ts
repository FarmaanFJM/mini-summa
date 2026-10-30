// Pure views over ClientState. The reducer in @minisumma/shared keeps the data current; these decide what the phone
// shows from it. Nothing here touches the network or the disk.
import { parseChatGptUrl, sessionsNeedingAttention, shortSessionId } from '@minisumma/shared';
import type {
  ActivityEvent, ClientState, Conversation, Delivery, PendingAction, Project, ReportSummary, SessionKey, SessionView,
} from '@minisumma/shared';
import { actionKindLabel, attentionText, declaredStatusText, sessionTarget } from '../lib/format.ts';
import { go } from '../routes.ts';
import type { AppHref } from '../routes.ts';

export interface ProjectCard {
  project: Project;
  liveSessions: number;
  needsYou: boolean;
  unreadReports: number;
}

export function projectCards(state: ClientState): ProjectCard[] {
  const needing = new Set<string>();
  for (const s of sessionsNeedingAttention(state)) if (s.projectId) needing.add(s.projectId);
  for (const a of state.actions) if (a.status === 'pending' && a.projectId) needing.add(a.projectId);
  return state.projects
    .filter((p) => p.archivedAt === null)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((project) => ({
      project,
      liveSessions: state.sessions.filter((s) => s.projectId === project.id && s.availability === 'live').length,
      needsYou: needing.has(project.id),
      unreadReports: state.reports.filter((r) => r.projectId === project.id && !r.read).length,
    }));
}

/** Live sessions that no project claims. They would otherwise be invisible on the phone. */
export const unassignedLiveSessions = (state: ClientState): SessionView[] =>
  state.sessions.filter((s) => s.projectId === null && s.availability === 'live');

export interface NeedsYouItem {
  id: string;
  kind: 'action' | 'session' | 'report';
  title: string;
  subtitle: string;
  target: AppHref;
}

/** Pending actions first (they lapse), then sessions that are waiting, then reports nobody has opened. */
export function needsYouItems(state: ClientState): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const pending = state.actions.filter((a) => a.status === 'pending');
  const withPermissionAction = new Set(pending.filter((a) => a.kind === 'permission').map((a) => a.sessionKey));
  for (const a of pending) {
    items.push({ id: `action:${a.id}`, kind: 'action', title: `${actionKindLabel(a)}: ${a.projectName ?? 'No project'}, session ${shortSessionId(a.sessionKey)}`, subtitle: a.summary, target: go.inbox });
  }
  for (const s of sessionsNeedingAttention(state)) {
    // The permission request is already listed as an action that can be answered; do not list the same thing twice.
    if (s.attention?.kind === 'permission' && withPermissionAction.has(s.key)) continue;
    items.push({ id: `session:${s.key}`, kind: 'session', title: sessionTarget(s), subtitle: s.attention ? attentionText[s.attention.kind] : s.stateLabel, target: go.session(s.key) });
  }
  for (const r of state.reports) {
    if (r.read) continue;
    items.push({ id: `report:${r.id}`, kind: 'report', title: r.taskTitle, subtitle: `${r.projectName ?? 'No project'}. ${declaredStatusText[r.declaredStatus]}`, target: go.report(r.id) });
  }
  return items;
}

export const findSession = (state: ClientState, key: SessionKey | string | undefined): SessionView | undefined =>
  key ? state.sessions.find((s) => s.key === key) : undefined;

export const findProject = (state: ClientState, id: string | undefined): Project | undefined =>
  id ? state.projects.find((p) => p.id === id) : undefined;

/** Live first, then the most recently active. */
export function sortSessions(list: SessionView[]): SessionView[] {
  const rank = (s: SessionView) => (s.availability === 'live' ? 0 : s.availability === 'resumable' || s.availability === 'disconnected' ? 1 : 2);
  return list.slice().sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
}

export const reportsOfProject = (state: ClientState, projectId: string): ReportSummary[] =>
  state.reports.filter((r) => r.projectId === projectId).slice().sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

export const sortedReports = (state: ClientState): ReportSummary[] =>
  state.reports.slice().sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

export interface ReportConversation {
  url: string;
  title: string;
  /** delivery: the destination frozen when the report was captured. project: the project's preferred conversation. */
  source: 'delivery' | 'project';
}

const latestFirst = (a: Delivery, b: Delivery) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Which ChatGPT conversation belongs to a report. The delivery's frozen destination wins (it is what Mini-Summa
 * decided when the report arrived); otherwise the project's preferred conversation. Never inferred from anything else.
 */
export function conversationForReport(state: ClientState, report: Pick<ReportSummary, 'id' | 'projectId'>): ReportConversation | null {
  const frozen = state.deliveries.filter((d) => d.reportId === report.id && d.destination).sort(latestFirst)[0]?.destination;
  if (frozen) {
    const parsed = parseChatGptUrl(frozen.url);
    if (parsed.ok) return { url: parsed.info.url, title: frozen.title, source: 'delivery' };
  }
  const project = findProject(state, report.projectId ?? undefined);
  const conv = project?.preferredConversationId ? state.conversations.find((c) => c.id === project.preferredConversationId) : undefined;
  if (conv) {
    const parsed = parseChatGptUrl(conv.url);
    if (parsed.ok) return { url: parsed.info.url, title: conv.title, source: 'project' };
  }
  return null;
}

export const conversationsOf = (state: ClientState, projectId: string): Conversation[] =>
  state.conversations.filter((c) => c.projectId === projectId).slice().sort((a, b) => a.position - b.position);

export interface ActivityFilter {
  needsAction: boolean;
  unread: boolean;
  projectId: string | null;
}

export const NO_ACTIVITY_FILTER: ActivityFilter = { needsAction: false, unread: false, projectId: null };

export function filterActivity(list: ActivityEvent[], f: ActivityFilter): ActivityEvent[] {
  return list.filter((a) => (!f.needsAction || (a.requiresAction && a.resolvedAt === null)) && (!f.unread || !a.read) && (!f.projectId || a.projectId === f.projectId));
}

/** Where tapping an activity entry goes: the most specific thing it links to that the phone can show. */
export function activityTarget(a: ActivityEvent, state: ClientState): AppHref | null {
  for (const l of a.links) {
    if (l.kind === 'report') return go.report(l.id);
  }
  for (const l of a.links) {
    if (l.kind === 'delivery') {
      const d = state.deliveries.find((x) => x.id === l.id);
      if (d) return go.report(d.reportId);
    }
  }
  for (const l of a.links) {
    if (l.kind === 'action') return go.inbox;
  }
  for (const l of a.links) {
    if (l.kind === 'session') return go.session(l.key);
  }
  for (const l of a.links) {
    if (l.kind === 'project') return go.project(l.id);
  }
  return null;
}

export const pendingActions = (state: ClientState): PendingAction[] =>
  state.actions.filter((a) => a.status === 'pending').slice().sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

export const recentActions = (state: ClientState, limit = 20): PendingAction[] =>
  state.actions.filter((a) => a.status !== 'pending').slice().sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)).slice(0, limit);
