// First run: the checklist over an empty application. Every tick is read from the core, the panel never blocks the
// application underneath, and Settings brings it back.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import { createEmptySeed } from '../../src/renderer/src/dev/demo/seed';
import { createFakeNative } from './helpers';
import { callsTo, renderFeature, textOf } from './features-helpers';

const KEY = 'minisumma.onboarding.v1';
type Options = Parameters<typeof renderFeature>[0];

const emptyApp = (options: Options = {}) => renderFeature({ seed: createEmptySeed(), view: 'workspace', gate: true, ...options });
const panel = () => screen.getByRole('region', { name: 'Set up Mini-Summa' });
const steps = () => within(panel()).getByRole('list', { name: 'Setup steps' });
const step = (name: RegExp) => within(steps()).getByRole('heading', { level: 3, name }).closest('li') as HTMLElement;
const isDone = (name: RegExp) => /^Done: /.test(textOf(within(step(name)).getByRole('heading', { level: 3 })));
const place = () => (panel().closest('.ms-onb-layer') as HTMLElement).getAttribute('data-place');
const saved = (storage: { getItem(k: string): string | null }) => JSON.parse(storage.getItem(KEY) ?? 'null') as { seenEmpty: boolean; dismissed: boolean } | null;

const URL_ONE = 'https://chatgpt.com/c/6720a0aa-1111-4222-8333-444455556666';

describe('the checklist over an empty application', () => {
  it('appears when there are no projects, ticks what is already true, and says what to do next', async () => {
    await emptyApp();
    await within(await screen.findByRole('region', { name: 'Set up Mini-Summa' })).findByRole('list', { name: 'Setup steps' });
    expect(place()).toBe('center');
    await waitFor(() => expect(isDone(/Claude Code is installed/)).toBe(true));
    expect(textOf(step(/Claude Code is installed/))).toContain('Found in Windows (version 2.1.4) and WSL (Ubuntu) (version 2.1.4).');
    expect(isDone(/Create your first project/)).toBe(false);
    expect(isDone(/Add its ChatGPT conversation/)).toBe(false);
    expect(textOf(step(/Add its ChatGPT conversation/))).toContain('Create a project first.');
    expect(isDone(/Choose how ChatGPT opens/)).toBe(true); // the embedded view is loaded
    expect(isDone(/Install Claude hooks/)).toBe(true); // Windows has them
    expect(textOf(step(/Install Claude hooks/))).toContain('(optional)');
    expect(isDone(/Start a Claude session/)).toBe(false);
    expect(textOf(panel())).toContain('3 of 6 done. You can use Mini-Summa without finishing this.');
    // Only the next step has the main action.
    const create = within(step(/Create your first project/)).getByRole('button', { name: 'Create project' });
    expect(create.className).toContain('sm-btn--primary');
    expect(panel().querySelectorAll('.sm-btn--primary')).toHaveLength(1);
  });

  it('is a panel, not a gate: nothing behind it is inert, and the application underneath still works', async () => {
    const user = userEvent.setup();
    await emptyApp();
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(false);
    expect(panel().closest('[aria-modal]')).toBeNull();
    // The sidebar and the workspace behind it answer as usual.
    expect(screen.getByText('No projects yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('opens the project dialog from its own step', async () => {
    const user = userEvent.setup();
    await emptyApp();
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    await user.click(within(step(/Create your first project/)).getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('follows the real state: a project, its conversation and a session tick their steps, and finishing hides it by itself', async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const app = await emptyApp({ storage });
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    expect(saved(storage)).toEqual({ seenEmpty: true, dismissed: false });

    const project = await app.demo.call('projects.create', { body: { name: 'Mini-Summa', roots: [{ path: 'C:\\code\\mini-summa', env: 'win' }] } });
    await waitFor(() => expect(isDone(/Create your first project/)).toBe(true));
    expect(textOf(step(/Create your first project/))).toContain('Mini-Summa.');
    expect(place()).toBe('corner'); // the application has content now: the checklist steps aside to the corner
    expect(textOf(step(/Add its ChatGPT conversation/))).toContain('Paste the address of the ChatGPT conversation');

    // Its own action opens that project's dialog.
    await user.click(within(step(/Add its ChatGPT conversation/)).getByRole('button', { name: 'Add a conversation to Mini-Summa' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Mini-Summa' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await app.demo.call('conversations.add', { params: { id: project.id }, body: { url: URL_ONE } });
    await waitFor(() => expect(isDone(/Add its ChatGPT conversation/)).toBe(true));
    expect(isDone(/Start a Claude session/)).toBe(false);

    await act(async () => { await app.demo.call('sessions.start', { params: { id: project.id }, body: { mode: 'new' } }); });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Set up Mini-Summa' })).toBeNull());
    expect(saved(storage)).toEqual({ seenEmpty: true, dismissed: true });
  });

  it('keeps the observed sessions of other programs from counting as a session of its own', async () => {
    const app = await emptyApp();
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    const project = await app.demo.call('projects.create', { body: { name: 'Mini-Summa', roots: [{ path: 'C:\\code\\mini-summa', env: 'win' }] } });
    await app.demo.call('conversations.add', { params: { id: project.id }, body: { url: URL_ONE } });
    await waitFor(() => expect(isDone(/Add its ChatGPT conversation/)).toBe(true));
    expect(app.runtime.store.getState().sessions.some((s) => s.origin === 'managed')).toBe(false);
    expect(isDone(/Start a Claude session/)).toBe(false);
    expect(within(step(/Start a Claude session/)).getByRole('button', { name: 'Open Mini-Summa' })).toBeTruthy();
  });
});

describe('Claude Code', () => {
  const withoutClaude = () => {
    const seed = createEmptySeed();
    seed.environments = seed.environments.map((e) => ({ ...e, claude: { path: null, version: null, error: 'claude was not found in PATH.' } }));
    return seed;
  };

  it('is not ticked while it is missing: it says so, gives the exact commands, and Refresh finds it once installed', async () => {
    const user = userEvent.setup();
    const seed = withoutClaude();
    const app = await emptyApp({ seed });
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    await waitFor(() => expect(textOf(step(/Claude Code is installed/))).toContain('Mini-Summa did not find Claude Code in any environment. Install it, then press Refresh.'));
    expect(isDone(/Claude Code is installed/)).toBe(false);
    const card = step(/Claude Code is installed/);
    expect(textOf(card)).toContain('irm https://claude.ai/install.ps1 | iex');
    expect(textOf(card)).toContain('npm install -g @anthropic-ai/claude-code');
    expect(within(card).getByRole('button', { name: 'Refresh' }).className).toContain('sm-btn--primary'); // the next thing to do
    expect(textOf(panel())).toContain('2 of 6 done');

    // The person installs it, then presses Refresh.
    const spy = vi.spyOn(app.demo, 'call');
    app.server.data.environments[0].claude = { path: 'C:\\Users\\dev\\.local\\bin\\claude.exe', version: '2.1.5', error: null };
    await user.click(within(card).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(callsTo(spy, 'environments.list').at(-1)).toEqual({ query: { refresh: true } }));
    await waitFor(() => expect(isDone(/Claude Code is installed/)).toBe(true));
    expect(textOf(step(/Claude Code is installed/))).toContain('Found in Windows (version 2.1.5).');
  });
});

describe('how ChatGPT opens', () => {
  it('says what is wrong when sign-in is needed, with the note about Google, and switches to the browser on request', async () => {
    const user = userEvent.setup();
    const native = createFakeNative({ view: { status: 'login_required' } });
    const app = await emptyApp({ native });
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    await waitFor(() => expect(isDone(/Choose how ChatGPT opens/)).toBe(false));
    const card = () => step(/Choose how ChatGPT opens/);
    await waitFor(() => expect(textOf(card())).toContain('ChatGPT asks you to sign in. Google sign-in is often refused inside embedded browsers.'));

    // The view changes by itself, and the step follows.
    act(() => native.emitView({ status: 'ready' }));
    await waitFor(() => expect(isDone(/Choose how ChatGPT opens/)).toBe(true));
    act(() => native.emitView({ status: 'login_required' }));
    await waitFor(() => expect(isDone(/Choose how ChatGPT opens/)).toBe(false));

    await user.click(within(card()).getByRole('button', { name: 'Use my browser' }));
    await waitFor(() => expect(app.runtime.store.getState().settings?.chatgpt.mode).toBe('external'));
    await waitFor(() => expect(isDone(/Choose how ChatGPT opens/)).toBe(true));
    expect(textOf(card())).toContain('ChatGPT opens in your browser.');
    expect(within(card()).queryByRole('button', { name: 'Use my browser' })).toBeNull();
  });

  it('takes the person to the ChatGPT settings', async () => {
    const user = userEvent.setup();
    const app = await emptyApp();
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    await user.click(within(step(/Choose how ChatGPT opens/)).getByRole('button', { name: 'ChatGPT settings' }));
    expect(app.runtime.route.getState()).toMatchObject({ view: 'settings', section: 'chatgpt' });
  });

  it('says this window cannot show ChatGPT when it is a plain browser, and offers the browser', async () => {
    await emptyApp({ native: createFakeNative({ embedded: false }) });
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    expect(textOf(step(/Choose how ChatGPT opens/))).toContain('This window cannot show ChatGPT inside Mini-Summa. Choose your browser to have it open there.');
    expect(isDone(/Choose how ChatGPT opens/)).toBe(false);
  });
});

describe('hiding it and getting it back', () => {
  it('hides on request, remembers that, and does not come back on the next start', async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const first = await emptyApp({ storage });
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    expect(textOf(panel())).toContain('You can bring this back from Settings, under About and setup.');
    await user.click(within(panel()).getByRole('button', { name: 'Hide the checklist' }));
    expect(screen.queryByRole('region', { name: 'Set up Mini-Summa' })).toBeNull();
    expect(saved(storage)).toEqual({ seenEmpty: true, dismissed: true });
    first.unmount();

    await emptyApp({ storage });
    await screen.findByText('No projects yet.');
    expect(screen.queryByRole('region', { name: 'Set up Mini-Summa' })).toBeNull();
  });

  it('is always in Settings, with a way to put it back on the start screen', async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const app = await emptyApp({ storage });
    await screen.findByRole('region', { name: 'Set up Mini-Summa' });
    await user.click(within(panel()).getByRole('button', { name: 'Hide the checklist' }));

    act(() => app.runtime.route.getState().go({ view: 'settings', section: 'about' }));
    const inline = await screen.findByRole('list', { name: 'Setup steps' });
    await waitFor(() => expect(textOf(within(inline).getAllByRole('heading', { level: 3 })[0])).toMatch(/^Done: Claude Code is installed/));
    await user.click(screen.getByRole('button', { name: 'Show the checklist on the start screen again' }));
    expect(await screen.findByRole('region', { name: 'Set up Mini-Summa' })).toBeTruthy();
    expect(saved(storage)).toEqual({ seenEmpty: true, dismissed: false });
    // And once it is on screen, Settings says so instead of offering it again.
    expect(screen.queryByRole('button', { name: 'Show the checklist on the start screen again' })).toBeNull();
    expect(screen.getByText('This checklist is also shown on the start screen until it is finished or you hide it.')).toBeTruthy();
  });
});

describe('an installation that already has projects', () => {
  it('is never shown the checklist unprompted, and no environment is probed for it', async () => {
    const storage = createMemoryStorage();
    const app = await renderFeature({ view: 'workspace', gate: true, storage });
    await screen.findByRole('button', { name: /^GitManager/ });
    expect(screen.queryByRole('region', { name: 'Set up Mini-Summa' })).toBeNull();
    expect(saved(storage)).toBeNull(); // nothing was recorded either
    expect(app.runtime.store.getState().projects.length).toBeGreaterThan(0);
  });

  it('still has it in Settings, with every step ticked from what exists', async () => {
    const app = await renderFeature({ view: 'settings', route: { section: 'about' }, gate: true });
    const inline = await screen.findByRole('list', { name: 'Setup steps' });
    await waitFor(() => expect(within(inline).getAllByRole('heading', { level: 3 }).map((h) => textOf(h).split(':')[0])).toEqual(['Done', 'Done', 'Done', 'Done', 'Done', 'Done']));
    expect(screen.getByText('Every step that matters is done.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Set up Mini-Summa' })).toBeNull();
    expect(app.runtime.store.getState().sessions.some((s) => s.origin === 'managed')).toBe(true);
  });
});
