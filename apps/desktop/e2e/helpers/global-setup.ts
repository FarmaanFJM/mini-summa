// Runs once, before any test: checks the display, builds the app into a PRIVATE directory (so that other people's builds of
// apps/desktop/out cannot change what this run launches) and writes down what the run is made of.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR, APP_DIR_ENV, HISTORY_FILE, META_FILE, REPO_ROOT, RESULTS_DIR } from './env.ts';

const require = createRequire(import.meta.url);

function run(label: string, command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').slice(-40).join('\n');
    throw new Error(`${label} failed (exit ${result.status}). A build can fail while somebody else is editing the sources; look at the output before blaming the tests.\n${tail}`);
  }
}

/** Best effort: which source the run was built from. Reading the repository's state never changes it. */
function sourceState(): { commit: string | null; uncommittedChanges: boolean | null } {
  const git = (args: string[]) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const head = git(['rev-parse', '--short', 'HEAD']);
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  return {
    commit: head.status === 0 ? head.stdout.trim() : null,
    uncommittedChanges: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

/** What the display is: the suite is meant to run under Xvfb, and the report says so only when that is what it found. */
function displayServer(): string {
  if (process.platform !== 'linux') return process.platform;
  const display = process.env.DISPLAY ?? '';
  const list = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  const line = (list.stdout ?? '').split('\n').find((l) => /(^|\/)Xvfb(\s|$)/.test(l.trim().split(/\s+/)[0] ?? '') && l.trim().split(/\s+/)[1] === display);
  if (!line) return `X display ${display} (server not identified as Xvfb)`;
  const screen = /-screen\s+\d+\s+(\d+x\d+x\d+)/.exec(line)?.[1];
  return `Xvfb ${display}${screen ? ` (${screen})` : ''}`;
}

/**
 * <dir>/package.json, <dir>/out/{main,preload,renderer}, <dir>/resources, <dir>/node_modules: the layout `electron <dir>` and the
 * app's own path logic (resolveLocations) expect, without writing anything into the repository.
 */
function buildPrivateApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-e2e-app-'));
  // The hook bundle is what the Claude hooks run (Electron in node mode); it is built into the claude-integration package.
  run('building the hook bundle', 'npm', ['run', 'build:hook', '-w', '@minisumma/claude-integration'], REPO_ROOT);
  run('electron-vite build', path.join(REPO_ROOT, 'node_modules', '.bin', 'electron-vite'), ['build', '--outDir', path.join(dir, 'out')], APP_DIR);
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(APP_DIR, 'resources'), path.join(dir, 'resources'), 'dir');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const needed of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    if (!fs.existsSync(path.join(dir, needed))) throw new Error(`The build did not produce ${needed}.`);
  }
  return dir;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    throw new Error('No DISPLAY. The acceptance suite drives a real Electron window: run it under Xvfb, for example  xvfb-run -a npm run e2e');
  }
  // A fresh results directory for every run; only the log of earlier runs (written by e2e/run.mjs) is kept.
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  for (const entry of fs.readdirSync(RESULTS_DIR)) {
    if (path.join(RESULTS_DIR, entry) !== HISTORY_FILE) fs.rmSync(path.join(RESULTS_DIR, entry), { recursive: true, force: true });
  }

  const preset = process.env[APP_DIR_ENV];
  const built = preset ? null : buildPrivateApp();
  if (built) process.env[APP_DIR_ENV] = built;
  const appDir = preset ?? built!;

  const electronPackage = require('electron/package.json') as { version: string };
  const playwrightPackage = require('playwright/package.json') as { version: string };
  fs.writeFileSync(META_FILE, JSON.stringify({
    startedAt: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    electron: electronPackage.version,
    playwright: playwrightPackage.version,
    display: process.env.DISPLAY ?? null,
    displayServer: displayServer(),
    source: sourceState(),
    appBuild: preset ? `reused ${appDir}` : 'built for this run',
    runningAsRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  }, null, 2));

  return async () => {
    if (built && !process.env.MINISUMMA_E2E_KEEP_BUILD) fs.rmSync(built, { recursive: true, force: true });
  };
}
