import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { safeSegments } from '../../src/http/static.ts';
import { UI_CSP } from '../../src/http/security.ts';
import { raw, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const SECRET = 'TOP-SECRET-OUTSIDE-THE-UI-DIRECTORY';
let root: string;
let uiDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-ui-'));
  uiDir = path.join(root, 'ui');
  fs.mkdirSync(path.join(uiDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(uiDir, 'sub'));
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>Mini-Summa</title><div id="root"></div>');
  fs.writeFileSync(path.join(uiDir, 'sub', 'index.html'), '<!doctype html><title>Sub</title>');
  fs.writeFileSync(path.join(uiDir, 'assets', 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(uiDir, 'assets', 'style.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(uiDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(uiDir, 'assets', 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(uiDir, 'assets', 'font.woff2'), 'wOF2');
  fs.writeFileSync(path.join(uiDir, 'assets', 'blob.xyz'), 'bytes');
  fs.writeFileSync(path.join(uiDir, '.hidden'), 'dotfile');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(uiDir, 'leak.txt'));
  fs.symlinkSync(root, path.join(uiDir, 'upward'));
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

let h: Harness | null = null;
afterEach(async () => { await h?.stop(); h = null; });
const boot = async (ui: string | null = uiDir) => { h = await startHarness({ uiDir: ui ?? undefined }); return h; };
const get = (hh: Harness, p: string, method = 'GET') => raw(hh.port, { method, path: p });

describe('serving the UI', () => {
  it('redirects / and /ui to /ui/', async () => {
    const hh = await boot();
    for (const p of ['/', '/ui']) {
      const res = await get(hh, p);
      expect(res.status, p).toBe(302);
      expect(res.headers.location).toBe('/ui/');
    }
  });

  it('serves index.html at /ui/ with the strict CSP and the other security headers', async () => {
    const hh = await boot();
    const res = await get(hh, '/ui/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Mini-Summa</title>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toBe(UI_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it.each([
    ['/ui/assets/app.js', 'text/javascript; charset=utf-8'],
    ['/ui/assets/style.css', 'text/css; charset=utf-8'],
    ['/ui/assets/logo.svg', 'image/svg+xml'],
    ['/ui/assets/data.json', 'application/json; charset=utf-8'],
    ['/ui/assets/font.woff2', 'font/woff2'],
    ['/ui/assets/blob.xyz', 'application/octet-stream'],
    ['/ui/index.html', 'text/html; charset=utf-8'],
  ])('serves %s as %s with the CSP on assets too', async (p, type) => {
    const hh = await boot();
    const res = await get(hh, p);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(type);
    expect(res.headers['content-security-policy']).toBe(UI_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.text)));
  });

  it('falls back to index.html for app routes and serves directory indexes', async () => {
    const hh = await boot();
    for (const p of ['/ui/projects/42/sessions', '/ui/settings', '/ui/a/b/c/']) {
      const res = await get(hh, p);
      expect(res.status, p).toBe(200);
      expect(res.text).toContain('<title>Mini-Summa</title>');
    }
    for (const p of ['/ui/sub/', '/ui/sub']) expect((await get(hh, p)).text, p).toContain('<title>Sub</title>');
  });

  it('answers a missing file with a real 404 instead of the app', async () => {
    const hh = await boot();
    const res = await get(hh, '/ui/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.headers['content-security-policy']).toBe(UI_CSP);
  });

  it('answers HEAD like GET without a body, and refuses other methods', async () => {
    const hh = await boot();
    const head = await get(hh, '/ui/', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect((await get(hh, '/ui/', 'POST')).status).toBe(404);
    expect((await get(hh, '/ui/assets/app.js', 'DELETE')).status).toBe(404);
  });

  it('says plainly when there is no UI to serve', async () => {
    const none = await boot(null);
    const res = await get(none, '/ui/');
    expect(res.status).toBe(404);
    expect(res.json().error.code).toBe('ui_not_available');
    await none.stop();
    h = null;
    const missing = await boot(path.join(root, 'does-not-exist'));
    const res2 = await get(missing, '/ui/');
    expect(res2.status).toBe(404);
    expect(res2.json().error.code).toBe('ui_not_available');
  });

  it('does not let the CSP or the UI cache policy leak onto the API', async () => {
    const hh = await boot();
    const res = await raw(hh.port, { path: '/api/v1/health' });
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('no directory traversal', () => {
  // These go over raw HTTP: fetch would normalise the dot segments away before they reached the server.
  const explicit = [
    '/ui/../secret.txt',
    '/ui/%2e%2e/secret.txt',
    '/ui/%2E%2E/secret.txt',
    '/ui/..%2fsecret.txt',
    '/ui/..%2Fsecret.txt',
    '/ui/%2e%2e%2fsecret.txt',
    '/ui/%252e%252e/secret.txt',
    '/ui/%252e%252e%252fsecret.txt',
    '/ui/%25252e%25252e/secret.txt',
    '/ui/assets/../../secret.txt',
    '/ui/assets/..%2f..%2fsecret.txt',
    '/ui/....//secret.txt',
    '/ui/.%2e/secret.txt',
    '/ui/%2e./secret.txt',
    '/ui/..%5csecret.txt',
    '/ui/%5c..%5csecret.txt',
    '/ui/%2e%2e%5csecret.txt',
    '/ui/..;/secret.txt',
    '/ui/%00../secret.txt',
    '/ui/secret.txt%00.png',
    '/ui/%2fetc%2fpasswd',
    '/ui/C:/Windows/win.ini',
    '/ui/%43%3a/Windows/win.ini',
    '/ui/.hidden',
    '/ui/leak.txt',
    '/ui/upward/secret.txt',
    '/ui/CON',
    '/ui/nul.txt',
  ];

  it.each(explicit)('refuses %s and never reveals files outside the UI directory', async (p) => {
    const hh = await boot();
    const res = await get(hh, p);
    expect([400, 403, 404], `${p} gave ${res.status}`).toContain(res.status);
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toMatch(/root:.*:0:0/);
  });

  it.each(['/ui//etc/passwd', '/ui/upward/'])('answers %s with the app itself, which is harmless', async (p) => {
    const hh = await boot();
    // <ui>/etc/passwd does not exist, and <ui>/upward is a symlink to the parent directory, which has no index.html:
    // both are app routes, so the answer is the UI's own index.html and nothing from outside.
    const res = await get(hh, p);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Mini-Summa</title>');
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toMatch(/root:/);
  });

  it('accepts only plain file names in safeSegments', () => {
    expect(safeSegments('/ui/')).toEqual([]);
    expect(safeSegments('/ui/assets/app.js')).toEqual(['assets', 'app.js']);
    expect(safeSegments('/ui/a%20b/c.js')).toEqual(['a b', 'c.js']);
    expect(safeSegments('/ui/caf%C3%A9.js')).toEqual(['café.js']);
    for (const bad of ['/ui/..', '/ui/.', '/ui/a/../b', '/ui/%2e%2e', '/ui/a%2Fb', '/ui/a%5Cb', '/ui/%252e', '/ui/a%00b', '/ui/%zz', '/ui/.env', '/ui/C:', '/ui/aux', '/ui/COM1.txt', '/ui/lpt9']) {
      expect(safeSegments(bad), bad).toBeNull();
    }
  });
});
