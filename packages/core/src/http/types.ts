// Shared types of the HTTP/WebSocket server.
//
// Contract notes (see the worker report):
//  * `native` is an optional extra dependency. contracts.ts has no service behind `conversations.open` and
//    `conversations.verify`, so those two routes use the host (NativeBridge) and the extension bridge directly.
//    Without `native` they answer 503 `unavailable` instead of pretending.
//  * `tuning` exists only so tests can shorten the 5 s / 8 MB limits. Production leaves it undefined.
import type {
  ActorRef, Counts, HandlerInput, NativeBridge, RouteName, RouteOutput, SystemInfo,
} from '@minisumma/shared';
import type {
  ActionsService, ActivityService, CoreBase, DataService, DeliveriesService, DevicesService, EnvironmentsService,
  ExtensionBridge, HooksService, NotificationsService, Principal, ProjectsService, PushProvider, ReportsService,
  SessionsService, SettingsService, TailscaleService,
} from '../contracts.ts';

export interface HttpServices {
  settings: SettingsService;
  projects: ProjectsService;
  sessions: SessionsService;
  environments: EnvironmentsService;
  activity: ActivityService;
  notifications: NotificationsService;
  reports: ReportsService;
  deliveries: DeliveriesService;
  actions: ActionsService;
  devices: DevicesService;
  hooks: HooksService;
  tailscale: TailscaleService;
  data: DataService;
  /** null when the build has no push provider; the push routes then answer 503. */
  push: PushProvider | null;
}

export interface HttpTuning {
  /** A WebSocket must send `hello` within this time or it is closed with 4001. */
  helloTimeoutMs: number;
  /** How long the extension bridge waits for the extension's answer. */
  bridgeTimeoutMs: number;
  /** A WebSocket whose unsent data exceeds this is dropped. */
  maxBufferedBytes: number;
  /** JSON request bodies larger than this are refused with 413. */
  maxBodyBytes: number;
  /** Global limit for `pairing.redeem`. */
  redeemPerMinute: number;
  /** How long a stored idempotent response is kept. */
  idempotencyTtlMs: number;
}

export const DEFAULT_TUNING: HttpTuning = {
  helloTimeoutMs: 5_000,
  // A tab the extension has to create can take up to 15 s to finish loading (its own limit); leave room for the answer.
  bridgeTimeoutMs: 18_000,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxBodyBytes: 1024 * 1024,
  redeemPerMinute: 10,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
};

export interface HttpServerDeps {
  base: CoreBase;
  /** 0 picks a free port. */
  port: number;
  /** Directory with the built renderer, served under /ui/. */
  uiDir?: string;
  services: HttpServices;
  counts: () => Counts;
  system: () => SystemInfo;
  /** Host capabilities, only needed by `conversations.open` and `conversations.verify`. */
  native?: NativeBridge;
  tuning?: Partial<HttpTuning>;
}

export interface HttpServer {
  /** Binds 127.0.0.1. Rejects with an HttpListenError (code `EADDRINUSE` when the port is taken). */
  start(): Promise<{ port: number; baseUrl: string }>;
  stop(): Promise<void>;
  extensionBridge: ExtensionBridge;
}

/** What a handler knows about the caller. Public routes get an anonymous principal with no scopes. */
export interface RequestContext {
  principal: Principal;
  /** Who to record in audit trails. Derived from the authenticated principal, never from the request body. */
  actor: ActorRef;
  via: Principal['via'];
  /** This server's own address, e.g. http://127.0.0.1:47811. */
  baseUrl: string;
  /** The Tailscale Serve URL when remote access is on. */
  publicUrl: string | null;
}

export type Handler<K extends RouteName> = (input: HandlerInput<K>, ctx: RequestContext) => RouteOutput<K> | Promise<RouteOutput<K>>;

/** One handler per entry of the shared route table. A missing entry is a compile error. */
export type HandlerMap = { [K in RouteName]: Handler<K> };

/** Thrown by `start()` when the socket cannot be bound. `code` is the Node errno, e.g. EADDRINUSE. */
export class HttpListenError extends Error {
  readonly code: string;
  readonly port: number;
  constructor(message: string, code: string, port: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HttpListenError';
    this.code = code;
    this.port = port;
  }
}
