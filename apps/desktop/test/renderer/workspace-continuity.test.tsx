// A project is a persistent workspace: its ChatGPT pane opens on the last page the person was on IN THAT PROJECT, without pasting
// anything; what the person does in ChatGPT is remembered per project and never creates a project or maps a conversation.
// The embedded view is a double (createFakeNative): it proves what the pane asks of it, not what ChatGPT does.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { pageToOpen } from '../../src/renderer/src/features/workspace/ChatGptPane';
import { createFakeNative, renderApp, stubWorkspaceGeometry } from './helpers';

vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

afterEach(() => { clearNativeBounds(); vi.restoreAllMocks(); });

const SCOPE_A = 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-alpha';
const SCOPE_B = 'g-p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-beta';
const uuid = (c: string): string => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const chatIn = (scope: string, c: string): string => `https://chatgpt.com/g/${scope}/c/${uuid(c)}`;
const projectPage = (scope: string): string => `https://chatgpt.com/g/${scope}/project`;
const plain = (c: string): string => `https://chatgpt.com/c/${uuid(c)}`;

const chatgpt = () => screen.getByRole('region', { name: 'ChatGPT' });
const navigateMock = (fake: ReturnType<typeof createFakeNative>) => fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>;
const lastNavigated = (fake: ReturnType<typeof createFakeNative>) => navigateMock(fake).mock.calls.at(-1)?.[0];

describe('the page the pane opens for a project (restore order)', () => {
  const linked = { url: projectPage(SCOPE_A), scopeId: SCOPE_A };
  const mapped = { url: plain('c') };

  it('is the last page used in the project, else the mapped conversation, else the linked project page, else nothing', () => {
    expect(pageToOpen({ projectId: 'p', remembered: chatIn(SCOPE_A, '1'), selected: mapped, linked })).toEqual({ from: 'last', url: chatIn(SCOPE_A, '1') });
    expect(pageToOpen({ projectId: 'p', remembered: null, selected: mapped, linked })).toEqual({ from: 'conversation', url: mapped.url });
    expect(pageToOpen({ projectId: 'p', remembered: null, selected: null, linked })).toEqual({ from: 'project', url: linked.url });
    expect(pageToOpen({ projectId: 'p', remembered: null, selected: null, linked: null })).toBeNull();
  });

  it('skips a remembered page that is not valid for the project now (another ChatGPT Project, the home page, garbage)', () => {
    expect(pageToOpen({ projectId: 'p', remembered: chatIn(SCOPE_B, '2'), selected: null, linked })).toEqual({ from: 'project', url: linked.url });
    expect(pageToOpen({ projectId: 'p', remembered: 'https://chatgpt.com/', selected: mapped, linked })).toEqual({ from: 'conversation', url: mapped.url });
    expect(pageToOpen({ projectId: 'p', remembered: 'not an address', selected: null, linked: null })).toBeNull();
  });

  it('an unlinked project uses a remembered conversation', () => {
    expect(pageToOpen({ projectId: 'p', remembered: plain('d'), selected: null, linked: null })).toEqual({ from: 'last', url: plain('d') });
  });
});

describe('opening a project', () => {
  it('shows the last page remembered for it instead of its mapped conversation or its project page, and loads nothing else', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const made = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    await app.demo.call('conversations.add', { params: { id: made.id }, body: { url: chatIn(SCOPE_A, 'c') } });
    act(() => { app.runtime.route.getState().selectChatGptUrl(made.id, chatIn(SCOPE_A, '1')); app.runtime.route.getState().selectProject(made.id); });
    await waitFor(() => expect(lastNavigated(fake)).toBe(chatIn(SCOPE_A, '1')));
    await new Promise((r) => setTimeout(r, 100));
    expect(navigateMock(fake).mock.calls.filter((c) => c[0] === chatIn(SCOPE_A, 'c') || c[0] === projectPage(SCOPE_A))).toEqual([]);
  });

  it('falls back to the mapped conversation, then to the linked project page, when nothing is remembered', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const withConversation = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    await app.demo.call('conversations.add', { params: { id: withConversation.id }, body: { url: chatIn(SCOPE_A, 'c') } });
    const onlyLink = await app.demo.call('projects.create', { body: { name: 'Beta', roots: [], chatgptProject: { url: projectPage(SCOPE_B) } } });
    act(() => app.runtime.route.getState().selectProject(withConversation.id));
    await waitFor(() => expect(lastNavigated(fake)).toBe(chatIn(SCOPE_A, 'c')));
    act(() => app.runtime.route.getState().selectProject(onlyLink.id));
    await waitFor(() => expect(lastNavigated(fake)).toBe(projectPage(SCOPE_B)));
  });

  it('keeps the empty state for a project with no link, no conversation and nothing remembered', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const bare = await app.demo.call('projects.create', { body: { name: 'Bare', roots: [] } });
    act(() => app.runtime.route.getState().selectProject(bare.id));
    expect(await within(chatgpt()).findByText('This project has no ChatGPT Project or conversation yet.')).toBeTruthy();
  });

  it('an unlinked project with a remembered conversation opens it, with no link or mapping', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const free = await app.demo.call('projects.create', { body: { name: 'Free', roots: [] } });
    act(() => { app.runtime.route.getState().selectChatGptUrl(free.id, plain('e')); app.runtime.route.getState().selectProject(free.id); });
    await waitFor(() => expect(lastNavigated(fake)).toBe(plain('e')));
    expect(within(chatgpt()).queryByText('This project has no ChatGPT Project or conversation yet.')).toBeNull();
  });
});

describe('remembering what the person does in the view', () => {
  it('records the pages of the linked ChatGPT Project (a conversation, the project page) and nothing else, per project', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const a = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    const b = await app.demo.call('projects.create', { body: { name: 'Beta', roots: [], chatgptProject: { url: projectPage(SCOPE_B) } } });
    const memory = () => app.runtime.route.getState().chatgptUrlByProject;
    act(() => app.runtime.route.getState().selectProject(a.id));
    await waitFor(() => expect(lastNavigated(fake)).toBe(projectPage(SCOPE_A)));
    act(() => fake.emitView({ url: projectPage(SCOPE_A), status: 'ready' }));
    expect(memory()[a.id]).toBe(projectPage(SCOPE_A));
    act(() => fake.emitView({ url: chatIn(SCOPE_A, '1'), status: 'ready' })); // a conversation, as ChatGPT's own client navigation would reach
    expect(memory()[a.id]).toBe(chatIn(SCOPE_A, '1'));
    for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/settings', chatIn(SCOPE_B, '2'), plain('3'), 'https://auth.openai.com/log-in']) {
      act(() => fake.emitView({ url, status: 'ready' }));
    }
    act(() => fake.emitView({ url: chatIn(SCOPE_A, '4'), status: 'loading' }));
    act(() => fake.emitView({ url: chatIn(SCOPE_A, '4'), status: 'login_required' }));
    expect(memory()[a.id]).toBe(chatIn(SCOPE_A, '1')); // the last good page of Alpha
    expect(memory()[b.id]).toBeUndefined();
  });

  it('does not record the previous project\'s page for the project just selected (the race), then records the page the new project loaded', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const free1 = await app.demo.call('projects.create', { body: { name: 'Free one', roots: [], } });
    const free2 = await app.demo.call('projects.create', { body: { name: 'Free two', roots: [], } });
    const route = () => app.runtime.route.getState();
    act(() => { route().selectChatGptUrl(free1.id, plain('1')); route().selectChatGptUrl(free2.id, plain('2')); route().selectProject(free1.id); });
    await waitFor(() => expect(lastNavigated(fake)).toBe(plain('1')));
    act(() => fake.emitView({ url: plain('1'), status: 'ready' }));
    // The person goes to another conversation of the first project, then selects the second project; the view reports the first
    // project's page again and again until the second project's page has loaded.
    act(() => fake.emitView({ url: plain('5'), status: 'ready' }));
    expect(route().chatgptUrlByProject[free1.id]).toBe(plain('5'));
    act(() => route().selectProject(free2.id));
    await waitFor(() => expect(lastNavigated(fake)).toBe(plain('2')));
    act(() => fake.emitView({ url: plain('5'), status: 'ready' }));
    act(() => fake.emitView({ url: plain('5'), status: 'loading' }));
    expect(route().chatgptUrlByProject[free2.id]).toBe(plain('2')); // untouched: still what it was
    act(() => fake.emitView({ url: plain('2'), status: 'ready' }));
    act(() => fake.emitView({ url: plain('6'), status: 'ready' }));
    expect(route().chatgptUrlByProject[free2.id]).toBe(plain('6'));
    expect(route().chatgptUrlByProject[free1.id]).toBe(plain('5')); // the first project's page was never changed by the second
  });

  it('never creates a project or maps a conversation: visiting conversations changes neither', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const a = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    act(() => app.runtime.route.getState().selectProject(a.id));
    await waitFor(() => expect(lastNavigated(fake)).toBe(projectPage(SCOPE_A)));
    const projects = JSON.stringify(app.runtime.store.getState().projects);
    const conversations = JSON.stringify(app.runtime.store.getState().conversations);
    const calls = vi.spyOn(app.demo, 'call');
    for (const c of ['1', '2', '3']) act(() => fake.emitView({ url: chatIn(SCOPE_A, c), status: 'ready' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(app.runtime.route.getState().chatgptUrlByProject[a.id]).toBe(chatIn(SCOPE_A, '3'));
    expect(JSON.stringify(app.runtime.store.getState().projects)).toBe(projects);
    expect(JSON.stringify(app.runtime.store.getState().conversations)).toBe(conversations);
    expect(calls.mock.calls.map((c) => c[0]).filter((name) => /^(projects|conversations)\.(create|add|update|remove|delete)/.test(name as string))).toEqual([]);
  });
});

describe('a page that belongs to another project', () => {
  it('is not remembered for the project on screen when it is another project\'s mapped conversation (a handoff opened it in the view on screen)', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const owner = await app.demo.call('projects.create', { body: { name: 'Owner', roots: [] } });
    await app.demo.call('conversations.add', { params: { id: owner.id }, body: { url: plain('a') } });
    const other = await app.demo.call('projects.create', { body: { name: 'Other', roots: [] } });
    act(() => { app.runtime.route.getState().selectChatGptUrl(other.id, plain('b')); app.runtime.route.getState().selectProject(other.id); });
    await waitFor(() => expect(lastNavigated(fake)).toBe(plain('b')));
    act(() => fake.emitView({ url: plain('b'), status: 'ready' }));
    act(() => fake.emitView({ url: plain('a'), status: 'ready' }));
    expect(app.runtime.route.getState().chatgptUrlByProject[other.id]).toBe(plain('b'));
    act(() => fake.emitView({ url: plain('c'), status: 'ready' }));
    expect(app.runtime.route.getState().chatgptUrlByProject[other.id]).toBe(plain('c'));
  });
});

describe('the "Open project page" action', () => {
  it('is in the pane header of a linked project and opens the linked project page, which then is the remembered page', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const a = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    act(() => { app.runtime.route.getState().selectChatGptUrl(a.id, chatIn(SCOPE_A, '1')); app.runtime.route.getState().selectProject(a.id); });
    await waitFor(() => expect(lastNavigated(fake)).toBe(chatIn(SCOPE_A, '1')));
    act(() => fake.emitView({ url: chatIn(SCOPE_A, '1'), status: 'ready' }));
    await user.click(within(chatgpt()).getByRole('button', { name: 'Open project page' }));
    await waitFor(() => expect(lastNavigated(fake)).toBe(projectPage(SCOPE_A)));
    act(() => fake.emitView({ url: projectPage(SCOPE_A), status: 'ready' }));
    expect(app.runtime.route.getState().chatgptUrlByProject[a.id]).toBe(projectPage(SCOPE_A));
  });

  it('is not offered for a project without a linked ChatGPT Project', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const free = await app.demo.call('projects.create', { body: { name: 'Free', roots: [] } });
    await app.demo.call('conversations.add', { params: { id: free.id }, body: { url: plain('1') } });
    act(() => app.runtime.route.getState().selectProject(free.id));
    await waitFor(() => expect(lastNavigated(fake)).toBe(plain('1')));
    expect(within(chatgpt()).queryByRole('button', { name: 'Open project page' })).toBeNull();
  });
});

describe('live views: a ChatGPT view for each project', () => {
  const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;

  it('names the project\'s view in every call: its bounds, its state, its navigation', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative({ liveViews: true });
    const app = await renderApp({ native: fake });
    const a = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    act(() => app.runtime.route.getState().selectProject(a.id));
    await waitFor(() => expect(calls(fake.native.chatgpt.navigate).at(-1)).toEqual([projectPage(SCOPE_A), a.id]));
    await waitFor(() => expect(fake.boundsOf(a.id)).toBeTruthy());
    expect(calls(fake.native.chatgpt.getState).every((c) => c.length === 1 || c[0] === undefined)).toBe(true);
    expect(calls(fake.native.chatgpt.getState).some((c) => c[0] === a.id)).toBe(true);
  });

  it('hides the view of the project that was left and shows the view of the project selected, without closing anything', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative({ liveViews: true });
    const app = await renderApp({ native: fake });
    const a = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    const b = await app.demo.call('projects.create', { body: { name: 'Beta', roots: [], chatgptProject: { url: projectPage(SCOPE_B) } } });
    act(() => app.runtime.route.getState().selectProject(a.id));
    await waitFor(() => expect(fake.boundsOf(a.id)).toBeTruthy());
    act(() => app.runtime.route.getState().selectProject(b.id));
    await waitFor(() => expect(fake.boundsOf(b.id)).toBeTruthy());
    await waitFor(() => expect(fake.boundsOf(a.id)).toBeNull());
    expect(fake.native.chatgpt.setOverlayActive).not.toHaveBeenCalled();
  });

  it('leaves a project\'s live view as it is when the project is selected again (no navigation), and loads the remembered page into a view that has none', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative({ liveViews: true });
    const app = await renderApp({ native: fake });
    const a = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    const b = await app.demo.call('projects.create', { body: { name: 'Beta', roots: [], chatgptProject: { url: projectPage(SCOPE_B) } } });
    const route = () => app.runtime.route.getState();
    act(() => route().selectProject(a.id));
    await waitFor(() => expect(calls(fake.native.chatgpt.navigate).at(-1)).toEqual([projectPage(SCOPE_A), a.id]));
    act(() => fake.emitView({ url: chatIn(SCOPE_A, '1') }, a.id)); // the person is in a conversation of Alpha, with a draft
    expect(route().chatgptUrlByProject[a.id]).toBe(chatIn(SCOPE_A, '1'));
    act(() => route().selectProject(b.id));
    await waitFor(() => expect(calls(fake.native.chatgpt.navigate).at(-1)).toEqual([projectPage(SCOPE_B), b.id]));
    const before = calls(fake.native.chatgpt.navigate).length;
    act(() => route().selectProject(a.id));
    await new Promise((r) => setTimeout(r, 150));
    expect(calls(fake.native.chatgpt.navigate).length).toBe(before); // Alpha's view still has its page: nothing was loaded
    // Alpha's view is unloaded (idle again): selecting it loads the remembered page, not the project page.
    // Beta first settles on its own page (its view is idle, so the pane loads it), so that the order of events does not depend on timing.
    act(() => route().selectProject(b.id));
    await waitFor(() => expect(calls(fake.native.chatgpt.navigate).at(-1)).toEqual([projectPage(SCOPE_B), b.id]));
    await waitFor(() => expect(fake.boundsOf(a.id)).toBeNull());
    act(() => fake.emitView({ url: null, status: 'idle', title: null }, a.id));
    act(() => route().selectProject(a.id));
    await waitFor(() => expect(calls(fake.native.chatgpt.navigate).at(-1)).toEqual([chatIn(SCOPE_A, '1'), a.id]));
  });

  it('records each project\'s pages from its own view only: a page of one project\'s view is never taken for another\'s', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative({ liveViews: true });
    const app = await renderApp({ native: fake });
    const free1 = await app.demo.call('projects.create', { body: { name: 'Free one', roots: [] } });
    const free2 = await app.demo.call('projects.create', { body: { name: 'Free two', roots: [] } });
    const route = () => app.runtime.route.getState();
    act(() => { route().selectChatGptUrl(free1.id, plain('1')); route().selectChatGptUrl(free2.id, plain('2')); route().selectProject(free1.id); });
    await waitFor(() => expect(fake.boundsOf(free1.id)).toBeTruthy());
    act(() => route().selectProject(free2.id));
    await waitFor(() => expect(fake.boundsOf(free2.id)).toBeTruthy());
    act(() => fake.emitView({ url: plain('7') }, free1.id)); // the first project's view reports a page while the second is on screen
    expect(route().chatgptUrlByProject[free2.id]).toBe(plain('2'));
    act(() => fake.emitView({ url: plain('8') }, free2.id));
    expect(route().chatgptUrlByProject[free2.id]).toBe(plain('8'));
  });

  it('says in a toast, with the project\'s name and the page it will reload at, that a view was unloaded and that unsent text is gone', async () => {
    stubWorkspaceGeometry();
    const fake = createFakeNative({ liveViews: true });
    const app = await renderApp({ native: fake });
    const a = await app.demo.call('projects.create', { body: { name: 'Alpha', roots: [], chatgptProject: { url: projectPage(SCOPE_A) } } });
    act(() => { app.runtime.route.getState().selectChatGptUrl(a.id, chatIn(SCOPE_A, '1')); });
    act(() => fake.emitNotice({ kind: 'unloaded', key: a.id, url: chatIn(SCOPE_A, '9') }));
    const expected = `The ChatGPT page of Alpha was unloaded to save memory. Unsent text there is gone; the page will reload at ${chatIn(SCOPE_A, '1')}.`;
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(expected).not.toContain(String.fromCharCode(8212));
  });
});
