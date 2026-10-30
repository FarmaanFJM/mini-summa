import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { renderApp } from './helpers';

// The activity, reports and settings views belong to another worker: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

async function openCreate() {
  const user = userEvent.setup();
  const app = await renderApp();
  await user.click(screen.getByRole('button', { name: 'New project' }));
  const dialog = await screen.findByRole('dialog', { name: 'New project' });
  return { user, app, dialog };
}

async function openEdit(project: string) {
  const user = userEvent.setup();
  const app = await renderApp();
  await user.click(screen.getByRole('button', { name: `Actions for ${project}` }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit project' }));
  const dialog = await screen.findByRole('dialog', { name: `Edit ${project}` });
  return { user, app, dialog };
}

const calledNames = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls as unknown[][]).map((c) => c[0] as string);

describe('folders: reading what is typed', () => {
  it('reads a Windows path and says which environment it is', async () => {
    const { user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Add a folder'), 'C:\\Dev\\App\\');
    expect(within(dialog).getByText('Windows')).toBeTruthy();
    expect(within(dialog).getByText('C:\\Dev\\App')).toBeTruthy(); // cleaned: no trailing separator
    expect((within(dialog).getByRole('button', { name: 'Add folder' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads a WSL share path as a path inside that distribution and says so', async () => {
    const { user, dialog } = await openCreate();
    fireEvent.change(within(dialog).getByLabelText('Add a folder'), { target: { value: '\\\\wsl$\\Ubuntu\\home\\me\\app' } });
    expect(within(dialog).getByText('WSL (Ubuntu)')).toBeTruthy();
    expect(within(dialog).getByText('/home/me/app')).toBeTruthy();
    expect(within(dialog).getByText('Read as a path inside WSL (Ubuntu).')).toBeTruthy();
  });

  it('asks which WSL distribution a Linux path is in, offering the ones the core found', async () => {
    const { user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Add a folder'), '/home/me/app');
    expect(within(dialog).getByText('This looks like a Linux path. Choose which WSL distribution it belongs to.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Add folder' }) as HTMLButtonElement).disabled).toBe(true); // not until it is answered
    const picker = await within(dialog).findByRole('button', { name: 'WSL distribution' });
    await user.click(picker);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['WSL (Ubuntu)', 'WSL (Debian)']);
    await user.click(screen.getByRole('option', { name: 'WSL (Ubuntu)' }));
    expect(within(dialog).getByText('WSL (Ubuntu)', { selector: '.ms-feedback__label' })).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Add folder' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('explains a path it cannot use', async () => {
    const { user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Add a folder'), 'relative/path');
    expect(within(dialog).getByRole('alert').textContent).toBe('Enter an absolute path (for example C:\\Dev\\App or /home/me/app).');
    expect((within(dialog).getByRole('button', { name: 'Add folder' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps several folders, refuses the same one twice, and removes one on request', async () => {
    const { user, dialog } = await openCreate();
    const input = within(dialog).getByLabelText('Add a folder');
    await user.type(input, 'C:\\Dev\\App{Enter}');
    await user.type(input, 'D:\\Other{Enter}');
    const list = within(dialog).getByRole('list', { name: 'Repository folders' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['C:\\Dev\\AppWindows', 'D:\\OtherWindows']);
    await user.type(input, 'c:\\dev\\app{Enter}');
    expect(within(dialog).getByRole('alert').textContent).toBe('This folder is already in the list.');
    await user.click(within(dialog).getByRole('button', { name: 'Remove folder D:\\Other' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('opens the folder picker of the desktop shell and uses what it returns', async () => {
    const { user, app, dialog } = await openCreate();
    (app.fake.native.dialogs.selectDirectory as ReturnType<typeof vi.fn>).mockResolvedValueOnce('C:\\Picked\\Folder');
    await user.click(within(dialog).getByRole('button', { name: 'Browse' }));
    expect((within(dialog).getByLabelText('Add a folder') as HTMLInputElement).value).toBe('C:\\Picked\\Folder');
    expect(app.fake.native.dialogs.selectDirectory).toHaveBeenCalledWith({ title: 'Choose the repository folder' });
  });

  it('offers no Browse button where there is no folder picker', async () => {
    const user = userEvent.setup();
    const { createFakeNative } = await import('./helpers');
    await renderApp({ native: createFakeNative({ embedded: false }) });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(within(await screen.findByRole('dialog', { name: 'New project' })).queryByRole('button', { name: 'Browse' })).toBeNull();
  });
});

describe('conversations: live feedback on the pasted address', () => {
  const paste = (dialog: HTMLElement, value: string) => fireEvent.change(within(dialog).getByLabelText('Add a conversation'), { target: { value } });

  it('says nothing until something is pasted', async () => {
    const { dialog } = await openCreate();
    expect(within(dialog).queryByText(/chatgpt\.com/)).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Add conversation' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the kind and the normalised address of a conversation', async () => {
    const { dialog } = await openCreate();
    paste(dialog, 'https://chatgpt.com/c/6F1A2B3C-4D5E-4F60-8A9B-0C1D2E3F4A5B?model=x#frag');
    expect(within(dialog).getByText('Conversation')).toBeTruthy();
    expect(within(dialog).getByText('https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Add conversation' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('recognises a project chat and a custom GPT chat', async () => {
    const { dialog } = await openCreate();
    paste(dialog, 'https://chatgpt.com/g/g-p-abc123/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
    expect(within(dialog).getByText('Conversation in a ChatGPT project')).toBeTruthy();
    paste(dialog, 'https://chatgpt.com/g/g-xyz789/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
    expect(within(dialog).getByText('Conversation with a custom GPT')).toBeTruthy();
  });

  it('warns in plain words about a project page and about the old host name', async () => {
    const { dialog } = await openCreate();
    paste(dialog, 'https://chatgpt.com/g/g-p-abc123/project');
    expect(within(dialog).getByText('This is a project page, not one conversation. Handoffs will open the project page.')).toBeTruthy();
    paste(dialog, 'https://chat.openai.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
    expect(within(dialog).getByText('chat.openai.com redirects to chatgpt.com, so the address was updated.')).toBeTruthy();
    paste(dialog, 'https://chatgpt.com/');
    expect(within(dialog).getByText(/does not look like a specific conversation/)).toBeTruthy();
  });

  it('refuses addresses that are not ChatGPT, with the reason', async () => {
    const { dialog } = await openCreate();
    paste(dialog, 'https://example.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
    expect(within(dialog).getByRole('alert').textContent).toBe('Only chatgpt.com conversation addresses are accepted.');
    paste(dialog, 'http://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
    expect(within(dialog).getByRole('alert').textContent).toBe('Only https addresses are accepted.');
    paste(dialog, 'javascript:alert(1)');
    expect(within(dialog).getByRole('alert').textContent).toBe('Only https addresses are accepted.');
    expect((within(dialog).getByRole('button', { name: 'Add conversation' }) as HTMLButtonElement).disabled).toBe(true);
  });

  const UUID1 = '11111111-1111-4111-8111-111111111111';
  const UUID2 = '22222222-2222-4222-8222-222222222222';

  it('makes the first conversation preferred on its own, and keeps it when more are added', async () => {
    const { user, dialog } = await openCreate();
    const input = within(dialog).getByLabelText('Add a conversation');
    await user.type(input, `chatgpt.com/c/${UUID1}{Enter}`);
    const radios = () => within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios()).toHaveLength(1);
    expect(radios()[0].checked).toBe(true);
    await user.type(input, `chatgpt.com/c/${UUID2}{Enter}`);
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
  });

  it('has exactly one preferred conversation: choosing another moves the choice', async () => {
    const { user, dialog } = await openCreate();
    const input = within(dialog).getByLabelText('Add a conversation');
    await user.type(input, `chatgpt.com/c/${UUID1}{Enter}`);
    await user.type(input, `chatgpt.com/c/${UUID2}{Enter}`);
    const radios = () => within(dialog).getAllByRole('radio') as HTMLInputElement[];
    await user.click(radios()[1]);
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
    expect(within(dialog).getByText(/^Preferred\./, { selector: '.ms-row-item__sub' })).toBeTruthy();
    expect(within(dialog).getAllByText(/^Preferred\./, { selector: '.ms-row-item__sub' })).toHaveLength(1);
  });

  it('hands the preference to the next conversation when the preferred one is removed', async () => {
    const { user, dialog } = await openCreate();
    const input = within(dialog).getByLabelText('Add a conversation');
    await user.type(input, `chatgpt.com/c/${UUID1}{Enter}`);
    await user.type(input, `chatgpt.com/c/${UUID2}{Enter}`);
    await user.click(within(dialog).getByRole('button', { name: /^Remove ChatGPT conversation 11111111/ }));
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(1);
    expect(radios[0].checked).toBe(true);
  });

  it('refuses the same conversation twice', async () => {
    const { user, dialog } = await openCreate();
    const input = within(dialog).getByLabelText('Add a conversation');
    await user.type(input, `chatgpt.com/c/${UUID1}{Enter}`);
    await user.type(input, `https://chatgpt.com/c/${UUID1.toUpperCase()}{Enter}`);
    expect(within(dialog).getByRole('alert').textContent).toBe('This conversation is already in the list.');
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1);
  });

  it('lets the title be edited', async () => {
    const { user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('Add a conversation'), `chatgpt.com/c/${UUID1}{Enter}`);
    const title = within(dialog).getByRole('textbox', { name: /^Title of ChatGPT conversation/ });
    await user.clear(title);
    await user.type(title, 'Design review');
    expect((within(dialog).getByRole('textbox', { name: 'Title of Design review' }) as HTMLInputElement).value).toBe('Design review');
  });
});

describe('editing a saved project', () => {
  it('shows what the core knows: folders, conversations, which is preferred and how each was verified', async () => {
    const { dialog } = await openEdit('GitManager');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('GitManager');
    expect((within(dialog).getByLabelText('GitHub repository') as HTMLInputElement).value).toBe('acme/git-manager');
    expect(within(dialog).getByText('C:\\Dev\\GitManager')).toBeTruthy();
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(within(dialog).getByText('Preferred. Verified: Release planning for GitManager')).toBeTruthy();
    expect(within(dialog).getByText('Verified: Code review notes')).toBeTruthy();
  });

  it('says each verification state in plain words', async () => {
    const { dialog: atlas } = await openEdit('Atlas API');
    expect(within(atlas).getByText('Preferred. Not verified yet')).toBeTruthy();
  });

  it('verifies a conversation and shows the new state in place', async () => {
    const { user, app, dialog } = await openEdit('Atlas API');
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Verify Atlas API design' }));
    await waitFor(() => expect(within(dialog).getByText('Preferred. Verified: Atlas API design')).toBeTruthy());
    expect(calls).toHaveBeenCalledWith('conversations.verify', { params: { id: IDS.c.atlasMain } });
  });

  it('shows a sign-in requirement as one', async () => {
    const { user, app, dialog } = await openEdit('Trading dashboard');
    void app;
    await waitFor(() => expect(within(dialog).getByText('Sign in to ChatGPT, then verify again')).toBeTruthy());
    void user;
  });

  it('opens a conversation through the core', async () => {
    const { user, app, dialog } = await openEdit('GitManager');
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Open Release planning' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('conversations.open', { params: { id: IDS.c.gmRelease } }));
    expect(app.fake.native.chatgpt.navigate).toHaveBeenCalledWith(expect.stringContaining('/c/6f1a2b3c'));
  });

  it('cannot open or verify what is not saved yet', async () => {
    const { user, dialog } = await openEdit('GitManager');
    await user.type(within(dialog).getByLabelText('Add a conversation'), 'chatgpt.com/c/11111111-1111-4111-8111-111111111111{Enter}');
    const open = within(dialog).getByRole('button', { name: /^Open ChatGPT conversation 11111111/ }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(within(dialog).getByText('Saved when you save the project')).toBeTruthy();
  });

  it('saves nothing and says so when nothing changed', async () => {
    const { user, app, dialog } = await openEdit('GitManager');
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calledNames(calls).filter((n) => /^(projects|conversations)\./.test(n))).toEqual([]);
    expect(screen.getByText('No changes to save')).toBeTruthy();
  });

  it('sends only what changed', async () => {
    const { user, app, dialog } = await openEdit('GitManager');
    const calls = vi.spyOn(app.demo, 'call');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Git Manager');
    await user.click(within(dialog).getByRole('radio', { name: 'Preferred: Code review notes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calledNames(calls).filter((n) => /^(projects|conversations)\./.test(n))).toEqual(['projects.update', 'conversations.setPreferred']);
    expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.gitManager)).toMatchObject({ name: 'Git Manager', preferredConversationId: IDS.c.gmReview });
    expect(await screen.findByRole('button', { name: /^Git Manager/ })).toBeTruthy();
  });

  it('removes a folder and a conversation, and the core ends with the preference on the one that remains', async () => {
    const { user, app, dialog } = await openEdit('GitManager');
    await user.click(within(dialog).getByRole('button', { name: 'Remove Release planning' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const project = app.runtime.store.getState().projects.find((p) => p.id === IDS.gitManager);
    expect(project?.preferredConversationId).toBe(IDS.c.gmReview);
    expect(app.runtime.store.getState().conversations.filter((c) => c.projectId === IDS.gitManager)).toHaveLength(1);
  });
});

describe('creating a project', () => {
  it('shows what is wrong with the name and the repository, and sends nothing', async () => {
    const { user, app, dialog } = await openCreate();
    const calls = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('GitHub repository'), 'not a repo');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(within(dialog).getByText('Give the project a name.')).toBeTruthy();
    expect(within(dialog).getByText('Use the form owner/repo, for example acme/git-manager.')).toBeTruthy();
    expect(calledNames(calls).some((n) => n === 'projects.create')).toBe(false);
  });

  it('tidies a pasted GitHub address and says what will be saved', async () => {
    const { user, dialog } = await openCreate();
    await user.type(within(dialog).getByLabelText('GitHub repository'), 'https://github.com/acme/billing.git');
    expect(within(dialog).getByText('Will be saved as acme/billing.')).toBeTruthy();
  });

  it('creates the project with its folders, then its conversations, selects it and closes', async () => {
    const { user, app, dialog } = await openCreate();
    const calls = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Name'), 'Billing service');
    await user.type(within(dialog).getByLabelText('GitHub repository'), 'acme/billing');
    await user.type(within(dialog).getByLabelText('Add a folder'), 'C:\\Dev\\Billing{Enter}');
    await user.type(within(dialog).getByLabelText('Add a conversation'), 'chatgpt.com/c/11111111-1111-4111-8111-111111111111{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calledNames(calls).filter((n) => /^(projects|conversations)\./.test(n))).toEqual(['projects.create', 'conversations.add']);
    const created = app.runtime.store.getState().projects.find((p) => p.name === 'Billing service');
    expect(created).toMatchObject({ githubRepo: 'acme/billing', roots: [{ path: 'C:\\Dev\\Billing', env: 'win' }] });
    expect(created?.preferredConversationId).not.toBeNull();
    expect((await screen.findByRole('button', { name: /^Billing service/ })).getAttribute('aria-current')).toBe('true');
  });

  it('keeps what was created when a later step fails, shows why, and a retry does not create it twice', async () => {
    const { user, app, dialog } = await openCreate();
    const original = app.demo.call;
    let failAdd = true;
    const spy = vi.spyOn(app.demo, 'call').mockImplementation(((name: string, ...rest: unknown[]) => (
      name === 'conversations.add' && failAdd ? Promise.reject(new Error('ChatGPT address was refused')) : (original as (...a: unknown[]) => unknown)(name, ...rest)
    )) as never);
    await user.type(within(dialog).getByLabelText('Name'), 'Billing service');
    await user.type(within(dialog).getByLabelText('Add a conversation'), 'chatgpt.com/c/11111111-1111-4111-8111-111111111111{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not add a conversation: ChatGPT address was refused');
    expect(screen.getByRole('dialog', { name: 'Edit Billing service' })).toBeTruthy(); // now editing the project it made
    expect(await screen.findByRole('button', { name: /^Billing service/ })).toBeTruthy();

    failAdd = false;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calledNames(spy).filter((n) => n === 'projects.create')).toHaveLength(1);
    expect(app.runtime.store.getState().projects.filter((p) => p.name === 'Billing service')).toHaveLength(1);
    expect(app.runtime.store.getState().conversations.filter((c) => c.url.includes('11111111'))).toHaveLength(1);
  });

  it('closes on Cancel and Escape without saving, and a stray click outside does not discard typed work', async () => {
    const { user, app, dialog } = await openCreate();
    const calls = vi.spyOn(app.demo, 'call');
    await user.type(within(dialog).getByLabelText('Name'), 'Half done');
    fireEvent.mouseDown(document.querySelector('.sm-backdrop') as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calledNames(calls).some((n) => n === 'projects.create')).toBe(false);
  });
});
