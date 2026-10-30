// Real browser test of the Mini-Summa tab focus extension.
//
//   cd /home/user/mini-summa && node apps/browser-extension/build.mjs --test-hosts
//   xvfb-run -a node apps/browser-extension/test/real-browser.mjs
//
// What runs: headed Chromium (Playwright's launchPersistentContext) with the built extension loaded for real, a fake
// Mini-Summa core (HTTP + WebSocket, no CORS headers) and a local HTTPS server that stands in for ChatGPT.
//
// No real ChatGPT is ever contacted. The stand-in is reached under the real names https://chatgpt.com and
// https://chat.openai.com because the browser itself is told to resolve those names to the local server
// (--host-resolver-rules) and every other name to "not found". The extension code under test is therefore byte for
// byte the production code: it sees ordinary https://chatgpt.com/c/<id> tab addresses. A canary navigation to an
// unrelated public name must fail to resolve, or the test stops.
//
// Request routing in the test framework (page.route) is deliberately NOT used: it does not cover tabs the browser
// creates by itself (chrome.tabs.create), which would then load the real site.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { buildExtension } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(process.env.MINISUMMA_EXT_DIR ?? path.join(here, '..', 'dist'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STAND_IN_HOSTS = ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'];

async function waitFor(fn, { timeout = 15_000, interval = 100, what = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try { const value = await fn(); if (value) return value; last = value; } catch (error) { last = error; }
    if (Date.now() - start > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(interval);
  }
}

function findChromium() {
  if (process.env.MINISUMMA_CHROMIUM && fs.existsSync(process.env.MINISUMMA_CHROMIUM)) return process.env.MINISUMMA_CHROMIUM;
  const preferred = chromium.executablePath();
  if (preferred && fs.existsSync(preferred)) return preferred;
  // The Playwright package may expect a newer browser revision than the one installed (it does in this container).
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  const revisions = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const dir of revisions) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = path.join(base, dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`No Chromium found. Set MINISUMMA_CHROMIUM or install one for Playwright (looked in ${base}).`);
}

// Conversation ids are valid uuids: n=3 gives 33333333-3333-4333-8333-333333333333.
const convId = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const convUrl = (n) => `https://chatgpt.com/c/${convId(n)}`;

// ------------------------------------------------------------------------------------------------------------------
// The stand-in for ChatGPT: https://chatgpt.com/... served from 127.0.0.1 with a throwaway self-signed certificate.

function makeCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=chatgpt.com', '-addext', `subjectAltName=${STAND_IN_HOSTS.map((h) => `DNS:${h}`).join(',')}`], { stdio: 'pipe' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const standInHtml = (title, text, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main id="conversation">${text}</main>${extra}</body></html>`;

class StandIn {
  requests = [];
  sockets = new Set();
  /** Conversation 5 redirects to sign-in, 6 redirects from script after load, 7 resets the connection, 8 never answers. */
  async start(credentials) {
    this.server = https.createServer(credentials, (req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }
  handle(req, res) {
    const host = String(req.headers.host ?? '');
    const url = new URL(req.url, 'https://chatgpt.com');
    this.requests.push({ host, method: req.method, path: url.pathname });
    const conv = /^\/c\/(\d)\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$/.exec(url.pathname);
    const n = conv ? Number(conv[1]) : null;
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(body); };
    if (url.pathname === '/favicon.ico') return send(204, '');
    if (url.pathname === '/auth/login') return send(200, standInHtml('Log in', 'Log in to continue'));
    if (n === 5) return send(302, '', { location: '/auth/login' });
    if (n === 6) return send(200, standInHtml('Conversation 6', 'Conversation 6', '<script>setTimeout(function () { location.replace("/auth/login"); }, 150);</script>'));
    if (n === 7) { req.socket.destroy(); return undefined; }
    if (n === 8) return undefined; // never answers
    if (n !== null) return send(200, standInHtml(`Conversation ${n}`, `Conversation ${n}`));
    return send(404, standInHtml('Not found', 'Not found'));
  }
  hits(pathname) { return this.requests.filter((r) => r.path === pathname).length; }
  async stop() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// ------------------------------------------------------------------------------------------------------------------
// The fake Mini-Summa core: pairing endpoint and WebSocket, deliberately without any CORS header.

class FakeCore {
  offers = new Map(); // offerId -> code
  redeemCalls = [];
  preflights = 0;
  hellos = [];
  connections = [];
  validTokens = new Set();
  pending = new Map();
  current = null;
  tokenCounter = 0;
  seq = 0;

  async start() {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://127.0.0.1').pathname !== '/ws') { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}`;
  }

  handleHttp(req, res) {
    if (req.method === 'OPTIONS') { this.preflights += 1; res.writeHead(404); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && req.url === '/api/v1/pairing/redeem') {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: { code: 'bad_json', message: 'Not JSON.' } }); }
        this.redeemCalls.push({ body, headers: req.headers });
        if (this.offers.get(body.offerId) !== body.code) return json(400, { error: { code: 'bad_code', message: 'The pairing code does not match this offer.' } });
        this.offers.delete(body.offerId);
        const token = `token-${++this.tokenCounter}-${Math.random().toString(16).slice(2)}`;
        this.validTokens.add(token);
        return json(200, {
          device: { id: `dev-ext-${this.tokenCounter}`, name: body.deviceName, platform: body.platform, scopes: ['extension'], trusted: false, pushRegistered: false, createdAt: new Date().toISOString(), lastSeenAt: null, lastSeenVia: null, revokedAt: null },
          token,
          server: { name: 'Fake Mini-Summa core', apiVersion: 1 },
        });
      }
      return json(404, { error: { code: 'not_found', message: 'No such route.' } });
    });
  }

  onSocket(ws, req) {
    const record = { origin: req.headers.origin, host: req.headers.host, messages: [], ws };
    this.connections.push(record);
    ws.once('message', (raw) => {
      const hello = JSON.parse(String(raw));
      record.messages.push(hello);
      this.hellos.push({ ...hello, origin: req.headers.origin });
      if (hello.t !== 'hello' || !this.validTokens.has(hello.token)) { ws.send(JSON.stringify({ t: 'error', code: 'unauthorized', message: 'Unknown token.', fatal: true })); ws.close(4003, 'revoked'); return; }
      this.current = ws;
      ws.send(JSON.stringify({ t: 'ready', serverTime: new Date().toISOString(), seq: 0, scopes: ['extension'], deviceId: 'dev-ext', resync: false, apiVersion: 1 }));
      ws.on('message', (more) => {
        const msg = JSON.parse(String(more));
        record.messages.push(msg);
        if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
        if (msg.t === 'bridge.result') { this.pending.get(msg.requestId)?.(msg); this.pending.delete(msg.requestId); }
      });
    });
    ws.on('close', () => { if (this.current === ws) this.current = null; });
  }

  createOffer() {
    const id = `offer-${this.offers.size + 1}-${Math.random().toString(16).slice(2, 8)}`;
    const code = `code-${Math.random().toString(16).slice(2, 12)}-${Math.random().toString(16).slice(2, 6)}`;
    this.offers.set(id, code);
    return { id, code };
  }

  /** Send a bridge.request to the connected extension and wait for its bridge.result. */
  request(action, timeoutMs = 30_000) {
    const ws = this.current;
    assert.ok(ws, 'the extension is not connected to the fake core');
    const requestId = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`no bridge.result for ${requestId} ${JSON.stringify(action)}`)); }, timeoutMs);
      this.pending.set(requestId, (msg) => { clearTimeout(timer); resolve(msg); });
      ws.send(JSON.stringify({ t: 'bridge.request', requestId, action }));
    });
  }

  focusOrOpen(url) { return this.request({ kind: 'focus_or_open', url }); }
  revokeCurrent() { const ws = this.current; this.validTokens.clear(); ws.close(4003, 'revoked'); }
  dropCurrent() { this.current.terminate(); }

  async stop() {
    for (const c of this.connections) c.ws.terminate();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// ------------------------------------------------------------------------------------------------------------------

/** Set MINISUMMA_SCREENSHOTS=<folder> to keep pictures of the options page in its main states. */
async function shot(page, name) {
  const dir = process.env.MINISUMMA_SCREENSHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `options-${name}.png`) });
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.log(`  FAIL  ${name}\n        ${String(error?.stack ?? error).split('\n').join('\n        ')}`);
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(path.join(extDir, 'manifest.json'))) {
    console.error(`No built extension in ${extDir}. Run: node apps/browser-extension/build.mjs --test-hosts`);
    process.exit(2);
  }
  const loadedManifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minisumma-real-browser-'));
  const standIn = new StandIn();
  const core = new FakeCore();
  const contexts = [];
  const consoleProblems = [];
  const chromiumPath = findChromium();

  console.log(`Chromium:   ${chromiumPath}`);
  console.log(`Extension:  ${loadedManifest.name} ${loadedManifest.version_name ?? loadedManifest.version} (${extDir})`);

  await standIn.start(makeCertificate(tmp));
  await core.start();
  const rules = [
    ...STAND_IN_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${standIn.port}`),
    'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost',
  ].join(', ');

  async function launch(extensionDir, tag) {
    const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(tmp, `profile-${tag}-`)), {
      executablePath: chromiumPath,
      headless: false,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
        `--host-resolver-rules=${rules}`, '--ignore-certificate-errors',
        '--no-proxy-server', '--disable-quic', '--no-first-run', '--no-default-browser-check',
      ],
    });
    contexts.push(context);
    return context;
  }

  let failure = null;
  try {
    const context = await launch(extDir, 'main');
    context.on('weberror', (e) => consoleProblems.push(`uncaught: ${e.error().message}`));
    const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(serviceWorker.url()).host;
    const getWorker = async () => (await waitFor(() => context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`)), { what: 'extension service worker' }));
    /** Run code inside the extension's service worker. Used only to read browser state and to arrange windows; the code under test never goes through it. */
    const inWorker = async (fn, arg) => (await getWorker()).evaluate(fn, arg);
    const snapshot = () => inWorker(async () => {
      const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
      return {
        tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, url: t.url ?? '', title: t.title ?? '', status: t.status })),
        windows: windows.map((w) => ({ id: w.id, focused: w.focused })),
      };
    });
    const tabsShowing = async (url) => (await snapshot()).tabs.filter((t) => t.url === url);
    const chatgptTabCount = async () => (await snapshot()).tabs.filter((t) => STAND_IN_HOSTS.includes(new URL(t.url || 'about:blank').hostname)).length;

    await step('the loaded bundle is byte for byte the production bundle', async () => {
      if (process.env.MINISUMMA_EXT_DIR) { console.log('        skipped: MINISUMMA_EXT_DIR points at a custom extension folder'); return; }
      const prod = path.join(tmp, 'prod-build');
      await buildExtension({ outDir: prod });
      for (const file of ['background.js', 'options.js', 'options.html', 'options.css']) {
        assert.equal(fs.readFileSync(path.join(extDir, file), 'utf8'), fs.readFileSync(path.join(prod, file), 'utf8'), `${file} differs from a production build`);
      }
      const a = { ...JSON.parse(fs.readFileSync(path.join(prod, 'manifest.json'), 'utf8')) };
      const b = { ...loadedManifest };
      for (const k of ['name', 'version_name']) { delete a[k]; delete b[k]; }
      assert.deepEqual(b, a, 'the manifest differs from production by more than the test label');
    });

    await step('network isolation: other names do not resolve, the stand-in answers as chatgpt.com', async () => {
      const canary = await context.newPage();
      const error = await canary.goto('https://example.com/').then(() => 'loaded', (e) => String(e.message));
      assert.match(error, /ERR_NAME_NOT_RESOLVED/, 'the canary navigation must fail to resolve; stopping before anything else can leave this machine');
      await canary.close();
      const probe = await context.newPage();
      const response = await probe.goto(convUrl(9));
      assert.equal(response.status(), 200);
      assert.equal(await probe.title(), 'Conversation 9');
      assert.deepEqual(standIn.requests.filter((r) => r.path.startsWith('/c/')).map((r) => r.host), ['chatgpt.com']);
      await probe.close();
      standIn.requests.length = 0;
    });

    await step('the loaded extension declares what the manifest says and has no way to inject code', async () => {
      const facts = await inWorker(() => {
        const m = chrome.runtime.getManifest();
        return {
          permissions: m.permissions, hosts: m.host_permissions, contentScripts: m.content_scripts ?? null, optional: m.optional_permissions ?? null,
          scripting: typeof chrome.scripting, executeScript: typeof chrome.tabs.executeScript, debugger: typeof chrome.debugger, webNavigation: typeof chrome.webNavigation,
          webRequest: typeof chrome.webRequest, cookies: typeof chrome.cookies, history: typeof chrome.history,
        };
      });
      assert.deepEqual(facts.permissions, ['tabs', 'storage', 'alarms']);
      assert.deepEqual(facts.hosts, ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'http://127.0.0.1/*', 'http://localhost/*']);
      assert.equal(facts.contentScripts, null);
      assert.equal(facts.optional, null);
      for (const api of ['scripting', 'executeScript', 'debugger', 'webNavigation', 'webRequest', 'cookies', 'history']) assert.equal(facts[api], 'undefined', `chrome.${api} must not exist for this extension`);
    });

    await step('the extension cannot talk to anything but this computer (CSP connect-src)', async () => {
      const violation = await inWorker(() => new Promise((resolve) => {
        self.addEventListener('securitypolicyviolation', (e) => resolve({ directive: e.violatedDirective, blocked: e.blockedURI }), { once: true });
        fetch('https://example.invalid/leak').catch(() => setTimeout(() => resolve({ none: true }), 1000));
      }));
      assert.equal(violation.directive, 'connect-src');
      assert.equal(violation.blocked, 'https://example.invalid/leak');
    });

    // ---- pairing through the real options page --------------------------------------------------------------------
    const options = await context.newPage();
    const status = async () => (await options.textContent('#status-headline'))?.trim();
    await step('options page: a wrong code is explained, then pairing with the real code connects', async () => {
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await waitFor(async () => (await status()) === 'Not paired', { what: 'status "Not paired"' });
      assert.equal(await options.inputValue('#core-url'), 'http://127.0.0.1:47811', 'the default core address');
      assert.ok((await options.inputValue('#device-name')).length > 0, 'a device name is suggested from the browser');
      await shot(options, '1-not-paired');
      await options.fill('#core-url', core.url);
      await options.click('summary');
      const offer = core.createOffer();
      await options.fill('#offer-id', offer.id);
      await options.fill('#code', `${offer.code}-wrong`);
      await options.click('#pair');
      await waitFor(async () => /refused the pairing/.test(await options.textContent('#message')), { what: 'the refusal message' });
      assert.match(await options.textContent('#message'), /The pairing code does not match this offer\./);
      assert.equal(await status(), 'Not paired');
      await shot(options, '2-refused');

      await options.fill('#code', offer.code);
      await options.click('#pair');
      await waitFor(async () => (await status()) === 'Connected', { what: 'status "Connected"', timeout: 20_000 });
      await shot(options, '3-connected');
      assert.equal(await options.isVisible('#unpair'), true);
      assert.equal(await options.isVisible('#pair'), false);
      assert.match(await options.textContent('#paired-line'), /^Paired as .+\.$/);
      assert.equal(await options.inputValue('#code'), '', 'the spent code is not left in the page');

      assert.equal(core.redeemCalls.length, 2);
      const sent = core.redeemCalls[1];
      assert.deepEqual(Object.keys(sent.body).sort(), ['code', 'deviceName', 'offerId', 'platform']);
      assert.equal(sent.body.platform, 'extension');
      assert.ok(sent.body.deviceName.length > 0 && sent.body.deviceName.length <= 80);
      assert.equal(sent.headers.authorization, undefined, 'the redeem request is public and carries no token');
      assert.equal(core.preflights, 0, 'host permission lets the options page call the core without a CORS preflight');
    });

    await step('the worker said hello with the stored token and the core answered ready', async () => {
      assert.equal(core.hellos.length, 1);
      const hello = core.hellos[0];
      assert.deepEqual(Object.keys(hello).sort(), ['client', 'origin', 't', 'token', 'topics']);
      assert.equal(hello.t, 'hello');
      assert.equal(hello.client, 'browser-extension');
      assert.deepEqual(hello.topics, []);
      assert.equal(hello.origin, `chrome-extension://${extensionId}`, 'Origin header the core sees on /ws');
      const stored = await inWorker(() => chrome.storage.local.get(['token', 'coreUrl']));
      assert.equal(stored.token, hello.token);
      assert.equal(stored.coreUrl, core.url);
    });

    await step('the heartbeat alarm exists while paired (30 s, the shortest period Chrome honours)', async () => {
      const alarm = await inWorker(() => chrome.alarms.get('minisumma-heartbeat'));
      assert.ok(alarm, 'an alarm named minisumma-heartbeat');
      assert.equal(alarm.periodInMinutes, 0.5);
    });

    // ---- the actual job: focus or open -----------------------------------------------------------------------------
    const pageA = await context.newPage();
    await pageA.goto(convUrl(1));
    const pageB = await context.newPage();
    await pageB.goto(convUrl(2));
    await pageA.bringToFront();
    let w1;

    await step('focus_or_open: an already open conversation tab becomes the active tab, without a reload', async () => {
      await waitFor(async () => (await tabsShowing(convUrl(1)))[0]?.active === true, { what: 'tab A in front' });
      const before = await snapshot();
      const tabA = before.tabs.find((t) => t.url === convUrl(1));
      const tabB = before.tabs.find((t) => t.url === convUrl(2));
      assert.ok(tabA?.active && !tabB?.active);
      w1 = tabA.windowId;
      assert.equal(before.windows.filter((w) => w.focused).length, 1);
      const requestsBefore = standIn.hits(`/c/${convId(2)}`);
      const count = await chatgptTabCount();

      const reply = await core.focusOrOpen(convUrl(2));

      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.deepEqual(Object.keys(reply.data).sort(), ['mode', 'tabId', 'title', 'url', 'urlMatches', 'windowFocused', 'windowId']);
      assert.equal(reply.data.mode, 'focused');
      assert.equal(reply.data.tabId, tabB.id);
      assert.equal(reply.data.windowId, tabB.windowId);
      assert.equal(reply.data.url, convUrl(2));
      assert.equal(reply.data.title, 'Conversation 2');
      assert.equal(reply.data.urlMatches, true);
      assert.equal(reply.data.windowFocused, true);
      const after = await snapshot();
      assert.equal(after.tabs.find((t) => t.id === tabB.id).active, true);
      assert.equal(after.tabs.find((t) => t.id === tabA.id).active, false);
      assert.equal(await chatgptTabCount(), count, 'no tab was opened');
      assert.equal(standIn.hits(`/c/${convId(2)}`), requestsBefore, 'the page was not reloaded');
    });

    await step('focus_or_open: the window that holds the tab is brought to the front', async () => {
      const w2 = await inWorker((url) => chrome.windows.create({ url, focused: true }).then((w) => ({ id: w.id, tabId: w.tabs[0].id })), convUrl(3));
      await waitFor(async () => (await tabsShowing(convUrl(3)))[0]?.status === 'complete', { what: 'conversation 3 loaded in a second window' });
      let snap = await snapshot();
      assert.notEqual(w2.id, w1);
      assert.equal(snap.windows.find((w) => w.id === w2.id).focused, true, 'precondition: window 2 is focused');
      assert.equal(snap.windows.find((w) => w.id === w1).focused, false, 'precondition: window 1 is not focused');

      const reply = await core.focusOrOpen(convUrl(1)); // lives in window 1
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.mode, 'focused');
      assert.equal(reply.data.windowId, w1);
      assert.equal(reply.data.windowFocused, true);
      snap = await snapshot();
      assert.equal(snap.windows.find((w) => w.id === w1).focused, true, 'window 1 is now the focused window');
      assert.equal(snap.windows.find((w) => w.id === w2.id).focused, false);
      assert.equal(snap.tabs.find((t) => t.url === convUrl(1)).active, true);
    });

    let openedTabId;
    await step('focus_or_open: no tab for that conversation, so one is created, loaded and reported honestly', async () => {
      const count = await chatgptTabCount();
      const started = Date.now();
      const reply = await core.focusOrOpen(convUrl(4));
      const elapsed = Date.now() - started;
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.mode, 'opened');
      assert.equal(reply.data.url, convUrl(4));
      assert.equal(reply.data.title, 'Conversation 4');
      assert.equal(reply.data.urlMatches, true);
      assert.equal(reply.data.windowFocused, true);
      assert.equal(reply.data.windowId, w1);
      assert.ok(elapsed >= 500, `waited for the page to settle (${elapsed} ms)`);
      openedTabId = reply.data.tabId;
      assert.equal(await chatgptTabCount(), count + 1);
      const tab = (await snapshot()).tabs.find((t) => t.id === openedTabId);
      assert.deepEqual({ active: tab.active, status: tab.status, url: tab.url }, { active: true, status: 'complete', url: convUrl(4) });
      assert.equal(standIn.hits(`/c/${convId(4)}`), 1);
    });

    await step('focus_or_open: asking again focuses that tab and does not open a duplicate', async () => {
      const count = await chatgptTabCount();
      await pageA.bringToFront();
      const reply = await core.focusOrOpen(convUrl(4));
      assert.equal(reply.ok, true);
      assert.equal(reply.data.mode, 'focused');
      assert.equal(reply.data.tabId, openedTabId);
      assert.equal(await chatgptTabCount(), count);
      assert.equal(standIn.hits(`/c/${convId(4)}`), 1);
    });

    await step('focus_or_open: the legacy host and extra query are normalized and match the open chatgpt.com tab', async () => {
      const count = await chatgptTabCount();
      const reply = await core.focusOrOpen(`https://chat.openai.com/c/${convId(1).toUpperCase()}/?model=x#top`);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.mode, 'focused');
      assert.equal(reply.data.url, convUrl(1));
      assert.equal(await chatgptTabCount(), count);
    });

    await step('focus_or_open: a load that ends on the sign-in page is reported as urlMatches false', async () => {
      const reply = await core.focusOrOpen(convUrl(5));
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.mode, 'opened');
      assert.equal(reply.data.url, 'https://chatgpt.com/auth/login');
      assert.equal(reply.data.urlMatches, false);
      assert.match(reply.data.note, /different address/);
    });

    await step('focus_or_open: a page that redirects from script right after load is also reported as urlMatches false', async () => {
      const reply = await core.focusOrOpen(convUrl(6));
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.url, 'https://chatgpt.com/auth/login');
      assert.equal(reply.data.urlMatches, false);
    });

    await step('focus_or_open: a load that fails at the network is not claimed to match', async () => {
      const reply = await core.focusOrOpen(convUrl(7));
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.mode, 'opened');
      // The browser reports the requested address for its own error page, so only the title gives it away.
      console.log(`        observed: url=${reply.data.url} title=${JSON.stringify(reply.data.title)} urlMatches=${reply.data.urlMatches}`);
      assert.equal(reply.data.urlMatches, false);
      assert.match(reply.data.note, /error page/);
    });

    await step('focus_or_open: two simultaneous requests for a new conversation open one tab', async () => {
      const count = await chatgptTabCount();
      const [first, second] = await Promise.all([core.focusOrOpen(convUrl(9)), core.focusOrOpen(convUrl(9))]);
      assert.equal(first.ok && second.ok, true);
      assert.deepEqual([first.data.mode, second.data.mode], ['opened', 'focused']);
      assert.equal(first.data.tabId, second.data.tabId);
      assert.equal(await chatgptTabCount(), count + 1);
    });

    await step('focus_or_open: refused addresses get a plain error and change nothing', async () => {
      const count = (await snapshot()).tabs.length;
      const hitsBefore = standIn.requests.length;
      for (const bad of ['https://example.com/c/' + convId(1), `http://chatgpt.com/c/${convId(1)}`, 'javascript:alert(1)', 'https://chatgpt.com.evil.example/c/' + convId(1), '']) {
        const reply = await core.focusOrOpen(bad);
        assert.equal(reply.ok, false, `${bad} must be refused`);
        assert.equal(typeof reply.error, 'string');
        assert.ok(reply.error.length > 5);
        assert.equal(reply.data, undefined);
      }
      const unknown = await core.request({ kind: 'close_all_tabs' });
      assert.equal(unknown.ok, false);
      assert.equal((await snapshot()).tabs.length, count);
      assert.equal(standIn.requests.length, hitsBefore);
    });

    await step('list_chatgpt_tabs: returns BridgeTabInfo for ChatGPT tabs and nothing else', async () => {
      const reply = await core.request({ kind: 'list_chatgpt_tabs' });
      assert.equal(reply.ok, true);
      const snap = await snapshot();
      const expected = snap.tabs.filter((t) => STAND_IN_HOSTS.includes(new URL(t.url || 'about:blank').hostname));
      assert.ok(expected.length >= 6);
      assert.equal(reply.data.length, expected.length);
      for (const info of reply.data) {
        assert.deepEqual(Object.keys(info).sort(), ['active', 'tabId', 'title', 'url', 'windowId']);
        const match = expected.find((t) => t.id === info.tabId);
        assert.ok(match, `tab ${info.tabId} is a ChatGPT tab`);
        assert.deepEqual({ windowId: info.windowId, url: info.url, active: info.active }, { windowId: match.windowId, url: match.url, active: match.active });
      }
      assert.ok(!reply.data.some((i) => i.url.startsWith('chrome-extension://')), 'the options page is not listed');
    });

    await step('focus_or_open: a page that never answers is given up on after 15 seconds, with a note', async () => {
      const started = Date.now();
      const reply = await core.focusOrOpen(convUrl(8), 40_000);
      const elapsed = Date.now() - started;
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.mode, 'opened');
      assert.equal(reply.data.urlMatches, false);
      assert.match(reply.data.note, /15 seconds/);
      assert.ok(elapsed >= 15_000 && elapsed < 17_500, `answered after ${elapsed} ms`);
      await inWorker((id) => chrome.tabs.remove(id), reply.data.tabId);
    });

    // ---- the extension did not touch the pages ----------------------------------------------------------------------
    await step('no content script ran: the pages are exactly what the server sent and no extension world exists in them', async () => {
      const expectedHtml = (n) => `<html lang="en"><head><meta charset="utf-8"><title>Conversation ${n}</title></head><body><main id="conversation">Conversation ${n}</main></body></html>`;
      const pageFor = (n) => context.pages().find((p) => p.url() === convUrl(n));
      const checked = [[pageFor(1), 1], [pageFor(2), 2], [pageFor(4), 4]];
      for (const [page, n] of checked) {
        assert.ok(page, `a page for conversation ${n}`);
        assert.equal(await page.evaluate(() => document.documentElement.outerHTML), expectedHtml(n));
        assert.deepEqual(await page.evaluate(() => document.documentElement.getAttributeNames()), ['lang']);
        const worlds = [];
        const cdp = await context.newCDPSession(page);
        cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
        await cdp.send('Runtime.enable');
        await page.reload();
        await sleep(300);
        assert.ok(worlds.length >= 1, 'the probe sees execution contexts');
        const fromExtensions = worlds.filter((w) => String(w.origin).startsWith('chrome-extension://') || w.name === loadedManifest.name);
        assert.deepEqual(fromExtensions, [], `conversation ${n}: no extension execution context`);
        assert.equal(await page.evaluate(() => document.documentElement.outerHTML), expectedHtml(n));
        await cdp.detach();
      }
    });

    await step('the detector above works: a control extension with a content script is caught by the same checks', async () => {
      const control = path.join(tmp, 'control-extension');
      fs.cpSync(extDir, control, { recursive: true });
      const manifest = JSON.parse(fs.readFileSync(path.join(control, 'manifest.json'), 'utf8'));
      manifest.name = 'Control Content Script';
      manifest.content_scripts = [{ matches: ['https://chatgpt.com/*'], js: ['control-content-script.js'], run_at: 'document_start' }];
      fs.writeFileSync(path.join(control, 'manifest.json'), JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(control, 'control-content-script.js'), "document.documentElement.setAttribute('data-control-marker', '1');");
      const controlContext = await launch(control, 'control');
      const page = await controlContext.newPage();
      const worlds = [];
      const cdp = await controlContext.newCDPSession(page);
      cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
      await cdp.send('Runtime.enable');
      await page.goto(convUrl(1));
      await sleep(300);
      assert.deepEqual(await page.evaluate(() => document.documentElement.getAttributeNames()), ['lang', 'data-control-marker']);
      assert.equal(worlds.filter((w) => String(w.origin).startsWith('chrome-extension://') && w.name === 'Control Content Script').length, 1);
      await controlContext.close();
    });

    // ---- connection behaviour ---------------------------------------------------------------------------------------
    await step('reconnect: when the core drops the socket the extension says hello again within a few seconds and keeps working', async () => {
      const hellosBefore = core.hellos.length;
      const token = core.hellos[0].token;
      core.dropCurrent();
      await waitFor(() => core.hellos.length === hellosBefore + 1 && core.current, { what: 'a new hello', timeout: 10_000 });
      assert.equal(core.hellos.at(-1).token, token);
      assert.equal(core.hellos.at(-1).origin, `chrome-extension://${extensionId}`);
      await waitFor(async () => (await status()) === 'Connected', { what: 'status back to Connected' });
      const reply = await core.request({ kind: 'list_chatgpt_tabs' });
      assert.equal(reply.ok, true);
    });

    await step('revoked: close code 4003 clears the token, shows the unpaired message and stops reconnecting', async () => {
      const connectionsBefore = core.connections.length;
      core.revokeCurrent();
      await waitFor(async () => (await status()) === 'This browser was unpaired in Mini-Summa', { what: 'the unpaired message', timeout: 10_000 });
      const stored = await inWorker(() => chrome.storage.local.get(['token', 'deviceId', 'revokedAt']));
      assert.ok(stored.token == null, 'the token was cleared');
      assert.equal(typeof stored.revokedAt, 'number');
      await waitFor(async () => (await inWorker(() => chrome.alarms.get('minisumma-heartbeat'))) == null, { what: 'the heartbeat alarm to be removed' });
      assert.equal(await options.isVisible('#pair'), true, 'the pairing form is back');
      await shot(options, '4-unpaired-by-mini-summa');
      await sleep(2500); // the first retry would come after 500 ms
      assert.equal(core.connections.length, connectionsBefore, 'no reconnect attempt after a revocation');
    });

    await step('pairing again after a revocation connects with a new token', async () => {
      const offer = core.createOffer();
      await options.fill('#offer-id', offer.id);
      await options.fill('#code', offer.code);
      await options.click('#pair');
      await waitFor(async () => (await status()) === 'Connected', { what: 'Connected again', timeout: 20_000 });
      assert.equal(core.hellos.length >= 3, true);
      assert.notEqual(core.hellos.at(-1).token, core.hellos[0].token);
      const reply = await core.request({ kind: 'list_chatgpt_tabs' });
      assert.equal(reply.ok, true);
    });

    await step('unpair: the extension forgets the token and closes the connection', async () => {
      await options.click('#unpair');
      await waitFor(async () => (await status()) === 'Not paired', { what: 'Not paired' });
      await waitFor(() => core.current === null, { what: 'the socket to close' });
      await waitFor(async () => (await inWorker(() => chrome.alarms.get('minisumma-heartbeat'))) == null, { what: 'the heartbeat alarm to be removed' });
      assert.ok((await inWorker(() => chrome.storage.local.get(['token']))).token == null);
    });

    await step('nothing but the stand-in and the fake core was contacted', async () => {
      const hosts = new Set(standIn.requests.map((r) => r.host));
      for (const h of hosts) assert.ok(STAND_IN_HOSTS.includes(h), `unexpected host ${h}`);
      for (const c of core.connections) assert.equal(c.host, `127.0.0.1:${core.port}`);
    });

    if (consoleProblems.length) console.log(`  note  uncaught errors seen in the browser: ${JSON.stringify(consoleProblems)}`);
  } catch (error) {
    failure = error;
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await core.stop().catch(() => undefined);
    await standIn.stop().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed${failure && !failed.length ? ` (aborted: ${failure.message})` : ''}`);
  if (failure) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
