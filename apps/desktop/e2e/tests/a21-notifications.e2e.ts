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
//   * SIMULATED presence (only the scenario that needs it): under Xvfb there is no person. Electron happens to answer
//     isFocused() = true and a small idle time (the X server has seen no input since it started, which grows while a test runs),
//     but a test must not lean on that, and some steps need the opposite. `pretendPresence` says what a person at the PC would
//     make true (window in front, keyboard used seconds ago) or not (another program in front, ten minutes away). What the window
//     SHOWS (project, session tab) is real: the renderer wrote it into the core, and the main process reads it back from there.
import type { ElectronApplication } from 'playwright';
import { expect } from 'vitest';
import type { SessionView } from '@minisumma/shared';
import type { AppHandle } from '../helpers/app.ts';
import { launchApp } from '../helpers/app.ts';
import { acceptsInput, startSession } from '../helpers/core.ts';
import { evidence, notTested } from '../helpers/evidence.ts';
import { directive } from '../helpers/fake-claude.ts';
import { finishTask, sceneWithSession } from '../helpers/flow.ts';
import { clickNotification, hideWindow, notificationSpy, spyOnNotifications, windowInfo } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { observe } from '../helpers/terminal.ts';
import { openActivity, openSettings, reportDetail, selectProject } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const A = uuidOf('a');
const B = uuidOf('b');

/** The tab of a session in the Claude pane. Its name starts with "Session " and the first eight characters of the id. */
const tabOf = (h: AppHandle, session: Pick<SessionView, 'sessionId'>) => h.page.getByRole('tab', { name: new RegExp(`^Session ${session.sessionId.slice(0, 8)},`) });

/** Says what a person at the PC would make true: the window has the focus, and the keyboard or mouse was used `idleSeconds` ago. */
const pretendPresence = (app: ElectronApplication, state: { focused: boolean; idleSeconds: number }): Promise<void> => app.evaluate(({ BrowserWindow, powerMonitor }, s) => {
  const win = BrowserWindow.getAllWindows()[0] as unknown as { isFocused: () => boolean };
  win.isFocused = () => s.focused;
  (powerMonitor as unknown as { getSystemIdleTime: () => number }).getSystemIdleTime = () => s.idleSeconds;
}, state);

/** The titles of the notifications the main process was asked to show, in order (simulated platform). */
const shownTitles = async (h: AppHandle): Promise<string[]> => (await notificationSpy(h.app)).created.map((c) => c.title);
const lastShown = async (h: AppHandle, title: string): Promise<number> => (await shownTitles(h)).lastIndexOf(title);
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

  // Permission request first (critical: it stays until seen).
  await stream.type(`run ${directive.permission('bash', 'echo again')}`);
  await until('the permission notification to be shown', async () => (await notificationSpy(h.app)).created.length >= 1, { timeout: 20_000 });
  const shown = (await notificationSpy(h.app)).created;
  expect(shown[0]).toMatchObject({ title: 'Alpha: needs permission', silent: false, urgency: 'critical', timeoutType: 'never' });
  expect(shown[0].body).toMatch(/^Needs permission: Alpha \//);
  await stream.type('\r', { submit: false });
  await until('Claude to finish that turn', async () => acceptsInput(await h.api.call('sessions.get', { params: { key: scene.session.key } })));

  // That turn ended without a report: Claude finished, and says so, once. Normal urgency: it goes away by itself.
  await until('the "Claude finished" notification to be shown', async () => (await shownTitles(h)).includes('Alpha: Claude finished'));
  const finished = (await notificationSpy(h.app)).created.find((c) => c.title === 'Alpha: Claude finished')!;
  expect(finished).toMatchObject({ body: expect.stringMatching(/^Turn ended: Alpha \//), silent: false, urgency: 'normal', timeoutType: 'default' });

  // Then the finished task. Its turn ends WITH a report, which is announced as the report only: no second "finished" for it.
  const report = await finishTask(h, scene, 'Ship the importer');
  await until('the report notification to be shown', async () => (await shownTitles(h)).includes('Alpha: report ready'));
  const second = (await notificationSpy(h.app)).created.find((c) => c.title === 'Alpha: report ready')!;
  expect(second).toMatchObject({ title: 'Alpha: report ready', body: 'Report ready: Ship the importer', silent: false, urgency: 'normal' });
  await new Promise((resolve) => setTimeout(resolve, 1500)); // longer than two polls of the spool: a second notification would have arrived
  expect(await shownTitles(h)).toEqual(['Alpha: needs permission', 'Alpha: Claude finished', 'Alpha: report ready']);
  const records = await h.api.call('notifications.list', { query: { limit: 10 } });
  expect(records.filter((n) => n.native === 'sent')).toHaveLength(3);

  // The person is elsewhere (Settings) and the window is hidden. Clicking the report notification brings it back to that report.
  await openSettings(h.page);
  await hideWindow(h.app);
  expect((await windowInfo(h.app)).visible).toBe(false);
  expect(await clickNotification(h.app, await lastShown(h, 'Alpha: report ready'))).toBe(true);
  await until('the window to be shown again', async () => (await windowInfo(h.app)).visible);
  await reportDetail(h.page).getByRole('heading', { level: 1, name: 'Ship the importer' }).waitFor();
  expect(report.taskTitle).toBe('Ship the importer');

  // Clicking the permission notification goes to the session that asked.
  await openSettings(h.page);
  expect(await clickNotification(h.app, 0)).toBe(true);
  await h.page.getByRole('heading', { level: 1, name: 'Alpha' }).waitFor();
  await h.page.getByRole('tab', { name: new RegExp(`^Session ${scene.session.sessionId.slice(0, 8)},`) }).waitFor();
  evidence('A21', `with the platform layer simulated (show answered by the test): the permission notification carried title "Alpha: needs permission", critical urgency and "never" timeout; the turn that followed ended without a report and produced exactly one "Alpha: Claude finished" (normal urgency, body "Turn ended: Alpha / <session>"); the report notification "Alpha: report ready" / "Report ready: Ship the importer" (normal urgency) was the only one for the turn that ended with a report, and nothing more arrived in the next 1.5 s (two polls of the spool); all three records say native="sent"; with the window hidden, a click on the report notification showed the window and opened that report's page, and a click on the permission notification opened Alpha's workspace on the asking session`);
}, { timeout: 150_000 });

scenario('[A21] A click on a notification of any kind opens its own project and session, and a project that is not selected still produces them', async () => {
  const h = await launchApp({ fakeKnobs: QUICK });
  await spyOnNotifications(h.app, true);
  const alpha = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  const beta = await sceneWithSession(h, 'Beta', { conversations: [conversationUrl(B)] });
  // Alpha has two sessions. The one that speaks is the second, so the click has to choose the tab, not just the project.
  const quiet = alpha.session;
  const speaking = await startSession(h, alpha.project.id, { name: 'second' });
  expect(speaking.key).not.toBe(quiet.key);
  const stream = await observe(h, speaking.key);
  const ready = () => until('the speaking session to be ready for the next prompt', async () => {
    const s = await h.api.call('sessions.get', { params: { key: speaking.key } });
    return acceptsInput(s) || s.state === 'error';
  }, { timeout: 30_000 });

  const kinds: { title: string; say: () => Promise<void>; answer?: () => Promise<void> }[] = [
    { title: 'Alpha: needs permission', say: () => stream.type(`run ${directive.permission('bash', 'echo kinds')}`), answer: () => stream.type('\r', { submit: false }) },
    { title: 'Alpha: needs your input', say: () => stream.type(`ask ${directive.input('Which branch should I use?')}`), answer: () => stream.type('\r', { submit: false }) },
    { title: 'Alpha: error', say: () => stream.type(`fail ${directive.error('api_error')}`) },
    { title: 'Alpha: Claude finished', say: () => stream.type('just answer a question') },
  ];
  const clicked: string[] = [];
  for (const kind of kinds) {
    // Alpha's window is left on the OTHER session (the quiet one) and then the window moves to Beta, so that only the notification
    // can bring the speaking session's tab forward.
    await selectProject(h.page, 'Alpha');
    await tabOf(h, quiet).click();
    await until('the quiet session to be the selected tab of Alpha', async () => (await tabOf(h, quiet).getAttribute('aria-selected')) === 'true');
    await selectProject(h.page, 'Beta'); // the window is on another project from here on
    const seen = (await shownTitles(h)).filter((t) => t === kind.title).length;
    await kind.say();
    await until(`the notification "${kind.title}" to be shown for a project that is not selected`, async () => (await shownTitles(h)).filter((t) => t === kind.title).length > seen, { timeout: 20_000 });
    if (kind.answer) await kind.answer();
    await ready();
    await openSettings(h.page); // and the window shows something else than the workspace
    expect(await clickNotification(h.app, await lastShown(h, kind.title))).toBe(true);
    await h.page.getByRole('heading', { level: 1, name: 'Alpha' }).waitFor();
    await until(`the session tab of "${kind.title}" to be the selected one`, async () => (await tabOf(h, speaking).getAttribute('aria-selected')) === 'true');
    expect(await tabOf(h, quiet).getAttribute('aria-selected')).toBe('false');
    clicked.push(kind.title);
  }

  // The same for a report, which opens the report instead.
  await selectProject(h.page, 'Beta');
  const report = await finishTask(h, { project: alpha.project, session: speaking }, 'Open me from the toast');
  await until('the report notification', async () => (await shownTitles(h)).includes('Alpha: report ready'));
  await openSettings(h.page);
  expect(await clickNotification(h.app, await lastShown(h, 'Alpha: report ready'))).toBe(true);
  await reportDetail(h.page).getByRole('heading', { level: 1, name: report.taskTitle }).waitFor();
  clicked.push('Alpha: report ready');

  // Every record belongs to the project that owns the session, not to the one that was selected.
  const records = await h.api.call('notifications.list', { query: { limit: 50 } });
  expect(records.length).toBeGreaterThanOrEqual(clicked.length);
  expect(records.every((n) => n.projectId === alpha.project.id)).toBe(true);
  expect(records.some((n) => n.projectId === beta.project.id)).toBe(false);
  for (const n of records.filter((r) => r.title !== 'Alpha: report ready')) expect(n.target).toEqual({ view: 'workspace', projectId: alpha.project.id, sessionKey: speaking.key });
  evidence('A21', `with Beta selected (and then Settings open), events in the second session of Alpha produced the notifications ${clicked.map((c) => `"${c}"`).join(', ')}; clicking each one showed Alpha's workspace with the second session's tab selected (the first stayed unselected), or, for the report, that report; every record belongs to Alpha and none to Beta`);
}, { timeout: 240_000 });

scenario('[A21] "Claude finished" is not shown for the session the person is looking at, is recorded as such, and is shown as soon as they look elsewhere', async () => {
  const h = await launchApp({ fakeKnobs: QUICK });
  await spyOnNotifications(h.app, true);
  const alpha = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  const beta = await sceneWithSession(h, 'Beta', { conversations: [conversationUrl(B)] });
  const natural = await h.app.evaluate(({ BrowserWindow, powerMonitor }) => {
    let idle: number | string;
    try { idle = powerMonitor.getSystemIdleTime(); } catch (error) { idle = `error: ${String(error)}`; }
    return { focused: BrowserWindow.getAllWindows()[0].isFocused(), idle };
  });
  await pretendPresence(h.app, { focused: true, idleSeconds: 3 });
  const stream = await observe(h, alpha.session.key);
  const records = async () => h.api.call('notifications.list', { query: { limit: 50 } });
  const windowShows = async () => (await h.api.call('settings.get')).ui;
  const ready = () => until('Claude to be ready again', async () => acceptsInput(await h.api.call('sessions.get', { params: { key: alpha.session.key } })), { timeout: 30_000 });
  /** Types a prompt that ends without a report and returns the notification record that turn made. */
  const turn = async (text: string, what: string) => {
    const known = new Set((await records()).map((n) => n.id));
    await stream.type(text);
    return until(what, async () => (await records()).find((n) => !known.has(n.id) && n.title === 'Alpha: Claude finished') ?? null, { timeout: 20_000 });
  };

  // 1. The window is in front, shows Alpha's workspace, and Alpha's session is the tab on screen: nothing to show.
  await selectProject(h.page, 'Alpha');
  await tabOf(h, alpha.session).waitFor();
  await until('the core to know that the window shows Alpha and its session', async () => {
    const ui = await windowShows();
    return ui?.route?.projectId === alpha.project.id && ui.route.view === 'workspace' && ui.perProject?.[alpha.project.id]?.sessionKey === alpha.session.key;
  }, { timeout: 10_000 });
  const watched = await turn('a question I am watching', 'a record for the turn that was watched');
  expect(watched).toMatchObject({ native: 'suppressed_viewing', push: 'not_applicable', projectId: alpha.project.id, target: { view: 'workspace', projectId: alpha.project.id, sessionKey: alpha.session.key } });
  await ready();
  expect(await shownTitles(h)).toEqual([]);                     // the platform was never asked to show anything
  const entry = (await h.api.call('activity.list', { query: { limit: 20 } })).items.find((a) => a.type === 'turn_ended');
  expect(entry).toMatchObject({ read: false });                  // the feed still has the moment

  // 2. A permission request is worth interrupting for, even for the session on screen.
  await stream.type(`run ${directive.permission('bash', 'echo watched')}`);
  await until('the permission notification to be shown while looking at the session', async () => (await shownTitles(h)).includes('Alpha: needs permission'), { timeout: 20_000 });
  await stream.type('\r', { submit: false });
  await ready();
  expect(await shownTitles(h)).toEqual(['Alpha: needs permission']); // and the "finished" of that turn was held back like the first

  // 3. The person looks at another project: the same event is shown.
  await selectProject(h.page, 'Beta');
  await until('the core to know that the window shows Beta', async () => (await windowShows())?.route?.projectId === beta.project.id, { timeout: 10_000 });
  const elsewhere = await turn('a question while I look at Beta', 'a record for the turn seen from Beta');
  expect(elsewhere.native).toBe('sent');
  await ready();
  expect(await shownTitles(h)).toEqual(['Alpha: needs permission', 'Alpha: Claude finished']);

  // 4. Back on Alpha, but the window is not the one in front (another program has it): shown.
  await selectProject(h.page, 'Alpha');
  await until('the core to know that the window shows Alpha again', async () => (await windowShows())?.route?.projectId === alpha.project.id, { timeout: 10_000 });
  await pretendPresence(h.app, { focused: false, idleSeconds: 3 });
  expect((await turn('a question while another program is in front', 'a record for the turn with the window behind')).native).toBe('sent');
  await ready();
  expect((await shownTitles(h)).filter((t) => t === 'Alpha: Claude finished')).toHaveLength(2);

  // 5. In front again, but nobody has touched the computer for ten minutes: shown, because the person is probably not there.
  await pretendPresence(h.app, { focused: true, idleSeconds: 600 });
  expect((await turn('a question while I am away', 'a record for the turn while away')).native).toBe('sent');
  await ready();
  expect((await shownTitles(h)).filter((t) => t === 'Alpha: Claude finished')).toHaveLength(3);

  const all = await records();
  evidence('A21', `Xvfb answered isFocused()=${natural.focused} and system idle time ${String(natural.idle)} on its own, so the test said what a person at the PC would make true (window in front, keyboard used 3 s ago); with the window on Alpha's workspace and Alpha's session tab selected (written by the renderer into the core, read back by the main process), "Claude finished" produced a record native="suppressed_viewing" and no call to the platform, the feed kept the entry unread, and a permission request for the same session was still shown; with Beta selected, with the window not in front, and with ten minutes without input, the same event was shown (${all.filter((n) => n.native === 'sent').length} "sent", ${all.filter((n) => n.native === 'suppressed_viewing').length} "suppressed_viewing" records in all)`);
}, { timeout: 240_000 });

scenario('[A21] An operating-system toast appears on screen and clicking it works', async (ctx) => {
  const h = await launchApp();
  const spy = await (async () => { await spyOnNotifications(h.app, false); return h.app.evaluate(({ Notification }) => Notification.isSupported()); })();
  evidence('A21', `Notification.isSupported() as answered by Electron ${h.electronVersion} on this machine (Linux under Xvfb, no notification daemon): ${spy}`);
  notTested(ctx, 'A21', `Not executed: this machine has no notification service (Electron answers Notification.isSupported() = ${spy} under Xvfb) and no API observes an operating-system toast, so whether a toast appears on screen, how it looks, and whether clicking a REAL toast brings the app forward was not observed. Verified instead: the core's records and the main process's attempts (real), and the click-to-navigation path with the platform layer simulated. Windows toasts (AppUserModelID com.minisumma.app) were not exercised.`);
});

