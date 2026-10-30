// The persistent connection to the Mini-Summa core: hello, ready, bridge requests and results, ping, reconnect.
// Written against small interfaces (a WebSocket constructor, a clock, a store) so the unit tests can drive it
// deterministically; background.ts wires in the real browser objects.
import type { ClientMessage } from '@minisumma/shared';
import type { BridgeOutcome } from './bridge.ts';
import { wsUrlOf } from './core-address.ts';
import type { ConnectionStatus } from './status.ts';
import type { StoredState } from './storage.ts';

export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
/** The service worker sleeps after 30 s without events; traffic on an open WebSocket counts, so ping inside that. */
export const PING_EVERY_MS = 25_000;
export const STALE_AFTER_MS = 70_000;
/** Close code the core uses when the device behind this token was revoked. */
export const CLOSE_REVOKED = 4003;
export const CLOSE_STALE = 4000;
const SOCKET_OPEN = 1;

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketCtor = new (url: string) => SocketLike;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export interface ConnectionDeps {
  WebSocket: SocketCtor;
  store: { load(): Promise<StoredState>; markRevoked(): Promise<void> };
  bridge: { handle(action: unknown): Promise<BridgeOutcome> };
  clock?: Clock;
  onStatus?: (status: ConnectionStatus) => void;
}

interface Credentials { coreUrl: string; token: string }

const sameCredentials = (a: Credentials | null, b: Credentials | null): boolean =>
  a === b || (a !== null && b !== null && a.coreUrl === b.coreUrl && a.token === b.token);

export class CoreConnection {
  private readonly clock: Clock;
  private creds: Credentials | null = null;
  private socket: SocketLike | null = null;
  private opened = false;
  private ready = false;
  private lastRx = 0;
  private backoff = BACKOFF_START_MS;
  private attempt = 0;
  private lastServerError: string | null = null;
  /** A token the core answered with close code 4003. It is never presented again, whatever the stored state says. */
  private revokedToken: string | null = null;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private current: ConnectionStatus;

  constructor(private readonly deps: ConnectionDeps) {
    this.clock = deps.clock ?? realClock;
    this.current = { state: 'not_paired', since: this.clock.now(), coreUrl: '' };
  }

  status(): ConnectionStatus { return this.current; }

  /** True while there is a token to connect with. The background worker keeps its heartbeat alarm only then. */
  isPaired(): boolean { return this.creds !== null; }

  start(): Promise<void> { return this.reload(); }

  /** Re-read the stored credentials and (re)connect, disconnect or do nothing, whichever the change calls for. */
  reload(): Promise<void> {
    this.queue = this.queue.then(() => this.applyStored());
    return this.queue;
  }

  /** Called from the chrome.alarms heartbeat: reconnect if nothing is running, drop a silent socket, otherwise ping. */
  heartbeat(): void {
    if (!this.creds) return;
    if (!this.socket) { if (this.retryTimer === null) this.connect(); return; }
    this.checkAlive();
  }

  /** Close everything and stop reconnecting. */
  stop(): void {
    this.teardown();
    this.creds = null;
    this.setStatus({ state: 'not_paired', since: this.clock.now(), coreUrl: this.current.coreUrl });
  }

  private async applyStored(): Promise<void> {
    let stored: StoredState;
    try { stored = await this.deps.store.load(); } catch { return; }
    const usable = stored.token !== null && stored.token !== this.revokedToken;
    const next: Credentials | null = usable && stored.token ? { coreUrl: stored.coreUrl, token: stored.token } : null;
    if (sameCredentials(next, this.creds)) {
      if (!next) this.setIdle(stored);
      else if (!this.socket && this.retryTimer === null) this.connect();
      return;
    }
    this.teardown();
    this.creds = next;
    this.backoff = BACKOFF_START_MS;
    this.attempt = 0;
    if (!next) { this.setIdle(stored); return; }
    this.connect();
  }

  private setIdle(stored: StoredState): void {
    const state = stored.revokedAt !== null ? 'revoked' : 'not_paired';
    if (this.current.state === state && this.current.coreUrl === stored.coreUrl) return;
    this.setStatus({ state, since: this.clock.now(), coreUrl: stored.coreUrl });
  }

  private setStatus(status: ConnectionStatus): void {
    this.current = status;
    this.deps.onStatus?.(status);
  }

  private connect(): void {
    const creds = this.creds;
    if (!creds) return;
    this.attempt += 1;
    this.setStatus({ state: 'connecting', since: this.clock.now(), coreUrl: creds.coreUrl, attempt: this.attempt });
    let ws: SocketLike;
    try {
      ws = new this.deps.WebSocket(wsUrlOf(creds.coreUrl));
    } catch {
      this.scheduleRetry('The address could not be used for a connection.');
      return;
    }
    this.socket = ws;
    this.opened = false;
    this.ready = false;
    this.lastServerError = null;
    // A connect that never completes counts as silence too; the heartbeat alarm drops it after STALE_AFTER_MS.
    this.lastRx = this.clock.now();
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.opened = true;
      this.lastRx = this.clock.now();
      const hello: ClientMessage = { t: 'hello', token: creds.token, client: 'browser-extension', topics: [] };
      ws.send(JSON.stringify(hello));
      this.startTimer();
    };
    ws.onmessage = (ev) => { if (this.socket === ws) this.onMessage(ws, creds, ev.data); };
    ws.onclose = (ev) => { if (this.socket === ws) this.onClose(ws, creds, ev?.code); };
    ws.onerror = () => { /* a close event always follows and decides what happens next */ };
  }

  private onMessage(ws: SocketLike, creds: Credentials, data: unknown): void {
    this.lastRx = this.clock.now();
    let msg: { t?: unknown; [k: string]: unknown };
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (typeof msg !== 'object' || msg === null) return;
    switch (msg.t) {
      case 'ready': {
        this.ready = true;
        this.backoff = BACKOFF_START_MS;
        this.attempt = 0;
        const scopes = Array.isArray(msg.scopes) ? msg.scopes.filter((s): s is string => typeof s === 'string') : [];
        this.setStatus({ state: 'connected', since: this.clock.now(), coreUrl: creds.coreUrl, scopes, canAnswer: scopes.includes('extension') });
        break;
      }
      case 'bridge.request':
        void this.answer(ws, msg.requestId, msg.action);
        break;
      case 'error':
        // The close that follows decides what happens; keep the sentence for the status line.
        this.lastServerError = typeof msg.message === 'string' ? msg.message : null;
        break;
      default:
        break; // pong and anything else only count as activity
    }
  }

  private async answer(ws: SocketLike, requestId: unknown, action: unknown): Promise<void> {
    if (typeof requestId !== 'string' || requestId === '') return;
    let outcome: BridgeOutcome;
    try { outcome = await this.deps.bridge.handle(action); } catch { outcome = { ok: false, error: 'The extension failed while handling the request.' }; }
    if (this.socket !== ws || ws.readyState !== SOCKET_OPEN) return; // the connection moved on; the core times the request out
    const reply: ClientMessage = outcome.ok
      ? { t: 'bridge.result', requestId, ok: true, data: outcome.data }
      : { t: 'bridge.result', requestId, ok: false, error: outcome.error };
    ws.send(JSON.stringify(reply));
  }

  private onClose(ws: SocketLike, creds: Credentials, code: number | undefined): void {
    this.stopTimer();
    this.socket = null;
    const wasOpen = this.opened;
    this.opened = false;
    this.ready = false;
    if (code === CLOSE_REVOKED) { void this.onRevoked(creds); return; }
    this.scheduleRetry(this.lastServerError ?? (wasOpen ? 'The connection to Mini-Summa was closed.' : null));
  }

  private async onRevoked(creds: Credentials): Promise<void> {
    this.teardown();
    this.creds = null;
    this.revokedToken = creds.token;
    // Status first so a page asking right now already sees the truth; the stored marker keeps it across restarts.
    this.setStatus({ state: 'revoked', since: this.clock.now(), coreUrl: creds.coreUrl });
    try { await this.deps.store.markRevoked(); } catch { /* the in-memory state above still stops reconnects */ }
  }

  private scheduleRetry(detail: string | null): void {
    const creds = this.creds;
    if (!creds) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    const now = this.clock.now();
    const since = this.current.state === 'unreachable' ? this.current.since : now;
    this.setStatus({ state: 'unreachable', since, coreUrl: creds.coreUrl, attempt: this.attempt, retryAt: now + delay, detail });
    this.clearRetry();
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.creds && !this.socket) this.connect();
    }, delay);
  }

  private startTimer(): void {
    this.stopTimer();
    this.pingTimer = this.clock.setInterval(() => this.checkAlive(), PING_EVERY_MS);
  }

  private stopTimer(): void {
    if (this.pingTimer !== null) this.clock.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Drop a socket that has been silent too long (a half open connection after sleep never reports a close), else ping. */
  private checkAlive(): void {
    const ws = this.socket;
    if (!ws) return;
    if (this.clock.now() - this.lastRx > STALE_AFTER_MS) {
      this.detach(ws, CLOSE_STALE, 'stale');
      this.stopTimer();
      this.socket = null;
      this.scheduleRetry('Mini-Summa stopped answering.');
      return;
    }
    if (this.ready && ws.readyState === SOCKET_OPEN) {
      const ping: ClientMessage = { t: 'ping' };
      try { ws.send(JSON.stringify(ping)); } catch { /* the close event handles it */ }
    }
  }

  private detach(ws: SocketLike, code?: number, reason?: string): void {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  private teardown(): void {
    this.clearRetry();
    this.stopTimer();
    const ws = this.socket;
    this.socket = null;
    this.opened = false;
    this.ready = false;
    if (ws) this.detach(ws, 1000, 'client closed');
  }
}
