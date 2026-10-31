// X07: a folder chosen for a project that has none is saved, shown, and still there after a restart.
//
// The report that led to this check: a project made from a GitHub repository alone ("CaissaTrainer") was given a folder with
// Browse. Browse only put the path into the "Add a folder" field; the folder joined the project's list through a second button,
// "Add folder". Save compared the project with the form, saw no difference, said "No changes to save" and closed the dialog, so
// the path was thrown away and the header still read "No folder yet". The dialogs no longer have a draft or a Save: a folder chosen
// with Browse reaches the core the moment it is chosen. Here the person does exactly what the report did (Browse, then finish,
// nothing in between) in the real window, with the native picker answered by the test, and then restarts the app.
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { evidence } from '../helpers/evidence.ts';
import { answerFolderPicker, folderPickerCalls } from '../helpers/main-process.ts';
import { makeRepo } from '../helpers/sandbox.ts';
import { scenario } from '../helpers/scenario.ts';
import { startSession } from '../helpers/core.ts';
import {
  addFolderWithPicker, chooseSource, closeSettings, listedFolders, openEditProject, openNewProject, projectHeaderText, projectRow,
} from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

scenario('[X07] A folder picked for a project that has none is saved, shown, and still there after a restart', async () => {
  const h = await launchApp();
  const repo = makeRepo(h.sandbox, 'CaissaTrainer');

  // The project exists as a name and a GitHub repository, with no local folder.
  const create = await openNewProject(h.page);
  await chooseSource(create, 'GitHub repository');
  await create.getByLabel('Repository', { exact: true }).fill('FarmaanFIM/CaissaTrainer');
  await create.getByRole('button', { name: 'Create project' }).click();
  await create.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: 'CaissaTrainer' }).waitFor();
  const before = await h.api.call('projects.list');
  expect(before[0].roots).toEqual([]);
  expect(await projectHeaderText(h.page, 'CaissaTrainer')).not.toContain(repo); // nothing of a folder is shown yet

  // Browse, choose, Done. No other button in between: that is what the person did.
  const edit = await openEditProject(h.page, 'CaissaTrainer');
  await answerFolderPicker(h.app, repo);
  await addFolderWithPicker(edit);
  await until('the picker to have been asked', async () => (await folderPickerCalls(h.app)).length === 1);
  await listedFolders(edit).getByText(repo, { exact: true }).waitFor(); // listed at once
  // The core already has it, before the dialog is closed: nothing is waiting for a Save.
  await until('the core to hold the folder', async () => (await h.api.call('projects.list'))[0].roots.map((r) => r.path).join() === repo);
  await closeSettings(edit);

  expect(await h.page.getByText('No changes to save').count()).toBe(0);
  await until('the header to show the folder', async () => (await projectHeaderText(h.page, 'CaissaTrainer')).includes(repo));
  const saved = await h.api.call('projects.list');
  expect(saved[0].roots.map((r) => r.path)).toEqual([repo]);

  // It survives a restart: same data directory, same profile.
  expect((await h.quit()).code).toBe(0);
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await projectRow(h2.page, 'CaissaTrainer').waitFor();
  const restored = await h2.api.call('projects.list');
  expect(restored[0].roots.map((r) => r.path)).toEqual([repo]);
  await until('the header to show the folder after the restart', async () => (await projectHeaderText(h2.page, 'CaissaTrainer')).includes(repo));

  // And local Claude works in it: a session started in the project runs in the folder the person chose. (It is started through the
  // core: how a session is started from the window is what the terminal scenarios test.)
  const session = await startSession(h2, restored[0].id);
  expect(session.origin).toBe('managed');
  expect(session.cwd).toBe(repo);
  expect((await h2.api.call('sessions.list')).filter((s) => s.origin === 'managed')).toHaveLength(1);

  evidence('X07', `a GitHub-only project had no folder; Browse listed ${repo} at once and the core held it before the dialog was closed; Done then closed with no "No changes to save", the header showed the folder, and after a quit and a start on the same data directory the folder was still there and a local session started in it`);
});
