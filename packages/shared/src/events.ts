// WebSocket protocol between the core and its clients (/ws).
//
// One socket per client. The first message must be `hello` with the bearer token; nothing else is accepted before it.
// State changes arrive as numbered events. A client that reconnects says which sequence number it last saw; if the
// core can no longer replay from there it answers `resync: true` and the client reloads its snapshots.
// Terminal traffic (managed Claude sessions) is multiplexed on the same socket and requires the `desktop` scope.
import type {
  ActivityEvent, Conversation, Counts, Delivery, Device, HookStatus, NotificationRecord, PendingAction, Project,
  ReportSummary, Scope, SessionView, Settings, TailscaleStatus,
} from './entities.ts';
import type { EnvId, SessionKey } from './env.ts';

export type Topic =
  | 'projects' | 'sessions' | 'activity' | 'reports' | 'deliveries' | 'actions' | 'notifications' | 'devices'
  | 'settings' | 'system';

export const ALL_TOPICS: Topic[] = [
  'projects', 'sessions', 'activity', 'reports', 'deliveries', 'actions', 'notifications', 'devices', 'settings', 'system',
];

/** Topics a client without the `desktop` scope may never receive. */
export const DESKTOP_ONLY_TOPICS: Topic[] = ['devices', 'settings'];

export type ServerEvent =
  | { type: 'project.upserted'; project: Project }
  | { type: 'project.removed'; id: string }
  | { type: 'conversation.upserted'; conversation: Conversation }
  | { type: 'conversation.removed'; id: string; projectId: string }
  | { type: 'session.upserted'; session: SessionView }
  | { type: 'session.removed'; key: SessionKey }
  | { type: 'activity.added'; activity: ActivityEvent }
  | { type: 'activity.updated'; activity: ActivityEvent }
  | { type: 'activity.read'; ids: string[]; counts: Counts }
  | { type: 'report.upserted'; report: ReportSummary }
  | { type: 'delivery.upserted'; delivery: Delivery }
  | { type: 'action.upserted'; action: PendingAction }
  | { type: 'notification.added'; notification: NotificationRecord }
  | { type: 'device.upserted'; device: Device }
  | { type: 'device.removed'; id: string }
  | { type: 'settings.changed'; settings: Settings }
  | { type: 'tailscale.changed'; status: TailscaleStatus }
  | { type: 'hooks.changed'; env: EnvId; status: HookStatus }
  | { type: 'counts'; counts: Counts }
  | { type: 'system.notice'; level: 'info' | 'warning' | 'error'; message: string };

export type ServerEventType = ServerEvent['type'];

export interface ClientHello {
  t: 'hello';
  token: string;
  client: string;
  /** Last sequence number seen, to resume without a full reload. */
  since?: number;
  topics?: Topic[];
}

export type ClientMessage =
  | ClientHello
  | { t: 'subscribe'; topics: Topic[] }
  | { t: 'unsubscribe'; topics: Topic[] }
  | { t: 'ping' }
  | { t: 'term.attach'; key: SessionKey; cols: number; rows: number }
  | { t: 'term.input'; key: SessionKey; data: string }
  | { t: 'term.resize'; key: SessionKey; cols: number; rows: number }
  | { t: 'term.detach'; key: SessionKey }
  /** Extension bridge replies. Only accepted from a token with the `extension` scope. */
  | { t: 'bridge.result'; requestId: string; ok: boolean; data?: unknown; error?: string };

export type ServerMessage =
  | { t: 'ready'; serverTime: string; seq: number; scopes: Scope[]; deviceId: string | null; resync: boolean; apiVersion: number }
  | { t: 'error'; code: string; message: string; fatal?: boolean }
  | { t: 'pong' }
  | { t: 'event'; seq: number; topic: Topic; event: ServerEvent }
  /** Terminal output already produced is replayed once on attach, then live data follows with increasing seq. */
  | { t: 'term.attached'; key: SessionKey; replay: string; seq: number; cols: number; rows: number }
  | { t: 'term.data'; key: SessionKey; seq: number; data: string }
  | { t: 'term.exit'; key: SessionKey; code: number | null; signal: number | null; at: string; reason: string }
  | { t: 'term.error'; key: SessionKey; code: string; message: string }
  /** Sent to a connected extension: do something with a browser tab and answer with bridge.result. */
  | { t: 'bridge.request'; requestId: string; action: BridgeAction };

export type BridgeAction =
  | { kind: 'focus_or_open'; url: string }
  | { kind: 'list_chatgpt_tabs' };

export interface BridgeTabInfo { tabId: number; windowId: number; url: string; title: string; active: boolean }

export const topicOf = (event: ServerEvent): Topic => {
  switch (event.type) {
    case 'project.upserted': case 'project.removed': case 'conversation.upserted': case 'conversation.removed':
      return 'projects';
    case 'session.upserted': case 'session.removed': return 'sessions';
    case 'activity.added': case 'activity.updated': case 'activity.read': return 'activity';
    case 'report.upserted': return 'reports';
    case 'delivery.upserted': return 'deliveries';
    case 'action.upserted': return 'actions';
    case 'notification.added': return 'notifications';
    case 'device.upserted': case 'device.removed': return 'devices';
    case 'settings.changed': return 'settings';
    case 'tailscale.changed': case 'hooks.changed': case 'counts': case 'system.notice': return 'system';
  }
};
