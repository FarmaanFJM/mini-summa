import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { createFakeNative, renderApp } from './helpers';

// The activity, reports and settings views belong to another worker: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

afterEach(() => { clearNativeBounds(); });

interface Geometry { area?: { width: number; height: number }; slot?: { x: number; y: number; width: number; height: number } }

/** jsdom has no layout. Give the two measured elements a size and everything else none. */
function geometry(g: Geometry = {}) {
  const area = g.area ?? { width: 1180, height: 860 };
  const slot = g.slot ?? { x: 260, y: 82, width: 590, height: 818 };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = this.classList?.contains('ms-workspace__area') ? { x: 260, y: 44, ...area }
      : this.hasAttribute?.('data-native-slot') ? slot
        : { x: 0, y: 0, width: 0, height: 0 };
    return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => ({}) } as DOMRect;
  });
}

const split = () => document.querySelector('.ms-split') as HTMLElement;
const divider = () => screen.getByRole('separator', { name: 'Resize the ChatGPT and Claude panes' });
// The layout tests look at the layout writes. What the window remembers about itself (the displayed session tab, the selected project)
// is written to the same route, as `ui`, and has its own tests (ui-sync.test.tsx).
const settingsUpdates = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls as unknown[][])
  .filter((c) => c[0] === 'settings.update').map((c) => (c[1] as { body: Record<string, unknown> }).body).filter((body) => !('ui' in body));

describe('orientation', () => {
  it('puts the panes side by side in a wide area and stacks them in a tall one', async () => {
    geometry({ area: { width: 1180, height: 860 } });
    const wide = await renderApp();
    expect(split().classList.contains('ms-split--horizontal')).toBe(true);
    expect(divider().getAttribute('aria-orientation')).toBe('vertical');
    wide.unmount();

    geometry({ area: { width: 640, height: 1100 } });
    await renderApp();
    expect(split().classList.contains('ms-split--vertical')).toBe(true);
    expect(divider().getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('switches at exactly 1.15 times the height', async () => {
    geometry({ area: { width: 1150, height: 1000 } });
    const at = await renderApp();
    expect(split().classList.contains('ms-split--horizontal')).toBe(true);
    at.unmount();
    geometry({ area: { width: 1149, height: 1000 } });
    await renderApp();
    expect(split().classList.contains('ms-split--vertical')).toBe(true);
  });

  it('lets the person override it from the layout menu, and go back to automatic', async () => {
    geometry({ area: { width: 1180, height: 860 } });
    const user = userEvent.setup();
    const app = await renderApp();
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Layout: Automatic' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Stacked' }));
    expect(split().classList.contains('ms-split--vertical')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Layout: Stacked' }));
    expect(screen.getByRole('menuitemradio', { name: 'Stacked' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Automatic' }));
    expect(split().classList.contains('ms-split--horizontal')).toBe(true);
    await waitFor(() => expect(settingsUpdates(spy)).toEqual([{ layout: { orientation: 'auto' } }]), { timeout: 2000 });
  });
});

describe('divider and persisted ratio', () => {
  it('starts from the ratio stored for the current orientation', async () => {
    geometry({ area: { width: 1180, height: 860 } });
    const user = userEvent.setup();
    const app = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Layout: Automatic' }));
    expect(divider().getAttribute('aria-valuenow')).toBe('50');
    app.unmount();
  });

  it('keeps a separate ratio for each orientation', async () => {
    geometry({ area: { width: 1180, height: 860 } });
    const seed = (await import('../../src/renderer/src/dev/demo/seed')).createSeed();
    seed.settings.layout.landscapeRatio = 0.35;
    seed.settings.layout.portraitRatio = 0.7;
    const landscape = await renderApp({ seed });
    expect(divider().getAttribute('aria-valuenow')).toBe('35');
    landscape.unmount();
    geometry({ area: { width: 640, height: 1100 } });
    await renderApp({ seed });
    expect(divider().getAttribute('aria-valuenow')).toBe('70');
  });

  it('sends one debounced settings update with the ratio of the orientation that changed', async () => {
    geometry({ area: { width: 1180, height: 860 } });
    const user = userEvent.setup();
    const app = await renderApp();
    const spy = vi.spyOn(app.demo, 'call');
    divider().focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(divider().getAttribute('aria-valuenow')).toBe('56'); // shown at once
    expect(settingsUpdates(spy)).toEqual([]); // nothing sent yet
    await waitFor(() => expect(settingsUpdates(spy)).toEqual([{ layout: { landscapeRatio: 0.56 } }]), { timeout: 2000 });
  });

  it('uses the portrait key when the panes are stacked', async () => {
    geometry({ area: { width: 640, height: 1100 } });
    const user = userEvent.setup();
    const app = await renderApp();
    const spy = vi.spyOn(app.demo, 'call');
    divider().focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(settingsUpdates(spy)).toEqual([{ layout: { portraitRatio: 0.52 } }]), { timeout: 2000 });
  });

  it('also remembers it locally, so it survives a core that cannot be reached', async () => {
    geometry({ area: { width: 1180, height: 860 } });
    const user = userEvent.setup();
    const app = await renderApp();
    vi.spyOn(app.demo, 'call').mockImplementation(((name: string) => (name === 'settings.update' ? Promise.reject(new Error('offline')) : Promise.resolve(undefined))) as never);
    divider().focus();
    await user.keyboard('{End}');
    expect(JSON.parse(app.storage.getItem('minisumma.layout.v1') ?? '{}')).toMatchObject({ landscapeRatio: 0.85 });
    await new Promise((r) => setTimeout(r, 600)); // the failed save does not undo what the person did
    expect(divider().getAttribute('aria-valuenow')).toBe('85');
  });

  it('never goes beyond 15 to 85 percent', async () => {
    geometry({ area: { width: 1180, height: 860 } });
    const user = userEvent.setup();
    await renderApp();
    divider().focus();
    await user.keyboard('{Home}{ArrowLeft}{ArrowLeft}');
    expect(divider().getAttribute('aria-valuenow')).toBe('15');
    await user.keyboard('{End}{Shift>}{ArrowRight}{/Shift}');
    expect(divider().getAttribute('aria-valuenow')).toBe('85');
  });
});

describe('where the native ChatGPT view goes', () => {
  const lastBounds = (fake: ReturnType<typeof createFakeNative>) => fake.lastBounds();

  it('reports the measured pane body to the native view', async () => {
    geometry({ slot: { x: 260, y: 82, width: 590, height: 818 } });
    const app = await renderApp();
    await waitFor(() => expect(lastBounds(app.fake)).toEqual({ x: 260, y: 82, width: 590, height: 818 }));
  });

  it('tells the rest of the app where the native view is, so floating things can keep clear of it', async () => {
    geometry();
    const { getNativeBounds } = await import('../../src/renderer/src/app/nativeBounds');
    await renderApp();
    await waitFor(() => expect(getNativeBounds()).toEqual({ x: 260, y: 82, width: 590, height: 818 }));
  });

  it('follows a change of layout', async () => {
    geometry({ slot: { x: 260, y: 82, width: 590, height: 818 } });
    const app = await renderApp();
    await waitFor(() => expect(lastBounds(app.fake)).not.toBeNull());
    geometry({ slot: { x: 260, y: 82, width: 400, height: 818 } });
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(lastBounds(app.fake)).toEqual({ x: 260, y: 82, width: 400, height: 818 }));
  });

  it('does not repeat itself when nothing moved', async () => {
    geometry();
    const app = await renderApp();
    await waitFor(() => expect(lastBounds(app.fake)).not.toBeNull());
    const setBounds = app.fake.native.chatgpt.setBounds as ReturnType<typeof vi.fn>;
    const before = setBounds.mock.calls.length;
    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('resize'));
    fireEvent(window, new Event('scroll'));
    await new Promise((r) => setTimeout(r, 50));
    expect(setBounds.mock.calls.length).toBe(before);
  });

  it('hides it (null) when Claude is shown alone, and brings it back with Split', async () => {
    geometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await waitFor(() => expect(lastBounds(app.fake)).not.toBeNull());
    await user.click(screen.getByRole('radio', { name: 'Claude' }));
    await waitFor(() => expect(lastBounds(app.fake)).toBeNull());
    await user.click(screen.getByRole('radio', { name: 'Split' }));
    await waitFor(() => expect(lastBounds(app.fake)).toEqual({ x: 260, y: 82, width: 590, height: 818 }));
  });

  it('hides it on any other view and returns it with the workspace', async () => {
    geometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await waitFor(() => expect(lastBounds(app.fake)).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Reports, 4 waiting for handoff' }));
    await waitFor(() => expect(lastBounds(app.fake)).toBeNull());
    await user.click(screen.getByRole('button', { name: /^GitManager/ }));
    await waitFor(() => expect(lastBounds(app.fake)).not.toBeNull());
  });

  it('hides it for a project that has no conversation and no linked ChatGPT Project, where there is nothing to show', async () => {
    geometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await waitFor(() => expect(lastBounds(app.fake)).not.toBeNull());
    await user.click(screen.getByRole('button', { name: /^Docs site/ }));
    await waitFor(() => expect(lastBounds(app.fake)).toBeNull());
    expect(screen.getByText('This project has no ChatGPT Project or conversation yet.')).toBeTruthy();
  });

  it('hides it for good when the pane unmounts', async () => {
    geometry();
    const app = await renderApp();
    await waitFor(() => expect(lastBounds(app.fake)).not.toBeNull());
    app.unmount();
    expect(lastBounds(app.fake)).toBeNull();
  });
});

describe('the ChatGPT pane', () => {
  it('names the conversation and lets the person switch between the project\'s conversations', async () => {
    geometry();
    const user = userEvent.setup();
    const app = await renderApp();
    const select = screen.getByRole('button', { name: 'Conversation' });
    expect(select.textContent).toContain('Release planning');
    await user.click(select);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Release planningPreferred', 'Code review notes']);
    await user.click(screen.getByRole('option', { name: 'Code review notes' }));
    expect(app.fake.native.chatgpt.navigate).toHaveBeenLastCalledWith(expect.stringContaining('/g/g-p-6720aa11bb22cc33/c/0b9c8d7e'));
    expect(screen.getByRole('button', { name: 'Conversation' }).textContent).toContain('Code review notes');
  });

  it('loads the mapped conversation when a project is shown, and not again for the same one', async () => {
    geometry();
    const user = userEvent.setup();
    const app = await renderApp();
    const navigate = app.fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/c/6f1a2b3c')));
    const before = navigate.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /^Atlas API/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/c/3a4b5c6d')));
    await user.click(screen.getByRole('button', { name: /^GitManager/ }));
    await waitFor(() => expect(navigate).toHaveBeenLastCalledWith(expect.stringContaining('/c/6f1a2b3c')));
    expect(navigate.mock.calls.length).toBe(before + 2);
  });

  it('does not reload a page the view is already showing', async () => {
    geometry();
    const fake = createFakeNative({ view: { url: 'https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', title: 'Release planning' } });
    await renderApp({ native: fake });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.native.chatgpt.navigate).not.toHaveBeenCalled();
  });

  it('follows the view when it shows another of the project\'s conversations (a handoff opened it)', async () => {
    geometry();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conversation' }).textContent).toContain('Release planning'));
    act(() => fake.emitView({ url: 'https://chatgpt.com/g/g-p-6720aa11bb22cc33/c/0b9c8d7e-6f5a-4b4c-9d3e-2f1a0b9c8d7e', status: 'ready' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conversation' }).textContent).toContain('Code review notes'));
  });

  it('says when the view shows a page that is not mapped to the project, and offers the two honest actions', async () => {
    geometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await waitFor(() => expect(fake.native.chatgpt.onState).toHaveBeenCalled());
    act(() => fake.emitView({ url: 'https://chatgpt.com/c/99999999-9999-4999-8999-999999999999', status: 'ready' }));
    const note = await screen.findByText(/This page is not one of GitManager's conversations/);
    expect(note.textContent).toContain('Handoffs still go to the one you mapped');
    expect(screen.getByRole('button', { name: 'Back to Release planning' })).toBeTruthy();
    const navigate = fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>;
    navigate.mockClear();
    await user.click(screen.getByRole('button', { name: 'Back to Release planning' }));
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/c/6f1a2b3c'));

    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Add to GitManager' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('conversations.add', { params: { id: IDS.gitManager }, body: { url: 'https://chatgpt.com/c/99999999-9999-4999-8999-999999999999' } }));
    // Once mapped, the page is one of the project's conversations and the note goes away.
    await waitFor(() => expect(screen.queryByText(/This page is not one of GitManager's conversations/)).toBeNull());
  });

  it('shows the view\'s state in plain language: loading, sign in, security check, blocked, error', async () => {
    geometry();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await waitFor(() => expect(fake.native.chatgpt.onState).toHaveBeenCalled());
    act(() => fake.emitView({ status: 'loading' }));
    expect(await screen.findByText('Loading ChatGPT.')).toBeTruthy();
    act(() => fake.emitView({ status: 'login_required', note: null }));
    expect(await screen.findByText('ChatGPT needs you to sign in. Sign in here, in this pane.')).toBeTruthy();
    act(() => fake.emitView({ status: 'challenge', note: 'A security check is showing.' }));
    expect(await screen.findByText('A security check is showing.')).toBeTruthy();
    act(() => fake.emitView({ status: 'blocked', note: null }));
    expect(await screen.findByText(/refused to open in this view/)).toBeTruthy();
    act(() => fake.emitView({ status: 'error', note: null }));
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    act(() => fake.emitView({ status: 'ready' }));
    await waitFor(() => expect(screen.queryByText(/could not be loaded/)).toBeNull());
  });

  it('has working navigation controls that follow what the view can do', async () => {
    geometry();
    const user = userEvent.setup();
    const fake = createFakeNative({ view: { canGoBack: true, canGoForward: false } });
    await renderApp({ native: fake });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await user.click(screen.getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.chatgpt.back).toHaveBeenCalled();
    expect(fake.native.chatgpt.reload).toHaveBeenCalled();
    expect(fake.native.shell.openExternal).toHaveBeenCalledWith(expect.stringContaining('chatgpt.com/c/6f1a2b3c'));
  });

  it('offers to add a conversation, or to link a ChatGPT Project, when the project has neither', async () => {
    geometry();
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: /^Docs site/ }));
    await user.click(screen.getByRole('button', { name: 'Add a conversation' }));
    expect(screen.getByRole('dialog', { name: 'Docs site settings' })).toBeTruthy();
  });
});

describe('without the embedded view', () => {
  it('in external mode, says ChatGPT opens in the browser and lists the mapped conversations with Open buttons', async () => {
    geometry();
    const user = userEvent.setup();
    const seed = (await import('../../src/renderer/src/dev/demo/seed')).createSeed();
    seed.settings.chatgpt.mode = 'external';
    const fake = createFakeNative();
    const app = await renderApp({ seed, native: fake });
    expect(await screen.findByRole('heading', { name: 'ChatGPT opens in your browser' })).toBeTruthy();
    expect(screen.getByText(/never reads or writes in the page/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Mapped conversations' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Release planningPreferredOpen', 'Code review notesOpen']);
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Open Release planning' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('conversations.open', { params: { id: IDS.c.gmRelease } }));
    expect(fake.lastBounds()).toBeNull();
    expect(fake.native.chatgpt.navigate).not.toHaveBeenCalled();
  });

  it('with no desktop host, says the embedded view is only in the desktop app', async () => {
    geometry();
    const fake = createFakeNative({ embedded: false });
    await renderApp({ native: fake });
    expect(await screen.findByRole('heading', { name: 'ChatGPT opens in your browser' })).toBeTruthy();
    expect(screen.getByText('The embedded ChatGPT view is only available in the desktop app.')).toBeTruthy();
    expect(fake.native.chatgpt.setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ width: 590 }));
  });

  it('falls back to the system browser when the host could not open it', async () => {
    geometry();
    const user = userEvent.setup();
    const fake = createFakeNative({ embedded: false });
    const app = await renderApp({ native: fake });
    vi.spyOn(app.demo, 'call').mockImplementation(((name: string) => (name === 'conversations.open'
      ? Promise.resolve({ ok: false, mode: 'none', opened: false, focused: false, verified: null, finalUrl: null, title: null, note: 'No browser host is available.' })
      : Promise.resolve(undefined))) as never);
    await user.click(await screen.findByRole('button', { name: 'Open Release planning' }));
    await waitFor(() => expect(fake.native.shell.openExternal).toHaveBeenCalledWith(expect.stringContaining('chatgpt.com/c/6f1a2b3c')));
  });
});

describe('navigation from outside (a notification, a deep link)', () => {
  it('opens a project and the session a notification names', async () => {
    geometry();
    const app = await renderApp();
    act(() => app.fake.navigate({ view: 'workspace', projectId: IDS.atlas, sessionKey: IDS.s.atlasIdle as never }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas API' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /e1f2a3b4/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('finds the project from the session alone', async () => {
    geometry();
    const app = await renderApp();
    act(() => app.fake.navigate({ view: 'workspace', sessionKey: IDS.s.gmPermission as never }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /b7c8d9e0/ }).getAttribute('aria-selected')).toBe('true'));
  });

  it('switches to the reports and settings views', async () => {
    geometry();
    const app = await renderApp();
    act(() => app.fake.navigate({ view: 'reports', reportId: 'rpt_gm_1' }));
    expect(await screen.findByRole('region', { name: 'Reports' })).toBeTruthy();
    expect(app.runtime.route.getState()).toMatchObject({ view: 'reports', reportId: 'rpt_gm_1' });
    act(() => app.fake.navigate({ view: 'settings', section: 'Phone' }));
    expect(await screen.findByRole('region', { name: 'Settings' })).toBeTruthy();
  });

  it('remembers the last selection between runs', async () => {
    geometry();
    const user = userEvent.setup();
    const first = await renderApp();
    await user.click(screen.getByRole('button', { name: /^Atlas API/ }));
    const storage = first.storage;
    first.unmount();
    first.runtime.dispose();
    await renderApp({ storage });
    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas API' })).toBeTruthy();
  });
});
