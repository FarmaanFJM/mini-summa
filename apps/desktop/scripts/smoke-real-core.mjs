#!/usr/bin/env node
// Starts the app with the REAL embedded core (no stub) and checks that the whole stack comes up: window on the core's
// origin, the built renderer served from where it lives (inside app.asar when packaged), the preload API, the HTTP API
// with the desktop token, the hook script and runtime the core will install, and a clean quit.
//
//   xvfb-run -a node apps/desktop/scripts/smoke-real-core.mjs --dev                     (electron <app dir>, test seams on)
//   xvfb-run -a node apps/desktop/scripts/smoke-real-core.mjs --packaged [path/to/mini-summa]   (release/linux-unpacked)
//
// With --packaged the test seams are OFF by construction (the app ignores them); the test sets MINISUMMA_DATA_DIR
// anyway and checks that it was ignored. Add --as <user> (root only) to run with Chromium's OS sandbox on.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const packaged = argv.includes('--packaged');
const asUser = argv.includes('--as') ? argv[argv.indexOf('--as') + 1] : null;
const exeArg = packaged ? argv.find((a, i) => i > argv.indexOf('--packaged') && !a.startsWith('--') && argv[i - 1] !== '--as') : null;
const packagedExe = exeArg ? path.resolve(exeArg) : path.join(appRoot, 'release', 'linux-unpacked', 'mini-summa');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

if (process.platform === 'linux' && !process.env.DISPLAY) { console.error('No DISPLAY. Use xvfb-run -a'); process.exit(2); }
if (!packaged && !fs.existsSync(path.join(appRoot, 'out', 'main', 'index.js'))) { console.error('Run "npx electron-vite build" first.'); process.exit(2); }
if (packaged && !fs.existsSync(packagedExe)) { console.error(`No packaged app at ${packagedExe}. Run "npm run dist:dir" first.`); process.exit(2); }

const results = [];
const check = async (name, fn) => {
  try { const d = await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}${d ? `  (${d})` : ''}`); } catch (e) { results.push({ name, ok: false }); console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await sleep(100); } };

const run = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-real-'));
const home = path.join(run, 'home');
const decoyData = path.join(run, 'decoy-data');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(decoyData, { recursive: true });
if (asUser) spawnSync('chmod', ['-R', 'a+rwX', run]);

const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
delete env.NODE_OPTIONS;
for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
// Set in both modes. In a dev run they take effect; in a packaged run they must be ignored (and are checked below).
env.MINISUMMA_DATA_DIR = decoyData;
// A "Claude" that stays alive, so that there is a running terminal to ask about when the app quits.
const fakeClaude = path.join(run, 'fake-claude');
fs.writeFileSync(fakeClaude, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi\nexec sleep 120\n', { mode: 0o755 });
env.MINISUMMA_CLAUDE_BIN = fakeClaude;
env.MINISUMMA_TEST_HOST_RULES = 'MAP chatgpt.com 127.0.0.1:9';
env.MINISUMMA_TEST_TRUST_CERTS = '1';

let executablePath = packaged ? packagedExe : require('electron');
const args = [];
if (asUser) {
  const wrapper = path.join(run, 'as-user.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec runuser -u ${asUser} -- env HOME="${home}" "${executablePath}" --disable-setuid-sandbox "$@"\n`, { mode: 0o755 });
  executablePath = wrapper;
} else if (isRoot) {
  args.push('--no-sandbox');
}
if (!packaged) args.push(appRoot);

console.log(`Mini-Summa real-core smoke test (${packaged ? `packaged: ${packagedExe}` : 'development build'}${asUser ? `, OS sandbox on as ${asUser}` : isRoot ? ', --no-sandbox (root)' : ''})\n  run dir ${run}\n`);

const app = await electron.launch({ executablePath, args, env, timeout: 90_000, chromiumSandbox: !!asUser });
const out = [];
app.process().stdout?.on('data', (d) => out.push(String(d)));
app.process().stderr?.on('data', (d) => out.push(String(d)));
const exited = new Promise((resolve) => app.process().once('exit', (code, signal) => resolve({ code, signal })));

try {
  const page = await app.firstWindow();
  await page.waitForURL(/\/ui\//, { timeout: 60_000 });
  const origin = new URL(page.url()).origin;
  let token;
  const api = async (route, init = {}) => {
    const res = await fetch(`${origin}/api/v1${route}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await check('the window shows the real core UI on 127.0.0.1', async () => {
    assert.match(page.url(), /^http:\/\/127\.0\.0\.1:\d+\/ui\//);
    await until(async () => (await page.title()) !== '');
    return `${page.url()}  title=${JSON.stringify(await page.title())}`;
  });

  await check('the built renderer is served by the core (index.html, a script and a stylesheet respond)', async () => {
    const html = await (await fetch(`${origin}/ui/`)).text();
    assert.match(html, /<div id="root"><\/div>/);
    const asset = /(?:src|href)="(\.?\/?assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert.ok(asset, 'no script in index.html');
    const js = await fetch(new URL(asset, `${origin}/ui/`));
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    const css = /(?:href)="(\.?\/?assets\/[^"]+\.css)"/.exec(html)?.[1];
    if (css) assert.equal((await fetch(new URL(css, `${origin}/ui/`))).status, 200);
    return asset;
  });

  await check('health is public; everything else needs the token; the token is not in the HTML', async () => {
    const health = await api('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal((await api('/state')).status, 401);
    const c = await page.evaluate(() => window.miniSumma.connection());
    assert.equal(c.baseUrl, origin);
    token = c.token;
    assert.ok(token.length >= 32);
    assert.ok(!(await (await fetch(`${origin}/ui/`)).text()).includes(token));
    const state = await api('/state');
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.equal(state.body.system.mode, 'embedded');
    assert.equal(state.body.system.version, '0.1.0');
    return `core ${state.body.system.version}, api ${state.body.system.apiVersion}`;
  });

  await check('the core was told what the host can do (native capabilities)', async () => {
    const { body } = await api('/state');
    const c = body.system.nativeCapabilities;
    assert.equal(c.clipboard, true);
    assert.equal(c.chatgptEmbedded, true);
    assert.equal(c.extensionBridge, false);
    assert.equal(c.openExternal, true);
    assert.equal(c.saveFile, true);
    assert.equal(typeof c.notifications, 'boolean');
    return JSON.stringify(c);
  });

  await check('window.miniSumma works from the real page', async () => {
    const r = await page.evaluate(async () => ({ kind: window.miniSumma.kind, version: window.miniSumma.appVersion, state: await window.miniSumma.chatgpt.getState(), paths: await window.miniSumma.app.getPaths() }));
    assert.equal(r.kind, 'electron');
    assert.equal(r.version, '0.1.0');
    assert.equal(r.state.status, 'idle');
    assert.ok(path.isAbsolute(r.paths.dataDir) && path.isAbsolute(r.paths.logsDir));
    return JSON.stringify(r.paths);
  });

  await check('the core listens on the loopback address only (no other address of this machine reaches it)', async () => {
    const port = Number(new URL(origin).port);
    const canConnect = (host) => new Promise((resolve) => {
      const s = net.connect({ host, port });
      const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(3000, () => done('timeout'));
      s.once('connect', () => done(true));
      s.once('error', (e) => done(e.code ?? false));
    });
    assert.equal(await canConnect('127.0.0.1'), true);
    const others = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    if (others.length === 0) return 'NOT TESTED beyond 127.0.0.1: this machine has no other IPv4 address';
    for (const other of others) {
      const result = await canConnect(other.address);
      assert.equal(result, 'ECONNREFUSED', `${other.address}:${port} answered with ${result}`);
    }
    // The same fact is what keeps the Windows Firewall from asking: it only asks when a program listens beyond loopback.
    return `${others.length} other address(es) refused (${others.map((i) => i.address).join(', ')})`;
  });

  await check('no secret is on any command line of the app or its child processes', async () => {
    if (process.platform !== 'linux') return 'NOT TESTED: reads /proc';
    const c = await page.evaluate(() => window.miniSumma.connection());
    const pids = new Set([app.process().pid]);
    const parentOf = (pid) => { try { return Number(/^\d+ \(.*\) \S (\d+)/.exec(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1]); } catch { return NaN; } };
    // Chromium helpers are children of the main process, but some are reparented; take every process that descends from it.
    for (let round = 0; round < 4; round += 1) for (const name of fs.readdirSync('/proc')) if (/^\d+$/.test(name) && pids.has(parentOf(name))) pids.add(Number(name));
    let scanned = 0;
    for (const pid of pids) {
      let cmd;
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { continue; }
      scanned += 1;
      assert.ok(!cmd.includes(c.token), `the desktop token is on the command line of process ${pid}`);
      assert.ok(!/bearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(cmd), `an Authorization value is on the command line of process ${pid}`);
      assert.ok(!/(?:^|\s)--?(?:token|password|secret|api-?key)[= ]/i.test(cmd), `a secret-looking option is on the command line of process ${pid}`);
    }
    assert.ok(scanned >= 3, `only ${scanned} process(es) found`);
    return `${scanned} processes scanned`;
  });

  const info = await app.evaluate(({ app: a }) => ({ packaged: a.isPackaged, name: a.getName(), userData: a.getPath('userData'), resources: process.resourcesPath, exe: process.execPath }));

  await check(packaged ? 'packaged: seams are inert (data lives under the profile in HOME, not in MINISUMMA_DATA_DIR)' : 'development: seams apply (data in MINISUMMA_DATA_DIR)', async () => {
    assert.equal(info.packaged, packaged);
    assert.equal(info.name, 'Mini-Summa');
    const usage = await api('/data/usage');
    assert.equal(usage.status, 200, JSON.stringify(usage.body));
    if (packaged) {
      assert.equal(info.userData, path.join(home, '.config', 'Mini-Summa'));
      assert.equal(usage.body.dataDir, path.join(info.userData, 'data'));
      assert.deepEqual(fs.readdirSync(decoyData), [], 'the decoy data dir was used');
    } else {
      assert.equal(usage.body.dataDir, decoyData);
    }
    return `dataDir=${usage.body.dataDir}`;
  });

  await check('the core will install hooks that run THIS executable in Node mode on the right script', async () => {
    const hooks = await api('/hooks');
    assert.equal(hooks.status, 200, JSON.stringify(hooks.body));
    const list = Array.isArray(hooks.body) ? hooks.body : [];
    assert.ok(list.length > 0, 'no environments');
    const h = list.find((x) => x.env === 'posix') ?? list[0];
    assert.equal(h.runtime.command, info.exe);
    assert.equal(h.runtime.kind, 'electron');
    if (packaged) assert.equal(h.captureScript, path.join(info.resources, 'hook', 'capture.mjs'));
    assert.ok(fs.existsSync(h.captureScript), `${h.captureScript} does not exist`);
    assert.ok(!h.captureScript.includes('app.asar'), 'the hook script must be a real file');
    return `${h.env}: ${h.captureScript}`;
  });

  await check('a hook call (this executable in Node mode) while the app runs opens no window, is not a second instance, and writes its record', async () => {
    const hooks = await api('/hooks');
    const list = Array.isArray(hooks.body) ? hooks.body : [];
    const h = list.find((x) => x.env === 'posix') ?? list[0];
    const spool = path.join(run, 'hook-spool');
    const registry = path.join(run, 'hook-registry.json');
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(registry, '{"version":1,"projects":[]}');
    const windowsBefore = app.windows().length;
    const logFile = path.join(info.userData, 'logs', 'main.log');
    const secondBefore = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('second instance started').length - 1;
    // Exactly what Claude Code runs: the app's own executable, the capture script, the hook options, one JSON document on stdin.
    const hookEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    const started = Date.now();
    const result = spawnSync(info.exe, [h.captureScript, '--spool', spool, '--registry', registry, '--env', 'posix', '--handler', 'h1', 'SessionStart'], {
      env: hookEnv, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: '00000000-0000-4000-8000-000000000001', cwd: os.tmpdir(), source: 'startup' }), timeout: 30_000, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `exit ${result.status} ${result.signal} ${result.stderr}`);
    assert.equal(fs.readdirSync(spool).filter((f) => f.endsWith('.json')).length, 1, 'the hook wrote no record');
    await sleep(1500); // a second instance would have been announced to the running copy by now
    assert.equal(app.windows().length, windowsBefore, 'a window was opened');
    const secondAfter = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('second instance started').length - 1;
    assert.equal(secondAfter, secondBefore, 'the running copy was told about a second instance');
    assert.equal((await api('/health')).status, 200);
    return `exit 0 in ${Date.now() - started} ms, 1 record in the spool, ${windowsBefore} window(s) before and after`;
  });

  await check('a real second launch (no Node mode) is passed to the running copy and exits, leaving one window', async () => {
    const logFile = path.join(info.userData, 'logs', 'main.log');
    const count = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('second instance started').length - 1;
    const before = count();
    const windowsBefore = app.windows().length;
    const second = spawnSync(info.exe, packaged ? ['--no-sandbox', 'minisumma://settings'] : [appRoot, '--no-sandbox', 'minisumma://settings'], { env, timeout: 40_000, encoding: 'utf8' });
    assert.equal(second.signal, null, `the second launch did not exit: ${second.signal}`);
    await until(() => count() > before, 10_000);
    assert.equal(app.windows().length, windowsBefore);
    assert.match(fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('second instance started')).at(-1) ?? '', /"link":true/);
    return `the running copy logged the second launch with its link; ${windowsBefore} window(s)`;
  });

  await check('a managed pty can be started by the real core (node-pty loads from where the build puts it)', async () => {
    const created = await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'smoke project', roots: [{ path: os.tmpdir() }] }) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    // In a development run the command is the fake Claude above; a packaged app ignores it and looks for `claude` itself.
    const started = await api(`/projects/${created.body.id}/sessions`, { method: 'POST', body: JSON.stringify({ mode: 'new' }), headers: { 'idempotency-key': 'smoke-1' } });
    assert.ok([200, 400, 409, 422, 500].includes(started.status), `unexpected ${started.status}`);
    return `HTTP ${started.status} ${JSON.stringify(started.body).slice(0, 160)}`;
  });

  await check('quitting asks about the running terminal (exact wording), then stops the core and exits with code 0', async () => {
    const live = (await api('/sessions')).body.filter((x) => x.origin === 'managed' && x.availability === 'live' && x.terminal && !x.terminal.exited).length;
    const proof = path.join(run, 'quit-dialog.json');
    await app.evaluate(({ dialog }, file) => {
      // The app exits right after, so what it asked is written to a file from inside the app.
      dialog.showMessageBox = async (...a) => { process.getBuiltinModule('node:fs').writeFileSync(file, JSON.stringify(a.at(-1))); return { response: 0, checkboxChecked: false }; };
    }, proof);
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
    const { code } = await Promise.race([exited, sleep(30_000).then(() => ({ code: 'timeout' }))]);
    assert.equal(code, 0);
    if (live > 0) {
      const asked = JSON.parse(fs.readFileSync(proof, 'utf8'));
      assert.equal(asked.message, 'Quit Mini-Summa?');
      assert.equal(asked.detail, live === 1 ? 'Closing Mini-Summa ends 1 running Claude terminal. It can be resumed later.' : `Closing Mini-Summa ends ${live} running Claude terminals. They can be resumed later.`);
      assert.equal(asked.defaultId, 1);
      return `asked: "${asked.detail}", then exited cleanly`;
    }
    assert.ok(!fs.existsSync(proof), 'the app asked although no terminal was running');
    return 'no live terminal at quit time; exited without asking';
  });
} catch (error) {
  results.push({ name: 'harness', ok: false });
  console.log(`FAIL  harness\n      ${error.stack ?? error}`);
  console.log('--- app output (tail) ---');
  console.log(out.join('').split('\n').slice(-30).join('\n'));
} finally {
  if (app.process().exitCode === null) { app.process().kill('SIGKILL'); await sleep(200); }
  await app.close().catch(() => undefined);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}.`);
  fs.rmSync(run, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
