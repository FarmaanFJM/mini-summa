// Shared fixtures for the workflow service tests. Every service is tested alone, against an in-memory database that has
// the real schema, with fakes for the services it depends on. Nothing here is imported by production code.
import { defaultNotificationPrefs, defaultSettings, mergeSettings, parseChatGptUrl, unavailableBridge } from '@minisumma/shared';
import type {
  ActivityEvent, ChatGptOpenResult, Conversation, ConversationVerification, Device, NativeBridge, NativeCapabilities, NativeNotification, NavigationTarget,
  PendingAction, Project, ProjectNotificationPrefs, Report, ServerEvent, SessionKey, SessionView, SettingsPatch, TargetCheck,
} from '@minisumma/shared';
import { fromJson, openDatabase, toJson } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import { createEventBus } from '../../src/bus.ts';
import type {
  ActivityInput, ActivityService, Clock, CoreBase, DevicesService, EventBus, Logger, NotifyHint, ProjectsService, PushPayload, PushProvider, SessionsService,
  SettingsService, TypeIntoResult,
} from '../../src/contracts.ts';
import { notFound } from '../../src/errors.ts';
import { createActivityService } from '../../src/workflow/activity.ts';

// ---------------------------------------------------------------------------------------------------------------
// Time, logging, base

export class TestClock implements Clock {
  private ms: number;
  constructor(start: string | Date = '2026-10-30T10:00:00.000Z') { this.ms = new Date(start).getTime(); }
  now(): Date { return new Date(this.ms); }
  set(to: string | Date): void { this.ms = new Date(to).getTime(); }
  advance(ms: number): void { this.ms += ms; }
  iso(): string { return new Date(this.ms).toISOString(); }
}

export interface LogLine { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }

export function recordingLogger(): Logger & { lines: LogLine[]; errors(): LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: LogLine['level']) => (msg: string, data?: Record<string, unknown>): void => { lines.push({ level, msg, data }); };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), errors: () => lines.filter((l) => l.level === 'error') };
}

export interface Env {
  db: Db;
  bus: EventBus;
  clock: TestClock;
  log: ReturnType<typeof recordingLogger>;
  base: CoreBase;
  /** Every event emitted on the bus so far, in order. */
  events: ServerEvent[];
  of<T extends ServerEvent['type']>(type: T): Extract<ServerEvent, { type: T }>[];
  clearEvents(): void;
}

export function makeEnv(start?: string | Date): Env {
  const { db } = openDatabase(':memory:');
  const bus = createEventBus();
  const clock = new TestClock(start);
  const log = recordingLogger();
  const events: ServerEvent[] = [];
  bus.subscribe((_seq, event) => { events.push(event); });
  return {
    db, bus, clock, log, events,
    base: { db, bus, clock, log, version: 'test', mode: 'headless', dataDir: '' },
    of: <T extends ServerEvent['type']>(type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type),
    clearEvents: () => { events.length = 0; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

export function fakeSettings(patch: SettingsPatch = {}): SettingsService & { set(patch: SettingsPatch): void } {
  let current = mergeSettings(defaultSettings(), patch);
  const listeners = new Set<(next: typeof current, prev: typeof current) => void>();
  const service = {
    get: () => current,
    update(p: SettingsPatch) {
      const prev = current;
      current = mergeSettings(current, p);
      for (const fn of listeners) fn(current, prev);
      return current;
    },
    onChange(fn: (next: typeof current, prev: typeof current) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set(p: SettingsPatch) { service.update(p); },
  };
  return service;
}

// ---------------------------------------------------------------------------------------------------------------
// Projects and conversations, backed by the real tables so foreign keys behave like production

export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface ProjectRow {
  id: string; name: string; description: string | null; github_repo: string | null; default_env: Project['defaultEnv']; preferred_conversation_id: string | null;
  default_session_key: SessionKey | null; notification_prefs_json: string; sort_order: number; archived_at: string | null; created_at: string; updated_at: string;
}

interface ConversationRow {
  id: string; project_id: string; title: string; url: string; original_url: string; kind: Conversation['kind']; chatgpt_conversation_id: string | null;
  verification: ConversationVerification; verified_at: string | null; verified_title: string | null; note: string | null; position: number; created_at: string; updated_at: string;
}

export class FakeProjects {
  readonly verifications: { id: string; verification: ConversationVerification; title?: string | null }[] = [];
  failVerification = false;
  private counter = 0;

  constructor(private readonly db: Db, private readonly clock: Clock) {}

  addProject(over: { id?: string; name?: string; prefs?: Partial<ProjectNotificationPrefs> } = {}): Project {
    this.counter++;
    const id = over.id ?? `prj_${this.counter}`;
    const now = this.clock.now().toISOString();
    this.db.run(
      `INSERT INTO projects (id, name, description, github_repo, default_env, preferred_conversation_id, default_session_key, notification_prefs_json, sort_order, archived_at, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'win', NULL, NULL, ?, 0, NULL, ?, ?)`,
      [id, over.name ?? `Project ${this.counter}`, toJson({ ...defaultNotificationPrefs(), ...over.prefs }), now, now],
    );
    return this.get(id)!;
  }

  setPrefs(id: string, prefs: Partial<ProjectNotificationPrefs>): void {
    const current = this.get(id)!.notificationPrefs;
    this.db.run('UPDATE projects SET notification_prefs_json = ? WHERE id = ?', [toJson({ ...current, ...prefs }), id]);
  }

  removeProject(id: string): void { this.db.run('DELETE FROM projects WHERE id = ?', [id]); }

  addConversation(projectId: string, over: { id?: string; title?: string; url?: string; verification?: ConversationVerification } = {}): Conversation {
    this.counter++;
    const url = over.url ?? `https://chatgpt.com/c/${uuid(this.counter)}`;
    const parsed = parseChatGptUrl(url);
    if (!parsed.ok) throw new Error(parsed.message);
    const id = over.id ?? `cnv_${this.counter}`;
    const now = this.clock.now().toISOString();
    this.db.run(
      `INSERT INTO conversations (id, project_id, title, url, original_url, kind, chatgpt_conversation_id, verification, verified_at, verified_title, note, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      [id, projectId, over.title ?? `Chat ${this.counter}`, parsed.info.url, url, parsed.info.kind, parsed.info.chatgptConversationId, over.verification ?? 'unverified', this.counter, now, now],
    );
    return this.conversations.get(id)!;
  }

  setPreferred(projectId: string, conversationId: string | null): void {
    this.db.run('UPDATE projects SET preferred_conversation_id = ? WHERE id = ?', [conversationId, projectId]);
  }

  /** Simulates the person editing a conversation after reports were already captured. */
  editConversation(id: string, patch: { url?: string; title?: string; verification?: ConversationVerification }): void {
    if (patch.url !== undefined) this.db.run('UPDATE conversations SET url = ? WHERE id = ?', [patch.url, id]);
    if (patch.title !== undefined) this.db.run('UPDATE conversations SET title = ? WHERE id = ?', [patch.title, id]);
    if (patch.verification !== undefined) this.db.run('UPDATE conversations SET verification = ? WHERE id = ?', [patch.verification, id]);
  }

  removeConversation(id: string): void { this.db.run('DELETE FROM conversations WHERE id = ?', [id]); }

  readonly get = (id: string): Project | null => {
    const r = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
    if (!r) return null;
    return {
      id: r.id, name: r.name, description: r.description, githubRepo: r.github_repo, roots: [], defaultEnv: r.default_env,
      preferredConversationId: r.preferred_conversation_id, defaultSessionKey: r.default_session_key,
      notificationPrefs: fromJson<ProjectNotificationPrefs>(r.notification_prefs_json, defaultNotificationPrefs()), sortOrder: r.sort_order,
      archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  };

  private toConversation(r: ConversationRow): Conversation {
    return {
      id: r.id, projectId: r.project_id, title: r.title, url: r.url, originalUrl: r.original_url, kind: r.kind, chatgptConversationId: r.chatgpt_conversation_id,
      verification: r.verification, verifiedAt: r.verified_at, verifiedTitle: r.verified_title, note: r.note, position: r.position,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  readonly conversations: ProjectsService['conversations'] = {
    list: (projectId) => this.db.all<ConversationRow>('SELECT * FROM conversations WHERE project_id = ? ORDER BY position, id', [projectId]).map((r) => this.toConversation(r)),
    get: (id) => {
      const r = this.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]);
      return r ? this.toConversation(r) : null;
    },
    require: (id) => {
      const c = this.conversations.get(id);
      if (!c) throw notFound('Conversation');
      return c;
    },
    add: () => { throw new Error('not used by the workflow services'); },
    update: () => { throw new Error('not used by the workflow services'); },
    remove: () => { throw new Error('not used by the workflow services'); },
    setPreferred: () => { throw new Error('not used by the workflow services'); },
    setVerification: (id, result) => {
      if (this.failVerification) throw new Error('verification store is down');
      this.verifications.push({ id, verification: result.verification, title: result.title });
      this.db.run('UPDATE conversations SET verification = ?, verified_at = ?, verified_title = COALESCE(?, verified_title) WHERE id = ?',
        [result.verification, this.clock.now().toISOString(), result.title ?? null, id]);
      return this.conversations.require(id);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

export const KEY_A = 'win|a1b2c3d4-1111-4111-8111-111111111111' as SessionKey;
export const KEY_B = 'win|b2c3d4e5-2222-4222-8222-222222222222' as SessionKey;
export const KEY_C = 'wsl:Ubuntu|c3d4e5f6-3333-4333-8333-333333333333' as SessionKey;
export const KEY_EXT = 'win|e5f6a7b8-4444-4444-8444-444444444444' as SessionKey;

export function sessionView(over: Partial<SessionView> = {}): SessionView {
  return {
    key: KEY_A, env: 'win', sessionId: 'a1b2c3d4-1111-4111-8111-111111111111', origin: 'managed', availability: 'live', termination: null, resumable: false,
    projectId: null, projectName: null, projectResolution: 'managed', cwd: 'C:\\dev\\gm', name: null, state: 'idle', stateLabel: 'Idle', stateEvidence: 'hook:Stop',
    generation: 1, pid: 100, startedAt: null, lastActivityAt: null, attention: null, unresolvedOrdering: 0, terminal: { cols: 120, rows: 32, exited: false },
    isProjectDefault: false, remoteControl: { state: 'unknown', hint: '' }, ...over,
  };
}

type TypeCall = { key: SessionKey; req: Parameters<SessionsService['typeInto']>[1] };
type AnswerCall = { key: SessionKey; decision: 'approve' | 'reject'; expectGeneration: number | null };

/** Behaves like the real SessionsService contract: targetCheck never throws, typeInto re-verifies before typing. */
export class FakeSessions {
  readonly views = new Map<SessionKey, SessionView>();
  readonly bindings = new Map<SessionKey, string>();
  readonly typeCalls: TypeCall[] = [];
  readonly typed: { key: SessionKey; text: string; submit: boolean }[] = [];
  readonly answerCalls: AnswerCall[] = [];
  readonly answers: { key: SessionKey; decision: 'approve' | 'reject' }[] = [];
  /** Force the outcome of typeInto / answerPermission (a result, or a function that may throw or wait). */
  typeHook: ((call: TypeCall) => TypeIntoResult | Promise<TypeIntoResult>) | null = null;
  answerHook: ((call: AnswerCall) => TypeIntoResult | Promise<TypeIntoResult>) | null = null;

  add(over: Partial<SessionView>): SessionView {
    const v = sessionView(over);
    this.views.set(v.key, v);
    return v;
  }

  patch(key: SessionKey, over: Partial<SessionView>): void {
    const v = this.views.get(key);
    if (!v) throw new Error(`no session ${key}`);
    this.views.set(key, { ...v, ...over });
  }

  readonly get = (key: SessionKey): SessionView | null => this.views.get(key) ?? null;
  readonly conversationBinding = (key: SessionKey): string | null => this.bindings.get(key) ?? null;

  /** Replaceable in a test (for example to make the session layer word a problem differently). */
  targetCheck: SessionsService['targetCheck'] = (key, expectGeneration): TargetCheck => {
    const v = this.views.get(key);
    if (!v) return { managed: false, live: false, generation: null, generationMatches: false, state: null, problem: 'Mini-Summa does not know this session.' };
    const managed = v.origin === 'managed';
    const live = v.availability === 'live';
    const matches = expectGeneration === null || expectGeneration === v.generation;
    const problem = !managed ? 'This session was not started by Mini-Summa.'
      : !live ? 'This session is not running right now.'
        : !matches ? `This session was restarted (it is now generation ${v.generation}).` : null;
    return { managed, live, generation: v.generation, generationMatches: matches, state: v.state, problem };
  };

  readonly typeInto = async (key: SessionKey, req: Parameters<SessionsService['typeInto']>[1]): Promise<TypeIntoResult> => {
    const call = { key, req };
    this.typeCalls.push(call);
    if (this.typeHook) return this.typeHook(call);
    const v = this.views.get(key);
    if (!v || v.origin !== 'managed') return { ok: false, code: 'not_managed', problem: 'This session was not started by Mini-Summa.' };
    if (v.availability !== 'live') return { ok: false, code: 'not_live', problem: 'This session is not running right now.' };
    if (req.expectGeneration !== null && req.expectGeneration !== v.generation) return { ok: false, code: 'generation_changed', problem: 'This session was restarted.' };
    if (!req.allowedStates.includes(v.state)) return { ok: false, code: 'state_not_allowed', problem: `Claude is busy (${v.stateLabel}), so nothing was typed.` };
    this.typed.push({ key, text: req.text, submit: req.submit });
    return { ok: true, submitted: req.submit };
  };

  readonly answerPermission = async (key: SessionKey, decision: 'approve' | 'reject', expectGeneration: number | null): Promise<TypeIntoResult> => {
    const call = { key, decision, expectGeneration };
    this.answerCalls.push(call);
    if (this.answerHook) return this.answerHook(call);
    const v = this.views.get(key);
    if (!v || v.origin !== 'managed') return { ok: false, code: 'not_managed', problem: 'This session was not started by Mini-Summa.' };
    if (v.availability !== 'live') return { ok: false, code: 'not_live', problem: 'This session is not running right now.' };
    if (expectGeneration !== null && expectGeneration !== v.generation) return { ok: false, code: 'generation_changed', problem: 'This session was restarted.' };
    if (v.state !== 'needs_permission') return { ok: false, code: 'state_not_allowed', problem: 'Claude is not asking for permission right now.' };
    this.answers.push({ key, decision });
    return { ok: true, submitted: true };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The host (clipboard, ChatGPT, notifications, files)

export interface FakeNative extends NativeBridge {
  caps: NativeCapabilities;
  clipboardWrites: string[];
  opened: { url: string; focus: boolean; reason: string }[];
  notifications: NativeNotification[];
  saved: { suggestedName: string; text: string }[];
  /** Every method of the bridge that was called, in order, as "clipboard.writeText", "chatgpt.open", ... */
  calls: string[];
  clipboardError: Error | null;
  openImpl: (url: string) => ChatGptOpenResult | Promise<ChatGptOpenResult>;
  notifyImpl: (n: NativeNotification) => { shown: boolean; reason?: string } | Promise<{ shown: boolean; reason?: string }>;
  saveImpl: (opts: { suggestedName: string; text: string }) => { path: string | null } | Promise<{ path: string | null }>;
}

export const okOpen = (url: string, over: Partial<ChatGptOpenResult> = {}): ChatGptOpenResult =>
  ({ ok: true, mode: 'embedded', opened: true, focused: true, verified: true, finalUrl: url, title: 'ChatGPT', note: null, ...over });

export function fakeNative(over: Partial<NativeCapabilities> = {}): FakeNative {
  const base = unavailableBridge();
  const fake: FakeNative = {
    ...base,
    caps: { clipboard: true, chatgptEmbedded: true, extensionBridge: false, notifications: true, openExternal: true, saveFile: true, ...over },
    clipboardWrites: [], opened: [], notifications: [], saved: [], calls: [], clipboardError: null,
    openImpl: (url) => okOpen(url),
    notifyImpl: () => ({ shown: true }),
    saveImpl: (opts) => ({ path: `/saved/${opts.suggestedName}` }),
    capabilities: () => fake.caps,
    chatgpt: {
      async open(url, opts) { fake.calls.push('chatgpt.open'); fake.opened.push({ url, focus: opts.focus, reason: opts.reason }); return fake.openImpl(url); },
      async verify(url) { fake.calls.push('chatgpt.verify'); return okOpen(url); },
      state: () => base.chatgpt.state(),
    },
    clipboard: {
      async writeText(text) {
        fake.calls.push('clipboard.writeText');
        if (fake.clipboardError) throw fake.clipboardError;
        fake.clipboardWrites.push(text);
      },
    },
    async notify(n) { fake.calls.push('notify'); fake.notifications.push(n); return fake.notifyImpl(n); },
    async openExternal() { fake.calls.push('openExternal'); },
    async saveTextFile(opts) { fake.calls.push('saveTextFile'); fake.saved.push(opts); return fake.saveImpl(opts); },
  };
  return fake;
}

// ---------------------------------------------------------------------------------------------------------------
// Push and devices

export class FakePush implements PushProvider {
  readonly name = 'fcm' as const;
  isConfigured = true;
  readonly sent: { targets: { deviceId: string; token: string }[]; payload: PushPayload }[] = [];
  respond: (targets: { deviceId: string; token: string }[]) => { deviceId: string; result: 'sent' | 'failed' | 'invalid_token'; error?: string }[] | Promise<{ deviceId: string; result: 'sent' | 'failed' | 'invalid_token'; error?: string }[]> =
    (targets) => targets.map((t) => ({ deviceId: t.deviceId, result: 'sent' as const }));
  throwOnSend: Error | null = null;
  configured(): boolean { return this.isConfigured; }
  configureFromJson(): { firebaseProject: string } { return { firebaseProject: 'test' }; }
  clear(): void { this.isConfigured = false; }
  async send(targets: { deviceId: string; token: string }[], payload: PushPayload) {
    this.sent.push({ targets, payload });
    if (this.throwOnSend) throw this.throwOnSend;
    return this.respond(targets);
  }
}

export const device = (over: Partial<Device> = {}): Device => ({
  id: 'dev_phone', name: 'Pixel', platform: 'android', scopes: ['read', 'prompt', 'approve'], trusted: false, pushRegistered: true,
  createdAt: '2026-10-01T00:00:00.000Z', lastSeenAt: null, lastSeenVia: null, revokedAt: null, ...over,
});

export class FakeDevices implements Pick<DevicesService, 'pushTargets' | 'clearPushToken' | 'get'> {
  targets: { deviceId: string; provider: 'fcm'; token: string; projectIds: 'all' }[] = [];
  readonly cleared: string[] = [];
  readonly devices = new Map<string, Device>();
  addDevice(over: Partial<Device> = {}): Device { const d = device(over); this.devices.set(d.id, d); return d; }
  addPushTarget(deviceId: string, token = `token-of-${deviceId}`): void { this.targets.push({ deviceId, provider: 'fcm', token, projectIds: 'all' }); }
  pushTargets() { return this.targets; }
  clearPushToken(deviceId: string): void { this.cleared.push(deviceId); this.targets = this.targets.filter((t) => t.deviceId !== deviceId); }
  get(id: string): Device | null { return this.devices.get(id) ?? null; }
}

// ---------------------------------------------------------------------------------------------------------------
// Reports (for the deliveries tests, which only need `require`, but need real rows for the foreign key)

export const sha = (s: string): string => `sha-${s.length}`;

export class FakeReports {
  private readonly all = new Map<string, Report>();
  private counter = 0;
  constructor(private readonly db: Db) {}

  add(over: Partial<Report> = {}): Report {
    this.counter++;
    const id = over.id ?? `rep${String(this.counter).padStart(13, '0')}`;
    const body = over.body ?? '## Implementation Report\n\nWhat was done.\n\n<!-- mini-summa:report status=complete task="Fix login" -->';
    const report: Report = {
      id, projectId: null, projectName: null, sessionKey: KEY_A, env: 'win', sessionId: 'a1b2c3d4-1111-4111-8111-111111111111', generation: 1,
      taskTitle: 'Fix login', declaredStatus: 'complete', source: 'marker', capturedAt: '2026-10-30T09:59:00.000Z', late: false, read: false,
      chars: body.length, excerpt: body.slice(0, 40), delivery: null, promptId: 'p1', taskId: `${over.sessionKey ?? KEY_A}:p1`, cwd: 'C:\\dev\\gm',
      body, bodySha256: sha(body), stopHookActive: false, verified: false, note: 'The marker is a declaration written by the model.', deliveries: [], ...over,
    };
    this.db.run(
      `INSERT INTO reports (id, session_key, env, session_id, generation, project_id, project_name, prompt_id, task_id, task_title, declared_status, source,
                            body, body_sha256, cwd, late, stop_hook_active, captured_seq, note, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)`,
      [report.id, report.sessionKey, report.env, report.sessionId, report.generation, report.projectId, report.projectName, report.promptId, report.taskId,
        report.taskTitle, report.declaredStatus, report.source, report.body, report.bodySha256, report.cwd, report.note, report.capturedAt],
    );
    this.all.set(id, report);
    return report;
  }

  readonly require = (id: string): Report => {
    const r = this.all.get(id);
    if (!r) throw notFound('Report');
    return r;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Activity: the real service, with a log of what was asked of it

export function recordingActivity(env: Env): { service: ActivityService; recorded: ActivityInput[]; resolved: Parameters<ActivityService['resolve']>[] } {
  const real = createActivityService({ base: env.base, fullCounts: () => ({ unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 0 }) });
  const recorded: ActivityInput[] = [];
  const resolved: Parameters<ActivityService['resolve']>[] = [];
  const service: ActivityService = {
    ...real,
    record: (input) => { recorded.push(input); return real.record(input); },
    resolve: (...args) => { resolved.push(args); return real.resolve(...args); },
  };
  return { service, recorded, resolved };
}

export const activityEvent = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'drv_1', at: '2026-10-30T10:00:00.000Z', projectId: null, projectName: null, source: 'claude', sessionKey: null, type: 'report_ready', severity: 'attention',
  title: 'Report ready: Fix login', description: null, requiresAction: true, resolvedAt: null, links: [], read: false, ...over,
});

export const notifyHint = (over: Partial<NotifyHint> = {}): NotifyHint => ({
  kind: 'report', projectId: null, urgency: 'normal', target: { view: 'reports' } satisfies NavigationTarget, dedupeKey: 'drv_1', ...over,
});

export const pendingActionIds = (events: ServerEvent[]): { id: string; status: PendingAction['status'] }[] =>
  events.flatMap((e) => (e.type === 'action.upserted' ? [{ id: e.action.id, status: e.action.status }] : []));

/** True when the text contains an em dash anywhere (a product rule: no user-visible string may). */
export const hasEmDash = (value: unknown): boolean => JSON.stringify(value).includes('\u2014');

export const flush = async (times = 5): Promise<void> => { for (let i = 0; i < times; i++) await Promise.resolve(); };
