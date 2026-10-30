// The words and small calculations of the settings screens. Pure, so they are tested without React.
import { buildReportMessage, envLabel } from '@minisumma/shared';
import type { ChatGptViewState, Device, DevicePlatform, HookStatus, ProjectNotificationPrefs, PruneResult, QuietMode, RetentionSettings, Scope, TailscaleStatus } from '@minisumma/shared';

// ---------------------------------------------------------------------------------------------------------------
// Devices and what they may do

export const GRANTABLE_SCOPES = ['read', 'notify', 'prompt', 'approve'] as const;
export type GrantableScope = (typeof GRANTABLE_SCOPES)[number];

export const SCOPE_WORDS: Record<Scope, { label: string; description: string }> = {
  desktop: { label: 'Full control', description: 'Everything this PC can do. Only Mini-Summa itself has it.' },
  read: { label: 'Read', description: 'See your projects, sessions, reports and activity.' },
  notify: { label: 'Notify', description: 'Get notifications, including when Mini-Summa is closed on the phone.' },
  prompt: { label: 'Prompt', description: 'Ask for a prompt to be typed into a Claude session that Mini-Summa started. You approve it on this PC unless the device is trusted.' },
  approve: { label: 'Approve', description: 'Approve or reject permission requests and prompts that come from other devices.' },
  extension: { label: 'Browser tab', description: 'Focus or open the ChatGPT tab. Nothing else.' },
};

export function scopesInWords(scopes: readonly Scope[]): string {
  if (scopes.length === 0) return 'No permissions';
  return scopes.map((s) => SCOPE_WORDS[s].label.toLowerCase()).join(', ').replace(/^./, (c) => c.toUpperCase());
}

export const PLATFORM_WORDS: Record<DevicePlatform, string> = { android: 'Android device', ios: 'iPhone or iPad', extension: 'Browser extension', desktop: 'Desktop', other: 'Device' };

const VIA: Record<NonNullable<Device['lastSeenVia']>, string> = { tailscale: 'over Tailscale', localhost: 'on this PC', unknown: 'from an unknown route' };

export function lastSeenWords(device: Pick<Device, 'lastSeenAt' | 'lastSeenVia' | 'revokedAt'>, ago: (iso: string) => string): string {
  if (device.revokedAt) return `Revoked ${ago(device.revokedAt)}`;
  if (!device.lastSeenAt) return 'Not connected yet';
  return `Last seen ${ago(device.lastSeenAt)}${device.lastSeenVia ? ` ${VIA[device.lastSeenVia]}` : ''}`;
}

/** Counts down to a pairing offer's end: "4:52", then "expired". */
export function countdown(expiresAt: string, now: number): { text: string; expired: boolean } {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms) || ms <= 0) return { text: 'expired', expired: true };
  const seconds = Math.ceil(ms / 1000);
  return { text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, expired: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Notifications

/** `hint` marks the few switches whose label alone does not say what they cover; the rest need no sentence under them. */
export const NOTIFICATION_SWITCHES: { key: Exclude<keyof ProjectNotificationPrefs, 'enabled'>; label: string; column: string; description: string; hint?: true }[] = [
  { key: 'permission', label: 'Claude needs permission', column: 'Permission', description: 'A session is waiting for you to allow an action.' },
  { key: 'input', label: 'Claude asks you something', column: 'Input', description: 'A session asked a question and waits for your answer.' },
  { key: 'error', label: 'A session hit an error', column: 'Error', description: 'A turn or a session ended with an error.' },
  { key: 'report', label: 'A report is ready', column: 'Report', description: 'Claude declared a task finished and the report waits for its handoff.' },
  { key: 'turnEnded', label: 'Claude finished', column: 'Finished', description: 'A session stopped and is waiting for you, without a report. A turn ending does not mean the task is complete.', hint: true },
  { key: 'sessionEnded', label: 'A session ended abnormally', column: 'Ended', description: 'A session that was working stopped. A normal end only goes to the feed.', hint: true },
  { key: 'presenceLost', label: 'A session is no longer visible', column: 'Lost', description: 'Claude Code stopped listing a session. It may have ended; this is not confirmed.', hint: true },
  { key: 'push', label: 'Also send to my phone', column: 'Phone', description: 'Send a short push notification to paired phones, when push is set up.' },
];

export const QUIET_CHOICES = [
  { value: 'forever', label: 'Until I turn it off' },
  { value: '1h', label: 'For 1 hour' },
  { value: '4h', label: 'For 4 hours' },
  { value: 'morning', label: 'Until tomorrow morning (08:00)' },
] as const;
export type QuietChoice = (typeof QUIET_CHOICES)[number]['value'];

/** The ISO end of a quiet period, or null for "until I turn it off". */
export function quietUntil(choice: QuietChoice, now: Date = new Date()): string | null {
  if (choice === 'forever') return null;
  if (choice === '1h') return new Date(now.getTime() + 3_600_000).toISOString();
  if (choice === '4h') return new Date(now.getTime() + 4 * 3_600_000).toISOString();
  const morning = new Date(now);
  morning.setHours(8, 0, 0, 0);
  if (morning.getTime() <= now.getTime()) morning.setDate(morning.getDate() + 1);
  return morning.toISOString();
}

const CLOCK = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false });

export function quietSummary(quiet: QuietMode, now: number = Date.now()): string {
  const parts: string[] = [];
  if (quiet.enabled) {
    const until = quiet.until === null ? NaN : Date.parse(quiet.until);
    if (quiet.until === null || Number.isNaN(until)) parts.push('Quiet until you turn it off.');
    else if (until > now) parts.push(`Quiet until ${CLOCK.format(new Date(until))}${new Date(until).toDateString() === new Date(now).toDateString() ? '' : ' tomorrow'}.`);
    else parts.push('The quiet period you set has ended.');
  }
  if (quiet.schedule.enabled) parts.push(`Quiet every day from ${quiet.schedule.from} to ${quiet.schedule.to}.`);
  return parts.length ? parts.join(' ') : 'Notifications are not silenced.';
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------------------------------------------
// Claude Code environments and hooks

export function hookSummary(status: Pick<HookStatus, 'installed' | 'missingEvents' | 'duplicateRegistrations' | 'events'>): string {
  if (status.duplicateRegistrations) return 'Installed twice. Every event would be captured twice.';
  if (status.installed && status.missingEvents.length === 0) return `Installed for ${status.events.length} events`;
  if (status.events.length > 0) return `Partly installed: ${status.missingEvents.length} ${status.missingEvents.length === 1 ? 'event is' : 'events are'} missing`;
  return 'Not installed';
}

export function runtimeWords(runtime: HookStatus['runtime']): string {
  if (runtime.kind === 'electron') return `Mini-Summa itself, so Node.js is not needed${runtime.version ? ` (${runtime.version})` : ''}`;
  if (runtime.kind === 'node') return `${runtime.command}${runtime.version ? `, version ${runtime.version}` : ''}`;
  return 'None found. Hooks cannot run until Node.js is installed.';
}

/** Where to get Claude Code, per environment, as exact commands. */
export function installGuidance(env: string): { where: string; command: string }[] {
  const isWin = env === 'win';
  const commands: { where: string; command: string }[] = isWin
    ? [{ where: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' }]
    : [{ where: 'a terminal in that environment', command: 'curl -fsSL https://claude.ai/install.sh | bash' }];
  commands.push({ where: 'any terminal with Node.js', command: 'npm install -g @anthropic-ai/claude-code' });
  return commands;
}

export const envName = (id: string): string => envLabel(id as Parameters<typeof envLabel>[0]);

export type DiffKind = 'file' | 'hunk' | 'add' | 'del' | 'context';
export interface DiffLine { kind: DiffKind; text: string }

/** A unified diff, one entry per line, so each line can be given its meaning in words and in type. */
export function parseDiff(diff: string): DiffLine[] {
  if (diff === '') return [];
  return diff.split('\n').map((text): DiffLine => {
    if (text.startsWith('+++') || text.startsWith('---')) return { kind: 'file', text };
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    return { kind: 'context', text };
  });
}

export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length };
}

// ---------------------------------------------------------------------------------------------------------------
// ChatGPT and Tailscale status

const VIEW_STATUS: Record<ChatGptViewState['status'], string> = {
  idle: 'Not loaded yet', loading: 'Loading', ready: 'Ready', login_required: 'Sign-in needed', challenge: 'Security check', blocked: 'Blocked', error: 'Could not load',
};
export const viewStatusWords = (s: ChatGptViewState['status']): string => VIEW_STATUS[s];

export interface TailscaleFacts { installed: string; running: string; signedIn: string; serve: string }

export function tailscaleFacts(s: TailscaleStatus): TailscaleFacts {
  return {
    installed: s.installed ? 'Installed' : 'Not installed',
    running: !s.installed ? 'Not checked' : s.running ? 'Running' : `Not running${s.backendState ? ` (${s.backendState})` : ''}`,
    signedIn: !s.installed ? 'Not checked' : s.loggedIn ? `Signed in${s.tailnet ? ` as ${s.tailnet}` : ''}` : 'Not signed in',
    serve: s.serve.funnelDetected ? 'Funnel is on' : s.serve.configured ? 'Published to your tailnet' : 'Not published',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Numbers

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const count = (n: number): string => n.toLocaleString('en-US');

/** "0" keeps everything. Any other whole number of days is the age after which records may be removed. */
export function parseDays(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 0 && n <= 3650 ? n : null;
}

export function parsePartSize(text: string): number | null {
  const cleaned = text.replace(/[\s,]/g, '');
  if (!/^\d{1,6}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n >= 2000 && n <= 100_000 ? n : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sections

export const SECTIONS = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'extension', label: 'Browser extension' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'hooks', label: 'Claude hooks' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'phones', label: 'Phones and devices' },
  { id: 'remote', label: 'Remote access' },
  { id: 'push', label: 'Push notifications' },
  { id: 'review', label: 'Review and handoff' },
  { id: 'data', label: 'Data and privacy' },
  { id: 'about', label: 'About and setup' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

/** Other names a link, a notification or an older version may use for a section. */
const SECTION_ALIASES: Record<string, SectionId> = {
  claude: 'claude-code', environments: 'claude-code', 'claude hooks': 'hooks', 'claude-hooks': 'hooks',
  phone: 'phones', devices: 'phones', pairing: 'phones', mobile: 'phones',
  tailscale: 'remote', 'remote-access': 'remote', 'remote access': 'remote',
  handoff: 'review', template: 'review', privacy: 'data', storage: 'data',
  setup: 'about', onboarding: 'about', checklist: 'about', sessions: 'claude-code',
};

/** The section to show for whatever the route holds. Unknown or missing values open the first section. */
export function resolveSection(raw: string | null | undefined): SectionId {
  const key = (raw ?? '').trim().toLowerCase();
  const direct = SECTIONS.find((s) => s.id === key || s.label.toLowerCase() === key);
  return direct?.id ?? SECTION_ALIASES[key] ?? 'chatgpt';
}

// ---------------------------------------------------------------------------------------------------------------
// Review message preview

export interface PreviewInput { requestTemplate: string; includeSessionRef: boolean; projectName: string; now?: Date }

/** What a handoff message looks like, built by the same function the core uses, around a short example report. */
export function previewMessage(input: PreviewInput): string {
  return buildReportMessage({
    reportId: 'rpt_example0123456789',
    projectName: input.projectName,
    taskTitle: 'Example task',
    sessionRef: 'a1b2c3d4, managed, Windows, generation 1',
    declaredStatus: 'complete',
    capturedAt: (input.now ?? new Date()).toISOString(),
    body: 'The full report from Claude appears here, word for word.',
    reviewRequest: input.requestTemplate,
    includeSessionRef: input.includeSessionRef,
  });
}

/** How many parts a message of this many characters becomes at this part size. */
export function partCountFor(chars: number, maxPartChars: number): number {
  return Math.max(1, Math.ceil(chars / Math.max(1, maxPartChars)));
}

// ---------------------------------------------------------------------------------------------------------------
// Data

export interface PruneWords { total: number; lines: string[] }

const PRUNE_LABELS: [keyof PruneResult['removed'], string, string][] = [
  ['rawEvents', 'hook event', 'hook events'],
  ['activity', 'activity entry', 'activity entries'],
  ['notifications', 'notification', 'notifications'],
  ['reports', 'report', 'reports'],
  ['deliveries', 'handoff record', 'handoff records'],
];

/** The records a cleanup removes (or would remove), in words, skipping the kinds with nothing to remove. */
export function pruneWords(result: Pick<PruneResult, 'removed'>): PruneWords {
  const lines: string[] = [];
  let total = 0;
  for (const [key, one, many] of PRUNE_LABELS) {
    const n = result.removed[key];
    total += n;
    if (n > 0) lines.push(`${count(n)} ${n === 1 ? one : many}`);
  }
  return { total, lines };
}

export const RETENTION_FIELDS = [
  { key: 'rawEventsDays', label: 'Hook events', hint: 'What lets a session be replayed.' },
  { key: 'activityDays', label: 'Activity feed', hint: 'Entries that still need you stay.' },
  { key: 'notificationsDays', label: 'Notification records', hint: 'What each notification became.' },
  { key: 'reportsDays', label: 'Reports and handoffs', hint: 'Finished handoffs and their reports. Anything still open stays.' },
] as const satisfies readonly { key: keyof RetentionSettings; label: string; hint: string }[];

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** The operating system in the words people use. Anything unknown is shown as the host reports it. */
export const platformWords = (platform: string): string => PLATFORM_NAMES[platform] ?? platform;
