// Reading the Tailscale CLI's JSON, and the plain-language problem texts built from it. No process spawning here, so
// every rule can be tested with a literal object.
//
// The CLI is the only interface (no local API socket, no control-plane calls). Two documents matter:
//   `tailscale status --json`        BackendState, Self.DNSName/HostName, CurrentTailnet.Name, TailscaleIPs, CertDomains
//   `tailscale serve status --json`  Web (host:port -> handlers -> Proxy), TCP, AllowFunnel (host:port -> true)
// Fields that a Tailscale version does not send are treated as unknown, never as a reason to alarm the user.
import type { TailscaleStatus } from '@minisumma/shared';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

export function tryParseJson(text: string): unknown {
  const t = text.trim();
  if (t === '') return null;
  try { return JSON.parse(t); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------
// status --json

export interface BackendInfo {
  backendState: string;
  hostName: string | null;
  /** Trailing dot removed. */
  dnsName: string | null;
  tailnet: string | null;
  tailscaleIps: string[];
  /** 'unknown' when this Tailscale version does not report CertDomains at all. */
  httpsCertificates: 'enabled' | 'not_enabled' | 'unknown';
}

export function parseBackend(json: unknown): BackendInfo | null {
  if (!isObject(json) || typeof json.BackendState !== 'string') return null;
  const self = isObject(json.Self) ? json.Self : null;
  const ips = (Array.isArray(json.TailscaleIPs) ? json.TailscaleIPs : Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [])
    .filter((x): x is string => typeof x === 'string');
  const dns = str(self?.DNSName);
  const tailnet = isObject(json.CurrentTailnet) ? str(json.CurrentTailnet.Name) : null;
  let certs: BackendInfo['httpsCertificates'] = 'unknown';
  if ('CertDomains' in json) certs = Array.isArray(json.CertDomains) && json.CertDomains.length > 0 ? 'enabled' : 'not_enabled';
  return {
    backendState: json.BackendState,
    hostName: str(self?.HostName),
    dnsName: dns === null ? null : dns.replace(/\.+$/, ''),
    tailnet,
    tailscaleIps: ips,
    httpsCertificates: certs,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// serve status --json

export interface ServeEntry {
  /** `host:port` exactly as Tailscale keys it. */
  hostPort: string;
  host: string;
  port: number;
  path: string;
  /** Raw Proxy value of the handler, or null for file/text handlers. */
  proxy: string | null;
}

export interface ServeInfo {
  entries: ServeEntry[];
  /** Every `host:port` that has Funnel switched on. */
  funnel: string[];
}

function splitHostPort(hp: string): { host: string; port: number } | null {
  const i = hp.lastIndexOf(':');
  if (i <= 0) return null;
  const port = Number(hp.slice(i + 1));
  return Number.isInteger(port) ? { host: hp.slice(0, i).toLowerCase(), port } : null;
}

export function parseServe(json: unknown): ServeInfo {
  const info: ServeInfo = { entries: [], funnel: [] };
  if (!isObject(json)) return info;
  // Foreground sessions (`tailscale serve <target>` without --bg) carry the same structure one level down.
  const configs = [json, ...(isObject(json.Foreground) ? Object.values(json.Foreground).filter(isObject) : [])];
  for (const cfg of configs) {
    if (isObject(cfg.Web)) {
      for (const [hostPort, web] of Object.entries(cfg.Web)) {
        const hp = splitHostPort(hostPort);
        if (!hp || !isObject(web) || !isObject(web.Handlers)) continue;
        for (const [path, handler] of Object.entries(web.Handlers)) {
          info.entries.push({ hostPort, host: hp.host, port: hp.port, path, proxy: isObject(handler) ? str(handler.Proxy) : null });
        }
      }
    }
    if (isObject(cfg.AllowFunnel)) {
      for (const [hostPort, on] of Object.entries(cfg.AllowFunnel)) if (on === true) info.funnel.push(hostPort);
    }
  }
  return info;
}

export interface ProxyTarget { host: string; port: number | null }

/** `http://127.0.0.1:4317`, `127.0.0.1:4317` and `http://localhost:4317/` all give host + port. */
export function parseProxy(proxy: string): ProxyTarget | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?(?:[/?#].*)?$/i.exec(proxy.trim());
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/g, '').toLowerCase(), port: m[2] ? Number(m[2]) : null };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export const isOurProxy = (proxy: string | null, port: number): boolean => {
  if (proxy === null) return false;
  const t = parseProxy(proxy);
  return t !== null && LOOPBACK.has(t.host) && t.port === port;
};

export interface ServeMatch {
  /** Serve publishes the port Mini-Summa listens on right now. */
  configured: boolean;
  url: string | null;
  /** The proxy target that is published for us. null when Serve does not publish Mini-Summa's port. */
  target: string | null;
  /** Something that is not Mini-Summa's current port is published at `/` of the HTTPS port we would use (for display). */
  foreignTarget: string | null;
  /** That same entry, so the caller can decide whether it is an old entry of Mini-Summa's own or somebody else's. */
  occupant: ServeEntry | null;
  funnel: string[];
}

export const HTTPS_PORT = 443;

export function matchServe(info: ServeInfo, port: number, dnsName: string | null): ServeMatch {
  const ofThisHost = info.entries.filter((e) => dnsName === null || e.host === dnsName.toLowerCase());
  const ours = ofThisHost.find((e) => isOurProxy(e.proxy, port));
  const funnel = info.funnel.filter((hp) => dnsName === null || (splitHostPort(hp)?.host ?? '') === dnsName.toLowerCase());
  if (ours) {
    const url = `https://${dnsName ?? ours.host}${ours.port === HTTPS_PORT ? '' : `:${ours.port}`}`;
    return { configured: true, url, target: ours.proxy, foreignTarget: null, occupant: null, funnel };
  }
  const occupant = ofThisHost.find((e) => e.port === HTTPS_PORT && e.path === '/') ?? null;
  const foreignTarget = occupant ? occupant.proxy ?? '(files or text)' : null;
  return { configured: false, url: null, target: null, foreignTarget, occupant, funnel };
}

/**
 * The entry at `/` of the HTTPS port that forwards to loopback:`port`. Used for an entry Mini-Summa recorded as its own:
 * it is only that entry if it still forwards to the recorded port. `dnsName` null = any host (Serve is per machine).
 */
export function findOwnedEntry(info: ServeInfo, port: number, dnsName: string | null): ServeEntry | null {
  const host = dnsName?.toLowerCase() ?? null;
  return info.entries.find((e) => e.port === HTTPS_PORT && e.path === '/' && isOurProxy(e.proxy, port) && (host === null || e.host === host)) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Problem texts. Each says what is wrong and what to do next. No dashes used as punctuation.

export const problems = {
  notInstalled: () =>
    'Tailscale is not installed on this PC. Install it from https://tailscale.com/download, sign in, then turn remote access on again.',
  notRunning: () =>
    'Tailscale is installed but its background service is not running. Start the Tailscale app (on Windows, open it from the Start menu or the system tray), then refresh.',
  timedOut: (what: string) =>
    `Tailscale did not answer in time while Mini-Summa ran "${what}". Check that Tailscale is running and not waiting for you to sign in, then refresh.`,
  unreadable: () =>
    'Tailscale answered with something Mini-Summa could not read. Update Tailscale to the latest version and refresh.',
  stopped: () =>
    'Tailscale is turned off. Open the Tailscale app and choose Connect (or run "tailscale up" in a terminal), then refresh.',
  needsLogin: () =>
    'Tailscale is not signed in. Open the Tailscale app and sign in (or run "tailscale up" in a terminal), then refresh.',
  needsMachineAuth: () =>
    'This PC is waiting for approval in your tailnet. Ask the tailnet admin to approve it at https://login.tailscale.com/admin/machines, then refresh.',
  starting: () =>
    'Tailscale is still starting. Wait a few seconds, then refresh.',
  unknownState: (state: string) =>
    `Tailscale reports the state "${state}", which Mini-Summa does not recognise. Open the Tailscale app to see what it needs, then refresh.`,
  noDnsName: () =>
    'This PC has no Tailscale DNS name yet. Turn on MagicDNS at https://login.tailscale.com/admin/dns, then refresh.',
  httpsNotEnabled: () =>
    'HTTPS certificates are not enabled for your tailnet, so phones cannot connect securely. Open https://login.tailscale.com/admin/dns as a tailnet admin, scroll to HTTPS Certificates, choose Enable HTTPS, then turn remote access on again.',
  funnel: (hostPorts: string[]) =>
    `Tailscale Funnel is turned on for this PC (${hostPorts.join(', ')}). Funnel makes services reachable from the whole internet. Mini-Summa never uses Funnel and will not turn on remote access while it is on. Turn it off by running "tailscale funnel reset" in a terminal, then refresh.`,
  foreignServe: (target: string) =>
    `Tailscale Serve already publishes something else on port 443 (${target}), not this Mini-Summa. Mini-Summa will not replace it. If it is an old Mini-Summa setting or you no longer need it, run "tailscale serve --https=443 off" in a terminal, then turn remote access on again.`,
  staleServe: (oldPort: number, newPort: number) =>
    `Tailscale Serve still forwards phone traffic to port ${oldPort}, which Mini-Summa used in an earlier run. Mini-Summa now listens on port ${newPort}, and another program could be listening on port ${oldPort}. Turn remote access on again to point Serve at the right port, or run "tailscale serve --https=443 off" in a terminal.`,
  portNotReady: () =>
    'Mini-Summa has not started its local server yet, so remote access cannot be set up. Wait a moment, then try again.',
  serveUnreadable: (detail: string) =>
    `Mini-Summa could not read which services Tailscale Serve publishes${detail ? ` (${detail})` : ''}. Update Tailscale, or run "tailscale serve status" in a terminal to check.`,
  serveNotShown: () =>
    'Tailscale accepted the command but does not list Mini-Summa as published. Run "tailscale serve status" in a terminal to see what is configured, then try again.',
};

const firstLines = (text: string, max = 220): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
};

/** Output that means the Tailscale daemon is not there to answer. */
export const looksNotRunning = (output: string): boolean =>
  /failed to connect to local|is tailscale running|doesn'?t appear to be running|not running|connection refused|no such file or directory.*tailscaled|the tailscale service|cannot connect to the tailscale|can't reach the tailscale/i.test(output);

/**
 * The text for a failed `tailscale serve` command. `kind` is what Mini-Summa was trying to do.
 * Matches the wording of real Tailscale output loosely, and always falls back to quoting the first line it said.
 */
export function describeServeFailure(output: string, kind: 'enable' | 'disable'): string {
  const text = output.trim();
  const login = /https:\/\/login\.tailscale\.com\/\S+/i.exec(text)?.[0]?.replace(/[).,;]+$/, '') ?? null;
  if (looksNotRunning(text)) return problems.notRunning();
  if (/serve is not enabled|serve.*not enabled on your tailnet/i.test(text)) {
    return `Tailscale Serve is not enabled for your tailnet. A tailnet admin must enable it${login ? ` at ${login}` : ' in the Tailscale admin console'}, then turn remote access on again.`;
  }
  if (/https/i.test(text) && /(not enabled|not configured|disabled|does not support|doesn'?t support|enable https)/i.test(text)) {
    return `${problems.httpsNotEnabled()}${login ? ` (Tailscale suggested: ${login})` : ''}`;
  }
  if (/access denied|permission denied|operator|must be root|administrator/i.test(text)) {
    return 'Tailscale refused the change because this account is not allowed to manage it. On Linux, run "sudo tailscale set --operator=$USER" once. On Windows, start Mini-Summa as the user who installed Tailscale or as an administrator. Then try again.';
  }
  if (/unknown flag|flag provided but not defined|unrecognized|unknown command|unexpected argument/i.test(text)) {
    return 'This version of Tailscale is too old to publish Mini-Summa (it needs "tailscale serve --bg", available from version 1.52). Update Tailscale and try again.';
  }
  const said = firstLines(text);
  const action = kind === 'enable' ? 'publish Mini-Summa' : 'stop publishing Mini-Summa';
  return `Tailscale could not ${action}${said ? `. It said: ${said}` : ''}. Run "tailscale serve status" in a terminal for details, then try again.`;
}

// ---------------------------------------------------------------------------------------------------------------

export const emptyStatus = (checkedAt: string): TailscaleStatus => ({
  installed: false, running: false, loggedIn: false, backendState: null, hostName: null, dnsName: null, tailnet: null,
  tailscaleIps: [], serve: { configured: false, url: null, target: null, funnelDetected: false }, checkedAt, problem: null,
});

/** The part of a status that matters for "did anything change": everything except when it was checked. */
export const statusKey = (s: TailscaleStatus): string => JSON.stringify({ ...s, checkedAt: null });

/** What the backend state means for the user. null = nothing wrong with the connection itself. */
export function problemForBackend(state: string): string | null {
  switch (state) {
    case 'Running': return null;
    case 'Stopped': return problems.stopped();
    case 'NeedsLogin': return problems.needsLogin();
    case 'NeedsMachineAuth': return problems.needsMachineAuth();
    case 'Starting': case 'NoState': return problems.starting();
    default: return problems.unknownState(state);
  }
}
