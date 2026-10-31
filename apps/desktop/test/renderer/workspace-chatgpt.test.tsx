// The ChatGPT pane for a project that has no conversation mapped: a linked ChatGPT Project is shown (its page, nothing imported or synced),
// a conversation opened inside it can become the one reports go to, and a project with neither gets a calm way to add one.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { createSeed } from '../../src/renderer/src/dev/demo/seed';
import type { RenderedApp } from './helpers';
import { createFakeNative, renderApp, stubWorkspaceGeometry } from './helpers';

// The activity, reports and settings views belong to other workers: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

afterEach(() => { clearNativeBounds(); vi.restoreAllMocks(); });

const PROJECT_URL = 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-caissa-trainer/project';
const CONVERSATION_IN_PROJECT = 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-caissa-trainer/c/5c4b3a29-1807-4f6e-8d5c-4b3a29180716';
const PLAIN_CONVERSATION = 'https://chatgpt.com/c/99999999-9999-4999-8999-999999999999';

const chatgpt = () => screen.getByRole('region', { name: 'ChatGPT' });
const inChatgpt = () => within(chatgpt());

async function open(app: RenderedApp, user: ReturnType<typeof userEvent.setup>, body: { name: string; chatgptProject?: { url: string; title?: string } }) {
  const { name } = body;
  await app.demo.call('projects.create', { body: { roots: [], ...body } });
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${name}(,|$)`) }));
  await screen.findByRole('heading', { level: 1, name });
}

describe('a project with a linked ChatGPT Project and no conversation', () => {
  it('shows the linked project\'s page in the embedded view, and its title in the header', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    await waitFor(() => expect(fake.native.chatgpt.navigate).toHaveBeenLastCalledWith(PROJECT_URL));
    expect(inChatgpt().getByText('Caissa trainer')).toBeTruthy(); // the title read from the address
    expect(inChatgpt().queryByRole('button', { name: 'Conversation' })).toBeNull(); // nothing to choose among
    expect(inChatgpt().getByLabelText('Embedded ChatGPT view')).toBeTruthy();
    await waitFor(() => expect(fake.lastBounds()).toEqual(places.chatgpt));
    for (const name of ['Back', 'Forward', 'Reload', 'Open in your browser']) expect(inChatgpt().getByRole('button', { name })).toBeTruthy();
  });

  it('uses the title the person gave it', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL, title: 'Chess engine research' } });
    expect(inChatgpt().getByText('Chess engine research')).toBeTruthy();
  });

  it('does not load the page again when the view is already on it', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative({ view: { url: PROJECT_URL, title: 'Caissa trainer' } });
    const app = await renderApp({ native: fake });
    const before = (fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>).mock.calls.length;
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    await new Promise((r) => setTimeout(r, 80));
    expect((fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('opens the page the view shows in the browser', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    await user.click(inChatgpt().getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenLastCalledWith(PROJECT_URL);
    act(() => fake.emitView({ url: CONVERSATION_IN_PROJECT, status: 'ready' }));
    await user.click(inChatgpt().getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenLastCalledWith(CONVERSATION_IN_PROJECT);
  });

  it('offers to use a conversation that is opened in it for reports, and maps it when asked', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    const calls = vi.spyOn(app.demo, 'call');
    const id = app.runtime.store.getState().projects.find((p) => p.name === 'Caissa')!.id;
    expect(inChatgpt().queryByRole('button', { name: 'Use this conversation for reports' })).toBeNull(); // the project page is not a conversation
    act(() => fake.emitView({ url: PROJECT_URL, status: 'ready' }));
    expect(inChatgpt().queryByRole('button', { name: 'Use this conversation for reports' })).toBeNull();

    act(() => fake.emitView({ url: CONVERSATION_IN_PROJECT, status: 'ready' }));
    const offer = await inChatgpt().findByRole('button', { name: 'Use this conversation for reports' });
    expect(within(chatgpt()).getByText('No conversation receives reports for Caissa yet.')).toBeTruthy();
    await user.click(offer);
    await waitFor(() => expect(calls).toHaveBeenCalledWith('conversations.add', { params: { id }, body: { url: CONVERSATION_IN_PROJECT } }));
    // Once mapped, the project has a conversation: the offer is gone and the pane shows it as it does for any project.
    await waitFor(() => expect(inChatgpt().queryByRole('button', { name: 'Use this conversation for reports' })).toBeNull());
    expect(app.runtime.store.getState().conversations.filter((c) => c.projectId === id)).toHaveLength(1);
    expect(inChatgpt().queryByText('Caissa trainer')).toBeNull();
    expect(inChatgpt().getByText(/^ChatGPT conversation 5c4b3a29/)).toBeTruthy();
  });

  it('offers it for a conversation outside any project too, because it is a conversation', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    act(() => fake.emitView({ url: PLAIN_CONVERSATION, status: 'ready' }));
    expect(await inChatgpt().findByRole('button', { name: 'Use this conversation for reports' })).toBeTruthy();
  });

  it('offers nothing for a page that is not a conversation, or while the page is still loading or needs a sign in', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    const offer = () => inChatgpt().queryByRole('button', { name: 'Use this conversation for reports' });
    act(() => fake.emitView({ url: 'https://chatgpt.com/', status: 'ready' }));
    expect(offer()).toBeNull();
    act(() => fake.emitView({ url: CONVERSATION_IN_PROJECT, status: 'loading' }));
    expect(offer()).toBeNull();
    act(() => fake.emitView({ url: CONVERSATION_IN_PROJECT, status: 'login_required' }));
    expect(offer()).toBeNull();
    act(() => fake.emitView({ url: CONVERSATION_IN_PROJECT, status: 'ready' }));
    expect(await inChatgpt().findByRole('button', { name: 'Use this conversation for reports' })).toBeTruthy();
  });

  it('never says the linked project was imported or kept in sync', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    act(() => fake.emitView({ url: CONVERSATION_IN_PROJECT, status: 'ready' }));
    await inChatgpt().findByRole('button', { name: 'Use this conversation for reports' });
    expect(chatgpt().textContent).not.toMatch(/import|sync|mirror|copied from/i);
  });

  it('keeps asking nothing of a project that has conversations mapped: the old notice about a page that is not one of them', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    act(() => fake.emitView({ url: PLAIN_CONVERSATION, status: 'ready' }));
    expect(await screen.findByText(/This page is not one of GitManager's conversations/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this conversation for reports' })).toBeNull();
  });
});

describe('the project settings asking for the linked ChatGPT Project\'s page', () => {
  it('is loaded by the pane, and the conversation the project would otherwise show does not take it away', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    // A project with a conversation and a linked project, while another project (GitManager) is the one on screen.
    const made = await app.demo.call('projects.create', { body: { name: 'Both', roots: [], chatgptProject: { url: PROJECT_URL } } });
    await app.demo.call('conversations.add', { params: { id: made.id }, body: { url: PLAIN_CONVERSATION } });
    const navigate = fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    navigate.mockClear();
    act(() => {
      app.runtime.route.getState().selectProject(made.id);
      app.runtime.route.getState().openChatGptProject(made.id);
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(PROJECT_URL));
    await waitFor(() => expect(app.runtime.route.getState().chatgptProjectOpen[made.id]).toBeUndefined()); // asked once, done once
    await new Promise((r) => setTimeout(r, 120));
    expect(navigate.mock.calls.map((c) => c[0])).toEqual([PROJECT_URL]); // the project's conversation was not loaded over it
  });

  it('does not load the page again when the view is already on it, and drops the request where nothing can show it', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative({ view: { url: PROJECT_URL } });
    const app = await renderApp({ native: fake });
    const made = await app.demo.call('projects.create', { body: { name: 'Linked', roots: [], chatgptProject: { url: PROJECT_URL } } });
    const bare = await app.demo.call('projects.create', { body: { name: 'Bare', roots: [] } });
    const navigate = fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>;
    await new Promise((r) => setTimeout(r, 100)); // the first project's own page, loaded on start, is not what is looked at here
    navigate.mockClear();
    act(() => { app.runtime.route.getState().selectProject(made.id); app.runtime.route.getState().openChatGptProject(made.id); });
    await waitFor(() => expect(app.runtime.route.getState().chatgptProjectOpen[made.id]).toBeUndefined());
    expect(navigate).not.toHaveBeenCalled();
    act(() => { app.runtime.route.getState().selectProject(bare.id); app.runtime.route.getState().openChatGptProject(bare.id); });
    await waitFor(() => expect(app.runtime.route.getState().chatgptProjectOpen[bare.id]).toBeUndefined());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('is what the "Open" of the project settings does, with the pane keeping the person where they are afterwards', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const made = await app.demo.call('projects.create', { body: { name: 'Both', roots: [], chatgptProject: { url: PROJECT_URL } } });
    await app.demo.call('conversations.add', { params: { id: made.id }, body: { url: PLAIN_CONVERSATION } });
    const navigate = fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>;
    await user.click(screen.getByRole('button', { name: `Actions for Both` }));
    await user.click(await screen.findByRole('menuitem', { name: /^(Edit project|Project settings|Settings)$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Both settings' });
    navigate.mockClear();
    await user.click(within(dialog).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(PROJECT_URL));
    await screen.findByRole('heading', { level: 1, name: 'Both' });
    await new Promise((r) => setTimeout(r, 120));
    expect(navigate.mock.calls.map((c) => c[0])).toEqual([PROJECT_URL]);
  });
});

describe('a project with neither a conversation nor a linked ChatGPT Project', () => {
  async function bare() {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Bare' });
    return { places, user, fake, app };
  }

  it('says so in one sentence and offers two ways to fix it, both in the project settings', async () => {
    const { user } = await bare();
    expect(inChatgpt().getByText('This project has no ChatGPT Project or conversation yet.')).toBeTruthy();
    const buttons = inChatgpt().getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Link a ChatGPT Project', 'Add a conversation']);
    expect(chatgpt().querySelectorAll('.sm-btn--primary')).toHaveLength(0); // the main button of the screen is not here
    await user.click(buttons[0]);
    expect(await screen.findByRole('dialog', { name: 'Bare settings' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Bare settings' })).toBeNull());
    await user.click(inChatgpt().getByRole('button', { name: 'Add a conversation' }));
    expect(await screen.findByRole('dialog', { name: 'Bare settings' })).toBeTruthy();
  });

  it('has no page to show: no slot, no navigation controls, and the native view is told it has no place', async () => {
    const { fake } = await bare();
    expect(chatgpt().querySelector('[data-native-slot]')).toBeNull();
    for (const name of ['Back', 'Forward', 'Reload', 'Open in your browser']) expect(inChatgpt().queryByRole('button', { name })).toBeNull();
    await waitFor(() => expect(fake.lastBounds()).toBeNull());
  });

  it('is a few words and not a block: nothing but the sentence and the two buttons', async () => {
    await bare();
    const body = chatgpt().querySelector('.ms-pane__empty') as HTMLElement;
    expect(body.querySelectorAll('p')).toHaveLength(1);
    expect(body.querySelectorAll('button')).toHaveLength(2);
    expect((body.textContent ?? '').length).toBeLessThan(110);
  });
});

describe('without the embedded view', () => {
  const external = () => { const seed = createSeed(); seed.settings.chatgpt.mode = 'external'; return seed; };

  it('lists the linked ChatGPT Project of a project without conversations, with a row that opens it in the browser', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake, seed: external() });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    expect(await inChatgpt().findByRole('heading', { name: 'ChatGPT opens in your browser' })).toBeTruthy();
    expect(inChatgpt().queryByRole('list', { name: 'Mapped conversations' })).toBeNull();
    const row = within(inChatgpt().getByRole('list', { name: 'Linked ChatGPT Project' })).getByRole('listitem');
    expect(row.textContent).toBe('Caissa trainerChatGPT ProjectOpen');
    await user.click(within(row).getByRole('button', { name: 'Open ChatGPT Project' }));
    expect(fake.native.shell.openExternal).toHaveBeenCalledWith(PROJECT_URL);
    expect(fake.native.chatgpt.navigate).not.toHaveBeenCalled();
    expect(fake.lastBounds()).toBeNull();
  });

  it('lists the conversations and the linked ChatGPT Project when a project has both', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake, seed: external() });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    const id = app.runtime.store.getState().projects.find((p) => p.name === 'Caissa')!.id;
    await act(async () => { await app.demo.call('conversations.add', { params: { id }, body: { url: PLAIN_CONVERSATION } }); });
    const conversations = await inChatgpt().findByRole('list', { name: 'Mapped conversations' });
    expect(within(conversations).getAllByRole('listitem')).toHaveLength(1);
    expect(within(inChatgpt().getByRole('list', { name: 'Linked ChatGPT Project' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('says the embedded view is only in the desktop app, in a browser, and still opens a linked project', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative({ embedded: false });
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Caissa', chatgptProject: { url: PROJECT_URL } });
    expect(inChatgpt().getByText('The embedded ChatGPT view is only available in the desktop app.')).toBeTruthy();
    await user.click(inChatgpt().getByRole('button', { name: 'Open ChatGPT Project' }));
    expect(fake.native.shell.openExternal).toHaveBeenCalledWith(PROJECT_URL);
    await user.click(inChatgpt().getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenLastCalledWith(PROJECT_URL);
  });

  it('shows the same calm empty state, and no list, for a project with neither', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative(), seed: external() });
    await open(app, user, { name: 'Bare' });
    expect(inChatgpt().getByText('This project has no ChatGPT Project or conversation yet.')).toBeTruthy();
    expect(inChatgpt().queryByRole('heading', { name: 'ChatGPT opens in your browser' })).toBeNull();
  });
});
