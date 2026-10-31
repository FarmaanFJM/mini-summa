// The HTTP API as data. The core registers a handler for every entry (TypeScript fails the build if one is missing),
// and the client SDK builds its typed methods from the same table, so the two can never drift apart.
import { z } from 'zod';
import type {
  ActivityEvent, Conversation, Counts, DataUsage, Delivery, DeliveryDetail, DeliveryPrepared, Device, EnvironmentInfo,
  HookPlan, HookStatus, NotificationRecord, PairingOffer, PairingRedeemResult, PendingAction, Project, Report,
  ReportCandidate, ReportSummary, Scope, SessionView, Settings, StateSnapshot, TailscaleStatus,
} from './entities.ts';
import { UI_LIMITS } from './defaults.ts';
import { isEnvId, isSessionKey } from './env.ts';
import type { EnvId, SessionKey } from './env.ts';
import type { ChatGptOpenResult } from './native.ts';

export const API_VERSION = 1;
export const API_PREFIX = '/api/v1';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteDef<Res, P extends string, B extends z.ZodType | undefined, Q extends z.ZodType | undefined> {
  method: HttpMethod;
  path: P;
  /** Minimum scope. A token with the `desktop` scope may call everything. */
  scope: Scope | 'public';
  body?: B;
  query?: Q;
  /** POST routes that create something accept an Idempotency-Key header so a retried request cannot double-submit. */
  idempotent?: boolean;
  readonly _res?: Res;
}

function route<Res>() {
  return <const P extends string, B extends z.ZodType | undefined = undefined, Q extends z.ZodType | undefined = undefined>(
    def: Omit<RouteDef<Res, P, B, Q>, '_res'>,
  ): RouteDef<Res, P, B, Q> => def;
}

// ---------------------------------------------------------------------------------------------------------------
// Reusable schemas

const envId = z.string().refine((v): v is EnvId => isEnvId(v), 'Not a valid environment id') as unknown as z.ZodType<EnvId>;
const sessionKey = z.string().refine((v): v is SessionKey => isSessionKey(v), 'Not a valid session key') as unknown as z.ZodType<SessionKey>;
const id = z.string().min(1).max(100);
const text = (max: number) => z.string().max(max);
const qInt = (min: number, max: number) => z.union([z.number().int().min(min).max(max), z.string().regex(/^\d{1,9}$/).transform(Number).pipe(z.number().int().min(min).max(max))]);
const qBool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const notificationPrefsSchema = z.object({
  enabled: z.boolean(), permission: z.boolean(), input: z.boolean(), error: z.boolean(), report: z.boolean(), turnEnded: z.boolean(),
  sessionEnded: z.boolean(), presenceLost: z.boolean(), push: z.boolean(),
});

const scopeSchema = z.enum(['desktop', 'read', 'notify', 'prompt', 'approve', 'extension']);
const grantableScope = z.enum(['read', 'notify', 'prompt', 'approve']);
const reviewState = z.enum(['none', 'requested', 'received', 'follow_up_drafted', 'follow_up_sent', 'closed']);
const noteBody = z.object({ note: text(1000).optional() });

/** The address of an existing ChatGPT Project (or of a conversation inside it) and, optionally, what to call it. Null unlinks. */
const chatgptProjectInput = z.object({ url: z.string().min(1).max(2048), title: text(120).optional() }).nullable();

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: text(2000).nullable().optional(),
  githubRepo: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use the form owner/repo').nullable().optional(),
  chatgptProject: chatgptProjectInput.optional(),
  defaultEnv: envId.optional(),
  roots: z.array(z.object({ path: z.string().min(1).max(1024), env: envId.optional(), label: text(120).nullable().optional() })).max(10).default([]),
});

export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: text(2000).nullable().optional(),
  githubRepo: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use the form owner/repo').nullable().optional(),
  chatgptProject: chatgptProjectInput.optional(),
  defaultEnv: envId.optional(),
  notificationPrefs: notificationPrefsSchema.partial().optional(),
  /** true hides the project (history is kept), false restores it. */
  archived: z.boolean().optional(),
});

export const sessionStartSchema = z.object({
  mode: z.enum(['new', 'resume']),
  /** For resume: the session to bring back as a managed session. */
  resumeKey: sessionKey.optional(),
  env: envId.optional(),
  rootId: id.optional(),
  name: text(120).optional(),
  remoteControl: z.boolean().optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
});

// The window's memory (`Settings.ui`). Strict: a key this build does not know is refused, not ignored. Bounded: ids are short and at
// most UI_LIMITS.projects projects are named in one patch. The meaning of the patch (null forgets) is `mergeUi` in defaults.ts.
const uiId = z.string().min(1).max(UI_LIMITS.idChars).refine((v) => v !== '__proto__' && v !== 'constructor' && v !== 'prototype', 'Not a usable id');
const uiSessionKey = z.string().max(UI_LIMITS.keyChars).refine((v): v is SessionKey => isSessionKey(v), 'Not a valid session key') as unknown as z.ZodType<SessionKey>;
const uiPatchSchema = z.strictObject({
  route: z.strictObject({ projectId: uiId.nullable(), view: z.enum(['workspace', 'activity', 'reports', 'settings']) }).nullable(),
  perProject: z.record(uiId, z.strictObject({ sessionKey: uiSessionKey.nullable(), conversationId: uiId.nullable(), cloudUrl: z.string().max(UI_LIMITS.urlChars).nullable(), chatgptUrl: z.string().max(UI_LIMITS.urlChars).nullable() }).partial().nullable())
    .refine((v) => Object.keys(v).length <= UI_LIMITS.projects, `At most ${UI_LIMITS.projects} projects can be named in one change`),
  setup: z.strictObject({ dismissed: z.boolean().nullable(), seenEmpty: z.boolean().nullable() }).partial(),
}).partial();

const settingsPatchSchema = z.object({
  chatgpt: z.object({ mode: z.enum(['embedded', 'external']), externalBrowser: z.enum(['default', 'extension']), pageScale: z.enum(['auto', '100', '90', '80', '70']) }).partial(),
  layout: z.object({
    orientation: z.enum(['auto', 'landscape', 'portrait']), landscapeRatio: z.number().min(0.15).max(0.85),
    portraitRatio: z.number().min(0.15).max(0.85), maximized: z.enum(['chatgpt', 'claude']).nullable(),
    sidebarWidth: z.number().min(180).max(520), sidebarCollapsed: z.boolean(),
  }).partial(),
  notifications: z.object({
    native: z.boolean(),
    quiet: z.object({
      enabled: z.boolean(), until: z.string().nullable(),
      schedule: z.object({ enabled: z.boolean(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }).partial(),
    }).partial(),
    defaults: notificationPrefsSchema.partial(),
  }).partial(),
  review: z.object({ requestTemplate: text(4000), includeSessionRef: z.boolean(), maxPartChars: z.number().int().min(2000).max(100_000) }).partial(),
  sessions: z.object({ discoveryIntervalSec: z.number().int().min(5).max(600), remoteControlByDefault: z.boolean(), claudeCommand: text(512).nullable() }).partial(),
  mobile: z.object({
    remoteAccess: z.enum(['off', 'tailscale']),
    promptActionTtlMinutes: z.number().int().min(1).max(1440),
  }).partial(),
  retention: z.object({ rawEventsDays: z.number().int().min(0).max(3650), activityDays: z.number().int().min(0).max(3650), notificationsDays: z.number().int().min(0).max(3650), reportsDays: z.number().int().min(0).max(3650) }).partial(),
  ui: uiPatchSchema,
}).partial();
export { settingsPatchSchema };

// ---------------------------------------------------------------------------------------------------------------
// Responses that are not plain entities

export interface Ok { ok: true }
export interface HealthInfo { ok: true; name: 'mini-summa-core'; version: string; apiVersion: number }
export interface DiscoveryRefreshResult { ran: EnvId[]; errors: { env: EnvId; message: string }[] }
export interface CopyResult { delivery: Delivery; part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null }
export interface OpenResult { delivery: Delivery; open: ChatGptOpenResult }
export interface HandoffResult { delivery: Delivery; part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null; open: ChatGptOpenResult }
export interface PartText { index: number; total: number; text: string; sha256: string }
export interface PruneResult { dryRun: boolean; removed: { rawEvents: number; activity: number; notifications: number; reports: number; deliveries: number } }
export interface ListPage<T> { items: T[]; nextBefore: string | null }
export interface PushConfigured { ok: true; configured: true; firebaseProject: string }
export interface PushTestResult { sent: number; failed: number; skipped: string | null }
/** What the system said to a test desktop notification. `shown` is true only when it accepted it; `quiet` tells that quiet mode is on, which holds real notifications back but not this test. */
export interface DesktopNotificationTestResult { shown: boolean; reason: string | null; quiet: boolean }
export interface SaveFileResult { delivery: Delivery; path: string | null }

// ---------------------------------------------------------------------------------------------------------------
// The table

export const routes = {
  // system
  'system.health': route<HealthInfo>()({ method: 'GET', path: '/health', scope: 'public' }),
  'system.state': route<StateSnapshot>()({ method: 'GET', path: '/state', scope: 'read' }),
  'system.counts': route<Counts>()({ method: 'GET', path: '/counts', scope: 'read' }),

  // projects
  'projects.list': route<Project[]>()({ method: 'GET', path: '/projects', scope: 'read', query: z.object({ includeArchived: qBool.optional() }) }),
  'projects.get': route<Project>()({ method: 'GET', path: '/projects/:id', scope: 'read' }),
  'projects.create': route<Project>()({ method: 'POST', path: '/projects', scope: 'desktop', body: projectCreateSchema, idempotent: true }),
  'projects.update': route<Project>()({ method: 'PATCH', path: '/projects/:id', scope: 'desktop', body: projectUpdateSchema }),
  'projects.remove': route<Ok>()({ method: 'DELETE', path: '/projects/:id', scope: 'desktop',
    /** Without stopSessions, a project with running Claude terminals is refused (409 sessions_running) so nothing ends by surprise. */
    query: z.object({ mode: z.enum(['archive', 'delete']).optional(), stopSessions: qBool.optional() }) }),
  'projects.reorder': route<Ok>()({ method: 'POST', path: '/projects-reorder', scope: 'desktop', body: z.object({ ids: z.array(id).max(500) }) }),
  'projects.addRoot': route<Project>()({ method: 'POST', path: '/projects/:id/roots', scope: 'desktop', body: z.object({ path: z.string().min(1).max(1024), env: envId.optional(), label: text(120).nullable().optional() }) }),
  'projects.removeRoot': route<Project>()({ method: 'DELETE', path: '/projects/:id/roots/:rootId', scope: 'desktop' }),

  // ChatGPT conversations mapped to a project
  'conversations.list': route<Conversation[]>()({ method: 'GET', path: '/projects/:id/conversations', scope: 'read' }),
  'conversations.add': route<Conversation>()({ method: 'POST', path: '/projects/:id/conversations', scope: 'desktop', idempotent: true,
    body: z.object({ url: z.string().min(1).max(2048), title: text(200).optional(), note: text(1000).nullable().optional(), makePreferred: z.boolean().optional() }) }),
  'conversations.update': route<Conversation>()({ method: 'PATCH', path: '/conversations/:id', scope: 'desktop',
    body: z.object({ url: z.string().min(1).max(2048).optional(), title: text(200).optional(), note: text(1000).nullable().optional() }) }),
  'conversations.remove': route<Ok>()({ method: 'DELETE', path: '/conversations/:id', scope: 'desktop' }),
  'conversations.setPreferred': route<Project>()({ method: 'POST', path: '/projects/:id/preferred-conversation', scope: 'desktop', body: z.object({ conversationId: id.nullable() }) }),
  'conversations.open': route<ChatGptOpenResult>()({ method: 'POST', path: '/conversations/:id/open', scope: 'desktop' }),
  'conversations.verify': route<Conversation>()({ method: 'POST', path: '/conversations/:id/verify', scope: 'desktop' }),

  // sessions
  'sessions.list': route<SessionView[]>()({ method: 'GET', path: '/sessions', scope: 'read', query: z.object({ projectId: id.optional(), includeEnded: qBool.optional() }) }),
  'sessions.get': route<SessionView>()({ method: 'GET', path: '/sessions/:key', scope: 'read' }),
  'sessions.start': route<SessionView>()({ method: 'POST', path: '/projects/:id/sessions', scope: 'desktop', body: sessionStartSchema, idempotent: true }),
  'sessions.stop': route<SessionView>()({ method: 'POST', path: '/sessions/:key/stop', scope: 'desktop', body: z.object({ force: z.boolean().optional() }) }),
  'sessions.bind': route<SessionView>()({ method: 'POST', path: '/sessions/:key/bind', scope: 'desktop', body: z.object({ projectId: id.nullable() }) }),
  'sessions.setDefault': route<Project>()({ method: 'POST', path: '/sessions/:key/default', scope: 'desktop', body: z.object({ isDefault: z.boolean() }) }),
  'sessions.refresh': route<DiscoveryRefreshResult>()({ method: 'POST', path: '/discovery/refresh', scope: 'desktop', body: z.object({ env: envId.optional() }) }),

  // reports
  'reports.list': route<ListPage<ReportSummary>>()({ method: 'GET', path: '/reports', scope: 'read',
    query: z.object({ projectId: id.optional(), unread: qBool.optional(), limit: qInt(1, 200).optional(), before: z.string().max(100).optional() }) }),
  'reports.get': route<Report>()({ method: 'GET', path: '/reports/:id', scope: 'read' }),
  'reports.markRead': route<ReportSummary>()({ method: 'POST', path: '/reports/:id/read', scope: 'read' }),
  'candidates.list': route<ReportCandidate[]>()({ method: 'GET', path: '/candidates', scope: 'read', query: z.object({ projectId: id.optional(), includePromoted: qBool.optional() }) }),
  'candidates.promote': route<Report>()({ method: 'POST', path: '/candidates/:id/promote', scope: 'desktop' }),

  // deliveries (ChatGPT handoff). Every step is an explicit user action; nothing here submits to ChatGPT.
  'deliveries.list': route<Delivery[]>()({ method: 'GET', path: '/deliveries', scope: 'read', query: z.object({ projectId: id.optional(), reportId: id.optional(), open: qBool.optional() }) }),
  'deliveries.get': route<DeliveryDetail>()({ method: 'GET', path: '/deliveries/:id', scope: 'read' }),
  'deliveries.create': route<Delivery>()({ method: 'POST', path: '/reports/:id/deliveries', scope: 'desktop', idempotent: true,
    body: z.object({ conversationId: id.optional(), includeReviewRequest: z.boolean().optional() }) }),
  'deliveries.prepare': route<DeliveryPrepared>()({ method: 'POST', path: '/deliveries/:id/prepare', scope: 'desktop' }),
  'deliveries.part': route<PartText>()({ method: 'GET', path: '/deliveries/:id/parts/:index', scope: 'desktop' }),
  'deliveries.copy': route<CopyResult>()({ method: 'POST', path: '/deliveries/:id/copy', scope: 'desktop', body: z.object({ part: z.number().int().min(1).optional() }) }),
  'deliveries.open': route<OpenResult>()({ method: 'POST', path: '/deliveries/:id/open', scope: 'desktop' }),
  'deliveries.handoff': route<HandoffResult>()({ method: 'POST', path: '/deliveries/:id/handoff', scope: 'desktop', body: z.object({ part: z.number().int().min(1).optional() }) }),
  'deliveries.confirmSent': route<Delivery>()({ method: 'POST', path: '/deliveries/:id/confirm-sent', scope: 'desktop', body: noteBody }),
  'deliveries.markUncertain': route<Delivery>()({ method: 'POST', path: '/deliveries/:id/uncertain', scope: 'desktop', body: noteBody }),
  'deliveries.discard': route<Delivery>()({ method: 'POST', path: '/deliveries/:id/discard', scope: 'desktop', body: noteBody }),
  'deliveries.reopen': route<Delivery>()({ method: 'POST', path: '/deliveries/:id/reopen', scope: 'desktop', body: noteBody }),
  'deliveries.setDestination': route<Delivery>()({ method: 'POST', path: '/deliveries/:id/destination', scope: 'desktop', body: z.object({ conversationId: id }) }),
  'deliveries.setReview': route<Delivery>()({ method: 'POST', path: '/deliveries/:id/review', scope: 'desktop',
    body: z.object({ review: reviewState, followUpDraft: text(100_000).nullable().optional() }) }),
  'deliveries.saveFile': route<SaveFileResult>()({ method: 'POST', path: '/deliveries/:id/save-file', scope: 'desktop' }),

  // pending actions
  'actions.list': route<PendingAction[]>()({ method: 'GET', path: '/actions', scope: 'read', query: z.object({ status: z.enum(['pending', 'open', 'all']).optional(), projectId: id.optional() }) }),
  'actions.create': route<PendingAction>()({ method: 'POST', path: '/actions', scope: 'prompt', idempotent: true,
    body: z.object({ sessionKey, text: z.string().min(1).max(20_000), expectGeneration: z.number().int().min(0).optional(), reportId: id.optional(), deliveryId: id.optional() }) }),
  'actions.approve': route<PendingAction>()({ method: 'POST', path: '/actions/:id/approve', scope: 'approve' }),
  'actions.reject': route<PendingAction>()({ method: 'POST', path: '/actions/:id/reject', scope: 'approve', body: z.object({ reason: text(500).optional() }) }),

  // activity and notifications
  'activity.list': route<ListPage<ActivityEvent>>()({ method: 'GET', path: '/activity', scope: 'read',
    query: z.object({ projectId: id.optional(), type: z.string().max(40).optional(), unread: qBool.optional(), requiresAction: qBool.optional(), limit: qInt(1, 200).optional(), before: z.string().max(100).optional() }) }),
  'activity.markRead': route<Counts>()({ method: 'POST', path: '/activity/read', scope: 'read',
    body: z.object({ ids: z.array(id).max(500).optional(), all: z.boolean().optional(), projectId: id.optional() }) }),
  'notifications.list': route<NotificationRecord[]>()({ method: 'GET', path: '/notifications', scope: 'read', query: z.object({ limit: qInt(1, 200).optional() }) }),

  // settings
  'settings.get': route<Settings>()({ method: 'GET', path: '/settings', scope: 'read' }),
  'settings.update': route<Settings>()({ method: 'PATCH', path: '/settings', scope: 'desktop', body: settingsPatchSchema }),

  // Claude Code hooks and environments (always shown as an exact diff before anything is written)
  'environments.list': route<EnvironmentInfo[]>()({ method: 'GET', path: '/environments', scope: 'desktop', query: z.object({ refresh: qBool.optional() }) }),
  'hooks.list': route<HookStatus[]>()({ method: 'GET', path: '/hooks', scope: 'desktop' }),
  'hooks.plan': route<HookPlan>()({ method: 'POST', path: '/hooks/plan', scope: 'desktop', body: z.object({ env: envId, action: z.enum(['install', 'uninstall']) }) }),
  'hooks.apply': route<HookStatus>()({ method: 'POST', path: '/hooks/apply', scope: 'desktop', body: z.object({ env: envId, action: z.enum(['install', 'uninstall']), planHash: z.string().min(16).max(128) }) }),

  // devices and pairing
  'pairing.createOffer': route<PairingOffer>()({ method: 'POST', path: '/pairing/offers', scope: 'desktop',
    body: z.object({ scopes: z.array(grantableScope).max(4).optional(), kind: z.enum(['phone', 'extension']).optional() }) }),
  'pairing.redeem': route<PairingRedeemResult>()({ method: 'POST', path: '/pairing/redeem', scope: 'public',
    body: z.object({ offerId: id, code: z.string().min(8).max(200), deviceName: z.string().trim().min(1).max(80), platform: z.enum(['android', 'ios', 'extension', 'other']) }) }),
  'devices.list': route<Device[]>()({ method: 'GET', path: '/devices', scope: 'desktop' }),
  'devices.self': route<Device>()({ method: 'GET', path: '/devices/self', scope: 'read' }),
  'devices.update': route<Device>()({ method: 'PATCH', path: '/devices/:id', scope: 'desktop',
    body: z.object({ name: z.string().trim().min(1).max(80).optional(), trusted: z.boolean().optional(), scopes: z.array(grantableScope).max(4).optional() }) }),
  'devices.revoke': route<Ok>()({ method: 'DELETE', path: '/devices/:id', scope: 'desktop' }),
  'devices.registerPush': route<Ok>()({ method: 'POST', path: '/devices/self/push-token', scope: 'notify', body: z.object({ provider: z.literal('fcm'), token: z.string().min(10).max(4096) }) }),

  // push notifications (Firebase Cloud Messaging, configured by the user with their own service account)
  'push.configure': route<PushConfigured>()({ method: 'POST', path: '/push/configure', scope: 'desktop', body: z.object({ serviceAccountJson: z.string().min(50).max(20_000) }) }),
  'push.clear': route<Ok>()({ method: 'DELETE', path: '/push/configure', scope: 'desktop' }),
  'push.test': route<PushTestResult>()({ method: 'POST', path: '/push/test', scope: 'desktop' }),
  // a test notification on this computer (the same path real ones take, so what the system does with it shows what it will do with them)
  'notifications.test': route<DesktopNotificationTestResult>()({ method: 'POST', path: '/notifications/test', scope: 'desktop' }),

  // remote access
  'tailscale.status': route<TailscaleStatus>()({ method: 'GET', path: '/tailscale', scope: 'desktop', query: z.object({ refresh: qBool.optional() }) }),
  'tailscale.setServe': route<TailscaleStatus>()({ method: 'POST', path: '/tailscale/serve', scope: 'desktop', body: z.object({ enabled: z.boolean() }) }),

  // data
  'data.usage': route<DataUsage>()({ method: 'GET', path: '/data/usage', scope: 'desktop' }),
  'data.prune': route<PruneResult>()({ method: 'POST', path: '/data/prune', scope: 'desktop', body: z.object({ dryRun: z.boolean().optional() }) }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;

// ---------------------------------------------------------------------------------------------------------------
// Type plumbing shared by the SDK and the server

export type PathParams<P extends string> =
  P extends `${string}:${infer N}/${infer Rest}` ? { [K in N]: string } & PathParams<Rest>
    : P extends `${string}:${infer N}` ? { [K in N]: string }
      : unknown;

type HasParams<P extends string> = P extends `${string}:${string}` ? true : false;

type DefOf<K extends RouteName> = Routes[K];
type PathOf<K extends RouteName> = DefOf<K> extends RouteDef<any, infer P, any, any> ? P : never;
type BodyOf<K extends RouteName> = DefOf<K> extends RouteDef<any, any, infer B, any> ? B : never;
type QueryOf<K extends RouteName> = DefOf<K> extends RouteDef<any, any, any, infer Q> ? Q : never;

/** What a caller passes. Parameters and body are required when the route has them. */
export type RouteInput<K extends RouteName> =
  (HasParams<PathOf<K>> extends true ? { params: PathParams<PathOf<K>> } : { params?: undefined })
  & (BodyOf<K> extends z.ZodType ? { body: z.input<BodyOf<K>> } : { body?: undefined })
  & (QueryOf<K> extends z.ZodType ? { query?: z.input<QueryOf<K>> } : { query?: undefined });

export type RouteOutput<K extends RouteName> = DefOf<K> extends RouteDef<infer R, any, any, any> ? R : never;

/** What a server handler receives after validation. */
export interface HandlerInput<K extends RouteName> {
  params: HasParams<PathOf<K>> extends true ? PathParams<PathOf<K>> : Record<string, never>;
  query: QueryOf<K> extends z.ZodType ? z.output<QueryOf<K>> : Record<string, never>;
  body: BodyOf<K> extends z.ZodType ? z.output<BodyOf<K>> : undefined;
}

/** Does a token with these scopes satisfy the route? `desktop` is the owner and passes everything. */
export function scopeAllows(granted: readonly Scope[], needed: Scope | 'public'): boolean {
  if (needed === 'public') return true;
  return granted.includes('desktop') || granted.includes(needed);
}

export const routeNames = Object.keys(routes) as RouteName[];

/** Fill `:name` placeholders, percent-encoding each value (session keys contain `|`). */
export function buildPath(path: string, params: Record<string, string> | undefined): string {
  return path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const v = params?.[name];
    if (v === undefined) throw new Error(`Missing path parameter "${name}" for ${path}`);
    return encodeURIComponent(v);
  });
}
