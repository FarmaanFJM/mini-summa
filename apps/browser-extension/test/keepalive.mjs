// Does the Manifest V3 service worker stay alive while the extension is connected?
//
//   node apps/browser-extension/build.mjs --test-hosts
//   xvfb-run -a node apps/browser-extension/test/keepalive.mjs          (takes about two minutes)
//
// This is a separate script because a test framework changes the answer: DevTools (and so Playwright) keeps a service
// worker it is attached to alive, so a Playwright run can never see Chrome stop an idle worker. Here Chromium is started
// directly and driven over the DevTools protocol, attaching only to the settings page (which is closed again before the
// observation starts) and never to the service worker.
//
// Two browsers run at the same time:
//   control  the extension, not paired: nothing keeps it busy. Chrome must stop its worker. If it does not, this harness
//            cannot tell "kept alive" from "never stopped", and the script says so instead of passing.
//   paired   the extension paired with a fake core. Its worker must keep running, the one connection must never be
//            replaced (a stopped worker would reconnect with a new hello), and pings must arrive at least every 27 s.
// Only loopback is reachable: --host-resolver-rules maps every other name to "not found".
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { CANARY_EXPECTED, CANARY_URL, FakeCore, LOOPBACK_HOSTS, findChromium, isolationFailure, sleep, waitFor } from './support.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(process.env.MINISUMMA_EXT_DIR ?? path.join(here, '..', 'dist'));
const observeSeconds = Number(process.env.MINISUMMA_KEEPALIVE_SECONDS ?? 100);

/** Chrome derives the id of an unpacked extension from its folder: sha256 of the path, first 128 bits, hex digits a to p.
 *  A directly started browser also runs component extensions with their own workers, so the id is how ours is found. */
function unpackedExtensionId(dir) {
  const hex = crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}
const extensionId = unpackedExtensionId(extDir);

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.nextId = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const p = msg.id ? this.pending.get(msg.id) : null;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.ws.close(); }
}

async function startBrowser(chromePath, tmp, tag) {
  const profile = fs.mkdtempSync(path.join(tmp, `profile-${tag}-`));
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-quic',
    `--host-resolver-rules=${['MAP * ~NOTFOUND', ...LOOPBACK_HOSTS.map((h) => `EXCLUDE ${h}`)].join(', ')}`,
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), // the container runs as root
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const text = await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim().split('\n').length >= 2 && fs.readFileSync(portFile, 'utf8'), { what: `${tag}: the DevTools port file`, timeout: 30_000 });
  const [port, browserPath] = text.trim().split('\n');
  const cdp = new Cdp(`ws://127.0.0.1:${port}${browserPath}`);
  await cdp.open();
  // Fail closed, before anything else: a public name must not resolve in this browser. If the resolver rules are missing
  // or ignored, stop here. (This script never opens a ChatGPT address; the check is the same one the other scripts make.)
  const { targetId: canaryTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: canarySession } = await cdp.send('Target.attachToTarget', { targetId: canaryTarget, flatten: true });
  const canary = await cdp.send('Page.navigate', { url: CANARY_URL }, canarySession);
  await cdp.send('Target.closeTarget', { targetId: canaryTarget }).catch(() => undefined);
  if (!CANARY_EXPECTED.test(canary.errorText ?? 'loaded')) { child.kill('SIGKILL'); throw isolationFailure(canary.errorText ?? 'loaded'); }
  const workerTarget = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && new URL(t.url).host === extensionId) ?? null;
  };
  await waitFor(workerTarget, { what: `${tag}: the extension service worker (id ${extensionId})`, timeout: 30_000 });
  return { child, cdp, workerTarget };
}

async function main() {
  if (!fs.existsSync(path.join(extDir, 'manifest.json'))) { console.error(`No built extension in ${extDir}. Run: node apps/browser-extension/build.mjs --test-hosts`); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minisumma-keepalive-'));
  const chromePath = findChromium();
  const core = new FakeCore();
  await core.start();
  const browsers = [];
  let failure = null;
  try {
    console.log(`Chromium:  ${chromePath}\nExtension: ${extDir}\nObserving for ${observeSeconds} s`);
    const [control, paired] = await Promise.all([startBrowser(chromePath, tmp, 'control'), startBrowser(chromePath, tmp, 'paired')]);
    browsers.push(control, paired);
    const startedControl = Date.now();

    // Pair the second browser through its real settings page, then leave the page so nothing else talks to the worker.
    const offer = core.createOffer();
    const { targetId } = await paired.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await paired.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const navigated = await paired.cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, sessionId);
    assert.equal(navigated.errorText, undefined, `the settings page did not open: ${navigated.errorText}`);
    const pageText = async () => (await paired.cdp.send('Runtime.evaluate', { expression: "document.getElementById('status-headline')?.textContent ?? ('no page yet: ' + location.href + ' ' + document.readyState)", returnByValue: true }, sessionId)).result.value;
    await waitFor(async () => (await pageText()) === 'Not paired', { what: 'the settings page to say "Not paired"' }).catch(async (e) => { throw new Error(`${e.message}; the page says ${JSON.stringify(await pageText())}`); });
    await paired.cdp.send('Runtime.evaluate', {
      expression: `(() => { const set = (id, v) => { document.getElementById(id).value = v; };
        set('core-url', ${JSON.stringify(core.url)}); set('offer-id', ${JSON.stringify(offer.id)}); set('code', ${JSON.stringify(offer.code)});
        document.getElementById('pair-form').requestSubmit(); })()`,
    }, sessionId);
    await waitFor(() => core.hellos.length === 1 && core.current, { what: 'the paired extension to say hello', timeout: 20_000 });
    await paired.cdp.send('Target.detachFromTarget', { sessionId });
    await paired.cdp.send('Target.closeTarget', { targetId });
    const connectedAt = Date.now();
    console.log(`paired and connected; settings page closed (${Math.round((connectedAt - startedControl) / 1000)} s after launch)`);

    // Observe both browsers.
    let controlStoppedAt = null;
    let pairedMissing = 0;
    const deadline = connectedAt + observeSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (controlStoppedAt === null && !(await control.workerTarget())) controlStoppedAt = Date.now();
      if (!(await paired.workerTarget())) pairedMissing += 1;
    }
    // The control may need a little longer than the paired run is observed; give it up to 75 s after launch.
    while (controlStoppedAt === null && Date.now() - startedControl < 75_000) {
      await sleep(2000);
      if (!(await control.workerTarget())) controlStoppedAt = Date.now();
    }

    const pings = core.pings.filter((t) => t >= connectedAt);
    const gaps = pings.slice(1).map((t, i) => (t - pings[i]) / 1000);
    const sincePair = (core.pings.length ? (Date.now() - connectedAt) / 1000 : 0);
    console.log(`control (not paired): worker ${controlStoppedAt ? `stopped by the browser ${Math.round((controlStoppedAt - startedControl) / 1000)} s after launch` : 'still running after 75 s'}`);
    console.log(`paired: worker missing in ${pairedMissing} samples; hellos ${core.hellos.length}; connections ${core.connections.length}; pings ${pings.length} in ${Math.round(sincePair)} s; largest gap ${gaps.length ? Math.max(...gaps).toFixed(1) : 'n/a'} s`);

    assert.ok(controlStoppedAt, 'inconclusive: Chrome never stopped the idle control worker, so this harness cannot show that anything keeps a worker alive');
    assert.equal(pairedMissing, 0, 'the connected worker was stopped by the browser');
    assert.equal(core.hellos.length, 1, 'the connection was replaced (a stopped worker comes back with a new hello)');
    assert.equal(core.connections.length, 1);
    assert.ok(pings.length >= Math.floor(observeSeconds / 27), `expected a ping about every 25 s, saw ${pings.length}`);
    assert.ok(gaps.every((g) => g <= 27), `a gap between pings was longer than 27 s: ${gaps.join(', ')}`);
    console.log('PASS: the idle worker is stopped, the connected worker is not');
  } catch (error) {
    failure = error;
    console.log(`FAIL: ${error?.message ?? error}`);
  } finally {
    for (const b of browsers) { b.cdp.close(); b.child.kill('SIGKILL'); }
    await core.stop().catch(() => undefined);
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
