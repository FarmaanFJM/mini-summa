// X07: a folder chosen for a project that has none is saved, shown, and still there after a restart.
//
// The report that led to this check: a project made from a GitHub repository alone ("CaissaTrainer") was given a folder with
// Browse. Browse only put the path into the "Add a folder" field; the folder joined the project's list through a second button,
// "Add folder". Save compared the project with the form, saw no difference, said "No changes to save" and closed the dialog, so
// the path was thrown away and the header still read "No folder yet". Here the person does exactly what the report did (Browse,
// then Save, nothing in between) in the real window, with the native picker answered by the test, and then restarts the app.
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { evidence } from '../helpers/evidence.ts';
import { answerFolderPicker, folderPickerCalls } from '../helpers/main-process.ts';
import { makeRepo } from '../helpers/sandbox.ts';
import { scenario } from '../helpers/scenario.ts';
import { claudeTabs, openEditProject, openNewProject, projectRow, startSessionInUi } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

scenario('[X07] A folder picked for a project that has none is saved, shown, and still there after a restart', async () => {
  const h = await launchApp();
  const repo = makeRepo(h.sandbox, 'CaissaTrainer');

  // The project exists as a name and a GitHub repository, with no local folder.
  const create = await openNewProject(h.page);
  await create.getByLabel('Name', { exact: true }).fill('CaissaTrainer');
  await create.getByLabel('GitHub repository').fill('FarmaanFIM/CaissaTrainer');
  await create.getByRole('button', { name: 'Create project' }).click();
  await create.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: 'CaissaTrainer' }).waitFor();
  await h.page.getByText(/No folder yet/).first().waitFor();
  const before = await h.api.call('projects.list');
  expect(before[0].roots).toEqual([]);

  // Browse, choose, Save. No "Add folder" press in between: that is what the person did.
  const edit = await openEditProject(h.page, 'CaissaTrainer');
  await answerFolderPicker(h.app, repo);
  await edit.getByRole('button', { name: 'Browse' }).click();
  await until('the picker to have been asked', async () => (await folderPickerCalls(h.app)).length === 1);
  await edit.getByRole('list', { name: 'Repository folders' }).getByText(repo, { exact: true }).waitFor(); // listed at once
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await edit.waitFor({ state: 'detached' });

  expect(await h.page.getByText('No changes to save').count()).toBe(0);
  await until('the header to show the folder', async () => (await h.page.getByText(/No folder yet/).count()) === 0);
  await h.page.getByText(repo, { exact: false }).first().waitFor();
  const saved = await h.api.call('projects.list');
  expect(saved[0].roots.map((r) => r.path)).toEqual([repo]);

  // It survives a restart: same data directory, same profile.
  expect((await h.quit()).code).toBe(0);
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await projectRow(h2.page, 'CaissaTrainer').waitFor();
  const restored = await h2.api.call('projects.list');
  expect(restored[0].roots.map((r) => r.path)).toEqual([repo]);
  expect(await h2.page.getByText(/No folder yet/).count()).toBe(0);
  await h2.page.getByText(repo, { exact: false }).first().waitFor();

  // And local Claude works in it (the folder is the one the person chose).
  await startSessionInUi(h2.page);
  await until('a Claude tab', async () => (await claudeTabs(h2.page).count()) === 1);
  const [session] = await until('one managed session', async () => {
    const list = await h2.api.call('sessions.list');
    return list.length === 1 ? list : null;
  });
  expect(session.origin).toBe('managed');
  expect(session.cwd).toBe(repo);

  evidence('X07', `a GitHub-only project had no folder; Browse then Save (no "Add folder" press) listed ${repo} at once, stored it, replaced "No folder yet" in the header and showed no "No changes to save"; after a quit and a start on the same data directory the folder was still there and a local session started in it`);
});
