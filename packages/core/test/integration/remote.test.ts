// Phones, pairing, scopes, the approval boundary for prompts, notification rules, minimal push payloads and the
// consent flow for Claude hooks: the real core, real PTYs, the fake Claude CLI and a local stand-in for Firebase.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, MiniSummaClient } from '@minisumma/shared';
import type { Scope } from '@minisumma/shared';
import { directive, readReceived, waitFor as waitUntil } from '../../src/testing/fake-claude/index.ts';
import { cleanup, startHarness, HOST_ENV } from './harness.ts';
import type { Harness } from './harness.ts';

const CONV = { A: 'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const open: Harness[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); }
});
const boot = async (...a: Parameters<typeof startHarness>) => { const h = await startHarness(...a); open.push(h); return h; };

async function pair(h: Harness, scopes: ('read' | 'notify' | 'prompt' | 'approve')[], name = 'Pixel') {
  const offer = await h.client.call('pairing.createOffer', { body: { scopes } });
  const anon = new MiniSummaClient({ baseUrl: h.core.baseUrl, token: '' });
  const res = await anon.call('pairing.redeem', { body: { offerId: offer.id, code: offer.code, deviceName: name, platform: 'android' } });
  const phone = new MiniSummaClient({ baseUrl: h.core.baseUrl, token: res.token, clientName: name, WebSocket: WebSocket as never });
  closers.push(() => phone.close());
  return { phone, device: res.device, offer, token: res.token };
}

const status = (p: Promise<unknown>): Promise<number> => p.then(() => 200, (e: unknown) => (e instanceof ApiError ? e.status : -1));

describe('pairing and scopes', () => {
  it('pairs once with a one-time code, enforces scopes on every call, and a revoked phone is cut off', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const { phone, device, offer, token } = await pair(h, ['read', 'notify']);
    expect(offer.qrPayload).toMatch(/^minisumma:\/\/pair\?/);
    expect(device.scopes.sort()).toEqual(['notify', 'read']);
    expect(JSON.stringify(device)).not.toContain(token);                       // the token is never listed again

    expect((await phone.call('system.state')).projects.map((p) => p.id)).toEqual([a.project.id]);
    expect(await status(phone.call('projects.create', { body: { name: 'Nope', roots: [] } }))).toBe(403);
    expect(await status(phone.call('devices.list'))).toBe(403);
    expect(await status(phone.call('hooks.list'))).toBe(403);
    expect(await status(phone.call('deliveries.handoff', { params: { id: 'dlv_x' }, body: {} }))).toBe(403);
    expect(await status(phone.call('actions.create', { body: { sessionKey: 'posix|x', text: 'hi' } }))).toBe(403);   // no prompt scope

    // A code works once. Replaying it, or guessing, gets nowhere.
    const anon = new MiniSummaClient({ baseUrl: h.core.baseUrl, token: '' });
    expect(await status(anon.call('pairing.redeem', { body: { offerId: offer.id, code: offer.code, deviceName: 'Again', platform: 'android' } }))).toBe(410);
    const o2 = await h.client.call('pairing.createOffer', { body: {} });
    for (let i = 0; i < 4; i++) expect(await status(anon.call('pairing.redeem', { body: { offerId: o2.id, code: `wrong-code-${i}-xxxxxxxx`, deviceName: 'X', platform: 'android' } }))).toBe(403);
    expect(await status(anon.call('pairing.redeem', { body: { offerId: o2.id, code: 'wrong-code-4-xxxxxxxx', deviceName: 'X', platform: 'android' } }))).toBe(429);
    expect(await status(anon.call('pairing.redeem', { body: { offerId: o2.id, code: o2.code, deviceName: 'X', platform: 'android' } }))).toBe(410);   // burned, even with the right code

    // Live events: a phone gets project events but never the desktop-only topics, and cannot attach terminals.
    const seen: string[] = []; const termErrors: string[] = [];
    phone.events.onEvent((_s, e) => seen.push(e.type));
    phone.events.connect();
    await h.waitFor('phone stream', () => phone.events.status === 'open');
    await h.client.call('projects.update', { params: { id: a.project.id }, body: { name: 'GitManager 2' } });
    await h.client.call('settings.update', { body: { layout: { landscapeRatio: 0.4 } } });
    await h.waitFor('project event on the phone', () => seen.includes('project.upserted'));
    expect(seen).not.toContain('settings.changed');
    phone.terminal.attach(`${HOST_ENV}|11111111-1111-4111-8111-111111111111`, { cols: 80, rows: 24 }, { onAttached() {}, onData() {}, onExit() {}, onError: (c) => termErrors.push(c) });
    await h.waitFor('terminal refusal', () => termErrors.length > 0);

    // Revoking cuts the phone off at once: requests fail and the socket is closed.
    await h.client.call('devices.revoke', { params: { id: device.id } });
    expect(await status(phone.call('system.state'))).toBe(401);
    await h.waitFor('phone stream closed', () => phone.events.status !== 'open');
    expect((await h.client.call('devices.list')).find((d) => d.id === device.id)?.revokedAt).not.toBeNull();
  }, 60_000);
});

describe('prompts from a phone', () => {
  // UNTESTED ON WINDOWS (first native runs, fake Claude behind a .cmd shim): a session stopped and started again (mode 'resume') is live again and its terminal shows the resumed conversation, but no new SessionStart hook is seen
  // from the restarted process within 15 s, so its generation does not move. Whether that is the fake CLI or a real defect needs a real Claude on Windows.
  it.skipIf(process.platform === 'win32')('wait for approval, are typed only into the verified session, and are refused when the target changed', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const s1 = await h.start(a.project.id, { name: 'one' });
    const s2 = await h.start(a.project.id, { name: 'two' });
    const { phone, device } = await pair(h, ['read', 'prompt']);
    const text = 'Please also update the README';

    const pending = await phone.call('actions.create', { body: { sessionKey: s1.key, text } }, { idempotencyKey: 'compose-1' });
    expect(pending).toMatchObject({ status: 'pending', kind: 'claude_prompt', sessionKey: s1.key, text });
    const again = await phone.call('actions.create', { body: { sessionKey: s1.key, text } }, { idempotencyKey: 'compose-1' });
    expect(again.id).toBe(pending.id);                                          // a retry cannot send twice
    expect((await h.client.call('actions.list', { query: { status: 'pending' } })).filter((x) => x.text === text)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(readReceived(h.stateDir, s1.sessionId)).toEqual([]);                  // nothing is typed before approval
    expect(await status(phone.call('actions.approve', { params: { id: pending.id } }))).toBe(403);   // and it cannot approve itself
    expect(h.native.notifications.some((n) => n.title.includes('GitManager'))).toBe(true);            // the desktop is told it is waiting

    const executed = await h.client.call('actions.approve', { params: { id: pending.id } });
    expect(executed.status).toBe('executed');
    expect((await waitUntil(() => readReceived(h.stateDir, s1.sessionId)[0], 'prompt in s1')).text).toBe(text);
    expect(readReceived(h.stateDir, s2.sessionId)).toEqual([]);                  // the other session in the same project saw nothing

    // The target changes between creation and approval: the session is stopped and resumed (new generation).
    await h.waitFor('s1 finished its turn', async () => (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended' && e.sessionKey === s1.key));
    const stale = await phone.call('actions.create', { body: { sessionKey: s1.key, text: 'second prompt' } });
    await h.client.call('sessions.stop', { params: { key: s1.key }, body: { force: true } });
    await h.waitFor('s1 down', async () => (await h.client.call('sessions.get', { params: { key: s1.key } })).availability !== 'live');
    await h.client.call('sessions.start', { params: { id: a.project.id }, body: { mode: 'resume', resumeKey: s1.key } });
    await h.waitFor('s1 live again with a new generation', async () => { const v = await h.client.call('sessions.get', { params: { key: s1.key } }); return v.availability === 'live' && v.generation >= 2; });
    const before = readReceived(h.stateDir, s1.sessionId).length;
    const result = await h.client.call('actions.approve', { params: { id: stale.id } }).catch((e: unknown) => e);
    const failed = result instanceof ApiError ? result : (result as { status: string; failure: string | null });
    if (failed instanceof ApiError) expect([409, 422]).toContain(failed.status);
    else { expect(failed.status).toBe('failed'); expect(failed.failure).toBeTruthy(); }
    await new Promise((r) => setTimeout(r, 400));
    expect(readReceived(h.stateDir, s1.sessionId).length).toBe(before);          // refused, not typed into the new process

    // A device the user explicitly trusts skips the second approval; nothing else changes.
    await h.client.call('devices.update', { params: { id: device.id }, body: { trusted: true } });
    await h.waitFor('s1 ready for input', async () => ['idle', 'turn_ended', 'waiting_for_you', 'report_ready'].includes((await h.client.call('sessions.get', { params: { key: s1.key } })).state));
    const direct = await phone.call('actions.create', { body: { sessionKey: s2.key, text: 'trusted prompt' } });
    expect(direct.status).toBe('executed');
    expect((await waitUntil(() => readReceived(h.stateDir, s2.sessionId)[0], 'prompt in s2')).text).toBe('trusted prompt');
  }, 90_000);

  it('a device with approve scope may not approve its own untrusted prompt', async () => {
    const h = await boot();
    const a = await h.project('GitManager');
    const s = await h.start(a.project.id);
    const { phone } = await pair(h, ['read', 'prompt', 'approve']);
    const p = await phone.call('actions.create', { body: { sessionKey: s.key, text: 'mine' } });
    expect(p.status).toBe('pending');
    expect(await status(phone.call('actions.approve', { params: { id: p.id } }))).toBe(403);
    expect(readReceived(h.stateDir, s.sessionId)).toEqual([]);
  }, 60_000);
});

describe('notifications', () => {
  it('respect per-project preferences and quiet mode, and keep unread state either way', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const b = await h.project('Herc');
    const sa = await h.start(a.project.id); const sb = await h.start(b.project.id);
    await h.client.call('projects.update', { params: { id: b.project.id }, body: { notificationPrefs: { permission: false } } });

    await h.type(sb.key, `x ${directive.permission('bash', 'echo b')}`);
    await h.waitFor('B needs permission', async () => (await h.client.call('sessions.get', { params: { key: sb.key } })).state === 'needs_permission');
    await new Promise((r) => setTimeout(r, 300));
    expect(h.native.notifications.filter((n) => n.target.sessionKey === sb.key)).toEqual([]);                  // switched off for B
    const feed = (await h.client.call('activity.list', { query: { projectId: b.project.id } })).items;
    expect(feed.some((e) => e.type === 'needs_permission' && !e.read)).toBe(true);                             // but the feed still has it, unread

    await h.client.call('settings.update', { body: { notifications: { quiet: { enabled: true } } } });
    await h.type(sa.key, `Done ${directive.report({ task: 'Quiet Task' })}`);
    const report = await h.waitFor('report', async () => (await h.client.call('reports.list', {})).items[0]);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.native.notifications.filter((n) => n.body.includes('Quiet Task') || n.title.includes('Quiet'))).toEqual([]);
    const records = await h.client.call('notifications.list', {});
    expect(records.some((n) => n.target.reportId === report.id && n.native === 'suppressed_quiet')).toBe(true);   // recorded, not shown
    expect((await h.client.call('system.counts')).unreadActivity).toBeGreaterThan(0);

    // Turning quiet mode off does not replay what was suppressed.
    await h.client.call('settings.update', { body: { notifications: { quiet: { enabled: false } } } });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.native.notifications.filter((n) => n.body.includes('Quiet Task'))).toEqual([]);
  }, 60_000);

  it('push carries ids and a fixed sentence only, never report text, task titles or paths', async () => {
    const fcm = await startFakeFcm();
    closers.push(() => fcm.close());
    const h = await boot({ core: { overrides: { pushEndpoint: fcm.url } } });
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const sa = await h.start(a.project.id);
    const { phone } = await pair(h, ['read', 'notify']);
    await h.client.call('push.configure', { body: { serviceAccountJson: fcm.serviceAccountJson } });
    await phone.call('devices.registerPush', { body: { provider: 'fcm', token: 'fcm-device-token-0123456789' } });

    await h.type(sa.key, `Done ${directive.report({ task: 'Secret Task Title 4711' })}`);
    const sent = await waitUntil(() => fcm.messages[0], 'a push message');
    const wire = JSON.stringify(sent);
    expect(sent.message.token).toBe('fcm-device-token-0123456789');
    expect(sent.message.notification).toEqual({ title: 'GitManager', body: 'A report is ready' });
    expect(Object.keys(sent.message.data).sort()).toEqual(['activityId', 'kind', 'projectId', 'reportId', 'sessionKey']);
    for (const secret of ['Secret Task Title 4711', 'Implementation Report', a.dir, 'echo', 'Done']) expect(wire).not.toContain(secret);
    expect(fcm.authorization[0]).toMatch(/^Bearer /);

    // Per-project push switch: the next report produces no push.
    await h.client.call('projects.update', { params: { id: a.project.id }, body: { notificationPrefs: { push: false } } });
    await h.waitFor('first report settled', async () => (await h.client.call('sessions.get', { params: { key: sa.key } })).state !== 'working');
    await h.type(sa.key, `More ${directive.report({ task: 'Second Task' })}`);
    await h.waitFor('second report', async () => (await h.client.call('reports.list', {})).items.length === 2);
    await new Promise((r) => setTimeout(r, 400));
    expect(fcm.messages).toHaveLength(1);
  }, 60_000);
});

describe('hook installation is permission-gated', () => {
  it('shows the exact change, applies only that plan, keeps other hooks, never duplicates and uninstalls cleanly', async () => {
    const realClaudeDir = path.join(process.env.HOME ?? '', '.claude', 'settings.json');
    const realBefore = fs.existsSync(realClaudeDir) ? fs.statSync(realClaudeDir).mtimeMs : null;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-int-hooks-'));
    const claudeDir = path.join(root, 'home', '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeDir;              // set BEFORE the core starts: the environment probe reads it once
    closers.push(() => { if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedConfigDir; });
    const h = await boot({ root });
    const settingsFile = path.join(claudeDir, 'settings.json');
    const original = `${JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }, null, 2)}\n`;
    fs.writeFileSync(settingsFile, original);

    const env = (await h.client.call('hooks.list')).find((s) => s.env === HOST_ENV)!;
    expect(env.installed).toBe(false);
    const plan = await h.client.call('hooks.plan', { body: { env: HOST_ENV, action: 'install' } });
    expect(plan.action).toBe('install');
    expect(plan.before).toBe(original);
    expect(plan.unifiedDiff).toContain('+');
    expect(plan.unifiedDiff).not.toMatch(/^-\s+"theme"/m);                       // nothing of the user's was removed
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(original);                // planning wrote nothing

    expect(await status(h.client.call('hooks.apply', { body: { env: HOST_ENV, action: 'install', planHash: `${'0'.repeat(64)}` } }))).toBe(409);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(original);                // a wrong consent changes nothing

    const installed = await h.client.call('hooks.apply', { body: { env: HOST_ENV, action: 'install', planHash: plan.planHash } });
    expect(installed.installed).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(JSON.stringify(after.hooks.PreToolUse)).toContain('echo user-hook');  // another application's hook survives
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']) {
      const ours = JSON.stringify(after.hooks[ev]).match(/--handler ms-user/g) ?? [];
      expect(ours, ev).toHaveLength(1);                                            // exactly one registration per event
    }
    expect(fs.readdirSync(path.join(h.dataDir, 'backups')).length).toBe(1);      // the original was backed up first

    expect((await h.client.call('hooks.plan', { body: { env: HOST_ENV, action: 'install' } })).action).toBe('noop');   // no duplicates

    const un = await h.client.call('hooks.plan', { body: { env: HOST_ENV, action: 'uninstall' } });
    await h.client.call('hooks.apply', { body: { env: HOST_ENV, action: 'uninstall', planHash: un.planHash } });
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual(JSON.parse(original));   // exactly the user's own config again

    if (realBefore !== null) expect(fs.statSync(realClaudeDir).mtimeMs).toBe(realBefore);       // the real ~/.claude was never touched
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------
// A local stand-in for Google's token endpoint and Firebase Cloud Messaging.
async function startFakeFcm() {
  const messages: { message: { token: string; notification: { title: string; body: string }; data: Record<string, string> } }[] = [];
  const authorization: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/token') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' }));
      } else if (req.url?.includes('/messages:send')) {
        authorization.push(String(req.headers.authorization ?? ''));
        messages.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: 'projects/demo-proj/messages/1' }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const serviceAccountJson = JSON.stringify({
    type: 'service_account', project_id: 'demo-proj', private_key_id: 'k1', client_email: 'sender@mini-summa-test.iam.gserviceaccount.com',
    private_key: privateKey, token_uri: `http://127.0.0.1:${port}/token`,
  });
  return { url: `http://127.0.0.1:${port}`, messages, authorization, serviceAccountJson, close: () => new Promise<void>((r) => server.close(() => r())) };
}
