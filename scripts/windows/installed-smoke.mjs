#!/usr/bin/env node
// Checks of the INSTALLED Mini-Summa on native Windows. Plain ESM; the only dependency is the repository's own `playwright`.
// Meant for the `installed-checks` job of .github/workflows/windows.yml (docs/WINDOWS_CI.md), but it runs on any Windows PC.
//
//   node scripts/windows/installed-smoke.mjs install   --installer <Mini-Summa-Setup-*.exe> [--out <dir>]
//   node scripts/windows/installed-smoke.mjs smoke     [<Mini-Summa.exe>]                    [--out <dir>]
//   node scripts/windows/installed-smoke.mjs uninstall                                       [--out <dir>]
//   node scripts/windows/installed-smoke.mjs report                                          [--out <dir>]
//   node scripts/windows/installed-smoke.mjs all       --installer <...>                     [--out <dir>]
//
// Each phase appends to <out>/results.json, prints one PASS / FAIL / NOT RUN / INFO block per check, and exits 1 when one of ITS
// checks failed. `report` writes <out>/windows-installed-report.md from everything recorded so far. Every check is independent: a
// failure is recorded and the next one still runs when it can. Nothing is skipped silently and no failure is turned into a pass.
//
// Honesty rules: a check that could not run says NOT RUN with the reason; a measurement that proves nothing by itself is INFO.
// The OS toast cannot be seen by anyone on a CI runner; check 5 says exactly that. See the "What this does NOT prove" list.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Results, STATUS, formatLine, renderReport, extractHookCommands, spoolFromCommand, exeFromCommand, encodePsCommand,
  samePath, deepDiff, hasChatgptUrlField, manifestExecutionLevel, findByName, findFilesContaining, pollUntil, sleep,
} from './lib/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PRODUCT = 'Mini-Summa';
const EXE_NAME = 'Mini-Summa.exe';
const CORE_PORT = 47811;

// ---------------------------------------------------------------------------------------------------------------------------
// Arguments, output folder, recorded state

const argv = process.argv.slice(2);
const phase = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
const OUT = path.resolve(flag('out') ?? process.env.WINDOWS_CI_OUT ?? path.join(REPO, 'windows-ci-out'));
const RESULTS_FILE = path.join(OUT, 'results.json');
const STATE_FILE = path.join(OUT, 'state.json');
fs.mkdirSync(OUT, { recursive: true });

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const results = new Results(readJson(RESULTS_FILE, []));
const state = readJson(STATE_FILE, {});
const saveAll = () => {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results.items, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

/** Run one check. `fn` returns [status, details]; an exception becomes a FAIL that carries the message. */
async function check(id, title, fn) {
  let status; let details;
  const t0 = Date.now();
  try { [status, details] = await fn(); } catch (error) {
    status = STATUS.FAIL;
    details = [`Unexpected error: ${error?.message ?? error}`, ...String(error?.stack ?? '').split('\n').slice(1, 5).map((s) => s.trim())];
  }
  const item = results.add(PHASE_TAG, id, title, status, [...(details ?? []), `(${Date.now() - t0} ms)`]);
  console.log(formatLine(item));
  saveAll();
  return item;
}
let PHASE_TAG = phase;
const pass = (...d) => [STATUS.PASS, d];
const fail = (...d) => [STATUS.FAIL, d];
const notRun = (...d) => [STATUS.NOT_RUN, d];
const info = (...d) => [STATUS.INFO, d];

// ---------------------------------------------------------------------------------------------------------------------------
// Windows helpers

const env = process.env;
const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const DEFAULT_INSTALL_DIR = path.join(localAppData, 'Programs', PRODUCT);
const USER_DIR = path.join(appData, PRODUCT);            // %APPDATA%\Mini-Summa (Electron userData, main.log)
const DATA_DIR = path.join(USER_DIR, 'data');            // the core: mini-summa.db, logs, spool
const claudeSettingsFile = path.join(os.homedir(), '.claude', 'settings.json');

function run(file, args, options = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 60_000, ...options });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
}
const ps = (script, timeout) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePsCommand(script)], { timeout });
const regFound = (key, extra = []) => run('reg.exe', ['query', key, ...extra]).code === 0;

function appProcesses() {
  const r = run('tasklist.exe', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH']);
  return r.stdout.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`"${EXE_NAME.toLowerCase()}"`)).map((l) => l.split('","')[1]);
}
function killApp() { return run('taskkill.exe', ['/F', '/T', '/IM', EXE_NAME]); }

async function waitProcessesGone(timeoutMs) {
  return pollUntil(() => appProcesses().length === 0, { timeoutMs, intervalMs: 500 });
}

function copyLogs(tag) {
  const dest = path.join(OUT, `app-logs-${tag}`);
  const sources = [[path.join(USER_DIR, 'logs'), 'shell'], [path.join(DATA_DIR, 'logs'), 'core']];
  for (const [dir, label] of sources) {
    try {
      for (const name of fs.readdirSync(dir)) {
        fs.mkdirSync(path.join(dest, label), { recursive: true });
        fs.copyFileSync(path.join(dir, name), path.join(dest, label, name));
      }
    } catch { /* no logs yet */ }
  }
  try { fs.mkdirSync(dest, { recursive: true }); fs.copyFileSync(path.join(DATA_DIR, 'spool', 'capture-errors.log'), path.join(dest, 'capture-errors.log')); } catch { /* none */ }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase: install (check group 1)

async function phaseInstall() {
  let installer = path.resolve(flag('installer') ?? positional[0] ?? '');
  // A folder is accepted too (the workflow passes the artifact folder): the one Mini-Summa-Setup-*.exe in it is used.
  if (fs.existsSync(installer) && fs.statSync(installer).isDirectory()) {
    const hit = safeList(installer).find((n) => /^Mini-Summa-Setup-.*\.exe$/i.test(n));
    if (hit) installer = path.join(installer, hit);
  }
  state.installer = installer;
  if (!fs.existsSync(installer) || !fs.statSync(installer).isFile()) {
    await check('1.0', 'The installer file is present', () => fail(`Not found: ${installer}`));
    return;
  }
  const bytes = fs.readFileSync(installer);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await check('1.0', 'The installer file is present', () => info(`${path.basename(installer)}, ${bytes.length} bytes, SHA-256 ${sha}`));

  await check('1.1', 'Elevation of this job (informational)', () => {
    const r = ps('[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))');
    const isAdmin = r.stdout.trim();
    return info(
      `WindowsPrincipal IsInRole(Administrator) = ${isAdmin || `unknown (${r.error ?? r.stderr.trim()})`}`,
      isAdmin === 'True'
        ? 'The GitHub runner account is an administrator, so "no UAC prompt appeared" cannot be proven by this job. The proof offered instead is 1.2 (the installer asks for no elevation), 1.3 and 1.8 (everything lands in per-user locations, nothing in Program Files or HKLM).'
        : 'This job is NOT elevated: a UAC prompt could not have been answered, so a successful install is evidence that none was needed.',
    );
  });

  await check('1.2', 'The installer asks Windows for no elevation (embedded manifest)', () => {
    const level = manifestExecutionLevel(bytes);
    if (level === null) return info('No requestedExecutionLevel was found in the installer file by a plain text search (the manifest may be compressed). Not a failure; 1.3 and 1.8 carry the weight.');
    if (level === 'asInvoker') return pass('requestedExecutionLevel = asInvoker');
    return fail(`requestedExecutionLevel = ${level}, but electron-builder.yml says asInvoker and "No administrator rights, ever."`);
  });

  const running = appProcesses();
  if (running.length) { log(`Stopping ${running.length} running ${EXE_NAME} before installing`); killApp(); await waitProcessesGone(30_000); }

  let installerExit = null;
  await check('1.3', 'Silent per-user install (Start-Process <installer> /S, waited for)', async () => {
    const t0 = Date.now();
    // The process is waited for directly. Start-Process -Wait would also wait for a Mini-Summa the installer starts afterwards.
    const child = spawn(installer, ['/S'], { stdio: 'ignore', windowsHide: true });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 300_000);
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code }); });
      child.once('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
    });
    const elapsed = Date.now() - t0;
    if (exit.timeout) { try { child.kill(); } catch { /* gone */ } return fail(`The installer did not finish within 300 s (${elapsed} ms).`); }
    if (exit.error) return fail(`The installer could not be started: ${exit.error}`);
    installerExit = exit.code;
    if (exit.code !== 0) return fail(`Installer exit code ${exit.code} after ${elapsed} ms (0 expected).`);
    return pass(`Installer exit code 0 after ${elapsed} ms.`);
  });

  // The installer may start the app after finishing (runAfterFinish). Whatever it started is stopped: the smoke phase launches its own.
  const dirAppears = await pollUntil(() => fs.existsSync(path.join(DEFAULT_INSTALL_DIR, EXE_NAME)), { timeoutMs: 60_000, intervalMs: 1000 });
  const afterInstall = appProcesses();
  if (afterInstall.length) { log(`The installer left ${afterInstall.length} ${EXE_NAME} process(es) running; stopping them (recorded below).`); killApp(); await waitProcessesGone(30_000); }
  state.installerExit = installerExit;
  state.appStartedByInstaller = afterInstall.length;

  const found = findByName(path.join(localAppData, 'Programs'), [EXE_NAME], 2);
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).flatMap((d) => findByName(path.join(d, PRODUCT), [EXE_NAME], 1));
  const installDir = dirAppears ? DEFAULT_INSTALL_DIR : (found[0] ? path.dirname(found[0]) : null);
  await check('1.4', `Install directory holds ${EXE_NAME} under %LOCALAPPDATA%\\Programs\\${PRODUCT}`, () => {
    const notes = [];
    if (afterInstall.length) notes.push(`Note: the installer started ${EXE_NAME} itself (${afterInstall.length} process(es)); it was stopped before the next phase.`);
    if (!installDir) return fail(`${path.join(DEFAULT_INSTALL_DIR, EXE_NAME)} does not exist.`, `Other ${EXE_NAME} under %LOCALAPPDATA%\\Programs: ${found.join(', ') || 'none'}`, `Under Program Files: ${pf.join(', ') || 'none'}`, ...notes);
    state.installDir = installDir;
    state.exe = path.join(installDir, EXE_NAME);
    const size = fs.statSync(state.exe).size;
    if (!samePath(installDir, DEFAULT_INSTALL_DIR)) return fail(`Installed to ${installDir}, not to ${DEFAULT_INSTALL_DIR}.`, ...notes);
    if (pf.length) return fail(`A copy also exists under Program Files: ${pf.join(', ')}`, ...notes);
    return pass(`${state.exe} (${size} bytes)`, ...notes);
  });
  if (!installDir) return;

  await check('1.5', 'resources\\hook\\capture.mjs is installed', () => {
    const f = path.join(installDir, 'resources', 'hook', 'capture.mjs');
    return fs.existsSync(f) ? pass(`${f} (${fs.statSync(f).size} bytes)`) : fail(`${f} is missing. Installed files: ${safeList(path.join(installDir, 'resources')).join(', ')}`);
  });

  await check('1.6', 'ConPTY files are installed on the real disk (conpty.dll, OpenConsole.exe, pty .node)', () => {
    const dll = findByName(installDir, ['conpty.dll']);
    const openConsole = findByName(installDir, ['OpenConsole.exe']);
    const nodeFiles = findByName(installDir, ['conpty.node', 'pty.node']);
    const asar = findByName(path.join(installDir, 'resources'), ['app.asar'], 1);
    const rel = (list) => list.map((p) => path.relative(installDir, p)).join(', ') || 'NONE';
    const lines = [`conpty.dll: ${rel(dll)}`, `OpenConsole.exe: ${rel(openConsole)}`, `pty .node: ${rel(nodeFiles)}`, `app.asar: ${rel(asar)}`];
    const inAsar = [...dll, ...openConsole, ...nodeFiles].filter((p) => /app\.asar[\\/]/.test(p));
    if (!dll.length || !openConsole.length || !nodeFiles.length) return fail('A ConPTY file is missing.', ...lines);
    if (inAsar.length) return fail('A native file is inside app.asar, where it cannot be loaded.', ...lines);
    return pass(...lines);
  });

  await check('1.7', 'The minisumma:// protocol key exists and points at the installed exe', () => {
    const r = run('reg.exe', ['query', 'HKCU\\Software\\Classes\\minisumma\\shell\\open\\command', '/ve']);
    if (r.code !== 0) return fail('HKCU\\Software\\Classes\\minisumma\\shell\\open\\command was not found.', r.stderr.trim());
    const value = r.stdout.split(/\r?\n/).find((l) => /REG_SZ/.test(l))?.replace(/^.*REG_SZ\s+/, '').trim() ?? '';
    const urlProtocol = regFound('HKCU\\Software\\Classes\\minisumma', ['/v', 'URL Protocol']);
    const ok = value.toLowerCase().includes(state.exe.toLowerCase());
    return ok && urlProtocol ? pass(`command = ${value}`, 'URL Protocol value present') : fail(`command = ${value}`, `URL Protocol value present: ${urlProtocol}`, `expected it to name ${state.exe}`);
  });

  await check('1.8', 'The uninstall entry is per-user (HKCU yes, HKLM no) and there is no Program Files copy', () => {
    const find = (hive) => run('reg.exe', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', PRODUCT, '/d']);
    const user = find('HKCU');
    const machine = find('HKLM');
    const wow = run('reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', PRODUCT, '/d']);
    const lines = [`HKCU uninstall entry found: ${user.code === 0}`, `HKLM uninstall entry found: ${machine.code === 0}`, `HKLM WOW6432Node entry found: ${wow.code === 0}`];
    return user.code === 0 && machine.code !== 0 && wow.code !== 0 ? pass(...lines) : fail(...lines, 'Expected per-user only.');
  });

  await check('1.9', 'Start menu / desktop shortcut (informational: the shortcut names are assumed from electron-builder defaults)', () => {
    const roots = [path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(os.homedir(), 'Desktop')];
    const hits = roots.flatMap((r) => findByName(r, [`${PRODUCT}.lnk`], 2));
    return hits.length ? info(`Found: ${hits.join(', ')}`) : info(`No ${PRODUCT}.lnk under ${roots.join(' or ')}. Either the shortcut lives elsewhere or it was not created.`);
  });
}

function safeList(dir) { try { return fs.readdirSync(dir); } catch { return ['(unreadable)']; } }

// ---------------------------------------------------------------------------------------------------------------------------
// Core API (plain fetch; the typed client of @minisumma/shared is TypeScript source and would need tsx, which adds nothing here)

class ApiFailure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function makeApi(conn) {
  return async (method, route, body) => {
    const headers = { accept: 'application/json', authorization: `Bearer ${conn.token}` };
    let payload;
    if (method !== 'GET' && method !== 'DELETE') { headers['content-type'] = 'application/json'; payload = JSON.stringify(body ?? {}); }
    if (method === 'POST') headers['idempotency-key'] = randomUUID();
    const res = await fetch(`${conn.baseUrl}/api/v1${route}`, { method, headers, body: payload, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new ApiFailure(res.status, json?.error?.code ?? `http_${res.status}`, json?.error?.message ?? text.slice(0, 300));
    return json;
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Launching the installed exe

/** Launch through Playwright's _electron. Throws with the reason when the packaged build cannot be driven that way. */
async function launchWithPlaywright(exe, tag) {
  const { _electron } = await import('playwright');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // would turn the exe into plain Node
  const app = await _electron.launch({ executablePath: exe, args: [], env: childEnv, cwd: os.homedir(), timeout: 120_000 });
  const proc = app.process();
  const out = [];
  proc.stdout?.on('data', (d) => out.push(String(d)));
  proc.stderr?.on('data', (d) => out.push(String(d)));
  const handle = { mode: 'playwright', app, proc, output: () => out.join('') };
  try {
    const page = await Promise.race([app.firstWindow(), sleep(120_000).then(() => { throw new Error('no window opened within 120 s'); })]);
    await page.waitForURL(/\/ui\//, { timeout: 120_000 });
    handle.page = page;
    handle.conn = await page.evaluate(() => window.miniSumma.connection());
    await pollUntil(async () => { try { return (await fetch(`${handle.conn.baseUrl}/api/v1/health`)).ok; } catch { return false; } }, { timeoutMs: 60_000 });
    await sleep(3000); // let the renderer finish its first load before anything is written to settings
    try { await page.screenshot({ path: path.join(OUT, `window-${tag}.png`) }); } catch { /* a screenshot is a diagnostic only */ }
    return handle;
  } catch (error) {
    try { await page_info(handle); } catch { /* best effort */ }
    try { proc.kill(); } catch { /* gone */ }
    error.message = `${error.message}\n--- app output (tail) ---\n${out.join('').split('\n').slice(-25).join('\n')}`;
    throw error;
  }
}
async function page_info(handle) {
  const windows = handle.app.windows();
  log(`Playwright sees ${windows.length} window(s): ${windows.map((w) => w.url()).join(', ')}`);
}

/** Fallback: start the exe plainly. Only the health probe and files on disk can be checked; the token is not reachable. */
async function launchPlain(exe) {
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const proc = spawn(exe, [], { env: childEnv, stdio: 'ignore', detached: true, windowsHide: false });
  proc.unref();
  const baseUrl = `http://127.0.0.1:${CORE_PORT}`;
  const healthy = await pollUntil(async () => { try { const r = await fetch(`${baseUrl}/api/v1/health`); return r.ok ? await r.json() : null; } catch { return null; } }, { timeoutMs: 120_000, intervalMs: 1000 });
  if (!healthy) throw new Error(`No answer from ${baseUrl}/api/v1/health within 120 s.`);
  return { mode: 'plain', proc, health: healthy, baseUrl };
}

async function quitApp(handle, label) {
  if (handle.mode === 'plain') {
    const r = killApp();
    await waitProcessesGone(30_000);
    return { clean: false, detail: `Plain launch: no clean quit is possible without the window; used taskkill (exit ${r.code}).` };
  }
  const exited = new Promise((resolve) => handle.proc.once('exit', (code, signal) => resolve({ code, signal })));
  const already = handle.proc.exitCode !== null || handle.proc.signalCode !== null;
  // A quit confirmation (only shown when terminals or unhandled reports exist, which this run has none of) is answered "Quit", as the e2e suite does.
  if (!already) await handle.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }).catch(() => undefined);
  if (!already) await handle.app.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); }).catch(() => undefined);
  const result = already ? { code: handle.proc.exitCode, signal: handle.proc.signalCode } : await Promise.race([exited, sleep(45_000).then(() => ({ timeout: true }))]);
  let clean = !result.timeout;
  if (result.timeout) log(`${label}: the app did not exit within 45 s of app.quit(); killing it`);
  const gone = await waitProcessesGone(result.timeout ? 1 : 30_000);
  if (!gone) { clean = false; killApp(); await waitProcessesGone(15_000); }
  try { await Promise.race([handle.app.close(), sleep(5000)]); } catch { /* already gone */ }
  return { clean: clean && Boolean(gone), detail: `exit ${JSON.stringify(result)}; all ${EXE_NAME} processes gone: ${Boolean(gone)}` };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase: smoke (check groups 2 to 5)

async function phaseSmoke() {
  const exe = path.resolve(positional[0] ?? state.exe ?? path.join(DEFAULT_INSTALL_DIR, EXE_NAME));
  if (!fs.existsSync(exe)) {
    await check('2.0', 'The installed executable exists', () => fail(`Not found: ${exe}. Did the install phase fail?`));
    return;
  }
  state.exe = exe;
  const stale = appProcesses();
  if (stale.length) { log(`Stopping ${stale.length} stale ${EXE_NAME} process(es)`); killApp(); await waitProcessesGone(30_000); }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-ci-'));
  const folderDir = path.join(tmpRoot, 'proj folder é');            // a space and an accented letter, as in the manual checklist
  const hookCwd = path.join(tmpRoot, 'hook-cwd');
  const missingDir = path.join(tmpRoot, 'does not exist é');
  fs.mkdirSync(folderDir); fs.mkdirSync(hookCwd);
  const ctx = { exe, projectId: null, project: null, wrote: null };
  let first = null;
  let second = null;
  try {
    // ----- 2.1 launch ------------------------------------------------------------------------------------------------
    let launchNotes = [];
    await check('2.1', 'Launch the INSTALLED exe with Playwright _electron and read window.miniSumma.connection()', async () => {
      try {
        first = await launchWithPlaywright(exe, 'first');
        return pass(`Window URL ${first.page.url()}`, `core at ${first.conn.baseUrl} (token not logged)`, `pid ${first.proc.pid}`);
      } catch (error) {
        launchNotes = [`Playwright could not drive the packaged build: ${String(error.message).split('\n')[0]}`];
        log(launchNotes[0], '-> falling back to a plain launch (health probe and files only)');
        killApp(); await waitProcessesGone(20_000);
        try {
          first = await launchPlain(exe);
          return [STATUS.INFO, [...launchNotes, `Fallback: started the exe plainly, GET ${first.baseUrl}/api/v1/health answered ${JSON.stringify(first.health)}.`, 'The API token is held in memory by the app and window only, so every check that needs the API is NOT RUN in this mode.', 'Full Playwright error:', ...String(error.message).split('\n').slice(0, 30)]];
        } catch (error2) {
          return fail(...launchNotes, `Fallback launch failed too: ${error2.message}`, 'Full Playwright error:', ...String(error.message).split('\n').slice(0, 30));
        }
      }
    });
    copyLogs('after-launch-1');
    if (!first) return;

    let api = null;
    if (first.mode === 'playwright') api = makeApi(first.conn);

    // ----- 2.2 project without a folder ------------------------------------------------------------------------------
    const projectInput = {
      name: 'CI project (GitHub + ChatGPT, no folder)',
      githubRepo: 'octocat/hello-world',
      chatgptProject: { url: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project', title: 'CI linked ChatGPT Project' },
    };
    await check('2.2', 'Create a project with githubRepo + chatgptProject and NO folder (R1/R2/R3 at the core level)', async () => {
      if (!api) return notRun('Needs the API token; see 2.1.');
      const created = await api('POST', '/projects', projectInput);
      ctx.projectId = created.id;
      const got = await api('GET', `/projects/${created.id}`);
      const list = await api('GET', '/projects');
      const problems = [];
      if (got.githubRepo !== projectInput.githubRepo) problems.push(`githubRepo = ${JSON.stringify(got.githubRepo)}`);
      if (!got.chatgptProject?.url) problems.push(`chatgptProject = ${JSON.stringify(got.chatgptProject)}`);
      if (got.roots.length !== 0) problems.push(`roots has ${got.roots.length} entries, expected none`);
      if (!list.some((p) => p.id === created.id)) problems.push('the project is missing from projects.list');
      return problems.length ? fail(...problems) : pass(`project ${created.id}`, `githubRepo ${got.githubRepo}`, `chatgptProject ${got.chatgptProject.url}`, 'roots: none, accepted as valid');
    });

    // ----- 2.3 folder root persisted (R1) -----------------------------------------------------------------------------
    await check('2.3', 'Add a real temp folder as a root and read it back at once (folder-persistence regression, core level)', async () => {
      if (!api) return notRun('Needs the API token; see 2.1.');
      if (!ctx.projectId) return notRun('2.2 did not create a project.');
      const updated = await api('POST', `/projects/${ctx.projectId}/roots`, { path: folderDir });
      const got = await api('GET', `/projects/${ctx.projectId}`);
      const wantReal = fs.realpathSync.native(folderDir);
      const hit = got.roots.find((r) => samePath(r.path, folderDir) || samePath(r.path, wantReal));
      const lines = [`asked for ${folderDir}`, `roots now: ${JSON.stringify(got.roots.map((r) => ({ env: r.env, path: r.path })))}`];
      if (!hit) return fail('The folder is not among the roots after addRoot.', ...lines);
      if (updated.roots.length !== 1) return fail(`projects.addRoot returned ${updated.roots.length} roots.`, ...lines);
      return pass(...lines);
    });

    await check('2.4', 'A folder that does not exist is refused with a message, and nothing is stored', async () => {
      if (!api) return notRun('Needs the API token; see 2.1.');
      if (!ctx.projectId) return notRun('2.2 did not create a project.');
      let refused = null;
      try { await api('POST', `/projects/${ctx.projectId}/roots`, { path: missingDir }); } catch (error) { refused = error; }
      const got = await api('GET', `/projects/${ctx.projectId}`);
      if (!refused) return fail(`addRoot accepted ${missingDir}.`, `roots: ${JSON.stringify(got.roots.map((r) => r.path))}`);
      if (got.roots.length !== 1) return fail(`The refused folder changed the stored roots (${got.roots.length}).`);
      if (!refused.message || refused.message.length < 10) return fail(`Refused (${refused.status} ${refused.code}) but without a useful message: ${JSON.stringify(refused.message)}`);
      return pass(`HTTP ${refused.status} ${refused.code}: ${refused.message}`);
    });

    // ----- 2.5 the window's remembered state ----------------------------------------------------------------------------
    const cloudUrl = 'https://claude.ai/code/ci-roundtrip';
    const chatgptUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
    const chatgptUrlPresent = (() => { try { return hasChatgptUrlField(fs.readFileSync(path.join(REPO, 'packages', 'shared', 'src', 'routes.ts'), 'utf8') + fs.readFileSync(path.join(REPO, 'packages', 'shared', 'src', 'entities.ts'), 'utf8')); } catch { return false; } })();
    await check('2.5', 'Write the window\'s remembered state (ui.route, ui.perProject cloudUrl) through settings.update', async () => {
      if (!api) return notRun('Needs the API token; see 2.1.');
      if (!ctx.projectId) return notRun('2.2 did not create a project.');
      await sleep(2000); // the renderer may write its own first-run state right after loading; let it settle first
      const perProject = { cloudUrl };
      if (chatgptUrlPresent) perProject.chatgptUrl = chatgptUrl;
      const patch = { ui: { route: { projectId: ctx.projectId, view: 'activity' }, perProject: { [ctx.projectId]: perProject } } };
      const settings = await api('PATCH', '/settings', patch);
      const mine = settings.ui?.perProject?.[ctx.projectId];
      ctx.wrote = { route: settings.ui?.route ?? null, perProject: mine ?? null };
      const lines = [`stored route ${JSON.stringify(ctx.wrote.route)}`, `stored perProject ${JSON.stringify(ctx.wrote.perProject)}`];
      if (ctx.wrote.route?.projectId !== ctx.projectId || mine?.cloudUrl !== cloudUrl) return fail('The settings answer does not echo what was written.', ...lines);
      lines.push(chatgptUrlPresent ? `chatgptUrl (per project) is declared in packages/shared; also written: ${mine?.chatgptUrl === chatgptUrl}` : 'chatgptUrl per project: NOT YET PRESENT in packages/shared (routes.ts / entities.ts); only cloudUrl was written.');
      if (chatgptUrlPresent && mine?.chatgptUrl !== chatgptUrl) return fail('chatgptUrl was declared but not stored.', ...lines);
      return pass(...lines);
    });

    // snapshot, quit, relaunch, compare
    let before = null;
    if (api && ctx.projectId) {
      try {
        before = { project: await api('GET', `/projects/${ctx.projectId}`), route: ctx.wrote?.route ?? null, perProject: ctx.wrote?.perProject ?? null };
      } catch (error) { log(`Could not take the snapshot: ${error.message}`); }
    }
    let quit1 = null;
    await check('2.6', 'Quit the app cleanly (app.quit(), no stray Mini-Summa.exe left)', async () => {
      quit1 = await quitApp(first, 'first run');
      return quit1.clean ? pass(quit1.detail) : (first.mode === 'plain' ? info(quit1.detail) : fail(quit1.detail));
    });
    copyLogs('after-quit-1');
    await sleep(2000);

    await check('2.7', 'Relaunch the same exe; the project, its folder, its associations and the remembered state are identical', async () => {
      try {
        second = first.mode === 'playwright' ? await launchWithPlaywright(exe, 'second') : await launchPlain(exe);
      } catch (error) {
        return fail(`The second launch failed: ${String(error.message).split('\n').slice(0, 12).join(' | ')}`);
      }
      if (second.mode === 'plain') {
        const db = path.join(DATA_DIR, 'mini-summa.db');
        return fs.existsSync(db) ? info(`Plain relaunch answered health; ${db} exists (${fs.statSync(db).size} bytes). Project contents could not be read without the API token.`) : fail(`${db} does not exist after a start and a restart.`);
      }
      if (!before) return notRun('No snapshot was taken before the restart (an earlier check failed).');
      const api2 = makeApi(second.conn);
      const project = await api2('GET', `/projects/${ctx.projectId}`);
      const settings = await api2('GET', '/settings');
      const after = { project, route: settings.ui?.route ?? null, perProject: settings.ui?.perProject?.[ctx.projectId] ?? null };
      const diffs = deepDiff(before, after);
      const lines = [`project ${project.id}: githubRepo ${project.githubRepo}, chatgptProject ${project.chatgptProject?.url}, roots ${JSON.stringify(project.roots.map((r) => r.path))}`, `ui.route ${JSON.stringify(after.route)}`, `ui.perProject ${JSON.stringify(after.perProject)}`];
      if (!fs.existsSync(folderDir)) lines.push('(the temp folder itself vanished from disk; that would be this script, not the app)');
      lines.push(chatgptUrlPresent ? 'chatgptUrl per project compared with the rest of perProject.' : 'chatgptUrl per project: NOT YET PRESENT in packages/shared; not compared.');
      return diffs.length ? fail('Read back differently after the restart:', ...diffs, ...lines) : pass('Everything read back identically after quit and relaunch.', ...lines);
    });
    copyLogs('after-launch-2');

    // ----- 3 environments + Claude CLI -------------------------------------------------------------------------------
    let hostEnv = null;
    await check('3', 'environments.list finds the host Windows environment; `claude --version` is reported (only if the CLI was installed by the workflow)', async () => {
      if (!second?.conn) return notRun('Needs the API token of a Playwright-driven launch; see 2.1 and 2.7.');
      const api2 = makeApi(second.conn);
      const envs = await api2('GET', '/environments?refresh=true');
      hostEnv = envs.find((e) => !String(e.id).startsWith('wsl:'));
      const lines = [`environments: ${envs.map((e) => `${e.id} (available ${e.available})`).join(', ')}`];
      if (!hostEnv) return fail('No host (non-WSL) environment is listed.', ...lines);
      lines.push(`host env id ${hostEnv.id}, available ${hostEnv.available}`, `claude.path ${hostEnv.claude?.path}, claude.version ${hostEnv.claude?.version}, claude.error ${hostEnv.claude?.error}`, `node ${hostEnv.node?.path} ${hostEnv.node?.version}`, `notes ${JSON.stringify(hostEnv.notes)}`);
      if (!hostEnv.available) return fail('The host environment is not available.', ...lines);
      const direct = run('claude', ['--version'], { shell: true, timeout: 60_000 });
      const directVersion = /\d+\.\d+\.\d+\S*/.exec(direct.stdout)?.[0] ?? null;
      state.claudeVersion = directVersion;
      if (!directVersion) return [STATUS.INFO, [...lines, `\`claude --version\` run from this script: ${direct.error ?? (direct.stderr.trim() || 'no version printed')}. The workflow's "npm install -g @anthropic-ai/claude-code" step probably failed (see its log), so whether the core reports Claude could not be checked: NOT RUN for that part. The host environment itself IS listed and available.`]];
      lines.push(`\`claude --version\` run from this script: ${directVersion}`);
      if (!hostEnv.claude?.version) return fail('PowerShell/cmd find Claude Code but the core reports no version for it.', ...lines);
      return hostEnv.claude.version.includes(directVersion) || directVersion.includes(hostEnv.claude.version) ? pass(...lines, 'Claude is unauthenticated here; only discovery and --version are covered.') : fail('Version mismatch between the core and the CLI.', ...lines);
    });

    // ----- 4 PowerShell hook behaviour (W-11) --------------------------------------------------------------------------
    await check('4.1', 'W-11 control: the installed exe as Node through Windows PowerShell, with and without `| Write-Output`', () => {
      const script = [
        "$env:ELECTRON_RUN_AS_NODE='1'",
        `$exe = '${exe.replace(/'/g, "''")}'`,
        '$bare = (Measure-Command { & $exe -e "setTimeout(()=>{},3000)" }).TotalSeconds',
        '$piped = (Measure-Command { & $exe -e "setTimeout(()=>{},3000)" | Write-Output }).TotalSeconds',
        'Write-Output ("RESULT bare={0:N3} piped={1:N3}" -f $bare, $piped)',
      ].join('; ');
      const r = ps(script, 120_000);
      const m = /RESULT bare=([\d.,]+) piped=([\d.,]+)/.exec(r.stdout);
      if (!m) return fail(`No measurement: exit ${r.code}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`);
      const bare = Number(m[1].replace(',', '.')); const piped = Number(m[2].replace(',', '.'));
      const lines = [`A 3 s child, no pipe: PowerShell returned after ${bare} s`, `A 3 s child, piped to Write-Output: PowerShell returned after ${piped} s`, `The pipe ${bare < 1.5 ? 'WAS needed (the bare call did not wait)' : 'was not needed on this machine (the bare call waited too)'}`];
      return piped >= 2.5 && piped < 10 ? pass(...lines) : fail(...lines, 'The hook command shape does not make PowerShell wait for the GUI-subsystem exe: hooks would race Claude Code.');
    });

    await check('4.2', 'W-11 end to end: hooks.plan (NOT applied) -> run the SessionStart and Stop commands through powershell.exe -> spool record exists when PowerShell returns, in under 10 s', async () => {
      if (!second?.conn || !hostEnv) return notRun('Needs the API and the host environment from check 3.');
      const api2 = makeApi(second.conn);
      const settingsBefore = fileFingerprint(claudeSettingsFile);
      const plan = await api2('POST', '/hooks/plan', { env: hostEnv.id, action: 'install' });
      const commands = extractHookCommands(plan.after, ['SessionStart', 'Stop']);
      const lines = [`plan.action ${plan.action}, settingsPath ${plan.settingsPath}`, `plan warnings: ${JSON.stringify(plan.warnings)}`];
      const missing = ['SessionStart', 'Stop'].filter((e) => !commands[e]);
      if (missing.length) return fail(`plan.after has no capture command for ${missing.join(', ')}.`, ...lines);
      const hookExe = exeFromCommand(commands.Stop.command);
      lines.push(`shell ${commands.Stop.shell}, timeout ${commands.Stop.timeout} s`, `command (Stop): ${commands.Stop.command}`, `hook exe ${hookExe}${hookExe && samePath(hookExe, exe) ? ' (the installed exe)' : ' (NOT the installed exe!)'}`);
      const spool = spoolFromCommand(commands.Stop.command);
      if (!spool) return fail('No --spool directory in the command.', ...lines);
      const watch = [spool, path.dirname(spool)];
      const problems = [];
      for (const event of ['SessionStart', 'Stop']) {
        const marker = `ms-ci-${event.toLowerCase()}-${Date.now()}`;
        const payload = { session_id: marker, transcript_path: path.join(tmpRoot, 'transcript.jsonl'), cwd: hookCwd, hook_event_name: event, ...(event === 'SessionStart' ? { source: 'startup' } : { stop_hook_active: false }) };
        let r = await runHook(commands[event].command, payload, 'Command');
        let found = findFilesContaining(watch, marker, 3);
        let late = null;
        if (!found.length) late = await pollUntil(() => { const f = findFilesContaining(watch, marker, 3); return f.length ? f : null; }, { timeoutMs: 8000, intervalMs: 100 });
        const errLog = path.join(path.dirname(spool), 'capture-errors.log');
        lines.push(`${event}: powershell exit ${r.code}, returned after ${r.ms} ms (${(r.ms / 1000).toFixed(2)} s), stdout ${JSON.stringify(r.stdout.slice(0, 120))}, stderr ${JSON.stringify(r.stderr.slice(0, 200))}`);
        if (found.length) lines.push(`${event}: spool record present at return: ${found[0]}`);
        else if (late) lines.push(`${event}: spool record appeared only AFTER PowerShell returned: ${late[0]}`);
        else lines.push(`${event}: no spool record appeared within 8 s after PowerShell returned`);
        if (!found.length) {
          problems.push(`${event}: record not there when PowerShell returned`);
          try { lines.push(`capture-errors.log: ${fs.readFileSync(errLog, 'utf8').slice(-600)}`); } catch { lines.push('capture-errors.log: none'); }
          const alt = await runHook(commands[event].command, { ...payload, session_id: `${marker}-b` }, 'EncodedCommand');
          lines.push(`${event} diagnostic with -EncodedCommand instead of -Command: exit ${alt.code}, ${alt.ms} ms, record present at return: ${findFilesContaining(watch, `${marker}-b`, 3).length > 0}`);
        }
        if (r.code !== 0) problems.push(`${event}: powershell exit code ${r.code}`);
        if (r.ms >= 10_000) problems.push(`${event}: took ${r.ms} ms (limit 10000)`);
        if (found.length) {
          try { const rec = JSON.parse(fs.readFileSync(found[0], 'utf8')); lines.push(`${event}: record schema ${rec.schema}, env_id ${rec.transport?.env_id}, hook_event_name ${rec.payload?.hook_event_name}, parse_error ${rec.transport?.parse_error}`); } catch { /* moved by the ingestor meanwhile */ }
        }
      }
      const settingsAfter = fileFingerprint(claudeSettingsFile);
      lines.push(`~/.claude/settings.json before: ${settingsBefore}; after: ${settingsAfter}`);
      if (settingsBefore !== settingsAfter) problems.push('hooks.plan changed ~/.claude/settings.json (it must not)');
      lines.push('Note: the test records go to the real spool of the running app and are ingested as an unknown observed session named ms-ci-*; nothing was installed.');
      return problems.length ? fail(...problems, ...lines) : pass(...lines);
    });

    // ----- 5 notification routing ---------------------------------------------------------------------------------------
    await check('5', 'notifications.test: Windows accepted the toast request (not seen by a human)', async () => {
      if (!second?.conn) return notRun('Needs the API token; see 2.1 and 2.7.');
      const result = await makeApi(second.conn)('POST', '/notifications/test');
      const lines = [`Returned {shown: ${result.shown}, reason: ${JSON.stringify(result.reason)}, quiet: ${result.quiet}}`, 'Windows accepted the toast request (not seen by a human). Nobody watches this runner: this does not show that a toast appeared on a screen, in a notification centre, or that a click would bring the window forward.'];
      return result.shown ? pass(...lines) : fail('The application reports it did NOT show the notification.', ...lines, 'On a Server image this can be an environment limit rather than an application bug; compare with a real PC (R7).');
    });

    // ----- 2.8 quit again --------------------------------------------------------------------------------------------------
    await check('2.8', 'Quit the second run cleanly', async () => {
      if (!second) return notRun('The second launch did not happen.');
      const q = await quitApp(second, 'second run');
      return q.clean ? pass(q.detail) : (second.mode === 'plain' ? info(q.detail) : fail(q.detail));
    });
    copyLogs('final');
  } finally {
    for (const h of [first, second]) { if (h && h.mode === 'playwright' && h.proc.exitCode === null && h.proc.signalCode === null) { try { h.proc.kill(); } catch { /* gone */ } } }
    if (appProcesses().length) { killApp(); await waitProcessesGone(20_000); }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

function fileFingerprint(file) {
  try { const b = fs.readFileSync(file); return `${b.length} bytes sha256 ${createHash('sha256').update(b).digest('hex').slice(0, 16)}`; } catch { return 'absent'; }
}

/** Run a hook command the way Claude Code's powershell shell does: `powershell.exe -NoProfile -Command <command>`, payload on stdin. */
function runHook(command, payload, mode) {
  const args = ['-NoProfile', '-NonInteractive'];
  if (mode === 'EncodedCommand') args.push('-EncodedCommand', encodePsCommand(command)); else args.push('-Command', command);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 60_000);
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - t0, stdout, stderr }); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: -1, ms: Date.now() - t0, stdout, stderr: String(error.message) }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase: uninstall (check group 6)

async function phaseUninstall() {
  const installDir = state.installDir;
  if (!installDir) {
    await check('6.0', 'Silent uninstall', () => notRun('Nothing was installed by this run (the install phase did not record an install directory).'));
    return;
  }
  const left = appProcesses();
  if (left.length) { log(`Stopping ${left.length} ${EXE_NAME} process(es) before uninstalling`); killApp(); await waitProcessesGone(30_000); }
  const dbBefore = path.join(DATA_DIR, 'mini-summa.db');
  const dataBefore = fs.existsSync(dbBefore);
  copyLogs('before-uninstall');

  const uninstaller = fs.existsSync(path.join(installDir, `Uninstall ${PRODUCT}.exe`)) ? path.join(installDir, `Uninstall ${PRODUCT}.exe`) : (safeList(installDir).find((n) => /^uninstall.*\.exe$/i.test(n)) ? path.join(installDir, safeList(installDir).find((n) => /^uninstall.*\.exe$/i.test(n))) : path.join(installDir, `Uninstall ${PRODUCT}.exe`));
  await check('6.1', 'Silent uninstall (the QuietUninstallString Windows registered: Uninstall Mini-Summa.exe /currentuser /S), waited for, then polled', async () => {
    if (!fs.existsSync(uninstaller)) return fail(`${uninstaller} does not exist. Installed files: ${safeList(installDir).join(', ')}`);
    const t0 = Date.now();
    // '/currentuser /S' is exactly what the installer registered as QuietUninstallString (first native run: a bare '/S' on an administrator
    // account looked in the all-users hive and left the per-user uninstall entry behind, which is a way of calling it, not a product defect).
    const child = spawn(uninstaller, ['/currentuser', '/S'], { stdio: 'ignore', windowsHide: true });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 180_000);
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code }); });
      child.once('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
    });
    if (exit.error) return fail(`The uninstaller could not be started: ${exit.error}`);
    // NSIS uninstallers copy themselves to %TEMP% and relaunch, so the first process may return before the work is done: poll.
    const gone = await pollUntil(() => !fs.existsSync(installDir), { timeoutMs: 120_000, intervalMs: 1000 });
    const detail = `uninstaller process: ${exit.timeout ? 'did not exit in 180 s' : `exit code ${exit.code}`}; install dir ${gone ? 'gone' : 'STILL THERE'} after ${Date.now() - t0} ms`;
    if (exit.timeout) { try { child.kill(); } catch { /* gone */ } }
    return gone && !exit.timeout && (exit.code === 0) ? pass(detail) : fail(detail, `remaining: ${fs.existsSync(installDir) ? safeList(installDir).join(', ') : 'n/a'}`);
  });
  await check('6.2', 'Install directory is gone', () => fs.existsSync(installDir) ? fail(`${installDir} still exists: ${safeList(installDir).join(', ')}`) : pass(`${installDir} removed`));
  await check('6.3', 'minisumma:// protocol key is removed', () => regFound('HKCU\\Software\\Classes\\minisumma') ? fail('HKCU\\Software\\Classes\\minisumma still exists.') : pass('HKCU\\Software\\Classes\\minisumma is gone'));
  await check('6.4', 'Uninstall entry is removed', () => {
    const r = run('reg.exe', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', PRODUCT, '/d']);
    return r.code === 0 ? fail(`An uninstall entry for ${PRODUCT} remains:\n${r.stdout.trim().slice(0, 500)}`) : pass('No HKCU uninstall entry for Mini-Summa remains');
  });
  await check('6.5', 'User data in %APPDATA%\\Mini-Summa is KEPT (deleteAppDataOnUninstall is false)', () => {
    const db = path.join(DATA_DIR, 'mini-summa.db');
    if (!dataBefore) return fail(`${db} did not exist even before the uninstall, so "kept" cannot be shown. Did the app ever start?`);
    return fs.existsSync(db) ? pass(`${db} still exists (${fs.statSync(db).size} bytes); ${USER_DIR} holds: ${safeList(USER_DIR).join(', ')}`) : fail(`${db} was deleted by the uninstaller.`);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Phase: report

function phaseReport() {
  const sha = env.GITHUB_SHA ?? null;
  const runUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const meta = {
    commit: sha, ref: env.GITHUB_REF ?? null, run: runUrl, 'runner image': env.ImageOS ? `${env.ImageOS} ${env.ImageVersion ?? ''}`.trim() : null,
    'windows build': os.release(), node: process.version, installer: state.installer ? path.basename(state.installer) : null,
    'installed exe': state.exe ?? null, 'claude code (npm, unauthenticated)': state.claudeVersion ?? 'not installed or not found',
  };
  const md = renderReport({ results, meta });
  const file = path.join(OUT, 'windows-installed-report.md');
  fs.writeFileSync(file, md);
  console.log(md);
  if (env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${md}\n`); } catch (error) { log(`Could not append to the step summary: ${error.message}`); } }
  log(`Report written to ${file}`);
}

// ---------------------------------------------------------------------------------------------------------------------------

async function main() {
  if (phase === 'help' || phase === '--help') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
    return 0;
  }
  if (process.platform !== 'win32' && phase !== 'report') {
    console.error('installed-smoke.mjs checks the installed Windows application and only runs on Windows.');
    return 2;
  }
  const phases = phase === 'all' ? ['install', 'smoke', 'uninstall', 'report'] : [phase];
  for (const p of phases) {
    PHASE_TAG = p;
    results.items = results.items.filter((i) => i.phase !== p); // a re-run replaces that phase's earlier results
    log(`=== phase ${p} ===`);
    if (p === 'install') await phaseInstall();
    else if (p === 'smoke') await phaseSmoke();
    else if (p === 'uninstall') await phaseUninstall();
    else if (p === 'report') phaseReport();
    else { console.error(`Unknown phase: ${p}`); return 2; }
  }
  saveAll();
  const bad = phases.flatMap((p) => results.failures(p));
  if (bad.length) { console.error(`\n${bad.length} check(s) FAILED: ${bad.map((b) => b.id).join(', ')}`); return 1; }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error('installed-smoke crashed:', error);
  try { results.add(PHASE_TAG, 'crash', 'The script itself crashed', STATUS.FAIL, [String(error?.stack ?? error)]); saveAll(); } catch { /* nothing more to do */ }
  process.exitCode = 1;
});
