// Realistic in-memory data for the demo client, tests and screenshots. Deterministic apart from the clock.
import { defaultNotificationPrefs, defaultSettings } from '@minisumma/shared';
import type {
  ActivityEvent, Conversation, Delivery, DeliveryState, Device, EnvironmentInfo, HookStatus, NotificationRecord,
  PendingAction, Project, ProjectRoot, Report, ReviewState, SessionKey, SessionView, Settings,
} from '@minisumma/shared';

export interface DemoData {
  projects: Project[];
  conversations: Conversation[];
  sessions: SessionView[];
  reports: Report[];
  deliveries: Delivery[];
  activity: ActivityEvent[];
  notifications: NotificationRecord[];
  actions: PendingAction[];
  devices: Device[];
  hooks: HookStatus[];
  environments: EnvironmentInfo[];
  settings: Settings;
}

// Well-known ids so tests and screenshots can name them.
export const IDS = {
  gitManager: 'prj_gitmanager',
  atlas: 'prj_atlas',
  docs: 'prj_docs',
  dashboard: 'prj_dashboard',
  s: {
    gmWorking: 'win|a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617',
    gmPermission: 'win|b7c8d9e0-1f2a-4b3c-9d4e-5f6a7b8c9d0e',
    gmExternal: 'win|d4e5f6a1-b2c3-4d4e-8f50-6172839405a6',
    atlasIdle: 'wsl:Ubuntu|e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7',
    atlasResumable: 'wsl:Ubuntu|f0e1d2c3-b4a5-4968-8776-655443322110',
    docsDisconnected: 'win|c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f',
    dashBackground: 'wsl:Ubuntu|0a1b2c3d-4e5f-4607-8192-a3b4c5d6e7f8',
    dashFailed: 'win|9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
    unassigned: 'wsl:Ubuntu|7c6b5a49-3827-4165-9403-b2a1c0d9e8f7',
  },
  c: {
    gmRelease: 'cnv_gm_release',
    gmReview: 'cnv_gm_review',
    atlasMain: 'cnv_atlas_main',
    dashCharts: 'cnv_dash_charts',
    dashApi: 'cnv_dash_api',
  },
} as const;

const MIN = 60_000;
const iso = (now: Date, minutesAgo: number): string => new Date(now.getTime() - minutesAgo * MIN).toISOString();

function root(projectId: string, n: number, env: ProjectRoot['env'], path: string): ProjectRoot {
  return { id: `${projectId}_root${n}`, projectId, env, path, label: null, position: n };
}

function conversation(now: Date, id: string, projectId: string, position: number, title: string, uuid: string, scope: string | null, verification: Conversation['verification'], verifiedTitle: string | null): Conversation {
  const url = scope ? `https://chatgpt.com/g/${scope}/c/${uuid}` : `https://chatgpt.com/c/${uuid}`;
  return {
    id, projectId, title, url, originalUrl: url, kind: scope ? 'project_chat' : 'chat', chatgptConversationId: uuid, verification,
    verifiedAt: verification === 'unverified' ? null : iso(now, 180), verifiedTitle, note: null, position,
    createdAt: iso(now, 60 * 24 * 12), updatedAt: iso(now, 180),
  };
}

function session(now: Date, key: string, over: Partial<SessionView> & Pick<SessionView, 'origin' | 'availability' | 'state' | 'stateLabel'>): SessionView {
  const sep = key.indexOf('|');
  const env = key.slice(0, sep) as SessionView['env'];
  return {
    key: key as SessionView['key'], env, sessionId: key.slice(sep + 1), termination: null, resumable: false,
    projectId: null, projectName: null, projectResolution: 'unregistered_directory', cwd: null, name: null,
    stateEvidence: over.origin === 'managed' ? 'managed:pty' : 'discovery', generation: 1, pid: 4000 + (key.charCodeAt(sep + 1) % 50) * 17,
    startedAt: iso(now, 95), lastActivityAt: iso(now, 1), attention: null, unresolvedOrdering: 0,
    terminal: over.origin === 'managed' ? { cols: 120, rows: 32, exited: false } : null, isProjectDefault: false,
    remoteControl: { state: 'unknown', hint: 'Type /remote-control in that session to control it from the Claude app or the web.' },
    ...over,
  };
}

function report(now: Date, id: string, p: { project: Project; session: string; title: string; status: Report['declaredStatus']; minutesAgo: number; read: boolean; delivery: { id: string; state: DeliveryState; review: ReviewState; destination: string | null } | null; excerpt: string }): Report {
  const sessionKey = p.session as Report['sessionKey'];
  const sep = p.session.indexOf('|');
  const body = `${p.excerpt}\n\n## What changed\n- Updated the affected modules and their tests.\n- Ran the full test suite: all passing.\n\n## Not done\n- Nothing outstanding.\n`;
  return {
    id, projectId: p.project.id, projectName: p.project.name, sessionKey, env: p.session.slice(0, sep) as Report['env'], sessionId: p.session.slice(sep + 1),
    generation: 1, taskTitle: p.title, declaredStatus: p.status, source: 'marker', capturedAt: iso(now, p.minutesAgo), late: false, read: p.read,
    chars: body.length, excerpt: p.excerpt,
    delivery: p.delivery ? { id: p.delivery.id, state: p.delivery.state, review: p.delivery.review, destinationTitle: p.delivery.destination, updatedAt: iso(now, p.minutesAgo - 1) } : null,
    promptId: null, taskId: `task_${id}`, cwd: p.project.roots[0]?.path ?? null, body, bodySha256: `${id}`.padEnd(64, '0'), stopHookActive: false,
    verified: false, note: 'Declared by Claude. Not verified by Mini-Summa.',
    deliveries: p.delivery ? [{ id: p.delivery.id, state: p.delivery.state, review: p.delivery.review, destinationTitle: p.delivery.destination, updatedAt: iso(now, p.minutesAgo - 1) }] : [],
  };
}

function delivery(now: Date, r: Report, conv: Conversation | null): Delivery | null {
  if (!r.delivery) return null;
  return {
    id: r.delivery.id, reportId: r.id, projectId: r.projectId, projectName: r.projectName, sessionKey: r.sessionKey, taskTitle: r.taskTitle,
    state: r.delivery.state, review: r.delivery.review,
    destination: conv ? { conversationId: conv.id, url: conv.url, title: conv.title, chatgptConversationId: conv.chatgptConversationId, resolvedFrom: 'project_preferred', verificationAtFreeze: conv.verification, frozenAt: r.capturedAt } : null,
    includeReviewRequest: true, messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null,
    stateChangedAt: r.delivery.updatedAt, createdAt: r.capturedAt, updatedAt: r.delivery.updatedAt,
  };
}

export function createSeed(now: Date = new Date()): DemoData {
  const prefs = defaultNotificationPrefs();
  const base = (id: string, name: string, order: number, over: Partial<Project>): Project => ({
    id, name, description: null, githubRepo: null, chatgptProject: null, roots: [], defaultEnv: 'win', preferredConversationId: null, defaultSessionKey: null,
    notificationPrefs: prefs, sortOrder: order, archivedAt: null, createdAt: iso(now, 60 * 24 * 30), updatedAt: iso(now, 60 * 5), ...over,
  });

  const gm = base(IDS.gitManager, 'GitManager', 0, {
    githubRepo: 'acme/git-manager', roots: [root(IDS.gitManager, 0, 'win', 'C:\\Dev\\GitManager')],
    preferredConversationId: IDS.c.gmRelease, defaultSessionKey: IDS.s.gmWorking as SessionKey,
  });
  const atlas = base(IDS.atlas, 'Atlas API', 1, {
    githubRepo: 'acme/atlas-api', defaultEnv: 'wsl:Ubuntu', roots: [root(IDS.atlas, 0, 'wsl:Ubuntu', '/home/dev/atlas-api')],
    preferredConversationId: IDS.c.atlasMain,
  });
  const docs = base(IDS.docs, 'Docs site', 2, { roots: [root(IDS.docs, 0, 'win', 'C:\\Dev\\docs-site')] });
  const dash = base(IDS.dashboard, 'Trading dashboard', 3, {
    githubRepo: 'acme/dashboard',
    roots: [root(IDS.dashboard, 0, 'win', 'C:\\Dev\\dashboard'), root(IDS.dashboard, 1, 'wsl:Ubuntu', '/home/dev/dashboard-api')],
    preferredConversationId: IDS.c.dashCharts,
  });
  const projects = [gm, atlas, docs, dash];

  const conversations: Conversation[] = [
    conversation(now, IDS.c.gmRelease, gm.id, 0, 'Release planning', '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', null, 'verified', 'Release planning for GitManager'),
    conversation(now, IDS.c.gmReview, gm.id, 1, 'Code review notes', '0b9c8d7e-6f5a-4b4c-9d3e-2f1a0b9c8d7e', 'g-p-6720aa11bb22cc33', 'verified', 'Code review notes'),
    conversation(now, IDS.c.atlasMain, atlas.id, 0, 'Atlas API design', '3a4b5c6d-7e8f-4091-a2b3-c4d5e6f70819', null, 'unverified', null),
    conversation(now, IDS.c.dashCharts, dash.id, 0, 'Charts and rendering', '8d7c6b5a-4938-4271-8605-f4e3d2c1b0a9', null, 'verified', 'Charts and rendering'),
    conversation(now, IDS.c.dashApi, dash.id, 1, 'Market data API', '1c2d3e4f-5061-4728-8394-a5b6c7d8e9f0', null, 'login_required', null),
  ];

  const sessions: SessionView[] = [
    session(now, IDS.s.gmWorking, { origin: 'managed', availability: 'live', state: 'working', stateLabel: 'Working', projectId: gm.id, projectName: gm.name, projectResolution: 'managed', cwd: 'C:\\Dev\\GitManager', isProjectDefault: true, stateEvidence: 'hook:PostToolUse' }),
    session(now, IDS.s.gmPermission, {
      origin: 'managed', availability: 'live', state: 'needs_permission', stateLabel: 'Waiting for your permission', projectId: gm.id, projectName: gm.name, projectResolution: 'managed',
      cwd: 'C:\\Dev\\GitManager', attention: { kind: 'permission', since: iso(now, 3) }, stateEvidence: 'hook:PermissionRequest', startedAt: iso(now, 40),
    }),
    session(now, IDS.s.gmExternal, {
      origin: 'external', availability: 'live', state: 'idle', stateLabel: 'Idle', projectId: gm.id, projectName: gm.name, projectResolution: 'matched', cwd: 'C:\\Dev\\GitManager',
      stateEvidence: 'hook:Stop', startedAt: iso(now, 210), lastActivityAt: iso(now, 14),
    }),
    session(now, IDS.s.atlasIdle, { origin: 'managed', availability: 'live', state: 'waiting_for_you', stateLabel: 'Waiting for you', projectId: atlas.id, projectName: atlas.name, projectResolution: 'managed', cwd: '/home/dev/atlas-api', stateEvidence: 'hook:Stop' }),
    session(now, IDS.s.atlasResumable, {
      origin: 'managed', availability: 'resumable', state: 'turn_ended', stateLabel: 'Finished a turn', projectId: atlas.id, projectName: atlas.name, projectResolution: 'managed',
      cwd: '/home/dev/atlas-api', resumable: true, termination: { kind: 'observed', reason: 'The session ended (SessionEnd hook).', at: iso(now, 75) },
      terminal: { cols: 120, rows: 32, exited: true }, startedAt: iso(now, 300), lastActivityAt: iso(now, 75), pid: null,
    }),
    session(now, IDS.s.docsDisconnected, {
      origin: 'managed', availability: 'disconnected', state: 'idle', stateLabel: 'Idle (last known)', projectId: docs.id, projectName: docs.name, projectResolution: 'managed',
      cwd: 'C:\\Dev\\docs-site', resumable: true, startedAt: iso(now, 60 * 20), lastActivityAt: iso(now, 60 * 19), pid: null,
    }),
    session(now, IDS.s.dashBackground, {
      origin: 'background', availability: 'live', state: 'background_wait', stateLabel: 'Running in the background', projectId: dash.id, projectName: dash.name, projectResolution: 'matched',
      cwd: '/home/dev/dashboard-api', name: 'nightly-benchmarks', stateEvidence: 'discovery',
    }),
    session(now, IDS.s.dashFailed, {
      origin: 'managed', availability: 'ended', state: 'error', stateLabel: 'Ended with an error', projectId: dash.id, projectName: dash.name, projectResolution: 'managed', cwd: 'C:\\Dev\\dashboard',
      attention: { kind: 'abnormal_end', since: iso(now, 22) }, termination: { kind: 'observed', reason: 'The process exited with code 1.', at: iso(now, 22) },
      terminal: { cols: 120, rows: 32, exited: true }, pid: null, startedAt: iso(now, 140), lastActivityAt: iso(now, 22),
    }),
    session(now, IDS.s.unassigned, {
      origin: 'external', availability: 'live', state: 'working', stateLabel: 'Working', projectResolution: 'unregistered_directory', cwd: '/home/dev/scratch',
      stateEvidence: 'discovery', startedAt: iso(now, 12),
    }),
  ];

  const r = (id: string, p: Parameters<typeof report>[2]) => report(now, id, p);
  const reports: Report[] = [
    r('rpt_gm_1', { project: gm, session: IDS.s.gmWorking, title: 'Fix flaky push retry test', status: 'complete', minutesAgo: 9, read: false, delivery: { id: 'dlv_gm_1', state: 'ready_for_handoff', review: 'none', destination: 'Release planning' }, excerpt: 'The retry test no longer depends on wall-clock time. It now uses a fake clock and passes 200 runs in a row.' }),
    r('rpt_gm_2', { project: gm, session: IDS.s.gmWorking, title: 'Add branch protection checks', status: 'partial', minutesAgo: 55, read: true, delivery: { id: 'dlv_gm_2', state: 'awaiting_user_send', review: 'none', destination: 'Release planning' }, excerpt: 'Branch protection is read from the GitHub API and shown in the status panel. Pull request rules are still missing.' }),
    r('rpt_gm_3', { project: gm, session: IDS.s.gmExternal, title: 'Upgrade libgit2 to 1.9', status: 'complete', minutesAgo: 60 * 6, read: true, delivery: { id: 'dlv_gm_3', state: 'user_confirmed_sent', review: 'requested', destination: 'Release planning' }, excerpt: 'libgit2 is now 1.9.0. Two deprecated calls were replaced; the clone tests pass on Windows and Linux.' }),
    r('rpt_atlas_1', { project: atlas, session: IDS.s.atlasResumable, title: 'Migrate auth middleware', status: 'blocked', minutesAgo: 80, read: false, delivery: { id: 'dlv_atlas_1', state: 'destination_unverified', review: 'none', destination: 'Atlas API design' }, excerpt: 'Blocked: the token format changed upstream and the fixtures need the new signing key.' }),
    r('rpt_docs_1', { project: docs, session: IDS.s.docsDisconnected, title: 'Rewrite the install guide', status: 'complete', minutesAgo: 60 * 19, read: false, delivery: { id: 'dlv_docs_1', state: 'destination_missing', review: 'none', destination: null }, excerpt: 'The install guide now covers Windows, WSL and Linux, with one command per step.' }),
    r('rpt_dash_1', { project: dash, session: IDS.s.dashFailed, title: 'Candle chart zoom bug', status: 'complete', minutesAgo: 60 * 3, read: true, delivery: { id: 'dlv_dash_1', state: 'delivery_uncertain', review: 'none', destination: 'Charts and rendering' }, excerpt: 'Zoom now keeps the cursor position fixed. The bug was a rounding error in the axis transform.' }),
    r('rpt_dash_2', { project: dash, session: IDS.s.dashBackground, title: 'Websocket reconnect backoff', status: 'partial', minutesAgo: 60 * 8, read: true, delivery: { id: 'dlv_dash_2', state: 'user_discarded', review: 'closed', destination: 'Charts and rendering' }, excerpt: 'Reconnects now back off up to 30 seconds. The jitter is not applied yet.' }),
  ];
  const convById = new Map(conversations.map((c) => [c.id, c]));
  const convFor = (rep: Report): Conversation | null => {
    const p = projects.find((x) => x.id === rep.projectId);
    return p?.preferredConversationId ? convById.get(p.preferredConversationId) ?? null : null;
  };
  const deliveries = reports.map((rep) => delivery(now, rep, convFor(rep))).filter((d): d is Delivery => d !== null);

  const act = (id: string, minutesAgo: number, over: Partial<ActivityEvent> & Pick<ActivityEvent, 'type' | 'title' | 'source'>): ActivityEvent => ({
    id, at: iso(now, minutesAgo), projectId: null, projectName: null, sessionKey: null, severity: 'info', description: null, requiresAction: false, resolvedAt: null, links: [], read: true, ...over,
  });
  const activity: ActivityEvent[] = [
    act('act_1', 3, { type: 'needs_permission', source: 'claude', title: 'GitManager needs your permission', description: 'Session b7c8d9e0 wants to run a shell command.', severity: 'attention', requiresAction: true, read: false, projectId: gm.id, projectName: gm.name, sessionKey: IDS.s.gmPermission as SessionKey, links: [{ kind: 'session', key: IDS.s.gmPermission as SessionKey }] }),
    act('act_2', 9, { type: 'report_ready', source: 'claude', title: 'Report ready: Fix flaky push retry test', read: false, projectId: gm.id, projectName: gm.name, links: [{ kind: 'report', id: 'rpt_gm_1' }] }),
    act('act_3', 22, { type: 'error', source: 'claude', title: 'Trading dashboard: a session ended with an error', description: 'The process exited with code 1.', severity: 'error', requiresAction: true, read: false, projectId: dash.id, projectName: dash.name, sessionKey: IDS.s.dashFailed as SessionKey }),
    act('act_4', 55, { type: 'report_ready', source: 'claude', title: 'Report ready: Add branch protection checks', projectId: gm.id, projectName: gm.name, links: [{ kind: 'report', id: 'rpt_gm_2' }] }),
    act('act_5', 80, { type: 'report_ready', source: 'claude', title: 'Report ready: Migrate auth middleware', description: 'Declared blocked.', severity: 'attention', projectId: atlas.id, projectName: atlas.name, read: false }),
    act('act_6', 95, { type: 'session_started', source: 'claude', title: 'Session a1b2c3d4 started in GitManager', projectId: gm.id, projectName: gm.name }),
    act('act_7', 60 * 3, { type: 'delivery_state', source: 'delivery', title: 'Delivery marked uncertain: Candle chart zoom bug', projectId: dash.id, projectName: dash.name }),
    act('act_8', 60 * 20, { type: 'device_paired', source: 'device', title: 'Pixel 8 paired', description: 'Remote access is off.' }),
    act('act_9', 60 * 30, { type: 'hooks_changed', source: 'hooks', title: 'Claude Code hooks installed for Windows' }),
  ];

  const notifications: NotificationRecord[] = [
    { id: 'ntf_1', activityId: 'act_1', projectId: gm.id, at: iso(now, 3), title: 'GitManager needs your permission', body: 'Session b7c8d9e0 wants to run a shell command.', native: 'sent', push: 'not_applicable', readAt: null, target: { view: 'workspace', projectId: gm.id, sessionKey: IDS.s.gmPermission as SessionKey } },
    { id: 'ntf_2', activityId: 'act_2', projectId: gm.id, at: iso(now, 9), title: 'Report ready', body: 'Fix flaky push retry test', native: 'sent', push: 'not_applicable', readAt: iso(now, 8), target: { view: 'reports', reportId: 'rpt_gm_1' } },
  ];

  const actions: PendingAction[] = [{
    id: 'act_perm_1', kind: 'permission', status: 'pending', projectId: gm.id, projectName: gm.name, sessionKey: IDS.s.gmPermission as SessionKey, generation: 1, text: null,
    summary: 'Bash: rm -rf node_modules && npm ci', reportId: null, deliveryId: null, createdAt: iso(now, 3), createdBy: { kind: 'system' }, approvableBy: 'desktop',
    decidedAt: null, decidedBy: null, executedAt: null, failure: null, expiresAt: new Date(now.getTime() + 55 * MIN).toISOString(),
    target: { managed: true, live: true, generation: 1, generationMatches: true, state: 'needs_permission', problem: null },
  }];

  const devices: Device[] = [{
    id: 'dev_pixel', name: 'Pixel 8', platform: 'android', scopes: ['read', 'notify', 'prompt'], trusted: false, pushRegistered: false,
    createdAt: iso(now, 60 * 20), lastSeenAt: iso(now, 60 * 2), lastSeenVia: 'localhost', revokedAt: null,
  }];

  const hookStatus = (env: HookStatus['env'], installed: boolean): HookStatus => ({
    env, configDir: env === 'win' ? 'C:\\Users\\dev\\.claude' : '/home/dev/.claude', settingsPath: env === 'win' ? 'C:\\Users\\dev\\.claude\\settings.json' : '/home/dev/.claude/settings.json',
    settingsExists: true, installed, events: installed ? ['SessionStart', 'Stop', 'SessionEnd', 'PermissionRequest', 'Notification'] : [], missingEvents: installed ? [] : ['SessionStart', 'Stop', 'SessionEnd'],
    duplicateRegistrations: false, runtime: { command: 'node', kind: 'node', version: '22.12.0' }, captureScript: 'capture.mjs', issues: installed ? [] : ['Hooks are not installed in this environment.'],
  });
  const hooks = [hookStatus('win', true), hookStatus('wsl:Ubuntu', false)];

  const environments: EnvironmentInfo[] = [
    { id: 'win', label: 'Windows', available: true, claude: { path: 'C:\\Users\\dev\\.local\\bin\\claude.exe', version: '2.1.4', error: null }, node: { path: 'C:\\Program Files\\nodejs\\node.exe', version: '22.12.0' }, configDir: 'C:\\Users\\dev\\.claude', hooks: hooks[0], notes: [] },
    { id: 'wsl:Ubuntu', label: 'WSL (Ubuntu)', available: true, claude: { path: '/home/dev/.local/bin/claude', version: '2.1.4', error: null }, node: { path: '/usr/bin/node', version: '22.11.0' }, configDir: '/home/dev/.claude', hooks: hooks[1], notes: [] },
    { id: 'wsl:Debian', label: 'WSL (Debian)', available: true, claude: { path: null, version: null, error: 'claude was not found in PATH.' }, node: { path: null, version: null }, configDir: null, hooks: null, notes: ['Claude Code is not installed in this distribution.'] },
  ];

  const settings = defaultSettings();
  return { projects, conversations, sessions, reports, deliveries, activity, notifications, actions, devices, hooks, environments, settings };
}

/** An empty world for the first-run screenshots and tests: no projects, no sessions. */
export function createEmptySeed(): DemoData {
  const full = createSeed();
  return {
    ...full, projects: [], conversations: [], sessions: [], reports: [], deliveries: [], activity: [], notifications: [], actions: [],
  };
}
