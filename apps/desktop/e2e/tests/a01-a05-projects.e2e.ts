// A01-A05: the app starts, and a person can register a project, pick its folder, configure its ChatGPT conversations and
// open them. Everything is driven through the real window; the core's API is used only to read back what the UI claims.
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { evidence } from '../helpers/evidence.ts';
import { allWebContentsUrls, answerFolderPicker, chatgptView, folderPickerCalls, windowInfo } from '../helpers/main-process.ts';
import { makeRepo } from '../helpers/sandbox.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import {
  addConversationInDialog, addFolderByTyping, addFolderWithPicker, createProjectInUi, openEditProject, openNewProject, projectRow,
} from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const A = uuidOf('a');
const B = uuidOf('b');

scenario('[A01] Mini-Summa launches successfully', async () => {
  const h = await launchApp({ firstRun: true });

  // A visible window on the embedded core's own origin, with the preload's bridge and no Node in the page.
  const info = await windowInfo(h.app);
  expect(info.visible).toBe(true);
  expect(h.page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ui\/$/);
  expect(await h.page.title()).toBe('Mini-Summa');
  const bridge = await h.page.evaluate(() => ({ kind: window.miniSumma?.kind, platform: window.miniSumma?.platform, hasRequire: typeof (window as unknown as { require?: unknown }).require, hasProcess: typeof (window as unknown as { process?: unknown }).process }));
  expect(bridge).toEqual({ kind: 'electron', platform: 'linux', hasRequire: 'undefined', hasProcess: 'undefined' });

  // The shell is on screen: the navigation, the empty state with its one action.
  await h.page.getByRole('complementary', { name: 'Mini-Summa navigation' }).waitFor();
  await h.page.getByRole('main').getByRole('button', { name: 'Create project' }).waitFor();

  // The real core is up behind it: health is public, everything else needs the token, the token is not in the page.
  const health = await fetch(`${h.baseUrl}/api/v1/health`);
  expect(await health.json()).toMatchObject({ ok: true, name: 'mini-summa-core' });
  expect((await fetch(`${h.baseUrl}/api/v1/state`)).status).toBe(401);
  expect(await (await fetch(`${h.baseUrl}/ui/`)).text()).not.toContain(h.token);
  const state = await h.api.call('system.state');
  expect(state.system).toMatchObject({ mode: 'embedded', platform: 'linux' });
  expect(state.projects).toEqual([]);
  expect(state.system.nativeCapabilities).toMatchObject({ clipboard: true, chatgptEmbedded: true });

  // Its data lives where it was told to, not in the home directory.
  expect(fs.existsSync(path.join(h.sandbox.data, 'mini-summa.db'))).toBe(true);
  expect(fs.existsSync(path.join(h.sandbox.home, '.config', 'Mini-Summa'))).toBe(false);

  const versions = await h.app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, packaged: false }));
  const exit = await h.quit();
  expect(exit.code).toBe(0);
  expect(exit.asked).toEqual([]); // nothing was running, so nothing was asked
  expect(h.pageErrors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
  evidence('A01', `window ${info.bounds.width}x${info.bounds.height} on ${h.page.url()}; Electron ${versions.electron}, Chromium ${versions.chrome}, Node ${versions.node}; core ${state.system.version} (embedded, api ${state.system.apiVersion}); preload bridge present, no require/process in the page; clean quit, exit code ${exit.code}`);
});

scenario('[A02] A new project can be registered', async () => {
  const h = await launchApp();
  const repo = makeRepo(h.sandbox, 'Alpha');

  // Nothing is created by an incomplete form.
  const dialog = await openNewProject(h.page);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.getByText('Give the project a name.').waitFor();
  expect(await h.api.call('projects.list')).toEqual([]);

  // A complete one creates the project and selects it.
  await dialog.getByLabel('Name', { exact: true }).fill('Alpha');
  await addFolderByTyping(dialog, repo);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: 'Alpha' }).waitFor();
  await projectRow(h.page, 'Alpha').waitFor();
  expect(await projectRow(h.page, 'Alpha').getAttribute('aria-current')).toBe('true');

  const projects = await h.api.call('projects.list');
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({ name: 'Alpha', archivedAt: null });
  expect(projects[0].roots.map((r) => r.path)).toEqual([repo]);
  evidence('A02', `empty form refused ("Give the project a name."), nothing created; "Alpha" created through the dialog, selected in the sidebar, stored with id ${projects[0].id} and root ${repo}`);
});

scenario('[A03] Its repository directory can be selected', async () => {
  const h = await launchApp();
  const repo = makeRepo(h.sandbox, 'Picked');

  const dialog = await openNewProject(h.page);
  await dialog.getByLabel('Name', { exact: true }).fill('Picked');

  // The native folder picker is a dialog of the operating system: the test answers it, the app asks for it for real.
  await answerFolderPicker(h.app, null);
  await dialog.getByRole('button', { name: 'Browse' }).click();
  await until('the picker to have been asked', async () => (await folderPickerCalls(h.app)).length === 1);
  expect(await dialog.getByLabel('Add a folder').inputValue()).toBe(''); // cancelled: nothing was filled in

  await answerFolderPicker(h.app, repo);
  await addFolderWithPicker(dialog);
  const calls = await folderPickerCalls(h.app);
  expect(calls.at(-1)).toMatchObject({ title: 'Choose the repository folder' });
  expect(calls.at(-1)?.properties).toEqual(expect.arrayContaining(['openDirectory']));
  const listed = dialog.getByRole('list', { name: 'Repository folders' });
  await listed.getByText(repo, { exact: true }).waitFor();

  // Adding the same folder twice is refused, not duplicated.
  await dialog.getByLabel('Add a folder').fill(repo);
  await dialog.getByRole('button', { name: 'Add folder' }).click();
  await dialog.getByText('This folder is already in the list.').waitFor();

  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });
  const [project] = await h.api.call('projects.list');
  expect(project.roots).toHaveLength(1);
  expect(project.roots[0]).toMatchObject({ path: repo, env: 'posix' });
  expect(fs.statSync(project.roots[0].path).isDirectory()).toBe(true);
  evidence('A03', `Browse asked the native picker ("${calls.at(-1)?.title}", ${calls.at(-1)?.properties?.join('+')}); a cancelled pick changed nothing; the picked folder ${repo} was listed, a duplicate was refused, and the project was stored with exactly that root`);
});

scenario('[A04] Its ChatGPT conversation URL can be configured', async () => {
  const h = await launchApp();
  const repo = makeRepo(h.sandbox, 'Configured');
  const dialog = await openNewProject(h.page);
  await dialog.getByLabel('Name', { exact: true }).fill('Configured');
  await addFolderByTyping(dialog, repo);

  // Only conversation addresses on chatgpt.com over https are accepted; the reason is said in words.
  const field = dialog.getByLabel('Add a conversation');
  const add = dialog.getByRole('button', { name: 'Add conversation' });
  for (const [typed, message] of [
    ['https://example.org/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Only chatgpt.com conversation addresses are accepted.'],
    ['http://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Only https addresses are accepted.'],
    ['javascript:alert(1)', 'Only https addresses are accepted.'],
  ] as const) {
    await field.fill(typed);
    await dialog.getByText(message).waitFor();
    expect(await add.isDisabled()).toBe(true);
  }

  // A pasted address is normalised (no query, no fragment, lower case), shown before it is added, and the first one becomes preferred.
  await field.fill(`${conversationUrl(A).toUpperCase().replace('HTTPS://CHATGPT.COM/C/', 'https://chatgpt.com/c/')}?model=x#top`);
  await dialog.getByText(conversationUrl(A), { exact: true }).waitFor();
  await add.click();
  await addConversationInDialog(dialog, conversationUrl(B));
  expect(await dialog.getByRole('radio', { name: `Preferred: ChatGPT conversation ${A.slice(0, 8)}` }).isChecked()).toBe(true);

  // Choose the second one as the preferred conversation, then save.
  await dialog.getByRole('radio', { name: `Preferred: ChatGPT conversation ${B.slice(0, 8)}` }).check();
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });

  const [project] = await h.api.call('projects.list');
  const conversations = await h.api.call('conversations.list', { params: { id: project.id } });
  expect(conversations.map((c) => c.url)).toEqual([conversationUrl(A), conversationUrl(B)]);
  expect(project.preferredConversationId).toBe(conversations[1].id);
  expect(conversations.every((c) => c.verification === 'unverified')).toBe(true); // nothing is claimed that was not checked

  // Configuring is also editing: rename one, remove the other, and the core follows.
  const edit = await openEditProject(h.page, 'Configured');
  await edit.getByRole('textbox', { name: `Title of ChatGPT conversation ${B.slice(0, 8)}` }).fill('Release plan');
  await edit.getByRole('button', { name: `Remove ChatGPT conversation ${A.slice(0, 8)}` }).click();
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await edit.waitFor({ state: 'detached' });
  await until('the core to hold the edited conversations', async () => {
    const list = await h.api.call('conversations.list', { params: { id: project.id } });
    return list.length === 1 && list[0].title === 'Release plan' && list[0].url === conversationUrl(B);
  });
  const after = await h.api.call('projects.get', { params: { id: project.id } });
  expect(after.preferredConversationId).toBe(conversations[1].id);
  evidence('A04', `refused example.org, http and javascript: addresses with a reason; accepted a messy pasted address as ${conversationUrl(A)}; two conversations stored in order, preferred chosen in the dialog (stored: ${after.preferredConversationId === conversations[1].id ? 'the second' : 'WRONG'}); rename and removal edited through the same dialog`);
});

scenario('[A05] The linked existing conversation can be opened', async () => {
  const h = await launchApp();
  h.standIn.name(A, 'Stand-in: the Alpha conversation');
  h.standIn.name(B, 'Stand-in: the second conversation');
  const repo = makeRepo(h.sandbox, 'Linked');

  // Create the project in the UI with two conversations; the pane in the workspace loads the preferred one by itself.
  await createProjectInUi(h.page, { name: 'Linked', folder: repo, conversations: [conversationUrl(A), conversationUrl(B)] });
  await until('the embedded view to show conversation A', async () => (await chatgptView(h.app))?.url === conversationUrl(A));
  const first = await until('the embedded view to finish loading', async () => {
    const view = await chatgptView(h.app);
    return view && !view.loading && view.title === 'Stand-in: the Alpha conversation' ? view : null;
  });
  expect(first.visible).toBe(true);
  expect(first.bounds?.width).toBeGreaterThan(100);
  expect(h.standIn.requests.filter((r) => r.path === `/c/${A}`)).toHaveLength(1);
  expect(h.standIn.requests[0].host).toBe('chatgpt.com');
  expect(h.standIn.requests[0].headers.cookie).toBeUndefined(); // an isolated profile: nothing of any real session

  // Another linked conversation opens in the same view through the pane's own selector.
  await h.page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await h.page.getByRole('option', { name: /ChatGPT conversation bbbbbbbb/ }).click();
  await until('the view to show conversation B', async () => (await chatgptView(h.app))?.url === conversationUrl(B));

  // "Open" in the project's own settings opens the conversation the core knows, and says what was verified.
  const edit = await openEditProject(h.page, 'Linked');
  await edit.getByRole('button', { name: `Open ChatGPT conversation ${A.slice(0, 8)}` }).click();
  await until('the view to show conversation A again', async () => (await chatgptView(h.app))?.url === conversationUrl(A));
  await edit.getByRole('button', { name: `Verify ChatGPT conversation ${A.slice(0, 8)}` }).click();
  await edit.getByText('Verified: Stand-in: the Alpha conversation').waitFor();
  const conversations = await h.api.call('conversations.list', { params: { id: (await h.api.call('projects.list'))[0].id } });
  expect(conversations.find((c) => c.url === conversationUrl(A))).toMatchObject({ verification: 'verified', verifiedTitle: 'Stand-in: the Alpha conversation' });

  // The only web contents besides the app window is that view, and it never left the stand-in.
  const urls = await allWebContentsUrls(h.app);
  expect(urls.filter((u) => u.startsWith('https://'))).toEqual([conversationUrl(A)]);
  expect(h.standIn.requests.every((r) => r.host === 'chatgpt.com' && r.method === 'GET')).toBe(true);
  evidence('A05', `the pane loaded ${conversationUrl(A)} in the embedded view (title "${first.title}", stand-in saw one GET for ${`/c/${A}`}); the selector switched to B; "Open" and "Verify" in the project dialog reopened A and marked it verified from the page title; every request carried Host chatgpt.com`);
});
