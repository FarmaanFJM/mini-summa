import { afterEach, describe, expect, it } from 'vitest';
import { ALL_TOPICS } from '@minisumma/shared';
import type { ServerEvent } from '@minisumma/shared';
import { connectWs, ev, fakeTerminal, openWs, raw, sleep, startHarness, WsClient } from './harness.ts';
import type { FakeTerminal, Harness, HarnessOptions } from './harness.ts';

let h: Harness | null = null;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await h?.stop();
  h = null;
});
async function boot(opts: HarnessOptions = {}): Promise<Harness> { h = await startHarness(opts); return h; }
async function connect(hh: Harness, token: string, hello: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; origin?: string } = {}) {
  const r = await connectWs(hh, token, hello, opts);
  clients.push(r.client);
  return r;
}
async function open(hh: Harness, opts: { headers?: Record<string, string>; origin?: string } = {}) {
  const c = await openWs(hh, opts);
  clients.push(c);
  return c;
}
/** Emits a sentinel and returns once it arrives: whatever else was queued before it has been received by then. */
async function flush(hh: Harness, c: WsClient): Promise<void> {
  hh.bus.emit(ev.notice('sentinel'));
  await c.next((m) => m.t === 'event' && m.event.type === 'system.notice' && m.event.message === 'sentinel');
}
const key = 'posix|aaaaaaaa-1111-2222-3333-444444444444';
const terminalOptions = (t: FakeTerminal): HarnessOptions => ({ overrides: { sessions: { terminal: t.api } } });

describe('hello and ready', () => {
  it('answers a valid hello with ready, including scopes and the head of the bus', async () => {
    const hh = await boot();
    hh.bus.emit(ev.notice('before'));
    const { ready } = await connect(hh, hh.tokens.read);
    expect(ready).toMatchObject({ t: 'ready', seq: 1, scopes: ['read'], deviceId: 'dev-read', resync: false, apiVersion: 1 });
    expect(Number.isNaN(Date.parse(ready.serverTime))).toBe(false);
    const desktop = await connect(hh, hh.tokens.desktop);
    expect(desktop.ready).toMatchObject({ scopes: ['desktop'], deviceId: null });
  });

  it('delivers events in order after ready, each once, with seq and topic', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read);
    hh.bus.emit(ev.notice('one'));
    hh.bus.emit(ev.session('posix|s9'));
    hh.bus.emit(ev.notice('two'));
    const a = await client.nextEvent();
    const b = await client.nextEvent();
    const c = await client.nextEvent();
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect([a.topic, b.topic, c.topic]).toEqual(['system', 'sessions', 'system']);
    expect(a.event).toEqual({ type: 'system.notice', level: 'info', message: 'one' });
    await sleep(50);
    expect(client.events()).toEqual([]);
  });

  it('answers ping with pong', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read);
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
  });

  it('refuses a token it does not know, closes with 4401 and does not echo the token', async () => {
    const hh = await boot();
    const c = await open(hh);
    c.send({ t: 'hello', token: hh.tokens.none, client: 'test' });
    const err = await c.nextOfType('error');
    expect(err).toMatchObject({ code: 'unauthorized', fatal: true });
    expect(JSON.stringify(err)).not.toContain(hh.tokens.none);
    expect((await c.waitClosed()).code).toBe(4401);
    expect(c.messages.find((m) => m.t === 'ready')).toBeUndefined();
  });

  it('refuses a second hello without closing', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read);
    client.send({ t: 'hello', token: hh.tokens.read, client: 'again' });
    expect(await client.nextOfType('error')).toMatchObject({ code: 'already_authenticated' });
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
  });

  it('closes a socket that does not say hello in time, with 4001', async () => {
    const hh = await boot({ tuning: { helloTimeoutMs: 150 } });
    const c = await open(hh);
    expect(await c.nextOfType('error')).toMatchObject({ code: 'hello_timeout', fatal: true });
    expect((await c.waitClosed()).code).toBe(4001);
  });

  it('keeps a socket open once it has said hello, however long it stays quiet', async () => {
    const hh = await boot({ tuning: { helloTimeoutMs: 150 } });
    const { client } = await connect(hh, hh.tokens.read);
    await sleep(400);
    expect(client.closed).toBeNull();
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
  });

  it.each([
    ['text that is not JSON', 'hello there'],
    ['a JSON number', '123'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['an object without t', '{"token":"x"}'],
    ['a message other than hello', '{"t":"ping"}'],
    ['an unknown message type', '{"t":"launch.missiles"}'],
    ['a hello without a token', '{"t":"hello"}'],
    ['a hello with a token that is not a string', '{"t":"hello","token":5}'],
    ['a terminal message', '{"t":"term.attach","key":"posix|x","cols":80,"rows":24}'],
  ])('ends the connection on %s before hello (fatal error, close 4001)', async (_what, payload) => {
    const hh = await boot();
    const c = await open(hh);
    c.send(payload);
    const err = await c.nextOfType('error');
    expect(err.fatal).toBe(true);
    expect((await c.waitClosed()).code).toBe(4001);
  });

  it('ends the connection on a binary frame before hello', async () => {
    const hh = await boot();
    const c = await open(hh);
    c.ws.send(Buffer.from([1, 2, 3]));
    expect((await c.nextOfType('error')).fatal).toBe(true);
    expect((await c.waitClosed()).code).toBe(4001);
  });

  it.each([
    ['text that is not JSON', 'oops', 'bad_json'],
    ['an object without t', '{"x":1}', 'bad_message'],
    ['an unknown type', '{"t":"nope"}', 'unknown_message'],
    ['a term.attach without a key', '{"t":"term.attach","cols":80,"rows":24}', 'bad_message'],
    ['a term.attach with an invalid key', '{"t":"term.attach","key":"nope","cols":80,"rows":24}', 'bad_message'],
    ['an absurd terminal size', `{"t":"term.attach","key":"${key}","cols":0,"rows":24}`, 'bad_message'],
    ['a subscribe without topics', '{"t":"subscribe"}', 'bad_message'],
  ])('answers %s after hello with a non-fatal error and carries on', async (_what, payload, code) => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send(payload);
    const err = await client.nextOfType('error');
    expect(err.code).toBe(code);
    expect(err.fatal).toBeUndefined();
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
  });

  it('closes a connection that sends more than 1 MiB in one message', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.desktop);
    client.ws.send('x'.repeat(2 * 1024 * 1024));
    expect((await client.waitClosed()).code).toBe(1009);
  });
});

describe('topic filtering', () => {
  it('delivers only the topics asked for in hello', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read, { topics: ['sessions'] });
    hh.bus.emit(ev.activity());
    hh.bus.emit(ev.notice());
    hh.bus.emit(ev.session('posix|s2'));
    const first = await client.nextEvent();
    expect(first.event.type).toBe('session.upserted');
    await sleep(50);
    expect(client.events()).toEqual([]);
  });

  it('subscribe and unsubscribe change the set while connected', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read, { topics: ['sessions'] });
    client.send({ t: 'subscribe', topics: ['activity'] });
    client.send({ t: 'unsubscribe', topics: ['sessions'] });
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
    hh.bus.emit(ev.session('posix|s2'));
    hh.bus.emit(ev.activity('a7'));
    const got = await client.nextEvent();
    expect(got.event.type).toBe('activity.added');
    await sleep(50);
    expect(client.events()).toEqual([]);
  });

  it('delivers every topic by default', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.desktop);
    for (const e of [ev.activity(), ev.session(), ev.deviceRemoved('x'), ev.settings(), ev.notice()]) hh.bus.emit(e);
    const types = [];
    for (let i = 0; i < 5; i++) types.push((await client.nextEvent()).event.type);
    expect(types).toEqual(['activity.added', 'session.upserted', 'device.removed', 'settings.changed', 'system.notice']);
  });

  it('treats a topics list that is not a list of strings as a malformed hello', async () => {
    const hh = await boot();
    const c = await open(hh);
    c.send({ t: 'hello', token: hh.tokens.desktop, client: 'test', topics: ['sessions', 5] });
    expect((await c.nextOfType('error')).fatal).toBe(true);
    expect((await c.waitClosed()).code).toBe(4001);
  });

  it('accepts a hello with an unknown topic name', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read, { topics: ['sessions', 'future-topic'] });
    hh.bus.emit(ev.session('posix|s3'));
    expect((await client.nextEvent()).event.type).toBe('session.upserted');
  });
});

describe('scope filtering', () => {
  const desktopOnly: ServerEvent[] = [
    ev.deviceUpserted({ id: 'd', name: 'd', platform: 'android', scopes: ['read'], trusted: false, pushRegistered: false, createdAt: 'x', lastSeenAt: null, lastSeenVia: null, revokedAt: null }),
    ev.deviceRemoved('someone-else'),
    ev.settings(),
    ev.hooks(),
    ev.tailscale(),
  ];

  it('never sends a device without the desktop scope the devices, settings, hooks or tailscale events', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read, { topics: ALL_TOPICS });
    client.send({ t: 'subscribe', topics: ['devices', 'settings'] });
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
    for (const e of desktopOnly) hh.bus.emit(e);
    hh.bus.emit(ev.counts());
    hh.bus.emit(ev.session());
    hh.bus.emit(ev.notice('visible'));
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await client.nextEvent()).event.type);
    expect(seen).toEqual(['counts', 'session.upserted', 'system.notice']);
    await sleep(50);
    expect(client.events()).toEqual([]);
  });

  it('sends all of them to the desktop', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.desktop);
    for (const e of desktopOnly) hh.bus.emit(e);
    const seen = [];
    for (let i = 0; i < desktopOnly.length; i++) seen.push((await client.nextEvent()).event.type);
    expect(seen).toEqual(['device.upserted', 'device.removed', 'settings.changed', 'hooks.changed', 'tailscale.changed']);
  });

  it('sends nothing but ready to a device that cannot read, and nothing to a bare extension', async () => {
    const hh = await boot();
    const notify = await connect(hh, hh.tokens.notify);
    const ext = await connect(hh, hh.tokens.extension);
    hh.bus.emit(ev.session());
    hh.bus.emit(ev.notice());
    hh.bus.emit(ev.activity());
    await sleep(100);
    expect(notify.client.events()).toEqual([]);
    expect(ext.client.events()).toEqual([]);
    notify.client.send({ t: 'ping' });
    await notify.client.nextOfType('pong');
  });
});

describe('resume with since', () => {
  const fill = (hh: Harness, n: number) => { for (let i = 1; i <= n; i++) hh.bus.emit(ev.notice(`n${i}`)); };

  it('replays what was missed in order, then continues live, without gaps or repeats', async () => {
    const hh = await boot();
    fill(hh, 5);
    const { client, ready } = await connect(hh, hh.tokens.read, { since: 2 });
    expect(ready).toMatchObject({ resync: false, seq: 2 });
    hh.bus.emit(ev.notice('live'));
    const seqs = [];
    for (let i = 0; i < 4; i++) seqs.push((await client.nextEvent()).seq);
    expect(seqs).toEqual([3, 4, 5, 6]);
    await sleep(50);
    expect(client.events()).toEqual([]);
  });

  it('sends ready before the replayed events', async () => {
    const hh = await boot();
    fill(hh, 3);
    const c = await open(hh);
    c.send({ t: 'hello', token: hh.tokens.read, client: 'test', since: 0 });
    await c.nextEvent();
    await c.nextEvent();
    await c.nextEvent();
    expect(c.arrivals.map((m) => m.t)).toEqual(['ready', 'event', 'event', 'event']);
    expect(c.arrivals.filter((m) => m.t === 'event').map((m) => (m as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  it('has nothing to replay when the client is up to date', async () => {
    const hh = await boot();
    fill(hh, 4);
    const { client, ready } = await connect(hh, hh.tokens.read, { since: 4 });
    expect(ready).toMatchObject({ resync: false, seq: 4 });
    await sleep(50);
    expect(client.events()).toEqual([]);
    hh.bus.emit(ev.notice('next'));
    expect((await client.nextEvent()).seq).toBe(5);
  });

  it('asks the client to resync when the buffer no longer reaches back', async () => {
    const hh = await boot({ busCapacity: 3 });
    fill(hh, 10);
    const { client, ready } = await connect(hh, hh.tokens.read, { since: 2 });
    expect(ready).toMatchObject({ resync: true, seq: 10 });
    await sleep(50);
    expect(client.events()).toEqual([]);
  });

  it('asks the client to resync when it is ahead of the server (the core restarted)', async () => {
    const hh = await boot();
    fill(hh, 2);
    const { ready } = await connect(hh, hh.tokens.read, { since: 500 });
    expect(ready).toMatchObject({ resync: true, seq: 2 });
  });

  it('applies the same topic and scope filters to the replay', async () => {
    const hh = await boot();
    hh.bus.emit(ev.settings());
    hh.bus.emit(ev.notice('visible'));
    hh.bus.emit(ev.hooks());
    const { client } = await connect(hh, hh.tokens.read, { since: 0 });
    const got = await client.nextEvent();
    expect(got.event).toMatchObject({ type: 'system.notice', message: 'visible' });
    await sleep(50);
    expect(client.events()).toEqual([]);
  });
});

describe('terminals', () => {
  it('refuses every terminal message without the desktop scope and touches no terminal', async () => {
    const t = fakeTerminal();
    const hh = await boot(terminalOptions(t));
    for (const token of [hh.tokens.read, hh.tokens.prompt, hh.tokens.approve]) {
      const { client } = await connect(hh, token);
      client.send({ t: 'term.attach', key, cols: 80, rows: 24 });
      client.send({ t: 'term.input', key, data: 'rm -rf /\n' });
      client.send({ t: 'term.resize', key, cols: 100, rows: 30 });
      for (let i = 0; i < 3; i++) expect(await client.nextOfType('term.error')).toMatchObject({ key, code: 'forbidden' });
    }
    expect(t.attached).toEqual([]);
    expect(t.inputs).toEqual([]);
    expect(t.resizes).toEqual([]);
  });

  it('attaches, replays once, then streams data with increasing seq and delivers the exit', async () => {
    const t = fakeTerminal();
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send({ t: 'term.attach', key, cols: 120, rows: 40 });
    expect(await client.nextOfType('term.attached')).toEqual({ t: 'term.attached', key, replay: 'replayed output', seq: 5, cols: 120, rows: 40 });
    const sink = t.sinks.get(key)!;
    sink.data(6, 'abc');
    sink.data(7, 'def');
    sink.exit({ code: 0, signal: null, at: '2026-10-30T12:00:00.000Z', reason: 'exited' });
    expect(await client.nextOfType('term.data')).toEqual({ t: 'term.data', key, seq: 6, data: 'abc' });
    expect(await client.nextOfType('term.data')).toEqual({ t: 'term.data', key, seq: 7, data: 'def' });
    expect(await client.nextOfType('term.exit')).toEqual({ t: 'term.exit', key, code: 0, signal: null, at: '2026-10-30T12:00:00.000Z', reason: 'exited' });
  });

  it('delivers output produced while attaching after term.attached, and skips what the replay already holds', async () => {
    const t = fakeTerminal();
    t.duringAttach = (sink) => { sink.data(4, 'already in the replay'); sink.data(5, 'also in the replay'); sink.data(6, 'new output'); };
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send({ t: 'term.attach', key, cols: 80, rows: 24 });
    const order: string[] = [];
    for (let i = 0; i < 2; i++) order.push((await client.next((m) => m.t.startsWith('term.'))).t);
    expect(order).toEqual(['term.attached', 'term.data']);
    await sleep(50);
    expect(client.messages.filter((m) => m.t === 'term.data')).toEqual([]);
  });

  it('forwards input and resize only for attached terminals', async () => {
    const t = fakeTerminal();
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send({ t: 'term.input', key, data: 'ls\n' });
    expect(await client.nextOfType('term.error')).toMatchObject({ key, code: 'not_attached' });
    client.send({ t: 'term.resize', key, cols: 90, rows: 30 });
    expect(await client.nextOfType('term.error')).toMatchObject({ code: 'not_attached' });
    expect(t.inputs).toEqual([]);

    client.send({ t: 'term.attach', key, cols: 80, rows: 24 });
    await client.nextOfType('term.attached');
    client.send({ t: 'term.input', key, data: 'ls\n' });
    client.send({ t: 'term.resize', key, cols: 90, rows: 30 });
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
    expect(t.inputs).toEqual([[key, 'ls\n']]);
    expect(t.resizes).toEqual([[key, 90, 30]]);
  });

  it('says so when the terminal does not take the input', async () => {
    const t = fakeTerminal();
    const dead = 'posix|aaaaaaaa-dead';
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send({ t: 'term.attach', key: dead, cols: 80, rows: 24 });
    await client.nextOfType('term.attached');
    client.send({ t: 'term.input', key: dead, data: 'x' });
    expect(await client.nextOfType('term.error')).toMatchObject({ key: dead, code: 'not_writable' });
  });

  it('reports a failed attach with the service message, and a crash with a generic one', async () => {
    const t = fakeTerminal();
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send({ t: 'term.attach', key: 'posix|session-missing', cols: 80, rows: 24 });
    expect(await client.nextOfType('term.error')).toMatchObject({ code: 'attach_failed', message: 'That session has no terminal Mini-Summa owns.' });
    client.send({ t: 'term.attach', key: 'posix|session-throws', cols: 80, rows: 24 });
    const crash = await client.nextOfType('term.error');
    expect(crash).toMatchObject({ code: 'attach_failed' });
    expect(crash.message).not.toContain('pty exploded');
    expect(hh.logs.some((l) => l.level === 'error' && l.msg === 'ws.term_attach_failed')).toBe(true);
  });

  it('re-attaching the same terminal replaces the old attachment', async () => {
    const t = fakeTerminal();
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send({ t: 'term.attach', key, cols: 80, rows: 24 });
    await client.nextOfType('term.attached');
    const oldSink = t.sinks.get(key)!;
    client.send({ t: 'term.attach', key, cols: 100, rows: 30 });
    await client.nextOfType('term.attached');
    expect(t.detached).toEqual([key]);
    oldSink.data(9, 'from the old attachment');
    t.sinks.get(key)!.data(9, 'from the new one');
    expect((await client.nextOfType('term.data')).data).toBe('from the new one');
  });

  it('detach stops the stream and forgets the attachment', async () => {
    const t = fakeTerminal();
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    client.send({ t: 'term.attach', key, cols: 80, rows: 24 });
    await client.nextOfType('term.attached');
    const sink = t.sinks.get(key)!;
    client.send({ t: 'term.detach', key });
    client.send({ t: 'ping' });
    await client.nextOfType('pong');
    expect(t.detached).toEqual([key]);
    sink.data(9, 'after detach');
    client.send({ t: 'term.input', key, data: 'x' });
    expect(await client.nextOfType('term.error')).toMatchObject({ code: 'not_attached' });
    expect(client.messages.filter((m) => m.t === 'term.data')).toEqual([]);
  });

  it('detaches every terminal when the socket closes', async () => {
    const t = fakeTerminal();
    const hh = await boot(terminalOptions(t));
    const { client } = await connect(hh, hh.tokens.desktop);
    const keys = ['posix|t1', 'posix|t2', 'win|t3'];
    for (const k of keys) { client.send({ t: 'term.attach', key: k, cols: 80, rows: 24 }); await client.nextOfType('term.attached'); }
    client.ws.terminate();
    await client.waitClosed();
    await sleep(100);
    expect([...t.detached].sort()).toEqual([...keys].sort());
  });
});

describe('revocation and scope changes', () => {
  it('closes the sockets of a revoked device with 4003 and leaves the others alone', async () => {
    const hh = await boot();
    const a1 = await connect(hh, hh.tokens.read);
    const a2 = await connect(hh, hh.tokens.read);
    const other = await connect(hh, hh.tokens.notify);
    const desktop = await connect(hh, hh.tokens.desktop);
    hh.devices.revoke('dev-read');
    for (const c of [a1.client, a2.client]) {
      const closed = await c.waitClosed();
      expect(closed).toEqual({ code: 4003, reason: 'revoked' });
    }
    await sleep(100);
    expect(other.client.closed).toBeNull();
    expect(desktop.client.closed).toBeNull();
    const again = await open(hh);
    again.send({ t: 'hello', token: hh.tokens.read, client: 'test' });
    expect(await again.nextOfType('error')).toMatchObject({ code: 'unauthorized', fatal: true });
  });

  it('closes the sockets of a removed device', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.notify);
    hh.bus.emit(ev.deviceRemoved('dev-notify'));
    expect(await client.waitClosed()).toEqual({ code: 4003, reason: 'revoked' });
  });

  it('does not close for a device event about someone else, or when the desktop socket has no device', async () => {
    const hh = await boot();
    const desktop = await connect(hh, hh.tokens.desktop);
    const { client } = await connect(hh, hh.tokens.read);
    hh.bus.emit(ev.deviceRemoved('dev-unrelated'));
    await sleep(100);
    expect(client.closed).toBeNull();
    expect(desktop.client.closed).toBeNull();
  });

  it('applies a scope change at once: a device that loses read stops receiving events', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read);
    hh.bus.emit(ev.notice('while allowed'));
    await client.nextEvent();
    hh.devices.update('dev-read', { scopes: ['notify'] });
    hh.bus.emit(ev.notice('after the change'));
    hh.bus.emit(ev.session());
    await sleep(100);
    expect(client.events()).toEqual([]);
    expect(client.closed).toBeNull();
  });
});

describe('slow clients', () => {
  const big = (n: number) => ev.notice('x'.repeat(n));

  it('drops a client whose unsent data passes the limit and keeps serving the others', async () => {
    const hh = await boot({ tuning: { maxBufferedBytes: 128 * 1024 } });
    const slow = await connect(hh, hh.tokens.read);
    const fine = await connect(hh, hh.tokens.read);
    slow.client.ws.pause();
    // One event per turn of the event loop, as real traffic arrives: the healthy client keeps up, the paused one cannot.
    for (let i = 0; i < 120; i++) { hh.bus.emit(big(400_000)); await sleep(2); }
    slow.client.ws.resume();
    const closed = await slow.client.waitClosed(8000);
    expect(closed.code).toBe(1006);
    expect(hh.logs.filter((l) => l.msg === 'ws.dropped')).toHaveLength(1);
    expect(fine.client.closed).toBeNull();
    hh.bus.emit(ev.notice('still here'));
    await fine.client.next((m) => m.t === 'event' && m.event.type === 'system.notice' && m.event.message === 'still here', 8000);
  });

  it('applies the 8 MB default', async () => {
    const hh = await boot();
    const slow = await connect(hh, hh.tokens.read);
    slow.client.ws.pause();
    for (let i = 0; i < 80; i++) hh.bus.emit(big(1_000_000));
    slow.client.ws.resume();
    const closed = await slow.client.waitClosed(15000);
    expect(closed.code).toBe(1006);
  });
});

describe('Host and Origin at upgrade', () => {
  it('lets a same-origin page and a client without Origin connect', async () => {
    const hh = await boot();
    for (const origin of [undefined, `http://127.0.0.1:${hh.port}`]) {
      const { ready } = await connect(hh, hh.tokens.desktop, {}, { origin });
      expect(ready.t).toBe('ready');
    }
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['the opaque origin', 'null'],
    ['localhost when addressed as 127.0.0.1', 'LOCALHOST'],
    ['a Firefox extension', 'moz-extension://11111111-2222-3333-4444-555555555555'],
  ])('refuses the handshake from %s', async (_what, origin) => {
    const hh = await boot();
    const o = origin === 'LOCALHOST' ? `http://localhost:${hh.port}` : origin;
    await expect(openWs(hh, { origin: o })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a Host header that is not this machine', async () => {
    const hh = await boot();
    await expect(openWs(hh, { headers: { Host: 'evil.example' } })).rejects.toMatchObject({ status: 403 });
    await expect(openWs(hh, { headers: { Host: `127.0.0.1` } })).rejects.toMatchObject({ status: 403 });
  });

  it('accepts the Tailscale host name when Tailscale has a public URL', async () => {
    const hh = await boot({ publicUrl: 'https://box.tail1234.ts.net' });
    const { ready } = await connect(hh, hh.tokens.read, {}, { headers: { Host: 'box.tail1234.ts.net', 'X-Forwarded-For': '100.64.0.7' }, origin: 'https://box.tail1234.ts.net' });
    expect(ready.t).toBe('ready');
    expect(hh.devices.authCalls.at(-1)?.via).toBe('tailscale');
  });

  it('answers other paths and other upgrades with an HTTP error', async () => {
    const hh = await boot();
    const wsHeaders = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' };
    expect((await raw(hh.port, { path: '/ws2', headers: wsHeaders })).status).toBe(404);
    expect((await raw(hh.port, { path: '/api/v1/health', headers: wsHeaders })).status).toBe(404);
    expect((await raw(hh.port, { path: '/ws', headers: { connection: 'Upgrade', upgrade: 'h2c' } })).status).toBe(400);
    expect((await raw(hh.port, { path: '/ws', headers: { ...wsHeaders, origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('serves /ws with a query string', async () => {
    const hh = await boot();
    const c = await openWs({ wsUrl: `${hh.wsUrl}?client=test` });
    clients.push(c);
    c.send({ t: 'hello', token: hh.tokens.read, client: 'q' });
    await c.nextOfType('ready');
  });

  describe('chrome-extension origin (the principal is only known after hello)', () => {
    const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

    it('is let through the handshake and then accepted for a principal with the extension scope', async () => {
      const hh = await boot();
      for (const token of [hh.tokens.extension, hh.tokens.readExtension]) {
        const { ready } = await connect(hh, token, {}, { origin: ext });
        expect(ready.scopes).toContain('extension');
      }
    });

    it('then closes the socket with 4003 for any principal without the extension scope, the desktop included', async () => {
      const hh = await boot();
      for (const token of [hh.tokens.read, hh.tokens.notify, hh.tokens.desktop, hh.tokens.prompt]) {
        const c = await open(hh, { origin: ext });
        c.send({ t: 'hello', token, client: 'test' });
        expect(await c.nextOfType('error')).toMatchObject({ code: 'origin_not_allowed', fatal: true });
        expect((await c.waitClosed()).code).toBe(4003);
        expect(c.messages.find((m) => m.t === 'ready')).toBeUndefined();
      }
    });

    it('sends nothing to such a socket before it has proved itself', async () => {
      const hh = await boot();
      const c = await open(hh, { origin: ext });
      hh.bus.emit(ev.notice('secret news'));
      hh.bus.emit(ev.session());
      await sleep(100);
      expect(c.messages).toEqual([]);
    });

    it('does not apply to a same-origin or Origin-less socket, which may be any principal', async () => {
      const hh = await boot();
      for (const origin of [undefined, `http://127.0.0.1:${hh.port}`]) {
        for (const token of [hh.tokens.extension, hh.tokens.read, hh.tokens.desktop]) {
          expect((await connect(hh, token, {}, { origin })).ready.t).toBe('ready');
        }
      }
    });
  });
});

describe('shutdown', () => {
  it('closes connected sockets with 1001 when the server stops', async () => {
    const hh = await boot();
    const { client } = await connect(hh, hh.tokens.read);
    const pending = await open(hh);
    const stopped = hh.server.stop();
    expect(await client.waitClosed()).toMatchObject({ code: 1001, reason: 'server stopping' });
    expect((await pending.waitClosed()).code).toBe(1001);
    await stopped;
  });
});
