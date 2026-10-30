// Domain entities shared by the core service, the desktop renderer, the browser extension and the Android app.
// These are the shapes that cross the API; storage rows are mapped to and from them inside @minisumma/storage.
import type { EnvId, SessionKey } from './env.ts';

export type Iso = string;

// ---------------------------------------------------------------------------------------------------------------
// Projects and ChatGPT conversations

export interface ProjectNotificationPrefs {
  /** Master switch for this project. When false nothing is notified, but the activity feed still records events. */
  enabled: boolean;
  permission: boolean;
  input: boolean;
  error: boolean;
  report: boolean;
  sessionEnded: boolean;
  presenceLost: boolean;
  /** Also send a push notification to paired phones. */
  push: boolean;
}

export interface ProjectRoot {
  id: string;
  projectId: string;
  env: EnvId;
  /** Absolute path in the namespace of `env` (Windows path, WSL path or POSIX path). */
  path: string;
  label: string | null;
  position: number;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  /** `owner/repo` on GitHub, if the user entered one. Display only. */
  githubRepo: string | null;
  roots: ProjectRoot[];
  /** Environment used for new managed sessions unless a root says otherwise. */
  defaultEnv: EnvId;
  preferredConversationId: string | null;
  /** Session that receives "send to Claude" actions by default. Never inferred from focus. */
  defaultSessionKey: SessionKey | null;
  notificationPrefs: ProjectNotificationPrefs;
  sortOrder: number;
  archivedAt: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export type ChatGptUrlKind = 'chat' | 'project_chat' | 'gpt_chat' | 'project' | 'other';

/** Outcome of the last attempt to confirm that a stored URL still opens the intended conversation. */
export type ConversationVerification = 'unverified' | 'verified' | 'mismatch' | 'unreachable' | 'login_required';

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  /** Normalized URL (host chatgpt.com, no query or fragment). Opening and delivery use this value. */
  url: string;
  /** What the user pasted, kept for the audit trail. */
  originalUrl: string;
  kind: ChatGptUrlKind;
  /** The conversation uuid inside the URL, when there is one. */
  chatgptConversationId: string | null;
  verification: ConversationVerification;
  verifiedAt: Iso | null;
  /** Page title seen when verified. A hint for the human, never an identity. */
  verifiedTitle: string | null;
  note: string | null;
  position: number;
  createdAt: Iso;
  updatedAt: Iso;
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/** Where a session came from. This decides what Mini-Summa may do with it. */
export type SessionOrigin =
  /** Started by Mini-Summa in its own terminal (PTY). Input and resize are possible. */
  | 'managed'
  /** An interactive Claude Code session started elsewhere (any terminal). Observed only; never typed into. */
  | 'external'
  /** A background session (`claude agents` kind "background"). Observed only. */
  | 'background';

export type SessionAvailability =
  /** A live process serves this session right now (managed PTY alive, or discovery lists a live process). */
  | 'live'
  /** No live process, but the transcript is saved so Claude Code can resume it. */
  | 'resumable'
  /** Mini-Summa lost the terminal connection (for example the app restarted). The process may or may not exist. */
  | 'disconnected'
  /** The session ended and cannot be resumed (it never received a prompt, or Claude reported no transcript). */
  | 'ended';

/** States derived by the verified reducer. See packages/claude-integration/docs/DESIGN.md. */
export type SessionState =
  | 'unknown' | 'idle' | 'working' | 'needs_permission' | 'needs_input' | 'waiting_for_you' | 'turn_ended'
  | 'background_wait' | 'report_ready' | 'error' | 'ended' | 'presence_lost';

export type ProjectResolution = 'managed' | 'manual' | 'matched' | 'unregistered_directory' | 'ambiguous' | 'no_cwd';

export interface SessionTermination {
  /** observed: SessionEnd hook or a listed process that is verifiably dead. suspected: absent from a full listing. */
  kind: 'observed' | 'suspected';
  reason: string;
  at: Iso | null;
}

export type AttentionKind = 'permission' | 'input' | 'error' | 'report' | 'presence_lost' | 'abnormal_end';

export interface SessionView {
  key: SessionKey;
  env: EnvId;
  sessionId: string;
  origin: SessionOrigin;
  availability: SessionAvailability;
  termination: SessionTermination | null;
  /** True when `claude --resume` can bring this session back as a managed session. */
  resumable: boolean;
  projectId: string | null;
  projectName: string | null;
  projectResolution: ProjectResolution;
  cwd: string | null;
  /** Display name from `claude agents` or the name given at start. */
  name: string | null;
  state: SessionState;
  stateLabel: string;
  /** What the state was derived from, e.g. `hook:Stop`, `discovery`, `managed:pty`. */
  stateEvidence: string;
  generation: number;
  pid: number | null;
  startedAt: Iso | null;
  lastActivityAt: Iso | null;
  attention: { kind: AttentionKind; since: Iso | null } | null;
  /** Hook events whose order could not be established (kept visible, never guessed). */
  unresolvedOrdering: number;
  /** Only for managed sessions. */
  terminal: { cols: number; rows: number; exited: boolean } | null;
  isProjectDefault: boolean;
  remoteControl: { state: 'enabled' | 'not_enabled' | 'unknown'; hint: string };
}

export interface ManagedStartRequestInfo {
  mode: 'new' | 'resume';
  /** For resume: the key of the session to resume. */
  resumeKey?: SessionKey;
}

// ---------------------------------------------------------------------------------------------------------------
// Reports and ChatGPT delivery

export type DeclaredStatus = 'complete' | 'partial' | 'blocked';

export type DeliveryState =
  | 'report_captured'
  | 'destination_missing'
  | 'destination_unverified'
  | 'ready_for_handoff'
  | 'copied'
  | 'awaiting_user_send'
  | 'user_confirmed_sent'
  | 'delivery_uncertain'
  | 'user_discarded';

/**
 * Mini-Summa cannot read ChatGPT's answer by any supported means, so every step after "requested" is a statement
 * the user makes, never something detected.
 */
export type ReviewState = 'none' | 'requested' | 'received' | 'follow_up_drafted' | 'follow_up_sent' | 'closed';

export interface DeliverySummary {
  id: string;
  state: DeliveryState;
  review: ReviewState;
  destinationTitle: string | null;
  updatedAt: Iso;
}

export interface ReportSummary {
  id: string;
  projectId: string | null;
  projectName: string | null;
  sessionKey: SessionKey;
  env: EnvId;
  sessionId: string;
  generation: number;
  taskTitle: string;
  declaredStatus: DeclaredStatus;
  source: 'marker' | 'user_promoted';
  capturedAt: Iso;
  late: boolean;
  read: boolean;
  chars: number;
  excerpt: string;
  /** Latest delivery, if one exists. */
  delivery: DeliverySummary | null;
}

export interface Report extends ReportSummary {
  promptId: string | null;
  taskId: string;
  cwd: string | null;
  /** The complete final message, byte for byte as Claude produced it (after secret redaction at capture). */
  body: string;
  bodySha256: string;
  stopHookActive: boolean;
  /** Always false: the marker is a declaration by the model, not evidence the work succeeded. */
  verified: false;
  note: string;
  /** Credential-like strings replaced by [REDACTED] when the message was captured. Shown to the reader, never hidden. */
  redactions?: number;
  deliveries: DeliverySummary[];
}

/** A final message that did not satisfy the report protocol. Preserved, never discarded. */
export interface ReportCandidate {
  id: string;
  projectId: string | null;
  projectName: string | null;
  sessionKey: SessionKey;
  env: EnvId;
  sessionId: string;
  generation: number;
  promptId: string | null;
  reason: string;
  declaredStatus: DeclaredStatus | null;
  taskTitle: string | null;
  body: string;
  bodySha256: string;
  capturedAt: Iso;
  late: boolean;
  promoted: boolean;
  redactions?: number;
}

export type DeliveryResolution = 'session_binding' | 'project_preferred' | 'only_conversation' | 'user_selected';

/** The destination as it was when the delivery was created or explicitly re-pointed. Never follows focus. */
export interface FrozenDestination {
  conversationId: string;
  url: string;
  title: string;
  chatgptConversationId: string | null;
  resolvedFrom: DeliveryResolution;
  verificationAtFreeze: ConversationVerification;
  frozenAt: Iso;
}

export interface DeliveryPartInfo {
  index: number;
  total: number;
  chars: number;
  sha256: string;
  copiedAt: Iso | null;
}

export type ActorRef =
  | { kind: 'desktop' }
  | { kind: 'device'; deviceId: string; name: string }
  | { kind: 'system' };

export type DeliveryEventType =
  | 'created' | 'destination_resolved' | 'destination_changed' | 'destination_verified' | 'prepared'
  | 'part_copied' | 'destination_opened' | 'confirmed_sent' | 'marked_uncertain' | 'discarded' | 'reopened'
  | 'review_changed' | 'follow_up_drafted' | 'note';

export interface DeliveryEvent {
  id: string;
  deliveryId: string;
  at: Iso;
  type: DeliveryEventType;
  from: DeliveryState | null;
  to: DeliveryState | null;
  actor: ActorRef;
  detail: Record<string, unknown>;
}

export interface Delivery {
  id: string;
  reportId: string;
  projectId: string | null;
  projectName: string | null;
  sessionKey: SessionKey;
  taskTitle: string;
  state: DeliveryState;
  destination: FrozenDestination | null;
  review: ReviewState;
  includeReviewRequest: boolean;
  messageSha256: string | null;
  messageChars: number | null;
  parts: DeliveryPartInfo[];
  /** Text the user wrote or pasted for Claude after the review. A draft only, nothing is sent from it. */
  followUpDraft: string | null;
  attempts: number;
  lastError: string | null;
  stateChangedAt: Iso;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface DeliveryDetail extends Delivery {
  events: DeliveryEvent[];
}

export interface DeliveryPrepared {
  delivery: Delivery;
  /** Whole message, for display and for save-to-file. */
  message: string;
  partCount: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Activity feed and notifications

export type ActivitySource = 'claude' | 'discovery' | 'delivery' | 'review' | 'action' | 'device' | 'hooks' | 'system';

export type ActivityType =
  | 'session_started' | 'session_discovered' | 'session_resumed' | 'session_ended' | 'presence_lost'
  | 'needs_permission' | 'needs_input' | 'waiting_for_you' | 'turn_ended' | 'error' | 'report_ready'
  | 'delivery_state' | 'review_state' | 'action_pending' | 'action_result'
  | 'device_paired' | 'device_revoked' | 'hooks_changed' | 'system';

export type ActivitySeverity = 'info' | 'attention' | 'error';

export type LinkTarget =
  | { kind: 'project'; id: string }
  | { kind: 'session'; key: SessionKey }
  | { kind: 'report'; id: string }
  | { kind: 'delivery'; id: string }
  | { kind: 'conversation'; id: string }
  | { kind: 'action'; id: string }
  | { kind: 'settings'; section: string };

export interface ActivityEvent {
  /** Stable: derived from the cause, so replays and restarts never create a second entry. */
  id: string;
  at: Iso;
  projectId: string | null;
  projectName: string | null;
  source: ActivitySource;
  sessionKey: SessionKey | null;
  type: ActivityType;
  severity: ActivitySeverity;
  /** One readable line, written for a person. */
  title: string;
  description: string | null;
  requiresAction: boolean;
  /** Set when the thing that needed action has been handled. */
  resolvedAt: Iso | null;
  links: LinkTarget[];
  read: boolean;
}

export type NotificationChannelResult =
  | 'sent' | 'suppressed_quiet' | 'suppressed_project' | 'suppressed_duplicate' | 'suppressed_disabled'
  | 'unavailable' | 'failed' | 'not_applicable';

export interface NotificationRecord {
  id: string;
  activityId: string;
  projectId: string | null;
  at: Iso;
  title: string;
  body: string;
  native: NotificationChannelResult;
  push: NotificationChannelResult;
  readAt: Iso | null;
  target: NavigationTarget;
}

export interface NavigationTarget {
  view: 'workspace' | 'activity' | 'reports' | 'settings';
  projectId?: string;
  sessionKey?: SessionKey;
  reportId?: string;
  deliveryId?: string;
  activityId?: string;
  section?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Pending actions (human approval boundary)

/**
 * claude_prompt  user-authored text to be typed into one verified managed session
 * permission     a permission prompt in a managed session, answered with an explicit approve or reject
 */
export type PendingActionKind = 'claude_prompt' | 'permission';

export type PendingActionStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired' | 'superseded';

export interface TargetCheck {
  managed: boolean;
  live: boolean;
  generation: number | null;
  generationMatches: boolean;
  state: SessionState | null;
  /** Human-readable reason when the target does not qualify. */
  problem: string | null;
}

export interface PendingAction {
  id: string;
  kind: PendingActionKind;
  status: PendingActionStatus;
  projectId: string | null;
  projectName: string | null;
  sessionKey: SessionKey;
  /** Generation of the session when the action was created. Execution refuses a different generation. */
  generation: number;
  /** claude_prompt: the exact text that will be typed. permission: null. */
  text: string | null;
  /** permission: tool and redacted input excerpt. claude_prompt: first line of the text. */
  summary: string;
  reportId: string | null;
  deliveryId: string | null;
  createdAt: Iso;
  createdBy: ActorRef;
  /** Who may approve: an action created from a phone is not approved by that same phone unless it is trusted. */
  approvableBy: 'desktop' | 'desktop_or_other_device' | 'any_approver';
  decidedAt: Iso | null;
  decidedBy: ActorRef | null;
  executedAt: Iso | null;
  failure: string | null;
  expiresAt: Iso;
  target: TargetCheck;
}

// ---------------------------------------------------------------------------------------------------------------
// Devices, pairing, remote access

export type Scope = 'desktop' | 'read' | 'notify' | 'prompt' | 'approve' | 'extension';

export type DevicePlatform = 'android' | 'ios' | 'extension' | 'desktop' | 'other';

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  scopes: Scope[];
  /** When true, prompts from this device run without a second approval. Off unless the user enables it. */
  trusted: boolean;
  pushRegistered: boolean;
  createdAt: Iso;
  lastSeenAt: Iso | null;
  lastSeenVia: 'tailscale' | 'localhost' | 'unknown' | null;
  revokedAt: Iso | null;
}

export interface PairingOffer {
  id: string;
  /** One-time secret, shown once as a QR code. The core stores only a hash. */
  code: string;
  expiresAt: Iso;
  scopes: Scope[];
  /** Base URLs a phone may try, best first. */
  urls: string[];
  /** Value encoded in the QR code. See pairing.ts. */
  qrPayload: string;
}

export interface PairingRedeemResult {
  device: Device;
  /** Bearer token, returned exactly once. */
  token: string;
  server: { name: string; apiVersion: number };
}

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  loggedIn: boolean;
  backendState: string | null;
  hostName: string | null;
  dnsName: string | null;
  tailnet: string | null;
  tailscaleIps: string[];
  /** Whether `tailscale serve` currently publishes the Mini-Summa port. Funnel is never used. */
  serve: { configured: boolean; url: string | null; target: string | null; funnelDetected: boolean };
  checkedAt: Iso;
  /** Plain-language explanation when something blocks remote access. */
  problem: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks, environments, settings

export interface HookStatus {
  env: EnvId;
  configDir: string;
  settingsPath: string;
  settingsExists: boolean;
  installed: boolean;
  /** Events that carry the Mini-Summa handler. */
  events: string[];
  missingEvents: string[];
  duplicateRegistrations: boolean;
  runtime: { command: string; kind: 'node' | 'electron' | 'missing'; version: string | null };
  captureScript: string;
  issues: string[];
}

export interface HookPlan {
  env: EnvId;
  settingsPath: string;
  /** Digest of the exact before/after pair. `apply` must present it, so consent applies to this diff only. */
  planHash: string;
  action: 'install' | 'uninstall' | 'noop';
  before: string;
  after: string;
  unifiedDiff: string;
  backupPath: string;
  warnings: string[];
  status: HookStatus;
}

export interface EnvironmentInfo {
  id: EnvId;
  label: string;
  available: boolean;
  claude: { path: string | null; version: string | null; error: string | null };
  node: { path: string | null; version: string | null };
  configDir: string | null;
  hooks: HookStatus | null;
  notes: string[];
}

export type LayoutOrientation = 'auto' | 'landscape' | 'portrait';

export interface LayoutPrefs {
  orientation: LayoutOrientation;
  /** Share of the workspace given to ChatGPT, 0.15 to 0.85. Kept separately per orientation. */
  landscapeRatio: number;
  portraitRatio: number;
  maximized: null | 'chatgpt' | 'claude';
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

export interface QuietMode {
  /** Manual "do not disturb". */
  enabled: boolean;
  until: Iso | null;
  /** Optional daily window, local time, 24h `HH:MM`. */
  schedule: { enabled: boolean; from: string; to: string };
}

export interface RetentionSettings {
  /** Raw hook and discovery log. Pruning removes replay history for sessions older than this. 0 = keep. */
  rawEventsDays: number;
  activityDays: number;
  notificationsDays: number;
  /** Reports and deliveries are kept unless the user asks otherwise. 0 = keep. */
  reportsDays: number;
}

export interface Settings {
  chatgpt: {
    mode: 'embedded' | 'external';
    /** How external mode finds the browser: the default browser, or the optional extension that can focus a tab. */
    externalBrowser: 'default' | 'extension';
  };
  layout: LayoutPrefs;
  notifications: {
    native: boolean;
    quiet: QuietMode;
    defaults: ProjectNotificationPrefs;
  };
  review: {
    requestTemplate: string;
    includeSessionRef: boolean;
    maxPartChars: number;
  };
  sessions: {
    discoveryIntervalSec: number;
    /** Start new managed sessions with Anthropic Remote Control enabled. */
    remoteControlByDefault: boolean;
    claudeCommand: string | null;
  };
  mobile: {
    remoteAccess: 'off' | 'tailscale';
    push: { provider: 'none' | 'fcm'; configured: boolean };
    promptActionTtlMinutes: number;
  };
  retention: RetentionSettings;
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type SettingsPatch = DeepPartial<Settings>;

// ---------------------------------------------------------------------------------------------------------------
// System

export interface SystemInfo {
  name: 'mini-summa-core';
  version: string;
  apiVersion: number;
  mode: 'embedded' | 'headless';
  platform: string;
  startedAt: Iso;
  nativeCapabilities: NativeCapabilities;
}

export interface NativeCapabilities {
  clipboard: boolean;
  chatgptEmbedded: boolean;
  extensionBridge: boolean;
  notifications: boolean;
  openExternal: boolean;
  saveFile: boolean;
}

export interface Counts {
  unreadActivity: number;
  actionsNeeded: number;
  pendingActions: number;
  reportsAwaitingHandoff: number;
  liveSessions: number;
}

export interface StateSnapshot {
  /** Event sequence number at the moment the snapshot was taken. Apply only events with a higher seq on top of it. */
  seq: number;
  system: SystemInfo;
  projects: Project[];
  conversations: Conversation[];
  sessions: SessionView[];
  counts: Counts;
  settings: Settings;
}

export interface DataUsage {
  dataDir: string;
  databaseBytes: number;
  rawEvents: number;
  activity: number;
  reports: number;
  deliveries: number;
  notifications: number;
  oldestRawEventAt: Iso | null;
}
