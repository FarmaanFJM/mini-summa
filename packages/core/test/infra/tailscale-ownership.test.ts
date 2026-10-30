// Which Serve entry is Mini-Summa's (SEC-11), and when its address may be handed out (SEC-12). Fake `tailscale` only:
// real Tailscale is NOT TESTED.
//
// The risk these tests guard: a Serve entry outlives the app. If it still forwards to the port the app used to listen on,
// whatever program listens there next receives the phones' bearer tokens. So the app records the entry it created,
// switches exactly that entry off when it stops, repairs it at start, and never touches an entry that is somebody else's.
import path from 'node:path';
import type { TailscaleStatus } from '@minisumma/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsService } from '../../src/infra/settings.ts';
import { SERVE_RECORD_KEY, createTailscaleService } from '../../src/infra/tailscale.ts';
import type { TailscaleDeps, TailscaleServiceImpl } from '../../src/infra/tailscale.ts';
import { cleanupTempDirs, eventually, expectPlainText, makeBase, tempDir } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';
import { FakeTailscale, serveConfigFor } from './tailscale-fake.ts';

const PORT = 4317; // the port this core listens on in most tests
const OLD_PORT = 47811; // the preferred port of an earlier run
const URL_OF_PC = 'https://farmaan-pc.tail1234.ts.net';

let base: TestBase | undefined;
let svc: TailscaleServiceImpl | undefined;
const fakes: FakeTailscale[] = [];

const fakeTs = (initial: ConstructorParameters<typeof FakeTailscale>[0] = {}): FakeTailscale => {
  const f = new FakeTailscale(initial);
  fakes.push(f);
  return f;
};

function setup(fake: FakeTailscale | null, extra: Partial<TailscaleDeps> = {}, remoteAccess: 'off' | 'tailscale' = 'off') {
  base = makeBase();
  const settings = createSettingsService({ base });
  if (remoteAccess === 'tailscale') settings.update({ mobile: { remoteAccess } });
  svc = createTailscaleService({
    base, settings, getPort: () => PORT, commandTimeoutMs: 5000,
    overrides: { tailscaleBin: fake ? fake.bin : path.join(tempDir(), 'no-such-tailscale') },
    ...extra,
  });
  return { svc, settings };
}

afterEach(async () => {
  await svc?.shutdown();
  svc = undefined;
  for (const f of fakes.splice(0)) expect(f.callLines().filter((l) => /funnel/i.test(l)), 'the funnel command must never be run').toEqual([]);
  base?.close();
  base = undefined;
  cleanupTempDirs();
});

const published = (port: number, extra: { funnel?: boolean } = {}): object => serveConfigFor({ target: `http://127.0.0.1:${port}`, ...extra });
const record = (): { port: number; createdAt: string } | null => {
  const row = base!.db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', [SERVE_RECORD_KEY]);
  return row ? (JSON.parse(row.value_json) as { port: number; createdAt: string }) : null;
};
const keepRecord = (port: number): void => {
  base!.db.run('INSERT OR REPLACE INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)', [SERVE_RECORD_KEY, JSON.stringify({ port, createdAt: 'an earlier run' }), 'x']);
};
const events = (): TailscaleStatus[] => base!.eventsOf('tailscale.changed').map((e) => e.status);
const serveCalls = (f: FakeTailscale): string[] => f.callLines().filter((l) => l.startsWith('serve --'));
/** What Serve forwards to now, as a port (the fake keeps the configuration in a file). */
const forwardedPort = (f: FakeTailscale): number | null => {
  const web = (f.serveConfig().Web ?? {}) as Record<string, { Handlers: Record<string, { Proxy?: string }> }>;
  const proxy = Object.values(web)[0]?.Handlers?.['/']?.Proxy;
  return proxy ? Number(/:(\d+)\/?$/.exec(proxy)?.[1]) : null;
};

describe('the record of the entry Mini-Summa created', () => {
  it('is written when Mini-Summa publishes its port: the port and when', async () => {
    const { svc } = setup(fakeTs());
    expect(record()).toBeNull();
    await svc.setServe(true);
    expect(record()).toEqual({ port: PORT, createdAt: base!.clock.iso() });
  });

  it('is not written for an entry somebody else made, even one that already points at this port', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT));
    const { svc } = setup(fake);
    expect((await svc.setServe(true)).serve.configured).toBe(true);
    expect(record()).toBeNull();
  });

  it('is removed when remote access is switched off by the user', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.setServe(true);
    expect(record()).not.toBeNull();
    await svc.setServe(false);
    expect(record()).toBeNull();
    expect(serveCalls(fake)).toContain('serve --https=443 off');
  });

  it('goes back to what it was when publishing fails', async () => {
    const fake = fakeTs({ serveCmd: { exit: 1, stderr: 'access denied\n' } });
    const { svc } = setup(fake);
    await svc.setServe(true);
    expect(record()).toBeNull(); // there was none before, so there is none now

    fake.setServe(published(OLD_PORT));
    keepRecord(OLD_PORT);
    const s = await svc.setServe(true);
    expect(s.problem).toMatch(/not allowed to manage it/);
    expect(record()).toEqual({ port: OLD_PORT, createdAt: 'an earlier run' }); // the old entry is still ours to clean up
  });

  it('ignores a value that is not a record, and an entry then counts as somebody else\'s', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake);
    for (const junk of ['not json', '{"port":"4317"}', '{"port":0}', '{"port":70000}', '{"port":47811.5}', 'null', '[]']) {
      base!.db.run('INSERT OR REPLACE INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)', [SERVE_RECORD_KEY, junk, 'x']);
      const s = await svc.status({ refresh: true });
      expect(s.problem, junk).toMatch(/already publishes something else on port 443/);
    }
  });
});

describe('shutdown switches off the entry Mini-Summa created (and only that)', () => {
  it('runs `tailscale serve --https=443 off`, forgets the record and stops reporting a public address', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.setServe(true);
    expect(svc.publicUrl()).toBe(URL_OF_PC);
    fake.clearCalls();

    await svc.shutdown();

    expect(fake.callLines()).toEqual(['serve status --json', 'serve --https=443 off']);
    expect(fake.serveConfig().Web ?? {}).toEqual({});
    expect(record()).toBeNull();
    expect(svc.publicUrl()).toBeNull();
    expect(base!.log.lines.some((l) => l.level === 'info' && /switched off its Tailscale Serve entry/.test(l.msg))).toBe(true);
  });

  it('works without init() having run, because the record is what matters', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake);
    keepRecord(OLD_PORT);
    await svc.shutdown();
    expect(serveCalls(fake)).toEqual(['serve --https=443 off']);
    expect(record()).toBeNull();
  });

  it('switches off an old entry of its own that still points at the recorded port, although this run listens elsewhere', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 });
    keepRecord(OLD_PORT);
    await svc.shutdown();
    expect(serveCalls(fake)).toEqual(['serve --https=443 off']);
    expect(fake.serveConfig().Web ?? {}).toEqual({});
  });

  it('does nothing at all, not even a command, when it never created an entry', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT)); // somebody else made it, and it even points at this port
    const { svc } = setup(fake);
    await svc.status({ refresh: true });
    fake.clearCalls();
    await svc.shutdown();
    expect(fake.calls()).toEqual([]);
    expect(forwardedPort(fake)).toBe(PORT);
  });

  it('leaves an entry alone that somebody pointed somewhere else since, and forgets the record', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.setServe(true);
    fake.setServe(published(9999)); // the user re-pointed it to something of their own
    fake.clearCalls();
    await svc.shutdown();
    expect(fake.callLines()).toEqual(['serve status --json']);
    expect(forwardedPort(fake)).toBe(9999);
    expect(record()).toBeNull();
  });

  it('forgets the record when the entry is already gone, without running anything that could change Serve', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.setServe(true);
    fake.setServe({});
    fake.clearCalls();
    await svc.shutdown();
    expect(fake.callLines()).toEqual(['serve status --json']);
    expect(record()).toBeNull();
  });

  it('does not touch an entry on a path other than `/` or on another port, even if it points at the recorded port', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    keepRecord(PORT);
    fake.setServe({
      Web: {
        'farmaan-pc.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } } },
        'farmaan-pc.tail1234.ts.net:443': { Handlers: { '/files': { Proxy: `http://127.0.0.1:${PORT}` } } },
      },
    });
    await svc.shutdown();
    expect(serveCalls(fake)).toEqual([]);
  });

  it('gives up after its time limit, keeps the record for the next start and still lets the app close', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake, { shutdownTimeoutMs: 700 });
    await svc.setServe(true);
    fake.set({ hang: true, hangOn: 'serve --https=443 off' });
    fake.clearCalls();

    const started = Date.now();
    await svc.shutdown();

    expect(Date.now() - started).toBeLessThan(3000);
    expect(fake.callLines()).toContain('serve --https=443 off'); // it did try
    expect(record()).toEqual({ port: PORT, createdAt: expect.any(String) });
    expect(forwardedPort(fake)).toBe(PORT); // the entry could not be removed, and the record says to retry
    const warning = base!.log.lines.find((l) => l.level === 'warn' && /could not switch off its Tailscale Serve entry/.test(l.msg));
    expect(warning?.msg).toMatch(/cleaned up at the next start/);
    expectPlainText(warning?.msg);
  });

  it('spends no more than the limit in total, whichever of its two commands is slow', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake, { shutdownTimeoutMs: 600 });
    await svc.setServe(true);
    fake.set({ hang: true, hangOn: 'serve status' });
    fake.clearCalls();
    const started = Date.now();
    await svc.shutdown();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(serveCalls(fake)).toEqual([]); // it could not even read the configuration, so it changed nothing
    expect(record()).not.toBeNull();
  });

  it('keeps the record when Tailscale is not running, so the next start can clean up', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.setServe(true);
    fake.set({ serveStatus: { exit: 1, stderr: 'failed to connect to local Tailscale service; is Tailscale running?\n' } });
    fake.clearCalls();
    await svc.shutdown();
    expect(serveCalls(fake)).toEqual([]);
    expect(record()).not.toBeNull();
  });

  it('keeps the record when the program is gone, and never throws', async () => {
    const { svc } = setup(null);
    keepRecord(PORT);
    await expect(svc.shutdown()).resolves.toBeUndefined();
    expect(record()).not.toBeNull();
  });

  it('is safe to call twice and runs its commands once', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.setServe(true);
    fake.clearCalls();
    const first = svc.shutdown();
    const second = svc.shutdown();
    expect(second).toBe(first);
    await first;
    await svc.shutdown();
    expect(serveCalls(fake)).toEqual(['serve --https=443 off']);
  });

  it('still does its work when a status check was running and had to be killed', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake, { commandTimeoutMs: 30_000 });
    await svc.setServe(true);
    fake.set({ hang: true, hangOn: 'status --json' }); // the next poll hangs (`serve status` and `off` still answer)
    const pending = svc.status({ refresh: true });
    await eventually(() => fake.callLines().filter((l) => l === 'status --json').length >= 3);
    fake.set({ hang: false });
    await svc.shutdown();
    await pending;
    expect(serveCalls(fake)).toContain('serve --https=443 off');
    expect(record()).toBeNull();
  });
});

describe('start-up reconcile (remote access is "tailscale")', () => {
  it('publishes the port when there is no entry', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake, {}, 'tailscale');
    svc.init();
    await eventually(() => svc.publicUrl());
    expect(svc.publicUrl()).toBe(URL_OF_PC);
    expect(fake.callLines()).toEqual(['status --json', 'serve status --json', `serve --bg --https=443 http://127.0.0.1:${PORT}`, 'status --json', 'serve status --json']);
    expect(record()?.port).toBe(PORT);
  });

  it('leaves the entry alone when it already points at the port this core listens on', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT));
    const { svc } = setup(fake, {}, 'tailscale');
    svc.init();
    await eventually(() => svc.publicUrl());
    await new Promise((r) => setTimeout(r, 100));
    expect(serveCalls(fake)).toEqual([]);
    expect(record()).toBeNull();
  });

  it('re-points an entry it created that forwards to another port, and says so while it is wrong', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 }, 'tailscale');
    keepRecord(OLD_PORT);
    svc.init();
    await eventually(() => svc.publicUrl());

    expect(serveCalls(fake)).toEqual(['serve --bg --https=443 http://127.0.0.1:51234']);
    expect(forwardedPort(fake)).toBe(51234);
    expect(record()).toMatchObject({ port: 51234 });
    expect(svc.publicUrl()).toBe(URL_OF_PC);
    const seen = events();
    expect(seen[0].serve.configured).toBe(false);
    expect(seen[0].problem).toMatch(/still forwards phone traffic to port 47811.*now listens on port 51234/);
    expectPlainText(seen[0].problem);
    expect(seen.at(-1)).toMatchObject({ serve: { configured: true, target: 'http://127.0.0.1:51234' }, problem: null });
  });

  it('does not touch an entry it did not create, even one on the old preferred port', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 }, 'tailscale');
    svc.init();
    await eventually(() => svc.cachedStatus());
    expect(serveCalls(fake)).toEqual([]);
    expect(forwardedPort(fake)).toBe(OLD_PORT);
    expect(svc.cachedStatus()?.problem).toMatch(/already publishes something else on port 443 \(http:\/\/127\.0\.0\.1:47811\)/);
    expect(svc.publicUrl()).toBeNull();
    expect(record()).toBeNull();
  });

  it('only reports the problem when Tailscale is not running or not signed in', async () => {
    for (const [status, problem] of [[{ state: 'Stopped' }, /turned off/], [{ state: 'NeedsLogin', dns: null }, /not signed in/]] as const) {
      const fake = fakeTs();
      fake.setStatus(status);
      const { svc } = setup(fake, {}, 'tailscale');
      svc.init();
      await eventually(() => svc.cachedStatus());
      expect(svc.cachedStatus()?.problem).toMatch(problem);
      expect(fake.callLines()).toEqual(['status --json']);
      expect(record()).toBeNull();
      await svc.shutdown();
      base!.close();
    }
  });

  it('only reports the problem when there is no Tailscale at all', async () => {
    const { svc } = setup(null, {}, 'tailscale');
    svc.init();
    await eventually(() => svc.cachedStatus());
    expect(svc.cachedStatus()?.problem).toMatch(/not installed/);
    expect(record()).toBeNull();
  });

  it('does not publish while Funnel is on', async () => {
    const fake = fakeTs();
    fake.setServe({ ...published(9999), AllowFunnel: { 'farmaan-pc.tail1234.ts.net:443': true } });
    const { svc } = setup(fake, {}, 'tailscale');
    svc.init();
    await eventually(() => svc.cachedStatus());
    expect(serveCalls(fake)).toEqual([]);
    expect(svc.cachedStatus()?.serve.funnelDetected).toBe(true);
  });

  it('reports a failure to publish instead of throwing, and keeps no record of an entry that was not made', async () => {
    const fake = fakeTs({ serveCmd: { exit: 1, stderr: 'Access denied: serve config denied\n' } });
    const { svc } = setup(fake, {}, 'tailscale');
    svc.init();
    await eventually(() => svc.cachedStatus()?.problem?.includes('not allowed to manage it'));
    expect(svc.publicUrl()).toBeNull();
    expect(record()).toBeNull();
  });

  it('does not publish before the local server has a port', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake, { getPort: () => 0 }, 'tailscale');
    svc.init();
    await eventually(() => svc.cachedStatus()?.problem);
    expect(svc.cachedStatus()?.problem).toMatch(/has not started its local server yet/);
    expect(serveCalls(fake)).toEqual([]);
    expect(record()).toBeNull();
  });

  it('repairs the entry only once per start, not on every poll', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake, { pollIntervalMs: 40 }, 'tailscale');
    svc.init();
    await eventually(() => svc.publicUrl());
    fake.setServe({}); // somebody removes the entry while the app runs; the poll reports it, it does not silently re-create it
    await eventually(() => svc.cachedStatus()?.serve.configured === false);
    await new Promise((r) => setTimeout(r, 200));
    expect(serveCalls(fake).filter((l) => l.startsWith('serve --bg'))).toHaveLength(1);
  });
});

describe('start-up with remote access off', () => {
  it('switches off the entry it recorded in an earlier run (that run could not shut down), then forgets it', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT));
    const { svc } = setup(fake, {}, 'off');
    keepRecord(PORT);
    svc.init();
    await eventually(() => record() === null);
    expect(serveCalls(fake)).toEqual(['serve --https=443 off']);
    expect(fake.serveConfig().Web ?? {}).toEqual({});
    await eventually(() => svc.cachedStatus()?.serve.configured === false);
  });

  it('also removes an old entry of its own that points at a port it no longer uses', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 }, 'off');
    keepRecord(OLD_PORT);
    svc.init();
    await eventually(() => record() === null);
    expect(serveCalls(fake)).toEqual(['serve --https=443 off']);
  });

  it('leaves an entry alone that is not the recorded one, and forgets the stale record', async () => {
    const fake = fakeTs();
    fake.setServe(published(9999));
    const { svc } = setup(fake, {}, 'off');
    keepRecord(PORT);
    svc.init();
    await eventually(() => record() === null);
    expect(serveCalls(fake)).toEqual([]);
    expect(forwardedPort(fake)).toBe(9999);
  });

  it('forgets a record whose entry no longer exists', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake, {}, 'off');
    keepRecord(PORT);
    svc.init();
    await eventually(() => record() === null);
    expect(serveCalls(fake)).toEqual([]);
  });

  it('keeps the record while Tailscale cannot be asked', async () => {
    const fake = fakeTs();
    fake.setStatus({ state: 'Stopped' });
    const { svc } = setup(fake, {}, 'off');
    keepRecord(PORT);
    svc.init();
    await eventually(() => svc.cachedStatus());
    expect(record()).not.toBeNull();
    expect(serveCalls(fake)).toEqual([]);
  });

  it('does not run a single command when there is no record', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT));
    const { svc } = setup(fake, {}, 'off');
    svc.init();
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.calls()).toEqual([]);
  });
});

describe('the public address', () => {
  it('is null when Serve forwards to a port other than the one this core listens on: an old entry of its own', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake);
    keepRecord(OLD_PORT);
    const s = await svc.status({ refresh: true });
    expect(s.serve).toEqual({ configured: false, url: null, target: null, funnelDetected: false });
    expect(s.problem).toMatch(/Tailscale Serve still forwards phone traffic to port 47811/);
    expect(s.problem).toMatch(/now listens on port 4317/);
    expect(s.problem).toMatch(/another program could be listening on port 47811/);
    expectPlainText(s.problem);
    expect(svc.publicUrl()).toBeNull();
  });

  it('is null for an entry somebody else made on another port', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake);
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBeNull();
  });

  it('is checked against the port at the time of the call, not only at the time of the last check', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT));
    let port = PORT;
    const { svc } = setup(fake, { getPort: () => port });
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBe(URL_OF_PC);
    port = 51234;
    expect(svc.publicUrl()).toBeNull();
    port = PORT;
    expect(svc.publicUrl()).toBe(URL_OF_PC);
  });

  it('is null while Funnel is on, although Serve forwards to the right port, and returns when Funnel is off', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT, { funnel: true }));
    const { svc } = setup(fake);
    const s = await svc.status({ refresh: true });
    expect(s.serve).toMatchObject({ configured: true, funnelDetected: true });
    expect(svc.publicUrl()).toBeNull();
    fake.setServe(published(PORT));
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBe(URL_OF_PC);
    fake.setServe(published(PORT, { funnel: true }));
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBeNull();
  });

  it('is null once the service has shut down', async () => {
    const fake = fakeTs();
    fake.setServe(published(PORT));
    const { svc } = setup(fake);
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBe(URL_OF_PC);
    await svc.shutdown();
    expect(svc.publicUrl()).toBeNull();
  });
});

describe('setServe with an old entry of its own', () => {
  it('turns it on by re-pointing the old entry to the port in use', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 });
    keepRecord(OLD_PORT);
    const s = await svc.setServe(true);
    expect(serveCalls(fake)).toEqual(['serve --bg --https=443 http://127.0.0.1:51234']);
    expect(s.serve).toMatchObject({ configured: true, target: 'http://127.0.0.1:51234' });
    expect(s.problem).toBeNull();
    expect(record()?.port).toBe(51234);
  });

  it('turns it off by removing the old entry', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 });
    keepRecord(OLD_PORT);
    const s = await svc.setServe(false);
    expect(serveCalls(fake)).toEqual(['serve --https=443 off']);
    expect(s.serve.configured).toBe(false);
    expect(s.problem).toBeNull();
    expect(record()).toBeNull();
  });

  it('keeps the record when switching off fails, so a later start can try again', async () => {
    const fake = fakeTs({ serveOff: { exit: 1, stderr: 'access denied\n' } });
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 });
    keepRecord(OLD_PORT);
    const s = await svc.setServe(false);
    expect(s.problem).toMatch(/not allowed to manage it/);
    expect(record()?.port).toBe(OLD_PORT);
  });

  it('still refuses to replace or remove an entry that has no matching record', async () => {
    const fake = fakeTs();
    fake.setServe(published(OLD_PORT));
    const { svc } = setup(fake, { getPort: () => 51234 });
    expect((await svc.setServe(true)).problem).toMatch(/already publishes something else/);
    expect((await svc.setServe(false)).problem).toMatch(/already publishes something else/);
    expect(serveCalls(fake)).toEqual([]);
    expect(forwardedPort(fake)).toBe(OLD_PORT);
  });

  it('does not keep a record of nothing: switching off when there is no entry forgets it', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    keepRecord(OLD_PORT);
    await svc.setServe(false);
    expect(record()).toBeNull();
    expect(serveCalls(fake)).toEqual([]);
  });
});
