// Client SDK for the Mini-Summa core API. It uses only fetch and WebSocket, so the same code runs in the Electron
// renderer, the Android app (Hermes), the browser extension service worker and Node tests (pass `WebSocket` from `ws`).
import type { ClientMessage, ServerEvent, ServerMessage, Topic } from './events.ts';
import { ALL_TOPICS } from './events.ts';
import { API_PREFIX, buildPath, routes } from './routes.ts';
import type { RouteInput, RouteName, RouteOutput } from './routes.ts';
import type { SessionKey } from './env.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The WebSocket surface used here exists unchanged in browsers, React Native and the `ws` package. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface ClientOptions {
  baseUrl: string;
  token: string;
  /** Sent in the WebSocket hello and logged by the core. */
  clientName?: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
}

export interface CallOptions {
  /** Reuse the same key when retrying a create so the core can recognise the repeat. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

type CallArgs<K extends RouteName> = {} extends RouteInput<K> ? [input?: RouteInput<K>, opts?: CallOptions] : [input: RouteInput<K>, opts?: CallOptions];

export function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function toQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

interface ReadyInfo { seq: number; resync: boolean }

/** Numbered state events plus the terminal channel, over a single self-healing WebSocket. */
export class EventStream {
  status: StreamStatus = 'idle';
  lastSeq = 0;
  private ws: WebSocketLike | null = null;
  private wanted = false;
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastRx = 0;
  private topics: Topic[] = ALL_TOPICS;
  private readonly eventHandlers = new Set<(seq: number, event: ServerEvent, topic: Topic) => void>();
  private readonly statusHandlers = new Set<(status: StreamStatus) => void>();
  private readonly readyHandlers = new Set<(info: ReadyInfo) => void>();
  private readonly messageHandlers = new Set<(msg: ServerMessage) => void>();
  private readonly errorHandlers = new Set<(code: string, message: string, fatal: boolean) => void>();

  constructor(private readonly opts: { baseUrl: string; token: string; clientName: string; WebSocket?: WebSocketCtor }) {}

  connect(topics?: Topic[]): void {
    if (topics) this.topics = topics;
    this.wanted = true;
    if (this.ws) return;
    this.open(this.lastSeq === 0 ? 'connecting' : 'reconnecting');
  }

  close(): void {
    this.wanted = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000, 'client closed'); } catch { /* already closed */ }
    this.setStatus('closed');
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1 || this.status !== 'open') return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  onEvent(h: (seq: number, event: ServerEvent, topic: Topic) => void): () => void { this.eventHandlers.add(h); return () => this.eventHandlers.delete(h); }
  onStatus(h: (status: StreamStatus) => void): () => void { this.statusHandlers.add(h); return () => this.statusHandlers.delete(h); }
  /** Fired after every successful (re)connect. `resync` means events were missed and snapshots must be reloaded. */
  onReady(h: (info: ReadyInfo) => void): () => void { this.readyHandlers.add(h); return () => this.readyHandlers.delete(h); }
  onMessage(h: (msg: ServerMessage) => void): () => void { this.messageHandlers.add(h); return () => this.messageHandlers.delete(h); }
  onError(h: (code: string, message: string, fatal: boolean) => void): () => void { this.errorHandlers.add(h); return () => this.errorHandlers.delete(h); }

  private setStatus(s: StreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  private wsUrl(): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '').replace(/^http/i, 'ws')}/ws`;
  }

  private open(initial: StreamStatus): void {
    const Ctor = this.opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new Error('No WebSocket implementation is available. Pass options.WebSocket.');
    this.setStatus(initial);
    let ws: WebSocketLike;
    try { ws = new Ctor(this.wsUrl()); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      const hello: ClientMessage = { t: 'hello', token: this.opts.token, client: this.opts.clientName, topics: this.topics, ...(this.lastSeq ? { since: this.lastSeq } : {}) };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      this.lastRx = Date.now();
      let msg: ServerMessage;
      try { msg = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      if (msg.t === 'ready') {
        this.backoff = 500;
        this.lastSeq = msg.seq;
        this.setStatus('open');
        this.startPing();
        for (const h of this.readyHandlers) h({ seq: msg.seq, resync: msg.resync });
      } else if (msg.t === 'event') {
        if (msg.seq <= this.lastSeq) return; // replay overlap
        this.lastSeq = msg.seq;
        for (const h of this.eventHandlers) h(msg.seq, msg.event, msg.topic);
      } else if (msg.t === 'error') {
        for (const h of this.errorHandlers) h(msg.code, msg.message, Boolean(msg.fatal));
        if (msg.fatal) { this.wanted = false; }
      }
      for (const h of this.messageHandlers) h(msg);
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      if (this.wanted) this.scheduleReconnect(); else this.setStatus('closed');
    };
    ws.onerror = () => { /* onclose follows and handles the retry */ };
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.lastRx = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastRx > 70_000) { try { this.ws?.close(4000, 'stale'); } catch { /* closing anyway */ } return; }
      this.send({ t: 'ping' });
    }, 25_000);
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer) return;
    this.setStatus('reconnecting');
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted && !this.ws) this.open('reconnecting');
    }, delay);
  }
}

export interface TerminalHandlers {
  /** Called on attach and again after every reconnect. Reset the terminal, then write `replay`. */
  onAttached(info: { replay: string; seq: number; cols: number; rows: number }): void;
  onData(data: string): void;
  onExit(info: { code: number | null; signal: number | null; at: string; reason: string }): void;
  onError(code: string, message: string): void;
}

export interface TerminalHandle {
  readonly key: SessionKey;
  input(data: string): boolean;
  resize(cols: number, rows: number): void;
  detach(): void;
}

/** Terminal multiplexing over the EventStream. Requires the `desktop` scope on the server. */
export class TerminalClient {
  private readonly attached = new Map<SessionKey, { handlers: TerminalHandlers; cols: number; rows: number; seq: number }>();

  constructor(private readonly stream: EventStream) {
    stream.onMessage((m) => this.dispatch(m));
    stream.onReady(() => {
      // After a reconnect every attached terminal is attached again; the server replays its scrollback.
      for (const [key, a] of this.attached) this.stream.send({ t: 'term.attach', key, cols: a.cols, rows: a.rows });
    });
  }

  attach(key: SessionKey, size: { cols: number; rows: number }, handlers: TerminalHandlers): TerminalHandle {
    this.attached.set(key, { handlers, cols: size.cols, rows: size.rows, seq: 0 });
    this.stream.send({ t: 'term.attach', key, cols: size.cols, rows: size.rows });
    return {
      key,
      input: (data) => this.stream.send({ t: 'term.input', key, data }),
      resize: (cols, rows) => {
        const a = this.attached.get(key);
        if (a) { a.cols = cols; a.rows = rows; }
        this.stream.send({ t: 'term.resize', key, cols, rows });
      },
      detach: () => {
        this.attached.delete(key);
        this.stream.send({ t: 'term.detach', key });
      },
    };
  }

  private dispatch(m: ServerMessage): void {
    if (m.t === 'term.attached') {
      const a = this.attached.get(m.key);
      if (a) { a.seq = m.seq; a.handlers.onAttached({ replay: m.replay, seq: m.seq, cols: m.cols, rows: m.rows }); }
    } else if (m.t === 'term.data') {
      const a = this.attached.get(m.key);
      if (a && m.seq > a.seq) { a.seq = m.seq; a.handlers.onData(m.data); }
    } else if (m.t === 'term.exit') {
      this.attached.get(m.key)?.handlers.onExit({ code: m.code, signal: m.signal, at: m.at, reason: m.reason });
    } else if (m.t === 'term.error') {
      this.attached.get(m.key)?.handlers.onError(m.code, m.message);
    }
  }
}

export class MiniSummaClient {
  readonly baseUrl: string;
  readonly events: EventStream;
  readonly terminal: TerminalClient;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.events = new EventStream({ baseUrl: this.baseUrl, token: opts.token, clientName: opts.clientName ?? 'client', WebSocket: opts.WebSocket });
    this.terminal = new TerminalClient(this.events);
  }

  /** Typed call into the route table. Path parameters, query and body are checked against the route definition. */
  async call<K extends RouteName>(name: K, ...args: CallArgs<K>): Promise<RouteOutput<K>> {
    const input = (args[0] ?? {}) as { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };
    const opts = (args[1] ?? {}) as CallOptions;
    const def = routes[name] as { method: string; path: string; scope: string; idempotent?: boolean; body?: unknown };
    const url = `${this.baseUrl}${API_PREFIX}${buildPath(def.path, input.params)}${toQuery(input.query)}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (def.scope !== 'public') headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (def.method !== 'GET' && def.method !== 'DELETE') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(input.body ?? {});
    }
    if (def.idempotent) headers['idempotency-key'] = opts.idempotencyKey ?? randomId();

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: def.method, headers, body, signal: ctl.signal });
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      throw new ApiError(0, aborted ? 'timeout' : 'network', aborted ? 'The request timed out.' : `Could not reach the Mini-Summa core: ${(err as Error)?.message ?? err}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const textBody = await res.text();
    let json: unknown = null;
    if (textBody) { try { json = JSON.parse(textBody); } catch { /* not JSON */ } }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? `Request failed with status ${res.status}`, e?.details);
    }
    return json as RouteOutput<K>;
  }

  close(): void { this.events.close(); }
}
