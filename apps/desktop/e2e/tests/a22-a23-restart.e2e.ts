// A22-A23: quit the app (the real quit flow, answering its question) and start it again on the same data directory.
// Projects, conversations, sessions and reports are still there; the sessions are resumable and NOT live; and the restart
// itself notifies nothing, copies nothing, opens nothing and types nothing.
import crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Delivery, SessionView } from '@minisumma/shared';
import { launchApp, occupyPreferredPort, PREFERRED_CORE_PORT } from '../helpers/app.ts';
import type { AppHandle } from '../helpers/app.ts';
import { createProject, fullReport, latestDelivery, reportsOf, startSession, waitForSession } from '../helpers/core.ts';
import { evidence, notTested } from '../helpers/evidence.ts';
import { isRunning, liveSessionsOf, readReceived } from '../helpers/fake-claude.ts';
import { finishTask } from '../helpers/flow.ts';
import { chatgptView, notificationSpy, readClipboard, spyOnNotifications } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { waitForScreen } from '../helpers/terminal.ts';
import { handoffCard, openReport, openReports, projectRow, reportRow, selectProject } from '../helpers/ui.ts';
import { sleep, until } from '../helpers/wait.ts';

const A1 = uuidOf('a1');
const A2 = uuidOf('a2');
const B = uuidOf('b');
const sha256 = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Two projects with conversations (Alpha prefers its second), three sessions (two of them used, one never prompted). */
async function populate(h: AppHandle) {
  const alpha = await createProject(h, 'Alpha', { conversations: [conversationUrl(A1), conversationUrl(A2)], preferred: 1 });
  const beta = await createProject(h, 'Beta', { conversations: [conversationUrl(B)] });
  const build = await startSession(h, alpha.project.id, { name: 'build' });
  const idle = await startSession(h, alpha.project.id);
  const betaSession = await startSession(h, beta.project.id);
  return { alpha, beta, build, idle, betaSession };
}

const stable = (d: Delivery): Delivery => JSON.parse(JSON.stringify(d)) as Delivery;

scenario('[A22] Project and session records persist after restart', async () => {
  const h = await launchApp();
  const { alpha, beta, build, idle, betaSession } = await populate(h);
  await h.api.call('settings.update', { body: { layout: { landscapeRatio: 0.62, portraitRatio: 0.41 } } });
  await finishTask(h, { project: alpha.project, session: build }, 'Alpha one');
  await finishTask(h, { project: beta.project, session: betaSession }, 'Beta one');
  // One feed entry read, the rest unread: that distinction is kept too.
  const feedBefore = (await h.api.call('activity.list', { query: { limit: 100 } })).items;
  const readId = feedBefore.find((a) => a.type === 'session_started')!.id;
  await h.api.call('activity.markRead', { body: { ids: [readId] } });

  const projectsBefore = await h.api.call('projects.list');
  const conversationsBefore = (await Promise.all(projectsBefore.map((p) => h.api.call('conversations.list', { params: { id: p.id } })))).flat();
  const sessionsBefore = (await h.api.call('sessions.list')).filter((s) => s.key !== idle.key);
  const receivedBefore = Object.fromEntries([build, betaSession].map((s) => [s.key, readReceived(h.sandbox.fakeState, s.sessionId).map((r) => r.text)]));
  const notificationsBefore = await h.api.call('notifications.list', { query: { limit: 50 } });
  const reportsBefore = await reportsOf(h);
  expect(sessionsBefore.every((s) => s.availability === 'live')).toBe(true);

  // Quitting asks first, because three terminals end with the app.
  const quit = await h.quit();
  expect(quit.code).toBe(0);
  expect(quit.asked).toHaveLength(1);
  expect(quit.asked[0]).toMatchObject({ message: 'Quit Mini-Summa?', detail: 'Closing Mini-Summa ends 3 running Claude terminals. They can be resumed later.' });
  for (const s of [build, idle, betaSession]) expect(isRunning(s.pid!), `the terminal of ${s.key} ended with the app`).toBe(false);
  expect(liveSessionsOf(h.sandbox.fakeState)).toEqual([]);

  // Start again on the same data directory.
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await spyOnNotifications(h2.app, false);

  // Projects, roots, conversations and the preference: exactly as they were.
  const projectsAfter = await h2.api.call('projects.list');
  expect(projectsAfter.map((p) => ({ id: p.id, name: p.name, roots: p.roots, preferred: p.preferredConversationId, sortOrder: p.sortOrder, archivedAt: p.archivedAt })))
    .toEqual(projectsBefore.map((p) => ({ id: p.id, name: p.name, roots: p.roots, preferred: p.preferredConversationId, sortOrder: p.sortOrder, archivedAt: p.archivedAt })));
  const conversationsAfter = (await Promise.all(projectsAfter.map((p) => h2.api.call('conversations.list', { params: { id: p.id } })))).flat();
  expect(conversationsAfter.map((c) => ({ id: c.id, projectId: c.projectId, url: c.url, title: c.title, position: c.position, verification: c.verification })))
    .toEqual(conversationsBefore.map((c) => ({ id: c.id, projectId: c.projectId, url: c.url, title: c.title, position: c.position, verification: c.verification })));
  expect(projectsAfter.find((p) => p.name === 'Alpha')!.preferredConversationId).toBe(alpha.conversations[1].id);
  expect((await h2.api.call('settings.get')).layout).toMatchObject({ landscapeRatio: 0.62, portraitRatio: 0.41 });

  // Sessions: the records are there, resumable, ended by the app, NOT live; the one never prompted cannot be resumed and is not offered.
  const sessionsAfter = await h2.api.call('sessions.list');
  expect(sessionsAfter.map((s) => s.key).sort()).toEqual(sessionsBefore.map((s) => s.key).sort());
  for (const before of sessionsBefore) {
    const after = sessionsAfter.find((s) => s.key === before.key) as SessionView;
    expect(after, `session ${before.key} is still known`).toBeTruthy();
    expect(after).toMatchObject({ origin: 'managed', availability: 'resumable', resumable: true, state: 'ended', projectId: before.projectId, cwd: before.cwd, name: before.name, generation: before.generation, pid: null });
    expect(after.termination).toMatchObject({ kind: 'observed' });
    expect(after.terminal?.exited).toBe(true);
  }
  const unlisted = await h2.api.call('sessions.list', { query: { includeEnded: true } });
  expect(unlisted.find((s) => s.key === idle.key)?.resumable ?? false).toBe(false);
  expect((await h2.api.call('system.counts')).liveSessions).toBe(0);

  // Reports and the feed: the same reports; the feed entries and their read state; the same two notifications, no new ones.
  expect((await reportsOf(h2)).map((r) => r.id).sort()).toEqual(reportsBefore.map((r) => r.id).sort());
  const feedAfter = (await h2.api.call('activity.list', { query: { limit: 100 } })).items;
  const stripEnded = (list: typeof feedAfter) => list.filter((a) => a.type !== 'session_ended').map((a) => ({ id: a.id, read: a.read, title: a.title }));
  expect(stripEnded(feedAfter).sort((x, y) => x.id.localeCompare(y.id))).toEqual(stripEnded(feedBefore.map((a) => (a.id === readId ? { ...a, read: true } : a))).sort((x, y) => x.id.localeCompare(y.id)));
  expect(feedAfter.find((a) => a.id === readId)?.read).toBe(true);
  expect(feedAfter.filter((a) => a.type === 'session_ended')).toHaveLength(sessionsBefore.length + 1); // the app's own ending of its three terminals
  expect((await h2.api.call('notifications.list', { query: { limit: 50 } })).map((n) => n.id)).toEqual(notificationsBefore.map((n) => n.id));

  // The restart itself did nothing: no notification attempt, nothing typed to Claude, no session started, nothing sent to ChatGPT.
  await sleep(2500);
  expect((await notificationSpy(h2.app)).supportedChecks).toBe(0);
  expect(liveSessionsOf(h2.sandbox.fakeState)).toEqual([]);
  for (const s of [build, betaSession]) expect(readReceived(h2.sandbox.fakeState, s.sessionId).map((r) => r.text)).toEqual(receivedBefore[s.key]);
  expect(h2.standIn.submissions()).toEqual([]);

  // In the window: the project list is back, and Alpha shows the session that was open when the app closed, as ended, with an
  // offer to resume it. (Which project and tab the window reopens on is the window's own memory; X02 covers it.)
  await projectRow(h2.page, 'Alpha').waitFor();
  await projectRow(h2.page, 'Beta').waitFor();
  await selectProject(h2.page, 'Alpha');
  const claude = h2.page.getByRole('region', { name: 'Claude', exact: true });
  const tab = claude.getByRole('tab', { name: new RegExp(`^Session ${build.sessionId.slice(0, 8)}, managed, Linux\\. Session ended`) });
  await tab.waitFor();
  expect(await tab.getAttribute('aria-selected')).toBe('true');
  expect(await claude.getByRole('tab').count(), 'only the session that was open has a tab: the never-prompted one is not offered').toBe(1);
  const notice = claude.getByRole('status').filter({ hasText: 'This session ended' });
  await notice.waitFor();
  const resumeButton = notice.getByRole('button', { name: 'Resume session' });
  await resumeButton.waitFor();
  // The "+" menu lists what can be resumed: the prompted session, not the one that never got a prompt.
  await claude.getByRole('button', { name: 'New or resumed session' }).click();
  await h2.page.getByRole('menuitem', { name: new RegExp(`^${build.sessionId.slice(0, 8)}, Linux`) }).waitFor();
  expect(await h2.page.getByRole('menuitem', { name: new RegExp(`^${idle.sessionId.slice(0, 8)}`) }).count()).toBe(0);
  await h2.page.keyboard.press('Escape');
  await h2.page.getByRole('menu').waitFor({ state: 'hidden' });
  expect(liveSessionsOf(h2.sandbox.fakeState), 'looking at the offer starts nothing').toEqual([]);

  // Resuming is the person's act: only now does a process start, with the same session identity, a new generation, and Claude's own "(resumed)".
  await resumeButton.click();
  const resumed = await waitForSession(h2, build.key, (s) => s.availability === 'live' && s.state !== 'unknown', 'the resumed session to be live');
  expect(resumed).toMatchObject({ key: build.key, origin: 'managed', projectId: alpha.project.id, name: 'build' });
  expect(resumed.generation).toBeGreaterThan(build.generation);
  await waitForScreen(h2.page, '(resumed)');
  expect(readReceived(h2.sandbox.fakeState, build.sessionId).map((r) => r.text)).toEqual(receivedBefore[build.key]); // resuming typed nothing
  evidence('A22', `quit asked "Quit Mini-Summa?" (3 running terminals) and exited 0, all terminal processes gone; on relaunch the same projects, roots, conversations, preferred conversation, layout (0.62/0.41), feed read state and notifications (${notificationsBefore.length}) were there; the 2 prompted sessions came back resumable/ended by "app_exit" (not live, no process), the never-prompted one was not offered; the restart attempted no notification, started no session, typed nothing, sent nothing; Alpha's pane reopened on the "build" tab as "Session ended" with a "Resume session" button (and the + menu listed only that session); pressing it started the same session key as generation ${resumed.generation} showing "(resumed)"`);
}, { timeout: 150_000 });

scenario('[A23] Pending reports persist after restart', async () => {
  const h = await launchApp();
  const { alpha, beta, build, betaSession } = await populate(h);
  const r1 = await finishTask(h, { project: alpha.project, session: build }, 'Alpha pending');
  const r2 = await finishTask(h, { project: alpha.project, session: build }, 'Alpha handed off');
  const r3 = await finishTask(h, { project: beta.project, session: betaSession }, 'Beta pending');

  // R2 is taken one step: "Copy and open" in the window. It now waits for the person to paste and send.
  await openReport(h.page, 'Alpha handed off');
  await handoffCard(h.page).getByRole('button', { name: 'Copy and open' }).click();
  await until('R2 to wait for the person', async () => (await latestDelivery(h, r2.id)).state === 'awaiting_user_send');
  const messageR2 = await readClipboard(h.app);
  expect(messageR2).toContain('Task: Alpha handed off');
  // Beta first in the list: a window that opens on the first project must not be what opens one of Alpha's conversations.
  await h.api.call('projects.reorder', { body: { ids: [beta.project.id, alpha.project.id] } });

  const deliveries = Object.fromEntries(await Promise.all([r1, r2, r3].map(async (r) => [r.id, stable(await latestDelivery(h, r.id))] as const)));
  const bodies = Object.fromEntries(await Promise.all([r1, r2, r3].map(async (r) => [r.id, sha256((await fullReport(h, r.id)).body)] as const)));
  expect(deliveries[r1.id]).toMatchObject({ state: 'destination_unverified' });
  expect(deliveries[r1.id].destination).toMatchObject({ url: conversationUrl(A2), resolvedFrom: 'project_preferred' });
  expect(deliveries[r2.id]).toMatchObject({ state: 'awaiting_user_send' });
  expect(deliveries[r2.id].parts.every((p) => p.copiedAt !== null)).toBe(true);
  const countsBefore = await h.api.call('system.counts');
  const notificationsBefore = await h.api.call('notifications.list', { query: { limit: 50 } });
  expect(countsBefore.reportsAwaitingHandoff).toBe(3);

  const quit = await h.quit();
  expect(quit.code).toBe(0);
  const mark = h.standIn.mark();
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await spyOnNotifications(h2.app, false);

  // Nothing advanced, repeated or re-sent: every delivery is exactly as it was, down to its timestamps; the texts are identical.
  for (const r of [r1, r2, r3]) {
    expect(stable(await latestDelivery(h2, r.id)), `delivery of "${r.taskTitle}" must be untouched by the restart`).toEqual(deliveries[r.id]);
    expect(sha256((await fullReport(h2, r.id)).body)).toBe(bodies[r.id]);
  }
  expect((await h2.api.call('system.counts')).reportsAwaitingHandoff).toBe(3);
  expect((await h2.api.call('notifications.list', { query: { limit: 50 } })).map((n) => n.id)).toEqual(notificationsBefore.map((n) => n.id));

  // The window shows them: the queue, with the state of each, and the destination of the pending one as it was frozen.
  await openReports(h2.page);
  for (const [r, state] of [[r1, 'Ready, conversation not verified'], [r2, 'Awaiting your send'], [r3, 'Ready, conversation not verified']] as const) {
    await until(`the queue row of "${r.taskTitle}" to show "${state}"`, async () => ((await reportRow(h2.page, r.taskTitle).getAttribute('aria-label')) ?? '').includes(state));
  }
  await reportRow(h2.page, 'Alpha pending').click();
  const card = handoffCard(h2.page);
  await card.getByLabel('Destination').getByText(conversationUrl(A2), { exact: true }).waitFor();
  await card.getByText("Chosen because it is the project's preferred conversation.").waitFor();
  await reportRow(h2.page, 'Alpha handed off').click();
  await card.getByRole('button', { name: 'I sent it', exact: true }).waitFor();
  await card.getByText('Awaiting your send', { exact: true }).waitFor();

  // The restart itself did nothing visible to ChatGPT or the clipboard: nothing copied, no notification attempt, no conversation of
  // Alpha opened (Beta was the selected project), nothing submitted.
  expect(await readClipboard(h2.app)).toBe('');
  await sleep(2000);
  expect((await notificationSpy(h2.app)).supportedChecks).toBe(0);
  const sinceRestart = h.standIn.since(mark).map((r) => r.path);
  expect(sinceRestart).not.toContain(`/c/${A1}`);
  expect(sinceRestart).not.toContain(`/c/${A2}`);
  expect(h.standIn.submissions()).toEqual([]);
  expect(liveSessionsOf(h2.sandbox.fakeState)).toEqual([]);

  // And the pending report is still actionable: the handoff works after the restart, to the destination frozen before it.
  await reportRow(h2.page, 'Alpha pending').click();
  await card.getByRole('button', { name: 'Copy and open' }).click();
  await until('the embedded view to show the frozen destination', async () => (await chatgptView(h2.app))?.url === conversationUrl(A2));
  await until('the clipboard to hold the report message', async () => (await readClipboard(h2.app)).includes('Task: Alpha pending'));
  const prepared = await h2.api.call('deliveries.prepare', { params: { id: deliveries[r1.id].id } });
  expect(await readClipboard(h2.app)).toBe(prepared.message);
  evidence('A23', `three pending reports (one pending in Alpha, one already copied and opened, one in Beta) survived quitting and starting again: their deliveries are identical down to timestamps and frozen destinations (${conversationUrl(A2)}), report texts have identical hashes, the queue shows each state, the awaiting-send one still offers "I sent it"; the restart notified nothing, copied nothing (clipboard empty), opened none of Alpha's conversations, sent nothing; after it, "Copy and open" on the pending report put its message on the clipboard and opened the frozen destination`);
}, { timeout: 150_000 });

// Not one of the 25 behaviours: the window's own memory. The route store keeps the selected project in the page's localStorage so
// that "the app reopens where it was left" (see app/route.ts).
scenario('[X02] The window reopens on the project that was selected when it was closed', async (ctx) => {
  const h = await launchApp();
  await createProject(h, 'Alpha');
  await createProject(h, 'Beta');
  await selectProject(h.page, 'Beta');
  const originBefore = new URL(h.page.url()).origin;
  if (h.port !== PREFERRED_CORE_PORT) {
    notTested(ctx, 'X02', `The core could not take its preferred port ${PREFERRED_CORE_PORT} (it listened on ${h.port}: something else on this machine holds it), so the window's origin cannot be expected to stay the same across a restart.`);
  }
  expect((await h.quit()).code).toBe(0);
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  const originAfter = new URL(h2.page.url()).origin;
  expect(originAfter, 'the window must keep the same origin across a restart, because localStorage belongs to the origin').toBe(originBefore);
  const heading = await h2.page.getByRole('heading', { level: 1 }).first().innerText();
  expect(heading, `reopened on "${heading}" instead of the project that was selected ("Beta"); origin ${originBefore} -> ${originAfter}`).toBe('Beta');
  evidence('X02', `the window reopened on Beta, as it was left, on the same origin (${originAfter})`);
});

// The same memory when the window's ORIGIN changes. The core prefers port 47811 and takes a free port when something else holds it
// (another program, or a second Windows user's Mini-Summa), and localStorage belongs to the page origin: the window used to lose
// everything it kept there although projects, sessions and reports were fine. The core keeps it now (Settings.ui). Here the second
// launch is made to find the port busy, so that the origin really is different, and the window must still reopen where it was left.
scenario('[X02] The window reopens where it was left when the origin changed (the core had to take another port)', async () => {
  const h = await launchApp();
  h.standIn.name(A1, 'Stand-in: Alpha first');
  h.standIn.name(A2, 'Stand-in: Alpha second');
  const alpha = await createProject(h, 'Alpha', { conversations: [conversationUrl(A1), conversationUrl(A2)] });
  const beta = await createProject(h, 'Beta', { conversations: [conversationUrl(B)] });
  const originBefore = new URL(h.page.url()).origin;

  // The person looks at Alpha's SECOND conversation (not the one it opens on), then moves on to Beta and leaves it selected.
  await selectProject(h.page, 'Alpha');
  await until('Alpha\'s first conversation to be in front', async () => (await chatgptView(h.app))?.url === conversationUrl(A1));
  await h.page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await h.page.getByRole('option', { name: /ChatGPT conversation a2a2a2a2/ }).click();
  await until('Alpha\'s second conversation to be in front', async () => (await chatgptView(h.app))?.url === conversationUrl(A2));
  await selectProject(h.page, 'Beta');

  // The core, not the page, is where it is kept: wait for the window's quiet-period write to arrive (what a person waits for without knowing).
  const remembered = await until('the core to hold what the window remembers', async () => {
    const ui = (await h.api.call('settings.get')).ui;
    return ui?.route?.projectId === beta.project.id && ui.perProject?.[alpha.project.id]?.conversationId === alpha.conversations[1].id && ui.setup?.dismissed === true ? ui : null;
  }, { timeout: 15_000 });
  expect(remembered.route).toEqual({ projectId: beta.project.id, view: 'workspace' });

  expect((await h.quit()).code).toBe(0);

  // Something else holds 47811 for the second launch only: the core falls back to a free port, so the window's origin is another one.
  const holder = await occupyPreferredPort();
  try {
    const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn, firstRun: true }); // firstRun: the checklist is NOT hidden for the test
    const originAfter = new URL(h2.page.url()).origin;
    expect(h2.port, 'the core must have taken another port, or this check proves nothing').not.toBe(PREFERRED_CORE_PORT);
    expect(originAfter, 'the window must be on another origin, so that nothing in the old origin\'s localStorage can help').not.toBe(originBefore);

    // It reopens on Beta, as it was left.
    const heading = await h2.page.getByRole('heading', { level: 1 }).first().innerText();
    expect(heading, `reopened on "${heading}" instead of the project that was selected ("Beta"); origin ${originBefore} -> ${originAfter}`).toBe('Beta');
    // The checklist that was hidden stays hidden, and a window that has projects never shows it in the middle of the screen.
    await sleep(1500);
    expect(await h2.page.getByRole('region', { name: 'Set up Mini-Summa' }).count(), 'the setup checklist came back after the origin changed').toBe(0);
    // Alpha's choice of conversation came back too: its pane shows, and the view loads, the second conversation.
    await selectProject(h2.page, 'Alpha');
    await until('the second conversation of Alpha to be in front', async () => (await chatgptView(h2.app))?.url === conversationUrl(A2));
    expect(await h2.page.getByRole('button', { name: 'Conversation', exact: true }).innerText()).toContain('a2a2a2a2');
    expect(h2.standIn.requests.filter((r) => r.path.includes(B)).length, 'Beta\'s conversation was loaded for the window\'s first screen only').toBeGreaterThan(0);
    evidence('X02', `the core could not take its preferred port ${PREFERRED_CORE_PORT} for the second launch (a throw-away listener held it) and listened on ${h2.port}, so the window's origin changed (${originBefore} -> ${originAfter}) and the localStorage of the old origin could not carry anything over; the window still reopened on Beta, kept Alpha's second conversation (its pane loaded it, not the first one) and kept the setup checklist hidden; the state came from the core's settings (ui.route, ui.perProject, ui.setup)`);
  } finally {
    await holder.close();
  }
});

// Not one of the 25 behaviours: what the window tells a person about a session that ended. The reason is in words a person can
// read, whichever way the session ended (the person stopped it; the app was closed around it).
scenario('[X03] A session that ended says why in words, not as an internal code', async () => {
  const h = await launchApp();
  const alpha = await createProject(h, 'Alpha', { conversations: [conversationUrl(A1)] });
  const stopped = await startSession(h, alpha.project.id, { name: 'stopped' });
  const kept = await startSession(h, alpha.project.id, { name: 'kept' });
  await finishTask(h, { project: alpha.project, session: stopped }, 'Stopped one');
  await finishTask(h, { project: alpha.project, session: kept }, 'Kept one');
  const tag = (s: SessionView): string => s.sessionId.slice(0, 8);
  const reasonShown = async (page: AppHandle['page'], what: string): Promise<string> => {
    const notice = page.getByRole('region', { name: 'Claude', exact: true }).getByRole('status').filter({ hasText: 'This session ended' });
    await notice.waitFor();
    const first = ((await notice.innerText()).split('\n')[0] ?? '').trim();
    evidence('X03', `${what}: the window says "${first}"`);
    return first.replace(/^This session ended: /, '');
  };
  const inWords = (reason: string): boolean => /^[A-Z][^_]* [^_]*\.$/.test(reason);

  // 1. The person stops a session from its menu.
  await selectProject(h.page, 'Alpha');
  const claude = h.page.getByRole('region', { name: 'Claude', exact: true });
  await claude.getByRole('tab', { name: new RegExp(`^Session ${tag(stopped)},`) }).click();
  await claude.getByRole('button', { name: `Actions for session ${tag(stopped)}` }).click();
  await h.page.getByRole('menuitem', { name: 'Stop session' }).click();
  await h.page.getByRole('alertdialog', { name: `Stop session ${tag(stopped)}?` }).getByRole('button', { name: 'Stop session' }).click();
  const afterStop = await reasonShown(h.page, 'after the person stopped a session');

  // 2. The app is closed around the other one, and opened again.
  await claude.getByRole('tab', { name: new RegExp(`^Session ${tag(kept)},`) }).click();
  expect((await h.quit()).code).toBe(0);
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await selectProject(h2.page, 'Alpha');
  await h2.page.getByRole('tab', { name: new RegExp(`^Session ${tag(kept)},.*Session ended`) }).waitFor();
  const afterQuit = await reasonShown(h2.page, 'after the app was closed around a running session');

  const wordless = [['stopped by the person', afterStop], ['app closed', afterQuit]].filter(([, reason]) => !inWords(reason as string));
  expect(wordless.map(([when, reason]) => `${when}: "This session ended: ${reason}"`), 'the notice must give the reason as a sentence, not as the internal code the core records').toEqual([]);
});
