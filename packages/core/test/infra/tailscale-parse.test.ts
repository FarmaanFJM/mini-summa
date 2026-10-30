import { describe, expect, it } from 'vitest';
import {
  describeServeFailure, emptyStatus, findOwnedEntry, isOurProxy, looksNotRunning, matchServe, parseBackend, parseProxy, parseServe, problemForBackend, problems,
  statusKey,
} from '../../src/infra/tailscale-parse.ts';
import { expectPlainText } from './part1-fixtures.ts';
import { serveConfigFor } from './tailscale-fake.ts';

describe('parseBackend', () => {
  it('reads the fields Mini-Summa needs from `tailscale status --json`', () => {
    const b = parseBackend({
      BackendState: 'Running', TailscaleIPs: ['100.64.0.1', 'fd7a::1'], CertDomains: ['pc.ts.net'],
      Self: { HostName: 'PC', DNSName: 'pc.ts.net.', TailscaleIPs: ['100.64.0.9'] }, CurrentTailnet: { Name: 'me@example.com' },
    });
    expect(b).toEqual({ backendState: 'Running', hostName: 'PC', dnsName: 'pc.ts.net', tailnet: 'me@example.com', tailscaleIps: ['100.64.0.1', 'fd7a::1'], httpsCertificates: 'enabled' });
  });

  it('is not fooled by documents that are not a status', () => {
    for (const bad of [null, undefined, 'x', 7, [], {}, { BackendState: 3 }, { Self: {} }]) expect(parseBackend(bad)).toBeNull();
  });

  it('tells "HTTPS not enabled" from "this Tailscale does not say"', () => {
    const base = { BackendState: 'Running' };
    expect(parseBackend({ ...base })?.httpsCertificates).toBe('unknown');
    expect(parseBackend({ ...base, CertDomains: null })?.httpsCertificates).toBe('not_enabled');
    expect(parseBackend({ ...base, CertDomains: [] })?.httpsCertificates).toBe('not_enabled');
    expect(parseBackend({ ...base, CertDomains: ['a.ts.net'] })?.httpsCertificates).toBe('enabled');
  });

  it('copes with a signed-out machine (no Self, no IPs)', () => {
    expect(parseBackend({ BackendState: 'NeedsLogin', Self: null, TailscaleIPs: null })).toEqual({
      backendState: 'NeedsLogin', hostName: null, dnsName: null, tailnet: null, tailscaleIps: [], httpsCertificates: 'unknown',
    });
    expect(parseBackend({ BackendState: 'Running', Self: { DNSName: '' } })?.dnsName).toBeNull();
  });
});

describe('parseProxy and isOurProxy', () => {
  it('splits host and port from the shapes Tailscale prints', () => {
    expect(parseProxy('http://127.0.0.1:4317')).toEqual({ host: '127.0.0.1', port: 4317 });
    expect(parseProxy('https://LOCALHOST:8080/path?x=1')).toEqual({ host: 'localhost', port: 8080 });
    expect(parseProxy('127.0.0.1:4317')).toEqual({ host: '127.0.0.1', port: 4317 });
    expect(parseProxy('http://[::1]:4317')).toEqual({ host: '::1', port: 4317 });
    expect(parseProxy('http://example.com')).toEqual({ host: 'example.com', port: null });
    expect(parseProxy('')).toBeNull();
  });

  it('counts only a loopback address with exactly this port as Mini-Summa', () => {
    expect(isOurProxy('http://127.0.0.1:4317', 4317)).toBe(true);
    expect(isOurProxy('http://localhost:4317', 4317)).toBe(true);
    expect(isOurProxy('http://127.0.0.1:4318', 4317)).toBe(false);
    expect(isOurProxy('http://192.168.1.5:4317', 4317)).toBe(false);
    expect(isOurProxy('http://evil.example:4317', 4317)).toBe(false);
    expect(isOurProxy('http://127.0.0.1', 4317)).toBe(false);
    expect(isOurProxy(null, 4317)).toBe(false);
  });
});

describe('parseServe and matchServe', () => {
  it('flattens web handlers and finds the hosts with Funnel on', () => {
    const info = parseServe({
      TCP: { '443': { HTTPS: true } },
      Web: { 'pc.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4317' }, '/files': { Path: 'C:\\x' } } } },
      AllowFunnel: { 'pc.ts.net:443': true, 'pc.ts.net:8443': false },
    });
    expect(info.entries).toEqual([
      { hostPort: 'pc.ts.net:443', host: 'pc.ts.net', port: 443, path: '/', proxy: 'http://127.0.0.1:4317' },
      { hostPort: 'pc.ts.net:443', host: 'pc.ts.net', port: 443, path: '/files', proxy: null },
    ]);
    expect(info.funnel).toEqual(['pc.ts.net:443']);
  });

  it('ignores junk', () => {
    for (const junk of [null, 'x', 5, [], { Web: 5 }, { Web: { bad: {} } }, { Web: { 'h:443': { Handlers: 3 } } }, { AllowFunnel: 'yes' }]) {
      expect(parseServe(junk)).toEqual({ entries: [], funnel: [] });
    }
  });

  it('matches this host only, and gives the URL without the default port', () => {
    const info = parseServe(serveConfigFor({ dns: 'pc.ts.net', target: 'http://127.0.0.1:4317' }));
    expect(matchServe(info, 4317, 'pc.ts.net')).toMatchObject({ configured: true, url: 'https://pc.ts.net', target: 'http://127.0.0.1:4317', foreignTarget: null });
    expect(matchServe(info, 4317, 'PC.ts.net').configured).toBe(true); // DNS names do not care about case
    expect(matchServe(info, 4317, 'other.ts.net')).toMatchObject({ configured: false, url: null, foreignTarget: null });
    const odd = parseServe(serveConfigFor({ dns: 'pc.ts.net', port: 8443, target: 'http://127.0.0.1:4317' }));
    expect(matchServe(odd, 4317, 'pc.ts.net').url).toBe('https://pc.ts.net:8443');
  });

  it('names what occupies the HTTPS port when it is not Mini-Summa', () => {
    const info = parseServe(serveConfigFor({ dns: 'pc.ts.net', target: 'http://127.0.0.1:9999' }));
    expect(matchServe(info, 4317, 'pc.ts.net')).toMatchObject({ configured: false, target: null, foreignTarget: 'http://127.0.0.1:9999' });
    const files = parseServe({ Web: { 'pc.ts.net:443': { Handlers: { '/': { Path: 'C:\\site' } } } } });
    expect(matchServe(files, 4317, 'pc.ts.net').foreignTarget).toBe('(files or text)');
    const elsewhere = parseServe(serveConfigFor({ dns: 'pc.ts.net', port: 8443, target: 'http://127.0.0.1:9999' }));
    expect(matchServe(elsewhere, 4317, 'pc.ts.net').foreignTarget).toBeNull();
  });
});

describe('findOwnedEntry', () => {
  const entry = (hostPort: string, path: string, proxy: string | null) => ({ hostPort, host: hostPort.split(':')[0], port: Number(hostPort.split(':')[1]), path, proxy });
  const info = (...entries: ReturnType<typeof entry>[]) => ({ entries, funnel: [] });

  it('finds the root entry on the HTTPS port that forwards to the recorded loopback port', () => {
    const e = entry('pc.ts.net:443', '/', 'http://127.0.0.1:47811');
    expect(findOwnedEntry(info(e), 47811, 'pc.ts.net')).toBe(e);
    expect(findOwnedEntry(info(e), 47811, null)).toBe(e); // Serve is per machine: any host key is this machine's
    expect(findOwnedEntry(info(entry('pc.ts.net:443', '/', 'http://localhost:47811/')), 47811, 'PC.ts.net')).not.toBeNull();
  });

  it('finds nothing for a different port, another path, another HTTPS port, another host or a target that is not loopback', () => {
    const wanted = 47811;
    for (const e of [
      entry('pc.ts.net:443', '/', 'http://127.0.0.1:9999'),
      entry('pc.ts.net:443', '/files', 'http://127.0.0.1:47811'),
      entry('pc.ts.net:8443', '/', 'http://127.0.0.1:47811'),
      entry('other.ts.net:443', '/', 'http://127.0.0.1:47811'),
      entry('pc.ts.net:443', '/', 'http://192.168.1.9:47811'),
      entry('pc.ts.net:443', '/', null),
    ]) expect(findOwnedEntry(info(e), wanted, 'pc.ts.net'), JSON.stringify(e)).toBeNull();
    expect(findOwnedEntry(info(), wanted, null)).toBeNull();
  });

  it('is what matchServe calls the occupant when the entry is not on the current port', () => {
    const parsed = parseServe(serveConfigFor({ dns: 'pc.ts.net', target: 'http://127.0.0.1:47811' }));
    const m = matchServe(parsed, 4317, 'pc.ts.net');
    expect(m.configured).toBe(false);
    expect(m.occupant).toMatchObject({ port: 443, path: '/', proxy: 'http://127.0.0.1:47811' });
    expect(findOwnedEntry(parsed, 47811, 'pc.ts.net')).toBe(m.occupant);
    expect(matchServe(parsed, 47811, 'pc.ts.net').occupant).toBeNull();
  });
});

describe('problem texts', () => {
  it('are plain sentences: no dashes as punctuation, and each says what to do', () => {
    const all = [
      problems.notInstalled(), problems.notRunning(), problems.timedOut('tailscale status'), problems.unreadable(), problems.stopped(),
      problems.needsLogin(), problems.needsMachineAuth(), problems.starting(), problems.unknownState('Odd'), problems.noDnsName(),
      problems.httpsNotEnabled(), problems.funnel(['pc.ts.net:443']), problems.foreignServe('http://127.0.0.1:9999'),
      problems.serveUnreadable('boom'), problems.serveNotShown(), problems.staleServe(47811, 51234), problems.portNotReady(),
      describeServeFailure('anything', 'enable'), describeServeFailure('anything', 'disable'),
      describeServeFailure('Access denied', 'enable'), describeServeFailure('Serve is not enabled on your tailnet', 'enable'),
    ];
    for (const text of all) {
      expectPlainText(text);
      expect(text.length).toBeGreaterThan(40);
      expect(text).toMatch(/\.$/);
      expect(text).toMatch(/\b(then|Install|Start|Open|Turn|Wait|Update|Run|Ask|Download|Import|Mini-Summa will not|Check)\b|try again|refresh/i);
    }
  });

  it('maps every backend state, and says nothing for Running', () => {
    expect(problemForBackend('Running')).toBeNull();
    for (const state of ['Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState', 'Mystery']) expect(problemForBackend(state)).toEqual(expect.any(String));
  });

  it('recognises a daemon that is not there', () => {
    for (const said of [
      'failed to connect to local Tailscale service; is Tailscale running?',
      "The Tailscale service doesn't appear to be running",
      'dial unix /var/run/tailscale/tailscaled.sock: connect: connection refused',
    ]) expect(looksNotRunning(said), said).toBe(true);
    expect(looksNotRunning('some unrelated failure')).toBe(false);
  });

  it('quotes the first lines of an unknown failure, briefly', () => {
    const text = describeServeFailure(`oops\n${'long line '.repeat(80)}`, 'enable');
    expect(text.length).toBeLessThan(450);
    expect(text).toContain('It said: oops long line');
    expect(text).toContain('...');
    expect(describeServeFailure('', 'disable')).toMatch(/^Tailscale could not stop publishing Mini-Summa\. Run/);
  });
});

describe('statusKey', () => {
  it('ignores when the status was checked and nothing else', () => {
    const a = emptyStatus('2026-01-01T00:00:00.000Z');
    expect(statusKey(a)).toBe(statusKey({ ...a, checkedAt: '2027-05-05T05:05:05.000Z' }));
    expect(statusKey(a)).not.toBe(statusKey({ ...a, running: true }));
    expect(statusKey(a)).not.toBe(statusKey({ ...a, problem: 'x' }));
    expect(statusKey(a)).not.toBe(statusKey({ ...a, serve: { ...a.serve, funnelDetected: true } }));
  });
});
