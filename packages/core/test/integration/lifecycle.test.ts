// Sessions, terminals, permission prompts, restarts: the real core with real PTYs and the fake Claude CLI.
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@minisumma/shared';
import { directive, readContext, readReceived, readTerminalSize, waitFor as waitUntil, writeExternals } from '../../src/testing/fake-claude/index.ts';
import { cleanup, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const CONV = { A: 'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const open: Harness[] = [];
afterEach(async () => { while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); } });
const boot = async (...a: Parameters<typeof startHarness>) => { const h = await startHarness(...a); open.push(h); return h; };

const sessionOf = (h: Harness, key: string) => h.client.call('sessions.get', { params: { key } });

describe('managed terminals', () => {
  it('starts Claude in the project folder with the report protocol injected, and typed input reaches only that session', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const b = await h.project('Markdown Studio');
    const sa = await h.start(a.project.id);
    const sb = await h.start(b.project.id);
    expect(sa.cwd).toBe(a.dir);
    expect(sb.cwd).toBe(b.dir);

    // The SessionStart hook of a registered project injects the report protocol; no repository CLAUDE.md is involved.
    const ctx = await waitUntil(() => readContext(h.stateDir, sa.sessionId), 'protocol context');
    expect(ctx).toContain('mini-summa:report');

    await h.type(sa.key, 'hello from A');
    const got = await waitUntil(() => readReceived(h.stateDir, sa.sessionId)[0], 'input to A');
    expect(got.text).toBe('hello from A');
    expect(readReceived(h.stateDir, sb.sessionId)).toEqual([]);           // B never saw it

    // The terminal replays what was already printed to a late attacher (session switching/reload) and keeps streaming.
    const chunks: string[] = []; let replay = '';
    const handle = h.client.terminal.attach(sa.key, { cols: 90, rows: 24 }, { onAttached: (i) => { replay = i.replay; }, onData: (d) => chunks.push(d), onExit() {}, onError() {} });
    await waitUntil(() => replay.length > 0, 'terminal replay');
    expect(replay).toContain('hello from A');
    // Resize reaches the process.
    handle.resize(132, 40);
    expect(await waitUntil(() => { const s = readTerminalSize(h.stateDir, sa.sessionId); return s?.cols === 132 && s.rows === 40 ? s : undefined; }, 'resize')).toMatchObject({ cols: 132, rows: 40 });
    handle.detach();
  }, 60_000);

  it('keeps unrelated sessions alive when another project\'s session is stopped, and supports several sessions in one project', async () => {
    const h = await boot();
    const a = await h.project('GitManager');
    const b = await h.project('Herc');
    const a1 = await h.start(a.project.id, { name: 'storage' });
    const a2 = await h.start(a.project.id, { name: 'tests' });
    const b1 = await h.start(b.project.id);
    expect(new Set([a1.key, a2.key, b1.key]).size).toBe(3);
    expect((await h.client.call('sessions.list', { query: { projectId: a.project.id } })).map((s) => s.key).sort()).toEqual([a1.key, a2.key].sort());

    await h.client.call('sessions.stop', { params: { key: a1.key }, body: { force: true } });
    await h.waitFor('a1 to leave live', async () => (await sessionOf(h, a1.key)).availability !== 'live');
    expect((await sessionOf(h, a2.key)).availability).toBe('live');
    expect((await sessionOf(h, b1.key)).availability).toBe('live');

    // Never a second copy of a live session: resuming something that is still running is refused.
    await expect(h.client.call('sessions.start', { params: { id: a.project.id }, body: { mode: 'resume', resumeKey: a2.key } }))
      .rejects.toMatchObject({ status: 422 });
  }, 60_000);

  it('turns a permission prompt into an attention entry and an approval item that answers the real dialog', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const b = await h.project('Herc');
    const sa = await h.start(a.project.id);
    const sb = await h.start(b.project.id);
    await h.type(sa.key, `Clean the build ${directive.permission('bash', 'echo mini-summa-permission-check')}`);

    const view = await h.waitFor('needs_permission', async () => { const v = await sessionOf(h, sa.key); return v.state === 'needs_permission' ? v : undefined; });
    expect(view.attention).toMatchObject({ kind: 'permission' });
    expect((await sessionOf(h, sb.key)).attention).toBeNull();              // B is unaffected

    const act = await h.waitFor('permission action', async () => (await h.client.call('actions.list', { query: { status: 'pending' } })).find((x) => x.kind === 'permission'));
    expect(act).toMatchObject({ sessionKey: sa.key, status: 'pending' });
    const feed = (await h.client.call('activity.list', { query: { requiresAction: true } })).items;
    expect(feed.some((e) => e.type === 'needs_permission' && e.sessionKey === sa.key && e.requiresAction)).toBe(true);
    expect(h.native.notifications.some((n) => n.title.includes('GitManager') && n.target.sessionKey === sa.key)).toBe(true);

    const approved = await h.client.call('actions.approve', { params: { id: act.id } });
    expect(approved.status).toBe('executed');
    await h.waitFor('session leaves permission', async () => (await sessionOf(h, sa.key)).state !== 'needs_permission');
    await h.waitFor('attention entry resolved', async () => (await h.client.call('activity.list', { query: { requiresAction: true } })).items.every((e) => e.type !== 'needs_permission'));
  }, 60_000);

  it('records a plain turn end as a turn end, not as a finished task', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const sa = await h.start(a.project.id);
    await h.type(sa.key, 'just answer a question');
    const entry = await h.waitFor('turn_ended', async () => (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended'));
    expect(entry.description).toMatch(/does not mean the task is complete/);
    expect((await h.client.call('reports.list', {})).items).toEqual([]);
    const cands = await h.client.call('candidates.list', {});
    expect(cands).toHaveLength(1);                                           // the message is preserved, not discarded
    expect(cands[0].reason).toBe('no_marker');
  }, 60_000);
});

describe('restart', () => {
  it('keeps pending reports and delivery state exactly as left, and never repeats a handoff or a notification', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const sa = await h.start(a.project.id);
    await h.type(sa.key, `Done ${directive.report({ task: 'Storage System' })}`);
    const report = await h.waitFor('report', async () => (await h.client.call('reports.list', {})).items[0]);
    const delivery = (await h.client.call('deliveries.list', { query: { reportId: report.id } }))[0];
    await h.client.call('deliveries.copy', { params: { id: delivery.id }, body: {} });
    const stateBefore = (await h.client.call('deliveries.get', { params: { id: delivery.id } }));
    expect(stateBefore.state).toBe('copied');
    const notificationsBefore = h.native.notifications.length;
    expect(notificationsBefore).toBeGreaterThan(0);

    const again = await h.restart(); open.push(again);
    const back = (await again.client.call('deliveries.get', { params: { id: delivery.id } }));
    expect(back.state).toBe('copied');                                       // not advanced, not reset, not resubmitted
    expect(back.destination).toEqual(stateBefore.destination);
    expect(again.native.clipboardWrites).toEqual([]);                        // a restart copies nothing
    expect(again.native.opened).toEqual([]);                                 // and opens nothing
    expect(again.native.notifications).toEqual([]);                          // and replays no notification
    const reports = (await again.client.call('reports.list', {})).items;
    expect(reports.map((r) => r.id)).toEqual([report.id]);                   // one report, not two
    expect((await again.client.call('reports.get', { params: { id: report.id } })).body).toContain('## Implementation Report');
    const feed = (await again.client.call('activity.list', {})).items.filter((e) => e.type === 'report_ready');
    expect(feed).toHaveLength(1);
  }, 60_000);

  it('does not claim a terminal survived: the managed session becomes disconnected and can be resumed', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    const sa = await h.start(a.project.id);
    await h.type(sa.key, 'a first prompt so the session is saved');
    await waitUntil(() => readReceived(h.stateDir, sa.sessionId)[0], 'prompt');
    await h.waitFor('turn finished', async () => (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended' && e.sessionKey === sa.key));

    const again = await h.restart(); open.push(again);
    const view = await again.client.call('sessions.get', { params: { key: sa.key } });
    expect(view.origin).toBe('managed');
    expect(view.availability).not.toBe('live');
    expect(['disconnected', 'resumable']).toContain(view.availability);
    expect(view.terminal?.exited ?? true).toBe(true);

    const resumed = await again.client.call('sessions.start', { params: { id: a.project.id }, body: { mode: 'resume', resumeKey: sa.key } });
    expect(resumed.key).toBe(sa.key);                                        // same session, new process
    await again.waitFor('live again', async () => (await again.client.call('sessions.get', { params: { key: sa.key } })).availability === 'live');
  }, 60_000);
});

describe('sessions started elsewhere', () => {
  it('are observed and attributed by folder, labelled external, and never typed into', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV.A] });
    writeExternals(h.stateDir, [{
      cwd: a.dir, kind: 'interactive', startedAt: Date.now() - 60_000, pid: process.pid, status: 'idle', sessionId: '99999999-9999-4999-8999-999999999999', name: 'terminal one',
    }]);
    await h.client.call('sessions.refresh', { body: {} });
    const ext = await h.waitFor('external session', async () => (await h.client.call('sessions.list', {})).find((s) => s.sessionId === '99999999-9999-4999-8999-999999999999'));
    expect(ext).toMatchObject({ origin: 'external', projectId: a.project.id, availability: 'live' });
    expect(ext.terminal).toBeNull();
    await expect(h.client.call('actions.create', { body: { sessionKey: ext.key, text: 'do it' } }))
      .rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.status === 422 && /Remote Control|observed/i.test(e.message));
    await expect(h.client.call('sessions.stop', { params: { key: ext.key }, body: {} })).rejects.toMatchObject({ status: 422 });
  }, 60_000);
});
