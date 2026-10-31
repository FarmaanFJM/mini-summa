import { describe, expect, it } from 'vitest';
import {
  EventStream, MiniSummaClient, ApiError, applyEvent, applySnapshot, buildPath, createInitialState, decodePairingPayload,
  encodePairingPayload, makeSessionKey, parseSessionKey, routeNames, routes, scopeAllows, shortSessionId, topicOf,
} from '../src/index.ts';
import type { ServerEvent, SessionView, StateSnapshot } from '../src/index.ts';

describe('pairing payload', () => {
  it('round trips and rejects junk', () => {
    const p = { version: 1 as const, code: 'abcDEF123456', offerId: 'off_1', urls: ['https://pc.tail1234.ts.net', 'http://127.0.0.1:4317'], name: "Farmaan's PC" };
    expect(decodePairingPayload(encodePairingPayload(p))).toEqual(p);
    expect(decodePairingPayload('https://example.com')).toBeNull();
    expect(decodePairingPayload('minisumma://pair?v=2&c=x&o=y&u=https://a')).toBeNull();
    expect(decodePairingPayload('minisumma://pair?v=1&c=x&o=y&u=javascript:alert(1)')).toBeNull();
  });
});

describe('session keys', () => {
  it('pair the environment with the session id', () => {
    const key = makeSessionKey('wsl:Ubuntu', '11111111-1111-4111-8111-111111111111');
    expect(key).toBe('wsl:Ubuntu|11111111-1111-4111-8111-111111111111');
    expect(parseSessionKey(key)).toEqual({ env: 'wsl:Ubuntu', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(parseSessionKey('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(parseSessionKey('nope|abc')).toBeNull();
    expect(shortSessionId(key)).toBe('11111111');
    // the same uuid in two environments is two sessions
    expect(makeSessionKey('win', 'x')).not.toBe(makeSessionKey('wsl:Ubuntu', 'x'));
  });
});

describe('route table', () => {
  it('has unique method+path pairs and no unscoped mutating route', () => {
    const seen = new Set<string>();
    for (const name of routeNames) {
      const r = routes[name];
      const k = `${r.method} ${r.path}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
      if (r.method !== 'GET') expect(['public', 'desktop', 'read', 'notify', 'prompt', 'approve']).toContain(r.scope);
    }
    expect(routes['pairing.redeem'].scope).toBe('public');
    expect(routes['system.health'].scope).toBe('public');
  });

  it('keeps ChatGPT and Claude control on the desktop scope', () => {
    for (const n of ['deliveries.copy', 'deliveries.handoff', 'deliveries.confirmSent', 'sessions.start', 'sessions.stop', 'hooks.apply', 'pairing.createOffer', 'projects.create'] as const) {
      expect(routes[n].scope).toBe('desktop');
    }
    expect(routes['actions.create'].scope).toBe('prompt');
    expect(routes['actions.approve'].scope).toBe('approve');
  });

  it('enforces scopes', () => {
    expect(scopeAllows(['desktop'], 'approve')).toBe(true);
    expect(scopeAllows(['read', 'notify'], 'prompt')).toBe(false);
    expect(scopeAllows(['read'], 'read')).toBe(true);
    expect(scopeAllows([], 'public')).toBe(true);
  });

  it('encodes path parameters', () => {
    expect(buildPath('/sessions/:key/stop', { key: 'wsl:Ubuntu|abc' })).toBe('/sessions/wsl%3AUbuntu%7Cabc/stop');
    expect(() => buildPath('/x/:id', {})).toThrow(/Missing path parameter/);
  });

  it('validates request bodies', () => {
    const create = routes['projects.create'].body!;
    expect(create.safeParse({ name: 'App', roots: [{ path: 'C:\\x' }] }).success).toBe(true);
    expect(create.safeParse({ name: '' }).success).toBe(false);
    expect(create.safeParse({ name: 'App', githubRepo: 'not a repo' }).success).toBe(false);
    const act = routes['actions.create'].body!;
    expect(act.safeParse({ sessionKey: 'win|abc', text: 'hello' }).success).toBe(true);
    expect(act.safeParse({ sessionKey: 'abc', text: 'hello' }).success).toBe(false);
    expect(act.safeParse({ sessionKey: 'win|abc', text: '' }).success).toBe(false);
  });
});

describe('client', () => {
  it('builds typed requests and surfaces API errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/projects/nope')) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such project' } }), { status: 404 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new MiniSummaClient({ baseUrl: 'http://127.0.0.1:4317/', token: 't0k', fetch: fakeFetch });
    await client.call('sessions.stop', { params: { key: 'win|abc' }, body: { force: true } });
    expect(calls[0].url).toBe('http://127.0.0.1:4317/api/v1/sessions/win%7Cabc/stop');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer t0k');
    await client.call('projects.create', { body: { name: 'A', roots: [] } }, { idempotencyKey: 'k1' });
    expect((calls[1].init.headers as Record<string, string>)['idempotency-key']).toBe('k1');
    await client.call('reports.list', { query: { projectId: 'p1', unread: true, limit: 5 } });
    expect(calls[2].url).toBe('http://127.0.0.1:4317/api/v1/reports?projectId=p1&unread=true&limit=5');
    await client.call('system.health');
    expect((calls[3].init.headers as Record<string, string>).authorization).toBeUndefined();
    await expect(client.call('projects.get', { params: { id: 'nope' } })).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'not_found' });
    await expect(client.call('projects.get', { params: { id: 'nope' } })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('client state reducer', () => {
  const session = (over: Partial<SessionView> = {}): SessionView => ({
    key: 'win|s1', env: 'win', sessionId: 's1', origin: 'managed', availability: 'live', termination: null, resumable: false,
    projectId: 'p1', projectName: 'P1', projectResolution: 'managed', cwd: 'C:\\x', name: null, state: 'idle', stateLabel: 'Idle',
    stateEvidence: 'hook:SessionStart', generation: 1, pid: 1, startedAt: null, lastActivityAt: null, attention: null, unresolvedOrdering: 0,
    terminal: { cols: 80, rows: 24, exited: false }, isProjectDefault: false, remoteControl: { state: 'unknown', hint: '' }, ...over,
  });
  const snap = (): StateSnapshot => ({ seq: 10, system: { name: 'mini-summa-core', version: '0', apiVersion: 1, mode: 'headless', platform: 'linux', startedAt: 'x',
    nativeCapabilities: { clipboard: false, chatgptEmbedded: false, extensionBridge: false, notifications: false, openExternal: false, saveFile: false } },
  projects: [], conversations: [], sessions: [session()], counts: { unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 1 }, settings: {} as never });

  it('applies a snapshot and only newer events', () => {
    let s = applySnapshot(createInitialState(), snap());
    expect(s.seq).toBe(10);
    const stale: ServerEvent = { type: 'session.upserted', session: session({ state: 'working' }) };
    expect(applyEvent(s, 10, stale)).toBe(s);
    s = applyEvent(s, 11, stale);
    expect(s.sessions[0].state).toBe('working');
    expect(s.sessions).toHaveLength(1);
    s = applyEvent(s, 12, { type: 'session.upserted', session: session({ key: 'wsl:Ubuntu|s1', env: 'wsl:Ubuntu' }) });
    expect(s.sessions.map((x) => x.key)).toEqual(['win|s1', 'wsl:Ubuntu|s1']);
    s = applyEvent(s, 13, { type: 'session.removed', key: 'win|s1' });
    expect(s.sessions.map((x) => x.key)).toEqual(['wsl:Ubuntu|s1']);
  });

  it('maps every event to a topic', () => {
    expect(topicOf({ type: 'session.removed', key: 'win|x' })).toBe('sessions');
    expect(topicOf({ type: 'device.removed', id: 'd' })).toBe('devices');
    expect(topicOf({ type: 'counts', counts: snap().counts })).toBe('system');
  });
});

describe('EventStream', () => {
  it('sends hello with the token, resumes from the last seq and reports resync', async () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 0; sent: string[] = [];
      onopen: ((e: unknown) => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
      constructor(public url: string) { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
      send(d: string) { this.sent.push(d); }
      close() { this.readyState = 3; this.onclose?.({}); }
      push(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
    }
    const stream = new EventStream({ baseUrl: 'https://pc.tail1.ts.net', token: 'tok', clientName: 'test', WebSocket: FakeSocket as never });
    const events: number[] = []; const readies: boolean[] = [];
    stream.onEvent((seq) => events.push(seq));
    stream.onReady((r) => readies.push(r.resync));
    stream.connect(['sessions']);
    await new Promise((r) => setTimeout(r, 5));
    expect(sockets[0].url).toBe('wss://pc.tail1.ts.net/ws');
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ t: 'hello', token: 'tok', client: 'test', topics: ['sessions'] });
    sockets[0].push({ t: 'ready', serverTime: 'x', seq: 5, scopes: ['read'], deviceId: 'd', resync: false, apiVersion: 1 });
    sockets[0].push({ t: 'event', seq: 6, topic: 'sessions', event: { type: 'session.removed', key: 'win|a' } });
    sockets[0].push({ t: 'event', seq: 6, topic: 'sessions', event: { type: 'session.removed', key: 'win|a' } }); // overlap
    expect(events).toEqual([6]);
    expect(stream.status).toBe('open');
    stream.close();
    expect(stream.status).toBe('closed');
  });
});
