// Internal contracts of the core. Modules are written against these interfaces, not against each other's classes.
// Workers own disjoint directories (claude/, workflow/, infra/); this file is owned by the architect. If a contract
// has to change, change it here first and tell the owners of the modules that depend on it.
import type {
  ActivityEvent, ActivitySeverity, ActivitySource, ActivityType, ActorRef, ChatGptOpenResult, Conversation, ConversationVerification,
  Counts, DataUsage, DeclaredStatus, Delivery, DeliveryDetail, DeliveryPrepared, Device, DevicePlatform, DiscoveryRefreshResult, EnvId,
  EnvironmentInfo, HookPlan, HookStatus, LinkTarget, ListPage, NativeBridge, NavigationTarget, NotificationRecord, PairingOffer,
  PairingRedeemResult, PendingAction, Project, ProjectNotificationPrefs, ProjectResolution, Report, ReportCandidate, ReportSummary,
  ReviewState, Scope, ServerEvent, SessionKey, SessionState, SessionView, Settings, SettingsPatch, TailscaleStatus, TargetCheck, Topic,
} from '@minisumma/shared';
import type { Db } from '@minisumma/storage';

// ---------------------------------------------------------------------------------------------------------------
// Plumbing

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export const nowIso = (clock: Clock): string => clock.now().toISOString();

/** In-process pub/sub with numbered events and a bounded replay buffer. Implemented in bus.ts. */
export interface EventBus {
  /** Publishes the event, assigns the next sequence number and returns it. */
  emit(event: ServerEvent): number;
  subscribe(fn: (seq: number, event: ServerEvent, topic: Topic) => void): () => void;
  readonly seq: number;
  /** Events after `seq`, or null when the buffer no longer reaches back that far (client must resync). */
  since(seq: number): { seq: number; event: ServerEvent }[] | null;
}

/** Everything a service may be handed. Services never reach for globals. */
export interface CoreBase {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  version: string;
  mode: 'embedded' | 'headless';
  /** Root of all runtime data (database, spools, managed settings, logs). Never inside a repository. */
  dataDir: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings and projects  (infra/)

export interface SettingsService {
  get(): Settings;
  update(patch: SettingsPatch): Settings;
  onChange(fn: (next: Settings, prev: Settings) => void): () => void;
}

/** The verified matcher from @minisumma/claude-integration (`createRegistry`). Resolves a directory to a project. */
export interface ProjectRegistry {
  defaultEnv: EnvId;
  resolve(cwd: string, env?: EnvId): {
    project: { id: string; name: string } | null;
    reason: 'matched' | 'unregistered_directory' | 'ambiguous' | 'no_cwd';
    canonical?: { fs: string; path: string };
    candidates?: string[];
  };
}

export interface ProjectCreateInput {
  name: string;
  description?: string | null;
  githubRepo?: string | null;
  defaultEnv?: EnvId;
  roots?: { path: string; env?: EnvId; label?: string | null }[];
}

export interface ProjectsService {
  list(opts?: { includeArchived?: boolean }): Project[];
  get(id: string): Project | null;
  /** Throws CoreError(404) when missing. */
  require(id: string): Project;
  create(input: ProjectCreateInput): Project;
  update(id: string, patch: { name?: string; description?: string | null; githubRepo?: string | null; defaultEnv?: EnvId; notificationPrefs?: Partial<ProjectNotificationPrefs>; archived?: boolean }): Project;
  /** archive keeps all history; delete removes the project and everything attached to it, in one transaction. */
  remove(id: string, mode: 'archive' | 'delete'): void;
  reorder(ids: string[]): void;
  addRoot(projectId: string, input: { path: string; env?: EnvId; label?: string | null }): Project;
  removeRoot(projectId: string, rootId: string): Project;
  /** Used by sessions for default-session bookkeeping. */
  setDefaultSession(projectId: string, key: SessionKey | null): Project;

  conversations: {
    list(projectId: string): Conversation[];
    get(id: string): Conversation | null;
    require(id: string): Conversation;
    add(projectId: string, input: { url: string; title?: string; note?: string | null; makePreferred?: boolean }): Conversation;
    update(id: string, patch: { url?: string; title?: string; note?: string | null }): Conversation;
    remove(id: string): void;
    setPreferred(projectId: string, conversationId: string | null): Project;
    setVerification(id: string, result: { verification: ConversationVerification; title?: string | null }): Conversation;
  };

  /** Current matcher. Rebuilt after any change to project roots; callers must not cache it across `onRootsChanged`. */
  registry(): ProjectRegistry;
  /** Registry file consumed by the hook process (`--registry`). Rewritten on every root change. */
  registryFileContents(): { defaultEnv: EnvId; projects: { id: string; name: string; roots: { path: string; env: EnvId }[] }[] };
  onRootsChanged(fn: () => void): () => void;
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code layer  (claude/)

/** Result of a final-message capture as produced by the verified reducer, attributed by the sessions layer. */
export interface CapturedReport {
  reportId: string;
  sessionKey: SessionKey;
  env: EnvId;
  sessionId: string;
  generation: number;
  /** Attribution: managed/manual binding first, registry match otherwise. */
  projectId: string | null;
  projectName: string | null;
  cwd: string | null;
  promptId: string | null;
  taskId: string;
  taskTitle: string;
  declaredStatus: DeclaredStatus;
  body: string;
  bodySha256: string;
  stopHookActive: boolean;
  late: boolean;
  capturedSeq: number;
  note: string;
  capturedAt: string;
  /** From the hook's transport metadata (additive, default 0): strings redacted / truncated at capture. */
  redactions?: number;
  truncations?: number;
}

export interface CapturedCandidate {
  candidateId: string;
  sessionKey: SessionKey;
  env: EnvId;
  sessionId: string;
  generation: number;
  projectId: string | null;
  projectName: string | null;
  promptId: string | null;
  reason: string;
  declaredStatus: DeclaredStatus | null;
  taskTitle: string | null;
  body: string;
  bodySha256: string;
  late: boolean;
  capturedAt: string;
  redactions?: number;
  truncations?: number;
}

/** Reducer-derived event, forwarded with the attribution the sessions layer settled on. */
export interface ClaudeDerivedEvent {
  /** Stable id of the derived event (`derived_id` from the reducer). Replays reproduce the same ids. */
  derivedId: string;
  kind: 'transition' | 'generation' | 'late_event' | 'unresolved_ordering' | 'report_ready' | 'report_duplicate' | 'session_discovered' | 'unhandled_event';
  sessionKey: SessionKey;
  generation: number;
  from?: SessionState | null;
  to?: SessionState | null;
  evidence?: string;
  text?: string;
  notify: boolean;
  requiresUser: boolean;
  abnormal?: boolean;
  /** For permission prompts: tool name and a redacted excerpt of the tool input, if the hook supplied them. */
  permission?: { toolName: string | null; inputExcerpt: string | null } | null;
  rawSeq: number | null;
  reportId?: string;
  at: string;
  /** true while replaying history at startup: handlers must not notify for these. */
  replay: boolean;
}

export interface ClaudeEventHandlers {
  /** A session's view changed (any field). Called after the change was persisted and emitted on the bus. */
  onSession?(view: SessionView, previous: SessionView | null): void;
  onDerived?(event: ClaudeDerivedEvent, view: SessionView): void;
  onReport?(report: CapturedReport): void;
  onCandidate?(candidate: CapturedCandidate): void;
}

export interface TerminalSink {
  data(seq: number, data: string): void;
  exit(info: { code: number | null; signal: number | null; at: string; reason: string }): void;
}

export interface TerminalAttachment {
  replay: string;
  seq: number;
  cols: number;
  rows: number;
  detach(): void;
}

export interface StartSessionRequest {
  mode: 'new' | 'resume';
  resumeKey?: SessionKey;
  env?: EnvId;
  rootId?: string;
  name?: string;
  remoteControl?: boolean;
  cols?: number;
  rows?: number;
  /** Optional conversation that receives this session's reports (overrides the project's preferred one). */
  conversationId?: string | null;
}

export type TypeIntoResult = { ok: true; submitted: boolean } | { ok: false; code: 'not_managed' | 'not_live' | 'generation_changed' | 'state_not_allowed' | 'no_terminal'; problem: string };

export interface SessionsService {
  list(opts?: { projectId?: string; includeEnded?: boolean }): SessionView[];
  get(key: SessionKey): SessionView | null;
  start(projectId: string, req: StartSessionRequest, actor: ActorRef): Promise<SessionView>;
  /** Graceful by default (Ctrl-C then exit); `force` kills the PTY process. Only for managed sessions. */
  stop(key: SessionKey, opts: { force?: boolean }): Promise<SessionView>;
  /** Manual attribution of an external or unregistered session. null clears the manual binding. */
  bind(key: SessionKey, projectId: string | null): SessionView;
  setDefault(key: SessionKey, isDefault: boolean): Project;
  /** Explicit conversation a session reports to, if one was chosen for it. Never inferred. */
  conversationBinding(key: SessionKey): string | null;
  refreshDiscovery(env?: EnvId): Promise<DiscoveryRefreshResult>;
  discoveryStatus(): { env: EnvId; ok: boolean; lastRunAt: string | null; error: string | null }[];

  /** Would typing into this session be safe right now? Never throws; reports the problem in words. */
  targetCheck(key: SessionKey, expectGeneration: number | null): TargetCheck;
  /** Type user-authored text into a verified managed session. Re-verifies the target at call time. */
  typeInto(key: SessionKey, req: { text: string; submit: boolean; expectGeneration: number | null; allowedStates: SessionState[] }): Promise<TypeIntoResult>;
  /** Answer a pending permission prompt of a managed session with the keystrokes Claude Code expects. */
  answerPermission(key: SessionKey, decision: 'approve' | 'reject', expectGeneration: number | null): Promise<TypeIntoResult>;

  terminal: {
    attach(key: SessionKey, size: { cols: number; rows: number }, sink: TerminalSink): TerminalAttachment | { error: string };
    input(key: SessionKey, data: string): boolean;
    resize(key: SessionKey, cols: number, rows: number): void;
  };

  subscribe(handlers: ClaudeEventHandlers): () => void;
  /** Loads persisted state, replays the raw log, starts polling/watching. Safe to call once. */
  init(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ManagedSessionRecord {
  key: SessionKey;
  env: EnvId;
  sessionId: string;
  projectId: string | null;
  rootId: string | null;
  cwd: string;
  name: string | null;
  mode: 'new' | 'resume';
  resumedFrom: SessionKey | null;
  remoteControl: boolean;
  status: 'running' | 'exited' | 'disconnected';
  pid: number | null;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  exitSignal: number | null;
  exitReason: string | null;
  cols: number;
  rows: number;
  /** True once a prompt was submitted, i.e. Claude saved a transcript and `--resume` can work. */
  prompted: boolean;
  lastOutputAt: string | null;
  /** Which run of the app started it. A record from an earlier run can no longer have a live PTY. */
  appRunId: string;
  /** Explicit conversation chosen for this session's reports (session_bindings.conversation_id). */
  conversationId: string | null;
}

export interface ManagedStartInput {
  projectId: string;
  rootId: string | null;
  env: EnvId;
  cwd: string;
  name: string | null;
  remoteControl: boolean;
  cols: number;
  rows: number;
  mode: 'new' | 'resume';
  /** For resume: the session id to resume (same environment). */
  resumeSessionId?: string;
  conversationId: string | null;
}

/**
 * Sessions Mini-Summa starts in its own terminals. Owns the PTYs, the per-session settings file that gives the session
 * hooks, the managed_sessions rows and the managed rows in session_bindings. Never decides what a session means:
 * session state comes from hooks and discovery through the reducer, not from terminal output.
 */
export interface ManagedManager {
  /** Marks records from earlier runs as disconnected (their PTYs died with the old process). */
  init(): void;
  list(): ManagedSessionRecord[];
  get(key: SessionKey): ManagedSessionRecord | null;
  start(input: ManagedStartInput): Promise<ManagedSessionRecord>;
  stop(key: SessionKey, opts: { force?: boolean }): Promise<ManagedSessionRecord>;
  /** Raw bytes typed by the user at the desktop terminal. */
  write(key: SessionKey, data: string): boolean;
  /** Programmatic user-authored text: bracketed paste for multi-line text, Enter only when `submit` is true. */
  typeText(key: SessionKey, text: string, opts: { submit: boolean }): Promise<boolean>;
  /** Keystrokes that answer Claude Code's permission dialog. */
  sendKeys(key: SessionKey, keys: 'approve' | 'reject'): Promise<boolean>;
  resize(key: SessionKey, cols: number, rows: number): void;
  attach(key: SessionKey, size: { cols: number; rows: number }, sink: TerminalSink): TerminalAttachment | { error: string };
  markPrompted(key: SessionKey): void;
  onChange(fn: (record: ManagedSessionRecord, previous: ManagedSessionRecord | null) => void): () => void;
  /** App exit: ends every PTY and records why. Does not claim the sessions survive. */
  shutdown(): Promise<void>;
}

export interface EnvLayout {
  env: EnvId;
  /** Directories as the core process sees them. */
  spoolDirHost: string;
  registryFileHost: string;
  /** The same locations as a hook process running inside `env` sees them (for WSL these are /mnt/<drive>/... paths). */
  spoolDirInEnv: string;
  registryFileInEnv: string;
  captureScriptInEnv: string;
  /** Node runtime that executes the capture script inside `env`. null = none found; hooks cannot run there. */
  runtime: { command: string; runAsNode: boolean; version: string | null } | null;
  /** Claude configuration directory as the core sees it, and as Claude inside `env` sees it. null = unknown. */
  configDirHost: string | null;
  configDirInEnv: string | null;
}

export interface EnvironmentsService {
  /** Where the core itself runs. */
  hostEnv(): EnvId;
  list(opts?: { refresh?: boolean }): Promise<EnvironmentInfo[]>;
  /** Resolve the layout for one environment (cached; refreshed with list({refresh:true})). */
  layout(env: EnvId): Promise<EnvLayout>;
  /** Directory where `claude` for this env can be started from the core: executable plus any wrapper arguments. */
  claudeCommand(env: EnvId): Promise<{ file: string; prefixArgs: string[]; wslDistro: string | null } | null>;
}

// ---------------------------------------------------------------------------------------------------------------
// Workflow  (workflow/)

export interface ActivityInput {
  /** Stable id from the cause (for derived Claude events: `drv_<derivedId>`). Recording the same id twice is a no-op. */
  id: string;
  at?: string;
  projectId: string | null;
  projectName?: string | null;
  source: ActivitySource;
  sessionKey?: SessionKey | null;
  type: ActivityType;
  severity: ActivitySeverity;
  title: string;
  description?: string | null;
  requiresAction?: boolean;
  links?: LinkTarget[];
}

export interface ActivityService {
  record(input: ActivityInput): { activity: ActivityEvent; created: boolean };
  get(id: string): ActivityEvent | null;
  /** Mark activity as handled (clears "needs action" in the UI) without marking it read. */
  resolve(match: { ids?: string[]; sessionKey?: SessionKey; types?: ActivityType[]; link?: LinkTarget }, at?: string): number;
  list(q: { projectId?: string; type?: string; unread?: boolean; requiresAction?: boolean; limit?: number; before?: string }): ListPage<ActivityEvent>;
  markRead(req: { ids?: string[]; all?: boolean; projectId?: string }): Pick<Counts, 'unreadActivity' | 'actionsNeeded'>;
  counts(): Pick<Counts, 'unreadActivity' | 'actionsNeeded'>;
  prune(olderThanIso: string): number;
}

export interface NotifyHint {
  kind: 'permission' | 'input' | 'error' | 'report' | 'sessionEnded' | 'presenceLost' | 'info';
  projectId: string | null;
  sessionKey?: SessionKey | null;
  urgency: 'normal' | 'critical';
  target: NavigationTarget;
  /** Same key = same thing. A second consider() with a key already notified is suppressed as a duplicate. */
  dedupeKey: string;
}

export interface PushPayload {
  /** Minimal by design: no report bodies, no tool inputs, no paths. */
  title: string;
  body: string;
  data: { kind: NotifyHint['kind']; projectId: string | null; sessionKey?: string; reportId?: string; activityId: string };
}

export interface PushProvider {
  readonly name: 'fcm';
  configured(): boolean;
  /** Validates and stores the user's Firebase service account (0600, outside the repo). Throws CoreError(400) if invalid. */
  configureFromJson(json: string): { firebaseProject: string };
  clear(): void;
  send(targets: { deviceId: string; token: string }[], payload: PushPayload): Promise<{ deviceId: string; result: 'sent' | 'failed' | 'invalid_token'; error?: string }[]>;
}

export interface NotificationsService {
  /** Applies the master switch, per-project preferences, quiet mode and dedupe, then notifies native and push. */
  consider(activity: ActivityEvent, hint: NotifyHint): Promise<NotificationRecord | null>;
  list(limit?: number): NotificationRecord[];
  /** Sends a clearly marked test push to every paired device that can receive one. */
  sendTest(): Promise<{ sent: number; failed: number; skipped: string | null }>;
  prune(olderThanIso: string): number;
}

export interface ReportsService {
  /** Idempotent by reportId: a replay or duplicate hook never creates a second report. */
  capture(r: CapturedReport): { report: ReportSummary; created: boolean };
  captureCandidate(c: CapturedCandidate): { created: boolean };
  list(q: { projectId?: string; unread?: boolean; limit?: number; before?: string }): ListPage<ReportSummary>;
  get(id: string): Report | null;
  require(id: string): Report;
  summary(id: string): ReportSummary | null;
  markRead(id: string): ReportSummary;
  listCandidates(q: { projectId?: string; includePromoted?: boolean }): ReportCandidate[];
  promote(candidateId: string): Report;
  prune(olderThanIso: string): number;
}

export interface DeliveriesService {
  /** Called once per newly captured report. Creates the delivery, freezes the destination, sets the honest state. */
  onReportCaptured(report: ReportSummary): Delivery;
  list(q: { projectId?: string; reportId?: string; open?: boolean }): Delivery[];
  get(id: string): DeliveryDetail | null;
  create(reportId: string, req: { conversationId?: string; includeReviewRequest?: boolean }, actor: ActorRef): Delivery;
  prepare(id: string, actor: ActorRef): DeliveryPrepared;
  part(id: string, index: number): { index: number; total: number; text: string; sha256: string };
  copy(id: string, part: number | undefined, actor: ActorRef): Promise<{ delivery: Delivery; part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null }>;
  open(id: string, actor: ActorRef): Promise<{ delivery: Delivery; open: ChatGptOpenResult }>;
  handoff(id: string, part: number | undefined, actor: ActorRef): Promise<{ delivery: Delivery; part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null; open: ChatGptOpenResult }>;
  confirmSent(id: string, note: string | undefined, actor: ActorRef): Delivery;
  markUncertain(id: string, note: string | undefined, actor: ActorRef): Delivery;
  discard(id: string, note: string | undefined, actor: ActorRef): Delivery;
  reopen(id: string, note: string | undefined, actor: ActorRef): Delivery;
  setDestination(id: string, conversationId: string, actor: ActorRef): Delivery;
  setReview(id: string, review: ReviewState, followUpDraft: string | null | undefined, actor: ActorRef): Delivery;
  saveFile(id: string, actor: ActorRef): Promise<{ delivery: Delivery; path: string | null }>;
  /** Called when an action created from this delivery's follow-up draft was typed into Claude. */
  markFollowUpSent(deliveryId: string, actionId: string): Delivery | null;
  /** Startup: nothing is auto-advanced. Deliveries stay exactly where the user left them; a restart event is logged. */
  recoverAfterRestart(): void;
  prune(olderThanIso: string): number;
}

export interface ActionsService {
  /**
   * Create a user-authored prompt for a managed session. A desktop actor's click is itself the approval and the
   * action executes at once; a paired device's prompt waits for approval unless that device is trusted.
   * Re-verifies the target (managed, live, same generation, state that accepts input) before typing.
   */
  createPrompt(input: { sessionKey: SessionKey; text: string; expectGeneration?: number; reportId?: string; deliveryId?: string; actor: ActorRef; submit?: boolean }): Promise<PendingAction>;
  /** Called by the glue when a managed session enters needs_permission. Idempotent by correlationKey. */
  raisePermission(input: { sessionKey: SessionKey; generation: number; summary: string; correlationKey: string; projectId: string | null }): PendingAction | null;
  /** Called when a session leaves needs_permission or ends: open permission actions become superseded. */
  supersedeOpenFor(sessionKey: SessionKey, reason: string): void;
  approve(id: string, actor: ActorRef): Promise<PendingAction>;
  reject(id: string, actor: ActorRef, reason?: string): PendingAction;
  list(q: { status?: 'pending' | 'open' | 'all'; projectId?: string }): PendingAction[];
  get(id: string): PendingAction | null;
  /** Expire overdue pending actions. Called by a timer in init(). */
  expireDue(): number;
  init(): void;
  shutdown(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Devices, remote access, hooks  (infra/)

/** Who is calling. Produced by token authentication and attached to every request and WebSocket. */
export interface Principal {
  kind: 'desktop' | 'device' | 'extension';
  deviceId: string | null;
  name: string;
  scopes: Scope[];
  trusted: boolean;
  via: 'tailscale' | 'localhost' | 'unknown';
}

export interface DevicesService {
  /** The desktop shell's token, generated at startup and kept only in memory (a hash is compared). */
  readonly desktopToken: string;
  authenticate(token: string, via: Principal['via']): Principal | null;
  createOffer(scopes: Scope[], urls: string[], kind: 'phone' | 'extension'): PairingOffer;
  redeem(req: { offerId: string; code: string; deviceName: string; platform: Exclude<DevicePlatform, 'desktop'> }, via: Principal['via']): PairingRedeemResult;
  list(): Device[];
  get(id: string): Device | null;
  update(id: string, patch: { name?: string; trusted?: boolean; scopes?: Scope[] }): Device;
  revoke(id: string): void;
  registerPush(deviceId: string, provider: 'fcm', token: string): void;
  clearPushToken(deviceId: string): void;
  pushTargets(): { deviceId: string; provider: 'fcm'; token: string; projectIds: 'all' }[];
  actorOf(principal: Principal): ActorRef;
}

export interface HooksService {
  list(): Promise<HookStatus[]>;
  status(env: EnvId): Promise<HookStatus>;
  plan(env: EnvId, action: 'install' | 'uninstall'): Promise<HookPlan>;
  /** Applies exactly the plan identified by planHash; refuses (409) if the file changed since the plan was shown. */
  apply(env: EnvId, action: 'install' | 'uninstall', planHash: string): Promise<HookStatus>;
}

export interface TailscaleService {
  status(opts?: { refresh?: boolean }): Promise<TailscaleStatus>;
  setServe(enabled: boolean): Promise<TailscaleStatus>;
  /** Public base URL phones should use (the Serve URL) or null. */
  publicUrl(): string | null;
  init(): void;
  shutdown(): void;
}

export interface ExtensionBridge {
  connected(): boolean;
  /** Ask a connected extension to focus or open the URL. Resolves with what actually happened. */
  openOrFocus(url: string): Promise<ChatGptOpenResult>;
}

export interface DataService {
  usage(): DataUsage;
  prune(opts: { dryRun?: boolean }): { dryRun: boolean; removed: { rawEvents: number; activity: number; notifications: number; reports: number; deliveries: number } };
}

// ---------------------------------------------------------------------------------------------------------------
// Composition

export interface CoreOptions {
  dataDir: string;
  mode: 'embedded' | 'headless';
  version: string;
  /** Host capabilities. Default: everything unavailable (headless). */
  native?: NativeBridge;
  /** 127.0.0.1 port. 0 picks a free one. */
  port?: number;
  /** Directory with the built renderer, served under /ui/. */
  uiDir?: string;
  clock?: Clock;
  log?: Logger;
  /** Test and packaging seams. Production leaves all of these undefined. */
  overrides?: {
    claudeBin?: string;
    nodeRuntime?: { command: string; runAsNode: boolean };
    captureScript?: string;
    tailscaleBin?: string;
    hostEnv?: EnvId;
    discoveryIntervalMs?: number;
    spoolPollMs?: number;
    pushEndpoint?: string;
    homeDir?: string;
  };
}

export interface Core {
  readonly baseUrl: string;
  readonly desktopToken: string;
  readonly base: CoreBase;
  readonly services: {
    settings: SettingsService; projects: ProjectsService; sessions: SessionsService; environments: EnvironmentsService;
    activity: ActivityService; notifications: NotificationsService; reports: ReportsService; deliveries: DeliveriesService;
    actions: ActionsService; devices: DevicesService; hooks: HooksService; tailscale: TailscaleService; data: DataService;
  };
  counts(): Counts;
  start(): Promise<void>;
  stop(): Promise<void>;
}
