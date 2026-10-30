// Pieces shared by the real browser tests: waiting, finding Chromium, and the fake Mini-Summa core.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor(fn, { timeout = 15_000, interval = 100, what = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try { const value = await fn(); if (value) return value; last = value; } catch (error) { last = error; }
    if (Date.now() - start > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(interval);
  }
}

export function findChromium() {
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

// ------------------------------------------------------------------------------------------------------------------
// The fake Mini-Summa core: pairing endpoint and WebSocket, deliberately without any CORS header.

export class FakeCore {
  offers = new Map(); // offerId -> code
  redeemCalls = [];
  preflights = 0;
  hellos = [];
  /** Wall clock time (ms) of every `ping` the extension sent. */
  pings = [];
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
        if (msg.t === 'ping') { this.pings.push(Date.now()); ws.send(JSON.stringify({ t: 'pong' })); }
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

export const STAND_IN_HOSTS = ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'];
// Conversation ids are valid uuids: n=3 gives 33333333-3333-4333-8333-333333333333.
export const convId = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
export const convUrl = (n) => `https://chatgpt.com/c/${convId(n)}`;

// ------------------------------------------------------------------------------------------------------------------
// The stand-in for ChatGPT: https://chatgpt.com/... served from 127.0.0.1 with a throwaway self-signed certificate.

export function makeCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=chatgpt.com', '-addext', `subjectAltName=${STAND_IN_HOSTS.map((h) => `DNS:${h}`).join(',')}`], { stdio: 'pipe' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

export const standInHtml = (title, text, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main id="conversation">${text}</main>${extra}</body></html>`;

export class StandIn {
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
