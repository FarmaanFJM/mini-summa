// /clear and /resume change the Claude session id INSIDE the running process. The managed terminal must stay the managed
// terminal, now bound to the new id: the real core with real PTYs and the fake Claude CLI (which does what the real 2.1.314 does:
// SessionEnd then SessionStart, and `claude agents --json` lists the new id with the same pid).
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { MiniSummaClient } from '@minisumma/shared';
import type { SessionKey, SessionView } from '@minisumma/shared';
import { directive, readReceived, typedCommand, waitFor as waitUntil } from '../../src/testing/fake-claude/index.ts';
import { cleanup, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const CONV = { A: 'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B: 'https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const open: Harness[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); }
});
const boot = async (...a: Parameters<typeof startHarness>) => { const h = await startHarness(...a); open.push(h); return h; };

const get = (h: Harness, key: SessionKey) => h.client.call('sessions.get', { params: { key } });
const READY = ['idle', 'turn_ended', 'waiting_for_you', 'report_ready'];
const ready = (h: Harness, key: SessionKey) => h.waitFor(`${key} to be ready for input`, async () => { const v = await get(h, key); return READY.includes(v.state) ? v : undefined; });

/** The live managed session of the project that is not `old`. */
const successorOf = (h: Harness, projectId: string, old: SessionKey) => h.waitFor('the terminal to follow the new session id', async () => {
  const all = await h.client.call('sessions.list', { query: { projectId, includeEnded: true } });
  return all.find((s) => s.origin === 'managed' && s.availability === 'live' && s.key !== old);
}, 20_000);

const reportsOf = async (h: Harness, projectId: string) => (await h.client.call('reports.list', { query: { projectId } })).items;

async function pairPhone(h: Harness) {
  const offer = await h.client.call('pairing.createOffer', { body: { scopes: ['read', 'prompt'] } });
  const anon = new MiniSummaClient({ baseUrl: h.core.baseUrl, token: '' });
  const res = await anon.call('pairing.redeem', { body: { offerId: offer.id, code: offer.code, deviceName: 'Pixel', platform: 'android' } });
  const phone = new MiniSummaClient({ baseUrl: h.core.baseUrl, token: res.token, clientName: 'Pixel', WebSocket: WebSocket as never });
  closers.push(() => phone.close());
  return phone;
}

describe('/clear inside a managed terminal', () => {
  it('keeps the terminal managed under the new session id; the old id becomes history', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A, CONV.B] });
    const old = await h.start(a.project.id, { name: 'work' });
    await h.client.call('sessions.setDefault', { params: { key: old.key }, body: { isDefault: true } });

    // History of the old key: a prompt with a report, seen through a terminal that stays attached across the /clear.
    await h.type(old.key, `Fix the login ${directive.report({ task: 'Before the clear' })}`);
    await h.waitFor('the first report', async () => (await reportsOf(h, a.project.id)).length === 1);
    const beforeReport = (await reportsOf(h, a.project.id))[0];
    expect(beforeReport.sessionKey).toBe(old.key);
    await ready(h, old.key);
    const events: { type: string; key?: string }[] = [];
    const offBus = h.client.events.onEvent((_seq, e) => {
      if (e.type === 'session.upserted') events.push({ type: e.type, key: e.session.key });
      else if (e.type === 'session.removed') events.push({ type: e.type, key: e.key });
    });
    const output: string[] = [];
    let replay = '';
    const attachedOld = h.client.terminal.attach(old.key, { cols: 100, rows: 30 }, { onAttached: (i) => { replay = i.replay; }, onData: (d) => output.push(d), onExit() {}, onError() {} });
    await waitUntil(() => replay.includes('Fix the login'), 'the replay of the old terminal');

    // ---- /clear, typed at the terminal
    attachedOld.input(typedCommand.clear);
    await new Promise((r) => setTimeout(r, 60));
    attachedOld.input('\r');
    const next = await successorOf(h, a.project.id, old.key);
    offBus();

    // the new key is the managed, live terminal; nothing else is
    expect(next.sessionId).not.toBe(old.sessionId);
    expect(next).toMatchObject({ origin: 'managed', availability: 'live', env: old.env, projectId: a.project.id, projectResolution: 'managed', name: 'work', cwd: old.cwd });
    expect(next.pid).toBe(old.pid);                                         // the very same process
    expect((await get(h, old.key)).startedAt).toBe(next.startedAt);          // and the same run: the start time is what ties a client's old tab to the new session
    expect(next.isProjectDefault).toBe(true);                               // the default flag moved with the terminal
    expect(next.terminal).toMatchObject({ exited: false });
    const live = (await h.client.call('sessions.list', { query: { projectId: a.project.id } })).filter((s) => s.availability === 'live');
    expect(live.map((s) => s.key)).toEqual([next.key]);                      // no phantom, no duplicate
    expect((await h.client.call('system.state')).sessions.filter((s) => s.availability === 'live')).toHaveLength(1);

    // the old key is ordinary history: a managed record that ended, resumable (it had a prompt), saying what happened
    const left = await get(h, old.key);
    expect(left).toMatchObject({ origin: 'managed', availability: 'resumable', resumable: true, isProjectDefault: false });
    expect(left.termination?.kind).toBe('observed');
    expect(left.termination?.reason).toContain('/clear');
    expect(left.termination?.reason).toContain(next.sessionId.slice(0, 8));
    expect(left.attention).toBeNull();
    expect(left.pid).toBeNull();
    // everything that happened before stays with the old key and the project
    expect((await reportsOf(h, a.project.id)).filter((r) => r.sessionKey === old.key)).toHaveLength(1);
    expect(events.some((e) => e.key === next.key)).toBe(true);               // clients heard about both
    expect(events.some((e) => e.key === old.key)).toBe(true);

    // ---- continuity: the terminal that was attached to the old key kept receiving output and still takes input
    await waitUntil(() => output.join('').includes('Conversation cleared'), 'the clear banner on the attached terminal');
    attachedOld.input('typed through the old attachment');
    await new Promise((r) => setTimeout(r, 60));
    attachedOld.input('\r');
    expect((await waitUntil(() => readReceived(h.stateDir, next.sessionId)[0], 'input through the old attachment')).text).toBe('typed through the old attachment');
    expect(readReceived(h.stateDir, old.sessionId).map((r) => r.text)).toEqual([expect.stringContaining('Fix the login')]);   // the old id got nothing new

    // a fresh attach to the new key replays the whole scrollback, from before the clear
    let replayNew = '';
    const attachedNew = h.client.terminal.attach(next.key, { cols: 100, rows: 30 }, { onAttached: (i) => { replayNew = i.replay; }, onData() {}, onExit() {}, onError() {} });
    await waitUntil(() => replayNew.length > 0, 'replay of the new key');
    expect(replayNew).toContain('Fix the login');
    expect(replayNew).toContain('Conversation cleared');
    attachedNew.detach();
    attachedOld.detach();

    // ---- a prompt from a phone to the NEW key waits for approval and is typed into the same terminal
    const phone = await pairPhone(h);
    await ready(h, next.key);
    const pending = await phone.call('actions.create', { body: { sessionKey: next.key, text: 'After the clear, please continue' } });
    expect(pending).toMatchObject({ status: 'pending', sessionKey: next.key });
    await new Promise((r) => setTimeout(r, 300));
    expect(readReceived(h.stateDir, next.sessionId).map((r) => r.text)).not.toContain('After the clear, please continue');
    const executed = await h.client.call('actions.approve', { params: { id: pending.id } });
    expect(executed.status).toBe('executed');
    expect((await waitUntil(() => readReceived(h.stateDir, next.sessionId).find((r) => r.text === 'After the clear, please continue'), 'the phone prompt in the new session')).text).toBe('After the clear, please continue');

    // ---- a report captured after the clear belongs to the new managed key, the project and its conversation
    await ready(h, next.key);
    await h.type(next.key, `Second task ${directive.report({ task: 'After the clear' })}`);
    const after = await h.waitFor('the report after the clear', async () => (await reportsOf(h, a.project.id)).find((r) => r.taskTitle === 'After the clear'));
    expect(after).toMatchObject({ sessionKey: next.key, projectId: a.project.id });
    const delivery = (await h.client.call('deliveries.list', { query: { reportId: after.id } }))[0];
    expect(delivery.destination?.url).toBeTruthy();
    expect((await get(h, next.key)).state).toBe('report_ready');

    // the old key's reports were not moved
    expect((await reportsOf(h, a.project.id)).find((r) => r.id === beforeReport.id)?.sessionKey).toBe(old.key);
  }, 90_000);

  it('a phone prompt that was waiting for the OLD conversation is not typed into the new one: approving it fails and says why', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const old = await h.start(a.project.id);
    await h.type(old.key, 'first conversation');
    await waitUntil(() => readReceived(h.stateDir, old.sessionId)[0], 'the first prompt');
    await ready(h, old.key);
    const phone = await pairPhone(h);
    const waiting = await phone.call('actions.create', { body: { sessionKey: old.key, text: 'written for the old conversation' } });
    expect(waiting.status).toBe('pending');
    await h.type(old.key, typedCommand.clear);
    const next = await successorOf(h, a.project.id, old.key);
    await ready(h, next.key);

    const result = await h.client.call('actions.approve', { params: { id: waiting.id } }).catch((e: unknown) => e);
    const done = result as { status?: string; failure?: string | null };
    expect(done.status).toBe('failed');
    expect(done.failure).toContain('replaced inside its terminal');
    await new Promise((r) => setTimeout(r, 400));
    expect(readReceived(h.stateDir, next.sessionId).map((r) => r.text)).not.toContain('written for the old conversation');
    expect(readReceived(h.stateDir, old.sessionId).map((r) => r.text)).not.toContain('written for the old conversation');
    // a NEW prompt for the old key is refused at creation, with the same words
    await expect(phone.call('actions.create', { body: { sessionKey: old.key, text: 'again' } })).rejects.toMatchObject({ status: 422 });
  }, 60_000);

  it('a permission dialog in the new session is offered for approval and answered in the same terminal', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const old = await h.start(a.project.id);
    await h.type(old.key, typedCommand.clear);
    const next = await successorOf(h, a.project.id, old.key);
    await ready(h, next.key);

    await h.type(next.key, `Clean the build ${directive.permission('bash', 'echo continuity-permission-check')}`);
    const act = await h.waitFor('a permission action for the new key', async () => (await h.client.call('actions.list', { query: { status: 'pending' } })).find((x) => x.kind === 'permission' && x.sessionKey === next.key));
    expect(act).toMatchObject({ status: 'pending', sessionKey: next.key });
    expect((await get(h, next.key)).state).toBe('needs_permission');
    expect((await get(h, old.key)).attention).toBeNull();
    const done = await h.client.call('actions.approve', { params: { id: act.id } });
    expect(done.status).toBe('executed');
    await h.waitFor('the dialog to be answered', async () => (await get(h, next.key)).state !== 'needs_permission');
  }, 60_000);

  it('/resume inside the terminal moves it back to the older session, which is managed and live again', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const first = await h.start(a.project.id, { name: 'first' });
    await h.type(first.key, 'a first prompt so that a transcript exists');
    await waitUntil(() => readReceived(h.stateDir, first.sessionId)[0], 'the first prompt');
    await ready(h, first.key);
    await h.type(first.key, typedCommand.clear);
    const second = await successorOf(h, a.project.id, first.key);
    await ready(h, second.key);

    await h.type(second.key, typedCommand.resume(first.sessionId));
    const back = await h.waitFor('the terminal to follow back to the first session', async () => {
      const v = await get(h, first.key);
      return v.origin === 'managed' && v.availability === 'live' ? v : undefined;
    }, 20_000);
    expect(back.pid).toBe(first.pid);
    expect(back.terminal).toMatchObject({ exited: false });
    const gone = await get(h, second.key);
    expect(gone).toMatchObject({ origin: 'managed', availability: 'ended' });  // it never received a prompt: nothing to resume
    expect(gone.termination?.reason).toContain('/resume');
    expect((await h.client.call('sessions.list', { query: { projectId: a.project.id } })).filter((s) => s.availability === 'live').map((s) => s.key)).toEqual([first.key]);

    // and it still takes input, under the first id
    await ready(h, first.key);
    await h.type(first.key, 'typed after the resume');
    expect((await waitUntil(() => readReceived(h.stateDir, first.sessionId).find((r) => r.text === 'typed after the resume'), 'input after the resume')).text).toBe('typed after the resume');
  }, 90_000);

  it('a directive in a prompt (what a model or a plan does) clears the conversation the same way', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const old = await h.start(a.project.id);
    await h.type(old.key, `Clear context and proceed ${directive.clear()}`);
    const next = await successorOf(h, a.project.id, old.key);
    expect(next.pid).toBe(old.pid);
    const left = await get(h, old.key);
    expect(left.attention).toBeNull();                                         // the end was explained: not an alarm
    expect(left.availability).toBe('resumable');
  }, 60_000);
});

describe('evidence', () => {
  it('while Claude\'s listing still names the old id, the hooks alone do not move the terminal; it says so, then follows when the listing catches up', async () => {
    process.env.FAKE_CLAUDE_REGISTRY_LAG_MS = '1500';
    try {
      const h = await boot();
      const a = await h.project('GitManager', { conversations: [CONV.A] });
      const old = await h.start(a.project.id, { name: 'work' });
      await h.client.call('sessions.refresh', { body: {} });          // a healthy listing exists: the process id will decide
      await h.type(old.key, typedCommand.clear);

      // the hooks are in, the listing is not: pending, nothing adopted, nothing guessed
      const pendingView = await h.waitFor('the pending notice', async () => {
        const v = await get(h, old.key);
        return v.stateLabel === 'Conversation replaced, learning the new session' ? v : undefined;
      }, 5000);
      expect(pendingView).toMatchObject({ origin: 'managed', availability: 'live' });
      const during = await h.client.call('sessions.list', { query: { projectId: a.project.id } });
      expect(during.filter((s) => s.origin === 'managed' && s.availability === 'live').map((s) => s.key)).toEqual([old.key]);
      const refused = await h.core.services.sessions.typeInto(old.key, { text: 'too early', submit: true, expectGeneration: null, allowedStates: ['idle', 'ended'] });
      expect(refused).toMatchObject({ ok: false, problem: expect.stringContaining('learning the new session id') });

      const next = await successorOf(h, a.project.id, old.key);                 // the listing catches up: the terminal follows
      expect(next.pid).toBe(old.pid);
      expect((await get(h, old.key)).availability).toBe('ended');               // it never received a prompt: nothing to resume
    } finally { delete process.env.FAKE_CLAUDE_REGISTRY_LAG_MS; }
  }, 60_000);

  it('a forged spool record cannot take over a terminal: the process id says the terminal still runs its own session', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const old = await h.start(a.project.id, { name: 'work' });
    await h.client.call('sessions.refresh', { body: {} });
    const stranger = '99999999-9999-4999-8999-999999999999';
    const spool = path.join(h.dataDir, 'spool', 'posix');
    const forge = (event: string, sessionId: string, extra: Record<string, unknown>, n: number) => {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const record = {
        schema: 'mini-summa.spool/1',
        transport: {
          transport_id: id, received_at: new Date().toISOString(), wall_ms: Date.now(), monotonic_ns: String(Date.now()) + '000000', capture_version: 1, hook_arg: event,
          handler_id: 'ms-managed', env_id: 'posix', clock_domain: null, pid: 1, ppid: 1, platform: 'linux', claude_project_dir: old.cwd, claude_config_dir: null,
          claude_code_remote: null, redactions: 0, truncations: 0, truncated_chars: 0, parse_error: null,
        },
        payload: { session_id: sessionId, transcript_path: '/x/y.jsonl', cwd: old.cwd, hook_event_name: event, ...extra },
      };
      fs.mkdirSync(spool, { recursive: true });
      fs.writeFileSync(path.join(spool, `${record.transport.monotonic_ns.padStart(20, '0')}-${id}.json`), JSON.stringify(record));
    };
    forge('SessionEnd', old.sessionId, { reason: 'clear' }, 1);
    forge('SessionStart', stranger, { source: 'clear' }, 2);
    const strangerKey = `posix|${stranger}` as SessionKey;
    await h.waitFor('the forged records to be read', async () => (await h.client.call('sessions.list', { query: { includeEnded: true } })).some((s) => s.key === strangerKey));
    await new Promise((r) => setTimeout(r, 2500));                              // longer than the first retries of the fresh listings
    expect(await get(h, strangerKey)).toMatchObject({ origin: 'external' });
    expect(await get(h, old.key)).toMatchObject({ origin: 'managed', availability: 'live', pid: old.pid });
    const managedLive = (await h.client.call('sessions.list', { query: { projectId: a.project.id, includeEnded: true } })).filter((s) => s.origin === 'managed');
    expect(managedLive.map((s) => s.key)).toEqual([old.key]);                   // nothing was re-keyed, nothing was invented
  }, 60_000);
});

describe('restart after a /clear', () => {
  it('shows the record with the new id as the one that can be resumed, and resumes it with the new id', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const old = await h.start(a.project.id, { name: 'work' });
    await h.type(old.key, 'a prompt in the first conversation');
    await waitUntil(() => readReceived(h.stateDir, old.sessionId)[0], 'first prompt');
    await ready(h, old.key);
    await h.type(old.key, typedCommand.clear);
    const next = await successorOf(h, a.project.id, old.key);
    await ready(h, next.key);
    await h.type(next.key, 'a prompt in the new conversation');
    await waitUntil(() => readReceived(h.stateDir, next.sessionId)[0], 'a prompt in the new conversation');
    await h.waitFor('the new conversation to have answered', async () => (await get(h, next.key)).state === 'turn_ended');

    const again = await h.restart(); open.push(again);
    const afterNew = await get(again, next.key);
    // (a graceful quit ends the terminals itself; a crash would leave 'disconnected', which the managed-rekey test covers)
    expect(afterNew).toMatchObject({ origin: 'managed', availability: 'resumable', resumable: true, name: 'work' });
    expect(afterNew.projectId).toBe(a.project.id);
    const afterOld = await get(again, old.key);
    expect(afterOld).toMatchObject({ origin: 'managed', availability: 'resumable' });
    expect(afterOld.termination?.reason).toContain('/clear');
    expect((await again.client.call('sessions.list', {})).filter((s) => s.availability === 'live')).toEqual([]);
    expect(again.core.baseUrl).toBeTruthy();

    // resuming the session that was running starts `claude --resume <new id>`, and it is the same key again
    const resumed = await again.client.call('sessions.start', { params: { id: a.project.id }, body: { mode: 'resume', resumeKey: next.key } });
    expect(resumed.key).toBe(next.key);
    await again.waitFor('the resumed session to be live', async () => { const v = await get(again, next.key); return v.availability === 'live' && v.state !== 'unknown' ? v : undefined; });
    const arg = fs.readdirSync(again.stateDir).filter((f) => f === `env-${next.sessionId}.json`);
    expect(arg).toHaveLength(1);
    expect(fs.existsSync(path.join(again.stateDir, `hooks-${next.sessionId}.jsonl`))).toBe(true);
  }, 120_000);
});

// keeps the unused imports honest for tsc when a case above is removed
export type _Unused = SessionView;
