// One throw-away world per launch: a home directory, a data directory, repositories, a place for the fake Claude's state,
// and an environment for the app that contains only what it needs. Nothing of the real home, the real data directory, the
// real Claude or the developer's credentials is visible from inside it.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeClaudeWrapper, writeDecoyClaude } from './fake-claude.ts';
import type { StandIn } from './standin.ts';

export interface Sandbox {
  /** Real path of the whole world; removed when the test ends. */
  root: string;
  /** HOME and XDG_* of the app: ~/.claude/settings.json lives here. */
  home: string;
  /** MINISUMMA_DATA_DIR: database, spool, logs, settings, backups, the Electron profile. */
  data: string;
  /** Project repositories are made here, far from the data directory. */
  repos: string;
  /** TMPDIR of the app and of everything it starts. */
  tmp: string;
  /** The fake Claude's state directory (registrations, received prompts, terminal sizes, hook runs). */
  fakeState: string;
  /** PATH of the app starts here: the decoy `claude` that must never run. */
  bin: string;
  /** MINISUMMA_CLAUDE_BIN. */
  claudeBin: string;
  /** Created if the decoy `claude` is ever started. */
  decoyMarker: string;
}

export function createSandbox(knobs: Record<string, string> = {}): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-e2e-')));
  const sb: Sandbox = {
    root,
    home: path.join(root, 'home'),
    data: path.join(root, 'data'),
    repos: path.join(root, 'repos'),
    tmp: path.join(root, 'tmp'),
    fakeState: path.join(root, 'fake-claude-state'),
    bin: path.join(root, 'bin'),
    claudeBin: '',
    decoyMarker: path.join(root, 'DECOY-CLAUDE-WAS-STARTED'),
  };
  for (const dir of [sb.home, sb.repos, sb.tmp, sb.fakeState, sb.bin]) fs.mkdirSync(dir, { recursive: true });
  sb.claudeBin = writeClaudeWrapper(path.join(root, 'fake'), sb.fakeState, knobs);
  writeDecoyClaude(sb.bin, sb.decoyMarker);
  return sb;
}

/** A project repository: a real directory with a file in it, and (by default) a real git repository. */
export function makeRepo(sb: Sandbox, name: string, options: { git?: boolean } = {}): string {
  const dir = path.join(sb.repos, name.replace(/[^A-Za-z0-9_.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nA repository for the acceptance suite.\n`);
  if (options.git !== false) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: sb.home } });
    } catch { /* git is optional for the tests that use this: the directory is the point */ }
  }
  return dir;
}

/** The environment of the app. Built from scratch, not from process.env, so no credential of the developer is inherited. */
export function appEnv(sb: Sandbox, standIn: StandIn, extra: Record<string, string> = {}): Record<string, string> {
  const dead = 'http://127.0.0.1:9';
  const env: Record<string, string | undefined> = {
    // The decoy `claude` comes first so that a PATH lookup could never find the real one.
    PATH: [sb.bin, '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    HOME: sb.home,
    XDG_CONFIG_HOME: path.join(sb.home, '.config'),
    XDG_DATA_HOME: path.join(sb.home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(sb.home, '.cache'),
    XDG_STATE_HOME: path.join(sb.home, '.local', 'state'),
    TMPDIR: sb.tmp,
    LANG: 'C.UTF-8',
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    // If the app ever sent a request through a proxy instead of resolving it by the host rules, it would fail here.
    http_proxy: dead, https_proxy: dead, HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead,
    MINISUMMA_DATA_DIR: sb.data,
    MINISUMMA_CLAUDE_BIN: sb.claudeBin,
    MINISUMMA_TEST_HOST_RULES: standIn.hostRules,
    MINISUMMA_TEST_TRUST_CERTS: '1',
    ...extra,
  };
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

// ---------------------------------------------------------------------------------------------------------------
// Cleaning up: whatever the app started must be gone when the test is over

function readProc(pid: string, file: string): string {
  try { return fs.readFileSync(`/proc/${pid}/${file}`, 'latin1'); } catch { return ''; }
}

/** Pids of every process that belongs to this sandbox: its command line names it, or its environment carries its data directory. */
export function sandboxProcesses(sb: Sandbox): number[] {
  if (process.platform !== 'linux') return [];
  const marker = `MINISUMMA_DATA_DIR=${sb.data}\0`;
  const found: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    if (readProc(entry, 'cmdline').includes(sb.root) || readProc(entry, 'environ').includes(marker)) found.push(Number(entry));
  }
  return found;
}

export async function killSandboxProcesses(sb: Sandbox): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const pids = sandboxProcesses(sb);
    if (pids.length === 0) return;
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function removeSandbox(sb: Sandbox): void {
  // Files the app made read-only (backups are 0600 but owned by us) are removable; force covers a vanished directory.
  fs.rmSync(sb.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** A fingerprint of a directory tree (relative path -> size and sha1), to prove nothing was added, changed or removed. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) { out[`${rel}/`] = 'dir'; walk(full); } else if (entry.isFile()) {
        out[rel] = `${fs.statSync(full).size}:${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`;
      } else out[rel] = entry.isSymbolicLink() ? 'symlink' : 'other';
    }
  };
  walk(dir);
  return out;
}
