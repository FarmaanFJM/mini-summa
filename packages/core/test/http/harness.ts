// Test harness for the HTTP/WebSocket server: a real server on port 0, a real in-memory database and bus, small fakes
// typed against the contract interfaces (never the real services, which other workers are still writing).
import http from 'node:http';
import { WebSocket } from 'ws';
import { defaultSettings } from '@minisumma/shared';
import type { ActorRef, Device, NativeBridge, PairingOffer, Scope, ServerEvent, ServerMessage, Settings, SystemInfo } from '@minisumma/shared';
import { openDatabase } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import { createEventBus } from '../../src/bus.ts';
import type { Clock, CoreBase, DevicesService, EventBus, Logger, Principal, PushProvider } from '../../src/contracts.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { HttpServer, HttpServices, HttpTuning } from '../../src/http/server.ts';

export type { HttpServices } from '../../src/http/server.ts';

// ---------------------------------------------------------------------------------------------------------------
// Recording logger and controllable clock

export interface LogEntry { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }

export function recordingLogger(): { log: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const add = (level: LogEntry['level']) => (msg: string, data?: Record<string, unknown>) => { entries.push({ level, msg, data }); };
  return { log: { debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error') }, entries };
}

export interface TestClock extends Clock { set(ms: number): void; advance(ms: number): void }
export function testClock(startMs = Date.parse('2026-10-30T12:00:00.000Z')): TestClock {
  let t = startMs;
  return { now: () => new Date(t), set: (ms) => { t = ms; }, advance: (ms) => { t += ms; } };
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-stubbed services: any method that is not given returns `{ stub: '<service>.<method>' }` and is recorded.

export interface Call { service: string; method: string; args: unknown[] }

export function autoStub<T extends object>(label: string, impl: Record<string, unknown> = {}, calls?: Call[]): T {
  const cache = new Map<string, unknown>();
  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) {
        const v = target[prop];
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => { calls?.push({ service: label, method: prop, args }); return (v as (...a: unknown[]) => unknown)(...args); };
      }
      if (prop === 'then' || prop === 'toJSON') return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn = (...args: unknown[]) => { calls?.push({ service: label, method: prop, args }); return { stub: `${label}.${prop}` }; };
        cache.set(prop, fn);
      }
      return fn;
    },
  }) as unknown as T;
}

// ---------------------------------------------------------------------------------------------------------------
// Fake DevicesService with a token table

export type PrincipalSpec = Omit<Principal, 'via'>;

export class FakeDevices implements DevicesService {
  readonly desktopToken = 'desktop-token-0123456789abcdef';
  readonly principals = new Map<string, PrincipalSpec>();
  readonly devices = new Map<string, Device>();
  readonly authCalls: { via: Principal['via'] }[] = [];
  readonly pushRegistrations: { deviceId: string; provider: 'fcm'; token: string }[] = [];
  readonly redeemCalls: { req: Parameters<DevicesService['redeem']>[0]; via: Principal['via'] }[] = [];
  redeemImpl: (() => ReturnType<DevicesService['redeem']>) | null = null;
  constructor(private readonly bus: EventBus | null = null) {
    this.principals.set(this.desktopToken, { kind: 'desktop', deviceId: null, name: 'Desktop', scopes: ['desktop'], trusted: true });
  }

  addDevice(token: string, id: string, scopes: Scope[], opts: { name?: string; kind?: Principal['kind']; trusted?: boolean } = {}): void {
    const name = opts.name ?? `Device ${id}`;
    this.principals.set(token, { kind: opts.kind ?? (scopes.includes('extension') ? 'extension' : 'device'), deviceId: id, name, scopes, trusted: opts.trusted ?? false });
    this.devices.set(id, {
      id, name, platform: 'android', scopes, trusted: opts.trusted ?? false, pushRegistered: false,
      createdAt: '2026-10-30T00:00:00.000Z', lastSeenAt: null, lastSeenVia: null, revokedAt: null,
    });
  }

  authenticate(token: string, via: Principal['via']): Principal | null {
    this.authCalls.push({ via });
    const p = this.principals.get(token);
    return p ? { ...p, scopes: [...p.scopes], via } : null;
  }

  createOffer(scopes: Scope[], urls: string[], kind: 'phone' | 'extension'): PairingOffer {
    return { id: 'offer1', code: 'code-one-time', expiresAt: '2026-10-30T12:10:00.000Z', scopes, urls, qrPayload: `minisumma://pair?kind=${kind}` };
  }

  redeem(req: Parameters<DevicesService['redeem']>[0], via: Principal['via']): ReturnType<DevicesService['redeem']> {
    this.redeemCalls.push({ req, via });
    if (this.redeemImpl) return this.redeemImpl();
    return {
      device: this.devices.get('phone') ?? { id: 'new', name: req.deviceName, platform: req.platform, scopes: ['read'], trusted: false, pushRegistered: false, createdAt: '2026-10-30T12:00:00.000Z', lastSeenAt: null, lastSeenVia: via, revokedAt: null },
      token: 'issued-token-should-only-appear-in-the-redeem-response',
      server: { name: 'mini-summa-core', apiVersion: 1 },
    };
  }

  list(): Device[] { return [...this.devices.values()]; }
  get(id: string): Device | null { return this.devices.get(id) ?? null; }
  update(id: string, patch: { name?: string; trusted?: boolean; scopes?: Scope[] }): Device {
    const d = this.devices.get(id);
    if (!d) throw new Error(`no device ${id}`);
    const next: Device = { ...d, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.trusted !== undefined ? { trusted: patch.trusted } : {}), ...(patch.scopes ? { scopes: patch.scopes } : {}) };
    this.devices.set(id, next);
    this.bus?.emit({ type: 'device.upserted', device: next });
    return next;
  }
  revoke(id: string): void {
    const d = this.devices.get(id);
    if (!d) throw new Error(`no device ${id}`);
    const next: Device = { ...d, revokedAt: '2026-10-30T12:30:00.000Z' };
    this.devices.set(id, next);
    for (const [token, p] of this.principals) if (p.deviceId === id) this.principals.delete(token);
    this.bus?.emit({ type: 'device.upserted', device: next });
  }
  registerPush(deviceId: string, provider: 'fcm', token: string): void { this.pushRegistrations.push({ deviceId, provider, token }); }
  clearPushToken(): void { /* not used */ }
  pushTargets(): { deviceId: string; provider: 'fcm'; token: string; projectIds: 'all' }[] { return []; }
  actorOf(principal: Principal): ActorRef {
    return principal.kind === 'desktop' || principal.deviceId === null ? { kind: 'desktop' } : { kind: 'device', deviceId: principal.deviceId, name: principal.name };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The harness

export interface HarnessOptions {
  /** Per-service method overrides on top of the auto stubs. */
  overrides?: Partial<Record<Exclude<keyof HttpServices, 'devices' | 'push'>, Record<string, unknown>>>;
  push?: PushProvider | null;
  uiDir?: string;
  publicUrl?: string | null;
  native?: NativeBridge;
  tuning?: Partial<HttpTuning>;
  busCapacity?: number;
  port?: number;
  /** Do not start the server; the caller does. */
  noStart?: boolean;
}

export interface Harness {
  base: CoreBase;
  bus: EventBus;
  db: Db;
  clock: TestClock;
  logs: LogEntry[];
  calls: Call[];
  services: HttpServices;
  devices: FakeDevices;
  server: HttpServer;
  port: number;
  baseUrl: string;
  wsUrl: string;
  tokens: { desktop: string; read: string; notify: string; prompt: string; approve: string; extension: string; readExtension: string; none: string };
  settings: { current: Settings };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const SYSTEM_INFO: SystemInfo = {
  name: 'mini-summa-core', version: '0.0.0-test', apiVersion: 1, mode: 'headless', platform: 'linux', startedAt: '2026-10-30T11:00:00.000Z',
  nativeCapabilities: { clipboard: false, chatgptEmbedded: false, extensionBridge: false, notifications: false, openExternal: false, saveFile: false },
};

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const { db } = openDatabase(':memory:');
  const bus = createEventBus(opts.busCapacity);
  const clock = testClock();
  const { log, entries } = recordingLogger();
  const base: CoreBase = { db, bus, clock, log, version: '0.0.0-test', mode: 'headless', dataDir: '/nonexistent/mini-summa-test' };
  const calls: Call[] = [];
  const devices = new FakeDevices(bus);
  const tokens = {
    desktop: devices.desktopToken, read: 'read-token-000000000001', notify: 'notify-token-0000000002', prompt: 'prompt-token-000000003',
    approve: 'approve-token-00000004', extension: 'extension-token-0000005', readExtension: 'read-ext-token-0000006', none: 'not-a-token-of-any-device',
  };
  devices.addDevice(tokens.read, 'dev-read', ['read']);
  devices.addDevice(tokens.notify, 'dev-notify', ['notify']);
  devices.addDevice(tokens.prompt, 'dev-prompt', ['prompt']);
  devices.addDevice(tokens.approve, 'dev-approve', ['approve']);
  devices.addDevice(tokens.extension, 'dev-ext', ['extension']);
  devices.addDevice(tokens.readExtension, 'dev-readext', ['read', 'extension']);
  // A device the matrix may update and revoke without taking the other tokens away.
  devices.addDevice('victim-token-0000000000007', 'dev-victim', ['read']);

  const settings = { current: defaultSettings() };
  const o = opts.overrides ?? {};
  const stub = <T extends object>(label: Exclude<keyof HttpServices, 'devices' | 'push'>, impl: Record<string, unknown> = {}) =>
    autoStub<T>(label, { ...impl, ...(o[label] ?? {}) }, calls);
  const services = {
    settings: stub('settings', { get: () => settings.current, update: (patch: unknown) => { calls.push({ service: 'settings.patch', method: 'update', args: [patch] }); return settings.current; } }),
    projects: stub('projects', { list: () => [], conversations: autoStub('projects.conversations', { list: () => [] }, calls) }),
    sessions: stub('sessions', { list: () => [], terminal: autoStub('sessions.terminal', { attach: () => ({ error: 'No terminal here.' }), input: () => false, resize: () => undefined }, calls) }),
    environments: stub('environments', { list: async () => [] }),
    activity: stub('activity'),
    notifications: stub('notifications'),
    reports: stub('reports'),
    deliveries: stub('deliveries'),
    actions: stub('actions'),
    devices,
    hooks: stub('hooks', { list: async () => [] }),
    tailscale: stub('tailscale', { publicUrl: () => opts.publicUrl ?? null }),
    data: stub('data'),
    push: opts.push ?? null,
  } as unknown as HttpServices;

  const server = createHttpServer({
    base, port: opts.port ?? 0, uiDir: opts.uiDir, services, native: opts.native, tuning: opts.tuning,
    counts: () => ({ unreadActivity: 1, actionsNeeded: 2, pendingActions: 3, reportsAwaitingHandoff: 4, liveSessions: 5 }),
    system: () => SYSTEM_INFO,
  });

  const h: Harness = {
    base, bus, db, clock, logs: entries, calls, services, devices, server, port: 0, baseUrl: '', wsUrl: '', tokens, settings,
    async start() {
      const started = await server.start();
      h.port = started.port;
      h.baseUrl = started.baseUrl;
      h.wsUrl = `ws://127.0.0.1:${started.port}/ws`;
    },
    async stop() { await server.stop(); db.close(); },
  };
  if (!opts.noStart) await h.start();
  return h;
}

// ---------------------------------------------------------------------------------------------------------------
// Raw HTTP: node:http does not normalise the path or forbid any header, so traversal and Host/Origin tests are honest.

export interface RawResponse { status: number; headers: http.IncomingHttpHeaders; text: string; json: <T = any>() => T }

export function raw(port: number, req: { method?: string; path: string; headers?: Record<string, string | undefined>; body?: string | Buffer }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (v !== undefined) headers[k] = v;
    if (req.body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
    // agent: false = a fresh connection per request, so one test's closed socket cannot be reused by the next
    const r = http.request({ host: '127.0.0.1', port, agent: false, method: req.method ?? 'GET', path: req.path, headers, setHost: headers.host === undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: <T,>() => JSON.parse(text) as T });
      });
    });
    r.on('error', reject);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/** JSON API call with a bearer token, through raw http so any header can be set. */
export function api(h: Pick<Harness, 'port'>, method: string, path: string, opts: { token?: string | null; body?: unknown; headers?: Record<string, string | undefined> } = {}): Promise<RawResponse> {
  const headers: Record<string, string | undefined> = { accept: 'application/json', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
  return raw(h.port, { method, path: `/api/v1${path}`, headers, body });
}

// ---------------------------------------------------------------------------------------------------------------
// WebSocket client wrapper with a message queue

export class WsClient {
  /** Messages not yet consumed by next()/nextOfType()/nextEvent(). */
  readonly messages: ServerMessage[] = [];
  /** Every message in order of arrival, consumed or not. */
  readonly arrivals: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.arrivals.push(msg);
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) { const [w] = this.waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); } else this.messages.push(msg);
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.closeWaiters.splice(0)) w(this.closed);
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(`socket closed (${code}) while waiting for a message`)); }
    });
    ws.on('error', () => { /* close follows */ });
  }

  send(msg: unknown): void { this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }

  /** Resolves with the first not-yet-consumed message matching the predicate (messages already received count). */
  next<T extends ServerMessage = ServerMessage>(match: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<T> {
    const idx = this.messages.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0] as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timed out waiting for a message; received so far: ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      this.waiters.push({ match, resolve: resolve as (m: ServerMessage) => void, reject, timer });
    });
  }

  nextOfType<T extends ServerMessage['t']>(t: T, timeoutMs?: number): Promise<Extract<ServerMessage, { t: T }>> {
    return this.next((m) => m.t === t, timeoutMs) as Promise<Extract<ServerMessage, { t: T }>>;
  }

  nextEvent(type?: ServerEvent['type'], timeoutMs?: number): Promise<Extract<ServerMessage, { t: 'event' }>> {
    return this.next((m) => m.t === 'event' && (type === undefined || m.event.type === type), timeoutMs) as Promise<Extract<ServerMessage, { t: 'event' }>>;
  }

  waitClosed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the socket to close')), timeoutMs);
      this.closeWaiters.push((c) => { clearTimeout(timer); resolve(c); });
    });
  }

  /** Messages of an event type currently in the queue (not consumed). */
  events(type?: ServerEvent['type']): Extract<ServerMessage, { t: 'event' }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { t: 'event' }> => m.t === 'event' && (type === undefined || m.event.type === type));
  }

  close(): void { try { this.ws.close(); } catch { /* already closed */ } }
}

export function openWs(h: Pick<Harness, 'wsUrl'>, opts: { headers?: Record<string, string>; origin?: string } = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(h.wsUrl, { headers: opts.headers, origin: opts.origin });
    const client = new WsClient(ws);
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`handshake refused with ${res.statusCode}`), { status: res.statusCode })));
  });
}

/** Connects and completes the hello. Returns the client and its `ready` message. */
export async function connectWs(h: Pick<Harness, 'wsUrl'>, token: string, hello: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; origin?: string } = {}) {
  const client = await openWs(h, opts);
  client.send({ t: 'hello', token, client: 'test', ...hello });
  const ready = await client.nextOfType('ready');
  return { client, ready };
}

/** Sleep helper for "nothing arrives" assertions. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// Event builders and a fake terminal layer

export const ev = {
  notice: (message = 'notice'): ServerEvent => ({ type: 'system.notice', level: 'info', message }),
  counts: (): ServerEvent => ({ type: 'counts', counts: { unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 0 } }),
  session: (key = 'posix|s1'): ServerEvent => ({ type: 'session.upserted', session: { key } as unknown as import('@minisumma/shared').SessionView }),
  activity: (id = 'a1'): ServerEvent => ({ type: 'activity.added', activity: { id } as unknown as import('@minisumma/shared').ActivityEvent }),
  deviceUpserted: (device: Device): ServerEvent => ({ type: 'device.upserted', device }),
  deviceRemoved: (id: string): ServerEvent => ({ type: 'device.removed', id }),
  settings: (): ServerEvent => ({ type: 'settings.changed', settings: defaultSettings() }),
  hooks: (): ServerEvent => ({ type: 'hooks.changed', env: 'posix', status: { env: 'posix' } as unknown as import('@minisumma/shared').HookStatus }),
  tailscale: (): ServerEvent => ({ type: 'tailscale.changed', status: { installed: true } as unknown as import('@minisumma/shared').TailscaleStatus }),
};

export interface FakeTerminal {
  sinks: Map<string, import('../../src/contracts.ts').TerminalSink>;
  attached: string[];
  detached: string[];
  inputs: [string, string][];
  resizes: [string, number, number][];
  /** Called inside attach() before it returns, to simulate output produced while attaching. */
  duringAttach: ((sink: import('../../src/contracts.ts').TerminalSink) => void) | null;
  attachSeq: number;
  api: Record<string, unknown>;
}

export function fakeTerminal(): FakeTerminal {
  const t: FakeTerminal = { sinks: new Map(), attached: [], detached: [], inputs: [], resizes: [], duringAttach: null, attachSeq: 5, api: {} };
  t.api = {
    attach: (key: string, size: { cols: number; rows: number }, sink: import('../../src/contracts.ts').TerminalSink) => {
      if (key.endsWith('missing')) return { error: 'That session has no terminal Mini-Summa owns.' };
      if (key.endsWith('throws')) throw new Error('pty exploded');
      t.sinks.set(key, sink);
      t.attached.push(key);
      t.duringAttach?.(sink);
      return { replay: 'replayed output', seq: t.attachSeq, cols: size.cols, rows: size.rows, detach: () => { t.detached.push(key); t.sinks.delete(key); } };
    },
    input: (key: string, data: string) => { t.inputs.push([key, data]); return !key.endsWith('dead'); },
    resize: (key: string, cols: number, rows: number) => { t.resizes.push([key, cols, rows]); },
  };
  return t;
}
