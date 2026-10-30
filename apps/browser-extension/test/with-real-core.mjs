// The extension in a real browser against the REAL Mini-Summa core (packages/core, headless runner), not the fake one.
//
//   node apps/browser-extension/build.mjs --test-hosts
//   xvfb-run -a node apps/browser-extension/test/with-real-core.mjs
//
// It starts `packages/core/src/cli.ts` as a child process on a free port with a temporary data directory, turns on
// "external browser through the extension", maps a project conversation to https://chatgpt.com/c/<id> (served by the local
// stand-in, see real-browser.mjs for how the real site is kept unreachable), pairs the extension by pasting the core's own
// `qrPayload` into the settings page, and then uses the core's own route POST /conversations/:id/open. What the core
// answers is the result the rest of Mini-Summa would see. Finally it removes the device in the core and watches the
// extension notice.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { STAND_IN_HOSTS, StandIn, convId, convUrl, findChromium, makeCertificate, sleep, waitFor } from './support.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const extDir = path.resolve(process.env.MINISUMMA_EXT_DIR ?? path.join(here, '..', 'dist'));

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name} (${Date.now() - started} ms)`); } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${String(error?.stack ?? error).split('\n').join('\n        ')}`);
    throw error;
  }
}

async function startCore(dataDir) {
  const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, path.join(repoRoot, 'packages', 'core', 'src', 'cli.ts'), '--data-dir', dataDir, '--port', '0', '--print-connection'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: repoRoot });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  const line = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (d) => { buffer += String(d); const i = buffer.indexOf('\n'); if (i >= 0) resolve(buffer.slice(0, i)); });
    child.once('exit', (code) => reject(new Error(`the core exited with ${code} before it was ready:\n${stderr}`)));
    setTimeout(() => reject(new Error(`the core did not become ready in 60 s:\n${stderr}`)), 60_000);
  });
  const { baseUrl, desktopToken } = JSON.parse(line);
  const call = async (method, route, body) => {
    const res = await fetch(`${baseUrl}/api/v1${route}`, {
      method, headers: { authorization: `Bearer ${desktopToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text}`);
    return json;
  };
  return { child, baseUrl, call, stderr: () => stderr, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }) };
}

async function main() {
  if (!fs.existsSync(path.join(extDir, 'manifest.json'))) { console.error(`No built extension in ${extDir}. Run: node apps/browser-extension/build.mjs --test-hosts`); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minisumma-real-core-'));
  const standIn = new StandIn();
  let core = null;
  let context = null;
  let failure = null;
  try {
    await standIn.start(makeCertificate(tmp));
    core = await startCore(path.join(tmp, 'core-data'));
    console.log(`Core:      ${core.baseUrl} (packages/core headless runner)\nExtension: ${extDir}`);
    const rules = [...STAND_IN_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${standIn.port}`), 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost'].join(', ');
    context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
      executablePath: findChromium(), headless: false, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--host-resolver-rules=${rules}`, '--ignore-certificate-errors', '--no-proxy-server', '--disable-quic', '--no-first-run', '--no-default-browser-check'],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;
    const inWorker = async (fn, arg) => (await waitFor(() => context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`)))).evaluate(fn, arg);
    const tabsShowing = async (url) => (await inWorker(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url ?? '', active: t.active, windowId: t.windowId })))).filter((t) => t.url === url);

    // Canary: nothing outside this machine may resolve.
    const canary = await context.newPage();
    const canaryError = await canary.goto('https://example.com/').then(() => 'loaded', (e) => String(e.message));
    assert.match(canaryError, /ERR_NAME_NOT_RESOLVED/);
    await canary.close();

    let project; let conversation1; let conversation2; let deviceId;
    await step('the core is set to open links through the extension and has two mapped conversations', async () => {
      const settings = await core.call('PATCH', '/settings', { chatgpt: { mode: 'external', externalBrowser: 'extension' } });
      assert.deepEqual([settings.chatgpt.mode, settings.chatgpt.externalBrowser], ['external', 'extension']);
      project = await core.call('POST', '/projects', { name: 'Extension integration' });
      conversation1 = await core.call('POST', `/projects/${project.id}/conversations`, { url: convUrl(1), title: 'One' });
      conversation2 = await core.call('POST', `/projects/${project.id}/conversations`, { url: convUrl(2), title: 'Two' });
      assert.equal(conversation1.url, convUrl(1));
    });

    const before = await core.call('POST', `/conversations/${conversation1.id}/open`);
    await step('without a paired extension the core says so plainly and opens nothing', async () => {
      assert.equal(before.ok, false);
      assert.equal(before.focused, false);
      assert.equal(before.opened, false);
      assert.ok((before.note ?? '').length > 10, 'a plain sentence explains it');
      console.log(`        core said: ${before.note}`);
      assert.equal((await tabsShowing(convUrl(1))).length, 0);
    });

    const options = await context.newPage();
    const status = async () => (await options.textContent('#status-headline'))?.trim();
    await step('pairing: the core\'s own pairing link, pasted into the settings page, connects the extension', async () => {
      const offer = await core.call('POST', '/pairing/offers', { kind: 'extension' });
      assert.match(offer.qrPayload, /^minisumma:\/\/pair\?/);
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await waitFor(async () => (await status()) === 'Not paired', { what: 'Not paired' });
      await options.fill('#link', offer.qrPayload);
      assert.equal(await options.inputValue('#offer-id'), offer.id, 'the link filled in the offer id');
      assert.match(await options.inputValue('#core-url'), /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'and a loopback address from the link');
      await options.click('#pair');
      await waitFor(async () => (await status()) === 'Connected', { what: 'Connected', timeout: 20_000 });
      const devices = await core.call('GET', '/devices');
      const mine = devices.filter((d) => d.platform === 'extension');
      assert.equal(mine.length, 1, JSON.stringify(devices));
      assert.deepEqual(mine[0].scopes, ['extension']);
      deviceId = mine[0].id;
    });

    await step('the core opens a mapped conversation through the extension: a tab appears and the core reports what the extension reported', async () => {
      const result = await core.call('POST', `/conversations/${conversation1.id}/open`);
      console.log(`        core answered: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.equal(result.mode, 'extension');
      assert.equal(result.opened, true);
      assert.equal(result.focused, true);
      assert.equal(result.verified, true);
      assert.equal(result.finalUrl, convUrl(1));
      assert.equal((await tabsShowing(convUrl(1))).length, 1);
    });

    await step('opening a second conversation and then the first again focuses the existing tab instead of opening another', async () => {
      const second = await core.call('POST', `/conversations/${conversation2.id}/open`);
      assert.equal(second.opened, true);
      const first = (await tabsShowing(convUrl(1)))[0];
      const secondTab = (await tabsShowing(convUrl(2)))[0];
      assert.equal(secondTab.active, true);
      assert.equal(first.active, false);
      const again = await core.call('POST', `/conversations/${conversation1.id}/open`);
      console.log(`        core answered: ${JSON.stringify(again)}`);
      assert.equal(again.ok, true);
      assert.equal(again.opened, false);
      assert.equal(again.focused, true);
      assert.equal(again.verified, true);
      assert.equal((await tabsShowing(convUrl(1))).length, 1, 'still exactly one tab for conversation 1');
      assert.equal((await tabsShowing(convUrl(1)))[0].active, true);
      assert.equal(standIn.hits(`/c/${convId(1)}`), 1, 'conversation 1 was fetched once');
    });

    await step('a mapped conversation whose page ends on the sign-in page is reported as not verified', async () => {
      const conversation5 = await core.call('POST', `/projects/${project.id}/conversations`, { url: convUrl(5), title: 'Five' });
      const result = await core.call('POST', `/conversations/${conversation5.id}/open`);
      console.log(`        core answered: ${JSON.stringify(result)}`);
      assert.equal(result.opened, true);
      assert.equal(result.verified, false);
      assert.equal(result.finalUrl, 'https://chatgpt.com/auth/login');
    });

    await step('a page that never answers: whatever the core reports, it must not claim the conversation was verified', async () => {
      const conversation8 = await core.call('POST', `/projects/${project.id}/conversations`, { url: convUrl(8), title: 'Eight' });
      const started = Date.now();
      const result = await core.call('POST', `/conversations/${conversation8.id}/open`);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      // Informational: the extension waits up to 15 s for a load, the core's bridge timeout is its own setting.
      console.log(`        after ${seconds} s the core answered: ${JSON.stringify(result)}`);
      assert.notEqual(result.verified, true);
      assert.ok((result.note ?? '').length > 10 || result.ok === false);
      await sleep(12_000); // let the extension's own answer arrive late, which the core must ignore without trouble
      const again = await core.call('POST', `/conversations/${conversation1.id}/open`);
      assert.equal(again.ok, true, 'the connection is still healthy afterwards');
    });

    await step('removing the device in the core makes the extension say it was unpaired, and it does not come back', async () => {
      await core.call('DELETE', `/devices/${deviceId}`);
      await waitFor(async () => (await status()) === 'This browser was unpaired in Mini-Summa', { what: 'the unpaired message', timeout: 15_000 });
      const stored = await inWorker(() => chrome.storage.local.get(['token']));
      assert.ok(stored.token == null);
      await sleep(2000);
      assert.equal(await status(), 'This browser was unpaired in Mini-Summa');
      const result = await core.call('POST', `/conversations/${conversation1.id}/open`);
      assert.equal(result.ok, false);
      assert.equal(result.opened, false);
      assert.ok((result.note ?? '').length > 10);
    });
  } catch (error) {
    failure = error;
    if (core) console.log(`--- core log (last lines) ---\n${core.stderr().split('\n').slice(-15).join('\n')}`);
  } finally {
    await context?.close().catch(() => undefined);
    await core?.stop().catch(() => undefined);
    await standIn.stop().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed${failure && results.every((r) => r.ok) ? ` (aborted: ${failure.message})` : ''}`);
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
