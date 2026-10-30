// A project's settings: every change reaches the core at once and is confirmed where it was made. There is no draft and no Save, so
// there is nothing to lose by closing, and these tests are about exactly that: what a person does is what the core ends up holding.
import type { RouteInput } from '@minisumma/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { createFakeNative, renderApp } from './helpers';
import type { RenderedApp } from './helpers';

vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

const PROJECT = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/project';
const OTHER_PROJECT = 'https://chatgpt.com/g/g-p-1234abcd5678ef90-release-notes/project';
const CHAT_IN_PROJECT = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const SINGLE_CHAT = 'https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

async function openSettings(name = 'GitManager', options: Parameters<typeof renderApp>[0] = {}) {
  const user = userEvent.setup();
  const app = await renderApp(options);
  const project = app.runtime.store.getState().projects.find((p) => p.name === name);
  if (!project) throw new Error(`No project ${name}`);
  act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'edit', projectId: project.id }));
  const dialog = await screen.findByRole('dialog', { name: `${name} settings` });
  return { user, app, dialog, id: project.id };
}

/** A project made through the core, the way an earlier session of the app would have left it, and its settings opened. */
async function openMade(body: RouteInput<'projects.create'>['body'], options: Parameters<typeof renderApp>[0] = {}) {
  const user = userEvent.setup();
  const app = await renderApp(options);
  const project = await app.demo.call('projects.create', { body });
  await waitFor(() => expect(app.runtime.store.getState().projects.some((p) => p.id === project.id)).toBe(true));
  act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'edit', projectId: project.id }));
  const dialog = await screen.findByRole('dialog', { name: `${body.name} settings` });
  return { user, app, dialog, id: project.id };
}

const calls = (spy: { mock: { calls: unknown[][] } }, name: string): unknown[] => spy.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
const callNames = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => c[0] as string);
const writes = (spy: { mock: { calls: unknown[][] } }): string[] => callNames(spy).filter((n) => /^(projects|conversations)\.(create|update|add|remove|setPreferred|addRoot|removeRoot)/.test(n));
const paste = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });
const section = (dialog: HTMLElement, title: string): HTMLElement => within(dialog).getByRole('heading', { level: 3, name: title }).closest('section') as HTMLElement;
const pickFolder = (app: RenderedApp) => app.fake.native.dialogs.selectDirectory as ReturnType<typeof vi.fn>;
const project = (app: RenderedApp, id: string) => app.runtime.store.getState().projects.find((p) => p.id === id);
const stored = async (app: RenderedApp, id: string) => app.demo.call('projects.get', { params: { id } });
const done = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Done' });

/** Makes the core refuse one route, in its own words, until `stop()` is called. */
function refuse(app: RenderedApp, route: string, message: string) {
  const original = app.demo.call;
  const state = { refusing: true };
  const spy = vi.spyOn(app.demo, 'call').mockImplementation((async (name: string, ...rest: unknown[]) => {
    if (name === route && state.refusing) throw Object.assign(new Error(message), { code: 'refused', status: 400 });
    return (original as (...a: unknown[]) => unknown)(name, ...rest);
  }) as never);
  return { spy, stop: () => { state.refusing = false; } };
}

describe('the settings of a project', () => {
  it('are named after the project, have one button, and no Save', async () => {
    const { dialog } = await openSettings();
    expect(screen.getByRole('dialog', { name: 'GitManager settings' })).toBe(dialog);
    const buttons = Array.from(dialog.querySelectorAll('.sm-dialog__foot button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Done']);
    expect(buttons[0].className).toContain('sm-btn--primary');
    expect(within(dialog).queryByRole('button', { name: /save|cancel/i })).toBeNull();
  });

  it('are plain headings with their content under them, in the order a person thinks of a project', async () => {
    const { dialog } = await openSettings();
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Name', 'ChatGPT Project', 'GitHub repository', 'Local folders', 'ChatGPT conversations used for reports',
    ]);
    // Nothing inside is a bordered box: rows are filled, headings are not boxed, the only outline is the dialog's own.
    expect(dialog.querySelector('fieldset')).toBeNull();
  });

  it('show what the core knows: name, repository, folder and its environment, conversations and how each was verified', async () => {
    const { dialog } = await openSettings();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('GitManager');
    expect((within(dialog).getByLabelText('GitHub repository') as HTMLInputElement).value).toBe('acme/git-manager');
    const folders = within(dialog).getByRole('list', { name: 'Local folders' });
    expect(within(folders).getByText('C:\\Dev\\GitManager')).toBeTruthy();
    expect(within(folders).getByText('Windows')).toBeTruthy();
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(within(dialog).getByText('Preferred. Verified: Release planning for GitManager')).toBeTruthy();
    expect(within(dialog).getByText('Verified: Code review notes')).toBeTruthy();
  });

  it('say where each environment is for a project with folders in two', async () => {
    const { dialog } = await openSettings('Trading dashboard');
    const folders = within(dialog).getByRole('list', { name: 'Local folders' });
    expect(within(folders).getAllByRole('listitem').map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'C:\\Dev\\dashboardWindows', '/home/dev/dashboard-apiWSL (Ubuntu)',
    ]);
  });

  it('use no em dash anywhere a person can read or hear', async () => {
    const { dialog } = await openMade({ name: 'Caissa', chatgptProject: { url: PROJECT }, githubRepo: 'acme/caissa', roots: [{ path: 'C:\\Dev\\Caissa', env: 'win' }] });
    const words = [dialog.textContent ?? '', ...Array.from(dialog.querySelectorAll('[aria-label], [title], [placeholder]')).flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder')])];
    expect(words.filter((w) => w && w.includes('\u2014'))).toEqual([]);
  });

  it('close when the project is removed while they are open', async () => {
    const { app, dialog, id } = await openSettings('Docs site');
    await act(async () => { await app.demo.call('projects.remove', { params: { id }, query: { mode: 'delete' } }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dialog.isConnected).toBe(false);
  });
});

describe('a project with a repository and no folder', () => {
  it('is complete: its folders say nothing about having none, beyond the way to add one', async () => {
    const { dialog } = await openMade({ name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' });
    const folders = section(dialog, 'Local folders');
    expect(within(folders).queryByRole('list')).toBeNull();
    expect(within(folders).queryByText(/no folder|none|yet|missing|empty|add a folder/i)).toBeNull();
    expect(within(folders).getByLabelText('Folder path')).toBeTruthy();
    expect(within(folders).getByRole('button', { name: 'Add folder' })).toBeTruthy();
    expect((within(dialog).getByLabelText('GitHub repository') as HTMLInputElement).value).toBe('FarmaanFIM/CaissaTrainer');
    expect(dialog.textContent ?? '').not.toMatch(/no folder|without a folder|has no folder/i);
  });

  it('is created from the New project dialog with no folder and its settings open complete', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'create' }));
    const create = await screen.findByRole('dialog', { name: 'New project' });
    await user.click(within(create).getByRole('tab', { name: 'GitHub repository' }));
    paste(within(create).getByLabelText('Repository'), 'FarmaanFIM/CaissaTrainer');
    await user.click(within(create).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const made = app.runtime.store.getState().projects.find((p) => p.name === 'CaissaTrainer');
    expect(made).toMatchObject({ githubRepo: 'FarmaanFIM/CaissaTrainer', roots: [], chatgptProject: null });
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'edit', projectId: made!.id }));
    const dialog = await screen.findByRole('dialog', { name: 'CaissaTrainer settings' });
    expect(within(section(dialog, 'Local folders')).queryByRole('list')).toBeNull();
    expect(dialog.textContent ?? '').not.toMatch(/no folder/i);
  });
});

describe('the name', () => {
  it('is saved with Enter, confirmed in place with a quiet "Saved" that goes away by itself, and the title follows', async () => {
    const { user, app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Git Manager{Enter}');
    expect(await within(section(dialog, 'Name')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { name: 'Git Manager' } }]);
    expect(project(app, id)?.name).toBe('Git Manager');
    expect(await screen.findByRole('dialog', { name: 'Git Manager settings' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: /./ })).toBeNull(); // not a toast: nothing outside the dialog said it
    expect(document.querySelector('.sm-toast')).toBeNull();
    // It is not a tag: plain text in a status region.
    expect(within(section(dialog, 'Name')).getByText('Saved').className).not.toMatch(/tag/);
    await waitFor(() => expect(within(section(dialog, 'Name')).queryByText('Saved')).toBeNull(), { timeout: 4000 });
  });

  it('is saved when the person leaves the field, and says so only in its own section', async () => {
    const { user, app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.tab();
    expect(await within(section(dialog, 'Name')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { name: 'Renamed' } }]);
    expect(within(section(dialog, 'GitHub repository')).queryByText('Saved')).toBeNull();
  });

  it('is sent once when Enter is pressed and the field is left straight after', async () => {
    const { user, app, dialog } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Once{Enter}');
    await user.tab();
    await within(section(dialog, 'Name')).findByText('Saved');
    expect(calls(spy, 'projects.update')).toHaveLength(1);
  });

  it('sends nothing, and says nothing, when it was not changed', async () => {
    const { user, app, dialog } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const name = within(dialog).getByLabelText('Name');
    await user.click(name);
    await user.keyboard('{Enter}');
    await user.tab();
    expect(writes(spy)).toEqual([]);
    expect(within(section(dialog, 'Name')).queryByText('Saved')).toBeNull();
  });

  it('is trimmed, and the field shows what was saved', async () => {
    const { user, app, dialog, id } = await openSettings();
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, '   Padded   {Enter}');
    await within(section(dialog, 'Name')).findByText('Saved');
    expect(project(app, id)?.name).toBe('Padded');
    expect(name.value).toBe('Padded');
  });

  it('is required: an empty name says so beside the field and is not sent; Escape takes it back', async () => {
    const { user, app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    await user.clear(name);
    expect(within(dialog).queryByRole('alert')).toBeNull(); // not while the person is still typing
    await user.keyboard('{Enter}');
    expect(within(section(dialog, 'Name')).getByRole('alert').textContent).toBe('Give the project a name.');
    expect(writes(spy)).toEqual([]);
    expect(project(app, id)?.name).toBe('GitManager');
    await user.keyboard('{Escape}');
    expect(name.value).toBe('GitManager'); // taken back
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'GitManager settings' })).toBeTruthy(); // the dialog stayed
  });

  it('shows the core\'s refusal in words beside the field, keeps what was typed, and is not "Saved"', async () => {
    const { user, app, dialog, id } = await openSettings();
    const { stop } = refuse(app, 'projects.update', 'The project name is already in use.');
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Taken{Enter}');
    const alert = await within(section(dialog, 'Name')).findByRole('alert');
    expect(alert.textContent).toBe('The project name is already in use.');
    expect(name.value).toBe('Taken');
    expect(within(section(dialog, 'Name')).queryByText('Saved')).toBeNull();
    expect(project(app, id)?.name).toBe('GitManager');
    // Pressing Enter again once the core agrees clears the message and saves.
    stop();
    await user.keyboard('{Enter}');
    expect(await within(section(dialog, 'Name')).findByText('Saved')).toBeTruthy();
    expect(within(section(dialog, 'Name')).queryByRole('alert')).toBeNull();
    expect(project(app, id)?.name).toBe('Taken');
  });
});

describe('the GitHub repository', () => {
  it('is set with Enter and saved as owner/repo, however it was pasted, and says what it will save while it is typed', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    const spy = vi.spyOn(app.demo, 'call');
    const field = within(dialog).getByLabelText('GitHub repository') as HTMLInputElement;
    expect(within(dialog).queryByRole('button', { name: 'Open on GitHub' })).toBeNull(); // nothing to open yet
    await user.click(field);
    await user.paste('https://github.com/acme/billing.git');
    expect(within(dialog).getByText('Will be saved as acme/billing.')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(await within(section(dialog, 'GitHub repository')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { githubRepo: 'acme/billing' } }]);
    expect(field.value).toBe('acme/billing');
    expect(within(dialog).queryByText(/Will be saved as/)).toBeNull();
    expect((await stored(app, id)).githubRepo).toBe('acme/billing');
  });

  it('says what is wrong as it is typed, and sends nothing on Enter or on leaving', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    const spy = vi.spyOn(app.demo, 'call');
    const field = within(dialog).getByLabelText('GitHub repository');
    await user.type(field, 'not a repo');
    expect(within(section(dialog, 'GitHub repository')).getByRole('alert').textContent).toBe('Use the form owner/repo, for example acme/git-manager.');
    await user.keyboard('{Enter}');
    await user.tab();
    expect(writes(spy)).toEqual([]);
    expect((await stored(app, id)).githubRepo).toBeNull();
  });

  it('is removed by clearing the field', async () => {
    const { user, app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const field = within(dialog).getByLabelText('GitHub repository') as HTMLInputElement;
    await user.clear(field);
    await user.keyboard('{Enter}');
    expect(await within(section(dialog, 'GitHub repository')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { githubRepo: null } }]);
    expect(project(app, id)?.githubRepo).toBeNull();
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Open on GitHub' })).toBeNull());
  });

  it('opens on GitHub in the person\'s browser', async () => {
    const { user, app, dialog } = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Open on GitHub' }));
    expect(app.fake.native.shell.openExternal).toHaveBeenCalledWith('https://github.com/acme/git-manager');
  });

  it('says beside the field when the browser could not be opened', async () => {
    const { user, app, dialog } = await openSettings();
    (app.fake.native.shell.openExternal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Only web addresses can be opened.'));
    await user.click(within(dialog).getByRole('button', { name: 'Open on GitHub' }));
    expect((await within(section(dialog, 'GitHub repository')).findByRole('alert')).textContent).toBe('Could not open GitHub. Only web addresses can be opened.');
  });

  it('shows the core\'s refusal and keeps what was typed', async () => {
    const { user, app, dialog } = await openSettings();
    refuse(app, 'projects.update', 'The GitHub repository must look like owner/repo. Fix it and save again.');
    const field = within(dialog).getByLabelText('GitHub repository') as HTMLInputElement;
    await user.clear(field);
    await user.type(field, 'acme/other{Enter}');
    expect((await within(section(dialog, 'GitHub repository')).findByRole('alert')).textContent).toBe('The GitHub repository must look like owner/repo. Fix it and save again.');
    expect(field.value).toBe('acme/other');
  });
});

describe('the ChatGPT Project', () => {
  const ADDRESS = 'Address of an existing ChatGPT Project';

  it('is linked with one field and a Link button, and says only the address is saved', async () => {
    const { user, app, dialog, id } = await openSettings('Docs site');
    const spy = vi.spyOn(app.demo, 'call');
    const block = section(dialog, 'ChatGPT Project');
    expect(within(block).getByText('Only the address is saved. Nothing in the project is imported or synced.')).toBeTruthy();
    expect((within(block).getByRole('button', { name: 'Link' }) as HTMLButtonElement).disabled).toBe(true);
    paste(within(block).getByLabelText(ADDRESS), PROJECT);
    expect(within(block).getByText('Title: Caissa trainer')).toBeTruthy();
    await user.click(within(block).getByRole('button', { name: 'Link' }));
    expect(await within(section(dialog, 'ChatGPT Project')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { chatgptProject: { url: PROJECT } } }]);
    expect(project(app, id)?.chatgptProject).toEqual({ url: PROJECT, scopeId: 'g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer', title: 'Caissa trainer' });

    // Now it is linked: its title, its address, and what can be done with it.
    const linked = section(dialog, 'ChatGPT Project');
    expect((within(linked).getByLabelText('Title of the ChatGPT Project') as HTMLInputElement).value).toBe('Caissa trainer');
    expect(within(linked).getByText(PROJECT)).toBeTruthy();
    expect(within(linked).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open', 'Change', 'Unlink']);
    expect(within(linked).queryByLabelText(ADDRESS)).toBeNull();
  });

  it('is linked with Enter too', async () => {
    const { user, app, dialog, id } = await openSettings('Docs site');
    await user.click(within(dialog).getByLabelText(ADDRESS));
    await user.paste(PROJECT);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(project(app, id)?.chatgptProject?.url).toBe(PROJECT));
  });

  it('refuses a single conversation with the reason beside the field, and sends nothing', async () => {
    const { user, app, dialog } = await openSettings('Docs site');
    const spy = vi.spyOn(app.demo, 'call');
    const block = section(dialog, 'ChatGPT Project');
    paste(within(block).getByLabelText(ADDRESS), SINGLE_CHAT);
    expect(within(block).getByRole('alert').textContent).toBe('That is a single conversation outside any project. Open the project in ChatGPT and copy the address of its project page.');
    expect((within(block).getByRole('button', { name: 'Link' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(block).getByLabelText(ADDRESS), '{Enter}');
    expect(writes(spy)).toEqual([]);
  });

  it('accepts an address it does not recognise, says it will be opened as pasted, and keeps it as pasted', async () => {
    const { user, app, dialog, id } = await openSettings('Docs site');
    const block = section(dialog, 'ChatGPT Project');
    paste(within(block).getByLabelText(ADDRESS), 'https://chatgpt.com/library?tab=1');
    expect(within(block).getByText('Mini-Summa does not recognise this form of address. It will be opened as pasted.')).toBeTruthy();
    await user.click(within(block).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(project(app, id)?.chatgptProject).toEqual({ url: 'https://chatgpt.com/library', scopeId: null, title: 'ChatGPT Project' }));
  });

  it('links the project page when a conversation inside the project was pasted', async () => {
    const { user, app, dialog, id } = await openSettings('Docs site');
    const block = section(dialog, 'ChatGPT Project');
    paste(within(block).getByLabelText(ADDRESS), CHAT_IN_PROJECT);
    expect(within(block).getByText(/This is a conversation inside the project, so the project page is linked\./)).toBeTruthy();
    await user.click(within(block).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(project(app, id)?.chatgptProject?.url).toBe(PROJECT));
  });

  it('shows the core\'s refusal of an address beside the field and keeps what was pasted', async () => {
    const { user, app, dialog } = await openSettings('Docs site');
    refuse(app, 'projects.update', 'The ChatGPT Project needs an address. Paste the address of the project from ChatGPT.');
    const block = section(dialog, 'ChatGPT Project');
    paste(within(block).getByLabelText(ADDRESS), PROJECT);
    await user.click(within(block).getByRole('button', { name: 'Link' }));
    expect((await within(block).findByRole('alert')).textContent).toBe('The ChatGPT Project needs an address. Paste the address of the project from ChatGPT.');
    expect((within(block).getByLabelText(ADDRESS) as HTMLInputElement).value).toBe(PROJECT);
  });

  describe('once linked', () => {
    const linkedProject = () => openMade({ name: 'Caissa', chatgptProject: { url: PROJECT } });

    it('keeps its title editable: Enter saves it with the same address, and an empty title is the one the address gives', async () => {
      const { user, app, dialog, id } = await linkedProject();
      const spy = vi.spyOn(app.demo, 'call');
      const title = within(dialog).getByLabelText('Title of the ChatGPT Project') as HTMLInputElement;
      await user.clear(title);
      await user.type(title, 'Chess coach{Enter}');
      expect(await within(section(dialog, 'ChatGPT Project')).findByText('Saved')).toBeTruthy();
      expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { chatgptProject: { url: PROJECT, title: 'Chess coach' } } }]);
      expect(project(app, id)?.chatgptProject).toMatchObject({ url: PROJECT, title: 'Chess coach' });

      await user.clear(title);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(project(app, id)?.chatgptProject?.title).toBe('Caissa trainer'));
      await waitFor(() => expect(title.value).toBe('Caissa trainer'));
    });

    it('is changed to another address in place, and the title the person typed is kept', async () => {
      const { user, app, dialog, id } = await linkedProject();
      const title = within(dialog).getByLabelText('Title of the ChatGPT Project');
      await user.clear(title);
      await user.type(title, 'Chess coach{Enter}');
      await within(section(dialog, 'ChatGPT Project')).findByText('Saved');
      const spy = vi.spyOn(app.demo, 'call');
      await user.click(within(dialog).getByRole('button', { name: 'Change' }));
      const address = within(dialog).getByLabelText('Address of the ChatGPT Project') as HTMLInputElement;
      expect(address.value).toBe(PROJECT);
      expect(document.activeElement).toBe(address);
      expect(within(dialog).queryByRole('button', { name: 'Change' })).toBeNull(); // the field is the change
      await user.keyboard(OTHER_PROJECT);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(project(app, id)?.chatgptProject?.url).toBe(OTHER_PROJECT));
      expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { chatgptProject: { url: OTHER_PROJECT, title: 'Chess coach' } } }]);
      expect(project(app, id)?.chatgptProject?.title).toBe('Chess coach');
      expect(within(dialog).queryByLabelText('Address of the ChatGPT Project')).toBeNull(); // back to showing it
      expect(within(dialog).getByText(OTHER_PROJECT)).toBeTruthy();
    });

    it('takes the new title from a new address when the old title was the address\'s own', async () => {
      const { user, app, dialog, id } = await linkedProject();
      const spy = vi.spyOn(app.demo, 'call');
      await user.click(within(dialog).getByRole('button', { name: 'Change' }));
      await user.keyboard(OTHER_PROJECT);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(project(app, id)?.chatgptProject?.url).toBe(OTHER_PROJECT));
      expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { chatgptProject: { url: OTHER_PROJECT } } }]);
      expect(project(app, id)?.chatgptProject?.title).toBe('Release notes');
    });

    it('refuses a change to something that is not a ChatGPT Project, beside the field, and keeps the link', async () => {
      const { user, app, dialog, id } = await linkedProject();
      const spy = vi.spyOn(app.demo, 'call');
      await user.click(within(dialog).getByRole('button', { name: 'Change' }));
      await user.keyboard(SINGLE_CHAT);
      expect(within(section(dialog, 'ChatGPT Project')).getByRole('alert').textContent).toContain('That is a single conversation outside any project.');
      await user.keyboard('{Enter}');
      await user.tab();
      expect(writes(spy)).toEqual([]);
      expect(project(app, id)?.chatgptProject?.url).toBe(PROJECT);
    });

    it('is unlinked at once, with Unlink, and can be linked again', async () => {
      const { user, app, dialog, id } = await linkedProject();
      const spy = vi.spyOn(app.demo, 'call');
      await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
      await waitFor(() => expect(project(app, id)?.chatgptProject).toBeNull());
      expect(calls(spy, 'projects.update')).toEqual([{ params: { id }, body: { chatgptProject: null } }]);
      expect(await within(section(dialog, 'ChatGPT Project')).findByLabelText('Address of an existing ChatGPT Project')).toBeTruthy();
      expect(within(section(dialog, 'ChatGPT Project')).getByText('Saved')).toBeTruthy();
    });

    it('says why when it could not be unlinked, and stays linked', async () => {
      const { user, app, dialog, id } = await linkedProject();
      refuse(app, 'projects.update', 'The core is busy. Try again.');
      await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
      expect((await within(section(dialog, 'ChatGPT Project')).findByRole('alert')).textContent).toBe('The core is busy. Try again.');
      expect(project(app, id)?.chatgptProject?.url).toBe(PROJECT);
    });

    it('opens by selecting the project, closing the dialog and showing the address in the ChatGPT view', async () => {
      const { user, app, dialog, id } = await linkedProject();
      await app.demo.call('settings.update', { body: { layout: { maximized: 'claude' } } });
      await waitFor(() => expect(app.runtime.store.getState().settings?.layout.maximized).toBe('claude'));
      await user.click(within(dialog).getByRole('button', { name: 'Open' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(app.runtime.route.getState()).toMatchObject({ view: 'workspace', projectId: id });
      expect(app.fake.native.chatgpt.navigate).toHaveBeenCalledWith(PROJECT);
      // The pane that shows ChatGPT is not left hidden behind a maximised Claude pane.
      await waitFor(() => expect(app.runtime.store.getState().settings?.layout.maximized).toBeNull());
    });

    it('opens in the browser when ChatGPT is set to open there', async () => {
      const { user, app, dialog, id } = await linkedProject();
      await app.demo.call('settings.update', { body: { chatgpt: { mode: 'external' } } });
      await waitFor(() => expect(app.runtime.store.getState().settings?.chatgpt.mode).toBe('external'));
      await user.click(within(dialog).getByRole('button', { name: 'Open' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(app.fake.native.shell.openExternal).toHaveBeenCalledWith(PROJECT);
      expect(app.fake.native.chatgpt.navigate).not.toHaveBeenCalledWith(PROJECT); // the pane's own loading of a conversation is not this
      expect(app.runtime.route.getState().projectId).toBe(id);
    });

    it('saves what is typed in other fields before it opens', async () => {
      const { user, app, dialog, id } = await linkedProject();
      const name = within(dialog).getByLabelText('Name');
      await user.clear(name);
      await user.type(name, 'Caissa trainer app');
      await user.click(within(dialog).getByRole('button', { name: 'Open' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(project(app, id)?.name).toBe('Caissa trainer app');
    });
  });
});

describe('the local folders', () => {
  const FOLDER = 'Folder path';

  it('adds a typed folder with the button, lists it with its environment, and empties the field', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    const spy = vi.spyOn(app.demo, 'call');
    const field = within(dialog).getByLabelText(FOLDER) as HTMLInputElement;
    await user.type(field, 'C:\\Dev\\Billing\\');
    expect(within(dialog).getByText('C:\\Dev\\Billing')).toBeTruthy(); // the reading: cleaned, with no trailing separator
    await user.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    expect(await within(section(dialog, 'Local folders')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'projects.addRoot')).toEqual([{ params: { id }, body: { path: 'C:\\Dev\\Billing', env: 'win' } }]);
    const list = await within(dialog).findByRole('list', { name: 'Local folders' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['C:\\Dev\\BillingWindows']);
    expect(field.value).toBe('');
    expect((await stored(app, id)).roots.map((r) => r.path)).toEqual(['C:\\Dev\\Billing']);
  });

  it('adds with Enter, keeps several, and removes one on request at once', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    const field = within(dialog).getByLabelText(FOLDER);
    await user.type(field, 'C:\\Dev\\Billing{Enter}');
    await within(dialog).findByRole('list', { name: 'Local folders' });
    await user.type(field, 'D:\\Other{Enter}');
    await waitFor(() => expect(within(within(dialog).getByRole('list', { name: 'Local folders' })).getAllByRole('listitem')).toHaveLength(2));

    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Remove folder D:\\Other' }));
    await waitFor(() => expect(within(within(dialog).getByRole('list', { name: 'Local folders' })).getAllByRole('listitem')).toHaveLength(1));
    expect(calls(spy, 'projects.removeRoot')).toHaveLength(1);
    expect((await stored(app, id)).roots.map((r) => r.path)).toEqual(['C:\\Dev\\Billing']);
    expect(await within(section(dialog, 'Local folders')).findByText('Saved')).toBeTruthy();

    // The last folder can go too: the project is complete without one.
    await user.click(within(dialog).getByRole('button', { name: 'Remove folder C:\\Dev\\Billing' }));
    await waitFor(() => expect(within(dialog).queryByRole('list', { name: 'Local folders' })).toBeNull());
    expect((await stored(app, id)).roots).toEqual([]);
    expect(within(section(dialog, 'Local folders')).queryByText(/no folder|none|yet/i)).toBeNull();
  });

  it('explains a path it cannot read, offers no way to add it, and sends nothing', async () => {
    const { user, app, dialog } = await openMade({ name: 'Billing' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText(FOLDER), 'relative/path');
    expect(within(section(dialog, 'Local folders')).getByRole('alert').textContent).toBe('Enter an absolute path (for example C:\\Dev\\App or /home/me/app).');
    expect((within(dialog).getByRole('button', { name: 'Add folder' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(writes(spy)).toEqual([]);
  });

  it('reads a WSL share as a path inside that distribution', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    paste(within(dialog).getByLabelText(FOLDER), '\\\\wsl$\\Ubuntu\\home\\me\\app');
    expect(within(dialog).getByText('Read as a path inside WSL (Ubuntu).')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    await waitFor(async () => expect((await stored(app, id)).roots).toMatchObject([{ path: '/home/me/app', env: 'wsl:Ubuntu' }]));
  });

  it('asks which WSL distribution a Linux path is in, and adds it to that one once answered', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    await user.type(within(dialog).getByLabelText(FOLDER), '/home/me/billing');
    expect(within(dialog).getByText('This looks like a Linux path. Choose which WSL distribution it belongs to.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Add folder' }) as HTMLButtonElement).disabled).toBe(true); // not until it is answered
    await user.click(await within(dialog).findByRole('button', { name: 'WSL distribution' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['WSL (Ubuntu)', 'WSL (Debian)']);
    await user.click(screen.getByRole('option', { name: 'WSL (Debian)' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    await waitFor(async () => expect((await stored(app, id)).roots).toMatchObject([{ path: '/home/me/billing', env: 'wsl:Debian' }]));
    expect(within(dialog).queryByRole('button', { name: 'WSL distribution' })).toBeNull(); // the question is gone with the path
  });

  it('adds the folder chosen with Browse at once: no second button, and the field stays empty', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    pickFolder(app).mockResolvedValueOnce('C:\\Picked\\Folder');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    expect(pickFolder(app)).toHaveBeenCalledWith({ title: 'Choose a folder for this project' });
    const list = await within(dialog).findByRole('list', { name: 'Local folders' });
    expect(within(list).getByText('C:\\Picked\\Folder')).toBeTruthy();
    expect(calls(spy, 'projects.addRoot')).toEqual([{ params: { id }, body: { path: 'C:\\Picked\\Folder', env: 'win' } }]);
    expect((within(dialog).getByLabelText(FOLDER) as HTMLInputElement).value).toBe('');
    expect(await within(section(dialog, 'Local folders')).findByText('Saved')).toBeTruthy();
    expect((await stored(app, id)).roots.map((r) => r.path)).toEqual(['C:\\Picked\\Folder']);
  });

  it('a cancelled picker changes nothing', async () => {
    const { user, app, dialog } = await openMade({ name: 'Billing' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    expect(within(dialog).queryByRole('list', { name: 'Local folders' })).toBeNull();
    expect(writes(spy)).toEqual([]);
  });

  it('keeps a picked path it cannot read in the field, with the question it needs answered', async () => {
    const { user, app, dialog } = await openMade({ name: 'Billing' });
    pickFolder(app).mockResolvedValueOnce('/home/me/app');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect((within(dialog).getByLabelText(FOLDER) as HTMLInputElement).value).toBe('/home/me/app'));
    expect(within(dialog).getByText('This looks like a Linux path. Choose which WSL distribution it belongs to.')).toBeTruthy();
    expect(writes(spy)).toEqual([]);
  });

  it('offers no Browse button where there is no folder picker, and says so beside the field when it cannot be opened', async () => {
    const without = await openMade({ name: 'Plain' }, { native: createFakeNative({ embedded: false }) });
    expect(within(without.dialog).queryByRole('button', { name: 'Browse' })).toBeNull();
    without.app.unmount();

    const { user, app, dialog } = await openMade({ name: 'Broken picker' });
    pickFolder(app).mockRejectedValueOnce(new Error('no dialog'));
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    expect((await within(section(dialog, 'Local folders')).findByRole('alert')).textContent).toBe('The folder picker could not be opened. Type the path instead.');
  });

  it('refuses a folder that is already in the project, in the core\'s words, with the path in the field', async () => {
    const { user, app, dialog } = await openMade({ name: 'Billing', roots: [{ path: 'C:\\Dev\\Billing', env: 'win' }] });
    pickFolder(app).mockResolvedValueOnce('c:\\dev\\billing\\');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    expect((await within(section(dialog, 'Local folders')).findByRole('alert')).textContent).toBe('This folder is already a root of this project. Choose a different folder.');
    expect((within(dialog).getByLabelText(FOLDER) as HTMLInputElement).value).toBe('c:\\dev\\billing\\');
    expect(within(within(dialog).getByRole('list', { name: 'Local folders' })).getAllByRole('listitem')).toHaveLength(1);

    // The same by typing it.
    await user.clear(within(dialog).getByLabelText(FOLDER));
    await user.type(within(dialog).getByLabelText(FOLDER), 'C:\\Dev\\Billing{Enter}');
    expect((await within(section(dialog, 'Local folders')).findByRole('alert')).textContent).toBe('This folder is already a root of this project. Choose a different folder.');
  });

  it('refuses a folder that belongs to another project, naming it, and keeps what was typed', async () => {
    const { user, dialog } = await openMade({ name: 'Billing' });
    const field = within(dialog).getByLabelText(FOLDER) as HTMLInputElement;
    await user.type(field, 'C:\\Dev\\GitManager{Enter}');
    expect((await within(section(dialog, 'Local folders')).findByRole('alert')).textContent).toBe(
      'This folder already belongs to the project "GitManager". A folder can belong to one project only, so remove it there first or choose a different folder.',
    );
    expect(field.value).toBe('C:\\Dev\\GitManager');
    expect(within(section(dialog, 'Local folders')).queryByText('Saved')).toBeNull();
    expect(within(dialog).queryByRole('list', { name: 'Local folders' })).toBeNull();
  });

  it('refuses a folder that does not exist and a file, as the core words it', async () => {
    const { user, app, dialog } = await openMade({ name: 'Billing' });
    app.demo.demo.server.folderCheck = (_env, path) => {
      if (path.endsWith('Nowhere')) return { code: 'root_not_found', message: `This folder does not exist: ${path}. Check the spelling, or choose it with Browse.` };
      if (path.endsWith('notes.txt')) return { code: 'root_not_directory', message: `That is a file, not a folder: ${path}. Choose the folder that contains it.` };
      return null;
    };
    const field = within(dialog).getByLabelText(FOLDER);
    await user.type(field, 'C:\\Dev\\Nowhere{Enter}');
    expect((await within(section(dialog, 'Local folders')).findByRole('alert')).textContent).toBe('This folder does not exist: C:\\Dev\\Nowhere. Check the spelling, or choose it with Browse.');
    await user.clear(field);
    await user.type(field, 'C:\\Dev\\notes.txt{Enter}');
    await waitFor(() => expect(within(section(dialog, 'Local folders')).getByRole('alert').textContent).toBe('That is a file, not a folder: C:\\Dev\\notes.txt. Choose the folder that contains it.'));
  });

  it('says why a folder could not be removed, and keeps it listed', async () => {
    const { user, app, dialog } = await openSettings();
    refuse(app, 'projects.removeRoot', 'That folder is not a root of this project. Reload the project and try again.');
    await user.click(within(dialog).getByRole('button', { name: 'Remove folder C:\\Dev\\GitManager' }));
    expect((await within(section(dialog, 'Local folders')).findByRole('alert')).textContent).toBe('That folder is not a root of this project. Reload the project and try again.');
    expect(within(within(dialog).getByRole('list', { name: 'Local folders' })).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('the conversations', () => {
  it('adds a conversation by its address, with its kind read back as it is typed, and the first one is preferred', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Billing' });
    const spy = vi.spyOn(app.demo, 'call');
    const field = within(dialog).getByLabelText('Conversation address');
    expect((within(dialog).getByRole('button', { name: 'Add conversation' }) as HTMLButtonElement).disabled).toBe(true);
    paste(field, `https://chatgpt.com/c/${UUID1.toUpperCase()}?model=x#frag`);
    expect(within(dialog).getByText('Conversation')).toBeTruthy();
    expect(within(dialog).getByText(`https://chatgpt.com/c/${UUID1}`)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Add conversation' }));
    expect(await within(section(dialog, 'ChatGPT conversations used for reports')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'conversations.add')).toEqual([{ params: { id }, body: { url: `https://chatgpt.com/c/${UUID1.toUpperCase()}?model=x#frag` } }]);
    const radios = await within(dialog).findAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByText('Preferred. Not verified yet')).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('');
    expect(app.runtime.store.getState().conversations.filter((c) => c.projectId === id).map((c) => c.url)).toEqual([`https://chatgpt.com/c/${UUID1}`]);
  });

  it('adds with Enter, and a second one is not preferred unless it is chosen', async () => {
    const { user, dialog } = await openMade({ name: 'Billing' });
    const field = within(dialog).getByLabelText('Conversation address');
    await user.type(field, `chatgpt.com/c/${UUID1}{Enter}`);
    await within(dialog).findAllByRole('radio');
    await user.type(field, `chatgpt.com/c/${UUID2}{Enter}`);
    await waitFor(() => expect(within(dialog).getAllByRole('radio')).toHaveLength(2));
    expect((within(dialog).getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([true, false]);
  });

  it('warns in plain words about a project page, and refuses what is not ChatGPT, with the reason', async () => {
    const { dialog } = await openMade({ name: 'Billing' });
    const field = within(dialog).getByLabelText('Conversation address');
    paste(field, 'https://chatgpt.com/g/g-p-abc123/project');
    expect(within(dialog).getByText('This is a project page, not one conversation. Handoffs will open the project page.')).toBeTruthy();
    paste(field, 'https://example.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
    expect(within(section(dialog, 'ChatGPT conversations used for reports')).getByRole('alert').textContent).toBe('Only chatgpt.com conversation addresses are accepted.');
    paste(field, 'javascript:alert(1)');
    expect(within(section(dialog, 'ChatGPT conversations used for reports')).getByRole('alert').textContent).toBe('Only https addresses are accepted.');
    expect((within(dialog).getByRole('button', { name: 'Add conversation' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses the same conversation twice in the core\'s words, and keeps what was typed', async () => {
    const { user, dialog } = await openMade({ name: 'Billing' });
    const field = within(dialog).getByLabelText('Conversation address') as HTMLInputElement;
    await user.type(field, `chatgpt.com/c/${UUID1}{Enter}`);
    await within(dialog).findAllByRole('radio');
    await user.type(field, `https://chatgpt.com/c/${UUID1.toUpperCase()}{Enter}`);
    expect((await within(section(dialog, 'ChatGPT conversations used for reports')).findByRole('alert')).textContent).toBe(
      `This conversation is already in the project as "ChatGPT conversation 11111111". Use that one, or remove it first.`,
    );
    expect(field.value).toBe(`https://chatgpt.com/c/${UUID1.toUpperCase()}`);
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1);
  });

  it('edits a title in place, saved when the field is left, and an empty title is the one the address gives', async () => {
    const { user, app, dialog } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const title = within(dialog).getByRole('textbox', { name: 'Title of Code review notes' }) as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'Design review');
    await user.tab();
    expect(await within(section(dialog, 'ChatGPT conversations used for reports')).findByText('Saved')).toBeTruthy();
    expect(calls(spy, 'conversations.update')).toEqual([{ params: { id: IDS.c.gmReview }, body: { title: 'Design review' } }]);
    expect(app.runtime.store.getState().conversations.find((c) => c.id === IDS.c.gmReview)?.title).toBe('Design review');
    expect(within(dialog).getByRole('textbox', { name: 'Title of Design review' })).toBeTruthy();

    const renamed = within(dialog).getByRole('textbox', { name: 'Title of Design review' }) as HTMLInputElement;
    await user.clear(renamed);
    await user.tab();
    await waitFor(() => expect(app.runtime.store.getState().conversations.find((c) => c.id === IDS.c.gmReview)?.title).toBe('ChatGPT conversation 0b9c8d7e'));
    await waitFor(() => expect(renamed.value).toBe('ChatGPT conversation 0b9c8d7e'));
  });

  it('keeps a typed title and says why when the core refuses it', async () => {
    const { user, app, dialog } = await openSettings();
    refuse(app, 'conversations.update', 'The conversation title is too long.');
    const title = within(dialog).getByRole('textbox', { name: 'Title of Code review notes' }) as HTMLInputElement;
    await user.clear(title);
    await user.type(title, 'Nope{Enter}');
    expect((await within(section(dialog, 'ChatGPT conversations used for reports')).findByRole('alert')).textContent).toBe('The conversation title is too long.');
    expect(title.value).toBe('Nope');
  });

  it('has exactly one preferred conversation, and choosing another moves it at once', async () => {
    const { user, app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const radios = () => within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
    await user.click(within(dialog).getByRole('radio', { name: 'Preferred: Code review notes' }));
    expect(radios().map((r) => r.checked)).toEqual([false, true]); // answered at once, not after the core
    expect(calls(spy, 'conversations.setPreferred')).toEqual([{ params: { id }, body: { conversationId: IDS.c.gmReview } }]);
    await waitFor(() => expect(project(app, id)?.preferredConversationId).toBe(IDS.c.gmReview));
    expect(within(dialog).getAllByText(/^Preferred\./)).toHaveLength(1);
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
    expect(await within(section(dialog, 'ChatGPT conversations used for reports')).findByText('Saved')).toBeTruthy();
  });

  it('puts the radio back and says why when the core refuses the choice', async () => {
    const { user, app, dialog } = await openSettings();
    refuse(app, 'conversations.setPreferred', 'That conversation belongs to another project.');
    await user.click(within(dialog).getByRole('radio', { name: 'Preferred: Code review notes' }));
    expect((await within(section(dialog, 'ChatGPT conversations used for reports')).findByRole('alert')).textContent).toBe('That conversation belongs to another project.');
    await waitFor(() => expect((within(dialog).getAllByRole('radio') as HTMLInputElement[]).map((r) => r.checked)).toEqual([true, false]));
  });

  it('removes a conversation at once, and removing the preferred one leaves none preferred: the core chooses nothing for the person', async () => {
    const { user, app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Remove Release planning' }));
    await waitFor(() => expect(within(dialog).getAllByRole('radio')).toHaveLength(1));
    expect(calls(spy, 'conversations.remove')).toEqual([{ params: { id: IDS.c.gmRelease } }]);
    expect(project(app, id)?.preferredConversationId).toBeNull();
    expect(app.runtime.store.getState().conversations.filter((c) => c.projectId === id)).toHaveLength(1);
    expect(await within(section(dialog, 'ChatGPT conversations used for reports')).findByText('Saved')).toBeTruthy();
  });

  it('says what happens to a report when several conversations remain and none is preferred', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'Three', roots: [] });
    for (const uuid of [UUID1, UUID2, '33333333-3333-4333-8333-333333333333']) {
      await app.demo.call('conversations.add', { params: { id }, body: { url: `https://chatgpt.com/c/${uuid}` } });
    }
    await waitFor(() => expect(within(dialog).getAllByRole('radio')).toHaveLength(3));
    expect(within(dialog).queryByText('No conversation is preferred. A report will ask where to go.')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /^Remove ChatGPT conversation 11111111/ }));
    await waitFor(() => expect(within(dialog).getAllByRole('radio')).toHaveLength(2));
    expect(await within(dialog).findByText('No conversation is preferred. A report will ask where to go.')).toBeTruthy();
    await user.click(within(dialog).getAllByRole('radio')[0]);
    await waitFor(() => expect(within(dialog).queryByText('No conversation is preferred. A report will ask where to go.')).toBeNull());
  });

  it('verifies a conversation and shows the new state in place', async () => {
    const { user, app, dialog } = await openSettings('Atlas API');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Verify Atlas API design' }));
    await waitFor(() => expect(within(dialog).getByText('Preferred. Verified: Atlas API design')).toBeTruthy());
    expect(calls(spy, 'conversations.verify')).toEqual([{ params: { id: IDS.c.atlasMain } }]);
  });

  it('says each verification state in plain words', async () => {
    const atlas = await openSettings('Atlas API');
    expect(within(atlas.dialog).getByText('Preferred. Not verified yet')).toBeTruthy();
    atlas.app.unmount();
    const trading = await openSettings('Trading dashboard');
    expect(within(trading.dialog).getByText('Sign in to ChatGPT, then verify again')).toBeTruthy();
  });

  it('opens a conversation through the core', async () => {
    const { user, app, dialog } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Open Release planning' }));
    await waitFor(() => expect(calls(spy, 'conversations.open')).toEqual([{ params: { id: IDS.c.gmRelease } }]));
    expect(app.fake.native.chatgpt.navigate).toHaveBeenCalledWith(expect.stringContaining('/c/6f1a2b3c'));
  });

  it('opens in the browser when the host could not show it, and says so in the row', async () => {
    const { user, app, dialog } = await openSettings();
    const original = app.demo.call;
    vi.spyOn(app.demo, 'call').mockImplementation((async (name: string, ...rest: unknown[]) => (
      name === 'conversations.open' ? { ok: true, mode: 'external', opened: false, focused: false, verified: null, finalUrl: null, title: null, note: 'ChatGPT is set to open in your browser.' } : (original as (...a: unknown[]) => unknown)(name, ...rest)
    )) as never);
    await user.click(within(dialog).getByRole('button', { name: 'Open Release planning' }));
    expect(await within(dialog).findByText('Opened in your browser. ChatGPT is set to open in your browser.')).toBeTruthy();
    expect(app.fake.native.shell.openExternal).toHaveBeenCalledWith(expect.stringContaining('/c/6f1a2b3c'));
  });

  it('says in the row when a conversation could not be opened', async () => {
    const { user, app, dialog } = await openSettings();
    refuse(app, 'conversations.open', 'The ChatGPT view is not available.');
    await user.click(within(dialog).getByRole('button', { name: 'Open Release planning' }));
    expect(await within(dialog).findByText('Could not open the conversation. The ChatGPT view is not available.')).toBeTruthy();
  });
});

describe('closing', () => {
  it('with nothing changed closes at once and sends nothing: there is no "No changes to save"', async () => {
    const { user, app, dialog } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(done(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(spy)).toEqual([]);
    expect(screen.queryByText('No changes to save')).toBeNull();
    expect(document.querySelector('.sm-toast')).toBeNull();
  });

  it('with Done sends what is typed, even when the field was never left and Enter was never pressed', async () => {
    const { app, dialog, id } = await openSettings();
    paste(within(dialog).getByLabelText('Name'), 'Typed, never confirmed');
    fireEvent.click(done(dialog)); // no focus moves: nothing but closing itself can send this
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(project(app, id)?.name).toBe('Typed, never confirmed');
  });

  it('with Escape sends what is typed and closes', async () => {
    const { user, app, dialog, id } = await openSettings();
    paste(within(dialog).getByLabelText('GitHub repository'), 'acme/kept');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(project(app, id)?.githubRepo).toBe('acme/kept');
  });

  it('with a click outside sends what is typed and closes', async () => {
    const { app, dialog, id } = await openSettings();
    paste(within(dialog).getByLabelText('Name'), 'Outside');
    fireEvent.mouseDown(document.querySelector('.sm-backdrop') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(project(app, id)?.name).toBe('Outside');
  });

  it('adds a folder that was typed and never added', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' });
    await user.type(within(dialog).getByLabelText('Folder path'), 'D:\\Work\\Caissa');
    await user.click(done(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await stored(app, id)).roots.map((r) => r.path)).toEqual(['D:\\Work\\Caissa']);
  });

  it('adds a conversation and links a ChatGPT Project that were pasted and never confirmed', async () => {
    const { app, dialog, id } = await openMade({ name: 'Pasted' });
    paste(within(dialog).getByLabelText('Conversation address'), `https://chatgpt.com/c/${UUID1}`);
    paste(within(dialog).getByLabelText('Address of an existing ChatGPT Project'), PROJECT);
    fireEvent.click(done(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.runtime.store.getState().conversations.filter((c) => c.projectId === id)).toHaveLength(1);
    expect(project(app, id)?.chatgptProject?.url).toBe(PROJECT);
  });

  it('stays open and says why when what is typed cannot be sent, and Escape then takes it back', async () => {
    const { user, app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    const repo = within(dialog).getByLabelText('GitHub repository') as HTMLInputElement;
    await user.type(repo, 'x');
    await user.clear(repo);
    await user.type(repo, 'not a repo');
    await user.click(done(dialog));
    expect(screen.getByRole('dialog', { name: 'GitManager settings' })).toBeTruthy(); // nothing was lost, nothing was sent
    expect(within(section(dialog, 'GitHub repository')).getByRole('alert').textContent).toBe('Use the form owner/repo, for example acme/git-manager.');
    expect(document.activeElement).toBe(repo);
    expect(writes(spy)).toEqual([]);
    // Escape first takes back what cannot be sent; the next one closes.
    await user.keyboard('{Escape}');
    expect(repo.value).toBe('acme/git-manager');
    expect(screen.getByRole('dialog', { name: 'GitManager settings' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(project(app, id)?.githubRepo).toBe('acme/git-manager');
  });

  it('stays open and keeps a Linux path that was typed and never answered, saying what to do beside the field', async () => {
    const { user, app, dialog } = await openMade({ name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Folder path'), '/home/me/caissa');
    await user.click(done(dialog));
    expect(await within(dialog).findByText('Choose which WSL distribution this folder is in, or clear the folder field.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'CaissaTrainer settings' })).toBeTruthy();
    expect((within(dialog).getByLabelText('Folder path') as HTMLInputElement).value).toBe('/home/me/caissa');
    expect(writes(spy)).toEqual([]);
  });

  it('stays open and shows the core\'s refusal beside the field when a typed folder is refused on the way out', async () => {
    const { user, app, dialog, id } = await openMade({ name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' });
    app.demo.demo.server.folderCheck = (_env, path) => ({ code: 'root_not_found', message: `This folder does not exist: ${path}. Check the spelling, or choose it with Browse.` });
    await user.type(within(dialog).getByLabelText('Folder path'), 'C:\\Dev\\Gone');
    await user.click(done(dialog));
    expect((await within(section(dialog, 'Local folders')).findByRole('alert')).textContent).toBe('This folder does not exist: C:\\Dev\\Gone. Check the spelling, or choose it with Browse.');
    expect(screen.getByRole('dialog', { name: 'CaissaTrainer settings' })).toBeTruthy();
    expect((await stored(app, id)).roots).toEqual([]);
  });

  it('sends several things typed in different fields, once each, and closes when all were accepted', async () => {
    const { app, dialog, id } = await openSettings();
    const spy = vi.spyOn(app.demo, 'call');
    paste(within(dialog).getByLabelText('Name'), 'Everything');
    paste(within(dialog).getByLabelText('GitHub repository'), 'acme/everything');
    paste(within(dialog).getByLabelText('Folder path'), 'D:\\Everything');
    fireEvent.click(done(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.update')).toHaveLength(2);
    expect(calls(spy, 'projects.addRoot')).toHaveLength(1);
    expect(project(app, id)).toMatchObject({ name: 'Everything', githubRepo: 'acme/everything' });
    expect((await stored(app, id)).roots.map((r) => r.path)).toEqual(['C:\\Dev\\GitManager', 'D:\\Everything']);
  });

  it('closes once however many times Done is pressed', async () => {
    const { user, app, dialog } = await openSettings();
    paste(within(dialog).getByLabelText('Name'), 'Pressed twice');
    const spy = vi.spyOn(app.demo, 'call');
    const button = done(dialog);
    await user.click(button);
    await user.click(button).catch(() => {});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.update')).toHaveLength(1);
  });
});

describe('regression: a folder chosen for a project that has none must be stored', () => {
  async function githubOnlyProject() {
    const user = userEvent.setup();
    const app = await renderApp();
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'create' }));
    const create = await screen.findByRole('dialog', { name: 'New project' });
    await user.click(within(create).getByRole('tab', { name: 'GitHub repository' }));
    paste(within(create).getByLabelText('Repository'), 'FarmaanFIM/CaissaTrainer');
    await user.click(within(create).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const made = app.runtime.store.getState().projects.find((p) => p.name === 'CaissaTrainer')!;
    return { user, app, id: made.id };
  }

  const headerOf = (name: string): string => screen.getByRole('heading', { level: 1, name }).parentElement?.textContent ?? '';

  it('Browse, then Done: the folder is stored and the header shows it, and nothing says there were no changes', async () => {
    const { user, app, id } = await githubOnlyProject();
    expect(app.runtime.route.getState().projectId).toBe(id);
    expect(headerOf('CaissaTrainer')).not.toContain('C:\\Dev\\CaissaTrainer'); // where the person started from
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'edit', projectId: id }));
    const dialog = await screen.findByRole('dialog', { name: 'CaissaTrainer settings' });
    pickFolder(app).mockResolvedValueOnce('C:\\Dev\\CaissaTrainer');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    await user.click(done(dialog)); // no "Add folder" in between, as in the report
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callNames(spy)).toContain('projects.addRoot');
    expect(screen.queryByText('No changes to save')).toBeNull();
    expect((await app.demo.call('projects.list')).find((p) => p.name === 'CaissaTrainer')?.roots.map((r) => r.path)).toEqual(['C:\\Dev\\CaissaTrainer']);
    await waitFor(() => expect(headerOf('CaissaTrainer')).toContain('C:\\Dev\\CaissaTrainer'));
  });

  it('Browse, then Done, even before the core has answered: the folder is not left behind', async () => {
    const { user, app, id } = await githubOnlyProject();
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'edit', projectId: id }));
    const dialog = await screen.findByRole('dialog', { name: 'CaissaTrainer settings' });
    pickFolder(app).mockResolvedValueOnce('C:\\Dev\\CaissaTrainer');
    const original = app.demo.call;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(app.demo, 'call').mockImplementation((async (name: string, ...rest: unknown[]) => {
      if (name === 'projects.addRoot') await gate;
      return (original as (...a: unknown[]) => unknown)(name, ...rest);
    }) as never);
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    await user.click(done(dialog));
    expect(screen.getByRole('dialog', { name: 'CaissaTrainer settings' })).toBeTruthy(); // closing waits for the core's answer
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await app.demo.call('projects.list')).find((p) => p.name === 'CaissaTrainer')?.roots.map((r) => r.path)).toEqual(['C:\\Dev\\CaissaTrainer']);
  });

  it('Browse while creating: the project is created with the folder, with no button between', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'create' }));
    const create = await screen.findByRole('dialog', { name: 'New project' });
    await user.click(within(create).getByRole('tab', { name: 'Local folder' }));
    pickFolder(app).mockResolvedValueOnce('C:\\Dev\\CaissaTrainer');
    await user.click(within(create).getByRole('button', { name: 'Browse' }));
    await user.click(within(create).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const made = (await app.demo.call('projects.list')).find((p) => p.name === 'CaissaTrainer');
    expect(made?.roots.map((r) => r.path)).toEqual(['C:\\Dev\\CaissaTrainer']);
    await waitFor(() => expect(headerOf('CaissaTrainer')).toContain('C:\\Dev\\CaissaTrainer'));
  });

  it('a path typed and not added is added by Done instead of being dropped', async () => {
    const { user, app, id } = await githubOnlyProject();
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'edit', projectId: id }));
    const dialog = await screen.findByRole('dialog', { name: 'CaissaTrainer settings' });
    await user.type(within(dialog).getByLabelText('Folder path'), 'D:\\Work\\Caissa');
    await user.click(done(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('No changes to save')).toBeNull();
    expect((await app.demo.call('projects.list')).find((p) => p.name === 'CaissaTrainer')?.roots.map((r) => r.path)).toEqual(['D:\\Work\\Caissa']);
  });
});
