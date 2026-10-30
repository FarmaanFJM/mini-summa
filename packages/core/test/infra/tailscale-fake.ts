// A stand-in for the `tailscale` command line: a small Node script that answers `status --json`, `serve status --json`
// and the serve commands from canned JSON, and records every call. The tests change its answers between calls through
// state.json, and the script changes the Serve configuration the way the real CLI would when `serve --bg` / `off` run.
//
// POSIX only: the script is started through its shebang line. Real Tailscale is NOT exercised by any of this.
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './part1-fixtures.ts';

export interface CliAnswer { exit?: number; stdout?: string; stderr?: string }

export interface FakeState {
  status: CliAnswer;
  serveStatus: CliAnswer;
  /** Answer to `serve --bg ...`. `apply: false` = report success but leave the Serve configuration unchanged. */
  serveCmd: CliAnswer & { apply?: boolean };
  /** Answer to `serve --https=443 off`. */
  serveOff: CliAnswer & { apply?: boolean };
  /** DNS name used as the key when the fake applies `serve --bg`. */
  dns: string;
  /** Block (for a minute) instead of answering. `hangOn` limits it to commands starting with that text. */
  hang?: boolean;
  hangOn?: string;
  /** Text written to stderr before blocking, like the real CLI printing where to enable Serve and then waiting. */
  hangOutput?: string;
}

const SCRIPT = (dir: string): string => `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(argv) + '\\n');
const statePath = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (r) => {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exit || 0);
};
const key = argv.join(' ');
const hostKey = () => state.dns.replace(/\\.$/, '') + ':443';
const readCfg = () => { try { return JSON.parse(state.serveStatus.stdout || '{}'); } catch { return {}; } };

if (state.hang && (!state.hangOn || key.startsWith(state.hangOn))) {
  if (state.hangOutput) process.stderr.write(state.hangOutput);
  setTimeout(() => process.exit(0), 60000);
} else if (key === 'status --json') {
  out(state.status);
} else if (key === 'serve status --json') {
  out(state.serveStatus);
} else if (argv[0] === 'serve' && argv.includes('--bg')) {
  const r = state.serveCmd;
  if (!(r.exit > 0) && r.apply !== false) {
    const cfg = readCfg();
    cfg.TCP = Object.assign({}, cfg.TCP, { '443': { HTTPS: true } });
    cfg.Web = Object.assign({}, cfg.Web, { [hostKey()]: { Handlers: { '/': { Proxy: argv[argv.length - 1] } } } });
    state.serveStatus = { stdout: JSON.stringify(cfg) };
    save();
  }
  out(r);
} else if (argv[0] === 'serve' && argv.includes('--https=443') && argv.includes('off')) {
  const r = state.serveOff;
  if (!(r.exit > 0) && r.apply !== false) {
    const cfg = readCfg();
    if (cfg.Web) delete cfg.Web[hostKey()];
    if (cfg.TCP) delete cfg.TCP['443'];
    state.serveStatus = { stdout: JSON.stringify(cfg) };
    save();
  }
  out(r);
} else {
  out({ exit: 99, stderr: 'the fake tailscale does not know: ' + key + '\\n' });
}
`;

export class FakeTailscale {
  readonly dir: string;
  readonly bin: string;

  constructor(initial: Partial<FakeState> = {}) {
    this.dir = tempDir('ms-fake-ts-');
    this.bin = path.join(this.dir, 'tailscale');
    fs.writeFileSync(this.bin, SCRIPT(this.dir), { mode: 0o755 });
    fs.chmodSync(this.bin, 0o755);
    const state: FakeState = {
      status: { stdout: statusJson() },
      serveStatus: { stdout: '{}' },
      serveCmd: {},
      serveOff: {},
      dns: 'farmaan-pc.tail1234.ts.net.',
      ...initial,
    };
    fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(this.dir, 'calls.log'), '');
  }

  private statePath(): string { return path.join(this.dir, 'state.json'); }
  state(): FakeState { return JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) as FakeState; }
  set(patch: Partial<FakeState>): void { fs.writeFileSync(this.statePath(), JSON.stringify({ ...this.state(), ...patch })); }

  /** Replace what `status --json` prints with a normal document. */
  setStatus(opts: StatusOptions): void { this.set({ status: { stdout: statusJson(opts) } }); }

  /** Replace what `status --json` does, byte for byte (garbage, failures). */
  setStatusAnswer(answer: CliAnswer): void { this.set({ status: answer }); }

  /** Replace the Serve configuration the fake reports. */
  setServe(config: object | null): void { this.set({ serveStatus: { stdout: config === null ? '' : JSON.stringify(config) } }); }

  serveConfig(): Record<string, unknown> {
    try { return JSON.parse(this.state().serveStatus.stdout ?? '{}') as Record<string, unknown>; } catch { return {}; }
  }

  /** Every call so far, as argument lists. */
  calls(): string[][] {
    return fs.readFileSync(path.join(this.dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
  }
  callLines(): string[] { return this.calls().map((c) => c.join(' ')); }
  clearCalls(): void { fs.writeFileSync(path.join(this.dir, 'calls.log'), ''); }
}

export interface StatusOptions {
  state?: string;
  dns?: string | null;
  host?: string;
  tailnet?: string;
  ips?: string[];
  /** undefined = a normal list; null = the field is null (HTTPS not enabled); 'absent' = an old Tailscale without the field. */
  certDomains?: string[] | null | 'absent';
}

/** `tailscale status --json` as a Running, signed-in Windows machine prints it (the fields Mini-Summa reads). */
export function statusJson(o: StatusOptions = {}): string {
  const dns = o.dns === undefined ? 'farmaan-pc.tail1234.ts.net.' : o.dns;
  const ips = o.ips ?? ['100.101.102.103', 'fd7a:115c:a1e0::1234'];
  const doc: Record<string, unknown> = {
    Version: '1.78.1-t4a2c4f2c6-g1d5b4f9b2',
    TUN: true,
    BackendState: o.state ?? 'Running',
    HaveNodeKey: true,
    AuthURL: '',
    TailscaleIPs: ips,
    Self: dns === null ? { HostName: o.host ?? 'FARMAAN-PC', DNSName: '' } : { ID: 'n123', HostName: o.host ?? 'FARMAAN-PC', DNSName: dns, OS: 'windows', Online: true, TailscaleIPs: ips },
    Health: [],
    MagicDNSSuffix: 'tail1234.ts.net',
    CurrentTailnet: { Name: o.tailnet ?? 'farmaan@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
    Peer: {},
    User: {},
  };
  if (o.certDomains !== 'absent') doc.CertDomains = o.certDomains === undefined ? ['farmaan-pc.tail1234.ts.net'] : o.certDomains;
  return JSON.stringify(doc);
}

/** What `tailscale serve status --json` prints when Mini-Summa's port is published (and optionally with Funnel on). */
export function serveConfigFor(opts: { dns?: string; target?: string; funnel?: boolean; port?: number } = {}): object {
  const host = `${opts.dns ?? 'farmaan-pc.tail1234.ts.net'}:${opts.port ?? 443}`;
  return {
    TCP: { [String(opts.port ?? 443)]: { HTTPS: true } },
    Web: { [host]: { Handlers: { '/': { Proxy: opts.target ?? 'http://127.0.0.1:4317' } } } },
    ...(opts.funnel ? { AllowFunnel: { [host]: true } } : {}),
  };
}
