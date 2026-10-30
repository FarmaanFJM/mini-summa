// Owns the SDK client and the phone's view of the desktop. No UI in here.
//
// What the manager promises (each point has a test):
//  * Status is one of connecting, connected, reconnecting, desktop_unreachable, revoked (plus idle when stopped).
//  * Every (re)connect reloads snapshots: system.state first, then reports, activity, actions, deliveries.
//  * Data is only "live" while the stream is open. In every other state the snapshot says when the desktop was last
//    heard from, and the banner built from it says so.
//  * A removed phone (HTTP 401, 403 on a bootstrap call, or WebSocket close 4003) is detected, the stream is closed and
//    `onRevoked` is called so the app can wipe the token.
import {
  ApiError, MiniSummaClient, applyEvent, applySnapshot, createInitialState,
} from '@minisumma/shared';
import type {
  ClientOptions, ClientState, Device, PendingAction, ReportSummary, RouteInput, RouteName, RouteOutput, Scope, ServerEvent,
  ServerMessage, WebSocketCtor,
} from '@minisumma/shared';
import type { Credentials } from './credentials.ts';
import { observeWebSocket } from './observedSocket.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'desktop_unreachable' | 'revoked';

/**
 * Why the desktop is unreachable, as far as the phone can tell.
 * no_answer     nothing answered: the PC is probably asleep, off, or this phone is not on the tailnet
 * server_error  something answered but Mini-Summa returned an error (for example the Tailscale proxy with no core behind it)
 * stream_blocked  plain requests work but the live connection cannot open
 */
export type UnreachableCause = 'no_answer' | 'server_error' | 'stream_blocked';

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  state: ClientState;
  device: Device | null;
  scopes: Scope[];
  /** Epoch ms of the last time the desktop was heard from (a snapshot, an event or a pong). */
  lastHeardAt: number | null;
  cause: UnreachableCause | null;
  lastError: string | null;
  refreshing: boolean;
  reportsNext: string | null;
  activityNext: string | null;
  endpoint: { baseUrl: string; serverName: string };
}

export interface ConnectionDeps {
  credentials: Credentials;
  clientName?: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  now?: () => number;
  /** How long the stream may stay down before the status becomes desktop_unreachable. */
  unreachableAfterMs?: number;
  /** Called once when the desktop says this phone is no longer allowed. The app clears secure storage here. */
  onRevoked?: () => void;
  timeoutMs?: number;
}

/** Subset of the manager that screens depend on. Tests can implement it with a plain object. */
export interface ConnectionApi {
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  call: MiniSummaClient['call'];
  refresh(): Promise<void>;
  loadMoreReports(): Promise<void>;
  loadMoreActivity(): Promise<void>;
  upsertAction(action: PendingAction): void;
  upsertReport(report: ReportSummary): void;
}

export const REVOKE_CLOSE_CODE = 4003;
const SERVER_REVOKE_ERROR_CODES = new Set(['unauthorized', 'forbidden', 'revoked', 'device_revoked', 'invalid_token']);
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 30_000;

export class ConnectionManager implements ConnectionApi {
  private snap: ConnectionSnapshot;
  private readonly listeners = new Set<() => void>();
  private client: MiniSummaClient | null = null;
  private wanted = false;
  private disposed = false;
  private loading = false;
  private loadGen = 0;
  private buffer: { seq: number; event: ServerEvent }[] = [];
  private heard: number | null = null;
  private readyScopes: Scope[] = [];
  private unreachableTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RETRY_BASE_MS;
  private readonly now: () => number;

  constructor(private readonly deps: ConnectionDeps) {
    this.now = deps.now ?? Date.now;
    this.snap = {
      status: 'idle', state: createInitialState(), device: null, scopes: [], lastHeardAt: null, cause: null, lastError: null,
      refreshing: false, reportsNext: null, activityNext: null,
      endpoint: { baseUrl: deps.credentials.baseUrl, serverName: deps.credentials.serverName },
    };
  }

  // ---- store interface (useSyncExternalStore) ---------------------------------------------------------------------

  getSnapshot = (): ConnectionSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<ConnectionSnapshot>): void {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  /** Open the stream. Safe to call repeatedly (for example on every return to the foreground). */
  start(): void {
    if (this.disposed || this.snap.status === 'revoked') return;
    this.wanted = true;
    this.stopClient();
    const observed = observeWebSocket(this.deps.WebSocket ?? (globalThis as { WebSocket: WebSocketCtor }).WebSocket, (code, reason) => this.onSocketClosed(code, reason));
    const options: ClientOptions = {
      baseUrl: this.deps.credentials.baseUrl,
      token: this.deps.credentials.token,
      clientName: this.deps.clientName ?? 'mini-summa-android',
      fetch: this.deps.fetch,
      WebSocket: observed,
      timeoutMs: this.deps.timeoutMs,
    };
    const client = new MiniSummaClient(options);
    this.client = client;
    this.set({ status: this.snap.state.loaded ? 'reconnecting' : 'connecting', lastHeardAt: this.heard ?? this.snap.lastHeardAt });
    this.startUnreachableTimer();

    client.events.onStatus((s) => this.onStreamStatus(client, s));
    client.events.onReady(() => { if (this.client === client) void this.loadAll(); });
    client.events.onEvent((seq, event) => { if (this.client === client) this.onEvent(seq, event); });
    client.events.onMessage((msg) => { if (this.client === client) this.onMessage(msg); });
    client.events.onError((code, message, fatal) => { if (this.client === client) this.onStreamError(code, message, fatal); });
    client.events.connect();
  }

  /** Close the stream (the app went to the background). Data is kept but is no longer live. */
  stop(): void {
    this.wanted = false;
    this.stopClient();
    this.clearTimers();
    if (this.snap.status !== 'revoked') this.set({ status: 'idle', lastHeardAt: this.heard ?? this.snap.lastHeardAt });
  }

  dispose(): void {
    this.wanted = false;
    this.stopClient();
    this.clearTimers();
    this.disposed = true;
    this.listeners.clear();
  }

  private stopClient(): void {
    const c = this.client;
    if (!c) return;
    this.loadGen++;
    this.loading = false;
    this.buffer = [];
    try { c.close(); } catch { /* already closed */ }
  }

  private clearTimers(): void {
    if (this.unreachableTimer) clearTimeout(this.unreachableTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.unreachableTimer = this.retryTimer = null;
  }

  // ---- stream callbacks -------------------------------------------------------------------------------------------

  private onStreamStatus(client: MiniSummaClient, s: string): void {
    if (this.client !== client || !this.wanted || this.snap.status === 'revoked') return;
    if (s === 'reconnecting' || s === 'connecting') {
      if (this.snap.status === 'connected') this.set({ status: 'reconnecting', lastHeardAt: this.heard ?? this.snap.lastHeardAt });
      this.startUnreachableTimer();
    }
  }

  private onMessage(msg: ServerMessage): void {
    this.heard = this.now();
    if (msg.t === 'ready') this.readyScopes = msg.scopes;
  }

  private onEvent(seq: number, event: ServerEvent): void {
    if (this.loading) { this.buffer.push({ seq, event }); return; }
    this.set({ state: applyEvent(this.snap.state, seq, event), lastHeardAt: this.now() });
  }

  private onStreamError(code: string, message: string, fatal: boolean): void {
    if (SERVER_REVOKE_ERROR_CODES.has(code)) { this.markRevoked(); return; }
    if (fatal) this.set({ lastError: message });
  }

  private onSocketClosed(code: number | null, _reason: string): void {
    if (code === REVOKE_CLOSE_CODE) this.markRevoked();
  }

  // ---- reaching the desktop ---------------------------------------------------------------------------------------

  private startUnreachableTimer(): void {
    if (this.unreachableTimer || !this.wanted) return;
    this.unreachableTimer = setTimeout(() => {
      this.unreachableTimer = null;
      if (!this.wanted) return;
      const s = this.snap.status;
      if (s !== 'connecting' && s !== 'reconnecting') return;
      this.set({ status: 'desktop_unreachable', cause: this.snap.cause ?? 'no_answer', lastHeardAt: this.heard ?? this.snap.lastHeardAt });
      void this.diagnose();
    }, this.deps.unreachableAfterMs ?? 15_000);
  }

  /** The stream is down. A plain request tells "PC is off" apart from "PC is on but Mini-Summa is not answering". */
  private async diagnose(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.call('system.health');
      if (this.client !== client || this.snap.status !== 'desktop_unreachable') return;
      this.set({ cause: 'stream_blocked' });
      await this.loadAll();
    } catch (err) {
      if (this.client !== client || this.snap.status !== 'desktop_unreachable') return;
      if (err instanceof ApiError && err.status >= 400) this.set({ cause: 'server_error', lastError: err.message });
    }
  }

  markRevoked(): void {
    if (this.snap.status === 'revoked') return;
    this.wanted = false;
    this.stopClient();
    this.clearTimers();
    this.set({ status: 'revoked', cause: null, lastHeardAt: this.heard ?? this.snap.lastHeardAt });
    this.deps.onRevoked?.();
  }

  // ---- snapshots --------------------------------------------------------------------------------------------------

  /** Runs on every (re)connect and on pull to refresh. Order matters: system.state carries the sequence number. */
  private async loadAll(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const gen = ++this.loadGen;
    this.loading = true;
    this.buffer = [];
    try {
      const snapshot = await this.bootstrap('system.state');
      if (gen !== this.loadGen) return;
      const [reports, activity, actions, deliveries] = await Promise.all([
        this.bootstrap('reports.list', { query: { limit: 100 } }),
        this.bootstrap('activity.list', { query: { limit: 100 } }),
        this.bootstrap('actions.list', { query: { status: 'all' } }),
        this.bootstrap('deliveries.list'),
      ]);
      let device = this.snap.device;
      try { device = await this.bootstrap('devices.self'); } catch (err) { if (this.isAuth(err)) return; /* keep the old record */ }
      if (gen !== this.loadGen) return;

      let state: ClientState = { ...applySnapshot(this.snap.state, snapshot), reports: reports.items, activity: activity.items, actions, deliveries };
      // Events that arrived while the lists were loading: older ones are ignored by the reducer, newer ones apply.
      for (const b of this.buffer) state = applyEvent(state, b.seq, b.event);
      this.loading = false;
      this.buffer = [];
      this.retryDelay = RETRY_BASE_MS;
      const open = client.events.status === 'open';
      if (open && this.unreachableTimer) { clearTimeout(this.unreachableTimer); this.unreachableTimer = null; }
      this.heard = this.now();
      this.set({
        state, device, scopes: device?.scopes ?? this.readyScopes, reportsNext: reports.nextBefore, activityNext: activity.nextBefore,
        lastHeardAt: this.heard, lastError: null, cause: open ? null : this.snap.cause, status: open ? 'connected' : this.snap.status,
      });
    } catch (err) {
      if (gen !== this.loadGen) return;
      this.onLoadFailed(client, err);
    }
  }

  private onLoadFailed(client: MiniSummaClient, err: unknown): void {
    this.loading = false;
    this.buffer = [];
    if (this.snap.status === 'revoked' || !this.wanted) return;
    const hasData = this.snap.state.loaded;
    if (err instanceof ApiError && err.status === 0) {
      // Plain requests do not get through. With no data yet this is the whole story; with data we may just be mid-reconnect.
      if (!hasData) this.set({ status: 'desktop_unreachable', cause: 'no_answer', lastError: null });
      else if (this.snap.status === 'connected') this.set({ status: 'reconnecting', lastHeardAt: this.heard ?? this.snap.lastHeardAt });
      this.startUnreachableTimer();
    } else {
      const message = err instanceof Error ? err.message : String(err);
      this.set({ status: 'desktop_unreachable', cause: 'server_error', lastError: message, lastHeardAt: this.heard ?? this.snap.lastHeardAt });
    }
    // The next `ready` reloads by itself. When the stream is open and only the requests fail, retry with backoff.
    if (client.events.status === 'open') this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.wanted) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.wanted) void this.loadAll(); }, delay);
  }

  async refresh(): Promise<void> {
    if (!this.client || this.snap.status === 'revoked') return;
    this.set({ refreshing: true });
    try { await this.loadAll(); } finally { this.set({ refreshing: false }); }
  }

  async loadMoreReports(): Promise<void> {
    const before = this.snap.reportsNext;
    if (!before) return;
    const page = await this.bootstrap('reports.list', { query: { before, limit: 50 } });
    const have = new Set(this.snap.state.reports.map((r) => r.id));
    this.set({
      state: { ...this.snap.state, reports: [...this.snap.state.reports, ...page.items.filter((r) => !have.has(r.id))] },
      reportsNext: page.nextBefore,
    });
  }

  async loadMoreActivity(): Promise<void> {
    const before = this.snap.activityNext;
    if (!before) return;
    const page = await this.bootstrap('activity.list', { query: { before, limit: 50 } });
    const have = new Set(this.snap.state.activity.map((a) => a.id));
    this.set({
      state: { ...this.snap.state, activity: [...this.snap.state.activity, ...page.items.filter((a) => !have.has(a.id))] },
      activityNext: page.nextBefore,
    });
  }

  // ---- calls ------------------------------------------------------------------------------------------------------

  /** Typed API call. A 401 means the token is gone. A 403 is usually a missing scope, so it is double checked. */
  call = (async (name: RouteName, ...args: unknown[]) => {
    const client = this.client;
    if (!client) throw new ApiError(0, 'not_connected', 'Not connected to your PC yet.');
    try {
      return await (client.call as (n: RouteName, ...a: unknown[]) => Promise<unknown>)(name, ...args);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) this.markRevoked();
        else if (err.status === 403) void this.verifyStillPaired();
      }
      throw err;
    }
  }) as MiniSummaClient['call'];

  /** Calls that every paired phone is allowed to make (read scope). A 403 here means the phone itself was removed. */
  private async bootstrap<K extends RouteName>(name: K, input?: RouteInput<K>): Promise<RouteOutput<K>> {
    const client = this.client;
    if (!client) throw new ApiError(0, 'not_connected', 'Not connected to your PC yet.');
    try {
      return await (client.call as (n: RouteName, i?: unknown) => Promise<unknown>)(name, input) as RouteOutput<K>;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) this.markRevoked();
      throw err;
    }
  }

  private isAuth = (err: unknown): boolean => err instanceof ApiError && (err.status === 401 || err.status === 403);

  /** After a 403 on an action: if the device record is still readable the phone is fine and only lacks a scope. */
  private async verifyStillPaired(): Promise<void> {
    try {
      const device = await this.bootstrap('devices.self');
      this.set({ device, scopes: device.scopes });
    } catch { /* bootstrap() already handled revocation; anything else is ignored */ }
  }

  // ---- local updates ----------------------------------------------------------------------------------------------

  /** Put an action the phone just created (or a response to one) into state without waiting for the event. */
  upsertAction(action: PendingAction): void {
    const list = this.snap.state.actions;
    const i = list.findIndex((a) => a.id === action.id);
    const actions = i >= 0 ? list.map((a, k) => (k === i ? action : a)) : [action, ...list];
    this.set({ state: { ...this.snap.state, actions } });
  }

  upsertReport(report: ReportSummary): void {
    const list = this.snap.state.reports;
    const i = list.findIndex((r) => r.id === report.id);
    const reports = i >= 0 ? list.map((r, k) => (k === i ? report : r)) : [report, ...list];
    this.set({ state: { ...this.snap.state, reports } });
  }
}
