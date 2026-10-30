// The shared client SDK (what the Android app and the desktop renderer use) driven end to end against this server.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ApiError, MiniSummaClient, routeNames } from '@minisumma/shared';
import type { RouteName, ServerEvent, Topic, WebSocketCtor } from '@minisumma/shared';
import { notFound } from '../../src/errors.ts';
import { ev, fakeTerminal, sleep, startHarness } from './harness.ts';
import type { Harness, HarnessOptions } from './harness.ts';
import { expectedStatus, samples } from './samples.ts';

let h: Harness | null = null;
const toClose: MiniSummaClient[] = [];
afterEach(async () => {
  for (const c of toClose.splice(0)) c.close();
  await h?.stop();
  h = null;
});

const instances: WebSocket[] = [];
class RecordingWebSocket extends WebSocket { constructor(url: string) { super(url); instances.push(this); } }
const WS = RecordingWebSocket as unknown as WebSocketCtor;

async function boot(opts: HarnessOptions = {}): Promise<Harness> { h = await startHarness(opts); return h; }
function clientFor(hh: Harness, token: string): MiniSummaClient {
  const c = new MiniSummaClient({ baseUrl: hh.baseUrl, token, clientName: 'sdk-test', WebSocket: WS });
  toClose.push(c);
  return c;
}
const ready = (c: MiniSummaClient) => new Promise<{ seq: number; resync: boolean }>((resolve) => { const off = c.events.onReady((i) => { off(); resolve(i); }); });
const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('condition not met in time'); await sleep(10); }
};

describe('typed calls', () => {
  it('every route of the table can be called through the SDK with the desktop token', async () => {
    const hh = await boot({ push: { name: 'fcm', configured: () => true, configureFromJson: () => ({ firebaseProject: 'demo' }), clear: () => undefined, send: async () => [] }, tuning: { redeemPerMinute: 1000 } });
    const client = clientFor(hh, hh.tokens.desktop);
    // The desktop token has no device row, so it cannot register a push token (a phone token can: see the auth matrix).
    const statusFor: Partial<Record<RouteName, number>> = { ...expectedStatus, 'devices.registerPush': 400 };
    for (const name of routeNames) {
      const call = client.call(name as RouteName, samples[name] as never);
      const wanted = statusFor[name];
      if (wanted && wanted >= 400) {
        await expect(call, name).rejects.toMatchObject({ status: wanted });
      } else {
        await expect(call, name).resolves.not.toBeUndefined();
      }
    }
  });

  it('returns typed data and carries path parameters, queries and bodies', async () => {
    const hh = await boot({ overrides: {
      reports: { list: (q: unknown) => ({ items: [{ id: 'r1', q }], nextBefore: null }) },
      projects: { create: (input: { name: string }) => ({ id: 'p1', name: input.name }) },
    } });
    const client = clientFor(hh, hh.tokens.desktop);
    expect(await client.call('system.health')).toEqual({ ok: true, name: 'mini-summa-core', version: '0.0.0-test', apiVersion: 1 });
    const page = await client.call('reports.list', { query: { limit: 3, unread: true, projectId: 'p 1' } });
    expect(page.items[0]).toMatchObject({ id: 'r1', q: { limit: 3, unread: true, projectId: 'p 1' } });
    expect(await client.call('projects.create', { body: { name: 'Alpha' } })).toEqual({ id: 'p1', name: 'Alpha' });
  });

  it('percent-encodes session keys and the server decodes them', async () => {
    const seen: string[] = [];
    const hh = await boot({ overrides: { sessions: { get: (k: string) => { seen.push(k); return { key: k }; } } } });
    const client = clientFor(hh, hh.tokens.read);
    const wsl = 'wsl:Ubuntu-22.04|11111111-2222-3333-4444-555555555555' as const;
    expect((await client.call('sessions.get', { params: { key: wsl } })).key).toBe(wsl);
    expect(seen).toEqual([wsl]);
  });

  it('surfaces errors as ApiError with status, code and details', async () => {
    const hh = await boot({ overrides: { projects: { require: () => { throw notFound('The project'); } } } });
    const client = clientFor(hh, hh.tokens.read);
    const err = await client.call('projects.get', { params: { id: 'nope' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'The project was not found.' });

    const wrong = await clientFor(hh, 'not-a-token').call('projects.list').catch((e: unknown) => e);
    expect(wrong).toMatchObject({ status: 401, code: 'unauthorized' });
    const weak = await client.call('projects.create', { body: { name: 'x' } }).catch((e: unknown) => e);
    expect(weak).toMatchObject({ status: 403, code: 'insufficient_scope' });
    const invalid = await clientFor(hh, hh.tokens.desktop).call('projects.create', { body: { name: '' } }).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ status: 400, code: 'validation_failed' });
  });

  it('a retried create with the same idempotency key does not run twice', async () => {
    let n = 0;
    const hh = await boot({ overrides: { projects: { create: () => ({ id: `p${++n}` }) } } });
    const client = clientFor(hh, hh.tokens.desktop);
    const a = await client.call('projects.create', { body: { name: 'Alpha' } }, { idempotencyKey: 'retry-me' });
    const b = await client.call('projects.create', { body: { name: 'Alpha' } }, { idempotencyKey: 'retry-me' });
    const c = await client.call('projects.create', { body: { name: 'Alpha' } });
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    expect(n).toBe(2);
  });

  it('reports a core that is not there as a network error', async () => {
    const hh = await boot();
    const client = clientFor(hh, hh.tokens.read);
    await hh.stop();
    h = null;
    const err = await client.call('system.health').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });
});

describe('the event stream', () => {
  it('connects, reports ready and delivers numbered events in order', async () => {
    const hh = await boot();
    const client = clientFor(hh, hh.tokens.read);
    const got: [number, ServerEvent['type'], Topic][] = [];
    client.events.onEvent((seq, event, topic) => got.push([seq, event.type, topic]));
    const r = ready(client);
    client.events.connect();
    expect(await r).toEqual({ seq: 0, resync: false });
    expect(client.events.status).toBe('open');
    hh.bus.emit(ev.notice());
    hh.bus.emit(ev.session());
    await until(() => got.length === 2);
    expect(got).toEqual([[1, 'system.notice', 'system'], [2, 'session.upserted', 'sessions']]);
    expect(client.events.lastSeq).toBe(2);
  });

  it('respects the topics given to connect()', async () => {
    const hh = await boot();
    const client = clientFor(hh, hh.tokens.read);
    const got: string[] = [];
    client.events.onEvent((_s, e) => got.push(e.type));
    const r = ready(client);
    client.events.connect(['sessions']);
    await r;
    hh.bus.emit(ev.notice());
    hh.bus.emit(ev.session());
    await until(() => got.length >= 1);
    await sleep(50);
    expect(got).toEqual(['session.upserted']);
  });

  it('resumes after a dropped connection and receives what it missed, once', async () => {
    const hh = await boot();
    const client = clientFor(hh, hh.tokens.read);
    const got: number[] = [];
    client.events.onEvent((seq) => got.push(seq));
    const first = ready(client);
    client.events.connect();
    await first;
    hh.bus.emit(ev.notice('1'));
    hh.bus.emit(ev.notice('2'));
    await until(() => got.length === 2);

    const second = ready(client);
    instances.at(-1)!.terminate();                      // the network drops
    await until(() => client.events.status !== 'open');
    hh.bus.emit(ev.notice('3'));                         // missed while disconnected
    hh.bus.emit(ev.notice('4'));
    const info = await second;                           // the SDK reconnects with since=2
    expect(info.resync).toBe(false);
    await until(() => got.length === 4);
    hh.bus.emit(ev.notice('5'));
    await until(() => got.length === 5);
    expect(got).toEqual([1, 2, 3, 4, 5]);
    expect(client.events.lastSeq).toBe(5);
  });

  it('is told to resync when the server can no longer replay what was missed', async () => {
    const hh = await boot({ busCapacity: 3 });
    const client = clientFor(hh, hh.tokens.read);
    const first = ready(client);
    client.events.connect();
    await first;
    hh.bus.emit(ev.notice('1'));
    await until(() => client.events.lastSeq === 1);
    const second = ready(client);
    instances.at(-1)!.terminate();
    await until(() => client.events.status !== 'open');
    for (let i = 0; i < 10; i++) hh.bus.emit(ev.notice(`missed ${i}`));
    const info = await second;
    expect(info).toEqual({ seq: 11, resync: true });
    // after the client reloads its snapshot (system.state carries seq) it continues from there
    const state = await clientFor(hh, hh.tokens.read).call('system.state');
    expect(state.seq).toBe(11);
    hh.bus.emit(ev.notice('after'));
    await until(() => client.events.lastSeq === 12);
  });

  it('stops reconnecting after a fatal error such as a bad token', async () => {
    const hh = await boot();
    const client = clientFor(hh, 'not-a-token');
    const errors: [string, boolean][] = [];
    client.events.onError((code, _m, fatal) => errors.push([code, fatal]));
    client.events.connect();
    await until(() => errors.length > 0);
    expect(errors[0]).toEqual(['unauthorized', true]);
    await until(() => client.events.status === 'closed');
    await sleep(700);
    expect(instances.filter((w) => w.url === hh.wsUrl).length).toBeGreaterThan(0);
    expect(client.events.status).toBe('closed');
  });

  it('does not send terminal or device traffic to a phone, even through the SDK', async () => {
    const t = fakeTerminal();
    const hh = await boot({ overrides: { sessions: { terminal: t.api } } });
    const client = clientFor(hh, hh.tokens.read);
    const topics: Topic[] = [];
    client.events.onEvent((_s, _e, topic) => topics.push(topic));
    const r = ready(client);
    client.events.connect();
    await r;
    const errors: string[] = [];
    client.events.onMessage((m) => { if (m.t === 'term.error') errors.push(m.code); });
    client.terminal.attach('posix|sdk-session', { cols: 80, rows: 24 }, { onAttached: () => undefined, onData: () => undefined, onExit: () => undefined, onError: () => undefined });
    hh.bus.emit(ev.settings());
    hh.bus.emit(ev.deviceRemoved('x'));
    hh.bus.emit(ev.notice());
    await until(() => errors.length === 1 && topics.length === 1);
    expect(errors).toEqual(['forbidden']);
    expect(topics).toEqual(['system']);
    expect(t.attached).toEqual([]);
  });
});

describe('the terminal channel', () => {
  it('attaches, receives the replay and output, sends input and resize, and detaches', async () => {
    const t = fakeTerminal();
    const hh = await boot({ overrides: { sessions: { terminal: t.api } } });
    const client = clientFor(hh, hh.tokens.desktop);
    const r = ready(client);
    client.events.connect();
    await r;
    const key = 'posix|sdk-session' as const;
    const log: string[] = [];
    const handle = client.terminal.attach(key, { cols: 100, rows: 30 }, {
      onAttached: (i) => log.push(`attached:${i.replay}:${i.seq}:${i.cols}x${i.rows}`),
      onData: (d) => log.push(`data:${d}`),
      onExit: (i) => log.push(`exit:${i.code}:${i.reason}`),
      onError: (code) => log.push(`error:${code}`),
    });
    await until(() => log.length === 1);
    t.sinks.get(key)!.data(6, 'hello ');
    t.sinks.get(key)!.data(7, 'world');
    t.sinks.get(key)!.exit({ code: 0, signal: null, at: '2026-10-30T12:00:00.000Z', reason: 'exited' });
    await until(() => log.length === 4);
    expect(log).toEqual(['attached:replayed output:5:100x30', 'data:hello ', 'data:world', 'exit:0:exited']);
    expect(handle.input('ls\n')).toBe(true);
    handle.resize(120, 40);
    await until(() => t.resizes.length === 1);
    expect(t.inputs).toEqual([[key, 'ls\n']]);
    expect(t.resizes).toEqual([[key, 120, 40]]);
    handle.detach();
    await until(() => t.detached.length === 1);
  });

  it('attaches again by itself after a reconnect and gets the replay again', async () => {
    const t = fakeTerminal();
    const hh = await boot({ overrides: { sessions: { terminal: t.api } } });
    const client = clientFor(hh, hh.tokens.desktop);
    const first = ready(client);
    client.events.connect();
    await first;
    const attachedCount: number[] = [];
    client.terminal.attach('posix|sdk-session', { cols: 80, rows: 24 }, { onAttached: () => attachedCount.push(1), onData: () => undefined, onExit: () => undefined, onError: () => undefined });
    await until(() => attachedCount.length === 1);
    const second = ready(client);
    instances.at(-1)!.terminate();
    await second;
    await until(() => attachedCount.length === 2);
    expect(t.attached).toHaveLength(2);
    expect(t.detached).toHaveLength(1); // the dead socket's attachment was released
  });
});
