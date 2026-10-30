// Fixture builders. Every entity is typed against @minisumma/shared, so a change to a contract breaks these first.
import { defaultNotificationPrefs, defaultSettings } from '@minisumma/shared';
import type {
  ActivityEvent, Conversation, Delivery, Device, PendingAction, Project, Report, ReportSummary, Scope, SessionView, StateSnapshot,
} from '@minisumma/shared';

export const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
export const SESSION_KEY = `win|${SESSION_ID}` as const;
export const OTHER_KEY = 'wsl:Ubuntu|f9e8d7c6-0000-4000-8000-000000000002' as const;

export const makeProject = (over: Partial<Project> = {}): Project => ({
  id: 'prj_1', name: 'GitManager', description: null, githubRepo: null, roots: [], defaultEnv: 'win', preferredConversationId: 'cnv_1',
  defaultSessionKey: null, notificationPrefs: defaultNotificationPrefs(), sortOrder: 0, archivedAt: null,
  createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z', ...over,
});

export const makeConversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'cnv_1', projectId: 'prj_1', title: 'GitManager planning', url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555',
  originalUrl: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555', kind: 'chat', chatgptConversationId: '11111111-2222-4333-8444-555555555555',
  verification: 'verified', verifiedAt: null, verifiedTitle: null, note: null, position: 0,
  createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z', ...over,
});

export const makeSession = (over: Partial<SessionView> = {}): SessionView => ({
  key: SESSION_KEY, env: 'win', sessionId: SESSION_ID, origin: 'managed', availability: 'live', termination: null, resumable: false,
  projectId: 'prj_1', projectName: 'GitManager', projectResolution: 'managed', cwd: 'C:\\code\\git-manager', name: null, state: 'idle',
  stateLabel: 'Idle', stateEvidence: 'hook:Stop', generation: 2, pid: 4242, startedAt: '2026-10-30T08:05:00.000Z',
  lastActivityAt: '2026-10-30T09:00:00.000Z', attention: null, unresolvedOrdering: 0, terminal: { cols: 120, rows: 30, exited: false },
  isProjectDefault: false, remoteControl: { state: 'not_enabled', hint: 'Remote Control is not turned on for this session.' }, ...over,
});

export const makeSummary = (over: Partial<ReportSummary> = {}): ReportSummary => ({
  id: 'rep_1', projectId: 'prj_1', projectName: 'GitManager', sessionKey: SESSION_KEY, env: 'win', sessionId: SESSION_ID, generation: 2,
  taskTitle: 'Add retry to the sync job', declaredStatus: 'complete', source: 'marker', capturedAt: '2026-10-30T09:10:00.000Z', late: false,
  read: false, chars: 120, excerpt: 'Added retry', delivery: { id: 'dlv_1', state: 'ready_for_handoff', review: 'none', destinationTitle: 'GitManager planning', updatedAt: '2026-10-30T09:10:00.000Z' }, ...over,
});

export const makeReport = (over: Partial<Report> = {}): Report => ({
  ...makeSummary(), promptId: 'prm_1', taskId: 'tsk_1', cwd: 'C:\\code\\git-manager', body: 'Done.', bodySha256: 'abc', stopHookActive: false,
  verified: false, note: '', deliveries: [], ...over,
});

export const makeDelivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: 'dlv_1', reportId: 'rep_1', projectId: 'prj_1', projectName: 'GitManager', sessionKey: SESSION_KEY, taskTitle: 'Add retry to the sync job',
  state: 'ready_for_handoff', destination: {
    conversationId: 'cnv_1', url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555', title: 'GitManager planning',
    chatgptConversationId: '11111111-2222-4333-8444-555555555555', resolvedFrom: 'project_preferred', verificationAtFreeze: 'verified', frozenAt: '2026-10-30T09:10:00.000Z',
  }, review: 'none', includeReviewRequest: true, messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null,
  stateChangedAt: '2026-10-30T09:10:00.000Z', createdAt: '2026-10-30T09:10:00.000Z', updatedAt: '2026-10-30T09:10:00.000Z', ...over,
});

export const makeAction = (over: Partial<PendingAction> = {}): PendingAction => ({
  id: 'act_1', kind: 'permission', status: 'pending', projectId: 'prj_1', projectName: 'GitManager', sessionKey: SESSION_KEY, generation: 2, text: null,
  summary: 'Bash: git push origin main', reportId: null, deliveryId: null, createdAt: '2026-10-30T09:20:00.000Z', createdBy: { kind: 'system' },
  approvableBy: 'any_approver', decidedAt: null, decidedBy: null, executedAt: null, failure: null, expiresAt: '2099-01-01T00:00:00.000Z',
  target: { managed: true, live: true, generation: 2, generationMatches: true, state: 'needs_permission', problem: null }, ...over,
});

export const makeActivity = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'act-ev-1', at: '2026-10-30T09:15:00.000Z', projectId: 'prj_1', projectName: 'GitManager', source: 'claude', sessionKey: SESSION_KEY,
  type: 'needs_permission', severity: 'attention', title: 'Needs permission: GitManager / a1b2c3d4', description: 'Bash: git push origin main',
  requiresAction: true, resolvedAt: null, links: [{ kind: 'project', id: 'prj_1' }, { kind: 'session', key: SESSION_KEY }], read: false, ...over,
});

export const makeDevice = (over: Partial<Device> = {}): Device => ({
  id: 'dev_1', name: 'Pixel 8', platform: 'android', scopes: ['read', 'notify', 'prompt', 'approve'], trusted: false, pushRegistered: false,
  createdAt: '2026-10-30T08:00:00.000Z', lastSeenAt: null, lastSeenVia: 'tailscale', revokedAt: null, ...over,
});

export const withScopes = (scopes: Scope[], over: Partial<Device> = {}): Device => makeDevice({ scopes, ...over });

export const makeSnapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  seq: 10,
  system: {
    name: 'mini-summa-core', version: '0.1.0', apiVersion: 1, mode: 'embedded', platform: 'win32', startedAt: '2026-10-30T07:00:00.000Z',
    nativeCapabilities: { clipboard: true, chatgptEmbedded: true, extensionBridge: false, notifications: true, openExternal: true, saveFile: true },
  },
  projects: [makeProject()], conversations: [makeConversation()], sessions: [makeSession()],
  counts: { unreadActivity: 1, actionsNeeded: 1, pendingActions: 1, reportsAwaitingHandoff: 1, liveSessions: 1 }, settings: defaultSettings(), ...over,
});
