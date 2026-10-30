import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatGptOpenResult, Conversation, HookStatus, NativeBridge } from '@minisumma/shared';
import { unavailableBridge } from '@minisumma/shared';
import type { PushProvider } from '../../src/contracts.ts';
import { CoreError, conflict, notFound, unprocessable, unavailable } from '../../src/errors.ts';
import { verificationOf } from '../../src/http/conversations.ts';
import { api, raw, startHarness } from './harness.ts';
import type { Harness, HarnessOptions } from './harness.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.stop(); h = null; });
async function boot(opts: HarnessOptions = {}): Promise<Harness> { h = await startHarness(opts); return h; }
const calls = (hh: Harness, service: string, method: string) => hh.calls.filter((c) => c.service === service && c.method === method);

describe('validation', () => {
  it('turns a failed body schema into 400 validation_failed with the problem in words', async () => {
    const hh = await boot();
    const res = await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: {} });
    expect(res.status).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('validation_failed');
    expect(error.message).toMatch(/name: is required/);
    expect(error.message).toMatch(/Fix these and try again/);
    expect(error.details.issues[0].path).toEqual(['name']);
    expect(calls(hh, 'projects', 'create')).toHaveLength(0);
  });

  it('names the field and the rule for a bad value', async () => {
    const hh = await boot();
    const res = await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: { name: 'A', githubRepo: 'not a repo' } });
    expect(res.status).toBe(400);
    expect(res.json().error.message).toMatch(/githubRepo: Use the form owner\/repo/);
    const wrongType = await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: { name: 5 } });
    expect(wrongType.status).toBe(400);
    expect(wrongType.json().error.message).toMatch(/name:/);
    expect(em(res.text)).toBe(false);
  });

  it('refuses a body that is not JSON', async () => {
    const hh = await boot();
    const res = await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, headers: { 'content-type': 'application/json' }, body: undefined });
    // an empty body is `{}`: still invalid for this route, but as a validation problem and not as bad JSON
    expect(res.json().error.code).toBe('validation_failed');
    const bad = await raw(hh.port, { method: 'POST', path: '/api/v1/projects', headers: { authorization: `Bearer ${hh.tokens.desktop}`, 'content-type': 'application/json' }, body: '{"name": ' });
    expect(bad.status).toBe(400);
    expect(bad.json().error.code).toBe('invalid_json');
  });

  it('validates and converts query strings', async () => {
    const hh = await boot({ overrides: { reports: { list: () => ({ items: [], nextBefore: null }) } } });
    const ok = await api(hh, 'GET', '/reports?limit=5&unread=true&projectId=p1', { token: hh.tokens.read });
    expect(ok.status).toBe(200);
    expect(calls(hh, 'reports', 'list')[0].args[0]).toEqual({ limit: 5, unread: true, projectId: 'p1' });
    for (const q of ['limit=abc', 'limit=0', 'limit=201', 'unread=maybe', 'limit=1.5']) {
      const bad = await api(hh, 'GET', `/reports?${q}`, { token: hh.tokens.read });
      expect(bad.status, q).toBe(400);
      expect(bad.json().error.code).toBe('validation_failed');
      expect(bad.json().error.message).toMatch(/query string/);
    }
  });

  it('hands handlers only the fields of the schema', async () => {
    const hh = await boot();
    await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: { name: 'A', evil: 1, __proto__: { polluted: true } } });
    expect(calls(hh, 'projects', 'create')[0].args[0]).toEqual({ name: 'A', roots: [] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('treats an empty body as {} and ignores bodies on routes without a schema', async () => {
    const hh = await boot();
    const stop = await raw(hh.port, { method: 'POST', path: '/api/v1/sessions/posix%7Cabc/stop', headers: { authorization: `Bearer ${hh.tokens.desktop}` } });
    expect(stop.status).toBe(200);
    const ignored = await raw(hh.port, { method: 'POST', path: '/api/v1/reports/r1/read', headers: { authorization: `Bearer ${hh.tokens.read}` }, body: 'this is not json at all' });
    expect(ignored.status).toBe(200);
  });

  it('refuses bodies over 1 MB with 413, with or without a Content-Length', async () => {
    const hh = await boot();
    const big = JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 10) });
    const withLength = await raw(hh.port, { method: 'POST', path: '/api/v1/projects', headers: { authorization: `Bearer ${hh.tokens.desktop}`, 'content-type': 'application/json' }, body: big });
    expect(withLength.status).toBe(413);
    expect(withLength.json().error.code).toBe('payload_too_large');
    // chunked: no Content-Length, the limit is enforced while reading
    const chunked = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      import('node:http').then(({ default: http }) => {
        const r = http.request({ host: '127.0.0.1', port: hh.port, agent: false, method: 'POST', path: '/api/v1/projects', headers: { authorization: `Bearer ${hh.tokens.desktop}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
          let t = '';
          res.on('data', (c) => { t += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
        });
        r.on('error', reject);
        for (let i = 0; i < 5; i++) r.write('x'.repeat(300_000));
        r.end();
      }, reject);
    });
    expect(chunked.status).toBe(413);
    // just under the limit gets as far as schema validation
    const under = await raw(hh.port, { method: 'POST', path: '/api/v1/projects', headers: { authorization: `Bearer ${hh.tokens.desktop}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(1_000_000) }) });
    expect(under.status).toBe(400);
    expect(under.json().error.code).toBe('validation_failed');
  });

  it('checks the part number of a delivery', async () => {
    const hh = await boot({ overrides: { deliveries: { part: (id: string, index: number) => ({ index, total: 3, text: `part ${index} of ${id}`, sha256: 'abc' }) } } });
    for (const bad of ['abc', '0', '-1', '1.5', '9999999']) {
      expect((await api(hh, 'GET', `/deliveries/d1/parts/${bad}`, { token: hh.tokens.desktop })).status, bad).toBe(400);
    }
    const ok = await api(hh, 'GET', '/deliveries/d1/parts/2', { token: hh.tokens.desktop });
    expect(ok.json().text).toBe('part 2 of d1');
  });
});
const em = (text: string) => text.includes('\u2014');

describe('error mapping', () => {
  it('keeps the status, code, message and details of a CoreError', async () => {
    const hh = await boot({ overrides: { projects: {
      require: (id: string) => { throw id === 'missing' ? notFound('The project') : id === 'busy' ? conflict('That project is busy.', 'project_busy', { holder: 'x' }) : unprocessable('Cannot do that.', 'cannot', { why: 1 }); },
    } } });
    const a = await api(hh, 'GET', '/projects/missing', { token: hh.tokens.read });
    expect(a.status).toBe(404);
    expect(a.json()).toEqual({ error: { code: 'not_found', message: 'The project was not found.' } });
    const b = await api(hh, 'GET', '/projects/busy', { token: hh.tokens.read });
    expect(b.status).toBe(409);
    expect(b.json()).toEqual({ error: { code: 'project_busy', message: 'That project is busy.', details: { holder: 'x' } } });
    const c = await api(hh, 'GET', '/projects/other', { token: hh.tokens.read });
    expect(c.status).toBe(422);
    expect(c.json().error).toMatchObject({ code: 'cannot', details: { why: 1 } });
  });

  it('maps services that are unavailable', async () => {
    const hh = await boot({ overrides: { data: { usage: () => { throw unavailable('The database is busy.', 'db_busy'); } } } });
    const r = await api(hh, 'GET', '/data/usage', { token: hh.tokens.desktop });
    expect(r.status).toBe(503);
    expect(r.json().error.code).toBe('db_busy');
  });

  it('hides internals of unexpected errors and logs them', async () => {
    const hh = await boot({ overrides: {
      projects: { require: () => { throw new Error('SQLITE_CORRUPT at /home/secret/path/db.sqlite'); } },
      reports: { require: async () => { throw 'a bare string was thrown'; } },
      data: { usage: async () => { throw new TypeError('cannot read properties of undefined'); } },
    } });
    for (const [path, token] of [['/projects/p1', hh.tokens.read], ['/reports/r1', hh.tokens.read], ['/data/usage', hh.tokens.desktop]] as const) {
      const res = await api(hh, 'GET', path, { token });
      expect(res.status, path).toBe(500);
      expect(res.json().error.code).toBe('internal_error');
      expect(res.text).not.toMatch(/SQLITE|secret|undefined|bare string|TypeError/);
    }
    const errors = hh.logs.filter((l) => l.level === 'error');
    expect(errors.map((e) => e.msg)).toEqual(['http.unhandled_error', 'http.unhandled_error', 'http.unhandled_error']);
    expect(String(errors[0].data?.message)).toContain('SQLITE_CORRUPT');
    expect(errors[0].data?.route).toBe('projects.get');
  });

  it('answers a failing authenticator with a 500, not a hang', async () => {
    const hh = await boot();
    hh.devices.authenticate = () => { throw new Error('keychain locked'); };
    const res = await api(hh, 'GET', '/counts', { token: hh.tokens.read });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('keychain');
  });
});

describe('session keys in the path', () => {
  const key = '11111111-2222-3333-4444-555555555555';
  const view = (k: string) => ({ key: k });
  const boot2 = () => boot({ overrides: { sessions: { get: (k: string) => (k.endsWith('unknown') ? null : view(k)), stop: async (k: string) => view(k) } } });

  it.each([
    ['percent-encoded pipe', `posix%7C${key}`, `posix|${key}`],
    ['raw pipe', `posix|${key}`, `posix|${key}`],
    ['a WSL key with an encoded colon', `wsl%3AUbuntu-22.04%7C${key}`, `wsl:Ubuntu-22.04|${key}`],
    ['a Windows key', `win%7C${key}`, `win|${key}`],
  ])('decodes %s once', async (_what, segment, expected) => {
    const hh = await boot2();
    const res = await raw(hh.port, { path: `/api/v1/sessions/${segment}`, headers: { authorization: `Bearer ${hh.tokens.read}` } });
    expect(res.status).toBe(200);
    expect(res.json().key).toBe(expected);
    expect(calls(hh, 'sessions', 'get')[0].args[0]).toBe(expected);
  });

  it.each([
    ['no environment', key],
    ['an unknown environment', `mac%7C${key}`],
    ['a missing session id', 'posix%7C'],
    ['a double-encoded separator', `posix%257C${key}`],
    ['a malformed escape', 'posix%7%zz'],
  ])('refuses %s with 400', async (_what, segment) => {
    const hh = await boot2();
    const res = await raw(hh.port, { path: `/api/v1/sessions/${segment}`, headers: { authorization: `Bearer ${hh.tokens.read}` } });
    expect(res.status).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.message).toMatch(/session key/);
    expect(calls(hh, 'sessions', 'get')).toHaveLength(0);
  });

  it('answers 404 for a session that does not exist and passes force to stop', async () => {
    const hh = await boot2();
    expect((await api(hh, 'GET', `/sessions/posix%7Cunknown`, { token: hh.tokens.read })).status).toBe(404);
    const stop = await api(hh, 'POST', `/sessions/posix%7C${key}/stop`, { token: hh.tokens.desktop, body: { force: true } });
    expect(stop.status).toBe(200);
    expect(calls(hh, 'sessions', 'stop')[0].args).toEqual([`posix|${key}`, { force: true }]);
  });

  it('checks that the project exists before binding or starting', async () => {
    const hh = await boot({ overrides: { projects: { require: (id: string) => { if (id === 'nope') throw notFound('The project'); return { id }; } } } });
    expect((await api(hh, 'POST', `/sessions/posix%7C${key}/bind`, { token: hh.tokens.desktop, body: { projectId: 'nope' } })).status).toBe(404);
    expect(calls(hh, 'sessions', 'bind')).toHaveLength(0);
    expect((await api(hh, 'POST', `/sessions/posix%7C${key}/bind`, { token: hh.tokens.desktop, body: { projectId: null } })).status).toBe(200);
    expect(calls(hh, 'sessions', 'bind')[0].args).toEqual([`posix|${key}`, null]);
    expect((await api(hh, 'POST', '/projects/nope/sessions', { token: hh.tokens.desktop, body: { mode: 'new' } })).status).toBe(404);
    expect(calls(hh, 'sessions', 'start')).toHaveLength(0);
  });
});

describe('system.state', () => {
  it('reads the sequence number first, then the data', async () => {
    let hh!: Harness;
    hh = await boot({ overrides: { projects: {
      list: () => { hh.bus.emit({ type: 'system.notice', level: 'info', message: 'raced the snapshot' }); return [{ id: 'p1' }, { id: 'p2' }]; },
    } } });
    const before = hh.bus.seq;
    const res = await api(hh, 'GET', '/state', { token: hh.tokens.read });
    expect(res.status).toBe(200);
    const state = res.json();
    expect(state.seq).toBe(before);
    expect(hh.bus.seq).toBe(before + 1);
    expect(state.projects).toEqual([{ id: 'p1' }, { id: 'p2' }]);
    expect(state.system.name).toBe('mini-summa-core');
    expect(state.counts).toEqual({ unreadActivity: 1, actionsNeeded: 2, pendingActions: 3, reportsAwaitingHandoff: 4, liveSessions: 5 });
    expect(state.settings.chatgpt.mode).toBe('embedded');
    expect(state.sessions).toEqual([]);
  });

  it('includes the conversations of every project', async () => {
    const conv = (id: string, projectId: string) => ({ id, projectId });
    const hh = await boot({ overrides: { projects: {
      list: () => [{ id: 'p1' }, { id: 'p2' }],
      conversations: { list: (id: string) => (id === 'p1' ? [conv('c1', 'p1'), conv('c2', 'p1')] : [conv('c3', 'p2')]) },
    } } });
    const state = (await api(hh, 'GET', '/state', { token: hh.tokens.read })).json();
    expect(state.conversations.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('route specifics', () => {
  it('health is public and complete', async () => {
    const hh = await boot();
    expect((await api(hh, 'GET', '/health')).json()).toEqual({ ok: true, name: 'mini-summa-core', version: '0.0.0-test', apiVersion: 1 });
  });

  it('merges the hook status into every environment', async () => {
    const status = (env: string) => ({ env, installed: true }) as unknown as HookStatus;
    const hh = await boot({ overrides: {
      environments: { list: async () => [{ id: 'posix', hooks: null }, { id: 'win', hooks: { env: 'win', installed: false } }, { id: 'wsl:Ubuntu', hooks: null }] },
      hooks: { list: async () => [status('posix'), status('wsl:Ubuntu')] },
    } });
    const res = await api(hh, 'GET', '/environments?refresh=true', { token: hh.tokens.desktop });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.json().map((e: { id: string }) => [e.id, e]));
    expect(byId.posix.hooks).toEqual({ env: 'posix', installed: true });
    expect(byId['wsl:Ubuntu'].hooks).toEqual({ env: 'wsl:Ubuntu', installed: true });
    expect(byId.win.hooks).toEqual({ env: 'win', installed: false });
    expect(calls(hh, 'environments', 'list')[0].args[0]).toEqual({ refresh: true });
  });

  it('still lists environments when the hook status cannot be read', async () => {
    const hh = await boot({ overrides: {
      environments: { list: async () => [{ id: 'posix', hooks: null }] },
      hooks: { list: async () => { throw new Error('settings.json is locked'); } },
    } });
    const res = await api(hh, 'GET', '/environments', { token: hh.tokens.desktop });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual([{ id: 'posix', hooks: null }]);
    expect(hh.logs.some((l) => l.level === 'warn' && l.msg === 'http.hook_status_failed')).toBe(true);
  });

  it('activity.markRead returns the full counts', async () => {
    const hh = await boot({ overrides: { activity: { markRead: () => ({ unreadActivity: 0, actionsNeeded: 0 }) } } });
    const res = await api(hh, 'POST', '/activity/read', { token: hh.tokens.read, body: { ids: ['a1'] } });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ unreadActivity: 1, actionsNeeded: 2, pendingActions: 3, reportsAwaitingHandoff: 4, liveSessions: 5 });
    expect(calls(hh, 'activity', 'markRead')[0].args[0]).toEqual({ ids: ['a1'] });
  });

  it('archives by default and deletes only when asked', async () => {
    const hh = await boot();
    await api(hh, 'DELETE', '/projects/p1', { token: hh.tokens.desktop });
    await api(hh, 'DELETE', '/projects/p2?mode=delete', { token: hh.tokens.desktop });
    expect(calls(hh, 'projects', 'remove').map((c) => c.args)).toEqual([['p1', 'archive'], ['p2', 'delete']]);
    expect((await api(hh, 'DELETE', '/projects/p3?mode=obliterate', { token: hh.tokens.desktop })).status).toBe(400);
  });

  it('describes the desktop principal for devices.self and rejects push registration for it', async () => {
    const hh = await boot();
    const self = await api(hh, 'GET', '/devices/self', { token: hh.tokens.desktop });
    expect(self.json()).toMatchObject({ id: 'desktop', platform: 'desktop', scopes: ['desktop'], trusted: true, revokedAt: null });
    const dev = await api(hh, 'GET', '/devices/self', { token: hh.tokens.read });
    expect(dev.json()).toMatchObject({ id: 'dev-read', scopes: ['read'] });
    const push = await api(hh, 'POST', '/devices/self/push-token', { token: hh.tokens.desktop, body: { provider: 'fcm', token: 'x'.repeat(20) } });
    expect(push.status).toBe(400);
    const registered = await api(hh, 'POST', '/devices/self/push-token', { token: hh.tokens.notify, body: { provider: 'fcm', token: 'y'.repeat(20) } });
    expect(registered.json()).toEqual({ ok: true });
    expect(hh.devices.pushRegistrations).toEqual([{ deviceId: 'dev-notify', provider: 'fcm', token: 'y'.repeat(20) }]);
  });

  it('derives the actor from the authenticated caller, never from the body', async () => {
    const hh = await boot({ overrides: { actions: { createPrompt: async (input: unknown) => ({ id: 'a1', input }) }, deliveries: { confirmSent: (id: string, note: string | undefined, actor: unknown) => ({ id, note, actor }) } } });
    const key = 'posix|11111111-2222-3333-4444-555555555555';
    const fromPhone = await api(hh, 'POST', '/actions', { token: hh.tokens.prompt, body: { sessionKey: key, text: 'Run the tests', actor: { kind: 'desktop' } } });
    expect(fromPhone.json().input).toMatchObject({ sessionKey: key, text: 'Run the tests', actor: { kind: 'device', deviceId: 'dev-prompt', name: 'Device dev-prompt' } });
    const fromDesktop = await api(hh, 'POST', '/actions', { token: hh.tokens.desktop, body: { sessionKey: key, text: 'Run the tests' } });
    expect(fromDesktop.json().input.actor).toEqual({ kind: 'desktop' });
    const confirm = await api(hh, 'POST', '/deliveries/d1/confirm-sent', { token: hh.tokens.desktop, body: { note: 'sent it' } });
    expect(confirm.json()).toEqual({ id: 'd1', note: 'sent it', actor: { kind: 'desktop' } });
  });

  it('builds pairing offers with the right scopes and addresses', async () => {
    const hh = await boot({ publicUrl: 'https://box.tail1234.ts.net' });
    const phone = (await api(hh, 'POST', '/pairing/offers', { token: hh.tokens.desktop, body: {} })).json();
    expect(phone.scopes).toEqual(['read', 'notify']);
    expect(phone.urls).toEqual(['https://box.tail1234.ts.net', hh.baseUrl]);
    const custom = (await api(hh, 'POST', '/pairing/offers', { token: hh.tokens.desktop, body: { scopes: ['read', 'prompt', 'read'] } })).json();
    expect(custom.scopes).toEqual(['read', 'prompt']);
    const ext = (await api(hh, 'POST', '/pairing/offers', { token: hh.tokens.desktop, body: { kind: 'extension', scopes: ['approve'] } })).json();
    expect(ext.scopes).toEqual(['extension']);
    expect(ext.urls).toEqual([hh.baseUrl]);
    expect((await api(hh, 'POST', '/pairing/offers', { token: hh.tokens.desktop, body: { scopes: ['desktop'] } })).status).toBe(400);
  });

  it('puts only the local address in an offer when Tailscale is off', async () => {
    const hh = await boot();
    const offer = (await api(hh, 'POST', '/pairing/offers', { token: hh.tokens.desktop, body: {} })).json();
    expect(offer.urls).toEqual([hh.baseUrl]);
  });
});

describe('push', () => {
  const provider = (impl: Partial<PushProvider> = {}): PushProvider & { configured: ReturnType<typeof vi.fn> } => ({
    name: 'fcm', configured: vi.fn(() => true), configureFromJson: vi.fn(() => ({ firebaseProject: 'demo-project' })), clear: vi.fn(), send: async () => [], ...impl,
  }) as PushProvider & { configured: ReturnType<typeof vi.fn> };
  const json = JSON.stringify({ type: 'service_account', project_id: 'demo-project', private_key: 'PRIVATE-KEY-MARKER-'.repeat(4) });

  it('configures the provider and records it in the settings', async () => {
    const push = provider();
    const hh = await boot({ push });
    const res = await api(hh, 'POST', '/push/configure', { token: hh.tokens.desktop, body: { serviceAccountJson: json } });
    expect(res.json()).toEqual({ ok: true, configured: true, firebaseProject: 'demo-project' });
    expect(push.configureFromJson).toHaveBeenCalledWith(json);
    expect(calls(hh, 'settings.patch', 'update')[0].args[0]).toEqual({ mobile: { push: { provider: 'fcm', configured: true } } });
  });

  it('leaves the settings alone when the provider refuses the file, and never echoes it', async () => {
    const push = provider({ configureFromJson: () => { throw new CoreError(400, 'bad_service_account', 'That file is not a Firebase service account. Download a new one from the Firebase console.'); } });
    const hh = await boot({ push });
    const res = await api(hh, 'POST', '/push/configure', { token: hh.tokens.desktop, body: { serviceAccountJson: json } });
    expect(res.status).toBe(400);
    expect(res.json().error.code).toBe('bad_service_account');
    expect(res.text).not.toContain('PRIVATE-KEY-MARKER');
    expect(calls(hh, 'settings.patch', 'update')).toHaveLength(0);
    // a body that fails validation must not be echoed either
    const short = await api(hh, 'POST', '/push/configure', { token: hh.tokens.desktop, body: { serviceAccountJson: 'PRIVATE-KEY-MARKER' } });
    expect(short.status).toBe(400);
    expect(short.text).not.toContain('PRIVATE-KEY-MARKER');
    expect(JSON.stringify(hh.logs)).not.toContain('PRIVATE-KEY-MARKER');
  });

  it('says so when this build has no push provider', async () => {
    const hh = await boot({ push: null });
    const res = await api(hh, 'POST', '/push/configure', { token: hh.tokens.desktop, body: { serviceAccountJson: json } });
    expect(res.status).toBe(503);
    expect(res.json().error.code).toBe('push_unavailable');
  });

  it('clears the provider and the setting, and sends a test through the notifications service', async () => {
    const push = provider();
    const hh = await boot({ push, overrides: { notifications: { sendTest: async () => ({ sent: 1, failed: 0, skipped: null }) } } });
    expect((await api(hh, 'DELETE', '/push/configure', { token: hh.tokens.desktop })).json()).toEqual({ ok: true });
    expect(push.clear).toHaveBeenCalled();
    expect(calls(hh, 'settings.patch', 'update')[0].args[0]).toEqual({ mobile: { push: { provider: 'none', configured: false } } });
    expect((await api(hh, 'POST', '/push/test', { token: hh.tokens.desktop })).json()).toEqual({ sent: 1, failed: 0, skipped: null });
  });
});

describe('pairing rate limit (only failed redemptions are charged)', () => {
  const body = { offerId: 'offer1', code: 'abcdefgh1234', deviceName: 'Pixel', platform: 'android' };
  const wrongCode = () => { throw new CoreError(400, 'wrong_code', 'That code is wrong. Scan a fresh code on the desktop.'); };
  const redeem = (hh: Harness, b: unknown = body, headers: Record<string, string> = {}) => api(hh, 'POST', '/pairing/redeem', { body: b, headers });

  it('cannot be locked out by requests that fail validation: 30 empty or invalid POSTs, then a valid pairing still works', async () => {
    const hh = await boot();
    const invalid: unknown[] = [
      {}, { offerId: 'offer1' }, { ...body, code: 'short' }, { ...body, deviceName: '' }, { ...body, platform: 'desktop' }, { ...body, offerId: 5 }, { code: 'abcdefgh1234' },
    ];
    for (let i = 0; i < 30; i++) {
      const res = await redeem(hh, invalid[i % invalid.length]);
      expect(res.status, `invalid request ${i + 1}`).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
    const notJson = await raw(hh.port, { method: 'POST', path: '/api/v1/pairing/redeem', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(notJson.status).toBe(400);
    expect(hh.devices.redeemCalls).toHaveLength(0);
    const ok = await redeem(hh);
    expect(ok.status).toBe(200);
    expect(ok.json().token).toBeTruthy();
    expect(hh.devices.redeemCalls).toHaveLength(1);
  });

  it('does not charge successful pairings either', async () => {
    const hh = await boot();
    for (let i = 0; i < 40; i++) expect((await redeem(hh)).status, `pairing ${i + 1}`).toBe(200);
    expect(hh.devices.redeemCalls).toHaveLength(40);
  });

  it('allows 20 failed redemptions a minute across everyone, then answers 429 with Retry-After', async () => {
    const hh = await boot();
    hh.devices.redeemImpl = wrongCode;
    for (let i = 0; i < 20; i++) {
      const res = await redeem(hh);
      expect(res.status, `failure ${i + 1}`).toBe(400);
      expect(res.json().error.code).toBe('wrong_code');
    }
    const blocked = await redeem(hh);
    expect(blocked.status).toBe(429);
    expect(blocked.json().error.code).toBe('rate_limited');
    const wait = Number(blocked.headers['retry-after']);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(hh.devices.redeemCalls).toHaveLength(20);   // the blocked request never reached the service
    // the budget is global, not per caller, and a correct code is held back as well while the limit applies
    hh.devices.redeemImpl = null;
    const other = await redeem(hh, body, { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'other@example.com' });
    expect(other.status).toBe(429);
    expect(hh.devices.redeemCalls).toHaveLength(20);
    // invalid requests are not refused with a validation error while blocked: the limit answers first
    expect((await redeem(hh, {})).status).toBe(429);
  });

  it('recovers when the failures leave the minute', async () => {
    const hh = await boot();
    hh.devices.redeemImpl = wrongCode;
    for (let i = 0; i < 20; i++) await redeem(hh);
    expect((await redeem(hh)).status).toBe(429);
    hh.clock.advance(59_000);
    const stillBlocked = await redeem(hh);
    expect(stillBlocked.status).toBe(429);
    expect(Number(stillBlocked.headers['retry-after'])).toBe(1);
    hh.clock.advance(1_500);
    hh.devices.redeemImpl = null;
    expect((await redeem(hh)).status).toBe(200);
  });

  it('charges every refusal the service answers (wrong code, unknown or used offer) but not server faults', async () => {
    const hh = await boot();
    const answers = [
      () => { throw new CoreError(400, 'wrong_code', 'That code is wrong.'); },
      () => { throw new CoreError(404, 'not_found', 'That pairing offer was not found.'); },
      () => { throw new CoreError(409, 'offer_used', 'That pairing offer was already used.'); },
      () => { throw new CoreError(422, 'offer_expired', 'That pairing offer has expired.'); },
    ];
    for (let i = 0; i < 20; i++) {
      hh.devices.redeemImpl = answers[i % answers.length];
      expect([400, 404, 409, 422]).toContain((await redeem(hh)).status);
    }
    expect((await redeem(hh)).status).toBe(429);

    const fresh = await boot();
    for (let i = 0; i < 30; i++) {
      fresh.devices.redeemImpl = i % 2 === 0 ? () => { throw new Error('database is locked'); } : () => { throw new CoreError(503, 'unavailable', 'Pairing is not available right now.'); };
      expect([500, 503]).toContain((await redeem(fresh)).status);
    }
    fresh.devices.redeemImpl = null;
    expect((await redeem(fresh)).status).toBe(200);
  });

  it('is not spent by other routes', async () => {
    const hh = await boot();
    for (let i = 0; i < 30; i++) await api(hh, 'GET', '/health');
    hh.devices.redeemImpl = wrongCode;
    for (let i = 0; i < 20; i++) expect((await redeem(hh)).status).toBe(400);
  });

  it('tells the service how the request arrived', async () => {
    const hh = await boot({ publicUrl: 'https://box.tail1234.ts.net' });
    await redeem(hh);
    await redeem(hh, body, { host: 'box.tail1234.ts.net', 'x-forwarded-for': '100.64.0.9' });
    expect(hh.devices.redeemCalls.map((c) => c.via)).toEqual(['localhost', 'tailscale']);
    expect(hh.devices.redeemCalls[0].req).toEqual(body);
  });
});

describe('idempotency', () => {
  const create = (hh: Harness, key: string | null, body: unknown = { name: 'Alpha' }, token = hh.tokens.desktop) =>
    api(hh, 'POST', '/projects', { token, body, headers: key ? { 'idempotency-key': key } : {} });
  const counting = () => { let n = 0; return { create: () => ({ id: `p${++n}`, n }), count: () => n }; };

  it('replays the stored answer with Idempotent-Replay and does not run the handler again', async () => {
    const c = counting();
    const hh = await boot({ overrides: { projects: { create: c.create } } });
    const first = await create(hh, 'key-1');
    const second = await create(hh, 'key-1');
    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.text).toBe(first.text);
    expect(c.count()).toBe(1);
    expect(hh.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idempotency')?.n).toBe(1);
    expect(hh.db.get<{ principal: string; route: string }>('SELECT principal, route FROM idempotency')).toMatchObject({ principal: 'desktop', route: 'projects.create' });
  });

  it('runs the handler every time when there is no key', async () => {
    const c = counting();
    const hh = await boot({ overrides: { projects: { create: c.create } } });
    await create(hh, null); await create(hh, null);
    expect(c.count()).toBe(2);
  });

  it('keeps keys apart per principal and per route', async () => {
    const c = counting();
    const hh = await boot({ overrides: { projects: { create: c.create } } });
    hh.devices.addDevice('second-desktop-like-token-00001', 'dev-two', ['desktop']);
    await create(hh, 'shared'); await create(hh, 'shared', { name: 'Alpha' }, 'second-desktop-like-token-00001');
    expect(c.count()).toBe(2);
    const conv = await api(hh, 'POST', '/projects/p1/conversations', { token: hh.tokens.desktop, body: { url: 'https://chatgpt.com/c/6a1b2c3d-1111-2222-3333-444455556666' }, headers: { 'idempotency-key': 'shared' } });
    expect(conv.headers['idempotent-replay']).toBeUndefined();
    expect(calls(hh, 'projects.conversations', 'add')).toHaveLength(1);
  });

  it('ignores the header on routes that are not marked idempotent', async () => {
    const hh = await boot();
    await api(hh, 'PATCH', '/projects/p1', { token: hh.tokens.desktop, body: { name: 'B' }, headers: { 'idempotency-key': 'k' } });
    const second = await api(hh, 'PATCH', '/projects/p1', { token: hh.tokens.desktop, body: { name: 'B' }, headers: { 'idempotency-key': 'k' } });
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(calls(hh, 'projects', 'update')).toHaveLength(2);
  });

  it('stores 4xx answers and replays them with their details', async () => {
    let n = 0;
    const hh = await boot({ overrides: { projects: { create: () => { n++; if (n === 1) throw conflict('A project with that name exists.', 'name_taken', { existing: 'p9' }); return { id: 'p2' }; } } } });
    const first = await create(hh, 'k4');
    const second = await create(hh, 'k4');
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json().error.details).toEqual({ existing: 'p9' });
    expect(n).toBe(1);
  });

  it('does not store 5xx answers: a retry runs again', async () => {
    let n = 0;
    const hh = await boot({ overrides: { projects: { create: () => { n++; if (n === 1) throw new Error('disk full'); return { id: 'p2' }; } } } });
    expect((await create(hh, 'k5')).status).toBe(500);
    expect(hh.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM idempotency')?.n).toBe(0);
    const retry = await create(hh, 'k5');
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replay']).toBeUndefined();
    expect(n).toBe(2);
  });

  it('does not store validation failures: the same key may be used again with a corrected request', async () => {
    const c = counting();
    const hh = await boot({ overrides: { projects: { create: c.create } } });
    expect((await create(hh, 'k6', {})).status).toBe(400);
    const fixed = await create(hh, 'k6', { name: 'Alpha' });
    expect(fixed.status).toBe(200);
    expect(fixed.headers['idempotent-replay']).toBeUndefined();
    expect((await create(hh, 'k6', { name: 'Alpha' })).headers['idempotent-replay']).toBe('true');
    expect(c.count()).toBe(1);
  });

  it('refuses a key reused for a different request instead of returning the other answer', async () => {
    const c = counting();
    const hh = await boot({ overrides: { projects: { create: c.create } } });
    await create(hh, 'k7', { name: 'Alpha' });
    const other = await create(hh, 'k7', { name: 'Beta' });
    expect(other.status).toBe(422);
    expect(other.json().error.code).toBe('idempotency_key_reused');
    expect(c.count()).toBe(1);
    // key order and unknown fields do not make a request different
    const same = await create(hh, 'k7', { roots: [], name: 'Alpha', extra: true });
    expect(same.headers['idempotent-replay']).toBe('true');
  });

  it('runs overlapping requests with the same key one after the other', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const hh = await boot({ overrides: { projects: { create: async () => { n++; await gate; return { id: 'p1' }; } } } });
    const a = create(hh, 'k8');
    const b = create(hh, 'k8');
    await new Promise((r) => setTimeout(r, 100));
    expect(n).toBe(1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(rb.text).toBe(ra.text);
    expect([ra.headers['idempotent-replay'], rb.headers['idempotent-replay']].filter(Boolean)).toEqual(['true']);
    expect(n).toBe(1);
  });

  it('forgets an answer after 24 hours', async () => {
    const c = counting();
    const hh = await boot({ overrides: { projects: { create: c.create } } });
    await create(hh, 'k9');
    hh.clock.advance(24 * 3600 * 1000 - 1000);
    expect((await create(hh, 'k9')).headers['idempotent-replay']).toBe('true');
    hh.clock.advance(2000);
    const again = await create(hh, 'k9');
    expect(again.headers['idempotent-replay']).toBeUndefined();
    expect(c.count()).toBe(2);
  });

  it.each([['a key with a space', 'two words'], ['an empty key', ''], ['a key over 200 characters', 'k'.repeat(201)]])('refuses %s', async (_what, key) => {
    const hh = await boot();
    const res = await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: { name: 'A' }, headers: { 'idempotency-key': key } });
    expect(res.status).toBe(400);
    expect(res.json().error.message).toMatch(/Idempotency-Key/);
  });

  it('prunes answers older than 24 hours when the server starts', async () => {
    const hh = await boot({ noStart: true });
    const now = hh.clock.now().getTime();
    const insert = (key: string, ageMs: number) => hh.db.run(
      'INSERT INTO idempotency (key, principal, route, response_status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [key, 'desktop', 'projects.create', 200, '{"id":"x"}', new Date(now - ageMs).toISOString()]);
    insert('old', 25 * 3600 * 1000); insert('fresh', 23 * 3600 * 1000);
    await hh.start();
    expect(hh.db.all<{ key: string }>('SELECT key FROM idempotency').map((r) => r.key)).toEqual(['fresh']);
  });

  it('replays rows stored without a fingerprint as they are', async () => {
    const hh = await boot();
    hh.db.run('INSERT INTO idempotency (key, principal, route, response_status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['legacy', 'desktop', 'projects.create', 201, '{"id":"from-before"}', hh.clock.now().toISOString()]);
    const res = await create(hh, 'legacy');
    expect(res.status).toBe(201);
    expect(res.json()).toEqual({ id: 'from-before' });
  });
});

describe('conversations.open and conversations.verify', () => {
  const conv = { id: 'c1', url: 'https://chatgpt.com/c/6a1b2c3d-1111-2222-3333-444455556666' } as Conversation;
  const bridge = (overrides: Partial<NativeBridge> & { caps?: Partial<ReturnType<NativeBridge['capabilities']>>; open?: NativeBridge['chatgpt']['open']; verify?: NativeBridge['chatgpt']['verify']; state?: NativeBridge['chatgpt']['state'] } = {}): NativeBridge => {
    const base = unavailableBridge();
    return {
      ...base,
      capabilities: () => ({ ...base.capabilities(), ...overrides.caps }),
      chatgpt: { open: overrides.open ?? base.chatgpt.open, verify: overrides.verify ?? base.chatgpt.verify, state: overrides.state ?? base.chatgpt.state },
      openExternal: overrides.openExternal ?? base.openExternal,
    };
  };
  const result = (extra: Partial<ChatGptOpenResult>): ChatGptOpenResult => ({ ok: true, mode: 'embedded', opened: true, focused: true, verified: null, finalUrl: null, title: null, note: null, ...extra });
  const projects = (extra: Record<string, unknown> = {}) => ({ projects: { conversations: { require: () => conv, setVerification: (_id: string, r: unknown) => ({ ...conv, verification: r }), ...extra } } });

  it('opens in the embedded view when that is the mode and the host has one', async () => {
    const open = vi.fn(async () => result({}));
    const hh = await boot({ native: bridge({ caps: { chatgptEmbedded: true }, open }), overrides: projects() });
    const res = await api(hh, 'POST', '/conversations/c1/open', { token: hh.tokens.desktop });
    expect(res.json()).toMatchObject({ ok: true, mode: 'embedded' });
    expect(open).toHaveBeenCalledWith(conv.url, { focus: true, reason: 'user' });
  });

  it('opens the default browser in external mode and says it cannot see the page', async () => {
    const openExternal = vi.fn(async () => undefined);
    const hh = await boot({ native: bridge({ caps: { openExternal: true }, openExternal }), overrides: projects() });
    hh.settings.current = { ...hh.settings.current, chatgpt: { ...hh.settings.current.chatgpt, mode: 'external' } };
    const res = await api(hh, 'POST', '/conversations/c1/open', { token: hh.tokens.desktop });
    expect(res.json()).toMatchObject({ ok: true, mode: 'external', opened: true, focused: false, verified: null });
    expect(res.json().note).toMatch(/cannot see which page/);
    expect(openExternal).toHaveBeenCalledWith(conv.url);
  });

  it('reports plainly that nothing can open it when the host has no browser', async () => {
    const hh = await boot({ overrides: projects() });
    const res = await api(hh, 'POST', '/conversations/c1/open', { token: hh.tokens.desktop });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, mode: 'none', opened: false });
  });

  it('records what verification could observe', async () => {
    const setVerification = vi.fn((_id: string, r: unknown) => ({ ...conv, verification: r }));
    const hh = await boot({
      native: bridge({ caps: { chatgptEmbedded: true }, verify: async () => result({ verified: true, title: 'Roadmap chat' }), state: () => ({ mode: 'embedded', status: 'ready', url: conv.url, title: 'Roadmap chat', canGoBack: false, canGoForward: false, note: null }) }),
      overrides: projects({ setVerification }),
    });
    const res = await api(hh, 'POST', '/conversations/c1/verify', { token: hh.tokens.desktop });
    expect(res.status).toBe(200);
    expect(setVerification).toHaveBeenCalledWith('c1', { verification: 'verified', title: 'Roadmap chat' });
    expect(res.json().verification).toEqual({ verification: 'verified', title: 'Roadmap chat' });
  });

  it('answers 503 when the host cannot verify', async () => {
    const hh = await boot({ overrides: projects() });
    const res = await api(hh, 'POST', '/conversations/c1/verify', { token: hh.tokens.desktop });
    expect(res.status).toBe(503);
    expect(res.json().error.code).toBe('verify_unavailable');
  });

  it('maps host observations to a verification state without claiming more than was seen', () => {
    const ready = { status: 'ready' as const };
    expect(verificationOf(result({ verified: true }), ready)).toBe('verified');
    expect(verificationOf(result({ verified: false }), ready)).toBe('mismatch');
    expect(verificationOf(result({ verified: null }), ready)).toBe('unverified');
    expect(verificationOf(result({ ok: false }), ready)).toBe('unreachable');
    expect(verificationOf(result({ verified: true }), { status: 'login_required' })).toBe('login_required');
    expect(verificationOf(result({ verified: true }), { status: 'challenge' })).toBe('unreachable');
  });
});

describe('wording of what the server says', () => {
  it('uses no em dashes in any message a person can read, and every message tells what to do or what is wrong', async () => {
    const hh = await boot({ push: null, overrides: { projects: { require: () => { throw new Error('boom'); } } } });
    const messages: string[] = [];
    const take = (res: { json: <T>() => T }) => messages.push((res.json<{ error: { message: string } }>()).error.message);
    take(await api(hh, 'GET', '/counts'));                                                                           // 401
    take(await api(hh, 'POST', '/projects', { token: hh.tokens.read, body: { name: 'x' } }));                         // 403 scope
    take(await raw(hh.port, { path: '/api/v1/health', headers: { host: 'evil.example' } }));                         // 403 host
    take(await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: { name: 'x' }, headers: { origin: 'https://evil.example' } })); // 403 origin
    take(await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: {} }));                                 // 400 body
    take(await api(hh, 'GET', '/reports?limit=zero', { token: hh.tokens.read }));                                     // 400 query
    take(await raw(hh.port, { method: 'POST', path: '/api/v1/projects', headers: { authorization: `Bearer ${hh.tokens.desktop}` }, body: '{' })); // invalid json
    take(await raw(hh.port, { method: 'POST', path: '/api/v1/projects', headers: { authorization: `Bearer ${hh.tokens.desktop}` }, body: 'x'.repeat(1024 * 1024 + 1) })); // 413
    take(await api(hh, 'GET', '/nothing', { token: hh.tokens.read }));                                                // 404
    take(await api(hh, 'GET', '/sessions/nope', { token: hh.tokens.read }));                                          // 400 session key
    take(await api(hh, 'GET', '/deliveries/d1/parts/x', { token: hh.tokens.desktop }));                               // 400 part
    take(await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: { name: 'x' }, headers: { 'idempotency-key': 'a b' } })); // 400 key
    take(await api(hh, 'POST', '/push/configure', { token: hh.tokens.desktop, body: { serviceAccountJson: 'x'.repeat(60) } })); // 503
    take(await api(hh, 'POST', '/conversations/c1/verify', { token: hh.tokens.desktop }));                            // 503
    take(await api(hh, 'GET', '/projects/p1', { token: hh.tokens.read }));                                            // 500
    hh.devices.redeemImpl = () => { throw new CoreError(400, 'wrong_code', 'That code is wrong.'); };
    for (let i = 0; i < 20; i++) await api(hh, 'POST', '/pairing/redeem', { body: { offerId: 'o', code: 'abcdefgh1234', deviceName: 'x', platform: 'android' } });
    take(await api(hh, 'POST', '/pairing/redeem', { body: { offerId: 'o', code: 'abcdefgh1234', deviceName: 'x', platform: 'android' } })); // 429
    await api(hh, 'POST', '/activity/read', { token: hh.tokens.read, body: { all: true }, headers: { 'idempotency-key': 'k' } });
    hh.db.run("INSERT INTO idempotency (key, principal, route, response_status, response_json, created_at) VALUES ('k2','desktop','projects.create',200,'{\"v\":1,\"fp\":\"other\",\"body\":{}}', ?)", [hh.clock.now().toISOString()]);
    take(await api(hh, 'POST', '/projects', { token: hh.tokens.desktop, body: { name: 'x' }, headers: { 'idempotency-key': 'k2' } })); // 422
    expect(messages.length).toBe(17);
    for (const m of messages) {
      expect(m, m).not.toMatch(/\u2014|\u2013/);
      expect(m.trim().length).toBeGreaterThan(15);
      expect(m, m).toMatch(/[.!]$/);
    }
  });
});
