// TailscaleService against a fake `tailscale` executable (see tailscale-fake.ts). Real Tailscale: NOT TESTED.
import fs from 'node:fs';
import path from 'node:path';
import type { TailscaleStatus } from '@minisumma/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsService } from '../../src/infra/settings.ts';
import { createTailscaleService } from '../../src/infra/tailscale.ts';
import type { TailscaleDeps, TailscaleServiceImpl } from '../../src/infra/tailscale.ts';
import { cleanupTempDirs, eventually, expectPlainText, makeBase, tempDir } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';
import { FakeTailscale, serveConfigFor, statusJson } from './tailscale-fake.ts';

const PORT = 4317;
const DNS = 'farmaan-pc.tail1234.ts.net';

let base: TestBase | undefined;
let svc: TailscaleServiceImpl | undefined;
const fakes: FakeTailscale[] = [];

function fakeTs(initial: ConstructorParameters<typeof FakeTailscale>[0] = {}): FakeTailscale {
  const f = new FakeTailscale(initial);
  fakes.push(f);
  return f;
}

function setup(fake: FakeTailscale | null, extra: Partial<TailscaleDeps> = {}, remoteAccess: 'off' | 'tailscale' = 'off') {
  base = makeBase();
  const settings = createSettingsService({ base });
  if (remoteAccess === 'tailscale') settings.update({ mobile: { remoteAccess } });
  svc = createTailscaleService({
    base, settings, getPort: () => PORT, commandTimeoutMs: 5000,
    overrides: fake ? { tailscaleBin: fake.bin } : { tailscaleBin: path.join(tempDir(), 'no-such-tailscale') },
    ...extra,
  });
  return { svc, settings };
}

afterEach(() => {
  svc?.shutdown();
  svc = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // Funnel is never enabled and never even queried through the funnel command.
  for (const f of fakes.splice(0)) expect(f.callLines().filter((l) => /funnel/i.test(l)), 'the funnel command must never be run').toEqual([]);
  base?.close();
  base = undefined;
  cleanupTempDirs();
});

const events = (): TailscaleStatus[] => base!.eventsOf('tailscale.changed').map((e) => e.status);
const times = (lines: string[], text: string): number => lines.filter((l) => l === text).length;

describe.skipIf(process.platform === 'win32')('reading the state', () => {
  it('reports a missing program as "not installed", with what to do, and never throws', async () => {
    const { svc } = setup(null);
    const s = await svc.status({ refresh: true });
    expect(s).toMatchObject({ installed: false, running: false, loggedIn: false, backendState: null, hostName: null, dnsName: null, tailnet: null, tailscaleIps: [], serve: { configured: false, url: null, target: null, funnelDetected: false } });
    expect(s.problem).toMatch(/not installed/);
    expect(s.problem).toContain('https://tailscale.com/download');
    expectPlainText(s.problem);
    expect(Date.parse(s.checkedAt)).toBe(base!.clock.now().getTime());
    expect(svc.publicUrl()).toBeNull();
  });

  it('finds `tailscale` on the PATH when no program is configured', async () => {
    const fake = fakeTs();
    const bin = path.join(tempDir(), 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(fake.bin, path.join(bin, 'tailscale'));
    fs.chmodSync(path.join(bin, 'tailscale'), 0o755);
    vi.stubEnv('PATH', bin);
    base = makeBase();
    const settings = createSettingsService({ base });
    svc = createTailscaleService({ base, settings, getPort: () => PORT, commandTimeoutMs: 5000 });
    const s = await svc.status({ refresh: true });
    expect(s.installed).toBe(true);
    expect(s.dnsName).toBe(DNS);
    // and says "not installed" when it is on no PATH (the Windows install folder does not exist here either)
    vi.stubEnv('PATH', tempDir());
    const gone = createTailscaleService({ base: base, settings, getPort: () => PORT, commandTimeoutMs: 5000 });
    expect((await gone.status({ refresh: true })).installed).toBe(false);
  });

  it('reads a running, signed-in machine', async () => {
    const { svc } = setup(fakeTs());
    const s = await svc.status();
    expect(s).toMatchObject({
      installed: true, running: true, loggedIn: true, backendState: 'Running', hostName: 'FARMAAN-PC', dnsName: DNS,
      tailnet: 'farmaan@example.com', tailscaleIps: ['100.101.102.103', 'fd7a:115c:a1e0::1234'], problem: null,
      serve: { configured: false, url: null, target: null, funnelDetected: false },
    });
    expect(svc.publicUrl()).toBeNull();
  });

  it('strips the trailing dot of the DNS name and tolerates a Tailscale without IPs at the top level', async () => {
    const fake = fakeTs();
    fake.setStatusAnswer({ stdout: JSON.stringify({ BackendState: 'Running', Self: { HostName: 'h', DNSName: 'pc.example.ts.net.', TailscaleIPs: ['100.1.1.1'] }, CertDomains: ['pc.example.ts.net'] }) });
    const s = await setup(fake).svc.status({ refresh: true });
    expect(s).toMatchObject({ dnsName: 'pc.example.ts.net', tailscaleIps: ['100.1.1.1'], tailnet: null, hostName: 'h', problem: null });
  });

  const notRunning: [string, Parameters<FakeTailscale['setStatus']>[0], Partial<TailscaleStatus>, RegExp][] = [
    ['signed out', { state: 'NeedsLogin', dns: null }, { running: false, loggedIn: false, backendState: 'NeedsLogin' }, /not signed in.*sign in/],
    ['turned off', { state: 'Stopped' }, { running: false, loggedIn: true, backendState: 'Stopped' }, /turned off.*Connect/],
    ['waiting for approval', { state: 'NeedsMachineAuth' }, { running: false, loggedIn: true, backendState: 'NeedsMachineAuth' }, /waiting for approval.*admin/],
    ['starting', { state: 'Starting' }, { running: false, loggedIn: true, backendState: 'Starting' }, /still starting/],
    ['not started yet', { state: 'NoState' }, { running: false, loggedIn: false, backendState: 'NoState' }, /still starting/],
    ['in a state nobody knows', { state: 'Banana' }, { running: false, loggedIn: true, backendState: 'Banana' }, /"Banana".*does not recognise/],
  ];
  for (const [name, status, expected, problem] of notRunning) {
    it(`explains a machine that is ${name}, and does not look for Serve`, async () => {
      const fake = fakeTs();
      fake.setStatus(status);
      const s = await setup(fake).svc.status({ refresh: true });
      expect(s).toMatchObject({ installed: true, ...expected });
      expect(s.problem).toMatch(problem);
      expectPlainText(s.problem);
      expect(fake.callLines()).toEqual(['status --json']);
      expect(s.serve).toEqual({ configured: false, url: null, target: null, funnelDetected: false });
    });
  }

  it('says Tailscale is not running when the daemon does not answer', async () => {
    const fake = fakeTs();
    fake.setStatusAnswer({ exit: 1, stderr: 'failed to connect to local Tailscale service; is Tailscale running?\n' });
    const s = await setup(fake).svc.status({ refresh: true });
    expect(s).toMatchObject({ installed: true, running: false, backendState: null });
    expect(s.problem).toMatch(/not running.*Start the Tailscale app/);
  });

  it('turns every other failure into a sentence that quotes what Tailscale said', async () => {
    const fake = fakeTs();
    fake.setStatusAnswer({ exit: 1, stderr: 'some unexpected failure\nwith two lines\n' });
    const failed = await setup(fake).svc.status({ refresh: true });
    expect(failed.installed).toBe(true);
    expect(failed.problem).toContain('some unexpected failure with two lines');
    expect(failed.problem).toMatch(/Run "tailscale status"/);

    fake.setStatusAnswer({ stdout: 'this is not json' });
    expect((await svc!.status({ refresh: true })).problem).toMatch(/could not read.*Update Tailscale/);
    fake.setStatusAnswer({ stdout: '' });
    expect((await svc!.status({ refresh: true })).problem).toMatch(/could not read/);
    fake.setStatusAnswer({ stdout: '[1,2,3]' });
    expect((await svc!.status({ refresh: true })).problem).toMatch(/could not read/);
  });

  it('does not wait for ever for a Tailscale that never answers', async () => {
    const fake = fakeTs({ hang: true });
    const { svc } = setup(fake, { commandTimeoutMs: 300 });
    const started = Date.now();
    const s = await svc.status({ refresh: true });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(s.installed).toBe(true);
    expect(s.problem).toMatch(/did not answer in time/);
    expectPlainText(s.problem);
  });

  it('reports a program that cannot be started as a problem with the error code', async () => {
    const dir = tempDir();
    const notExecutable = path.join(dir, 'tailscale');
    fs.writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const { svc } = setup(null, { overrides: { tailscaleBin: notExecutable } });
    const s = await svc.status({ refresh: true });
    expect(s.installed).toBe(true);
    expect(s.problem).toMatch(/could not start Tailscale \(EACCES\)/);
  });
});

describe.skipIf(process.platform === 'win32')('reading what Serve publishes', () => {
  it('sees that Mini-Summa\'s port is published, and offers the address phones should use', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ target: `http://127.0.0.1:${PORT}` }));
    const { svc } = setup(fake);
    const s = await svc.status({ refresh: true });
    expect(s.serve).toEqual({ configured: true, url: `https://${DNS}`, target: `http://127.0.0.1:${PORT}`, funnelDetected: false });
    expect(s.problem).toBeNull();
    expect(svc.publicUrl()).toBe(`https://${DNS}`);
  });

  for (const target of [`http://localhost:${PORT}`, `http://[::1]:${PORT}`, `127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}/`]) {
    it(`recognises the target ${target} as this Mini-Summa`, async () => {
      const fake = fakeTs();
      fake.setServe(serveConfigFor({ target }));
      expect((await setup(fake).svc.status({ refresh: true })).serve.configured).toBe(true);
    });
  }

  it('treats an empty configuration, "{}" and the plain-text "No serve config" as nothing published', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    for (const out of ['', '{}', '{}\n', 'No serve config\n']) {
      fake.set({ serveStatus: { stdout: out } });
      const s = await svc.status({ refresh: true });
      expect(s.serve).toEqual({ configured: false, url: null, target: null, funnelDetected: false });
      expect(s.problem, JSON.stringify(out)).toBeNull();
    }
  });

  it('finds Mini-Summa in a foreground Serve session too', async () => {
    const fake = fakeTs();
    fake.setServe({ Foreground: { 'session-1': serveConfigFor({ target: `http://127.0.0.1:${PORT}` }) } });
    expect((await setup(fake).svc.status({ refresh: true })).serve.configured).toBe(true);
  });

  it('says so when Serve cannot be read, and keeps what it knows about the connection', async () => {
    const fake = fakeTs();
    fake.set({ serveStatus: { exit: 1, stderr: 'unknown command "status" for "tailscale serve"\n' } });
    const s = await setup(fake).svc.status({ refresh: true });
    expect(s).toMatchObject({ installed: true, running: true, dnsName: DNS });
    expect(s.problem).toMatch(/could not read which services Tailscale Serve publishes/);
    expect(s.problem).toContain('unknown command');
    fake.set({ serveStatus: { stdout: 'garbled' } });
    expect((await svc!.status({ refresh: true })).problem).toMatch(/unexpected output/);
    fake.set({ serveStatus: { exit: 1, stderr: 'failed to connect to local tailscaled\n' } });
    expect((await svc!.status({ refresh: true })).problem).toMatch(/not running/);
  });

  it('reports Funnel when it is on, with the command that turns it off', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ funnel: true, target: `http://127.0.0.1:${PORT}` }));
    const { svc } = setup(fake);
    const s = await svc.status({ refresh: true });
    expect(s.serve.funnelDetected).toBe(true);
    expect(s.problem).toContain(`${DNS}:443`);
    expect(s.problem).toContain('tailscale funnel reset');
    expect(s.problem).toMatch(/internet/);
    expectPlainText(s.problem);
    // Funnel on another service is Funnel on this computer
    fake.setServe({ ...serveConfigFor({ target: 'http://127.0.0.1:9999', port: 8443 }), AllowFunnel: { [`${DNS}:8443`]: true } });
    expect((await svc.status({ refresh: true })).serve.funnelDetected).toBe(true);
    // a funnel entry that is switched off is not Funnel
    fake.setServe({ ...serveConfigFor({}), AllowFunnel: { [`${DNS}:443`]: false } });
    expect((await svc.status({ refresh: true })).serve.funnelDetected).toBe(false);
  });

  it('reports a Serve entry on the HTTPS port that is not Mini-Summa\'s, and does not call it ours', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ target: 'http://127.0.0.1:9999' }));
    const s = await setup(fake).svc.status({ refresh: true });
    expect(s.serve).toEqual({ configured: false, url: null, target: null, funnelDetected: false });
    expect(s.problem).toMatch(/already publishes something else on port 443 \(http:\/\/127\.0\.0\.1:9999\)/);
    expect(s.problem).toContain('tailscale serve --https=443 off');
    expect(svc!.publicUrl()).toBeNull();
  });

  it('explains a missing DNS name and tailnet HTTPS that is not enabled', async () => {
    const fake = fakeTs();
    fake.setStatus({ dns: null });
    const { svc } = setup(fake);
    expect((await svc.status({ refresh: true })).problem).toMatch(/no Tailscale DNS name.*MagicDNS/);
    fake.setStatus({ certDomains: null });
    const noHttps = await svc.status({ refresh: true });
    expect(noHttps.problem).toMatch(/HTTPS certificates are not enabled.*Enable HTTPS/);
    expectPlainText(noHttps.problem);
    fake.setStatus({ certDomains: [] });
    expect((await svc.status({ refresh: true })).problem).toMatch(/HTTPS certificates are not enabled/);
    // an old Tailscale that does not report the field at all is not accused of anything
    fake.setStatus({ certDomains: 'absent' });
    expect((await svc.status({ refresh: true })).problem).toBeNull();
  });

  it('gives the Serve URL only while the backend is running', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ target: `http://127.0.0.1:${PORT}` }));
    const { svc } = setup(fake);
    expect(svc.publicUrl()).toBeNull(); // nothing has been checked yet
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBe(`https://${DNS}`);
    fake.setStatus({ state: 'Stopped' });
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBeNull();
    fake.setStatus({});
    await svc.status({ refresh: true });
    expect(svc.publicUrl()).toBe(`https://${DNS}`);
  });
});

describe.skipIf(process.platform === 'win32')('turning Serve on and off', () => {
  it('publishes Mini-Summa\'s port on the HTTPS port, then reads the result back', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    const s = await svc.setServe(true);
    expect(fake.callLines()).toEqual([
      'status --json', 'serve status --json',
      `serve --bg --https=443 http://127.0.0.1:${PORT}`,
      'status --json', 'serve status --json',
    ]);
    expect(s.serve).toEqual({ configured: true, url: `https://${DNS}`, target: `http://127.0.0.1:${PORT}`, funnelDetected: false });
    expect(s.problem).toBeNull();
    expect(svc.publicUrl()).toBe(`https://${DNS}`);
    expect(events().at(-1)).toEqual(s);
  });

  it('uses the port the server really listens on, read at the time of the call', async () => {
    const fake = fakeTs();
    let port = 5555;
    const { svc } = setup(fake, { getPort: () => port });
    await svc.setServe(true);
    expect(fake.callLines()).toContain('serve --bg --https=443 http://127.0.0.1:5555');
    port = 6666;
    fake.setServe(null);
    await svc.setServe(true);
    expect(fake.callLines()).toContain('serve --bg --https=443 http://127.0.0.1:6666');
  });

  it('does not publish twice: turning it on when it is on changes nothing', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ target: `http://127.0.0.1:${PORT}` }));
    const s = await setup(fake).svc.setServe(true);
    expect(s.serve.configured).toBe(true);
    expect(fake.callLines().some((l) => l.startsWith('serve --bg'))).toBe(false);
  });

  it('switches its own entry off with `serve --https=443 off`, and only when it is its own', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.setServe(true);
    fake.clearCalls();
    const off = await svc.setServe(false);
    expect(fake.callLines()).toEqual(['status --json', 'serve status --json', 'serve --https=443 off', 'status --json', 'serve status --json']);
    expect(off.serve).toEqual({ configured: false, url: null, target: null, funnelDetected: false });
    expect(svc.publicUrl()).toBeNull();
    // already off: nothing to switch off, nothing run
    fake.clearCalls();
    await svc.setServe(false);
    expect(fake.callLines().some((l) => l.includes(' off'))).toBe(false);
  });

  it('refuses to turn Serve on while Funnel is on, and runs nothing that could change it', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ funnel: true, target: 'http://127.0.0.1:9999' }));
    const s = await setup(fake).svc.setServe(true);
    expect(s.serve.funnelDetected).toBe(true);
    expect(s.serve.configured).toBe(false);
    expect(s.problem).toContain('tailscale funnel reset');
    expect(fake.callLines().filter((l) => l.startsWith('serve --'))).toEqual([]);
  });

  it('refuses on Funnel alone, even when no Serve entry is in the way', async () => {
    const fake = fakeTs();
    // Funnel is on for another service on port 8443; nothing at all is published on 443.
    fake.setServe({ ...serveConfigFor({ target: 'http://127.0.0.1:9999', port: 8443 }), AllowFunnel: { [`${DNS}:8443`]: true } });
    const s = await setup(fake).svc.setServe(true);
    expect(s.serve).toMatchObject({ funnelDetected: true, configured: false });
    expect(s.problem).toContain('tailscale funnel reset');
    expect(fake.callLines().filter((l) => l.startsWith('serve --'))).toEqual([]);
    // once the user has turned Funnel off, Mini-Summa publishes
    fake.setServe(serveConfigFor({ target: 'http://127.0.0.1:9999', port: 8443 }));
    expect((await svc!.setServe(true)).serve.configured).toBe(true);
  });

  it('lets the user switch its own Serve entry off even while Funnel is on', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ funnel: true, target: `http://127.0.0.1:${PORT}` }));
    await setup(fake).svc.setServe(false);
    expect(fake.callLines()).toContain('serve --https=443 off');
  });

  it('does not replace, or switch off, a Serve entry that is not Mini-Summa\'s', async () => {
    const fake = fakeTs();
    fake.setServe(serveConfigFor({ target: 'http://127.0.0.1:9999' }));
    const { svc } = setup(fake);
    const on = await svc.setServe(true);
    expect(on.problem).toMatch(/already publishes something else/);
    const off = await svc.setServe(false);
    expect(off.problem).toMatch(/already publishes something else/);
    expect(fake.callLines().filter((l) => l.startsWith('serve --'))).toEqual([]);
    expect(fake.serveConfig()).toEqual(serveConfigFor({ target: 'http://127.0.0.1:9999' }));
  });

  const blocked: [string, Parameters<FakeTailscale['setStatus']>[0], RegExp][] = [
    ['signed out', { state: 'NeedsLogin', dns: null }, /not signed in/],
    ['turned off', { state: 'Stopped' }, /turned off/],
    ['still starting', { state: 'Starting' }, /still starting/],
  ];
  for (const [name, status, problem] of blocked) {
    it(`does not try to publish while Tailscale is ${name}`, async () => {
      const fake = fakeTs();
      fake.setStatus(status);
      const s = await setup(fake).svc.setServe(true);
      expect(s.problem).toMatch(problem);
      expect(s.serve.configured).toBe(false);
      expect(fake.callLines()).toEqual(['status --json']);
    });
  }

  it('says "not installed" instead of failing when there is no Tailscale', async () => {
    const { svc } = setup(null);
    expect((await svc.setServe(true)).problem).toMatch(/not installed/);
    expect((await svc.setServe(false)).problem).toMatch(/not installed/);
  });

  const failures: [string, string, RegExp][] = [
    ['serve is not enabled on the tailnet', 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\t https://login.tailscale.com/f/serve?node=n123abc\n', /Serve is not enabled for your tailnet.*admin.*https:\/\/login\.tailscale\.com\/f\/serve\?node=n123abc/],
    ['HTTPS is not enabled for the tailnet', 'HTTPS cert support is not enabled/configured for your tailnet\n', /HTTPS certificates are not enabled.*Enable HTTPS/],
    ['access is denied', 'Access denied: serve config denied\nUse \'sudo tailscale serve\' or \'tailscale set --operator=$USER\' to not require root.\n', /not allowed to manage it.*operator/],
    ['the flag is unknown', 'flag provided but not defined: -bg\n', /too old.*1\.52/],
    ['the daemon went away', 'failed to connect to local Tailscale service; is Tailscale running?\n', /not running.*Start the Tailscale app/],
    ['anything else', 'something exploded in a way nobody planned\n', /could not publish Mini-Summa\. It said: something exploded in a way nobody planned\. Run "tailscale serve status"/],
  ];
  for (const [name, stderr, problem] of failures) {
    it(`turns "${name}" into a problem, leaves Serve off and tells every client`, async () => {
      const fake = fakeTs({ serveCmd: { exit: 1, stderr } });
      const { svc } = setup(fake);
      const s = await svc.setServe(true);
      expect(s.serve.configured).toBe(false);
      expect(s.problem).toMatch(problem);
      expectPlainText(s.problem);
      expect(events().at(-1)).toEqual(s);
      expect(svc.publicUrl()).toBeNull();
      expect(fake.serveConfig()).toEqual({});
    });
  }

  it('turns a failing switch-off into a problem and keeps reporting that Serve is on', async () => {
    const fake = fakeTs({ serveOff: { exit: 1, stderr: 'access denied\n' } });
    fake.setServe(serveConfigFor({ target: `http://127.0.0.1:${PORT}` }));
    const s = await setup(fake).svc.setServe(false);
    expect(s.serve.configured).toBe(true);
    expect(s.problem).toMatch(/not allowed to manage it/);
    expect(s.problem).toMatch(/\.$/);
  });

  it('does not believe a command that says it worked while Serve shows nothing', async () => {
    const fake = fakeTs({ serveCmd: { apply: false } });
    const s = await setup(fake).svc.setServe(true);
    expect(s.serve.configured).toBe(false);
    expect(s.problem).toMatch(/accepted the command but does not list Mini-Summa as published/);
    const fake2 = fakeTs({ serveOff: { apply: false } });
    fake2.setServe(serveConfigFor({ target: `http://127.0.0.1:${PORT}` }));
    const off = await setup(fake2).svc.setServe(false);
    expect(off.serve.configured).toBe(true);
    expect(off.problem).toMatch(/still published/);
  });

  it('reads where to enable Serve from output printed before Tailscale started waiting', async () => {
    const fake = fakeTs({ serveCmd: {} });
    fake.set({ hang: true, hangOn: 'serve --bg', hangOutput: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\t https://login.tailscale.com/f/serve?node=n9\n' });
    const s = await setup(fake, { commandTimeoutMs: 800 }).svc.setServe(true);
    expect(s.serve.configured).toBe(false);
    expect(s.problem).toMatch(/Serve is not enabled for your tailnet.*https:\/\/login\.tailscale\.com\/f\/serve\?node=n9/);
  });

  it('says it timed out when Tailscale printed nothing before it stopped answering', async () => {
    const fake = fakeTs();
    fake.set({ hang: true, hangOn: 'serve --bg' });
    const s = await setup(fake, { commandTimeoutMs: 400 }).svc.setServe(true);
    expect(s.problem).toMatch(/did not answer in time/);
    expect(s.problem).toContain('tailscale serve --bg --https=443');
  });

  it('runs one command at a time: a refresh during a change waits for it', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    const results = await Promise.all([svc.setServe(true), svc.status({ refresh: true }), svc.status({ refresh: true })]);
    expect(results[0].serve.configured).toBe(true);
    expect(results[1].serve.configured).toBe(true); // it ran after the change, not during it
    const lines = fake.callLines();
    const at = lines.indexOf(`serve --bg --https=443 http://127.0.0.1:${PORT}`);
    expect(at).toBeGreaterThan(1);
    expect(lines.slice(0, at)).toEqual(['status --json', 'serve status --json']);
    expect(lines.slice(at + 1).every((l) => l === 'status --json' || l === 'serve status --json')).toBe(true);
    expect(times(lines, 'status --json')).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(process.platform === 'win32')('keeping the answer current', () => {
  it('answers from the last check for a few seconds, and runs again when asked to refresh or when it is old', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    await svc.status();
    await svc.status();
    expect(fake.callLines()).toEqual(['status --json', 'serve status --json']);
    await svc.status({ refresh: true });
    expect(fake.callLines()).toHaveLength(4);
    base!.clock.advance(4999);
    await svc.status();
    expect(fake.callLines()).toHaveLength(4);
    base!.clock.advance(1);
    await svc.status();
    expect(fake.callLines()).toHaveLength(6);
  });

  it('runs the commands once for callers that ask at the same time', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    const all = await Promise.all([svc.status({ refresh: true }), svc.status({ refresh: true }), svc.status()]);
    expect(fake.callLines()).toEqual(['status --json', 'serve status --json']);
    expect(all[1]).toEqual(all[0]);
    all[0].tailscaleIps.push('tampered');
    expect(all[1].tailscaleIps).not.toContain('tampered');
    expect(svc.cachedStatus()?.tailscaleIps).not.toContain('tampered');
  });

  it('emits tailscale.changed only when something other than the check time changed', async () => {
    const fake = fakeTs();
    const { svc } = setup(fake);
    expect(events()).toHaveLength(0);
    const first = await svc.status({ refresh: true });
    expect(events()).toEqual([first]); // the first answer is news
    base!.clock.advance(60_000);
    await svc.status({ refresh: true });
    await svc.status({ refresh: true });
    expect(events()).toHaveLength(1);

    fake.setStatus({ state: 'Stopped' });
    const stopped = await svc.status({ refresh: true });
    expect(events()).toHaveLength(2);
    expect(events()[1]).toEqual(stopped);
    await svc.status({ refresh: true });
    expect(events()).toHaveLength(2);

    fake.setStatus({});
    fake.setServe(serveConfigFor({ target: `http://127.0.0.1:${PORT}` }));
    await svc.status({ refresh: true });
    expect(events()).toHaveLength(3);
    expect(events()[2].serve.configured).toBe(true);
    // a different problem text is a change as well
    fake.setServe(serveConfigFor({ target: `http://127.0.0.1:${PORT}`, funnel: true }));
    await svc.status({ refresh: true });
    expect(events()).toHaveLength(4);
  });

  it('keeps cachedStatus() null until the first check', async () => {
    const { svc } = setup(fakeTs());
    expect(svc.cachedStatus()).toBeNull();
    const s = await svc.status();
    expect(svc.cachedStatus()).toEqual(s);
  });
});

describe.skipIf(process.platform === 'win32')('polling', () => {
  it('does not run anything while remote access is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fake = fakeTs();
    const { svc } = setup(fake, {}, 'off');
    svc.init();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls()).toEqual([]);
  });

  it('checks right away and then every 30 seconds while remote access is "tailscale", announcing only changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fake = fakeTs();
    const { svc } = setup(fake, {}, 'tailscale');
    svc.init();
    expect(vi.getTimerCount()).toBe(1);
    await eventually(() => fake.calls().length >= 2);
    await eventually(() => events().length === 1);

    vi.advanceTimersByTime(29_999);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.calls()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await eventually(() => fake.calls().length >= 4);
    await new Promise((r) => setTimeout(r, 50));
    expect(events()).toHaveLength(1); // nothing changed: nothing announced

    fake.setStatus({ state: 'Stopped' });
    vi.advanceTimersByTime(30_000);
    await eventually(() => events().length === 2);
    expect(events()[1]).toMatchObject({ running: false, backendState: 'Stopped' });
  });

  it('starts and stops with the setting', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fake = fakeTs();
    const { svc, settings } = setup(fake, {}, 'off');
    svc.init();
    expect(vi.getTimerCount()).toBe(0);
    settings.update({ mobile: { remoteAccess: 'tailscale' } });
    expect(vi.getTimerCount()).toBe(1);
    await eventually(() => fake.calls().length >= 2);
    settings.update({ layout: { sidebarWidth: 300 } }); // unrelated change must not start a second timer
    expect(vi.getTimerCount()).toBe(1);
    settings.update({ mobile: { remoteAccess: 'off' } });
    expect(vi.getTimerCount()).toBe(0);
    const calls = fake.calls().length;
    vi.advanceTimersByTime(5 * 60_000);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.calls()).toHaveLength(calls);
  });

  it('leaves no timer behind after shutdown, and ignores a second init', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fake = fakeTs();
    const { svc, settings } = setup(fake, {}, 'tailscale');
    svc.init();
    svc.init();
    expect(vi.getTimerCount()).toBe(1);
    await eventually(() => fake.calls().length >= 2);
    svc.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    const calls = fake.calls().length;
    vi.advanceTimersByTime(10 * 60_000);
    settings.update({ mobile: { remoteAccess: 'off' } });
    settings.update({ mobile: { remoteAccess: 'tailscale' } }); // the setting listener is gone too
    expect(vi.getTimerCount()).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls()).toHaveLength(calls);
    svc.init(); // a stopped service stays stopped
    expect(vi.getTimerCount()).toBe(0);
  });

  it('really stops with real timers: no more commands, no timer left', async () => {
    const countTimers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = countTimers();
    const fake = fakeTs();
    const { svc } = setup(fake, { pollIntervalMs: 40 }, 'tailscale');
    svc.init();
    await eventually(() => fake.calls().length >= 6); // at least three polls
    svc.shutdown();
    await new Promise((r) => setTimeout(r, 300)); // lets a poll that was running finish
    const calls = fake.calls().length;
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.calls()).toHaveLength(calls);
    expect(countTimers()).toBeLessThanOrEqual(before);
  });

  it('kills a command that is still running at shutdown and announces nothing afterwards', async () => {
    const fake = fakeTs({ hang: true });
    const { svc } = setup(fake, { commandTimeoutMs: 30_000 }, 'tailscale');
    svc.init();
    await eventually(() => fake.calls().length >= 1);
    const eventCount = base!.events.length;
    const started = Date.now();
    svc.shutdown();
    // the pending status() settles now instead of after 30 seconds
    const settled = await svc.status();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(settled.installed).toBe(true);
    expect(base!.events).toHaveLength(eventCount);
  });

  it('keeps polling after a check that failed', async () => {
    const fake = fakeTs();
    fake.setStatusAnswer({ exit: 1, stderr: 'failed to connect to local Tailscale service\n' });
    const { svc } = setup(fake, { pollIntervalMs: 40 }, 'tailscale');
    svc.init();
    await eventually(() => events().length === 1);
    expect(events()[0].problem).toMatch(/not running/);
    fake.setStatusAnswer({ stdout: statusJson() });
    await eventually(() => events().length === 2);
    expect(events()[1]).toMatchObject({ running: true, problem: null });
  });
});
