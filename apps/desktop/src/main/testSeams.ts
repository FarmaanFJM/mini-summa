// Test-only seams.
//
// This is the ONLY file that reads the MINISUMMA_* test variables, and every reader returns the inert value when the
// app is packaged. A unit test (test/main/testSeams.test.ts) pins both facts: a packaged build ignores the whole
// environment, and no other source file mentions these names.
//
//   MINISUMMA_TEST_HOST_RULES   Chromium host-resolver-rules, e.g. "MAP chatgpt.com 127.0.0.1:8443". Lets the real
//                               navigation policy and the real embedded view talk to a local stand-in for chatgpt.com.
//   MINISUMMA_TEST_TRUST_CERTS  "1": accept TLS certificates for hosts that the rules above map to loopback, nothing else.
//   MINISUMMA_DATA_DIR          data directory override (default <userData>/data).
//   MINISUMMA_USER_DATA_DIR     Electron profile override. Without it, a data-dir override puts the profile beside it
//                               (<dataDir>/electron-profile) so that one variable isolates a whole test run.
//   MINISUMMA_CLAUDE_BIN        forwarded to the core as overrides.claudeBin (the fake Claude CLI).
//   MINISUMMA_CORE_MODULE       module that exports createCore, used instead of @minisumma/core (stub core for smoke tests).
import path from 'node:path';

export interface TestSeams {
  hostRules: string | null;
  trustCerts: boolean;
  dataDir: string | null;
  userDataDir: string | null;
  claudeBin: string | null;
  coreModule: string | null;
  /** Variables that were set but not usable, so the caller can log why a seam did nothing. */
  ignored: string[];
}

export const SEAM_ENV = {
  hostRules: 'MINISUMMA_TEST_HOST_RULES',
  trustCerts: 'MINISUMMA_TEST_TRUST_CERTS',
  dataDir: 'MINISUMMA_DATA_DIR',
  userDataDir: 'MINISUMMA_USER_DATA_DIR',
  claudeBin: 'MINISUMMA_CLAUDE_BIN',
  coreModule: 'MINISUMMA_CORE_MODULE',
} as const;

export const INERT_SEAMS: TestSeams = Object.freeze({
  hostRules: null, trustCerts: false, dataDir: null, userDataDir: null, claudeBin: null, coreModule: null, ignored: [],
}) as TestSeams;

// Chromium rule syntax uses words, dots, commas, colons, stars, brackets (IPv6) and "~NOTFOUND". Nothing else is needed.
const HOST_RULES_RE = /^[\w .,;*:~\-[\]?]+$/;

export function readTestSeams(env: Record<string, string | undefined>, isPackaged: boolean): TestSeams {
  if (isPackaged) return INERT_SEAMS;
  const ignored: string[] = [];
  const text = (name: string): string | null => {
    const v = env[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };
  const absolute = (name: string): string | null => {
    const v = text(name);
    if (v === null) return null;
    if (!path.isAbsolute(v)) { ignored.push(`${name} must be an absolute path`); return null; }
    return v;
  };
  let hostRules = text(SEAM_ENV.hostRules);
  if (hostRules !== null && !HOST_RULES_RE.test(hostRules)) {
    ignored.push(`${SEAM_ENV.hostRules} contains characters that are not valid in a host rule`);
    hostRules = null;
  }
  return {
    hostRules,
    trustCerts: env[SEAM_ENV.trustCerts] === '1',
    dataDir: absolute(SEAM_ENV.dataDir),
    userDataDir: absolute(SEAM_ENV.userDataDir),
    claudeBin: absolute(SEAM_ENV.claudeBin),
    coreModule: absolute(SEAM_ENV.coreModule),
    ignored,
  };
}

export const resolveUserDataDir = (seams: TestSeams, defaultDir: string): string =>
  seams.userDataDir ?? (seams.dataDir ? path.join(seams.dataDir, 'electron-profile') : defaultDir);

export const resolveDataDir = (seams: TestSeams, userDataDir: string): string =>
  seams.dataDir ?? path.join(userDataDir, 'data');

// ---------------------------------------------------------------------------------------------------------------
// Host rules

export interface HostRule { pattern: string; target: string; loopback: boolean }

const isLoopbackHost = (target: string): boolean => {
  // "[::1]:8443" has brackets around the address; "127.0.0.1:8443" and "localhost:8443" have a single colon before the port.
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(target);
  const host = (bracketed ? bracketed[1] : target.replace(/^([^:]*):\d+$/, '$1')).toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
};

/** MAP rules only. EXCLUDE rules never widen trust, so they are not needed here. */
export function parseHostRules(rules: string | null): HostRule[] {
  if (!rules) return [];
  const out: HostRule[] = [];
  for (const piece of rules.split(/[,;]/)) {
    const words = piece.trim().split(/\s+/);
    if (words.length === 3 && words[0].toUpperCase() === 'MAP') {
      out.push({ pattern: words[1].toLowerCase(), target: words[2], loopback: isLoopbackHost(words[2]) });
    }
  }
  return out;
}

export function hostMatches(pattern: string, hostname: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(hostname);
}

/** Certificates are trusted for a host only when a rule sends that host to this machine, so the real site stays out of reach. */
export function isTrustedTestHost(seams: TestSeams, hostname: string): boolean {
  if (!seams.trustCerts || !hostname) return false;
  return parseHostRules(seams.hostRules).some((r) => r.loopback && hostMatches(r.pattern, hostname));
}

export interface CommandLineLike { appendSwitch(name: string, value?: string): void }

/**
 * Must run before the app is ready. Returns whether the switches were added.
 *
 * `no-proxy-server` goes with the rules on purpose: when a proxy is configured (an environment proxy is picked up on
 * Linux), Chromium sends the host NAME to the proxy and the proxy resolves it, so the rules would not apply and a mapped
 * name such as chatgpt.com would reach the real site. With the switch the rules decide, and nothing can bypass them.
 */
export function applyHostRules(commandLine: CommandLineLike, seams: TestSeams): boolean {
  if (!seams.hostRules) return false;
  commandLine.appendSwitch('host-resolver-rules', seams.hostRules);
  commandLine.appendSwitch('no-proxy-server');
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Certificates

export interface CertificateTrustDeps {
  app: { on(event: 'certificate-error', listener: (...args: any[]) => void): unknown };
  sessions: { setCertificateVerifyProc(proc: ((request: { hostname: string }, callback: (result: number) => void) => void) | null): void }[];
  seams: TestSeams;
}

/** -3 tells Chromium to use its own verification result, so every other host is judged normally. */
const USE_CHROMIUM_RESULT = -3;

export function installCertificateTrust({ app, sessions, seams }: CertificateTrustDeps): boolean {
  if (!seams.trustCerts || parseHostRules(seams.hostRules).every((r) => !r.loopback)) return false;
  app.on('certificate-error', (event: { preventDefault(): void }, _contents: unknown, url: string, _error: string, _cert: unknown, callback: (trusted: boolean) => void) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* not a URL: not trusted */ }
    if (isTrustedTestHost(seams, host)) { event.preventDefault(); callback(true); }
  });
  for (const s of sessions) {
    s.setCertificateVerifyProc((request, callback) => callback(isTrustedTestHost(seams, request.hostname) ? 0 : USE_CHROMIUM_RESULT));
  }
  return true;
}
