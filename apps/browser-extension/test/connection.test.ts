import { describe, expect, it } from 'vitest';
import type { BridgeOutcome } from '../src/bridge.ts';
import {
  BACKOFF_MAX_MS, BACKOFF_START_MS, CLOSE_REVOKED, CLOSE_STALE, CLOSE_UNAUTHORIZED, CoreConnection, PING_EVERY_MS, STALE_AFTER_MS,
} from '../src/connection.ts';
import type { Clock } from '../src/connection.ts';
import { DEFAULT_CORE_URL } from '../src/core-address.ts';
import { loadState, markRevoked, savePairing } from '../src/storage.ts';
import { FakeClock } from './fake-clock.ts';
import { MemoryArea, socketFactory } from './fake-socket.ts';

const URL1 = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';

function setup(opts: { bridge?: (action: unknown) => Promise<BridgeOutcome>; revoke?: (area: MemoryArea, at: number) => Promise<void> } = {}) {
  const clock = new FakeClock();
  const area = new MemoryArea();
  const { Ctor, sockets, throwOnCreate } = socketFactory(clock.now);
  const handled: unknown[] = [];
  const bridge = {
    handle: async (action: unknown): Promise<BridgeOutcome> => {
      handled.push(action);
      return opts.bridge ? opts.bridge(action) : { ok: true, data: [] };
    },
  };
  const statuses: string[] = [];
  const conn = new CoreConnection({
    WebSocket: Ctor,
    store: { load: () => loadState(area), markRevoked: () => (opts.revoke ?? markRevoked)(area, clock.now()) },
    bridge,
    clock: clock as unknown as Clock,
    onStatus: (s) => statuses.push(s.state),
  });
  // background.ts reloads on every chrome.storage change; do the same here so races between writes are exercised.
  area.onChange = () => { void conn.reload(); };
  const pair = (token = 'tok-1', coreUrl = DEFAULT_CORE_URL) =>
    savePairing(area, { coreUrl, token, deviceId: 'dev-1', deviceName: 'Chrome on Windows', pairedAt: 1 });
  return { clock, area, sockets, throwOnCreate, conn, handled, statuses, pair };
}

/** A paired connection that has finished the hello and ready exchange. */
async function connected(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.pair();
  await s.conn.start();
  const ws = s.sockets[0];
  ws.open();
  ws.ready();
  await s.clock.flush();
  return { ...s, ws };
}

describe('starting up', () => {
  it('stays idle and opens no socket when this browser is not paired', async () => {
    const { conn, sockets, clock } = setup();
    await conn.start();
    expect(sockets).toHaveLength(0);
    expect(conn.status()).toMatchObject({ state: 'not_paired', coreUrl: DEFAULT_CORE_URL });
    expect(conn.isPaired()).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('connects to <core address>/ws with the stored token and sends hello first', async () => {
    const { conn, sockets, pair } = setup();
    await pair('secret-token', 'http://localhost:5555');
    await conn.start();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://localhost:5555/ws');
    expect(conn.status().state).toBe('connecting');
    expect(sockets[0].sent).toEqual([]); // nothing may be sent before the socket opens

    sockets[0].open();
    expect(sockets[0].sent).toEqual([{ t: 'hello', token: 'secret-token', client: 'browser-extension', topics: [] }]);
    expect(conn.status().state).toBe('connecting'); // not connected until the core says ready
  });

  it('becomes connected on ready and records the granted scopes', async () => {
    const { conn, ws } = await connected();
    expect(conn.status()).toMatchObject({ state: 'connected', coreUrl: DEFAULT_CORE_URL, scopes: ['extension'], canAnswer: true });
    expect(conn.isPaired()).toBe(true);
    expect(ws.sent).toHaveLength(1);
  });

  it('says so when the pairing cannot answer browser requests', async () => {
    const s = setup();
    await s.pair();
    await s.conn.start();
    s.sockets[0].open();
    s.sockets[0].ready({ scopes: ['read', 'notify'] });
    expect(s.conn.status()).toMatchObject({ state: 'connected', canAnswer: false, scopes: ['read', 'notify'] });
  });

  it('falls back to the default address when the stored one is not acceptable', async () => {
    const s = setup();
    await s.area.set({ coreUrl: 'http://evil.example:80', token: 'tok' });
    await s.conn.start();
    expect(s.sockets[0].url).toBe('ws://127.0.0.1:47811/ws');
  });
});

describe('reconnecting', () => {
  it('backs off 500 ms doubling up to 15 s while the core is unreachable', async () => {
    const { conn, sockets, clock, pair } = setup();
    await pair();
    await conn.start();
    const expectedDelays = [500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000];
    expect(expectedDelays[0]).toBe(BACKOFF_START_MS);
    expect(expectedDelays.at(-1)).toBe(BACKOFF_MAX_MS);

    for (let i = 0; i < expectedDelays.length; i++) {
      const failedAt = clock.now();
      sockets[i].refuse();
      const status = conn.status();
      expect(status).toMatchObject({ state: 'unreachable', retryAt: failedAt + expectedDelays[i], attempt: i + 1 });
      await clock.advance(expectedDelays[i] - 1);
      expect(sockets).toHaveLength(i + 1); // not one millisecond early
      await clock.advance(1);
      expect(sockets).toHaveLength(i + 2);
      expect(sockets[i + 1].openedAt - failedAt).toBe(expectedDelays[i]);
      expect(conn.status().state).toBe('connecting');
    }
  });

  it('starts again at 500 ms after a successful connection', async () => {
    const { conn, sockets, clock, pair } = setup();
    await pair();
    await conn.start();
    sockets[0].refuse();
    await clock.advance(500);
    sockets[1].refuse();
    await clock.advance(1000);
    sockets[2].open();
    sockets[2].ready();
    expect(conn.status().state).toBe('connected');

    const droppedAt = clock.now();
    sockets[2].serverClose(1006);
    expect(conn.status()).toMatchObject({ state: 'unreachable', retryAt: droppedAt + 500, detail: 'The connection to Mini-Summa was closed.' });
    await clock.advance(500);
    expect(sockets).toHaveLength(4);
    expect(sockets[3].url).toBe(sockets[0].url);
  });

  it('keeps the sentence the core sent in an error message for the status line', async () => {
    const { conn, sockets, pair } = setup();
    await pair();
    await conn.start();
    sockets[0].open();
    sockets[0].receive({ t: 'error', code: 'bad_hello', message: 'Host not allowed', fatal: true });
    sockets[0].serverClose(1008);
    expect(conn.status()).toMatchObject({ state: 'unreachable', detail: 'Host not allowed' });
  });

  it('retries when the WebSocket constructor throws', async () => {
    const { conn, sockets, throwOnCreate, clock, pair } = setup();
    await pair();
    throwOnCreate.error = new Error('bad url');
    await conn.start();
    expect(conn.status().state).toBe('unreachable');
    throwOnCreate.error = null;
    await clock.advance(500);
    expect(sockets).toHaveLength(1);
  });

  it('opens one socket when several reloads race', async () => {
    const s = setup();
    await s.pair();
    await Promise.all([s.conn.reload(), s.conn.reload(), s.conn.reload()]);
    expect(s.sockets).toHaveLength(1);
  });
});

describe('a revoked token', () => {
  it('on close code 4003 clears the token, says the browser was unpaired and never reconnects', async () => {
    const { conn, sockets, clock, area, ws } = await connected();

    ws.serverClose(CLOSE_REVOKED, 'revoked');
    await clock.flush();

    expect(conn.status().state).toBe('revoked');
    const stored = await loadState(area);
    expect(stored.token).toBeNull();
    expect(stored.deviceId).toBeNull();
    expect(stored.revokedAt).not.toBeNull();
    expect(stored.coreUrl).toBe(DEFAULT_CORE_URL); // the address stays so pairing again is one step
    expect(conn.isPaired()).toBe(false);

    await clock.advance(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(clock.pending).toBe(0);

    // the storage change listener calls reload; that must not flip the status back to "not paired" nor reconnect
    await conn.reload();
    expect(conn.status().state).toBe('revoked');
    expect(sockets).toHaveLength(1);
  });

  it('treats close code 4401 (token not known to the core) the same way: the token is dropped and no retry follows', async () => {
    expect(CLOSE_UNAUTHORIZED).toBe(4401);
    const s = setup();
    await s.pair();
    await s.conn.start();
    s.sockets[0].open();
    s.sockets[0].receive({ t: 'error', code: 'unauthorized', message: 'The token was not accepted.', fatal: true });
    s.sockets[0].serverClose(CLOSE_UNAUTHORIZED, 'unauthorized');
    await s.clock.flush();
    expect(s.conn.status().state).toBe('revoked');
    expect((await loadState(s.area)).token).toBeNull();
    await s.clock.advance(60_000);
    expect(s.sockets).toHaveLength(1);
  });

  it('also stops when the core rejects the token during the hello', async () => {
    const s = setup();
    await s.pair();
    await s.conn.start();
    s.sockets[0].open();
    s.sockets[0].serverClose(CLOSE_REVOKED, 'revoked');
    await s.clock.flush();
    expect(s.conn.status().state).toBe('revoked');
    expect((await loadState(s.area)).token).toBeNull();
    await s.clock.advance(60_000);
    expect(s.sockets).toHaveLength(1);
  });

  it('never presents a token again after the core said it is revoked, even if the stored state still holds it', async () => {
    const s = await connected();
    s.ws.serverClose(CLOSE_REVOKED, 'revoked');
    await s.clock.flush();
    await s.area.set({ token: 'tok-1', revokedAt: 5 }); // as if a stale or partial write put the same token back
    await s.conn.reload();
    await s.clock.advance(60_000);
    expect(s.sockets).toHaveLength(1);
    expect(s.conn.status().state).toBe('revoked');
  });

  it('a revocation written in two steps (marker first, token removal second) cannot trigger a reconnect either', async () => {
    const s = setup({
      revoke: async (area, at) => { await area.set({ revokedAt: at }); await area.remove(['token', 'deviceId', 'deviceName', 'pairedAt']); },
    });
    await s.pair();
    await s.conn.start();
    s.sockets[0].open();
    s.sockets[0].ready();
    s.sockets[0].serverClose(CLOSE_REVOKED, 'revoked');
    await s.clock.flush();
    await s.clock.advance(60_000);
    expect(s.sockets).toHaveLength(1);
    expect(s.conn.status().state).toBe('revoked');
    expect((await loadState(s.area)).token).toBeNull();
  });

  it('connects again with the new token after pairing again, and the revoked note is gone', async () => {
    const s = await connected();
    s.ws.serverClose(CLOSE_REVOKED, 'revoked');
    await s.clock.flush();

    await s.pair('tok-2');
    await s.conn.reload();

    expect(s.sockets).toHaveLength(2);
    s.sockets[1].open();
    expect(s.sockets[1].sent[0]).toMatchObject({ t: 'hello', token: 'tok-2' });
    expect((await loadState(s.area)).revokedAt).toBeNull();
  });
});

describe('answering bridge requests', () => {
  const request = { t: 'bridge.request', requestId: 'req-1', action: { kind: 'focus_or_open', url: URL1 } };

  it('hands the action to the bridge and sends the result with the same requestId', async () => {
    const data = { mode: 'focused', tabId: 5, windowId: 2, url: URL1, title: 'T', urlMatches: true };
    const { ws, handled, clock } = await connected({ bridge: async () => ({ ok: true, data: data as never }) });

    ws.receive(request);
    await clock.flush();

    expect(handled).toEqual([request.action]);
    expect(ws.sent.at(-1)).toEqual({ t: 'bridge.result', requestId: 'req-1', ok: true, data });
  });

  it('sends ok false with the error text and no data when the bridge refuses', async () => {
    const { ws, clock } = await connected({ bridge: async () => ({ ok: false, error: 'Only chatgpt.com conversation addresses are accepted.' }) });
    ws.receive(request);
    await clock.flush();
    expect(ws.sent.at(-1)).toEqual({ t: 'bridge.result', requestId: 'req-1', ok: false, error: 'Only chatgpt.com conversation addresses are accepted.' });
  });

  it('turns an exception inside the bridge into ok false', async () => {
    const { ws, clock } = await connected({ bridge: async () => { throw new Error('unexpected'); } });
    ws.receive(request);
    await clock.flush();
    expect(ws.sent.at(-1)).toEqual({ t: 'bridge.result', requestId: 'req-1', ok: false, error: 'The extension failed while handling the request.' });
  });

  it('answers list_chatgpt_tabs the same way', async () => {
    const tabs = [{ tabId: 1, windowId: 1, url: URL1, title: 'One', active: true }];
    const { ws, clock, handled } = await connected({ bridge: async () => ({ ok: true, data: tabs }) });
    ws.receive({ t: 'bridge.request', requestId: 'req-2', action: { kind: 'list_chatgpt_tabs' } });
    await clock.flush();
    expect(handled).toEqual([{ kind: 'list_chatgpt_tabs' }]);
    expect(ws.sent.at(-1)).toEqual({ t: 'bridge.result', requestId: 'req-2', ok: true, data: tabs });
  });

  it('ignores requests without a request id and survives garbage frames', async () => {
    const { ws, clock, handled } = await connected();
    const before = ws.sent.length;
    ws.receive({ t: 'bridge.request', action: { kind: 'list_chatgpt_tabs' } });
    ws.receive({ t: 'bridge.request', requestId: 42, action: {} });
    ws.receive('this is not json');
    ws.receive('null');
    ws.receive({ t: 'event', seq: 3, topic: 'system', event: { type: 'counts' } });
    await clock.flush();
    expect(handled).toEqual([]);
    expect(ws.sent).toHaveLength(before);
  });

  it('does not send a result over a socket that was replaced while the request was running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = await connected({ bridge: async () => { await gate; return { ok: true, data: [] }; } });
    s.ws.receive(request);
    await s.clock.flush();

    await s.pair('tok-2'); // credentials change: the old socket is closed and a new one opened
    await s.conn.reload();
    release();
    await s.clock.flush();

    expect(s.ws.closedWith).toEqual({ code: 1000, reason: 'client closed' });
    expect(s.ws.sent.filter((m) => m.t === 'bridge.result')).toEqual([]);
    expect(s.sockets[1].sent).toEqual([]);
  });
});

describe('keeping the connection alive', () => {
  it('pings every 25 seconds once the core is ready, and not before', async () => {
    const s = setup();
    await s.pair();
    await s.conn.start();
    const ws = s.sockets[0];
    ws.open();
    await s.clock.advance(PING_EVERY_MS); // opened but no ready yet
    expect(ws.sent.filter((m) => m.t === 'ping')).toHaveLength(0);
    ws.ready();
    await s.clock.advance(PING_EVERY_MS);
    expect(ws.sent.filter((m) => m.t === 'ping')).toHaveLength(1);
    ws.receive({ t: 'pong' });
    await s.clock.advance(PING_EVERY_MS);
    expect(ws.sent.filter((m) => m.t === 'ping')).toHaveLength(2);
  });

  it('keeps the same socket for minutes while pongs keep arriving', async () => {
    const s = await connected();
    for (let i = 0; i < 20; i++) {
      await s.clock.advance(PING_EVERY_MS);
      s.ws.receive({ t: 'pong' });
    }
    expect(s.sockets).toHaveLength(1);
    expect(s.conn.status().state).toBe('connected');
  });

  it('drops a socket that went silent and reconnects', async () => {
    const s = await connected();
    // pings go out at 25, 50 and 75 s with no answer; at 75 s the silence (75 s) exceeds the 70 s limit
    await s.clock.advance(3 * PING_EVERY_MS);
    expect(3 * PING_EVERY_MS).toBeGreaterThan(STALE_AFTER_MS);
    expect(s.ws.closedWith).toEqual({ code: CLOSE_STALE, reason: 'stale' });
    expect(s.conn.status()).toMatchObject({ state: 'unreachable', detail: 'Mini-Summa stopped answering.' });
    await s.clock.advance(BACKOFF_START_MS);
    expect(s.sockets).toHaveLength(2);
  });

  it('heartbeat leaves an already scheduled retry alone instead of opening a second socket', async () => {
    const s = setup();
    await s.pair();
    await s.conn.start();
    s.sockets[0].refuse();
    s.conn.heartbeat();
    expect(s.sockets).toHaveLength(1);
    await s.clock.advance(BACKOFF_START_MS);
    expect(s.sockets).toHaveLength(2);
  });

  it('heartbeat sends a ping on a healthy socket', async () => {
    const s = await connected();
    s.conn.heartbeat();
    expect(s.ws.sent.filter((m) => m.t === 'ping')).toHaveLength(1);
    expect(s.ws.closedWith).toBeNull();
  });

  it('heartbeat drops a socket that has been silent for more than 70 seconds', async () => {
    const s = await connected();
    await s.clock.advance(STALE_AFTER_MS + 1_000); // the 25 s and 50 s pings went unanswered; the 75 s tick has not fired yet
    expect(s.ws.closedWith).toBeNull();
    s.conn.heartbeat();
    expect(s.ws.closedWith).toEqual({ code: CLOSE_STALE, reason: 'stale' });
    expect(s.conn.status().state).toBe('unreachable');
    await s.clock.advance(BACKOFF_START_MS);
    expect(s.sockets).toHaveLength(2);
  });

  it('heartbeat does nothing when not paired', async () => {
    const s = setup();
    await s.conn.start();
    s.conn.heartbeat();
    expect(s.sockets).toHaveLength(0);
  });
});

describe('changes to the stored pairing', () => {
  it('does nothing when the credentials did not change', async () => {
    const s = await connected();
    await s.conn.reload();
    await s.conn.reload();
    expect(s.sockets).toHaveLength(1);
    expect(s.ws.closedWith).toBeNull();
  });

  it('reconnects to the new address with the same token', async () => {
    const s = await connected();
    await s.area.set({ coreUrl: 'http://localhost:6000' });
    await s.conn.reload();
    expect(s.ws.closedWith?.code).toBe(1000);
    expect(s.sockets).toHaveLength(2);
    expect(s.sockets[1].url).toBe('ws://localhost:6000/ws');
    s.sockets[1].open();
    expect(s.sockets[1].sent[0]).toMatchObject({ t: 'hello', token: 'tok-1' });
  });

  it('closes the socket and stops all timers when the person unpairs', async () => {
    const s = await connected();
    await s.area.remove(['token', 'deviceId', 'deviceName', 'pairedAt']);
    await s.conn.reload();
    expect(s.ws.closedWith?.code).toBe(1000);
    expect(s.conn.status().state).toBe('not_paired');
    expect(s.conn.isPaired()).toBe(false);
    expect(s.clock.pending).toBe(0);
    await s.clock.advance(60_000);
    expect(s.sockets).toHaveLength(1);
  });

  it('stop() closes everything', async () => {
    const s = await connected();
    s.conn.stop();
    expect(s.ws.closedWith?.code).toBe(1000);
    expect(s.clock.pending).toBe(0);
  });
});
