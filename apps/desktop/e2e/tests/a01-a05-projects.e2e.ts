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
  addConversationInDialog, addFolderByTyping, addFolderWithPicker, chooseSource, closeSettings, createProjectInUi, listedFolders, openEditProject,
  openNewProject, projectHeaderText, projectRow,
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

  // Nothing is created by an incomplete form. The dialog starts from a ChatGPT Project and asks for that one thing and a name.
  const dialog = await openNewProject(h.page);
  expect(await dialog.getByRole('tab').allTextContents()).toEqual(['ChatGPT Project', 'GitHub repository', 'Local folder', 'Empty project']);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.getByText('Give the project a name.').waitFor();
  await dialog.getByText('Paste the address of the ChatGPT Project.').waitFor();
  expect(await h.api.call('projects.list')).toEqual([]);

  // Starting from a folder creates the project and selects it. The name is offered from the folder until the person types one.
  await addFolderByTyping(dialog, repo);
  await dialog.getByText(repo, { exact: true }).waitFor(); // the reading of the path
  expect(await dialog.getByLabel('Name', { exact: true }).inputValue()).toBe('Alpha');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: 'Alpha' }).waitFor();
  await projectRow(h.page, 'Alpha').waitFor();
  expect(await projectRow(h.page, 'Alpha').getAttribute('aria-current')).toBe('true');

  const projects = await h.api.call('projects.list');
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({ name: 'Alpha', archivedAt: null, githubRepo: null, chatgptProject: null });
  expect(projects[0].roots.map((r) => r.path)).toEqual([repo]);

  // Starting from a GitHub repository creates a project with no folder at all, and it is complete as it is.
  const github = await openNewProject(h.page);
  await chooseSource(github, 'GitHub repository');
  await github.getByLabel('Repository', { exact: true }).fill('https://github.com/FarmaanFIM/Beta.git');
  await github.getByText('Will be saved as FarmaanFIM/Beta.').waitFor();
  await github.getByLabel('Repository', { exact: true }).press('Enter'); // Enter in the field creates, as the button does
  await github.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: 'Beta' }).waitFor();

  // Starting from a ChatGPT Project links its address and nothing else, and says so.
  const address = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/project';
  const chatgpt = await openNewProject(h.page);
  await chatgpt.getByText('Only the address is saved. Nothing in the project is imported or synced.').waitFor();
  await chatgpt.getByLabel('Address of an existing ChatGPT Project').fill('https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
  await chatgpt.getByText(/That is a single conversation outside any project\./).waitFor(); // refused with its reason
  await chatgpt.getByLabel('Address of an existing ChatGPT Project').fill(address);
  await chatgpt.getByText('Title: Caissa trainer').waitFor();
  expect(await chatgpt.getByLabel('Name', { exact: true }).inputValue()).toBe('Caissa trainer');
  await chatgpt.getByRole('button', { name: 'Create project' }).click();
  await chatgpt.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: 'Caissa trainer' }).waitFor();

  // Starting from nothing needs only a name.
  const empty = await openNewProject(h.page);
  await chooseSource(empty, 'Empty project');
  await empty.getByLabel('Name', { exact: true }).fill('Delta');
  await empty.getByRole('button', { name: 'Create project' }).click();
  await empty.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: 'Delta' }).waitFor();

  const all = await h.api.call('projects.list');
  const byName = Object.fromEntries(all.map((p) => [p.name, p]));
  expect(Object.keys(byName).sort()).toEqual(['Alpha', 'Beta', 'Caissa trainer', 'Delta']);
  expect(byName.Beta).toMatchObject({ githubRepo: 'FarmaanFIM/Beta', roots: [], chatgptProject: null });
  expect(byName['Caissa trainer']).toMatchObject({ githubRepo: null, roots: [], chatgptProject: { url: address, scopeId: 'g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer', title: 'Caissa trainer' } });
  expect(byName.Delta).toMatchObject({ githubRepo: null, roots: [], chatgptProject: null });
  evidence('A02', `empty form refused ("Give the project a name." and the address for the default ChatGPT Project source), nothing created; four projects created through the dialog, one from each way to start (folder ${repo}, GitHub repository normalised to FarmaanFIM/Beta, a ChatGPT Project address linked as "Caissa trainer" after a single conversation was refused, nothing), each selected on creation and stored with exactly the fields of its source`);
});

scenario('[A03] Its repository directory can be selected', async () => {
  const h = await launchApp();
  const repo = makeRepo(h.sandbox, 'Picked');

  const dialog = await openNewProject(h.page);
  // The native folder picker is a dialog of the operating system: the test answers it, the app asks for it for real.
  await answerFolderPicker(h.app, null);
  await addFolderWithPicker(dialog);
  await until('the picker to have been asked', async () => (await folderPickerCalls(h.app)).length === 1);
  expect(await dialog.getByLabel('Folder', { exact: true }).inputValue()).toBe(''); // cancelled: nothing was filled in

  await answerFolderPicker(h.app, repo);
  await addFolderWithPicker(dialog);
  await until('the folder to be the one chosen', async () => (await dialog.getByLabel('Folder', { exact: true }).inputValue()) === repo);
  const calls = await folderPickerCalls(h.app);
  expect(calls.at(-1)).toMatchObject({ title: 'Choose the project folder' });
  expect(calls.at(-1)?.properties).toEqual(expect.arrayContaining(['openDirectory']));
  // It is used at once: the name comes from it, and there is no second button.
  expect(await dialog.getByLabel('Name', { exact: true }).inputValue()).toBe('Picked');
  expect(await dialog.getByRole('button', { name: /^Add/ }).count()).toBe(0);

  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });
  const [project] = await h.api.call('projects.list');
  expect(project.roots).toHaveLength(1);
  expect(project.roots[0]).toMatchObject({ path: repo, env: 'posix' });
  expect(fs.statSync(project.roots[0].path).isDirectory()).toBe(true);

  // A project that has none can be given one in its settings. The core says no to a folder that is not there, to one that is a file,
  // and to one another project has, each in its own words beside the field; nothing is added and what was typed stays.
  await h.api.call('projects.create', { body: { name: 'Second', githubRepo: 'acme/second' } });
  const settings = await openEditProject(h.page, 'Second');
  const field = settings.getByLabel('Folder path');
  await field.fill(path.join(h.sandbox.root, 'does-not-exist'));
  await settings.getByRole('button', { name: 'Add folder', exact: true }).click();
  await settings.getByText(`This folder does not exist: ${path.join(h.sandbox.root, 'does-not-exist')}.`).waitFor();
  const aFile = path.join(repo, 'README.md');
  fs.writeFileSync(aFile, 'x');
  await field.fill(aFile);
  await settings.getByRole('button', { name: 'Add folder', exact: true }).click();
  await settings.getByText(`That is a file, not a folder: ${aFile}.`).waitFor();
  await field.fill(repo);
  await settings.getByRole('button', { name: 'Add folder', exact: true }).click();
  await settings.getByText('This folder already belongs to the project "Picked".').waitFor();
  expect(await field.inputValue()).toBe(repo);
  expect((await h.api.call('projects.list')).find((p) => p.name === 'Second')?.roots).toEqual([]);

  // Chosen with Browse it is added at once (here, the second folder of a real directory), listed with its environment, and removable.
  const other = makeRepo(h.sandbox, 'Other');
  await answerFolderPicker(h.app, other);
  await addFolderWithPicker(settings);
  await listedFolders(settings).getByText(other, { exact: true }).waitFor();
  expect((await h.api.call('projects.list')).find((p) => p.name === 'Second')?.roots.map((r) => r.path)).toEqual([other]);
  await settings.getByRole('button', { name: `Remove folder ${other}` }).click();
  await until('the folder to be gone', async () => (await h.api.call('projects.list')).find((p) => p.name === 'Second')?.roots.length === 0);
  await closeSettings(settings);
  evidence('A03', `Browse asked the native picker ("${calls.at(-1)?.title}", ${calls.at(-1)?.properties?.join('+')}); a cancelled pick changed nothing; the picked folder ${repo} became the project's folder with no second button, named the project, and was stored as exactly that root; in another project's settings the real core refused a folder that does not exist, a file and a folder that belongs to "Picked" (each in its own words beside the field, the typed path kept), and a Browse pick was added at once and removed at once`);
});

scenario('[A04] Its ChatGPT conversation URL can be configured', async () => {
  const h = await launchApp();
  const repo = makeRepo(h.sandbox, 'Configured');
  const dialog = await openNewProject(h.page);
  await dialog.getByLabel('Name', { exact: true }).fill('Configured');
  await addFolderByTyping(dialog, repo);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });
  const [project] = await h.api.call('projects.list');
  const listed = () => h.api.call('conversations.list', { params: { id: project.id } });

  // Conversations are configured in the project's settings. Only conversation addresses on chatgpt.com over https are accepted; the
  // reason is said in words.
  const settings = await openEditProject(h.page, 'Configured');
  const field = settings.getByLabel('Conversation address');
  const add = settings.getByRole('button', { name: 'Add conversation' });
  for (const [typed, message] of [
    ['https://example.org/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Only chatgpt.com conversation addresses are accepted.'],
    ['http://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Only https addresses are accepted.'],
    ['javascript:alert(1)', 'Only https addresses are accepted.'],
  ] as const) {
    await field.fill(typed);
    await settings.getByText(message).waitFor();
    expect(await add.isDisabled()).toBe(true);
  }
  expect(await listed()).toEqual([]);

  // A pasted address is normalised (no query, no fragment, lower case), shown before it is added, and the first one becomes preferred.
  await field.fill(`${conversationUrl(A).toUpperCase().replace('HTTPS://CHATGPT.COM/C/', 'https://chatgpt.com/c/')}?model=x#top`);
  await settings.getByText(conversationUrl(A), { exact: true }).waitFor();
  await add.click();
  await until('the first conversation to be stored', async () => (await listed()).length === 1);
  await addConversationInDialog(settings, conversationUrl(B));
  expect(await settings.getByRole('radio', { name: `Preferred: ChatGPT conversation ${A.slice(0, 8)}` }).isChecked()).toBe(true);

  // The same conversation twice is refused by the core in its own words, beside the field.
  await field.fill(conversationUrl(B));
  await add.click();
  await settings.getByText(`This conversation is already in the project as "ChatGPT conversation ${B.slice(0, 8)}".`).waitFor();
  expect((await listed()).map((c) => c.url)).toEqual([conversationUrl(A), conversationUrl(B)]);
  await field.fill('');

  // Choosing the second one as the preferred conversation reaches the core at once: there is no Save to press.
  await settings.getByRole('radio', { name: `Preferred: ChatGPT conversation ${B.slice(0, 8)}` }).check();
  const conversations = await listed();
  await until('the core to prefer the second conversation', async () => (await h.api.call('projects.get', { params: { id: project.id } })).preferredConversationId === conversations[1].id);
  expect(conversations.every((c) => c.verification === 'unverified')).toBe(true); // nothing is claimed that was not checked

  // Rename one (on leaving the field) and remove the other; the core follows each, with the dialog still open.
  await settings.getByRole('textbox', { name: `Title of ChatGPT conversation ${B.slice(0, 8)}` }).fill('Release plan');
  await settings.getByRole('textbox', { name: `Title of ChatGPT conversation ${B.slice(0, 8)}` }).press('Enter');
  await until('the core to hold the new title', async () => (await listed()).some((c) => c.title === 'Release plan'));
  await settings.getByRole('button', { name: `Remove ChatGPT conversation ${A.slice(0, 8)}` }).click();
  await until('the core to hold the edited conversations', async () => {
    const list = await listed();
    return list.length === 1 && list[0].title === 'Release plan' && list[0].url === conversationUrl(B);
  });
  const after = await h.api.call('projects.get', { params: { id: project.id } });
  expect(after.preferredConversationId).toBe(conversations[1].id);

  // Closing keeps all of it: a title typed and never confirmed is sent by Done.
  await settings.getByRole('textbox', { name: 'Title of Release plan' }).fill('Release plan v2');
  await closeSettings(settings);
  await until('Done to have sent the title', async () => (await listed())[0]?.title === 'Release plan v2');
  evidence('A04', `refused example.org, http and javascript: addresses with a reason; accepted a messy pasted address as ${conversationUrl(A)}; refused the same conversation twice in the core's words; two conversations stored in order, preferred chosen in the settings (stored: ${after.preferredConversationId === conversations[1].id ? 'the second' : 'WRONG'}) with no Save; rename, removal and a title typed and left unconfirmed (sent by Done) each reached the core`);
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
  expect(await edit.getByRole('radio').count()).toBe(2);
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
