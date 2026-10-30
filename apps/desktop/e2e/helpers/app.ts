// Launching the REAL built desktop app (Electron main + preload + React renderer + the embedded core service + SQLite + PTYs)
// through Playwright's _electron, inside a sandbox, and cleaning everything up afterwards.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { MiniSummaClient } from '@minisumma/shared';
import WebSocket from 'ws';
import { APP_DIR_ENV } from './env.ts';
import { answerMessageBoxes, setWindowSize } from './main-process.ts';
import { appEnv, createSandbox, killSandboxProcesses, removeSandbox } from './sandbox.ts';
import type { Sandbox } from './sandbox.ts';
import { startStandIn } from './standin.ts';
import type { StandIn } from './standin.ts';
import { sleep, until, within } from './wait.ts';

export interface LaunchOptions {
  /** Reuse an earlier launch's world (a restart): same data directory, same profile, same repositories. */
  sandbox?: Sandbox;
  standIn?: StandIn;
  /** Environment knobs for the fake Claude (FAKE_CLAUDE_*), written into its wrapper. Only used when the sandbox is created here. */
  fakeKnobs?: Record<string, string>;
  /** Extra environment variables for the app. */
  env?: Record<string, string>;
  /** Working directory of the app process. Default: the sandbox root, so a stray relative write cannot land in a repository. */
  cwd?: string;
  /** Resize the window right after it opened. */
  size?: { width: number; height: number };
  /** Leave the first-run checklist ("Set up Mini-Summa") on screen. By default a person's first click, "Hide the checklist", is done for the test. */
  firstRun?: boolean;
}

export interface AppHandle {
  readonly sandbox: Sandbox;
  readonly standIn: StandIn;
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly baseUrl: string;
  /** The port of the embedded core (and so of the window's origin). The core prefers 47811 and takes a free port when it is busy. */
  readonly port: number;
  readonly token: string;
  /** The typed client of the core (desktop token), with its event stream connected. */
  readonly api: MiniSummaClient;
  readonly pid: number;
  readonly electronVersion: string;
  /** stdout and stderr of the app so far. */
  output(): string;
  /** Uncaught exceptions and console errors of the main window. */
  readonly pageErrors: string[];
  /** Quit like a person would (the quit confirmation is answered "Quit"), and wait for the process to exit. Returns its exit code. */
  quit(): Promise<{ code: number | null; signal: string | null; asked: { message?: string; detail?: string }[] }>;
  /** Kill the process now (SIGKILL), as a crash or power loss would. */
  kill(): Promise<void>;
}

interface Registry { handles: Set<AppHandle>; sandboxes: Set<Sandbox>; standIns: Set<StandIn>; listeners: Set<PortHolder> }
const registry: Registry = { handles: new Set(), sandboxes: new Set(), standIns: new Set(), listeners: new Set() };

const require = createRequire(import.meta.url);

function builtAppDir(): string {
  const dir = process.env[APP_DIR_ENV];
  if (!dir || !fs.existsSync(path.join(dir, 'out', 'main', 'index.js'))) {
    throw new Error(`No built app. ${APP_DIR_ENV} is ${dir ? `${dir} (no out/main/index.js there)` : 'not set'}; the vitest global setup builds it (e2e/helpers/global-setup.ts).`);
  }
  return dir;
}

export async function launchApp(options: LaunchOptions = {}): Promise<AppHandle> {
  if (process.platform === 'linux' && !process.env.DISPLAY) throw new Error('No DISPLAY. Run the suite under Xvfb: xvfb-run -a npm run e2e');
  const sandbox = options.sandbox ?? createSandbox(options.fakeKnobs);
  registry.sandboxes.add(sandbox);
  const standIn = options.standIn ?? await startStandIn();
  registry.standIns.add(standIn);

  const executablePath = require('electron') as string;
  const app = await electron.launch({
    executablePath,
    args: [builtAppDir()],
    env: appEnv(sandbox, standIn, options.env),
    cwd: options.cwd ?? sandbox.root,
    timeout: 60_000,
  });
  const proc = app.process();
  const out: string[] = [];
  proc.stdout?.on('data', (d) => out.push(String(d)));
  proc.stderr?.on('data', (d) => out.push(String(d)));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));

  let handle: AppHandle | null = null;
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`); });
    await page.waitForURL(/\/ui\//, { timeout: 45_000 });
    const connection = await page.evaluate(() => window.miniSumma!.connection());
    const api = new MiniSummaClient({ baseUrl: connection.baseUrl, token: connection.token, clientName: 'e2e-suite', WebSocket: WebSocket as never });
    api.events.connect();

    // The window shows the project list once the first snapshot arrived.
    await until('the app to finish loading its data', () => page.evaluate(() => !document.querySelector('[aria-label="Loading projects"]') && !!document.querySelector('nav[aria-label="Projects"]')), { timeout: 30_000 });

    // The first-run checklist floats over the corner of the window until it is hidden; every test but the first-run one hides it.
    if (!options.firstRun) {
      const checklist = page.getByRole('region', { name: 'Set up Mini-Summa' });
      if (await checklist.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) {
        await page.getByRole('button', { name: 'Hide the checklist' }).click();
        await checklist.waitFor({ state: 'hidden' });
      }
    }

    // Hard guard: this suite only ever runs the fake Claude. The app must have been told so, and must have believed it.
    const environments = await api.call('environments.list');
    const host = environments.find((e) => !e.id.startsWith('wsl:'));
    if (!host || host.claude.path !== sandbox.claudeBin) {
      throw new Error(`The app would start "${host?.claude.path ?? 'no Claude'}" instead of the fake Claude at ${sandbox.claudeBin}. Refusing to continue.`);
    }

    const electronVersion = await app.evaluate(() => process.versions.electron);
    let gone = false;
    handle = {
      sandbox, standIn, app, page, baseUrl: connection.baseUrl, port: Number(new URL(connection.baseUrl).port), token: connection.token, api, pid: proc.pid ?? -1, electronVersion,
      pageErrors,
      output: () => out.join(''),
      async quit() {
        const recordTo = path.join(sandbox.root, `quit-dialog-${Date.now()}.jsonl`);
        if (gone) return { code: null, signal: null, asked: [] };
        await answerMessageBoxes(app, 0, recordTo).catch(() => undefined);
        api.close();
        await app.evaluate(({ app: electronApp }) => { setTimeout(() => electronApp.quit(), 10); }).catch(() => undefined);
        const result = await Promise.race([exited, sleep(30_000).then(() => ({ code: null, signal: 'timeout' as string | null }))]);
        gone = true;
        if (result.signal === 'timeout') await handle!.kill();
        let asked: { message?: string; detail?: string }[] = [];
        try {
          asked = fs.readFileSync(recordTo, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch { /* nothing was asked */ }
        await killSandboxProcesses(sandbox);
        return { ...result, asked };
      },
      async kill() {
        gone = true;
        api.close();
        killTree(proc);
        await killSandboxProcesses(sandbox);
      },
    };
    registry.handles.add(handle);
    if (options.size) await setWindowSize(app, options.size.width, options.size.height);
    return handle;
  } catch (error) {
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    await killSandboxProcesses(sandbox);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- app output (tail) ---\n${out.join('').split('\n').filter((l) => !/dbus/i.test(l)).slice(-30).join('\n')}`);
  }
}

function killTree(proc: ChildProcess): void {
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

/** The core prefers this port for its address (the window's origin depends on it). */
export const PREFERRED_CORE_PORT = 47811;

export interface PortHolder {
  readonly port: number;
  /** Stops listening and drops every connection. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Takes the core's preferred port (47811, on 127.0.0.1) with a throw-away listener that answers nothing, the way another program (or
 * a second Windows user's Mini-Summa) would hold it. The next launch's core then finds the port busy and falls back to a free one, so
 * its web origin differs from the last launch's. The listener is closed by `close()` and, whatever the test did, by `cleanupAll()`.
 * It retries for a moment, because the app that had the port may still be letting go of it.
 */
export async function occupyPreferredPort(): Promise<PortHolder> {
  const net = await import('node:net');
  const sockets = new Set<import('node:net').Socket>();
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const server = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined); });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(PREFERRED_CORE_PORT, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    } catch (error) {
      last = error;
      await sleep(50);
      continue;
    }
    let closed = false;
    const holder: PortHolder = {
      port: PREFERRED_CORE_PORT,
      async close() {
        if (closed) return;
        closed = true;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        registry.listeners.delete(holder);
      },
    };
    registry.listeners.add(holder);
    return holder;
  }
  throw new Error(`Could not take port ${PREFERRED_CORE_PORT} for the test: ${last instanceof Error ? last.message : String(last)}. Something else on this machine holds it.`);
}

/** Waits (briefly) until nothing listens on the preferred port, so that the next launch gets the same origin as the last one. */
async function waitForPreferredPortFree(): Promise<boolean> {
  const net = await import('node:net');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(PREFERRED_CORE_PORT, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return true;
    await sleep(50);
  }
  return false;
}

/**
 * Every launched app is stopped, every stand-in closed and every sandbox removed. Called after each test. A process of the
 * sandbox that cannot be killed is an error: a leaked Electron would hold the core's preferred port and give the next launch
 * a different address.
 */
export async function cleanupAll(): Promise<void> {
  const leaked: string[] = [];
  for (const handle of [...registry.handles]) {
    await within('kill app', 15_000, handle.kill()).catch(() => undefined);
    registry.handles.delete(handle);
  }
  for (const holder of [...registry.listeners]) { await within('close the port listener', 5_000, holder.close()).catch(() => undefined); registry.listeners.delete(holder); }
  for (const standIn of [...registry.standIns]) { await within('close stand-in', 5_000, standIn.close()).catch(() => undefined); registry.standIns.delete(standIn); }
  for (const sandbox of [...registry.sandboxes]) {
    const left = await killSandboxProcesses(sandbox);
    if (left > 0) leaked.push(`${left} process(es) of ${sandbox.root} survived SIGKILL`);
    removeSandbox(sandbox);
    registry.sandboxes.delete(sandbox);
  }
  await waitForPreferredPortFree();
  if (leaked.length > 0) throw new Error(`Leaked processes: ${leaked.join('; ')}`);
}

/** What to keep from a failed test: a screenshot of every window, the app's output, the stand-in's requests, the core log. */
export async function saveArtifacts(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const handle of registry.handles) {
    n += 1;
    const base = path.join(dir, `app${n}`);
    await within('screenshot', 10_000, handle.page.screenshot({ path: `${base}.png` })).catch(() => undefined);
    fs.writeFileSync(`${base}.output.txt`, handle.output());
    fs.writeFileSync(`${base}.page-errors.txt`, handle.pageErrors.join('\n'));
    fs.writeFileSync(`${base}.standin.json`, JSON.stringify(handle.standIn.requests.map((r) => ({ n: r.n, method: r.method, host: r.host, path: r.path })), null, 1));
    for (const log of [path.join(handle.sandbox.data, 'logs', 'core.log'), path.join(handle.sandbox.data, 'electron-profile', 'logs', 'main.log')]) {
      try { fs.copyFileSync(log, `${base}.${path.basename(log)}`); } catch { /* not written */ }
    }
    try { fs.writeFileSync(`${base}.fake-claude-hooks.txt`, fs.readdirSync(handle.sandbox.fakeState).join('\n')); } catch { /* none */ }
  }
}

export const liveHandles = (): AppHandle[] => [...registry.handles];

/** True if any launched sandbox's decoy `claude` was started. Checked after every test. */
export function decoyClaudeStarted(): string[] {
  return [...registry.sandboxes].filter((s) => fs.existsSync(s.decoyMarker)).map((s) => fs.readFileSync(s.decoyMarker, 'utf8'));
}
