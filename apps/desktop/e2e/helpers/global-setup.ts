// Runs once, before any test: checks the display, builds the app into a PRIVATE directory (so that other people's builds of
// apps/desktop/out cannot change what this run launches) and writes down what the run is made of.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR, APP_DIR_ENV, META_FILE, REPO_ROOT, RESULTS_DIR } from './env.ts';

const require = createRequire(import.meta.url);

function run(label: string, command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').slice(-40).join('\n');
    throw new Error(`${label} failed (exit ${result.status}). A build can fail while somebody else is editing the sources; look at the output before blaming the tests.\n${tail}`);
  }
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
  fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

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
    appBuild: preset ? `reused ${appDir}` : 'built for this run',
    runningAsRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  }, null, 2));

  return async () => {
    if (built && !process.env.MINISUMMA_E2E_KEEP_BUILD) fs.rmSync(built, { recursive: true, force: true });
  };
}
