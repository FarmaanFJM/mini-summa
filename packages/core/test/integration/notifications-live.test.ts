// "Claude finished" through the real core: the real hook script, spool, ingestion, reducer, orchestrator and notification service.
// Only two things are fakes: the Claude CLI (the model) and the desktop that would show the notification (it records the call).
//
// What these tests pin down:
//   * a turn that ends without a report notifies, once, and leads to the project and the session;
//   * a turn that ends WITH a report notifies as the report only, never also as "finished";
//   * the project that happens to be selected in the window does not matter: every project's sessions notify;
//   * what happened while Mini-Summa was not running is in the feed afterwards but is never shown as a toast.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeNotification, SessionKey } from '@minisumma/shared';
import { buildSettings } from '@minisumma/claude-integration';
import { directive, readHookRuns } from '../../src/testing/fake-claude/index.ts';
import { runHook } from '../claude/helpers/observer-hook.ts';
import { cleanup, startHarness, HOST_ENV } from './harness.ts';
import type { Harness } from './harness.ts';

const CONV = 'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const open: Harness[] = [];
afterEach(async () => { while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); } });
const boot = async (...a: Parameters<typeof startHarness>) => { const h = await startHarness(...a); open.push(h); return h; };

const OUTSIDE = '99999999-9999-4999-8999-999999999999';

/** One hook of a Claude session that is not Mini-Summa's (a terminal somewhere inside a folder), run through the REAL capture script. */
async function hookOf(h: Harness, sessionId: string, cwd: string, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  const layout = await h.core.services.environments.layout(HOST_ENV);
  const r = runHook({
    spool: layout.spoolDirHost, registry: layout.registryFileHost, env: HOST_ENV, handler: 'outside', event,
    payload: { session_id: sessionId, transcript_path: path.join(h.root, `${sessionId}.jsonl`), cwd, permission_mode: 'default', hook_event_name: event, ...extra },
  });
  expect(r.status).toBe(0);
}
const stopOf = (h: Harness, cwd: string, promptId: string, message: string, extra: Record<string, unknown> = {}) =>
  hookOf(h, OUTSIDE, cwd, 'Stop', { prompt_id: promptId, stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [], ...extra });
const promptOf = (h: Harness, cwd: string, promptId: string) => hookOf(h, OUTSIDE, cwd, 'UserPromptSubmit', { prompt_id: promptId, prompt: `question ${promptId}` });
const turn = async (h: Harness, sessionId: string, cwd: string, n: number) => {
  void sessionId;
  await promptOf(h, cwd, `prompt-${n}`);
  await stopOf(h, cwd, `prompt-${n}`, `answer ${n}`);
};
const REPORT = (task: string) => `Everything is done.\n\n## Implementation Report\n\nChanged things.\n\n<!-- mini-summa:report status=complete task="${task}" -->`;

const finishedBy = (h: Harness): NativeNotification[] => h.native.notifications.filter((n) => n.title.endsWith(': Claude finished'));
const titles = (h: Harness): string[] => h.native.notifications.map((n) => n.title);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Claude finished', () => {
  it('notifies once when a turn ends without a report, and leads to that project and session', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV] });
    const sa = await h.start(a.project.id);
    await h.type(sa.key, 'just answer a question');

    const note = await h.waitFor('the "Claude finished" notification', () => finishedBy(h)[0]);
    expect(note).toMatchObject({
      title: 'GitManager: Claude finished', urgency: 'normal', silent: false, suppressIfViewing: true,
      target: { view: 'workspace', projectId: a.project.id, sessionKey: sa.key },
    });
    expect(note.body).toMatch(/^Turn ended: GitManager \//);
    expect(note.tag).toMatch(/^drv_/);

    await pause(400); // nothing late follows
    expect(finishedBy(h)).toHaveLength(1);
    const records = await h.client.call('notifications.list', {});
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ native: 'sent', push: 'not_applicable', projectId: a.project.id, target: note.target });
    // The feed has the same moment, unread, without asking anything of the person.
    const entry = (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended');
    expect(entry).toMatchObject({ id: note.tag, read: false, requiresAction: false, severity: 'info' });
  }, 60_000);

  it('notifies a turn that ends with a report as the report only: never "finished" as well', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV] });
    const sa = await h.start(a.project.id);

    await h.type(sa.key, `Done ${directive.report({ task: 'Storage System' })}`);
    await h.waitFor('the report notification', () => h.native.notifications.find((n) => n.title === 'GitManager: report ready'));
    await pause(500); // time for a second notification to arrive if one were going to
    expect(titles(h)).toEqual(['GitManager: report ready']);
    const feed = (await h.client.call('activity.list', {})).items;
    expect(feed.filter((e) => e.type === 'report_ready')).toHaveLength(1);
    expect(feed.filter((e) => e.type === 'turn_ended')).toHaveLength(0);

    // A later turn without a report is a new turn and is announced, once.
    await h.type(sa.key, 'and one more thing');
    await h.waitFor('the "Claude finished" notification of the next turn', () => finishedBy(h)[0]);
    await pause(400);
    expect(titles(h)).toEqual(['GitManager: report ready', 'GitManager: Claude finished']);
  }, 60_000);

  it('is on for a project that an older build saved without the switch, and the switch then works', async () => {
    const first = await boot();
    const a = await first.project('GitManager');
    first.core.base.db.run('UPDATE projects SET notification_prefs_json = ? WHERE id = ?', [
      JSON.stringify({ enabled: true, permission: true, input: true, error: true, report: true, sessionEnded: false, presenceLost: true, push: true }), a.project.id,
    ]);
    const again = await first.restart(); open.push(again);
    expect((await again.client.call('projects.get', { params: { id: a.project.id } })).notificationPrefs).toMatchObject({ turnEnded: true });
    const sa = await again.start(a.project.id);
    await again.type(sa.key, 'a question after the upgrade');
    await again.waitFor('the "Claude finished" notification', () => finishedBy(again)[0]);
  }, 60_000);

  it('can be switched off per project, which leaves the feed entry and the other notifications alone', async () => {
    const h = await boot();
    const a = await h.project('GitManager');
    const sa = await h.start(a.project.id);
    expect((await h.client.call('projects.get', { params: { id: a.project.id } })).notificationPrefs.turnEnded).toBe(true);
    await h.client.call('projects.update', { params: { id: a.project.id }, body: { notificationPrefs: { turnEnded: false } } });

    await h.type(sa.key, 'a quiet question');
    await h.waitFor('the turn to end', async () => (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended'));
    await pause(400);
    expect(h.native.notifications).toEqual([]);
    expect(await h.client.call('notifications.list', {})).toEqual([]);

    await h.type(sa.key, `a permission question ${directive.permission('bash', 'echo still-notifies')}`);
    await h.waitFor('the permission notification', () => h.native.notifications.find((n) => n.title === 'GitManager: needs permission'));
  }, 60_000);

  it('notifies for the session of a project that is not selected in the window, and a project with nothing happening stays silent', async () => {
    const h = await boot();
    const a = await h.project('Alpha');
    const b = await h.project('Beta');
    const sa = await h.start(a.project.id);
    const sb = await h.start(b.project.id);
    // The window is on Beta, showing Beta's session.
    await h.client.call('settings.update', { body: { ui: { route: { projectId: b.project.id, view: 'workspace' }, perProject: { [b.project.id]: { sessionKey: sb.key } } } } });

    await h.type(sa.key, 'a question for Alpha');
    const note = await h.waitFor('the notification for Alpha', () => finishedBy(h).find((n) => n.title === 'Alpha: Claude finished'));
    expect(note.target).toEqual({ view: 'workspace', projectId: a.project.id, sessionKey: sa.key });
    await pause(300);
    expect(titles(h)).toEqual(['Alpha: Claude finished']);

    // The same for the other direction, and each notification points at its own session.
    await h.type(sb.key, 'a question for Beta');
    const second = await h.waitFor('the notification for Beta', () => finishedBy(h).find((n) => n.title === 'Beta: Claude finished'));
    expect(second.target).toEqual({ view: 'workspace', projectId: b.project.id, sessionKey: sb.key });
  }, 60_000);

  it('records "not shown: you were looking at it" when the desktop says so, and leaves the feed entry', async () => {
    const h = await boot();
    const a = await h.project('GitManager');
    const sa = await h.start(a.project.id);
    h.native.notify = async (n) => { h.native.notifications.push(n); return { shown: false, suppressed: 'viewing', reason: 'The window is in front on this session.' }; };

    await h.type(sa.key, 'a question I am watching');
    const record = await h.waitFor('the notification record', async () => (await h.client.call('notifications.list', {}))[0]);
    expect(record).toMatchObject({ title: 'GitManager: Claude finished', native: 'suppressed_viewing', push: 'not_applicable', readAt: null });
    expect((await h.client.call('activity.list', {})).items.some((e) => e.type === 'turn_ended')).toBe(true);
  }, 60_000);
});

describe('one turn, one notification (the real reducer, hooks as Claude Code fires them)', () => {
  it('a second Stop with no work in between a report and itself is the same turn, so "finished" does not follow the report', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV] });
    await hookOf(h, OUTSIDE, a.dir, 'SessionStart', { source: 'startup', model: 'fake' });
    await promptOf(h, a.dir, 'p1');
    await stopOf(h, a.dir, 'p1', REPORT('Storage System'));
    await h.waitFor('the report notification', () => h.native.notifications.find((n) => n.title === 'GitManager: report ready'));
    // A stop hook of the user's sent Claude on for one more step, and it stopped again without a marker. No prompt, no tool in between.
    await stopOf(h, a.dir, 'p1', 'One more thing: the tests pass.');
    const entry = await h.waitFor('the feed entry of the second Stop', async () => (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended'));
    expect(entry.projectId).toBe(a.project.id);
    await pause(300);
    expect(titles(h)).toEqual(['GitManager: report ready']);

    // The next prompt starts a new turn; if that one ends without a report it is announced.
    await promptOf(h, a.dir, 'p2');
    await stopOf(h, a.dir, 'p2', 'A plain answer.');
    await h.waitFor('the "Claude finished" notification', () => finishedBy(h)[0]);
    expect(titles(h)).toEqual(['GitManager: report ready', 'GitManager: Claude finished']);
  }, 60_000);

  it('hooks registered twice (the user\'s settings and Mini-Summa\'s own for the session) deliver every event twice and still notify once per turn', async () => {
    const h = await boot();
    const a = await h.project('GitManager', { conversations: [CONV] });
    // The user installed Mini-Summa's hooks in their Claude settings as well: Claude Code runs both registrations for every event.
    const layout = await h.core.services.environments.layout(HOST_ENV);
    const runtime = layout.runtime ?? { command: process.execPath, runAsNode: false };
    const userSettings = buildSettings({
      env: HOST_ENV, node: runtime.command, capture: layout.captureScriptInEnv, spool: layout.spoolDirInEnv, registry: layout.registryFileInEnv,
      handlers: ['ms-user'], runAsNode: runtime.runAsNode,
    });
    fs.mkdirSync(path.join(h.stateDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, 'config', 'settings.json'), JSON.stringify(userSettings));

    const sa = await h.start(a.project.id);
    await h.type(sa.key, 'a plain question');
    await h.waitFor('the "Claude finished" notification', () => finishedBy(h)[0]);
    await h.type(sa.key, `Done ${directive.report({ task: 'Twice delivered' })}`);
    await h.waitFor('the report notification', () => h.native.notifications.find((n) => n.title === 'GitManager: report ready'));
    await pause(600);

    const stops = readHookRuns(h.stateDir, sa.sessionId).filter((r) => r.event === 'Stop');
    expect(stops.length).toBe(4); // two turns, two registrations each: it really was delivered twice
    expect(titles(h)).toEqual(['GitManager: Claude finished', 'GitManager: report ready']);
    expect((await h.client.call('notifications.list', {}))).toHaveLength(2);
  }, 60_000);

  it('a turn that ends with background work pending is in the feed but not announced; the turn that really ends is', async () => {
    const h = await boot();
    const a = await h.project('GitManager');
    await hookOf(h, OUTSIDE, a.dir, 'SessionStart', { source: 'startup', model: 'fake' });
    await promptOf(h, a.dir, 'p1');
    await stopOf(h, a.dir, 'p1', 'The tests are running in the background.', { background_tasks: [{ id: 'bg_1', type: 'bash' }] });
    const waiting = await h.waitFor('the feed entry', async () => (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended'));
    expect(waiting.description).toMatch(/background work is still pending/);
    await pause(400);
    expect(h.native.notifications).toEqual([]);

    // The tests finished, Claude woke up, did something, and ended its turn with nothing pending.
    await hookOf(h, OUTSIDE, a.dir, 'PostToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'cat results' }, tool_response: {}, tool_use_id: 'tu_1' });
    await stopOf(h, a.dir, 'p1', 'All tests pass.');
    await h.waitFor('the "Claude finished" notification', () => finishedBy(h)[0]);
    await pause(300);
    expect(finishedBy(h)).toHaveLength(1);
  }, 60_000);

  it('a turn that is interrupted (no Stop ever comes) is not announced as finished', async () => {
    const h = await boot();
    const a = await h.project('GitManager');
    await hookOf(h, OUTSIDE, a.dir, 'SessionStart', { source: 'startup', model: 'fake' });
    await promptOf(h, a.dir, 'p1');
    await pause(500);
    expect(h.native.notifications).toEqual([]);
    expect((await h.client.call('activity.list', {})).items.some((e) => e.type === 'turn_ended')).toBe(false);
  }, 60_000);
});

describe('when Mini-Summa is not running', () => {
  it('a turn that ended in the meantime is in the feed at the next start, and is never shown as a toast; the next live one is', async () => {
    const first = await boot();
    const a = await first.project('GitManager');
    const key = `posix|${OUTSIDE}` as SessionKey;
    await first.stop(); // closing the window quits the app: nothing watches the spool any more

    // Claude goes on in its own terminal and finishes a turn while nobody is watching.
    await hookOf(first, OUTSIDE, a.dir, 'SessionStart', { source: 'startup', model: 'fake' });
    await turn(first, OUTSIDE, a.dir, 1);

    const again = await boot({ dataDir: first.dataDir, root: first.root });
    const entries = await again.waitFor('the backlog to be read', async () => (await again.client.call('activity.list', {})).items.filter((e) => e.type === 'turn_ended'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionKey: key, projectId: a.project.id, read: false });
    expect(again.native.notifications).toEqual([]);            // no late toast for something that happened while the app was closed
    expect(await again.client.call('notifications.list', {})).toEqual([]);

    // Now that it runs, the next turn of that same terminal is announced like any other.
    await turn(again, OUTSIDE, a.dir, 2);
    const note = await again.waitFor('the live notification', () => finishedBy(again)[0]);
    expect(note).toMatchObject({ title: 'GitManager: Claude finished', target: { view: 'workspace', projectId: a.project.id, sessionKey: key } });
    expect(again.native.notifications).toHaveLength(1);
  }, 60_000);

  it('does not announce again what it announced before the restart', async () => {
    const first = await boot();
    const a = await first.project('GitManager');
    const sa = await first.start(a.project.id);
    await first.type(sa.key, 'a question');
    await first.waitFor('the notification', () => finishedBy(first)[0]);
    expect(await first.client.call('notifications.list', {})).toHaveLength(1);

    const again = await first.restart(); open.push(again);
    await pause(500);
    expect(again.native.notifications).toEqual([]);
    expect(await again.client.call('notifications.list', {})).toHaveLength(1);       // the record is still there, once
    expect((await again.client.call('activity.list', {})).items.filter((e) => e.type === 'turn_ended')).toHaveLength(1);
  }, 60_000);

  it('a Claude session outside any project folder never notifies, whoever started it', async () => {
    const h = await boot();
    await h.project('GitManager');
    const elsewhere = path.join(h.root, 'not-a-project');
    fs.mkdirSync(elsewhere, { recursive: true });
    await hookOf(h, OUTSIDE, elsewhere, 'SessionStart', { source: 'startup', model: 'fake' });
    await turn(h, OUTSIDE, elsewhere, 1);
    const entry = await h.waitFor('the feed entry', async () => (await h.client.call('activity.list', {})).items.find((e) => e.type === 'turn_ended'));
    expect(entry.projectId).toBeNull();
    await pause(300);
    expect(h.native.notifications).toEqual([]);
  }, 60_000);
});
