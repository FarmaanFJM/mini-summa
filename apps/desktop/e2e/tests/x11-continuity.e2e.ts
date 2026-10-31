// X11: a Mini-Summa project is a persistent workspace. Its ChatGPT pane comes back on the last page the person was on IN THAT PROJECT,
// with nothing pasted, across switching projects and across a restart; opening and creating conversations in ChatGPT never creates a
// project or maps a conversation; each project keeps its own live ChatGPT view (conversation, scroll position, an unsent draft) while it
// is within the bound on live views, and a view that is unloaded to save memory is announced and loads again at its last address.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. Every page comes from a local stand-in for chatgpt.com (an HTTPS server on loopback with a
// throw-away certificate, reached through the host-resolver seam). The stand-in's pages are navigated the way a page of the real site
// would be: by a script that changes the address without loading (history.pushState, what a single-page app does) and by a normal link
// that loads a new document. The test plays the PERSON for typing and plays the SITE for those navigations; the product only watches
// the address. It proves what Mini-Summa remembers, restores and keeps alive in the real Electron window on Linux under Xvfb. It does
// not prove how the real chatgpt.com navigates or what it does in a hidden view, and nothing about Windows (NOT TESTED).
import { expect } from 'vitest';
import type { AppHandle } from '../helpers/app.ts';
import { launchApp } from '../helpers/app.ts';
import { acceptsInput } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { finishTask, sceneWithSession } from '../helpers/flow.ts';
import { chatgptViewMemory, chatgptViews, clickNotification, composerOf, inChatgptView, notificationSpy, spyOnNotifications, typeIntoView } from '../helpers/main-process.ts';
import { makeRepo } from '../helpers/sandbox.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, projectScope, projectUrl, uuidOf } from '../helpers/standin.ts';
import { openSettings, projectRow, reportDetail, selectProject } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const DASH = String.fromCharCode(8212);

/** A conversation inside a ChatGPT Project, as ChatGPT's addresses look today. */
const chatIn = (scope: string, tag: string): string => `https://chatgpt.com/g/${scope}/c/${uuidOf(tag)}`;

/** The page navigates without loading, the way a single-page app does when the person opens a conversation. */
const pushState = (h: AppHandle, viewId: number, url: string): Promise<unknown> => inChatgptView(h.app, viewId, `history.pushState({}, '', ${JSON.stringify(new URL(url).pathname)})`);

/** The page loads a new document through an ordinary link, the way following a link in the sidebar does. */
const followLink = (h: AppHandle, viewId: number, url: string): Promise<unknown> =>
  inChatgptView(h.app, viewId, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(new URL(url).pathname)}; a.textContent = 'next'; document.body.append(a); a.click(); })()`);

/** What the core remembers as the last ChatGPT page of a project. */
const remembered = async (h: AppHandle, projectId: string): Promise<string | undefined> => (await h.api.call('settings.get')).ui?.perProject?.[projectId]?.chatgptUrl;

const untilRemembered = (h: AppHandle, name: string, projectId: string, url: string): Promise<unknown> =>
  until(`the core to remember ${url} for ${name}`, async () => (await remembered(h, projectId)) === url);

/** The one view on screen, once the project's page is in it. */
const visibleView = async (h: AppHandle, url: string) => until(`the view on screen to show ${url}`, async () => {
  const views = (await chatgptViews(h.app)).filter((v) => v.visible);
  return views.length === 1 && views[0].url === url && !views[0].loading ? views[0] : null;
});

const projectsSnapshot = async (h: AppHandle) => (await h.api.call('projects.list')).map((p) => ({ ...p }));

scenario('[X11] Each project reopens on the last ChatGPT page used in it, through switching and a restart, without creating or mapping anything', async () => {
  const h = await launchApp();
  const scopes = { alpha: projectScope('a1', 'alpha'), beta: projectScope('b2', 'beta'), gamma: projectScope('c3', 'gamma') };
  const make = async (name: string, link?: string) => h.api.call('projects.create', { body: { name, roots: [{ path: makeRepo(h.sandbox, name) }], ...(link ? { chatgptProject: { url: link } } : {}) } });
  const alpha = await make('Alpha', projectUrl(scopes.alpha));
  const beta = await make('Beta', projectUrl(scopes.beta));
  const gamma = await make('Gamma', projectUrl(scopes.gamma));
  const delta = await make('Delta'); // no ChatGPT Project; one conversation mapped the old way
  const echo = await make('Echo'); // nothing at all
  const mapped = await h.api.call('conversations.add', { params: { id: delta.id }, body: { url: conversationUrl(uuidOf('d1')) } });
  const before = await projectsSnapshot(h);
  expect(before).toHaveLength(5);

  // (a) Three projects, each in its own ChatGPT Project; in each the person goes somewhere else than the project page.
  await selectProject(h.page, 'Alpha');
  const alphaView = await visibleView(h, projectUrl(scopes.alpha));
  await untilRemembered(h, 'Alpha', alpha.id, projectUrl(scopes.alpha)); // the project page opened by the pane is the first page used
  await pushState(h, alphaView.id, chatIn(scopes.alpha, '11')); // in-page navigation
  await untilRemembered(h, 'Alpha', alpha.id, chatIn(scopes.alpha, '11'));
  // Pages that are not worth coming back to are never remembered: settings, the home page, and a page of another ChatGPT Project.
  await pushState(h, alphaView.id, 'https://chatgpt.com/settings');
  await pushState(h, alphaView.id, 'https://chatgpt.com/');
  await pushState(h, alphaView.id, chatIn(scopes.beta, '99'));
  await new Promise((resolve) => setTimeout(resolve, 1600)); // longer than the 0.6 s the window waits before telling the core
  expect(await remembered(h, alpha.id)).toBe(chatIn(scopes.alpha, '11'));
  await pushState(h, alphaView.id, chatIn(scopes.alpha, '12'));
  await untilRemembered(h, 'Alpha', alpha.id, chatIn(scopes.alpha, '12'));

  await selectProject(h.page, 'Beta');
  const betaView = await visibleView(h, projectUrl(scopes.beta));
  await followLink(h, betaView.id, chatIn(scopes.beta, '21')); // a normal link: a new document
  await visibleView(h, chatIn(scopes.beta, '21'));
  await untilRemembered(h, 'Beta', beta.id, chatIn(scopes.beta, '21'));

  await selectProject(h.page, 'Gamma');
  const gammaView = await visibleView(h, projectUrl(scopes.gamma));
  await followLink(h, gammaView.id, chatIn(scopes.gamma, '31'));
  await visibleView(h, chatIn(scopes.gamma, '31'));
  await pushState(h, gammaView.id, chatIn(scopes.gamma, '32'));
  await untilRemembered(h, 'Gamma', gamma.id, chatIn(scopes.gamma, '32'));

  // Switching among the three restores three independent last-used addresses: no mixing, and nothing is loaded again (the live view of each
  // project is still there with its page).
  const mark = h.standIn.mark();
  const ids = new Map([['Alpha', alphaView.id], ['Beta', betaView.id], ['Gamma', gammaView.id]]);
  const expectedNow = { Alpha: chatIn(scopes.alpha, '12'), Beta: chatIn(scopes.beta, '21'), Gamma: chatIn(scopes.gamma, '32') };
  for (const name of ['Alpha', 'Gamma', 'Beta', 'Alpha', 'Beta', 'Gamma'] as const) {
    await selectProject(h.page, name);
    const shown = await visibleView(h, expectedNow[name]);
    expect(shown.id, `${name} keeps its own web contents`).toBe(ids.get(name));
  }
  expect((await chatgptViews(h.app)).map((v) => v.url).sort()).toEqual(Object.values(expectedNow).sort());
  expect(h.standIn.pathsSince(mark), 'switching projects loaded nothing').toEqual([]);
  expect(await remembered(h, alpha.id)).toBe(expectedNow.Alpha);
  expect(await remembered(h, beta.id)).toBe(expectedNow.Beta);
  expect(await remembered(h, gamma.id)).toBe(expectedNow.Gamma);

  // The header action: the linked project page, one click. It becomes Beta's last page.
  await selectProject(h.page, 'Beta');
  await h.page.getByRole('region', { name: 'ChatGPT', exact: true }).getByRole('button', { name: 'Open project page' }).click();
  await visibleView(h, projectUrl(scopes.beta));
  await untilRemembered(h, 'Beta', beta.id, projectUrl(scopes.beta));
  expectedNow.Beta = projectUrl(scopes.beta);

  // (d) A project without a linked ChatGPT Project still works as before: its mapped conversation opens, the offer to use a visited
  // conversation stays an explicit action, and what is visited is remembered for it without being mapped.
  await selectProject(h.page, 'Delta');
  const deltaView = await visibleView(h, conversationUrl(uuidOf('d1')));
  await pushState(h, deltaView.id, conversationUrl(uuidOf('d2')));
  await untilRemembered(h, 'Delta', delta.id, conversationUrl(uuidOf('d2')));
  await selectProject(h.page, 'Echo');
  await h.page.getByRole('region', { name: 'ChatGPT', exact: true }).getByText('This project has no ChatGPT Project or conversation yet.').waitFor();
  expect(await remembered(h, echo.id)).toBeUndefined();

  // (c) Creating and opening conversations never changes the projects: same count, same fields, nothing mapped.
  expect(await projectsSnapshot(h)).toEqual(before);
  for (const p of [alpha, beta, gamma, echo]) expect(await h.api.call('conversations.list', { params: { id: p.id } }), p.name).toEqual([]);
  expect(await h.api.call('conversations.list', { params: { id: delta.id } })).toEqual([mapped]);
  expect(h.standIn.submissions()).toEqual([]);

  // (b) A restart: every project opens on its own last page, not on its project page, and the first request is for that page.
  const last = { alpha: expectedNow.Alpha, beta: expectedNow.Beta, gamma: expectedNow.Gamma, delta: conversationUrl(uuidOf('d2')) };
  await selectProject(h.page, 'Gamma');
  await visibleView(h, last.gamma);
  await until('the last choices to reach the core', async () => (await h.api.call('settings.get')).ui?.route?.projectId === gamma.id);
  expect((await h.quit()).code).toBe(0);
  const restartMark = h.standIn.mark();
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await projectRow(h2.page, 'Gamma').waitFor();
  await visibleView(h2, last.gamma); // the selected project comes back on its page
  for (const [name, id, url] of [['Alpha', alpha.id, last.alpha], ['Beta', beta.id, last.beta], ['Delta', delta.id, last.delta]] as const) {
    expect(await remembered(h2, id), `${name} is remembered by the core after the restart`).toBe(url);
    await selectProject(h2.page, name);
    await visibleView(h2, url);
  }
  const paths = h2.standIn.pathsSince(restartMark);
  expect(paths.some((p) => p === `/g/${scopes.alpha}/project` || p === `/g/${scopes.gamma}/project`), 'a project with a remembered page did not open its project page').toBe(false);
  expect(paths).toContain(new URL(last.alpha).pathname);
  expect(paths).toContain(new URL(last.gamma).pathname);
  expect(await projectsSnapshot(h2)).toEqual(before);
  expect(await h2.api.call('conversations.list', { params: { id: delta.id } })).toEqual([mapped]);

  evidence('X11', `against a local stand-in for chatgpt.com only (NOT the real site, NOT Windows): three projects, each linked to its own ChatGPT Project, were taken to different conversations by an in-page navigation (history.pushState) and by a link that loads a document; the core remembered each project's last page (settings, the home page and a page of another ChatGPT Project were not remembered); switching among the three six times showed each project's own last address in its own web contents (ids ${[...ids.values()].join(', ')}) with no request at all; the header action "Open project page" opened the linked project page; an unlinked project with a mapped conversation remembered the conversation it moved to without mapping it; a project with nothing showed the empty state; projects.list was identical (5 projects, same fields) and no conversation was mapped; after a quit and a start every project reopened on its last page and the stand-in saw no request for a project page of a project that had a remembered page`);
}, { timeout: 240_000 });

scenario('[X11] A project keeps its live ChatGPT view (page and unsent draft) within the bound; the least recently used view is unloaded with a notice and loads again at its last address; Claude, notifications and the view control still work', async () => {
  const h = await launchApp({ fakeKnobs: { FAKE_CLAUDE_NOTIFY_MS: '300' } });
  await spyOnNotifications(h.app, true);
  const names = ['Anna', 'Boris', 'Cleo', 'Dmitri', 'Eva'] as const;
  const scope = Object.fromEntries(names.map((n, i) => [n, projectScope(`${'abcde'[i]}${i + 1}`, n.toLowerCase())])) as Record<(typeof names)[number], string>;
  // Cleo also has a folder and a running local Claude session (the fake one).
  const cleo = await sceneWithSession(h, 'Cleo');
  await h.api.call('projects.update', { params: { id: cleo.project.id }, body: { chatgptProject: { url: projectUrl(scope.Cleo) } } });
  const made = new Map<string, string>([['Cleo', cleo.project.id]]);
  for (const n of names) {
    if (n === 'Cleo') continue;
    made.set(n, (await h.api.call('projects.create', { body: { name: n, roots: [], chatgptProject: { url: projectUrl(scope[n]) } } })).id);
  }
  const before = await projectsSnapshot(h);

  // Anna: a conversation and an unsent draft.
  await selectProject(h.page, 'Anna');
  const annaFirst = await visibleView(h, projectUrl(scope.Anna));
  await pushState(h, annaFirst.id, chatIn(scope.Anna, '41'));
  const annaPage = chatIn(scope.Anna, '41');
  await untilRemembered(h, 'Anna', made.get('Anna')!, annaPage);
  await typeIntoView(h.app, annaFirst.id, 'unsent in Anna');

  // (e) The draft survives switching to Boris and back: the same web contents, the same draft, the page not loaded again.
  const mark = h.standIn.mark();
  await selectProject(h.page, 'Boris');
  const boris = await visibleView(h, projectUrl(scope.Boris));
  const hidden = (await chatgptViews(h.app)).find((v) => v.id === annaFirst.id);
  expect(hidden?.visible, 'Anna\'s view is hidden, not closed').toBe(false);
  await selectProject(h.page, 'Anna');
  const annaBack = await visibleView(h, annaPage);
  expect(annaBack.id).toBe(annaFirst.id);
  expect(await composerOf(h.app, annaBack.id)).toBe('unsent in Anna');
  expect(h.standIn.pathsSince(mark).filter((p) => p.includes('/c/'))).toEqual([]);

  // Up to the bound (four live views) nothing is unloaded and no notice is shown.
  await selectProject(h.page, 'Boris');
  await selectProject(h.page, 'Cleo');
  await visibleView(h, projectUrl(scope.Cleo));
  await selectProject(h.page, 'Dmitri');
  await visibleView(h, projectUrl(scope.Dmitri));
  expect(await chatgptViews(h.app)).toHaveLength(4);
  expect(await h.page.getByText(/was unloaded to save memory/).count()).toBe(0);
  // Memory of the four live views (Electron's process metrics; the stand-in page, not the real site). Written to the evidence, not asserted.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const memory = await chatgptViewMemory(h.app);
  expect(memory).toHaveLength(4);
  const perView = memory.map((m) => `${m.workingSetMB} MB working set / ${m.privateMB} MB private (pid ${m.pid})`).join('; ');
  expect(boris.id).toBeGreaterThan(0);

  // The fifth view: the least recently used one (Anna's) is unloaded, with a notice that says what was lost and where it comes back.
  await selectProject(h.page, 'Eva');
  await visibleView(h, projectUrl(scope.Eva));
  const expected = `The ChatGPT page of Anna was unloaded to save memory. Unsent text there is gone; the page will reload at ${annaPage}.`;
  await h.page.getByText(expected).waitFor();
  expect(expected).not.toContain(DASH);
  const live = await chatgptViews(h.app);
  expect(live).toHaveLength(4);
  expect(live.find((v) => v.id === annaFirst.id), 'Anna\'s view was destroyed').toBeUndefined();
  expect(live.filter((v) => v.visible).map((v) => v.url)).toEqual([projectUrl(scope.Eva)]);

  // Opening Anna again loads her last address into a new view (and nothing else); the draft is gone, as the notice said.
  const mark2 = h.standIn.mark();
  await selectProject(h.page, 'Anna');
  const annaAgain = await visibleView(h, annaPage);
  expect(annaAgain.id).not.toBe(annaFirst.id);
  expect(await composerOf(h.app, annaAgain.id)).toBe('');
  expect(h.standIn.pathsSince(mark2)).toEqual([new URL(annaPage).pathname]);
  expect(await remembered(h, made.get('Anna')!)).toBe(annaPage);
  expect(await chatgptViews(h.app)).toHaveLength(4); // still within the bound: another view made room

  // (f) Claude, a notification click and the Workspace view control still work in the same scenario.
  // Cleo's local session finishes a task while Anna is on screen; the notification goes to the report.
  const report = await finishTask(h, cleo, 'Ship the importer');
  const spyTitles = async () => (await notificationSpy(h.app)).created.map((c) => c.title);
  await until('the report notification to be shown', async () => (await spyTitles()).includes('Cleo: report ready'));
  await openSettings(h.page);
  expect(await clickNotification(h.app, (await spyTitles()).lastIndexOf('Cleo: report ready'))).toBe(true);
  await reportDetail(h.page).getByRole('heading', { level: 1, name: report.taskTitle }).waitFor();
  expect((await chatgptViews(h.app)).filter((v) => v.visible), 'no ChatGPT view over the report').toEqual([]);
  await until('Claude to be ready again', async () => acceptsInput(await h.api.call('sessions.get', { params: { key: cleo.session.key } })));
  // Back to a project: its view is shown again and is the same one.
  await selectProject(h.page, 'Anna');
  const annaShown = await visibleView(h, annaPage);
  expect(annaShown.id).toBe(annaAgain.id);
  // The Workspace view control: Claude only hides every ChatGPT view, ChatGPT only and Split show Anna's; the draft typed now survives.
  await typeIntoView(h.app, annaShown.id, 'second draft');
  const control = h.page.getByRole('radiogroup', { name: 'Workspace view' });
  await control.getByRole('radio', { name: 'Claude', exact: true }).click();
  await until('every ChatGPT view to be hidden', async () => (await chatgptViews(h.app)).every((v) => v.visible === false));
  await control.getByRole('radio', { name: 'ChatGPT', exact: true }).click();
  await visibleView(h, annaPage);
  await control.getByRole('radio', { name: 'Split', exact: true }).click();
  const split = await visibleView(h, annaPage);
  expect(split.id).toBe(annaAgain.id);
  expect(await composerOf(h.app, split.id)).toBe('second draft');
  // Cleo's local session is still the Claude pane's session and still answers.
  await selectProject(h.page, 'Cleo');
  await h.page.getByRole('tab', { name: new RegExp(`^Session ${cleo.session.sessionId.slice(0, 8)},`) }).waitFor();
  expect((await h.api.call('sessions.get', { params: { key: cleo.session.key } })).state).not.toBe('error');

  expect(await projectsSnapshot(h)).toEqual(before);
  expect(h.standIn.submissions()).toEqual([]);
  evidence('X11', `against a local stand-in for chatgpt.com only (NOT the real site, NOT Windows): five projects, each linked to its own ChatGPT Project; the four live views cost, as separate renderer processes (Electron process metrics, idle stand-in page): ${perView}; a draft typed in Anna's view was still there, in the same web contents (id ${annaFirst.id}), after Boris was shown and Anna again, with no request for her page; four live views were kept without any notice; the fifth view unloaded the least recently used one (Anna's), the window showed "${expected}", her web contents was gone, opening her again loaded exactly her last address (one request) into a new web contents (id ${annaAgain.id}) with an empty draft; a local Claude session finished a task, the (simulated) notification click opened that report with no ChatGPT view over it, and the Workspace view control hid and showed the views with the second draft intact; projects.list was unchanged`);
}, { timeout: 300_000 });
