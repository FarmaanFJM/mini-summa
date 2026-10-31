// A fake Mini-Summa desktop for tests. It speaks the real route table over a fake fetch and a fake WebSocket, so the
// tests exercise the actual shared SDK (MiniSummaClient, EventStream, reducer) and the app on top of it.
import { API_PREFIX, topicOf } from '@minisumma/shared';
import type {
  ActivityEvent, Delivery, Device, PendingAction, Report, ReportSummary, ServerEvent, ServerMessage, StateSnapshot, WebSocketCtor,
  WebSocketLike,
} from '@minisumma/shared';
import { makeAction, makeActivity, makeDelivery, makeDevice, makeReport, makeSnapshot, makeSummary } from './data';

export interface RecordedRequest {
  method: string;
  /** Path below /api/v1, for example /reports/rep_1. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = { status?: number; body?: unknown } | 'network-error';
export type Handler = (req: RecordedRequest) => Reply | Promise<Reply>;

export interface CoreData {
  snapshot: StateSnapshot;
  reports: ReportSummary[];
  activity: ActivityEvent[];
  actions: PendingAction[];
  deliveries: Delivery[];
  device: Device;
  reportBodies: Record<string, Report>;
  /** Status a freshly created prompt action gets: a phone that is not trusted waits for approval. */
  createStatus: PendingAction['status'];
}

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code = 1000, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  /** The server accepts the connection. */
  serverOpen(): void { this.readyState = 1; this.onopen?.({}); }
  serverSend(msg: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  /** The server (or the network) drops the connection. */
  serverClose(code = 1006, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  serverFailToOpen(): void { this.onerror?.({}); this.serverClose(1006, ''); }
}

export interface FakeCore {
  data: CoreData;
  fetch: typeof fetch;
  WebSocket: WebSocketCtor;
  requests: RecordedRequest[];
  sockets: FakeSocket[];
  lastSocket(): FakeSocket;
  /** Accept the latest socket and send `ready`, like a healthy desktop. */
  connect(opts?: { seq?: number; resync?: boolean }): void;
  emit(seq: number, event: ServerEvent): void;
  /** Replace the handler for "METHOD /path" (path as written below, with :params). */
  on(route: string, handler: Handler): void;
  /** Every request fails like a PC that is asleep. */
  setOffline(offline: boolean): void;
  calls(route: string): RecordedRequest[];
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/'); const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function createFakeCore(seed: Partial<CoreData> = {}): FakeCore {
  const data: CoreData = {
    snapshot: makeSnapshot(), reports: [makeSummary()], activity: [makeActivity()], actions: [makeAction()], deliveries: [makeDelivery()],
    device: makeDevice(), reportBodies: { rep_1: makeReport({ body: 'Done.' }) }, createStatus: 'pending', ...seed,
  };
  const requests: RecordedRequest[] = [];
  const sockets: FakeSocket[] = [];
  const overrides = new Map<string, Handler>();
  const idempotent = new Map<string, PendingAction>();
  let offline = false;
  let created = 0;

  const json = (body: unknown, status = 200): Reply => ({ status, body });
  const notFound = (what: string): Reply => ({ status: 404, body: { error: { code: 'not_found', message: `${what} was not found.` } } });

  const defaults: Record<string, Handler> = {
    'GET /health': () => json({ ok: true, name: 'mini-summa-core', version: '0.1.0', apiVersion: 1 }),
    'GET /state': () => json(data.snapshot),
    'GET /reports': () => json({ items: data.reports, nextBefore: null }),
    'GET /activity': () => json({ items: data.activity, nextBefore: null }),
    'GET /actions': () => json(data.actions),
    'GET /deliveries': () => json(data.deliveries),
    'GET /devices/self': () => json(data.device),
    'GET /reports/:id': (req) => {
      const id = req.path.split('/')[2];
      const r = data.reportBodies[id];
      return r ? json(r) : notFound('Report');
    },
    'POST /reports/:id/read': (req) => {
      const id = req.path.split('/')[2];
      const s = data.reports.find((r) => r.id === id);
      return s ? json({ ...s, read: true }) : notFound('Report');
    },
    'POST /activity/read': () => json(data.snapshot.counts),
    'POST /devices/self/push-token': () => json({ ok: true }),
    'POST /pairing/redeem': () => json({ device: data.device, token: 'bearer-from-pairing', server: { name: "Farmaan's PC", apiVersion: 1 } }),
    'POST /actions': (req) => {
      const key = req.headers['idempotency-key'];
      if (key && idempotent.has(key)) return json(idempotent.get(key));
      const body = req.body as { sessionKey: string; text: string; expectGeneration?: number };
      const action = makeAction({
        id: `act_new_${++created}`, kind: 'claude_prompt', status: data.createStatus, text: body.text, summary: body.text.split('\n')[0],
        sessionKey: body.sessionKey as PendingAction['sessionKey'], generation: body.expectGeneration ?? 0,
        createdBy: { kind: 'device', deviceId: data.device.id, name: data.device.name }, approvableBy: 'desktop_or_other_device',
      });
      if (key) idempotent.set(key, action);
      data.actions = [action, ...data.actions];
      return json(action, 200);
    },
    'POST /actions/:id/approve': (req) => {
      const id = req.path.split('/')[2];
      const a = data.actions.find((x) => x.id === id);
      return a ? json({ ...a, status: 'executed', decidedAt: '2026-10-30T09:30:00.000Z' }) : notFound('Action');
    },
    'POST /actions/:id/reject': (req) => {
      const id = req.path.split('/')[2];
      const a = data.actions.find((x) => x.id === id);
      return a ? json({ ...a, status: 'rejected', decidedAt: '2026-10-30T09:30:00.000Z' }) : notFound('Action');
    },
  };

  const fakeFetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    if (offline) throw new TypeError('Network request failed');
    const [rawPath, rawQuery = ''] = url.replace(/^https?:\/\/[^/]+/, '').split('?');
    const path = rawPath.startsWith(API_PREFIX) ? rawPath.slice(API_PREFIX.length) : rawPath;
    const query: Record<string, string> = {};
    for (const pair of rawQuery.split('&').filter(Boolean)) { const [k, v = ''] = pair.split('='); query[decodeURIComponent(k)] = decodeURIComponent(v); }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v;
    const req: RecordedRequest = { method: init?.method ?? 'GET', path, query, headers, body: init?.body ? JSON.parse(init.body) : undefined };
    requests.push(req);

    const all = [...overrides.entries(), ...Object.entries(defaults)];
    for (const [route, handler] of all) {
      const [method, pattern] = route.split(' ');
      if (method === req.method && matchPath(pattern, path)) {
        const reply = await handler(req);
        if (reply === 'network-error') throw new TypeError('Network request failed');
        const status = reply.status ?? 200;
        const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
        return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
      }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'not_found', message: 'No such route in the fake core.' } }) } as unknown as Response;
  }) as unknown as typeof fetch;

  class Sock extends FakeSocket {
    constructor(url: string) { super(url); sockets.push(this); }
  }

  const core: FakeCore = {
    data,
    fetch: fakeFetch,
    WebSocket: Sock as unknown as WebSocketCtor,
    requests,
    sockets,
    lastSocket: () => sockets[sockets.length - 1],
    connect(opts = {}) {
      const s = core.lastSocket();
      s.serverOpen();
      s.serverSend({ t: 'ready', serverTime: '2026-10-30T09:00:00.000Z', seq: opts.seq ?? data.snapshot.seq, scopes: data.device.scopes, deviceId: data.device.id, resync: opts.resync ?? false, apiVersion: 1 });
    },
    emit(seq, event) { core.lastSocket().serverSend({ t: 'event', seq, topic: topicOf(event), event }); },
    on(route, handler) { overrides.set(route, handler); },
    setOffline(v) { offline = v; },
    calls: (route) => {
      const [method, pattern] = route.split(' ');
      return requests.filter((r) => r.method === method && matchPath(pattern, r.path) !== null);
    },
  };
  return core;
}

/** Let promise chains and zero-delay timers run. Works with Jest fake timers. */
export async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    if (typeof jest !== 'undefined') await jest.advanceTimersByTimeAsync(0);
  }
}
