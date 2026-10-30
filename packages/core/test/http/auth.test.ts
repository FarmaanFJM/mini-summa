import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPath, routeNames, routes } from '@minisumma/shared';
import type { RouteName, Scope } from '@minisumma/shared';
import type { PushProvider } from '../../src/contracts.ts';
import { api, raw, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';
import { expectedStatus, samples } from './samples.ts';

const fakePush: PushProvider = {
  name: 'fcm', configured: () => true, configureFromJson: () => ({ firebaseProject: 'demo-project' }), clear: () => undefined, send: async () => [],
};

function requestFor(name: RouteName) {
  const def = routes[name];
  const s = samples[name] as { params?: Record<string, string>; body?: unknown };
  const hasBody = def.method !== 'GET' && def.method !== 'DELETE';
  return { method: def.method as string, path: buildPath(def.path, s.params), body: hasBody ? (s.body ?? {}) : undefined };
}

describe('auth matrix over every route of the shared table', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ push: fakePush, tuning: { redeemPerMinute: 1000 } }); });
  afterAll(async () => { await h.stop(); });

  const tokenOf = (scope: Scope): string => h.tokens[scope as 'desktop' | 'read' | 'notify' | 'prompt' | 'approve' | 'extension'];
  const wrongScopeFor = (needed: Scope): Scope => (needed === 'read' ? 'notify' : 'read');

  it('covers every route and every route has a sample', () => {
    expect(Object.keys(samples).sort()).toEqual([...routeNames].sort());
    expect(routeNames.length).toBeGreaterThan(70);
  });

  it.each(routeNames)('%s', async (name) => {
    const def = routes[name];
    const { method, path, body } = requestFor(name);
    if (def.scope === 'public') {
      for (const token of [null, h.tokens.none, h.tokens.read]) {
        const res = await api(h, method, path, { token, body });
        expect(res.status, `${name} public with ${token}`).toBe(200);
      }
      return;
    }
    // no token
    const none = await api(h, method, path, { body });
    expect(none.status, `${name} without token`).toBe(401);
    expect(none.json().error.code).toBe('unauthorized');
    expect(none.headers['www-authenticate']).toBe('Bearer realm="mini-summa"');
    // wrong token
    const wrong = await api(h, method, path, { token: h.tokens.none, body });
    expect(wrong.status, `${name} wrong token`).toBe(401);
    expect(wrong.json().error.code).toBe('unauthorized');
    // a real token without the scope
    const weak = await api(h, method, path, { token: tokenOf(wrongScopeFor(def.scope)), body });
    expect(weak.status, `${name} with a token lacking ${def.scope}`).toBe(403);
    expect(weak.json().error.code).toBe('insufficient_scope');
    expect(weak.json().error.details).toEqual({ needed: def.scope });
    // the right scope reaches the handler
    const ok = await api(h, method, path, { token: tokenOf(def.scope), body });
    expect(ok.status, `${name} with ${def.scope}: ${ok.text}`).toBe(expectedStatus[name] ?? 200);
    // the desktop token may call everything
    if (def.scope !== 'desktop') {
      const owner = await api(h, method, path, { token: h.tokens.desktop, body });
      expect(owner.status, `${name} with the desktop token`).not.toBe(403);
      expect(owner.status).not.toBe(401);
    }
  });
});

describe('bearer token handling', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.stop(); });

  it.each([
    ['Basic dXNlcjpwYXNz'], ['Bearer'], ['Bearer '], ['bearer'], [`Bearer ${'a'.repeat(600)}`], ['Bearer a b'], ['Token abc'],
  ])('refuses the Authorization header %j', async (header) => {
    const res = await api(h, 'GET', '/counts', { headers: { authorization: header } });
    expect(res.status).toBe(401);
  });

  it('accepts the scheme in any case and ignores a token in the query string', async () => {
    expect((await api(h, 'GET', '/counts', { headers: { authorization: `bearer ${h.tokens.read}` } })).status).toBe(200);
    expect((await api(h, 'GET', `/counts?token=${h.tokens.read}`)).status).toBe(401);
  });

  it('never echoes or logs a token, valid or not', async () => {
    const secret = 'ultra-secret-device-token-9f8e7d6c5b4a';
    h.devices.addDevice(secret, 'dev-secret', ['read']);
    const bad = 'wrong-secret-token-1a2b3c4d5e6f7a8b';
    const responses = [
      await api(h, 'GET', '/counts', { token: bad }),
      await api(h, 'GET', '/counts', { token: secret }),
      await api(h, 'GET', '/projects/p1', { token: secret }),
    ];
    for (const r of responses) {
      expect(r.text).not.toContain(secret);
      expect(r.text).not.toContain(bad);
      expect(JSON.stringify(r.headers)).not.toContain(secret);
      expect(JSON.stringify(r.headers)).not.toContain(bad);
    }
    expect(JSON.stringify(h.logs)).not.toContain(secret);
    expect(JSON.stringify(h.logs)).not.toContain(bad);
  });

  it('does not log the secret when a service fails with a 500', async () => {
    const hh = await startHarness({ overrides: { projects: { require: () => { throw new Error('database exploded'); } } } });
    try {
      hh.devices.addDevice('another-secret-token-0123456789', 'dev-x', ['read']);
      const r = await api(hh, 'GET', '/projects/p1', { token: 'another-secret-token-0123456789' });
      expect(r.status).toBe(500);
      expect(JSON.stringify(hh.logs)).not.toContain('another-secret-token-0123456789');
      expect(r.text).not.toContain('another-secret-token-0123456789');
    } finally { await hh.stop(); }
  });
});

describe('Host header (DNS rebinding defence)', () => {
  let h: Harness;
  let publicUrl: string | null = null;
  beforeAll(async () => { h = await startHarness({ overrides: { tailscale: { publicUrl: () => publicUrl } } }); });
  afterAll(async () => { await h.stop(); });

  it('accepts this machine under its three names with the right port', async () => {
    for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`, `[::1]:${h.port}`, `LOCALHOST:${h.port}`]) {
      const res = await raw(h.port, { path: '/api/v1/health', headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it.each([
    ['an unrelated name', 'evil.example'],
    ['an unrelated name with the right port', undefined as unknown as string],
    ['the address without a port', '127.0.0.1'],
    ['localhost without a port', 'localhost'],
    ['a different port', '127.0.0.1:1'],
    ['a name that merely starts with localhost', 'localhost.evil.example'],
    ['a look-alike with the right port', 'localhost.evil.example:PORT'],
    ['the wildcard address', '0.0.0.0:PORT'],
    ['another loopback address', '127.0.0.2:PORT'],
    ['a different IPv6 address', '[::2]:PORT'],
  ])('refuses %s', async (_what, host) => {
    const hostHeader = (host ?? 'evil.example:PORT').replace('PORT', String(h.port));
    const res = await raw(h.port, { path: '/api/v1/health', headers: { host: hostHeader } });
    expect(res.status).toBe(403);
    expect(res.json().error.code).toBe('host_not_allowed');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a rejected host on every kind of path, before looking at the token', async () => {
    const before = h.devices.authCalls.length;
    for (const path of ['/api/v1/counts', '/', '/ui/', '/nothing/here']) {
      const res = await raw(h.port, { path, headers: { host: 'evil.example', authorization: `Bearer ${h.tokens.desktop}` } });
      expect(res.status, path).toBe(403);
    }
    expect(h.devices.authCalls.length).toBe(before);
  });

  it('allows the Tailscale Serve host only while Tailscale reports a public URL', async () => {
    publicUrl = null;
    expect((await raw(h.port, { path: '/api/v1/health', headers: { host: 'box.tail1234.ts.net' } })).status).toBe(403);
    publicUrl = 'https://box.tail1234.ts.net';
    expect((await raw(h.port, { path: '/api/v1/health', headers: { host: 'box.tail1234.ts.net' } })).status).toBe(200);
    expect((await raw(h.port, { path: '/api/v1/health', headers: { host: 'other.tail1234.ts.net' } })).status).toBe(403);
    publicUrl = 'https://box.tail1234.ts.net:8443';
    expect((await raw(h.port, { path: '/api/v1/health', headers: { host: 'box.tail1234.ts.net:8443' } })).status).toBe(200);
    expect((await raw(h.port, { path: '/api/v1/health', headers: { host: 'box.tail1234.ts.net' } })).status).toBe(403);
    publicUrl = null;
  });
});

describe('how the request reached us (via)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ publicUrl: 'https://box.tail1234.ts.net' }); });
  afterAll(async () => { await h.stop(); });

  const viaOf = async (headers: Record<string, string>): Promise<string> => {
    const before = h.devices.authCalls.length;
    const res = await api(h, 'GET', '/counts', { token: h.tokens.read, headers });
    expect(res.status).toBe(200);
    return h.devices.authCalls[before].via;
  };

  it('is localhost for a plain local request', async () => {
    expect(await viaOf({})).toBe('localhost');
  });
  it('is tailscale when Serve identifies the user', async () => {
    expect(await viaOf({ 'tailscale-user-login': 'me@example.com', host: 'box.tail1234.ts.net' })).toBe('tailscale');
  });
  it('is tailscale for a forwarded request addressed to the Serve host', async () => {
    expect(await viaOf({ 'x-forwarded-for': '100.64.0.7', host: 'box.tail1234.ts.net' })).toBe('tailscale');
  });
  it('is tailscale for any forwarded request, even one that claims a local host name (a tailnet client can forge Host)', async () => {
    expect(await viaOf({ 'x-forwarded-for': '100.64.0.7' })).toBe('tailscale');
    expect(await viaOf({ 'x-forwarded-for': '100.64.0.7', host: `127.0.0.1:${h.port}` })).toBe('tailscale');
  });
  it('is localhost for the Serve host name without any Serve headers', async () => {
    expect(await viaOf({ host: 'box.tail1234.ts.net' })).toBe('localhost');
  });
});

describe('Origin header (CSRF defence)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ publicUrl: 'https://box.tail1234.ts.net' }); });
  afterAll(async () => { await h.stop(); });
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const same = () => `http://127.0.0.1:${h.port}`;

  it('lets the same origin and a missing Origin through on every method', async () => {
    for (const origin of [same(), undefined]) {
      expect((await api(h, 'POST', '/projects', { token: h.tokens.desktop, body: { name: 'A' }, headers: { origin } })).status).toBe(200);
      expect((await api(h, 'PATCH', '/projects/p1', { token: h.tokens.desktop, body: { name: 'B' }, headers: { origin } })).status).toBe(200);
      expect((await api(h, 'DELETE', '/projects/p1', { token: h.tokens.desktop, headers: { origin } })).status).toBe(200);
    }
  });

  it('accepts the Tailscale origin on the Tailscale host', async () => {
    const res = await api(h, 'POST', '/projects', { token: h.tokens.desktop, body: { name: 'A' }, headers: { host: 'box.tail1234.ts.net', origin: 'https://box.tail1234.ts.net', 'x-forwarded-for': '100.64.0.7' } });
    expect(res.status).toBe(200);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['the opaque origin', 'null'],
    ['an empty origin', ''],
    ['localhost when the request went to 127.0.0.1', 'PORT_LOCALHOST'],
    ['the same host on another port', 'PORT_OTHER'],
    ['a look-alike', 'PORT_LOOKALIKE'],
    ['a file page', 'file://'],
  ])('refuses a state-changing request from %s, even with a valid token', async (_what, origin) => {
    const o = origin.replace('PORT_LOCALHOST', `http://localhost:${h.port}`).replace('PORT_OTHER', `http://127.0.0.1:${h.port + 1}`).replace('PORT_LOOKALIKE', `http://127.0.0.1:${h.port}.evil.example`);
    const calls = h.calls.filter((c) => c.service === 'projects').length;
    for (const [method, path, body] of [['POST', '/projects', { name: 'A' }], ['PATCH', '/projects/p1', { name: 'B' }], ['DELETE', '/projects/p1', undefined]] as const) {
      const res = await api(h, method, path, { token: h.tokens.desktop, body, headers: { origin: o } });
      expect(res.status, `${method} from ${o}`).toBe(403);
      expect(res.json().error.code).toBe('origin_not_allowed');
    }
    expect(h.calls.filter((c) => c.service === 'projects').length).toBe(calls);
  });

  it('does not restrict reads by Origin, and still sends no CORS headers', async () => {
    const res = await api(h, 'GET', '/counts', { token: h.tokens.read, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  describe('extension origin on REST', () => {
    it('is allowed for a principal with the extension scope', async () => {
      const res = await api(h, 'POST', '/activity/read', { token: h.tokens.readExtension, body: { all: true }, headers: { origin: ext } });
      expect(res.status).toBe(200);
    });
    it('is refused for principals without the extension scope, the desktop token included', async () => {
      for (const token of [h.tokens.read, h.tokens.desktop]) {
        const res = await api(h, 'POST', '/activity/read', { token, body: { all: true }, headers: { origin: ext } });
        expect(res.status).toBe(403);
        expect(res.json().error.code).toBe('origin_not_allowed');
      }
    });
    it('is allowed on the public pairing route, where there is no principal yet', async () => {
      const before = h.devices.redeemCalls.length;
      const res = await api(h, 'POST', '/pairing/redeem', { body: samples['pairing.redeem'].body, headers: { origin: ext } });
      expect(res.status).toBe(200);
      expect(h.devices.redeemCalls.length).toBe(before + 1);
    });
    it('is still refused for a web page redeeming a pairing code', async () => {
      const before = h.devices.redeemCalls.length;
      const res = await api(h, 'POST', '/pairing/redeem', { body: samples['pairing.redeem'].body, headers: { origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      expect(h.devices.redeemCalls.length).toBe(before);
    });
    it('is fine for reads', async () => {
      expect((await api(h, 'GET', '/health', { headers: { origin: ext } })).status).toBe(200);
      expect((await api(h, 'GET', '/counts', { token: h.tokens.read, headers: { origin: ext } })).status).toBe(200);
    });
  });
});

describe('no CORS, security headers everywhere', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.stop(); });

  it('answers a preflight without any Access-Control headers', async () => {
    for (const origin of ['https://evil.example', `http://127.0.0.1:${h.port}`]) {
      const res = await raw(h.port, {
        method: 'OPTIONS', path: '/api/v1/projects',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
      });
      expect([403, 404]).toContain(res.status);
      expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('puts the baseline headers on success, auth failures, validation failures, unknown paths and rate limits', async () => {
    const responses = [
      await api(h, 'GET', '/health'),
      await api(h, 'GET', '/counts'),
      await api(h, 'GET', '/counts', { token: h.tokens.read }),
      await api(h, 'POST', '/projects', { token: h.tokens.desktop, body: {} }),
      await api(h, 'GET', '/no/such/route', { token: h.tokens.read }),
      await raw(h.port, { path: '/nothing' }),
      await raw(h.port, { path: '/api/v1/health', headers: { host: 'evil.example' } }),
    ];
    for (const r of responses) {
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('answers unknown API paths with the standard error shape', async () => {
    const res = await api(h, 'GET', '/no/such/route', { token: h.tokens.read });
    expect(res.status).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.headers['content-type']).toContain('application/json');
  });
});
