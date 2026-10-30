// A21: desktop notifications.
//
// What can be executed here, and what cannot:
//   * REAL, end to end: an event in a real Claude session (a finished task, a permission request) goes through the real hook,
//     ingestion, orchestrator and notification service of the core, which asks the Electron main process to show a native
//     notification and records what became of it (GET /notifications, and the Notifications list in Activity). The main
//     process's own check "can this platform show notifications?" is observed.
//   * SIMULATED platform layer: under Xvfb there is no notification service (Electron's Notification.isSupported() is false
//     here), so the test plays the operating system's part for one test: it makes isSupported() true, answers `show`, and
//     later emits `click` on the notification object. Everything of Mini-Summa's in between is real: the notifier, the bridge,
//     the window router, the preload, the renderer's navigation.
//   * NOT TESTED: that an operating-system toast appears on a screen, and that clicking it works. No notification daemon runs
//     under Xvfb and there is no API to observe a toast.
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { acceptsInput } from '../helpers/core.ts';
import { evidence, notTested } from '../helpers/evidence.ts';
import { directive } from '../helpers/fake-claude.ts';
import { finishTask, sceneWithSession } from '../helpers/flow.ts';
import { clickNotification, hideWindow, notificationSpy, spyOnNotifications, windowInfo } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { observe } from '../helpers/terminal.ts';
import { openActivity, openSettings, reportDetail } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const A = uuidOf('a');
// The real CLI sends its "needs permission" Notification about 6 s after the dialog opens; the fake does too. Shorten it.
const QUICK = { FAKE_CLAUDE_NOTIFY_MS: '300' };

scenario('[A21] A finished task and a permission request become notifications that the main process asks the platform to show', async () => {
  const h = await launchApp({ fakeKnobs: QUICK });
  await spyOnNotifications(h.app, false); // count the main process's attempts; the platform's answers pass through unchanged
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  const tag = scene.session.sessionId.slice(0, 8);
  const records = async () => h.api.call('notifications.list', { query: { limit: 50 } });
  const nativeOutcomes = (platformSupported: boolean): string[] => (platformSupported ? ['sent', 'failed'] : ['unavailable']);

  // A permission request: critical urgency, leads to the session.
  const stream = await observe(h, scene.session.key);
  await stream.type(`run a command ${directive.permission('bash', 'echo from-fake')}`);
  const permission = await until('a notification record for the permission request', async () => (await records()).find((n) => n.title === 'Alpha: needs permission') ?? null, { timeout: 20_000 });
  expect(permission.body).toMatch(new RegExp(`^Needs permission: Alpha / ${tag}`));
  expect(permission.target).toMatchObject({ view: 'workspace', projectId: scene.project.id, sessionKey: scene.session.key });
  await stream.type('\r', { submit: false }); // the person allows it in the terminal
  await until('Claude to finish that turn', async () => acceptsInput(await h.api.call('sessions.get', { params: { key: scene.session.key } })));

  // A finished task: leads to the report and its handoff.
  const report = await finishTask(h, scene, 'Ship the importer');
  const note = await until('a notification record for the report', async () => (await records()).find((n) => n.title === 'Alpha: report ready') ?? null);
  expect(note).toMatchObject({ body: 'Report ready: Ship the importer', projectId: scene.project.id, push: 'not_applicable' });
  expect(note.target).toMatchObject({ view: 'reports', projectId: scene.project.id, reportId: report.id });
  expect(note.target.deliveryId).toBeTruthy();

  // The main process was asked, once per notification, and the platform's honest answer is what the record says.
  const spy = await notificationSpy(h.app);
  expect(spy.supportedChecks).toBeGreaterThanOrEqual(2);
  for (const n of [permission, note]) expect(nativeOutcomes(spy.platformSupported)).toContain(n.native);
  expect(spy.simulated).toBe(false);

  // The same facts are in the window: each notification is listed with what became of it on this PC.
  await openActivity(h.page);
  await h.page.getByRole('tab', { name: 'Notifications' }).click();
  const list = h.page.getByRole('list', { name: /^Notifications, / }).first();
  const reportItem = list.getByRole('button', { name: /Alpha: report ready/ });
  await reportItem.waitFor();
  const label = (await reportItem.getAttribute('aria-label')) ?? '';
  expect(label).toContain('Report ready: Ship the importer');
  expect(label).toContain(spy.platformSupported ? 'Shown on this PC' : 'Could not be shown: this PC cannot show notifications');

  // Quiet mode: nothing is shown, the main process is not even asked, but the entry is in the feed and unread.
  const asked = spy.supportedChecks;
  await h.api.call('settings.update', { body: { notifications: { quiet: { enabled: true, until: null } } } });
  const quiet = await finishTask(h, scene, 'Written in quiet mode');
  const quietNote = await until('a record for the quiet-mode report', async () => (await records()).find((n) => n.body === 'Report ready: Written in quiet mode') ?? null);
  expect(quietNote.native).toBe('suppressed_quiet');
  expect((await notificationSpy(h.app)).supportedChecks).toBe(asked);
  const entry = (await h.api.call('activity.list', { query: { limit: 50 } })).items.find((a) => a.type === 'report_ready' && a.title.includes('Written in quiet mode'));
  expect(entry).toMatchObject({ read: false, requiresAction: true });
  await h.api.call('settings.update', { body: { notifications: { quiet: { enabled: false, until: null } } } });

  // The project's own switch for reports: no notification, and still a feed entry.
  await h.api.call('projects.update', { params: { id: scene.project.id }, body: { notificationPrefs: { report: false } } });
  const muted = await finishTask(h, scene, 'Written while reports are off');
  await until('the feed entry for the muted report', async () => (await h.api.call('activity.list', { query: { limit: 50 } })).items.some((a) => a.title.includes('Written while reports are off')));
  expect((await records()).some((n) => n.body.includes('Written while reports are off'))).toBe(false);
  expect(quiet.id).not.toBe(muted.id);
  evidence('A21', `real chain: a permission request (critical) and a finished task each produced a notification record with the right title ("Alpha: needs permission", "Alpha: report ready"), body and navigation target (workspace/session, reports/report/delivery); the main process asked the platform to show them ${spy.supportedChecks} times and Electron answered isSupported()=${spy.platformSupported}, so the records say native="${note.native}" and the Notifications list in Activity says "${spy.platformSupported ? 'Shown on this PC' : 'Could not be shown: this PC cannot show notifications'}"; quiet mode recorded "suppressed_quiet" without asking the platform, and a project with reports switched off made no notification; the feed kept the entries unread`);
}, { timeout: 150_000 });

scenario('[A21] With a notification service (platform simulated), the notification has the right words and a click opens what it is about', async () => {
  const h = await launchApp({ fakeKnobs: QUICK });
  await spyOnNotifications(h.app, true); // the OS part is played by the test: show() succeeds, click() is emitted by the test
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  const stream = await observe(h, scene.session.key);

  // Permission request first (critical: it stays until seen), then the finished task.
  await stream.type(`run ${directive.permission('bash', 'echo again')}`);
  await until('the permission notification to be shown', async () => (await notificationSpy(h.app)).created.length >= 1, { timeout: 20_000 });
  const shown = (await notificationSpy(h.app)).created;
  expect(shown[0]).toMatchObject({ title: 'Alpha: needs permission', silent: false, urgency: 'critical', timeoutType: 'never' });
  expect(shown[0].body).toMatch(/^Needs permission: Alpha \//);
  await stream.type('\r', { submit: false });
  await until('Claude to finish that turn', async () => acceptsInput(await h.api.call('sessions.get', { params: { key: scene.session.key } })));

  const report = await finishTask(h, scene, 'Ship the importer');
  await until('the report notification to be shown', async () => (await notificationSpy(h.app)).created.length >= 2);
  const second = (await notificationSpy(h.app)).created[1];
  expect(second).toMatchObject({ title: 'Alpha: report ready', body: 'Report ready: Ship the importer', silent: false, urgency: 'normal' });
  const records = await h.api.call('notifications.list', { query: { limit: 10 } });
  expect(records.filter((n) => n.native === 'sent')).toHaveLength(2);

  // The person is elsewhere (Settings) and the window is hidden. Clicking the report notification brings it back to that report.
  await openSettings(h.page);
  await hideWindow(h.app);
  expect((await windowInfo(h.app)).visible).toBe(false);
  expect(await clickNotification(h.app, 1)).toBe(true);
  await until('the window to be shown again', async () => (await windowInfo(h.app)).visible);
  await reportDetail(h.page).getByRole('heading', { level: 1, name: 'Ship the importer' }).waitFor();
  expect(report.taskTitle).toBe('Ship the importer');

  // Clicking the permission notification goes to the session that asked.
  await openSettings(h.page);
  expect(await clickNotification(h.app, 0)).toBe(true);
  await h.page.getByRole('heading', { level: 1, name: 'Alpha' }).waitFor();
  await h.page.getByRole('tab', { name: new RegExp(`^Session ${scene.session.sessionId.slice(0, 8)},`) }).waitFor();
  evidence('A21', `with the platform layer simulated (show answered by the test): the permission notification carried title "Alpha: needs permission", critical urgency and "never" timeout, the report notification "Alpha: report ready" / "Report ready: Ship the importer" with normal urgency; both records say native="sent"; with the window hidden, a click on the report notification showed the window and opened that report's page, and a click on the permission notification opened Alpha's workspace on the asking session`);
}, { timeout: 150_000 });

scenario('[A21] An operating-system toast appears on screen and clicking it works', async (ctx) => {
  const h = await launchApp();
  const spy = await (async () => { await spyOnNotifications(h.app, false); return h.app.evaluate(({ Notification }) => Notification.isSupported()); })();
  evidence('A21', `Notification.isSupported() as answered by Electron ${h.electronVersion} on this machine (Linux under Xvfb, no notification daemon): ${spy}`);
  notTested(ctx, 'A21', `Not executed: this machine has no notification service (Electron answers Notification.isSupported() = ${spy} under Xvfb) and no API observes an operating-system toast, so whether a toast appears on screen, how it looks, and whether clicking a REAL toast brings the app forward was not observed. Verified instead: the core's records and the main process's attempts (real), and the click-to-navigation path with the platform layer simulated. Windows toasts (AppUserModelID com.minisumma.app) were not exercised.`);
});

