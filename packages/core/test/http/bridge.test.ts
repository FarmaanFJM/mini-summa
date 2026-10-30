import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@minisumma/shared';
import { resultOfReply } from '../../src/http/bridge.ts';
import { connectWs, openWs, sleep, startHarness } from './harness.ts';
import type { Harness, HarnessOptions, WsClient } from './harness.ts';

let h: Harness | null = null;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await h?.stop();
  h = null;
});
async function boot(opts: HarnessOptions = {}): Promise<Harness> { h = await startHarness(opts); return h; }
async function connect(hh: Harness, token: string, opts: { origin?: string } = {}) {
  const r = await connectWs(hh, token, {}, opts);
  clients.push(r.client);
  return r.client;
}

const url = 'https://chatgpt.com/c/6a1b2c3d-1111-2222-3333-444455556666';
type BridgeRequest = Extract<ServerMessage, { t: 'bridge.request' }>;
const nextRequest = (c: WsClient) => c.nextOfType('bridge.request') as Promise<BridgeRequest>;
const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describe('extension bridge', () => {
  it('says plainly that no extension is connected', async () => {
    const hh = await boot();
    expect(hh.server.extensionBridge.connected()).toBe(false);
    const res = await hh.server.extensionBridge.openOrFocus(url);
    expect(res).toMatchObject({ ok: false, mode: 'none', opened: false, focused: false, verified: null, finalUrl: null, title: null });
    expect(res.note).toMatch(/No browser extension is connected/);
  });

  it('works before the server has started', async () => {
    const hh = await boot({ noStart: true });
    expect(hh.server.extensionBridge.connected()).toBe(false);
    expect((await hh.server.extensionBridge.openOrFocus(url)).ok).toBe(false);
    await hh.start();
  });

  it('round trip: asks the extension, and reports only what the extension reported', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension, { origin: ext });
    expect(hh.server.extensionBridge.connected()).toBe(true);
    const pending = hh.server.extensionBridge.openOrFocus(url);
    const req = await nextRequest(extension);
    expect(req.action).toEqual({ kind: 'focus_or_open', url });
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    extension.send({ t: 'bridge.result', requestId: req.requestId, ok: true, data: { focused: true, opened: false, verified: true, url, title: 'Roadmap chat' } });
    expect(await pending).toEqual({ ok: true, mode: 'extension', opened: false, focused: true, verified: true, finalUrl: url, title: 'Roadmap chat', note: null });
  });

  it('does not claim a focus, an open or a verification the extension did not report', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    const pending = hh.server.extensionBridge.openOrFocus(url);
    const req = await nextRequest(extension);
    extension.send({ t: 'bridge.result', requestId: req.requestId, ok: true });
    const res = await pending;
    expect(res).toMatchObject({ ok: true, mode: 'extension', opened: false, focused: false, verified: null, finalUrl: null, title: null });
    expect(res.note).toMatch(/cannot tell which page is showing/);
  });

  it('keeps the extension own wording when it fails', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    const pending = hh.server.extensionBridge.openOrFocus(url);
    const req = await nextRequest(extension);
    extension.send({ t: 'bridge.result', requestId: req.requestId, ok: false, error: 'The browser has no window open.' });
    expect(await pending).toMatchObject({ ok: false, mode: 'extension', opened: false, focused: false, note: 'The browser has no window open.' });
  });

  it('gives up after the timeout and says so', async () => {
    const hh = await boot({ tuning: { bridgeTimeoutMs: 150 } });
    const extension = await connect(hh, hh.tokens.extension);
    const started = Date.now();
    const res = await hh.server.extensionBridge.openOrFocus(url);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(res).toMatchObject({ ok: false, mode: 'extension', opened: false, focused: false });
    expect(res.note).toMatch(/did not answer within 0\.2 seconds/);
    await nextRequest(extension);
    // a late answer is ignored and harmless
    extension.send({ t: 'bridge.result', requestId: 'whatever', ok: true });
    extension.send({ t: 'ping' });
    await extension.nextOfType('pong');
  });

  it('waits 5 seconds by default', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    const started = Date.now();
    const res = await hh.server.extensionBridge.openOrFocus(url);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThan(6500);
    expect(res).toMatchObject({ ok: false, mode: 'extension' });
    expect(res.note).toMatch(/did not answer within 5 seconds/);
    await nextRequest(extension);
  }, 15_000);

  it('fails fast when the extension disconnects before answering', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    const pending = hh.server.extensionBridge.openOrFocus(url);
    await nextRequest(extension);
    extension.ws.terminate();
    const res = await pending;
    expect(res).toMatchObject({ ok: false, mode: 'extension' });
    expect(res.note).toMatch(/disconnected/);
    await sleep(50);
    expect(hh.server.extensionBridge.connected()).toBe(false);
  });

  it('asks the most recent extension connection, and falls back when it goes away', async () => {
    const hh = await boot();
    const first = await connect(hh, hh.tokens.extension);
    const second = await connect(hh, hh.tokens.readExtension);
    const p1 = hh.server.extensionBridge.openOrFocus(url);
    const r1 = await nextRequest(second);
    second.send({ t: 'bridge.result', requestId: r1.requestId, ok: true, data: { opened: true } });
    expect((await p1).opened).toBe(true);
    expect(first.messages.some((m) => m.t === 'bridge.request')).toBe(false);

    second.close();
    await second.waitClosed();
    await sleep(50);
    expect(hh.server.extensionBridge.connected()).toBe(true);
    const p2 = hh.server.extensionBridge.openOrFocus(url);
    const r2 = await nextRequest(first);
    first.send({ t: 'bridge.result', requestId: r2.requestId, ok: true, data: { focused: true } });
    expect((await p2).focused).toBe(true);
  });

  it('ignores an answer from a connection that was not asked', async () => {
    const hh = await boot({ tuning: { bridgeTimeoutMs: 300 } });
    const older1 = await connect(hh, hh.tokens.readExtension);
    const older2 = await connect(hh, hh.tokens.extension);
    const target = await connect(hh, hh.tokens.readExtension); // the most recent connection is the one that is asked
    const pending = hh.server.extensionBridge.openOrFocus(url);
    const req = await nextRequest(target);
    older1.send({ t: 'bridge.result', requestId: req.requestId, ok: true, data: { opened: true } });
    older2.send({ t: 'bridge.result', requestId: req.requestId, ok: true, data: { opened: true } });
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.opened).toBe(false);
    expect(res.note).toMatch(/did not answer/);
  });

  it('refuses bridge results from a connection without the extension scope', async () => {
    const hh = await boot();
    const phone = await connect(hh, hh.tokens.read);
    phone.send({ t: 'bridge.result', requestId: 'x', ok: true });
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'forbidden' });
    expect(phone.closed).toBeNull();
  });

  it('does not register the desktop or a phone as an extension', async () => {
    const hh = await boot();
    await connect(hh, hh.tokens.desktop);
    await connect(hh, hh.tokens.read);
    expect(hh.server.extensionBridge.connected()).toBe(false);
  });

  it('stops using a connection that loses the extension scope', async () => {
    const hh = await boot();
    await connect(hh, hh.tokens.readExtension);
    expect(hh.server.extensionBridge.connected()).toBe(true);
    hh.devices.update('dev-readext', { scopes: ['read'] });
    expect(hh.server.extensionBridge.connected()).toBe(false);
  });

  it('refuses addresses that are not ChatGPT conversations and sends nothing to the extension', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    for (const bad of ['https://evil.example/c/6a1b2c3d-1111-2222-3333-444455556666', 'javascript:alert(1)', 'http://chatgpt.com/c/x', 'file:///etc/passwd', '', 'not a url']) {
      const res = await hh.server.extensionBridge.openOrFocus(bad);
      expect(res, bad).toMatchObject({ ok: false, mode: 'extension', opened: false });
    }
    await sleep(50);
    expect(extension.messages.some((m) => m.t === 'bridge.request')).toBe(false);
  });

  it('sends the canonical address to the extension', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    const pending = hh.server.extensionBridge.openOrFocus('https://chat.openai.com/c/6A1B2C3D-1111-2222-3333-444455556666?model=x#frag');
    const req = await nextRequest(extension);
    expect(req.action).toEqual({ kind: 'focus_or_open', url: 'https://chatgpt.com/c/6a1b2c3d-1111-2222-3333-444455556666' });
    extension.send({ t: 'bridge.result', requestId: req.requestId, ok: true, data: { opened: true } });
    await pending;
  });

  it('keeps simultaneous requests apart', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    const a = hh.server.extensionBridge.openOrFocus(url);
    const b = hh.server.extensionBridge.openOrFocus('https://chatgpt.com/c/6a1b2c3d-9999-2222-3333-444455556666');
    const ra = await nextRequest(extension);
    const rb = await nextRequest(extension);
    // answer in the opposite order
    extension.send({ t: 'bridge.result', requestId: rb.requestId, ok: true, data: { title: 'B', opened: true } });
    extension.send({ t: 'bridge.result', requestId: ra.requestId, ok: true, data: { title: 'A', focused: true } });
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.title).toBe(ra.action.kind === 'focus_or_open' && ra.action.url === url ? 'A' : 'B');
    expect(resB.title).toBe(resA.title === 'A' ? 'B' : 'A');
  });

  it('an unauthenticated socket cannot answer', async () => {
    const hh = await boot();
    const extension = await connect(hh, hh.tokens.extension);
    const impostor = await openWs(hh);
    clients.push(impostor);
    const pending = hh.server.extensionBridge.openOrFocus(url);
    const req = await nextRequest(extension);
    impostor.send({ t: 'bridge.result', requestId: req.requestId, ok: true, data: { opened: true } });
    expect((await impostor.nextOfType('error')).fatal).toBe(true);
    extension.send({ t: 'bridge.result', requestId: req.requestId, ok: true, data: { focused: true } });
    expect((await pending).focused).toBe(true);
  });
});

describe('resultOfReply', () => {
  it('truncates absurd text and ignores wrongly typed fields', () => {
    const res = resultOfReply({ requestId: 'r', ok: true, data: { focused: 'yes', opened: 1, verified: 'true', url: 42, title: 'T'.repeat(5000), note: ['x'] } });
    expect(res).toMatchObject({ ok: true, focused: false, opened: false, verified: null, finalUrl: null });
    expect(res.title?.length).toBe(2000);
  });
});
