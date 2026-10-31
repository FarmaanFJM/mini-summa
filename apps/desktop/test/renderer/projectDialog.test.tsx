// The New project dialog: how a project starts, the one thing each way of starting asks for, and the one call that creates it. The
// dialog is opened through the ui store (openProjectDialog), which is the contract the shell and the empty states rely on.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeNative, renderApp } from './helpers';
import type { RenderedApp } from './helpers';

// The activity, reports and settings views belong to other workers: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

const PROJECT = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/project';
const CHAT_IN_PROJECT = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const SINGLE_CHAT = 'https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';

const ADDRESS_LABEL = 'Address of an existing ChatGPT Project';

async function openCreate(options: Parameters<typeof renderApp>[0] = {}) {
  const user = userEvent.setup();
  const app = await renderApp(options);
  act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'create' }));
  const dialog = await screen.findByRole('dialog', { name: 'New project' });
  return { user, app, dialog };
}

const calls = (spy: { mock: { calls: unknown[][] } }, name: string): unknown[] => spy.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
const callNames = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => c[0] as string);
const paste = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });
const tab = (dialog: HTMLElement, name: string) => within(dialog).getByRole('tab', { name });
const stored = (app: RenderedApp, name: string) => app.runtime.store.getState().projects.find((p) => p.name === name);
const pickFolder = (app: RenderedApp) => app.fake.native.dialogs.selectDirectory as ReturnType<typeof vi.fn>;

describe('starting a project', () => {
  it('offers four ways to start, the ChatGPT Project first, and asks for that one thing and a name', async () => {
    const { dialog } = await openCreate();
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['ChatGPT Project', 'GitHub repository', 'Local folder', 'Empty project']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(within(dialog).getByRole('tablist', { name: 'Start from' })).toBeTruthy();

    // One input for the source, then the name. Nothing about repositories or folders.
    expect(within(dialog).getAllByRole('textbox').map((t) => t.getAttribute('aria-label') ?? (t as HTMLInputElement).labels?.[0]?.textContent)).toEqual([ADDRESS_LABEL, 'Name']);
    expect(within(dialog).queryByRole('button', { name: 'Browse' })).toBeNull();
    // Cancel, and one primary action.
    const buttons = within(dialog).getAllByRole('button').filter((b) => b.getAttribute('role') !== 'tab');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Create project']);
    expect(buttons[1].className).toContain('sm-btn--primary');
    expect(document.querySelectorAll('.sm-dialog .sm-btn--primary')).toHaveLength(1);
  });

  it('puts the cursor in the field of the chosen source', async () => {
    const { dialog } = await openCreate();
    expect(document.activeElement).toBe(within(dialog).getByLabelText(ADDRESS_LABEL));
  });

  it('shows one source at a time and keeps what was typed in each while the person looks at another', async () => {
    const { user, dialog } = await openCreate();
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), PROJECT);
    await user.click(tab(dialog, 'GitHub repository'));
    expect(within(dialog).queryByLabelText(ADDRESS_LABEL)).toBeNull();
    expect(within(dialog).getByRole('tabpanel')).toBeTruthy();
    paste(within(dialog).getByLabelText('Repository'), 'acme/billing');
    await user.click(tab(dialog, 'Local folder'));
    expect(within(dialog).queryByLabelText('Repository')).toBeNull();
    expect(within(dialog).getByLabelText('Folder')).toBeTruthy();
    await user.click(tab(dialog, 'Empty project'));
    expect(within(dialog).queryByLabelText('Folder')).toBeNull();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1); // only the name
    await user.click(tab(dialog, 'ChatGPT Project'));
    expect((within(dialog).getByLabelText(ADDRESS_LABEL) as HTMLInputElement).value).toBe(PROJECT);
    await user.click(tab(dialog, 'GitHub repository'));
    expect((within(dialog).getByLabelText('Repository') as HTMLInputElement).value).toBe('acme/billing');
  });

  it('moves between the ways to start with the arrow keys', async () => {
    const { user, dialog } = await openCreate();
    tab(dialog, 'ChatGPT Project').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab(dialog, 'GitHub repository').getAttribute('aria-selected')).toBe('true');
    expect(within(dialog).getByLabelText('Repository')).toBeTruthy();
  });
});

describe('from a ChatGPT Project', () => {
  it('says what it will keep, in one sentence, and nothing that suggests more is imported', async () => {
    const { dialog } = await openCreate();
    expect(within(dialog).getByText('Only the address is saved. Nothing in the project is imported or synced.')).toBeTruthy();
    expect(dialog.textContent ?? '').not.toMatch(/import(ed)? (your|the|its) (files|conversations|instructions)|synchronis/i);
  });

  it('reads the address as it is typed: the title it will be saved with, and the name offered', async () => {
    const { dialog } = await openCreate();
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), PROJECT);
    expect(within(dialog).getByText('Title: Caissa trainer')).toBeTruthy();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Caissa trainer');
  });

  it('says when it took the project page from a conversation inside the project', async () => {
    const { dialog } = await openCreate();
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), CHAT_IN_PROJECT);
    expect(within(dialog).getByText('Title: Caissa trainer. This is a conversation inside the project, so the project page is linked.')).toBeTruthy();
  });

  it('refuses a single conversation, with the reason beside the field, and sends nothing', async () => {
    const { user, app, dialog } = await openCreate();
    const spy = vi.spyOn(app.demo, 'call');
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), SINGLE_CHAT);
    expect(within(dialog).getByRole('alert').textContent).toBe('That is a single conversation outside any project. Open the project in ChatGPT and copy the address of its project page.');
    expect(within(dialog).queryByText('Only the address is saved. Nothing in the project is imported or synced.')).toBeNull(); // the message takes its place
    await user.type(within(dialog).getByLabelText('Name'), 'Caissa');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(callNames(spy)).not.toContain('projects.create');
  });

  it('accepts an address of a form it does not recognise and says it will be opened as pasted', async () => {
    const { user, app, dialog } = await openCreate();
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), 'https://chatgpt.com/library');
    expect(within(dialog).getByText('Mini-Summa does not recognise this form of address. It will be opened as pasted.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(''); // no title to offer
    await user.type(within(dialog).getByLabelText('Name'), 'Library');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'Library', chatgptProject: { url: 'https://chatgpt.com/library' } } }]);
    expect(stored(app, 'Library')?.chatgptProject).toEqual({ url: 'https://chatgpt.com/library', scopeId: null, title: 'ChatGPT Project' });
  });

  it('creates the project with one call, links the address, selects it and closes', async () => {
    const { user, app, dialog } = await openCreate();
    const spy = vi.spyOn(app.demo, 'call');
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), PROJECT);
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'Caissa trainer', chatgptProject: { url: PROJECT } } }]);
    expect(callNames(spy).filter((n) => /^(projects|conversations)\./.test(n))).toEqual(['projects.create']);
    const created = stored(app, 'Caissa trainer');
    expect(created).toMatchObject({ githubRepo: null, roots: [], chatgptProject: { url: PROJECT, scopeId: 'g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer', title: 'Caissa trainer' } });
    expect(app.runtime.route.getState().projectId).toBe(created?.id);
    expect(await screen.findByRole('button', { name: /^Caissa trainer(,|$)/ })).toBeTruthy();
  });

  it('turns a pasted conversation inside the project into the project page', async () => {
    const { user, app, dialog } = await openCreate();
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), CHAT_IN_PROJECT);
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(stored(app, 'Caissa trainer')?.chatgptProject?.url).toBe(PROJECT);
  });

  it('asks for the address when there is none, and for a name, once Create is pressed', async () => {
    const { user, app, dialog } = await openCreate();
    const spy = vi.spyOn(app.demo, 'call');
    expect(within(dialog).queryByRole('alert')).toBeNull(); // nothing is said before it is needed
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(within(dialog).getAllByRole('alert').map((a) => a.textContent)).toEqual(['Paste the address of the ChatGPT Project.', 'Give the project a name.']);
    expect(callNames(spy)).not.toContain('projects.create');
    expect(document.activeElement).toBe(within(dialog).getByLabelText(ADDRESS_LABEL));
  });
});

describe('from a GitHub repository', () => {
  const openGithub = async () => {
    const opened = await openCreate();
    await opened.user.click(tab(opened.dialog, 'GitHub repository'));
    return opened;
  };

  it('normalises a pasted address as it is typed and says what will be saved', async () => {
    const { dialog } = await openGithub();
    paste(within(dialog).getByLabelText('Repository'), 'https://github.com/acme/billing.git');
    expect(within(dialog).getByText('Will be saved as acme/billing.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('billing');
    paste(within(dialog).getByLabelText('Repository'), 'acme/billing');
    expect(within(dialog).queryByText(/Will be saved as/)).toBeNull(); // already as it will be saved
  });

  it('says what is wrong with a repository as it is typed', async () => {
    const { dialog } = await openGithub();
    paste(within(dialog).getByLabelText('Repository'), 'not a repo');
    expect(within(dialog).getByRole('alert').textContent).toBe('Use the form owner/repo, for example acme/git-manager.');
  });

  it('creates a project with a repository and no folder, with one call', async () => {
    const { user, app, dialog } = await openGithub();
    const spy = vi.spyOn(app.demo, 'call');
    paste(within(dialog).getByLabelText('Repository'), 'https://github.com/FarmaanFIM/CaissaTrainer.git');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('CaissaTrainer');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' } }]);
    expect(stored(app, 'CaissaTrainer')).toMatchObject({ githubRepo: 'FarmaanFIM/CaissaTrainer', roots: [], chatgptProject: null });
  });

  it('asks for the repository when there is none', async () => {
    const { user, app, dialog } = await openGithub();
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Name'), 'Billing');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Enter the repository as owner/repo.');
    expect(callNames(spy)).not.toContain('projects.create');
  });
});

describe('from a local folder', () => {
  const openFolder = async (options: Parameters<typeof renderApp>[0] = {}) => {
    const opened = await openCreate(options);
    await opened.user.click(tab(opened.dialog, 'Local folder'));
    return opened;
  };

  it('reads a Windows path as it is typed, and offers the folder name as the name', async () => {
    const { user, dialog } = await openFolder();
    await user.type(within(dialog).getByLabelText('Folder'), 'C:\\Dev\\Billing service\\');
    expect(within(dialog).getByText('Windows')).toBeTruthy();
    expect(within(dialog).getByText('C:\\Dev\\Billing service')).toBeTruthy(); // cleaned: no trailing separator
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Billing service');
  });

  it('reads a WSL share as a path inside that distribution and says so', async () => {
    const { dialog } = await openFolder();
    paste(within(dialog).getByLabelText('Folder'), '\\\\wsl$\\Ubuntu\\home\\me\\app');
    expect(within(dialog).getByText('WSL (Ubuntu)')).toBeTruthy();
    expect(within(dialog).getByText('/home/me/app')).toBeTruthy();
    expect(within(dialog).getByText('Read as a path inside WSL (Ubuntu).')).toBeTruthy();
  });

  it('asks which WSL distribution a Linux path is in, offering the ones the core found, and creates in that one', async () => {
    const { user, app, dialog } = await openFolder();
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Folder'), '/home/me/billing');
    expect(within(dialog).getByText('This looks like a Linux path. Choose which WSL distribution it belongs to.')).toBeTruthy();

    // Not until it is answered.
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(within(dialog).getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'Choose which WSL distribution this folder is in, or clear the folder field.',
      'Give the project a name.', // there is no folder name to offer yet either
    ]);
    expect(callNames(spy)).not.toContain('projects.create');

    await user.click(await within(dialog).findByRole('button', { name: 'WSL distribution' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['WSL (Ubuntu)', 'WSL (Debian)']);
    await user.click(screen.getByRole('option', { name: 'WSL (Debian)' }));
    expect(within(dialog).getByText('WSL (Debian)', { selector: '.ms-pj-reading__label' })).toBeTruthy();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('billing');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'billing', roots: [{ path: '/home/me/billing', env: 'wsl:Debian' }] } }]);
  });

  it('explains a path it cannot use, and does not create', async () => {
    const { user, app, dialog } = await openFolder();
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Folder'), 'relative/path');
    expect(within(dialog).getByRole('alert').textContent).toBe('Enter an absolute path (for example C:\\Dev\\App or /home/me/app).');
    await user.type(within(dialog).getByLabelText('Name'), 'Relative');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(callNames(spy)).not.toContain('projects.create');
  });

  it('creates the project with its folder, with one call', async () => {
    const { user, app, dialog } = await openFolder();
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Folder'), 'C:\\Dev\\Billing');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'Billing', roots: [{ path: 'C:\\Dev\\Billing', env: 'win' }] } }]);
    expect(stored(app, 'Billing')).toMatchObject({ githubRepo: null, chatgptProject: null, roots: [{ path: 'C:\\Dev\\Billing', env: 'win' }] });
  });

  it('uses the folder chosen with Browse at once: it is the project folder, and there is no second button to press', async () => {
    const { user, app, dialog } = await openFolder();
    pickFolder(app).mockResolvedValueOnce('C:\\Picked\\Folder');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    expect(pickFolder(app)).toHaveBeenCalledWith({ title: 'Choose the project folder' });
    await waitFor(() => expect((within(dialog).getByLabelText('Folder') as HTMLInputElement).value).toBe('C:\\Picked\\Folder'));
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Folder');
    expect(within(dialog).queryByRole('button', { name: /^Add/ })).toBeNull();

    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'Folder', roots: [{ path: 'C:\\Picked\\Folder', env: 'win' }] } }]);
  });

  it('a cancelled picker changes nothing', async () => {
    const { user, dialog } = await openFolder();
    await user.type(within(dialog).getByLabelText('Folder'), 'C:\\Dev\\Kept');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' })); // the fake answers null, as a cancelled picker does
    expect((within(dialog).getByLabelText('Folder') as HTMLInputElement).value).toBe('C:\\Dev\\Kept');
  });

  it('keeps a picked Linux path in the field with the question it needs answered', async () => {
    const { user, app, dialog } = await openFolder();
    pickFolder(app).mockResolvedValueOnce('/home/me/app');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect((within(dialog).getByLabelText('Folder') as HTMLInputElement).value).toBe('/home/me/app'));
    expect(within(dialog).getByText('This looks like a Linux path. Choose which WSL distribution it belongs to.')).toBeTruthy();
  });

  it('says so beside the field when the folder picker cannot be opened', async () => {
    const { user, app, dialog } = await openFolder();
    pickFolder(app).mockRejectedValueOnce(new Error('no dialog'));
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The folder picker could not be opened. Type the path instead.');
  });

  it('offers no Browse button where there is no folder picker', async () => {
    const { dialog } = await openFolder({ native: createFakeNative({ embedded: false }) });
    expect(within(dialog).getByLabelText('Folder')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Browse' })).toBeNull();
  });

  it('shows the core\'s refusal of a folder beside the folder field, in its own words, and keeps what was typed', async () => {
    const { user, app, dialog } = await openFolder();
    app.demo.demo.server.folderCheck = (_env, path) => (path.endsWith('Nowhere') ? { code: 'root_not_found', message: `This folder does not exist: ${path}. Check the spelling, or choose it with Browse.` } : null);
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Folder'), 'C:\\Dev\\Nowhere');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This folder does not exist: C:\\Dev\\Nowhere. Check the spelling, or choose it with Browse.');
    // Beside the field it is about, with everything still typed, and nothing was created.
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
    expect((within(dialog).getByLabelText('Folder') as HTMLInputElement).value).toBe('C:\\Dev\\Nowhere');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Nowhere');
    expect(app.runtime.store.getState().projects.some((p) => p.name === 'Nowhere')).toBe(false);

    // Fixing the path and pressing Create again creates the project once.
    await user.clear(within(dialog).getByLabelText('Folder'));
    await user.type(within(dialog).getByLabelText('Folder'), 'C:\\Dev\\Somewhere');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toHaveLength(2);
    expect(app.runtime.store.getState().projects.filter((p) => p.name === 'Nowhere')).toHaveLength(0);
    expect(app.runtime.store.getState().projects.filter((p) => p.name === 'Somewhere')).toHaveLength(1);
  });

  it('refuses a folder that belongs to another project, in the core\'s words', async () => {
    const { user, dialog } = await openFolder();
    await user.type(within(dialog).getByLabelText('Folder'), 'C:\\Dev\\GitManager');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This folder already belongs to the project "GitManager". A folder can belong to one project only, so remove it there first or choose a different folder.',
    );
    expect((within(dialog).getByLabelText('Folder') as HTMLInputElement).value).toBe('C:\\Dev\\GitManager');
  });
});

describe('from nothing', () => {
  it('asks for a name and creates an empty project', async () => {
    const { user, app, dialog } = await openCreate();
    await user.click(tab(dialog, 'Empty project'));
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Give the project a name.');
    expect(callNames(spy)).not.toContain('projects.create');
    await user.type(within(dialog).getByLabelText('Name'), 'Scratch');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'Scratch' } }]);
    expect(stored(app, 'Scratch')).toMatchObject({ githubRepo: null, chatgptProject: null, roots: [] });
    expect(app.runtime.route.getState().projectId).toBe(stored(app, 'Scratch')?.id);
  });
});

describe('the name', () => {
  it('is offered from the source until the person types their own, and then it is theirs', async () => {
    const { user, dialog } = await openCreate();
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    paste(within(dialog).getByLabelText(ADDRESS_LABEL), PROJECT);
    expect(name.value).toBe('Caissa trainer');
    await user.click(tab(dialog, 'GitHub repository'));
    expect(name.value).toBe(''); // this source has none to offer yet
    paste(within(dialog).getByLabelText('Repository'), 'acme/billing');
    expect(name.value).toBe('billing');

    await user.clear(name);
    await user.type(name, 'Mine');
    paste(within(dialog).getByLabelText('Repository'), 'acme/other');
    expect(name.value).toBe('Mine');
    await user.click(tab(dialog, 'ChatGPT Project'));
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Mine');
  });

  it('is required, and the message comes once Create has been pressed, not before', async () => {
    const { user, app, dialog } = await openCreate();
    await user.click(tab(dialog, 'Empty project'));
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Name'), '  ');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Give the project a name.');
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Name'));
    expect(callNames(spy)).not.toContain('projects.create');
  });

  it('holds at most 120 characters', async () => {
    const { dialog } = await openCreate();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).maxLength).toBe(120);
  });

  it('is trimmed before it is sent', async () => {
    const { user, app, dialog } = await openCreate();
    await user.click(tab(dialog, 'Empty project'));
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Name'), '  Padded  ');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'Padded' } }]);
  });
});

describe('creating with the keyboard', () => {
  it('creates with Enter from the last field, as the button does', async () => {
    const { user, app, dialog } = await openCreate();
    await user.click(tab(dialog, 'Empty project'));
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Name'), 'Typed{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toEqual([{ body: { name: 'Typed' } }]);
  });
});

describe('creating once', () => {
  it('sends one request however many times Create is pressed while it is answered', async () => {
    const { user, app, dialog } = await openCreate();
    await user.click(tab(dialog, 'Empty project'));
    await user.type(within(dialog).getByLabelText('Name'), 'Once');
    const original = app.demo.call;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(app.demo, 'call').mockImplementation((async (name: string, ...rest: unknown[]) => {
      if (name === 'projects.create') await gate;
      return (original as (...a: unknown[]) => unknown)(name, ...rest);
    }) as never);
    const create = within(dialog).getByRole('button', { name: 'Create project' });
    await user.click(create);
    await user.click(create);
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toHaveLength(1);
    expect(app.runtime.store.getState().projects.filter((p) => p.name === 'Once')).toHaveLength(1);
  });

  it('says why when the core cannot be reached, keeps everything, and creates on the next press', async () => {
    const { user, app, dialog } = await openCreate();
    await user.click(tab(dialog, 'Empty project'));
    await user.type(within(dialog).getByLabelText('Name'), 'Retry');
    const original = app.demo.call;
    let fail = true;
    const spy = vi.spyOn(app.demo, 'call').mockImplementation((async (name: string, ...rest: unknown[]) => {
      if (name === 'projects.create' && fail) throw Object.assign(new Error('Could not reach the Mini-Summa core: fetch failed'), { code: 'network' });
      return (original as (...a: unknown[]) => unknown)(name, ...rest);
    }) as never);
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not reach the Mini-Summa core: fetch failed');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Retry');
    expect(app.runtime.store.getState().projects.some((p) => p.name === 'Retry')).toBe(false);
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(spy, 'projects.create')).toHaveLength(2);
    expect(app.runtime.store.getState().projects.filter((p) => p.name === 'Retry')).toHaveLength(1);
  });
});

describe('leaving without creating', () => {
  it('closes on Cancel and on Escape without creating anything', async () => {
    const { user, app, dialog } = await openCreate();
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Name'), 'Half done');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'create' }));
    await screen.findByRole('dialog', { name: 'New project' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callNames(spy)).not.toContain('projects.create');
  });

  it('a stray click outside does not discard typed work, but closes an untouched dialog', async () => {
    const { user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Name'), 'Half done');
    fireEvent.mouseDown(document.querySelector('.sm-backdrop') as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const second = await openCreate();
    fireEvent.mouseDown(document.querySelector('.sm-backdrop') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    second.app.unmount();
  });

  it('opens fresh every time: nothing typed last time is still there', async () => {
    const { user, app, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Name'), 'Old');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    act(() => app.runtime.ui.getState().openProjectDialog({ mode: 'create' }));
    const again = await screen.findByRole('dialog', { name: 'New project' });
    expect(tab(again, 'ChatGPT Project').getAttribute('aria-selected')).toBe('true');
    expect((within(again).getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });
});
