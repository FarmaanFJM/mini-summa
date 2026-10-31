import net from 'node:net';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpListenError } from '../../src/http/server.ts';
import { api, connectWs, startHarness } from './harness.ts';
import type { Harness, HarnessOptions } from './harness.ts';

const open: Harness[] = [];
afterEach(async () => { for (const hh of open.splice(0)) await hh.stop().catch(() => undefined); });
async function boot(opts: HarnessOptions = {}): Promise<Harness> { const hh = await startHarness(opts); open.push(hh); return hh; }

const canConnect = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

describe('start and stop', () => {
  it('returns the real port and base URL when asked for port 0', async () => {
    const hh = await boot();
    expect(hh.port).toBeGreaterThan(0);
    expect(hh.baseUrl).toBe(`http://127.0.0.1:${hh.port}`);
    expect((await api(hh, 'GET', '/health')).status).toBe(200);
  });

  it('listens on the port it was given', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const wanted = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const hh = await boot({ port: wanted });
    expect(hh.port).toBe(wanted);
  });

  it('is bound to 127.0.0.1 only', async () => {
    const hh = await boot();
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    expect(await canConnect('127.0.0.1', hh.port)).toBe(true);
    if (external) expect(await canConnect(external.address, hh.port)).toBe(false);
  });

  it('refuses to start twice and can stop twice', async () => {
    const hh = await boot();
    await expect(hh.server.start()).rejects.toThrow(/already running/);
    await hh.server.stop();
    await hh.server.stop();
  });

  it('frees the port on stop and can be started again', async () => {
    const hh = await boot();
    const firstPort = hh.port;
    await hh.server.stop();
    expect(await canConnect('127.0.0.1', firstPort)).toBe(false);
    await hh.start();
    expect((await api(hh, 'GET', '/health')).status).toBe(200);
    // the bus subscription was renewed with the restart
    const { client } = await connectWs(hh, hh.tokens.read);
    hh.bus.emit({ type: 'system.notice', level: 'info', message: 'after restart' });
    expect((await client.nextEvent('system.notice')).event).toMatchObject({ message: 'after restart' });
    client.close();
  });

  it('answers requests that are in flight before it stops', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hh = await boot({ overrides: { reports: { require: async () => { await gate; return { id: 'r1' }; } } } });
    const inFlight = api(hh, 'GET', '/reports/r1', { token: hh.tokens.read });
    await new Promise((r) => setTimeout(r, 50));
    const stopping = hh.server.stop();
    release();
    expect((await inFlight).status).toBe(200);
    await stopping;
  });
});

describe('port already in use', () => {
  it('rejects start() with a clear HttpListenError (code EADDRINUSE) and leaves the first server running', async () => {
    const first = await boot();
    const second = await boot({ port: first.port, noStart: true });
    const err = await second.server.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpListenError);
    expect(err).toMatchObject({ name: 'HttpListenError', code: 'EADDRINUSE', port: first.port });
    expect((err as Error).message).toContain(`Port ${first.port}`);
    expect((err as Error).message).toMatch(/already in use/);
    expect((err as Error).message).toMatch(/port 0/);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    expect((err as Error).message).not.toMatch(/\u2014/);
    // nothing is left half open
    await second.server.stop();
    expect((await api(first, 'GET', '/health')).status).toBe(200);
  });

  it('lets the caller retry with port 0', async () => {
    const first = await boot();
    const taken = await boot({ port: first.port, noStart: true });
    await expect(taken.server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const retry = await boot({ port: 0 });
    expect(retry.port).not.toBe(first.port);
    expect((await api(retry, 'GET', '/health')).status).toBe(200);
  });

  it('can be started again on the same instance once the port is free', async () => {
    const first = await boot();
    const port = first.port;
    const later = await boot({ port, noStart: true });
    await expect(later.server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await first.server.stop();
    await later.start();
    expect(later.port).toBe(port);
    expect((await api(later, 'GET', '/health')).status).toBe(200);
  });
});
