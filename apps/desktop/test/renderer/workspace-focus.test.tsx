// The slim workspace header: the project's name with its places, and the "Workspace view" control (Split, ChatGPT, Claude). Showing one
// pane alone must only hide the other one: its terminals keep their output and processes, and its native views keep their pages.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { createSeed } from '../../src/renderer/src/dev/demo/seed';
import { createFakeNative, renderApp, stubWorkspaceGeometry } from './helpers';

// The activity, reports and settings views belong to other workers: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

afterEach(() => { clearNativeBounds(); vi.restoreAllMocks(); });

const group = () => screen.getByRole('radiogroup', { name: 'Workspace view' });
const radio = (name: string) => within(group()).getByRole('radio', { name });
const chatgptPane = () => screen.getByRole('region', { name: 'ChatGPT', hidden: true }).closest('.ms-split__pane') as HTMLElement;
const claudePane = () => screen.getByRole('region', { name: 'Claude', hidden: true }).closest('.ms-split__pane') as HTMLElement;
const checked = () => within(group()).getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);
const layoutWrites = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls as unknown[][])
  .filter((c) => c[0] === 'settings.update').map((c) => (c[1] as { body: { layout?: unknown } }).body).filter((b) => b.layout !== undefined).map((b) => b.layout);
const ctrlShift = (key: string) => `{Control>}{Shift>}{${key}}{/Shift}{/Control}`;

describe('the header', () => {
  it('names the project in the one h1, with the whole name in its title', async () => {
    stubWorkspaceGeometry();
    await renderApp();
    const h1 = screen.getByRole('heading', { level: 1, name: 'GitManager' });
    expect(h1.getAttribute('title')).toBe('GitManager');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('is one line of the project, the view control, the project settings and the layout, in that order', async () => {
    stubWorkspaceGeometry();
    await renderApp();
    const bar = document.querySelector('.ms-wsbar') as HTMLElement;
    expect(bar.tagName).toBe('HEADER');
    const identity = bar.querySelector('.ms-wsbar__identity') as HTMLElement;
    const tools = bar.querySelector('.ms-wsbar__tools') as HTMLElement;
    expect(within(identity).getByRole('heading', { level: 1 })).toBeTruthy();
    const names = [...within(tools).getAllByRole('radio').map((r) => r.textContent ?? ''), ...within(tools).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')];
    expect(names).toEqual(['Split', 'ChatGPT', 'Claude', 'GitManager settings', 'Layout: Automatic']);
  });

  it('shows the repository and the first folder as quiet buttons that do what they say', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    const repo = screen.getByRole('button', { name: 'Open acme/git-manager on GitHub' });
    expect(repo.textContent).toBe('acme/git-manager');
    await user.click(repo);
    expect(fake.native.shell.openExternal).toHaveBeenCalledWith('https://github.com/acme/git-manager');
    const folder = screen.getByRole('button', { name: /^Show the folder C:\\Dev\\GitManager$/ });
    expect(folder.textContent).toBe('C:\\Dev\\GitManager');
    await user.click(folder);
    expect(fake.native.shell.showItemInFolder).toHaveBeenCalledWith('C:\\Dev\\GitManager');
  });

  it('says what each of them does in a tooltip', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    await user.hover(screen.getByRole('button', { name: 'Open acme/git-manager on GitHub' }));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Open acme/git-manager on GitHub');
    await user.unhover(screen.getByRole('button', { name: 'Open acme/git-manager on GitHub' }));
    await user.hover(screen.getByRole('button', { name: /^Show the folder / }));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Show the folder');
  });

  it('shows no folder and no label for a project that has none, and no repository for one without', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await app.demo.call('projects.create', { body: { name: 'Bare', roots: [] } });
    await user.click(await screen.findByRole('button', { name: /^Bare(,|$)/ }));
    await screen.findByRole('heading', { level: 1, name: 'Bare' });
    const bar = document.querySelector('.ms-wsbar') as HTMLElement;
    expect(bar.querySelector('.ms-wsbar__places')).toBeNull();
    expect(bar.textContent).not.toMatch(/No folder|No repository|folder yet/i);
    // A project with a folder and no repository shows only the folder.
    await user.click(screen.getByRole('button', { name: /^Docs site/ }));
    await screen.findByRole('heading', { level: 1, name: 'Docs site' });
    expect(screen.queryByRole('button', { name: /on GitHub$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Show the folder C:\\Dev\\docs-site$/ })).toBeTruthy();
  });

  it('says how many more folders there are, when there are several', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: /^Trading dashboard/ }));
    await screen.findByRole('heading', { level: 1, name: 'Trading dashboard' });
    expect(screen.getByRole('button', { name: /^Show the folder C:\\Dev\\dashboard$/ })).toBeTruthy();
    expect((document.querySelector('.ms-wsbar__more') as HTMLElement).textContent).toBe('+1');
  });

  it('shows the folder as plain text where a folder cannot be shown (a browser)', async () => {
    stubWorkspaceGeometry();
    await renderApp({ native: createFakeNative({ embedded: false }) });
    expect(screen.queryByRole('button', { name: /^Show the folder/ })).toBeNull();
    expect(within(document.querySelector('.ms-wsbar') as HTMLElement).getByText('C:\\Dev\\GitManager')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open acme/git-manager on GitHub' })).toBeTruthy(); // a browser can still open a page
  });

  it('opens the project settings from the pencil, and the layout menu from its button', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Layout: Automatic' }));
    expect(screen.getByRole('menu', { name: 'Layout' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'GitManager settings' }));
    expect(await screen.findByRole('dialog', { name: 'GitManager settings' })).toBeTruthy();
  });
});

describe('the "Workspace view" control', () => {
  it('has Split, ChatGPT and Claude as one choice, with Split chosen to begin with', async () => {
    stubWorkspaceGeometry();
    await renderApp();
    expect(within(group()).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Split', 'ChatGPT', 'Claude']);
    expect(checked()).toEqual(['Split']);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
  });

  it('shows ChatGPT alone, Claude alone, or both, and saves the choice in the layout', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    const spy = vi.spyOn(app.demo, 'call');
    expect(chatgptPane().hasAttribute('hidden')).toBe(false);
    expect(claudePane().hasAttribute('hidden')).toBe(false);

    await user.click(radio('Claude'));
    expect(checked()).toEqual(['Claude']);
    expect(chatgptPane().hasAttribute('hidden')).toBe(true);
    expect(claudePane().hasAttribute('hidden')).toBe(false);
    expect(screen.queryByRole('separator', { name: 'Resize the ChatGPT and Claude panes' })).toBeNull();

    await user.click(radio('ChatGPT'));
    expect(checked()).toEqual(['ChatGPT']);
    expect(chatgptPane().hasAttribute('hidden')).toBe(false);
    expect(claudePane().hasAttribute('hidden')).toBe(true);

    await user.click(radio('Split'));
    expect(checked()).toEqual(['Split']);
    expect(chatgptPane().hasAttribute('hidden')).toBe(false);
    expect(claudePane().hasAttribute('hidden')).toBe(false);
    expect(screen.getByRole('separator', { name: 'Resize the ChatGPT and Claude panes' })).toBeTruthy();

    // One request, with the last choice: null is Split.
    await waitFor(() => expect(layoutWrites(spy).at(-1)).toEqual({ maximized: null }), { timeout: 2000 });
    await user.click(radio('Claude'));
    await waitFor(() => expect(layoutWrites(spy).at(-1)).toEqual({ maximized: 'claude' }), { timeout: 2000 });
    await user.click(radio('ChatGPT'));
    await waitFor(() => expect(layoutWrites(spy).at(-1)).toEqual({ maximized: 'chatgpt' }), { timeout: 2000 });
  });

  it('keeps the choice for the window: it opens on the pane that was shown alone', async () => {
    stubWorkspaceGeometry();
    const seed = createSeed();
    seed.settings.layout.maximized = 'claude';
    await renderApp({ seed });
    expect(checked()).toEqual(['Claude']);
    expect(chatgptPane().hasAttribute('hidden')).toBe(true);
  });

  it('no longer has a button on each pane to maximise it, or one to show both', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    const none = () => screen.queryAllByRole('button', { name: /maximize|restore .* pane|show both panes/i });
    expect(none()).toEqual([]);
    await user.click(radio('Claude'));
    expect(none()).toEqual([]);
    await user.click(radio('ChatGPT'));
    expect(none()).toEqual([]);
  });

  it('is a radio group: the arrow keys move and choose, Home and End jump, and only the chosen one is in the tab order', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    expect(radio('Split').tabIndex).toBe(0);
    expect(radio('ChatGPT').tabIndex).toBe(-1);
    radio('Split').focus();
    await user.keyboard('{ArrowRight}');
    expect(checked()).toEqual(['ChatGPT']);
    expect(document.activeElement).toBe(radio('ChatGPT'));
    await user.keyboard('{ArrowRight}');
    expect(checked()).toEqual(['Claude']);
    await user.keyboard('{ArrowRight}');
    expect(checked()).toEqual(['Split']); // wraps
    await user.keyboard('{ArrowLeft}');
    expect(checked()).toEqual(['Claude']);
    await user.keyboard('{Home}');
    expect(checked()).toEqual(['Split']);
    await user.keyboard('{End}');
    expect(checked()).toEqual(['Claude']);
  });

  it('shows the shortcut in the tooltip of the two panes', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    await user.hover(radio('ChatGPT'));
    expect((await screen.findByRole('tooltip')).textContent).toContain('Ctrl+Shift+Left');
    await user.unhover(radio('ChatGPT'));
    await user.hover(radio('Claude'));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain('Ctrl+Shift+Right'));
  });

  it('still answers Ctrl+Shift+arrow, the same key again shows both, and the control follows', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard(ctrlShift('ArrowRight'));
    expect(checked()).toEqual(['Claude']);
    await user.keyboard(ctrlShift('ArrowRight'));
    expect(checked()).toEqual(['Split']);
    await user.keyboard(ctrlShift('ArrowLeft'));
    expect(checked()).toEqual(['ChatGPT']);
    await user.keyboard(ctrlShift('ArrowUp'));
    expect(checked()).toEqual(['Split']);
    await user.keyboard(ctrlShift('ArrowDown'));
    expect(checked()).toEqual(['Claude']);
    await user.keyboard(ctrlShift('ArrowLeft'));
    expect(checked()).toEqual(['ChatGPT']); // from one pane straight to the other
  });
});

describe('showing one pane never closes the other', () => {
  it('keeps the terminal of the hidden Claude pane: the same emulator, not disposed, not opened again', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await waitFor(() => expect(app.adapters.size).toBe(1));
    const adapter = [...app.adapters.values()][0];
    expect(adapter.openCount).toBe(1);
    await user.click(radio('ChatGPT'));
    expect(adapter.disposed).toBe(false);
    expect(claudePane().querySelector('.ms-term')).toBeTruthy(); // still in the page, only not displayed
    await user.click(radio('Split'));
    await user.click(radio('Claude'));
    await user.click(radio('Split'));
    expect(adapter.disposed).toBe(false);
    expect(adapter.openCount).toBe(1);
    expect(app.created).toHaveLength(1);
  });

  it('tells the ChatGPT view it has no place only while Claude is alone, and never reloads, closes or sends it anywhere', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await waitFor(() => expect(fake.lastBounds()).toEqual({ x: 260, y: 82, width: 590, height: 818 }));
    const navigate = fake.native.chatgpt.navigate as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const navigations = navigate.mock.calls.length;

    await user.click(radio('Claude'));
    await waitFor(() => expect(fake.lastBounds()).toBeNull());
    await user.click(radio('ChatGPT'));
    await waitFor(() => expect(fake.lastBounds()).toEqual({ x: 260, y: 82, width: 590, height: 818 })); // it has its place when it is the one shown
    await user.click(radio('Claude'));
    await waitFor(() => expect(fake.lastBounds()).toBeNull());
    await user.click(radio('Split'));
    await waitFor(() => expect(fake.lastBounds()).toEqual({ x: 260, y: 82, width: 590, height: 818 }));

    expect(navigate.mock.calls.length).toBe(navigations);
    for (const call of ['reload', 'back', 'forward'] as const) expect(fake.native.chatgpt[call]).not.toHaveBeenCalled();
  });

  it('tells the Claude Code view it has no place while ChatGPT is alone, and gives it back its place and its page on Split', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await user.click(screen.getByRole('tab', { name: /^Cloud/ }));
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    const navigate = fake.native.claudeWeb!.navigate as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));

    await user.click(radio('ChatGPT'));
    await waitFor(() => expect(fake.lastClaudeBounds()).toBeNull());
    await user.click(radio('Split'));
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    await user.click(radio('Claude'));
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude)); // alone, it is shown
    await user.click(radio('ChatGPT'));
    await waitFor(() => expect(fake.lastClaudeBounds()).toBeNull());

    expect(navigate).toHaveBeenCalledTimes(1); // the page stayed where it was: nothing was sent to it, nothing reloaded
    for (const call of ['reload', 'back', 'forward'] as const) expect(fake.native.claudeWeb![call]).not.toHaveBeenCalled();
  });

  it('keeps what the pane that is not shown knows: the Cloud tab is still the one chosen when it comes back', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp({ native: createFakeNative() });
    await user.click(screen.getByRole('tab', { name: /^Cloud/ }));
    await user.click(radio('ChatGPT'));
    await user.click(radio('Claude'));
    expect(screen.getByRole('tab', { name: /^Cloud/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('hides both native views when the workspace itself is not the view, and brings them back', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await user.click(screen.getByRole('tab', { name: /^Cloud/ }));
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    await user.click(screen.getByRole('button', { name: 'Reports, 4 waiting for handoff' }));
    await waitFor(() => expect(fake.lastBounds()).toBeNull());
    await waitFor(() => expect(fake.lastClaudeBounds()).toBeNull());
    await user.click(screen.getByRole('button', { name: /^GitManager/ }));
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    await waitFor(() => expect(fake.lastBounds()).toEqual(places.chatgpt));
  });
});

describe('the workspace at the sizes it has to work at', () => {
  it('lays the panes out side by side in a wide area and stacked in a tall one, with the same header', async () => {
    stubWorkspaceGeometry({ area: { width: 1180, height: 860 } });
    const wide = await renderApp();
    expect(document.querySelector('.ms-split--horizontal')).toBeTruthy();
    expect(within(group()).getAllByRole('radio')).toHaveLength(3);
    wide.unmount();
    vi.restoreAllMocks();
    stubWorkspaceGeometry({ area: { width: 640, height: 1100 } });
    await renderApp();
    expect(document.querySelector('.ms-split--vertical')).toBeTruthy();
    expect(within(group()).getAllByRole('radio')).toHaveLength(3);
  });
});
