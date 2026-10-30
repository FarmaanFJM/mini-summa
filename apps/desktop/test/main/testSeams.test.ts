// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyHostRules, hostMatches, INERT_SEAMS, installCertificateTrust, isTrustedTestHost, parseHostRules, readTestSeams,
  resolveDataDir, resolveUserDataDir, SEAM_ENV,
} from '../../src/main/testSeams.ts';

const ALL_SET = {
  [SEAM_ENV.hostRules]: 'MAP chatgpt.com 127.0.0.1:8443, MAP auth.openai.com 127.0.0.1:8443',
  [SEAM_ENV.trustCerts]: '1',
  [SEAM_ENV.dataDir]: '/tmp/ms-data',
  [SEAM_ENV.userDataDir]: '/tmp/ms-profile',
  [SEAM_ENV.claudeBin]: '/tmp/fake-claude',
  [SEAM_ENV.coreModule]: '/tmp/stub-core.mjs',
};

describe('a packaged app ignores the whole test environment', () => {
  it('reads nothing when packaged, whatever is set', () => {
    expect(readTestSeams(ALL_SET, true)).toBe(INERT_SEAMS);
    expect(INERT_SEAMS).toEqual({ hostRules: null, trustCerts: false, dataDir: null, userDataDir: null, claudeBin: null, coreModule: null, ignored: [] });
  });

  it('adds no command-line switch when packaged', () => {
    const commandLine = { appendSwitch: vi.fn() };
    expect(applyHostRules(commandLine, readTestSeams(ALL_SET, true))).toBe(false);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('installs no certificate handler when packaged', () => {
    const app = { on: vi.fn() };
    const ses = { setCertificateVerifyProc: vi.fn() };
    expect(installCertificateTrust({ app, sessions: [ses], seams: readTestSeams(ALL_SET, true) })).toBe(false);
    expect(app.on).not.toHaveBeenCalled();
    expect(ses.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  it('trusts no host when packaged', () => {
    expect(isTrustedTestHost(readTestSeams(ALL_SET, true), 'chatgpt.com')).toBe(false);
  });

  it('keeps the profile and data directories at their defaults when packaged', () => {
    const seams = readTestSeams(ALL_SET, true);
    expect(resolveUserDataDir(seams, '/home/me/.config/Mini-Summa')).toBe('/home/me/.config/Mini-Summa');
    expect(resolveDataDir(seams, '/home/me/.config/Mini-Summa')).toBe(path.join('/home/me/.config/Mini-Summa', 'data'));
  });

  it('is the only source file that mentions the test variables', () => {
    const dir = path.resolve(import.meta.dirname, '../../src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'renderer') walk(p); } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(p);
      }
    };
    walk(dir);
    const names = Object.values(SEAM_ENV);
    const offenders = files.filter((f) => path.basename(f) !== 'testSeams.ts' && names.some((n) => fs.readFileSync(f, 'utf8').includes(n)));
    expect(offenders).toEqual([]);
    expect(files.some((f) => path.basename(f) === 'testSeams.ts')).toBe(true);
    // And nothing reads process.env directly in the main process except through the seam reader.
    const direct = files.filter((f) => /process\.env/.test(fs.readFileSync(f, 'utf8')));
    expect(direct.map((f) => path.basename(f)).sort()).toEqual(['index.ts']);
  });
});

describe('readTestSeams (development)', () => {
  it('reads every variable', () => {
    expect(readTestSeams(ALL_SET, false)).toEqual({
      hostRules: 'MAP chatgpt.com 127.0.0.1:8443, MAP auth.openai.com 127.0.0.1:8443',
      trustCerts: true,
      dataDir: '/tmp/ms-data',
      userDataDir: '/tmp/ms-profile',
      claudeBin: '/tmp/fake-claude',
      coreModule: '/tmp/stub-core.mjs',
      ignored: [],
    });
  });

  it('is empty by default', () => {
    expect(readTestSeams({}, false)).toEqual({ hostRules: null, trustCerts: false, dataDir: null, userDataDir: null, claudeBin: null, coreModule: null, ignored: [] });
  });

  it('only treats "1" as yes for certificate trust', () => {
    for (const v of ['true', 'yes', '0', '', ' 1 ']) expect(readTestSeams({ [SEAM_ENV.trustCerts]: v }, false).trustCerts).toBe(false);
    expect(readTestSeams({ [SEAM_ENV.trustCerts]: '1' }, false).trustCerts).toBe(true);
  });

  it('ignores relative paths and says so', () => {
    const s = readTestSeams({ [SEAM_ENV.dataDir]: 'relative/dir', [SEAM_ENV.claudeBin]: './claude' }, false);
    expect(s.dataDir).toBeNull();
    expect(s.claudeBin).toBeNull();
    expect(s.ignored).toHaveLength(2);
  });

  it('ignores host rules with odd characters', () => {
    const s = readTestSeams({ [SEAM_ENV.hostRules]: 'MAP a.com 127.0.0.1 --evil="x"' }, false);
    expect(s.hostRules).toBeNull();
    expect(s.ignored[0]).toMatch(/not valid in a host rule/);
  });

  it('puts the profile beside an overridden data directory unless told otherwise', () => {
    expect(resolveUserDataDir(readTestSeams({ [SEAM_ENV.dataDir]: '/tmp/run1' }, false), '/default')).toBe(path.join('/tmp/run1', 'electron-profile'));
    expect(resolveUserDataDir(readTestSeams({ [SEAM_ENV.dataDir]: '/tmp/run1', [SEAM_ENV.userDataDir]: '/tmp/p' }, false), '/default')).toBe('/tmp/p');
    expect(resolveUserDataDir(readTestSeams({}, false), '/default')).toBe('/default');
    expect(resolveDataDir(readTestSeams({ [SEAM_ENV.dataDir]: '/tmp/run1' }, false), '/profile')).toBe('/tmp/run1');
    expect(resolveDataDir(readTestSeams({}, false), '/profile')).toBe(path.join('/profile', 'data'));
  });
});

describe('host rules', () => {
  it('passes the rules to Chromium verbatim', () => {
    const commandLine = { appendSwitch: vi.fn() };
    const seams = readTestSeams(ALL_SET, false);
    expect(applyHostRules(commandLine, seams)).toBe(true);
    expect(commandLine.appendSwitch).toHaveBeenCalledWith('host-resolver-rules', ALL_SET[SEAM_ENV.hostRules]);
  });

  it('also turns proxies off, because a proxy would resolve the mapped names itself and reach the real site', () => {
    const commandLine = { appendSwitch: vi.fn() };
    applyHostRules(commandLine, readTestSeams(ALL_SET, false));
    expect(commandLine.appendSwitch).toHaveBeenCalledWith('no-proxy-server');
    expect(commandLine.appendSwitch).toHaveBeenCalledTimes(2);
  });

  it('adds nothing without rules', () => {
    const commandLine = { appendSwitch: vi.fn() };
    expect(applyHostRules(commandLine, readTestSeams({ [SEAM_ENV.trustCerts]: '1' }, false))).toBe(false);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('parses MAP rules and marks which ones go to this machine', () => {
    expect(parseHostRules('MAP chatgpt.com 127.0.0.1:8443, MAP *.openai.com localhost:9, MAP evil.example 203.0.113.9, EXCLUDE 127.0.0.1, MAP [::1]x [::1]:1')).toEqual([
      { pattern: 'chatgpt.com', target: '127.0.0.1:8443', loopback: true },
      { pattern: '*.openai.com', target: 'localhost:9', loopback: true },
      { pattern: 'evil.example', target: '203.0.113.9', loopback: false },
      { pattern: '[::1]x', target: '[::1]:1', loopback: true },
    ]);
    expect(parseHostRules(null)).toEqual([]);
    expect(parseHostRules('MAP * ~NOTFOUND')).toEqual([{ pattern: '*', target: '~NOTFOUND', loopback: false }]);
  });

  it('matches host patterns like Chromium does (star and question mark, case-insensitive)', () => {
    expect(hostMatches('chatgpt.com', 'ChatGPT.com')).toBe(true);
    expect(hostMatches('chatgpt.com', 'www.chatgpt.com')).toBe(false);
    expect(hostMatches('*.openai.com', 'auth.openai.com')).toBe(true);
    expect(hostMatches('*.openai.com', 'openai.com')).toBe(false);
    expect(hostMatches('auth?.openai.com', 'auth0.openai.com')).toBe(true);
    expect(hostMatches('a.b', 'axb')).toBe(false);
    expect(hostMatches('*', 'anything.example')).toBe(true);
  });
});

describe('certificate trust (development only)', () => {
  const seams = readTestSeams({ [SEAM_ENV.hostRules]: 'MAP chatgpt.com 127.0.0.1:8443, MAP auth.openai.com 127.0.0.1:8443, MAP elsewhere.example 203.0.113.9', [SEAM_ENV.trustCerts]: '1' }, false);

  it('trusts hosts that are mapped to this machine, and only those', () => {
    expect(isTrustedTestHost(seams, 'chatgpt.com')).toBe(true);
    expect(isTrustedTestHost(seams, 'auth.openai.com')).toBe(true);
    expect(isTrustedTestHost(seams, 'cdn.oaistatic.com')).toBe(false);
    expect(isTrustedTestHost(seams, 'elsewhere.example')).toBe(false);
    expect(isTrustedTestHost(seams, '')).toBe(false);
  });

  it('trusts nothing without the explicit switch', () => {
    const off = readTestSeams({ [SEAM_ENV.hostRules]: 'MAP chatgpt.com 127.0.0.1:8443' }, false);
    expect(isTrustedTestHost(off, 'chatgpt.com')).toBe(false);
    const app = { on: vi.fn() };
    const ses = { setCertificateVerifyProc: vi.fn() };
    expect(installCertificateTrust({ app, sessions: [ses], seams: off })).toBe(false);
    expect(app.on).not.toHaveBeenCalled();
  });

  it('trusts nothing when no rule sends a host to this machine', () => {
    const none = readTestSeams({ [SEAM_ENV.hostRules]: 'MAP chatgpt.com 203.0.113.9', [SEAM_ENV.trustCerts]: '1' }, false);
    const app = { on: vi.fn() };
    expect(installCertificateTrust({ app, sessions: [], seams: none })).toBe(false);
    expect(app.on).not.toHaveBeenCalled();
  });

  it('accepts a certificate error for a mapped host on the app, and ignores every other host', () => {
    const app = { on: vi.fn() };
    const ses = { setCertificateVerifyProc: vi.fn() };
    expect(installCertificateTrust({ app, sessions: [ses], seams })).toBe(true);
    const [event, handler] = app.on.mock.calls[0];
    expect(event).toBe('certificate-error');

    const mapped = { preventDefault: vi.fn() };
    const accept = vi.fn();
    handler(mapped, {}, 'https://chatgpt.com/c/abc', 'net::ERR_CERT_AUTHORITY_INVALID', {}, accept, true);
    expect(mapped.preventDefault).toHaveBeenCalled();
    expect(accept).toHaveBeenCalledWith(true);

    for (const url of ['https://example.org/', 'https://cdn.oaistatic.com/x', 'not a url']) {
      const other = { preventDefault: vi.fn() };
      const cb = vi.fn();
      handler(other, {}, url, 'net::ERR_CERT_AUTHORITY_INVALID', {}, cb, true);
      expect(other.preventDefault).not.toHaveBeenCalled();
      expect(cb).not.toHaveBeenCalled();
    }
  });

  it('accepts mapped hosts in the session and leaves the rest to Chromium (-3)', () => {
    const app = { on: vi.fn() };
    const ses = { setCertificateVerifyProc: vi.fn() };
    installCertificateTrust({ app, sessions: [ses], seams });
    const proc = ses.setCertificateVerifyProc.mock.calls[0][0] as (r: { hostname: string }, cb: (n: number) => void) => void;
    const verdict = (hostname: string) => { const cb = vi.fn(); proc({ hostname }, cb); return cb.mock.calls[0][0]; };
    expect(verdict('chatgpt.com')).toBe(0);
    expect(verdict('auth.openai.com')).toBe(0);
    expect(verdict('example.org')).toBe(-3);
    expect(verdict('elsewhere.example')).toBe(-3);
  });
});
