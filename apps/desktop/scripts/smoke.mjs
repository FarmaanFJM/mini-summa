#!/usr/bin/env node
// Real-Electron smoke test for the main process, the preload and the embedded ChatGPT view.
//
//   npx electron-vite build            (once; builds out/main and out/preload, and the renderer when it exists)
//   xvfb-run -a node apps/desktop/scripts/smoke.mjs [--as nobody] [--keep]
//
// What runs for real: the built Electron app (out/main/index.js + out/preload/index.cjs) launched through Playwright's
// _electron, the real window, preload, IPC, navigation policy, permission handlers, the real WebContentsView with its
// persistent partition, notifications, quit flow, single-instance forwarding and window-state persistence.
// What is stood in: the core (scripts/smoke-stub-core.mjs, via the MINISUMMA_CORE_MODULE seam) and the ChatGPT site,
// which is a local HTTPS server reached through the test-only MINISUMMA_TEST_HOST_RULES / MINISUMMA_TEST_TRUST_CERTS
// seams, so the app still sees https://chatgpt.com/... addresses and applies its real policy to them. The real
// chatgpt.com is never contacted: every host the app could reach is mapped to loopback or is an `.invalid` name.
//
// --as <user>  (root only) runs Electron as that user with Chromium's user-namespace sandbox ON. Without it, a root
//              run has to pass --no-sandbox, and the report says so. The other user must be able to reach the X server:
//              xvfb-run -a -s "-ac" node apps/desktop/scripts/smoke.mjs --as nobody
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { makeSelfSigned } from './lib/selfsigned.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const mainJs = path.join(appRoot, 'out', 'main', 'index.js');
const preloadCjs = path.join(appRoot, 'out', 'preload', 'index.cjs');
const stubCore = path.join(here, 'smoke-stub-core.mjs');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const asUser = argv.includes('--as') ? argv[argv.indexOf('--as') + 1] : null;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

if (process.platform === 'linux' && !process.env.DISPLAY) {
  console.error('No DISPLAY. Run it as: xvfb-run -a node apps/desktop/scripts/smoke.mjs');
  process.exit(2);
}
for (const f of [mainJs, preloadCjs]) {
  if (!fs.existsSync(f)) { console.error(`Missing ${f}. Run "npx electron-vite build" in apps/desktop first.`); process.exit(2); }
}

// ---------------------------------------------------------------------------------------------------------------
// Harness

const results = [];
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms)),
]);
let diagnostics = async () => '';
async function check(name, fn, ms = 40_000) {
  const t0 = Date.now();
  try {
    const detail = await withTimeout(Promise.resolve().then(fn), ms, name);
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}  [${Date.now() - t0} ms]`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAIL  ${name}\n      ${String(error.message).split('\n').join('\n      ')}`);
    const extra = await diagnostics().catch(() => '');
    if (extra) console.log(`      recent web contents events: ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(step);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in for chatgpt.com (HTTPS, self-signed, reached only through the host-resolver rules)

const HOSTS = ['chatgpt.com', 'auth.openai.com', 'accounts.google.com'];
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ID = { ok: uuid(1), other: uuid(2), login: uuid(3), challenge: uuid(4), external: uuid(5), fail: uuid(6), late: uuid(7), cookie: uuid(8) };
const conv = (id) => `https://chatgpt.com/c/${id}`;
const hits = new Map();

function startStandIn() {
  const { key, cert } = makeSelfSigned(HOSTS);
  const page = (title, body = '', headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>` });
  const okBody = `<div style="height:3000px"><textarea id="composer"></textarea>
    <a id="ext" href="https://outside.invalid/clicked">ext</a>
    <a id="blank" target="_blank" href="https://outside.invalid/blank">blank</a>
    <a id="self" target="_blank" href="${conv(ID.other)}">self</a>
    <a id="http" href="http://chatgpt.com/insecure">http</a></div>`;
  const server = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0];
    const url = new URL(req.url ?? '/', `https://${host}`);
    hits.set(`${host}${url.pathname}`, (hits.get(`${host}${url.pathname}`) ?? 0) + 1);
    let r = { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
    if (host === 'auth.openai.com' && url.pathname === '/log-in') r = page('Log in');
    else if (host === 'accounts.google.com' && url.pathname === '/v3/signin/rejected') r = page('Sign in');
    else if (host === 'chatgpt.com') {
      if (url.pathname === '/') r = page('ChatGPT');
      else if (url.pathname === `/c/${ID.ok}`) r = page('Stand-in conversation', okBody);
      else if (url.pathname === `/c/${ID.other}`) r = page('Other conversation');
      else if (url.pathname === `/c/${ID.login}`) r = { status: 302, headers: { location: 'https://auth.openai.com/log-in' }, body: '' };
      else if (url.pathname === `/c/${ID.challenge}`) r = page('Just a moment...');
      else if (url.pathname === `/c/${ID.external}`) r = { status: 302, headers: { location: 'https://redirect-target.invalid/landing' }, body: '' };
      else if (url.pathname === `/c/${ID.fail}`) { req.socket.destroy(); return; }
      else if (url.pathname === `/c/${ID.late}`) r = page('Late redirect', '<script>setTimeout(function(){location.replace("https://auth.openai.com/log-in")},150)</script>');
      else if (url.pathname === `/c/${ID.cookie}`) r = page('Cookie page', '', { 'set-cookie': 'ms_standin_login=yes; Max-Age=3600; Path=/; Secure; SameSite=Lax' });
    }
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------------------------------------------------------------------------------------------------------------
// Launching the app

const run = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-smoke-'));
const dataDir = path.join(run, 'data');
const profileDir = path.join(dataDir, 'electron-profile');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(run, 'home'), { recursive: true });
if (asUser) {
  if (!isRoot) { console.error('--as needs root'); process.exit(2); }
  spawnSync('chmod', ['-R', 'a+rwX', run]);
}
const fakeClaude = path.join(run, 'fake-claude');
fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

let executablePath = electronBinary;
const sandboxArgs = [];
let sandboxMode;
if (asUser) {
  // Chromium's own sandbox (user namespaces) stays ON; only the SUID helper, which a container cannot provide, is skipped.
  executablePath = path.join(run, 'electron-as-user.sh');
  fs.writeFileSync(executablePath, `#!/bin/sh\nexec runuser -u ${asUser} -- env HOME="${path.join(run, 'home')}" "${electronBinary}" --disable-setuid-sandbox "$@"\n`, { mode: 0o755 });
  sandboxMode = `Chromium OS sandbox ON (running as ${asUser}, user-namespace sandbox)`;
} else if (isRoot) {
  sandboxArgs.push('--no-sandbox');
  sandboxMode = 'Chromium OS sandbox OFF (--no-sandbox: root in a container); webPreferences.sandbox is still true';
} else {
  sandboxMode = 'Chromium OS sandbox default';
}

const standIn = await startStandIn();
// Every host the app could reach is mapped to the stand-in or fails to resolve; loopback (the stub core) is excluded.
const hostRules = [...HOSTS.map((h) => `MAP ${h} 127.0.0.1:${standIn.port}`), 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost'].join(', ');

function appEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // Electron rejects --use-openssl-ca
  // Chromium follows proxy variables on Linux. Point them at a closed port: if the app ever sent a request through a
  // proxy instead of resolving it with the host rules, it would fail here instead of reaching a real site.
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
  const deadProxy = 'http://127.0.0.1:9';
  return {
    ...env,
    http_proxy: deadProxy, https_proxy: deadProxy, HTTP_PROXY: deadProxy, HTTPS_PROXY: deadProxy, ALL_PROXY: deadProxy,
    MINISUMMA_CORE_MODULE: stubCore,
    MINISUMMA_DATA_DIR: dataDir,
    MINISUMMA_CLAUDE_BIN: fakeClaude,
    MINISUMMA_TEST_HOST_RULES: hostRules,
    MINISUMMA_TEST_TRUST_CERTS: '1',
    ...extra,
  };
}

async function launch(extra, extraArgs = []) {
  // Launched like `electron .`: the app directory, so Electron reads package.json (name, version) as it does for a developer.
  // Playwright adds --no-sandbox itself unless chromiumSandbox is true.
  const app = await electron.launch({ executablePath, args: [...sandboxArgs, appRoot, ...extraArgs], env: appEnv(extra), timeout: 60_000, chromiumSandbox: !!asUser });
  const out = [];
  app.process().stdout?.on('data', (d) => out.push(String(d)));
  app.process().stderr?.on('data', (d) => out.push(String(d)));
  const exited = new Promise((resolve) => app.process().once('exit', (code, signal) => resolve({ code, signal })));
  const page = await app.firstWindow();
  await page.waitForURL(/\/ui\/$/, { timeout: 30_000 });
  return { app, page, out, exited };
}

// Helpers that run in the main process of the app under test.
const mainWindowInfo = (app) => app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows?.has(w.id));
  return { id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds(), contentSize: win.getContentSize() };
});
const viewProbe = (app) => app.evaluate(({ BrowserWindow, session }) => {
  const win = BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows?.has(w.id));
  const view = win.contentView.children.find((c) => c.webContents);
  if (!view) return null;
  const wc = view.webContents;
  const prefs = wc.getLastWebPreferences();
  return {
    id: wc.id, url: wc.getURL(), title: wc.getTitle(), bounds: view.getBounds(), visible: view.getVisible(), focused: wc.isFocused(),
    inChatGptPartition: wc.session === session.fromPartition('persist:chatgpt'), inDefaultSession: wc.session === session.defaultSession,
    storagePath: wc.session.storagePath,
    prefs: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity, webviewTag: prefs.webviewTag, hasPreload: !!prefs.preload },
    userAgent: wc.getUserAgent(), defaultUserAgent: session.fromPartition('persist:chatgpt').getUserAgent(),
  };
});
const inView = (app, code) => app.evaluate(({ BrowserWindow }, source) => {
  const win = BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows?.has(w.id));
  const view = win.contentView.children.find((c) => c.webContents);
  return view.webContents.executeJavaScript(source, true);
}, code);
const opened = (app) => app.evaluate(() => globalThis.__opened.slice());
const stub = async (core, route, body) => {
  const res = await fetch(`${core}${route}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return res.json();
};

// ---------------------------------------------------------------------------------------------------------------
// The checks

console.log(`Mini-Summa smoke test\n  electron ${require('electron/package.json').version} | ${sandboxMode}\n  run dir ${run}\n  stand-in for chatgpt.com on https://127.0.0.1:${standIn.port} (host rules: ${hostRules})\n`);

const first = await launch();
const { app, page } = first;
const core = new URL(page.url()).origin;
let nativeApiShape;

try {
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__opened = [];
    globalThis.__dialogs = [];
    globalThis.__dialogAnswer = 1;
    globalThis.__folder = [];
    globalThis.__testWindows = new Set();
    shell.openExternal = async (u) => { globalThis.__opened.push(u); };
    shell.showItemInFolder = (p) => { globalThis.__folder.push(p); };
    dialog.showMessageBox = async (...a) => { const o = a.at(-1); globalThis.__dialogs.push({ withWindow: a.length > 1, ...o }); return { response: globalThis.__dialogAnswer, checkboxChecked: false }; };
    dialog.showOpenDialog = async (...a) => { globalThis.__openDialog = a.at(-1); return { canceled: false, filePaths: ['/picked/dir'] }; };
    dialog.showSaveDialog = async (...a) => { globalThis.__saveDialog = a.at(-1); return { canceled: false, filePath: `${globalThis.__saveDir}/saved-report.md` }; };
  });
  await app.evaluate((_e, dir) => { globalThis.__saveDir = dir; }, run);
  // Keep a short trail of web contents events, printed when a check fails.
  await app.evaluate(({ app: a }) => {
    globalThis.__events = [];
    a.on('web-contents-created', (_e, wc) => {
      for (const ev of ['did-start-loading', 'did-stop-loading', 'did-finish-load', 'did-fail-load', 'did-navigate', 'will-redirect', 'will-navigate']) {
        wc.on(ev, (_x, ...args) => { globalThis.__events.push(`${wc.id}:${ev}${typeof args[0] === 'string' ? ` ${args[0].slice(0, 60)}` : ''}`); if (globalThis.__events.length > 60) globalThis.__events.shift(); });
      }
    });
  });
  diagnostics = async () => (await app.evaluate(() => globalThis.__events.slice(-25))).join(' | ');

  // ---- window, identity, options --------------------------------------------------------------------------------

  await check('window opens on the core origin under /ui/', async () => {
    const w = await mainWindowInfo(app);
    assert.match(w.url, /^http:\/\/127\.0\.0\.1:\d+\/ui\/$/);
    assert.equal(await page.title(), 'Mini-Summa stub core');
    assert.equal(w.visible, true);
    return w.url;
  });

  await check('app identity: name, profile and data directories', async () => {
    const id = await app.evaluate(({ app: a }) => ({ name: a.getName(), userData: a.getPath('userData'), logs: a.getPath('logs'), packaged: a.isPackaged, version: a.getVersion() }));
    assert.equal(id.name, 'Mini-Summa');
    assert.equal(id.userData, profileDir);
    assert.equal(id.logs, path.join(profileDir, 'logs'));
    assert.equal(id.packaged, false);
    return `userData=${id.userData}`;
  });

  await check('host rules are paired with --no-proxy-server, so nothing is sent through a proxy by name (the environment here points at a dead one)', async () => {
    const r = await app.evaluate(async ({ app: a, session }) => ({
      noProxy: a.commandLine.hasSwitch('no-proxy-server'),
      rules: a.commandLine.getSwitchValue('host-resolver-rules'),
      chatgpt: await session.fromPartition('persist:chatgpt').resolveProxy('https://chatgpt.com/'),
      other: await session.defaultSession.resolveProxy('https://example.org/'),
      env: process.env.https_proxy,
    }));
    assert.equal(r.noProxy, true);
    assert.equal(r.chatgpt, 'DIRECT');
    assert.equal(r.other, 'DIRECT');
    assert.equal(r.env, 'http://127.0.0.1:9');
    assert.ok(r.rules.startsWith('MAP chatgpt.com 127.0.0.1:'), r.rules);
    assert.ok(r.rules.includes('MAP * ~NOTFOUND'));
  });

  await check('createCore got the right options (data dir, embedded mode, runtime, fake Claude, UI dir)', async () => {
    const o = await (await fetch(`${core}/__test/options`)).json();
    assert.equal(o.dataDir, dataDir);
    assert.equal(o.mode, 'embedded');
    assert.equal(o.port, 0);
    assert.equal(o.hasNative, true);
    assert.equal(o.hasLog, false, 'the core must use its own logger, not the main process one');
    assert.equal(o.uiDir, path.join(appRoot, 'out', 'renderer'));
    assert.equal(o.overrides.claudeBin, fakeClaude);
    assert.deepEqual(o.overrides.nodeRuntime, { command: electronBinary, runAsNode: true });
    assert.equal(o.overrides.captureScript, undefined);
    assert.deepEqual(Object.keys(o.capabilities).sort(), ['chatgptEmbedded', 'clipboard', 'extensionBridge', 'notifications', 'openExternal', 'saveFile']);
    assert.equal(o.capabilities.clipboard, true);
    assert.equal(o.capabilities.chatgptEmbedded, true);
    assert.equal(o.capabilities.extensionBridge, false);
    assert.equal(o.capabilities.openExternal, true);
    assert.equal(o.capabilities.saveFile, true);
    return `notifications capability=${o.capabilities.notifications}`;
  });

  // ---- preload ---------------------------------------------------------------------------------------------------

  await check('window.miniSumma exists with the NativeApi shape', async () => {
    nativeApiShape = await page.evaluate(() => {
      const api = window.miniSumma;
      const shape = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, typeof o[k] === 'object' && o[k] !== null ? shape(o[k]) : typeof o[k]]));
      return { shape: shape(api), frozen: Object.isFrozen(api), kind: api.kind, platform: api.platform, version: api.appVersion, leaks: ['ipcRenderer', 'require', 'process', 'electron'].filter((k) => k in window || k in api) };
    });
    assert.deepEqual(nativeApiShape.shape, {
      app: { getPaths: 'function', onNavigate: 'function', setBadgeCount: 'function' },
      appVersion: 'string',
      chatgpt: { back: 'function', focus: 'function', forward: 'function', getState: 'function', navigate: 'function', onState: 'function', reload: 'function', setBounds: 'function', setOverlayActive: 'function' },
      clipboard: { writeText: 'function' },
      connection: 'function',
      dialogs: { selectDirectory: 'function' },
      kind: 'string',
      platform: 'string',
      shell: { openExternal: 'function', showItemInFolder: 'function' },
    });
    assert.equal(nativeApiShape.kind, 'electron');
    assert.equal(nativeApiShape.platform, 'linux');
    assert.equal(nativeApiShape.version, '0.1.0');
    assert.deepEqual(nativeApiShape.leaks, []);
    return `kind=${nativeApiShape.kind} version=${nativeApiShape.version}`;
  });

  await check('connection() returns baseUrl and token; the token is not in the page, the URL or the log', async () => {
    const c = await page.evaluate(() => window.miniSumma.connection());
    assert.equal(c.baseUrl, core);
    assert.match(c.token, /^[0-9a-f]{48}$/);
    const html = await (await fetch(`${core}/ui/`)).text();
    assert.ok(!html.includes(c.token), 'token appears in the served HTML');
    assert.ok(!page.url().includes(c.token));
    const cookies = await page.context().cookies();
    assert.ok(!JSON.stringify(cookies).includes(c.token));
    first.token = c.token;
  });

  await check('the page has no Node: no require, no process, no electron', async () => {
    const r = await page.evaluate(() => ({ require: typeof require, process: typeof process, module: typeof module, electron: typeof electron }));
    assert.deepEqual(r, { require: 'undefined', process: 'undefined', module: 'undefined', electron: 'undefined' });
  });

  await check('main window webPreferences: isolated, sandboxed, no node, no webview', async () => {
    const p = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows?.has(w.id));
      const pr = win.webContents.getLastWebPreferences();
      return { sandbox: pr.sandbox, contextIsolation: pr.contextIsolation, nodeIntegration: pr.nodeIntegration, webSecurity: pr.webSecurity, webviewTag: pr.webviewTag, nodeIntegrationInSubFrames: pr.nodeIntegrationInSubFrames };
    });
    assert.deepEqual(p, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, nodeIntegrationInSubFrames: false });
  });

  await check('renderer process is really sandboxed by the OS (Linux seccomp filter)', async () => {
    if (!asUser) return 'SKIPPED here: --no-sandbox in this run; use --as <user>';
    const pids = await app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.type === 'Tab' || m.type === 'Renderer').map((m) => m.pid));
    assert.ok(pids.length > 0);
    const modes = pids.map((pid) => /Seccomp:\s*(\d)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]);
    assert.ok(modes.every((m) => m === '2'), `seccomp modes ${modes.join(',')}`);
    return `renderer pids ${pids.join(',')} seccomp=${modes.join(',')}`;
  });

  // ---- IPC trust and validation ------------------------------------------------------------------------------------

  await check('IPC refuses a window that is not the core page (data: page and a different origin, both with the preload)', async () => {
    const verdicts = await app.evaluate(async ({ BrowserWindow }, { preload, coreUrl }) => {
      const out = {};
      const other = coreUrl.replace('127.0.0.1', 'localhost');
      for (const [label, url] of [['data page', 'data:text/html,<title>x</title>'], ['other origin', `${other}/ui/`]]) {
        const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
        globalThis.__testWindows.add(w.id);
        await w.loadURL(url);
        out[label] = await w.webContents.executeJavaScript('window.miniSumma ? window.miniSumma.connection().then(() => "ALLOWED", (e) => "refused: " + e.message) : "no api"');
        w.destroy();
      }
      return out;
    }, { preload: preloadCjs, coreUrl: core });
    for (const [label, verdict] of Object.entries(verdicts)) {
      assert.match(verdict, /^refused: .*did not come from the Mini-Summa window/, `${label}: ${verdict}`);
    }
  });

  await check('IPC validates arguments (bounds, ChatGPT address, external link, badge)', async () => {
    const r = await page.evaluate(async () => {
      const fail = async (p) => { try { await p; return 'ACCEPTED'; } catch (e) { return e.message; } };
      return {
        bounds: await fail(window.miniSumma.chatgpt.setBounds({ x: 'a', y: 0, width: 1, height: 1 })),
        navigateOther: await fail(window.miniSumma.chatgpt.navigate('https://example.org/')),
        navigateHttp: await fail(window.miniSumma.chatgpt.navigate('http://chatgpt.com/')),
        openFile: await fail(window.miniSumma.shell.openExternal('file:///etc/passwd')),
        openHttp: await fail(window.miniSumma.shell.openExternal('http://example.org/')),
        folder: await fail(window.miniSumma.shell.showItemInFolder('relative/path')),
        badge: await fail(window.miniSumma.app.setBadgeCount(-3)),
        clip: await fail(window.miniSumma.clipboard.writeText({ not: 'text' })),
      };
    });
    for (const [k, v] of Object.entries(r)) assert.match(v, /Invalid/, `${k}: ${v}`);
    assert.deepEqual(await opened(app), []);
  });

  await check('native wiring: clipboard, folder picker, reveal-in-folder, badge, paths', async () => {
    const r = await page.evaluate(async () => {
      await window.miniSumma.clipboard.writeText('smoke clipboard text\nsecond line');
      const dir = await window.miniSumma.dialogs.selectDirectory({ title: 'Pick a project', defaultPath: '/tmp', properties: ['openFile'] });
      await window.miniSumma.shell.showItemInFolder('/tmp/some/report.md');
      await window.miniSumma.app.setBadgeCount(3);
      await window.miniSumma.shell.openExternal('https://example.org/docs');
      return { dir, paths: await window.miniSumma.app.getPaths() };
    });
    assert.equal(r.dir, '/picked/dir');
    assert.deepEqual(r.paths, { dataDir, logsDir: path.join(profileDir, 'logs') });
    const m = await app.evaluate(async ({ clipboard }) => ({ clip: await clipboard.readText(), open: globalThis.__openDialog, folder: globalThis.__folder, opened: globalThis.__opened }));
    assert.equal(m.clip, 'smoke clipboard text\nsecond line');
    assert.equal(m.open.title, 'Pick a project');
    assert.equal(m.open.defaultPath, '/tmp');
    assert.deepEqual(m.open.properties, ['openDirectory', 'createDirectory']);
    assert.deepEqual(m.folder, ['/tmp/some/report.md']);
    assert.deepEqual(m.opened, ['https://example.org/docs']);
    await app.evaluate(() => { globalThis.__opened.length = 0; });
  });

  await check('NativeBridge: clipboard is verified, openExternal is https-only, save dialog writes UTF-8', async () => {
    const ok = await stub(core, '/__test/clipboard', { text: 'from the core é' });
    assert.deepEqual(ok, { ok: true });
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'from the core é');
    assert.equal((await stub(core, '/__test/open-external', { url: 'file:///etc/passwd' })).ok, false);
    assert.equal((await stub(core, '/__test/open-external', { url: 'https://example.org/from-core' })).ok, true);
    assert.deepEqual(await opened(app), ['https://example.org/from-core']);
    const saved = await stub(core, '/__test/save', { suggestedName: '../evil/..:report.md', text: 'café report' });
    assert.equal(saved.path, path.join(run, 'saved-report.md'));
    assert.equal(fs.readFileSync(saved.path, 'utf8'), 'café report');
    const dialogOptions = await app.evaluate(() => globalThis.__saveDialog);
    const docs = await app.evaluate(({ app: a }) => a.getPath('documents'));
    assert.equal(path.dirname(dialogOptions.defaultPath), docs, 'the suggested name must not climb out of the documents folder');
    assert.equal(path.basename(dialogOptions.defaultPath), '_evil_.._report.md');
    await app.evaluate(() => { globalThis.__opened.length = 0; });
  });

  // ---- hardening of the main window --------------------------------------------------------------------------------

  await check('navigating the main window away from the core origin is blocked (https goes to the browser, the rest is dropped)', async () => {
    await app.evaluate(() => { globalThis.__opened.length = 0; });
    const before = page.url();
    for (const target of ['https://example.org/away', 'http://127.0.0.1:1/', 'file:///etc/hostname', 'ftp://example.org/']) {
      await page.evaluate((t) => { try { window.location.href = t; } catch { /* blocked is the point */ } }, target).catch(() => undefined);
      await sleep(250);
      assert.equal(page.url(), before, `window moved to ${page.url()} for ${target}`);
    }
    await page.evaluate(() => document.getElementById('outside').click());
    await until(async () => (await opened(app)).includes('https://outside.invalid/page'), 3000);
    assert.equal(page.url(), before);
    const out = await opened(app);
    assert.deepEqual(out, ['https://example.org/away', 'https://outside.invalid/page']);
    await app.evaluate(() => { globalThis.__opened.length = 0; });
  });

  await check('window.open is denied: no new window, https goes to the browser', async () => {
    await app.evaluate(() => { globalThis.__opened.length = 0; });
    const windowsBefore = app.windows().length;
    const r = await page.evaluate(() => ({ a: window.open('https://example.org/popup'), b: window.open('about:blank'), c: window.open(location.href) }));
    assert.deepEqual(r, { a: null, b: null, c: null });
    await sleep(250);
    assert.equal(app.windows().length, windowsBefore);
    assert.deepEqual(await opened(app), ['https://example.org/popup']);
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.equal(count, 1);
    await app.evaluate(() => { globalThis.__opened.length = 0; });
  });

  await check('main window permissions: camera, microphone, clipboard-read and notifications are refused', async () => {
    const r = await page.evaluate(async () => {
      const verdict = async (p) => { try { await p; return 'GRANTED'; } catch (e) { return e.name; } };
      return {
        mic: await verdict(navigator.mediaDevices.getUserMedia({ audio: true })),
        cam: await verdict(navigator.mediaDevices.getUserMedia({ video: true })),
        clipboardRead: await verdict(navigator.clipboard.readText()),
        geolocation: await new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('GRANTED'), (e) => res(`code ${e.code}`))),
        notifications: await Notification.requestPermission(),
      };
    });
    assert.notEqual(r.mic, 'GRANTED');
    assert.notEqual(r.cam, 'GRANTED');
    assert.notEqual(r.clipboardRead, 'GRANTED');
    assert.notEqual(r.geolocation, 'GRANTED');
    assert.notEqual(r.notifications, 'granted');
    return JSON.stringify(r);
  });

  // ---- the embedded ChatGPT view ---------------------------------------------------------------------------------

  const RECT = { x: 300, y: 80, width: 700, height: 520 };

  await check('the ChatGPT view does not exist until it is needed (setBounds alone creates nothing)', async () => {
    assert.equal(await viewProbe(app), null);
    await page.evaluate((r) => window.miniSumma.chatgpt.setBounds(r), RECT);
    assert.equal(await viewProbe(app), null);
    const state = await page.evaluate(() => window.miniSumma.chatgpt.getState());
    assert.deepEqual(state, { mode: 'embedded', status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null });
  });

  // The renderer side of the contract: record pushed states, and answer a request to show the workspace by placing the pane.
  await page.evaluate((r) => {
    window.__states = [];
    window.__nav = [];
    window.miniSumma.chatgpt.onState((s) => window.__states.push(s));
    window.miniSumma.app.onNavigate((t) => { window.__nav.push(t); if (t.view === 'workspace' && window.__placeOnWorkspace) window.miniSumma.chatgpt.setBounds(r); });
  }, RECT);

  await check('open() of a conversation: real navigation, honest result, view in persist:chatgpt', async () => {
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.ok))}&focus=1&reason=handoff`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'embedded');
    assert.equal(r.opened, true);
    assert.equal(r.verified, true);
    assert.equal(r.finalUrl, conv(ID.ok));
    assert.equal(r.title, 'Stand-in conversation');
    assert.equal(typeof r.focused, 'boolean');
    if (!r.focused) assert.match(r.note, /did not report keyboard focus/);
    assert.match(r.note, /cannot read the page/);
    const v = await viewProbe(app);
    assert.equal(v.url, conv(ID.ok));
    assert.equal(v.focused, r.focused, 'focused claim must equal what the web contents reports');
    assert.equal(v.inChatGptPartition, true);
    assert.equal(v.inDefaultSession, false);
    assert.match(v.storagePath ?? '', /Partitions\/chatgpt$/);
    assert.ok(v.storagePath.startsWith(profileDir), v.storagePath);
    assert.deepEqual(v.prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, hasPreload: false });
    assert.equal(hits.get('chatgpt.com/c/' + ID.ok), 1);
    return `focused=${r.focused}`;
  });

  await check('the view is not given a spoofed user agent', async () => {
    const v = await viewProbe(app);
    assert.equal(v.userAgent, v.defaultUserAgent);
    assert.match(v.userAgent, /Electron\//);
    const inPage = await inView(app, 'navigator.userAgent');
    assert.equal(inPage, v.userAgent);
  });

  await check('nothing of Mini-Summa runs inside the ChatGPT page (no preload, no Node)', async () => {
    const r = await inView(app, 'JSON.stringify({ api: typeof window.miniSumma, require: typeof require, process: typeof process, electron: typeof electron })');
    assert.deepEqual(JSON.parse(r), { api: 'undefined', require: 'undefined', process: 'undefined', electron: 'undefined' });
  });

  await check('the view is placed at the renderer rectangle and the page state was pushed to the renderer', async () => {
    const v = await viewProbe(app);
    assert.deepEqual(v.bounds, RECT);
    assert.equal(v.visible, true);
    const states = await page.evaluate(() => window.__states);
    assert.ok(states.length >= 2);
    assert.equal(states.at(-1).status, 'ready');
    assert.equal(states.at(-1).url, conv(ID.ok));
    assert.equal(states.at(-1).title, 'Stand-in conversation');
    assert.equal(states.some((s) => s.status === 'loading'), true);
  });

  await check('ChatGPT permissions: camera, microphone, clipboard-read, notifications and geolocation are all refused', async () => {
    const r = await inView(app, `(async () => {
      const verdict = async (p) => { try { await p; return 'GRANTED'; } catch (e) { return e.name; } };
      return JSON.stringify({
        mic: await verdict(navigator.mediaDevices.getUserMedia({ audio: true })),
        cam: await verdict(navigator.mediaDevices.getUserMedia({ video: true })),
        clipboardRead: await verdict(navigator.clipboard.readText()),
        geo: await new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('GRANTED'), (e) => res('code ' + e.code))),
        notifications: await Notification.requestPermission(),
      });
    })()`);
    const v = JSON.parse(r);
    assert.notEqual(v.mic, 'GRANTED');
    assert.notEqual(v.cam, 'GRANTED');
    assert.notEqual(v.clipboardRead, 'GRANTED');
    assert.notEqual(v.geo, 'GRANTED');
    assert.notEqual(v.notifications, 'granted');
    return r;
  });

  await check('hiding the pane (null) and showing it again never destroys the page: scroll position and typed text survive', async () => {
    await inView(app, 'document.getElementById("composer").value = "draft that must survive"; document.getElementById("composer").focus(); window.scrollTo(0, 400); 1');
    const before = await viewProbe(app);
    await page.evaluate(() => window.miniSumma.chatgpt.setBounds(null));
    assert.equal((await viewProbe(app)).visible, false);
    await page.evaluate(() => window.miniSumma.chatgpt.setOverlayActive(true));
    await page.evaluate((r) => window.miniSumma.chatgpt.setBounds(r), RECT);
    assert.equal((await viewProbe(app)).visible, false, 'an active overlay must keep the native view hidden');
    await page.evaluate(() => window.miniSumma.chatgpt.setOverlayActive(false));
    const after = await viewProbe(app);
    assert.equal(after.visible, true);
    assert.equal(after.id, before.id, 'a different web contents was created');
    const kept = JSON.parse(await inView(app, 'JSON.stringify({ y: Math.round(window.scrollY), draft: document.getElementById("composer").value })'));
    assert.deepEqual(kept, { y: 400, draft: 'draft that must survive' });
    assert.equal(hits.get('chatgpt.com/c/' + ID.ok), 1, 'the page was reloaded');
  });

  await check('bounds follow the page zoom, the window size, maximize and fullscreen (DIP math, clamped)', async () => {
    const set = (r) => page.evaluate((x) => window.miniSumma.chatgpt.setBounds(x), r);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows.has(w.id)).webContents.setZoomFactor(1.25); });
    await set(RECT);
    assert.deepEqual((await viewProbe(app)).bounds, { x: 375, y: 100, width: 875, height: 650 });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows.has(w.id)).webContents.setZoomFactor(1); });
    await set(RECT);
    assert.deepEqual((await viewProbe(app)).bounds, RECT);

    // Shrink the window so the pane no longer fits: the native view is clamped at once, before the renderer reacts.
    // (The window has a 960x600 minimum, so use a pane that is bigger than that.)
    const BIG = { x: 300, y: 80, width: 800, height: 700 };
    await set(BIG);
    assert.deepEqual((await viewProbe(app)).bounds, BIG);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !globalThis.__testWindows.has(x.id)); w.setContentSize(1000, 600); });
    await until(async () => (await viewProbe(app)).bounds.height === 520);
    assert.deepEqual((await viewProbe(app)).bounds, { x: 300, y: 80, width: 700, height: 520 });
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !globalThis.__testWindows.has(x.id)); w.setContentSize(1280, 900); });
    await until(async () => (await viewProbe(app)).bounds.height === 700);
    assert.deepEqual((await viewProbe(app)).bounds, BIG);
    await set(RECT);

    // Fullscreen and back.
    const fs1 = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !globalThis.__testWindows.has(x.id));
      await new Promise((resolve) => { w.once('enter-full-screen', resolve); w.setFullScreen(true); setTimeout(resolve, 1500); });
      const [cw, ch] = w.getContentSize();
      const view = w.contentView.children.find((c) => c.webContents);
      return { fullscreen: w.isFullScreen(), content: [cw, ch], bounds: view.getBounds() };
    });
    if (fs1.fullscreen) {
      assert.deepEqual(fs1.bounds, RECT);
      await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !globalThis.__testWindows.has(x.id)); await new Promise((r) => { w.once('leave-full-screen', r); w.setFullScreen(false); setTimeout(r, 1500); }); });
    }
    return `fullscreen ${fs1.fullscreen ? 'entered' : 'not available without a window manager'}`;
  });

  await check('opening the same page again does not navigate (server saw one request) and does not touch the draft', async () => {
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.ok) + '?model=x')}&focus=0&reason=user`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(hits.get('chatgpt.com/c/' + ID.ok), 1);
    const kept = JSON.parse(await inView(app, 'JSON.stringify({ draft: document.getElementById("composer").value })'));
    assert.equal(kept.draft, 'draft that must survive');
  });

  await check('open() of another conversation navigates the same view (same web contents)', async () => {
    const before = await viewProbe(app);
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.other))}&focus=0&reason=verify`)).json();
    assert.deepEqual([r.ok, r.opened, r.verified, r.title], [true, true, true, 'Other conversation']);
    const after = await viewProbe(app);
    assert.equal(after.id, before.id);
    assert.equal(after.url, conv(ID.other));
  });

  await check('navigate() from the renderer loads a ChatGPT address in the same view, and does nothing for the page already shown', async () => {
    const before = await viewProbe(app);
    const hitsBefore = hits.get('chatgpt.com/c/' + ID.ok) ?? 0;
    await page.evaluate((u) => window.miniSumma.chatgpt.navigate(u), conv(ID.ok));
    await until(async () => (await viewProbe(app)).url === conv(ID.ok) && (await page.evaluate(() => window.miniSumma.chatgpt.getState())).status === 'ready', 8000);
    assert.equal((await viewProbe(app)).id, before.id);
    assert.equal(hits.get('chatgpt.com/c/' + ID.ok), hitsBefore + 1);
    await page.evaluate((u) => window.miniSumma.chatgpt.navigate(u), conv(ID.ok));
    await sleep(300);
    assert.equal(hits.get('chatgpt.com/c/' + ID.ok), hitsBefore + 1, 'navigate() reloaded the page that was already shown');
    await page.evaluate(() => window.miniSumma.chatgpt.focus());
  });

  await check('a conversation that redirects to the sign-in page is opened but NOT verified; state says login_required', async () => {
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.login))}&focus=0&reason=verify`)).json();
    assert.deepEqual([r.ok, r.opened, r.verified], [true, true, false]);
    assert.equal(r.finalUrl, 'https://auth.openai.com/log-in');
    assert.match(r.note, /sign-in/i);
    const s = await (await fetch(`${core}/__test/state`)).json();
    assert.equal(s.status, 'login_required');
    assert.match(s.note, /Google sign-in is often refused/);
    const pushed = await page.evaluate(() => window.__states.at(-1));
    assert.equal(pushed.status, 'login_required');
  });

  await check('a client-side redirect shortly after load is caught by the settle step (verified false)', async () => {
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.late))}&focus=0&reason=verify`)).json();
    assert.deepEqual([r.ok, r.opened, r.verified], [true, true, false]);
    assert.equal(r.finalUrl, 'https://auth.openai.com/log-in');
  });

  await check('a security-check page is reported as challenge and not verified', async () => {
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.challenge))}&focus=0&reason=verify`)).json();
    assert.deepEqual([r.ok, r.opened, r.verified, r.finalUrl], [true, true, false, conv(ID.challenge)]);
    assert.equal((await (await fetch(`${core}/__test/state`)).json()).status, 'challenge');
  });

  await check('a connection failure is reported as not opened with status error', async () => {
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.fail))}&focus=0&reason=user`)).json();
    assert.deepEqual([r.ok, r.opened, r.verified], [false, false, null]);
    assert.match(r.note, /could not be loaded/);
    assert.equal((await (await fetch(`${core}/__test/state`)).json()).status, 'error');
  });

  await check('a redirect to another website is cancelled by the policy and handed to the browser; the claim is "not opened"', async () => {
    await app.evaluate(() => { globalThis.__opened.length = 0; });
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.external))}&focus=0&reason=user`)).json();
    assert.deepEqual([r.ok, r.opened, r.verified], [false, false, null]);
    assert.match(r.note, /another site/);
    assert.deepEqual(await opened(app), ['https://redirect-target.invalid/landing']);
    await app.evaluate(() => { globalThis.__opened.length = 0; });
  });

  await check('open() refuses addresses that are not chatgpt.com, and the view is untouched', async () => {
    const before = await viewProbe(app);
    for (const bad of ['https://example.org/', 'http://chatgpt.com/', 'javascript:alert(1)']) {
      const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(bad)}`)).json();
      assert.deepEqual([r.ok, r.opened, r.verified, r.finalUrl], [false, false, null, null], bad);
    }
    assert.equal((await viewProbe(app)).url, before.url);
  });

  await check('links inside the page: external is cancelled and sent to the browser, _blank external too, _blank ChatGPT stays in the view, http is dropped', async () => {
    await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.ok))}&focus=0&reason=user`)).json();
    await app.evaluate(() => { globalThis.__opened.length = 0; });
    const urlBefore = (await viewProbe(app)).url;
    const windowsBefore = await app.evaluate(({ BrowserWindow, webContents }) => ({ w: BrowserWindow.getAllWindows().length, c: webContents.getAllWebContents().length }));

    await inView(app, 'document.getElementById("ext").click(); 1');
    await sleep(400);
    assert.equal((await viewProbe(app)).url, urlBefore, 'navigated away through a plain link');
    await inView(app, 'document.getElementById("blank").click(); 1');
    await sleep(400);
    await inView(app, 'document.getElementById("http").click(); 1');
    await sleep(400);
    assert.equal((await viewProbe(app)).url, urlBefore, 'navigated through an http link');
    assert.deepEqual(await opened(app), ['https://outside.invalid/clicked', 'https://outside.invalid/blank']);

    await inView(app, 'document.getElementById("self").click(); 1');
    await until(async () => (await viewProbe(app)).url === conv(ID.other), 8000);
    const windowsAfter = await app.evaluate(({ BrowserWindow, webContents }) => ({ w: BrowserWindow.getAllWindows().length, c: webContents.getAllWebContents().length }));
    assert.deepEqual(windowsAfter, windowsBefore, 'a popup window was created');
    await app.evaluate(() => { globalThis.__opened.length = 0; });
  });

  await check('Google rejecting an embedded browser is reported as blocked with the Settings hint (heuristic from the address)', async () => {
    await inView(app, 'location.href = "https://accounts.google.com/v3/signin/rejected?flowName=GlifWebSignIn"; 1');
    await until(async () => (await (await fetch(`${core}/__test/state`)).json()).status === 'blocked', 8000);
    const s = await (await fetch(`${core}/__test/state`)).json();
    assert.match(s.note, /Google refused/);
    assert.match(s.note, /external browser mode in Settings/);
  });

  await check('back and forward act on the view history', async () => {
    const r = await page.evaluate(async () => {
      const before = await window.miniSumma.chatgpt.getState();
      await window.miniSumma.chatgpt.back();
      return before;
    });
    assert.equal(r.canGoBack, true);
    await until(async () => (await viewProbe(app)).url !== 'https://accounts.google.com/v3/signin/rejected?flowName=GlifWebSignIn', 8000);
    await page.evaluate(() => window.miniSumma.chatgpt.reload());
  });

  await check('with no pane on screen, open() asks the renderer for the workspace and succeeds once the pane is placed', async () => {
    await page.evaluate(() => { window.__nav.length = 0; window.__placeOnWorkspace = true; return window.miniSumma.chatgpt.setBounds(null); });
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.ok))}&focus=0&reason=handoff`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    const nav = await page.evaluate(() => window.__nav);
    assert.deepEqual(nav.filter((t) => t.view === 'workspace'), [{ view: 'workspace' }]);
    assert.equal((await viewProbe(app)).visible, true);
  });

  await check('with no pane and no answer from the renderer, open() waits 2 s and reports that nothing was opened (the page is not touched)', async () => {
    await page.evaluate(() => { window.__placeOnWorkspace = false; return window.miniSumma.chatgpt.setBounds(null); });
    const urlBefore = (await viewProbe(app)).url;
    const t0 = Date.now();
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.other))}&focus=0&reason=handoff`)).json();
    const took = Date.now() - t0;
    assert.deepEqual([r.ok, r.opened, r.verified], [false, false, null]);
    assert.match(r.note, /not on screen/);
    assert.ok(took >= 1900 && took < 4500, `waited ${took} ms`);
    assert.equal((await viewProbe(app)).url, urlBefore);
  });

  await page.evaluate((x) => window.miniSumma.chatgpt.setBounds(x), RECT).catch(() => undefined);

  // ---- notifications, links, tray, state -------------------------------------------------------------------------

  await check('native notification: the result is honest (shown, or not with a reason)', async () => {
    const r = await stub(core, '/__test/notify', { title: 'Report ready: smoke', body: 'A body', tag: 'smoke:1', target: { view: 'reports', reportId: 'rep_smoke' }, urgency: 'normal', silent: true });
    assert.equal(typeof r.shown, 'boolean');
    if (!r.shown) assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
    return JSON.stringify(r);
  }, 15_000);

  await check('a minisumma:// link (second-instance path) brings a hidden window forward and reaches onNavigate', async () => {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows.has(w.id)).hide(); });
    assert.equal((await mainWindowInfo(app)).visible, false);
    await page.evaluate(() => { window.__nav.length = 0; });
    await app.evaluate(({ app: a }) => { a.emit('second-instance', {}, ['Mini-Summa', 'minisumma://reports?report=rep_9&delivery=dlv_2'], '', {}); });
    await until(async () => (await page.evaluate(() => window.__nav.length)) > 0);
    const nav = await page.evaluate(() => window.__nav);
    assert.deepEqual(nav, [{ view: 'reports', reportId: 'rep_9', deliveryId: 'dlv_2' }]);
    assert.equal((await mainWindowInfo(app)).visible, true);
  });

  await check('a malformed link is rejected (no navigation) but still brings the window forward', async () => {
    await page.evaluate(() => { window.__nav.length = 0; });
    await app.evaluate(({ app: a }) => { a.emit('second-instance', {}, ['Mini-Summa', 'minisumma://admin?x=1'], '', {}); });
    await sleep(300);
    assert.deepEqual(await page.evaluate(() => window.__nav), []);
  });

  await check('a second launch exits at once and forwards its link to the first instance (real single-instance lock)', async () => {
    await page.evaluate(() => { window.__nav.length = 0; });
    const child = spawn(executablePath, [...sandboxArgs, appRoot, 'minisumma://settings?section=hooks'], { env: appEnv(), stdio: 'ignore' });
    const code = await withTimeout(new Promise((resolve) => child.once('exit', resolve)), 30_000, 'second instance exit');
    assert.equal(code, 0);
    await until(async () => (await page.evaluate(() => window.__nav.length)) > 0, 10_000);
    assert.deepEqual(await page.evaluate(() => window.__nav), [{ view: 'settings', section: 'hooks' }]);
  }, 60_000);

  await check('tray: created if the desktop has a system tray, otherwise the app says so and carries on', async () => {
    const log = fs.readFileSync(path.join(profileDir, 'logs', 'main.log'), 'utf8');
    const unavailable = /tray unavailable|tray icon missing/.test(log);
    return unavailable ? 'no tray on this desktop (logged, app continues)' : 'tray created without error';
  });

  await check('window size and position are written to window-state.json', async () => {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows.has(w.id)).setBounds({ x: 40, y: 30, width: 1111, height: 777 }); });
    const file = path.join(profileDir, 'window-state.json');
    await until(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).width === 1111; } catch { return false; } }, 5000);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved, { x: 40, y: 30, width: 1111, height: 777, maximized: false });
  });

  await check('a persistent cookie set by the ChatGPT page is stored in the persist:chatgpt session', async () => {
    const r = await (await fetch(`${core}/__test/open?url=${encodeURIComponent(conv(ID.cookie))}&focus=0&reason=user`)).json();
    assert.equal(r.ok, true);
    const cookies = await app.evaluate(({ session }) => session.fromPartition('persist:chatgpt').cookies.get({ name: 'ms_standin_login' }));
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].value, 'yes');
    const inDefault = await app.evaluate(({ session }) => session.defaultSession.cookies.get({ name: 'ms_standin_login' }));
    assert.equal(inDefault.length, 0, 'the cookie leaked into the main window session');
  });

  // ---- quit flow --------------------------------------------------------------------------------------------------

  await check('closing the window with 2 running terminals asks first (exact wording, Cancel is the default) and Cancel keeps everything running', async () => {
    await stub(core, '/__test/sessions', [
      { origin: 'managed', availability: 'live', terminal: { cols: 80, rows: 24, exited: false } },
      { origin: 'managed', availability: 'live', terminal: { cols: 80, rows: 24, exited: false } },
      { origin: 'external', availability: 'live', terminal: null },
    ]);
    await app.evaluate(({ BrowserWindow }) => { globalThis.__dialogs.length = 0; globalThis.__dialogAnswer = 1; BrowserWindow.getAllWindows().find((w) => !globalThis.__testWindows.has(w.id)).close(); });
    await until(async () => (await app.evaluate(() => globalThis.__dialogs.length)) === 1);
    const [d] = await app.evaluate(() => globalThis.__dialogs);
    assert.equal(d.type, 'warning');
    assert.equal(d.message, 'Quit Mini-Summa?');
    assert.equal(d.detail, 'Closing Mini-Summa ends 2 running Claude terminals. They can be resumed later.');
    assert.deepEqual(d.buttons, ['Quit and end terminals', 'Cancel']);
    assert.equal(d.defaultId, 1);
    assert.equal(d.cancelId, 1);
    assert.equal(d.withWindow, true);
    await sleep(500);
    assert.equal((await stub(core, '/__test/status')).stopped, false);
    assert.equal((await mainWindowInfo(app)).visible, true);
    assert.equal(fs.existsSync(path.join(dataDir, 'stub-core-stopped.json')), false);
  });

  await check('Ctrl+Q style app.quit() asks the same question once, even if requested twice', async () => {
    await app.evaluate(({ app: a }) => { globalThis.__dialogs.length = 0; a.quit(); a.quit(); });
    await until(async () => (await app.evaluate(() => globalThis.__dialogs.length)) >= 1);
    await sleep(400);
    assert.equal(await app.evaluate(() => globalThis.__dialogs.length), 1);
  });

  await check('confirming stops the core BEFORE the process exits (exit code 0) and flushes the ChatGPT login to disk', async () => {
    await app.evaluate(() => { globalThis.__dialogAnswer = 0; });
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
    const { code } = await withTimeout(first.exited, 30_000, 'app exit');
    assert.equal(code, 0);
    const proof = JSON.parse(fs.readFileSync(path.join(dataDir, 'stub-core-stopped.json'), 'utf8'));
    assert.equal(proof.sessionsAtStop, 3);
    const cookieDb = path.join(profileDir, 'Partitions', 'chatgpt', 'Cookies');
    assert.ok(fs.existsSync(cookieDb), `no cookie database at ${cookieDb}`);
  }, 60_000);

  // ---- second run: what must survive a restart -------------------------------------------------------------------

  const second = await launch().catch((error) => { results.push({ name: 'relaunch', ok: false, error: error.message }); console.log(`FAIL  relaunch\n      ${error.message}`); return null; });
  if (second) {
    await check('after a restart the window comes back at the saved size and position', async () => {
      const w = await second.app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; return win.getBounds(); });
      assert.deepEqual({ width: w.width, height: w.height }, { width: 1111, height: 777 });
      return `bounds ${JSON.stringify(w)}`;
    });
    await check('after a restart the ChatGPT login (persistent cookie) is still there, in the persist:chatgpt session only', async () => {
      const found = await second.app.evaluate(({ session }) => session.fromPartition('persist:chatgpt').cookies.get({ name: 'ms_standin_login' }));
      assert.equal(found.length, 1);
      assert.equal(found[0].value, 'yes');
    });
    await check('the main-process log has the startup line and never the desktop token', async () => {
      const log = fs.readFileSync(path.join(profileDir, 'logs', 'main.log'), 'utf8');
      assert.match(log, /core started/);
      assert.ok(!log.includes(first.token), 'desktop token found in main.log');
      // The redaction itself is covered by the unit tests; here the real log must simply never carry the token.
      assert.ok(!fs.readFileSync(path.join(profileDir, 'logs', 'main.log'), 'utf8').includes(first.token));
    });
    await second.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
    await withTimeout(second.exited, 30_000, 'second run exit').catch(() => second.app.close());

    // Cold start from a link (Windows launches the exe with the link as an argument).
    const third = await launch({}, ['minisumma://reports?report=rep_cold&delivery=dlv_cold']).catch((error) => { results.push({ name: 'cold start with a link', ok: false, error: error.message }); console.log(`FAIL  cold start with a link\n      ${error.message}`); return null; });
    if (third) {
      await check('a link on the command line of the first launch reaches the page even if it registers its listener late', async () => {
        await sleep(500);
        const target = await third.page.evaluate(() => new Promise((resolve) => { window.miniSumma.app.onNavigate(resolve); setTimeout(() => resolve(null), 3000); }));
        assert.deepEqual(target, { view: 'reports', reportId: 'rep_cold', deliveryId: 'dlv_cold' });
      });
      await third.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
      await withTimeout(third.exited, 30_000, 'third run exit').catch(() => third.app.close());
    }
  }
} catch (error) {
  results.push({ name: 'harness', ok: false, error: error.stack ?? String(error) });
  console.log(`FAIL  harness\n      ${error.stack ?? error}`);
} finally {
  await first.app.close().catch(() => undefined);
  standIn.server.close();
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n--- main process output of the first run (tail) ---');
    console.log(first.out.join('').split('\n').slice(-25).join('\n'));
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}.`);
  console.log(`sandbox: ${sandboxMode}`);
  if (!keep) fs.rmSync(run, { recursive: true, force: true });
  else console.log(`kept ${run}`);
  process.exit(failed.length ? 1 : 0);
}
