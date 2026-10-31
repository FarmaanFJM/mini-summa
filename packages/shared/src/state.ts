// Client-side state and the pure function that keeps it current from server events.
// The desktop renderer (zustand) and the Android app both use this, so they agree on what an event means.
import type {
  ActivityEvent, Conversation, Counts, Delivery, Device, HookStatus, NotificationRecord, PendingAction, Project,
  ReportSummary, SessionView, Settings, StateSnapshot, SystemInfo, TailscaleStatus,
} from './entities.ts';
import type { ServerEvent } from './events.ts';

export interface ClientState {
  loaded: boolean;
  /** Highest event seq applied. Events at or below it are ignored. */
  seq: number;
  system: SystemInfo | null;
  projects: Project[];
  conversations: Conversation[];
  sessions: SessionView[];
  reports: ReportSummary[];
  deliveries: Delivery[];
  actions: PendingAction[];
  activity: ActivityEvent[];
  notifications: NotificationRecord[];
  devices: Device[];
  hooks: HookStatus[];
  tailscale: TailscaleStatus | null;
  settings: Settings | null;
  counts: Counts;
  notices: { id: number; level: 'info' | 'warning' | 'error'; message: string }[];
}

export const EMPTY_COUNTS: Counts = { unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 0 };

export function createInitialState(): ClientState {
  return {
    loaded: false, seq: 0, system: null, projects: [], conversations: [], sessions: [], reports: [], deliveries: [],
    actions: [], activity: [], notifications: [], devices: [], hooks: [], tailscale: null, settings: null,
    counts: EMPTY_COUNTS, notices: [],
  };
}

const ACTIVITY_WINDOW = 500;

function upsert<T>(list: T[], item: T, same: (a: T) => boolean, prepend = false): T[] {
  const i = list.findIndex(same);
  if (i >= 0) { const next = list.slice(); next[i] = item; return next; }
  return prepend ? [item, ...list] : [...list, item];
}

export function applySnapshot(state: ClientState, snap: StateSnapshot): ClientState {
  return { ...state, loaded: true, seq: snap.seq, system: snap.system, projects: snap.projects, conversations: snap.conversations,
    sessions: snap.sessions, counts: snap.counts, settings: snap.settings };
}

let noticeCounter = 0;

export function applyEvent(state: ClientState, seq: number, event: ServerEvent): ClientState {
  if (seq <= state.seq) return state;
  const s: ClientState = { ...state, seq };
  switch (event.type) {
    case 'project.upserted': return { ...s, projects: upsert(s.projects, event.project, (p) => p.id === event.project.id) };
    case 'project.removed': return { ...s, projects: s.projects.filter((p) => p.id !== event.id), conversations: s.conversations.filter((c) => c.projectId !== event.id) };
    case 'conversation.upserted': return { ...s, conversations: upsert(s.conversations, event.conversation, (c) => c.id === event.conversation.id) };
    case 'conversation.removed': return { ...s, conversations: s.conversations.filter((c) => c.id !== event.id) };
    case 'session.upserted': return { ...s, sessions: upsert(s.sessions, event.session, (x) => x.key === event.session.key) };
    case 'session.removed': return { ...s, sessions: s.sessions.filter((x) => x.key !== event.key) };
    case 'activity.added': return { ...s, activity: [event.activity, ...s.activity.filter((a) => a.id !== event.activity.id)].slice(0, ACTIVITY_WINDOW) };
    case 'activity.updated': return { ...s, activity: upsert(s.activity, event.activity, (a) => a.id === event.activity.id, true) };
    case 'activity.read': {
      const ids = new Set(event.ids);
      return { ...s, activity: s.activity.map((a) => (ids.has(a.id) ? { ...a, read: true } : a)), counts: event.counts };
    }
    case 'report.upserted': return { ...s, reports: upsert(s.reports, event.report, (r) => r.id === event.report.id, true) };
    case 'delivery.upserted': return { ...s, deliveries: upsert(s.deliveries, event.delivery, (d) => d.id === event.delivery.id, true) };
    case 'action.upserted': return { ...s, actions: upsert(s.actions, event.action, (a) => a.id === event.action.id, true) };
    case 'notification.added': return { ...s, notifications: [event.notification, ...s.notifications.filter((n) => n.id !== event.notification.id)].slice(0, 200) };
    case 'device.upserted': return { ...s, devices: upsert(s.devices, event.device, (d) => d.id === event.device.id) };
    case 'device.removed': return { ...s, devices: s.devices.filter((d) => d.id !== event.id) };
    case 'settings.changed': return { ...s, settings: event.settings };
    case 'tailscale.changed': return { ...s, tailscale: event.status };
    case 'hooks.changed': return { ...s, hooks: upsert(s.hooks, event.status, (h) => h.env === event.env) };
    case 'counts': return { ...s, counts: event.counts };
    case 'system.notice': return { ...s, notices: [...s.notices.slice(-4), { id: ++noticeCounter, level: event.level, message: event.message }] };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small selectors used by more than one client

export const sessionsOfProject = (state: ClientState, projectId: string): SessionView[] =>
  state.sessions.filter((s) => s.projectId === projectId);

export function conversationsOfProject(state: ClientState, projectId: string): Conversation[] {
  return state.conversations.filter((c) => c.projectId === projectId).sort((a, b) => a.position - b.position);
}

/** Sessions that need the user: permission or input requested, errors, abnormal ends. */
export const sessionsNeedingAttention = (state: ClientState): SessionView[] =>
  state.sessions.filter((s) => s.attention !== null && s.attention.kind !== 'report');
