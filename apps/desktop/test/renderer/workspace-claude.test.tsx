// The Claude pane's two ways to start: local (needs a folder) and cloud (needs a GitHub repository), and the Cloud tab that shows
// Claude Code on the web. One is never started in place of the other, and one that cannot start says why.
import { claudeCodeUrl, teleportCommand } from '@minisumma/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';
import { CLOUD_LINE, CLOUD_LINE_BROWSER, CLOUD_NEEDS_REPOSITORY, LOCAL_NEEDS_FOLDER } from '../../src/renderer/src/features/workspace/claudeCloud';
import type { RenderedApp } from './helpers';
import { createFakeNative, renderApp, stubWorkspaceGeometry } from './helpers';

// The activity, reports and settings views belong to other workers: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

afterEach(() => { clearNativeBounds(); vi.restoreAllMocks(); });

// Pages of Claude Code on the web, built from their parts and made up: the publish guard refuses a literal session address.
const page = (segment: string, tail = ''): string => `https://claude.ai/code/${segment}${tail}`;
const SESSION = page('session_abc123');
const OTHER_SESSION = page('session_xyz789');
const START = (repo: string) => claudeCodeUrl({ repo });

const claude = () => screen.getByRole('region', { name: 'Claude' });
const inClaude = () => within(claude());
const cloudTab = () => inClaude().getByRole('tab', { name: /^Cloud/ });
const plus = () => inClaude().getByRole('button', { name: 'New session' });
const primaries = () => [...claude().querySelectorAll('.sm-btn--primary')].map((b) => b.textContent);

const FOLDER = [{ path: 'C:\\Dev\\folder' }];
interface Combo { label: string; name: string; roots: { path: string }[]; repo?: string; local: boolean; cloud: boolean; fix: string | null }
const COMBOS: Combo[] = [
  { label: 'no folder and no repository', name: 'Nothing', roots: [], local: false, cloud: false, fix: 'Add a folder or a GitHub repository' },
  { label: 'a folder only', name: 'Folder', roots: FOLDER, local: true, cloud: false, fix: 'Add a GitHub repository' },
  { label: 'a repository only', name: 'Repo', roots: [], repo: 'acme/repo', local: false, cloud: true, fix: 'Add a folder' },
  { label: 'a folder and a repository', name: 'Both', roots: FOLDER, repo: 'acme/both', local: true, cloud: true, fix: null },
];

async function openProject(app: RenderedApp, user: ReturnType<typeof userEvent.setup>, c: Pick<Combo, 'name' | 'roots' | 'repo'>) {
  await app.demo.call('projects.create', { body: { name: c.name, githubRepo: c.repo, roots: c.roots } });
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${c.name}(,|$)`) }));
  await screen.findByRole('heading', { level: 1, name: c.name });
}

const startCalls = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls as unknown[][]).filter((c) => c[0] === 'sessions.start');

describe('the + menu', () => {
  it.each(COMBOS)('offers a local and a cloud session as two entries, each with its reason when it cannot start: $label', async (c) => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await openProject(app, user, c);
    await user.click(plus());
    const menu = screen.getByRole('menu', { name: 'New session' });
    const local = within(menu).getByRole('menuitem', { name: 'New local session' }) as HTMLButtonElement;
    const cloud = within(menu).getByRole('menuitem', { name: 'New cloud session' }) as HTMLButtonElement;
    expect(local.disabled).toBe(!c.local);
    expect(cloud.disabled).toBe(!c.cloud);
    // The reason is in words, on the entry itself, and only for the entry that cannot start.
    expect(within(menu).queryByText(LOCAL_NEEDS_FOLDER) !== null).toBe(!c.local);
    expect(within(menu).queryByText(CLOUD_NEEDS_REPOSITORY) !== null).toBe(!c.cloud);
    expect(local.getAttribute('aria-describedby') !== null).toBe(!c.local);
    // The fix is one click away: the project settings.
    const fix = c.fix ? within(menu).getByRole('menuitem', { name: c.fix }) : null;
    expect(within(menu).queryAllByRole('menuitem', { name: /^Add a / })).toHaveLength(c.fix ? 1 : 0);
    if (fix) {
      expect((fix as HTMLButtonElement).disabled).toBe(false);
      await user.click(fix);
      expect(await screen.findByRole('dialog', { name: `${c.name} settings` })).toBeTruthy();
    }
  });

  it('puts the entries to resume after them, under a heading', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: /^Atlas API/ }));
    await user.click(plus());
    const items = within(screen.getByRole('menu', { name: 'New session' })).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items[0]).toBe('New local session');
    expect(items[1]).toBe('New cloud session');
    expect(items.at(-1)).toMatch(/^f0e1d2c3, WSL \(Ubuntu\)/);
  });
});

describe('local and cloud are never swapped', () => {
  it('starts a local session for "New local session", in the folder, and never touches the Claude Code view', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const calls = vi.spyOn(app.demo, 'call');
    await openProject(app, user, COMBOS[3]);
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'New local session' }));
    await waitFor(() => expect(startCalls(calls)).toHaveLength(1));
    expect(startCalls(calls)[0][1]).toMatchObject({ body: { mode: 'new', rootId: expect.stringContaining('_root') } });
    expect(fake.native.claudeWeb!.navigate).not.toHaveBeenCalled();
    expect(fake.lastClaudeBounds()).toBeUndefined();
    await waitFor(() => expect(inClaude().getAllByRole('tab', { name: /^Session / })).toHaveLength(1));
    expect(cloudTab().getAttribute('aria-selected')).toBe('false');
  });

  it('opens the Cloud tab on the start page of the repository for "New cloud session", and starts nothing locally', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const calls = vi.spyOn(app.demo, 'call');
    await openProject(app, user, COMBOS[3]);
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'New cloud session' }));
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledWith(START('acme/both')));
    expect(START('acme/both')).toBe('https://claude.ai/code?repositories=acme/both'); // only the repository is preselected, nothing is submitted
    expect(startCalls(calls)).toHaveLength(0);
    expect(cloudTab().getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
  });

  it('does nothing, and says no more than the entry already says, when a disabled entry is pressed', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const calls = vi.spyOn(app.demo, 'call');
    await openProject(app, user, COMBOS[2]); // a repository, no folder
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'New local session' }));
    expect(startCalls(calls)).toHaveLength(0);
    expect(screen.queryByText(/Add a repository folder first/)).toBeNull(); // no toast any more
    expect(fake.native.claudeWeb!.navigate).not.toHaveBeenCalled();
    expect(cloudTab().getAttribute('aria-selected')).toBe('false');
  });

  it('has no Cloud tab for a project without a repository, and nothing to start in the cloud', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await openProject(app, user, COMBOS[1]); // a folder, no repository
    expect(inClaude().queryByRole('tab', { name: /^Cloud/ })).toBeNull();
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'New cloud session' }));
    expect(fake.native.claudeWeb!.navigate).not.toHaveBeenCalled();
    expect(inClaude().queryByRole('tab', { name: /^Cloud/ })).toBeNull();
  });

  it('asks which folder for a local session when the project has several, and the cloud needs no folder', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: /^Trading dashboard/ }));
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'New local session' }));
    const dialog = await screen.findByRole('dialog', { name: 'New local session' });
    expect(startCalls(calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(startCalls(calls)).toHaveLength(1));
  });
});

describe('a Claude pane with no session tab', () => {
  it.each(COMBOS)('has one main action, the right one, and says why the other cannot start: $label', async (c) => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await openProject(app, user, c);
    const body = claude().querySelector('.ms-claude__empty') as HTMLElement;
    expect(body).toBeTruthy();
    expect(primaries()).toHaveLength(1);
    const local = within(body).queryByRole('button', { name: 'New local session' }) as HTMLButtonElement | null;
    const cloud = within(body).queryByRole('button', { name: 'New cloud session' }) as HTMLButtonElement | null;
    if (!c.local && !c.cloud) {
      expect(local).toBeNull();
      expect(cloud).toBeNull();
      expect(primaries()).toEqual(['Add a folder or a GitHub repository']);
      await user.click(within(body).getByRole('button', { name: 'Add a folder or a GitHub repository' }));
      expect(await screen.findByRole('dialog', { name: `${c.name} settings` })).toBeTruthy();
      return;
    }
    expect(local!.disabled).toBe(!c.local);
    expect(cloud!.disabled).toBe(!c.cloud);
    expect(primaries()).toEqual([c.local ? 'New local session' : 'New cloud session']); // local when there is a folder, else cloud
    const why = body.querySelector('.ms-claude__why');
    if (c.fix) {
      expect(why?.textContent).toContain(c.local ? CLOUD_NEEDS_REPOSITORY : LOCAL_NEEDS_FOLDER);
      await user.click(within(body).getByRole('button', { name: c.fix }));
      expect(await screen.findByRole('dialog', { name: `${c.name} settings` })).toBeTruthy();
    } else {
      expect(why).toBeNull();
    }
  });

  it.each(COMBOS)('is a few words and two buttons, not a paragraph: $label', async (c) => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await openProject(app, user, c);
    const body = claude().querySelector('.ms-claude__empty') as HTMLElement;
    expect((body.textContent ?? '').length).toBeLessThan(170);
    expect(body.querySelectorAll('p').length).toBeLessThanOrEqual(2);
    expect(body.querySelectorAll('button').length).toBeLessThanOrEqual(3);
  });

  it('opens the Cloud tab on the start page from "New cloud session", and starts nothing locally', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const calls = vi.spyOn(app.demo, 'call');
    await openProject(app, user, COMBOS[3]);
    await user.click(within(claude().querySelector('.ms-claude__empty') as HTMLElement).getByRole('button', { name: 'New cloud session' }));
    expect(startCalls(calls)).toHaveLength(0);
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledWith(START('acme/both')));
    expect(cloudTab().getAttribute('aria-selected')).toBe('true');
    expect(claude().querySelector('.ms-claude__empty')).toBeNull();
  });

  it('starts a local session from "New local session", and never opens the Claude Code view', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const calls = vi.spyOn(app.demo, 'call');
    await openProject(app, user, COMBOS[3]);
    await user.click(within(claude().querySelector('.ms-claude__empty') as HTMLElement).getByRole('button', { name: 'New local session' }));
    await waitFor(() => expect(startCalls(calls)).toHaveLength(1));
    expect(startCalls(calls)[0][1]).toMatchObject({ body: { mode: 'new' } });
    expect(fake.native.claudeWeb!.navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(inClaude().getAllByRole('tab', { name: /^Session / })).toHaveLength(1));
    expect(cloudTab().getAttribute('aria-selected')).toBe('false');
  });

  it('shows the Cloud tab beside the buttons, not selected, for a project with a repository', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await openProject(app, user, COMBOS[2]);
    expect(cloudTab().getAttribute('aria-selected')).toBe('false');
    expect(claude().querySelector('.ms-claude__empty')).toBeTruthy();
    expect(inClaude().queryByRole('tabpanel')).toBeNull(); // nothing is shown yet, so there is no panel
  });
});

describe('the Cloud tab', () => {
  it('is there for a project with a GitHub repository, after its sessions, and cannot be closed', async () => {
    stubWorkspaceGeometry();
    await renderApp();
    const tabs = inClaude().getAllByRole('tab').map((t) => t.getAttribute('aria-label'));
    expect(tabs.at(-1)).toBe('Cloud, Claude Code on the web');
    expect(tabs.slice(0, -1).every((t) => t?.startsWith('Session '))).toBe(true);
    expect(inClaude().queryByRole('button', { name: /^Close tab Cloud/ })).toBeNull();
    expect(inClaude().getAllByRole('button', { name: /^Close tab / })).toHaveLength(2); // the two sessions only
  });

  it('is not there for a project without a repository and without a remembered page, and comes with a remembered page', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp();
    await user.click(screen.getByRole('button', { name: /^Docs site/ }));
    await screen.findByRole('heading', { level: 1, name: 'Docs site' });
    expect(inClaude().queryByRole('tab', { name: /^Cloud/ })).toBeNull();
    act(() => app.runtime.route.getState().selectCloudUrl(IDS.docs, SESSION));
    expect(await inClaude().findByRole('tab', { name: /^Cloud/ })).toBeTruthy();
    act(() => app.runtime.route.getState().selectCloudUrl(IDS.docs, null));
    await waitFor(() => expect(inClaude().queryByRole('tab', { name: /^Cloud/ })).toBeNull());
  });

  it('shows the page, one row of controls and the one honest line, and no session terminal', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await user.click(cloudTab());
    const panel = inClaude().getByRole('tabpanel', { name: /^Cloud/ });
    expect(cloudTab().getAttribute('aria-selected')).toBe('true');
    expect(within(panel).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Back', 'Forward', 'Reload', 'Open in your browser']);
    expect(within(panel).getByText(CLOUD_LINE)).toBeTruthy();
    expect(CLOUD_LINE).toMatch(/notifications/);
    expect(CLOUD_LINE.match(/\./g)).toHaveLength(1); // one sentence
    expect(panel.querySelector('.ms-term')).toBeNull();
    expect(document.querySelector('.ms-input')).toBeNull(); // "Input goes to" belongs to a terminal
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    // ... and the person's own session tabs are still there to go back to.
    expect(inClaude().getAllByRole('tab', { name: /^Session / })).toHaveLength(2);
  });

  it('opens the start page of the repository the first time', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledWith(START('acme/git-manager')));
  });

  it('tells the Claude Code view where it is only while the tab is the one shown, and tells it nothing before', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    expect(fake.lastClaudeBounds()).toBeUndefined();
    await user.click(cloudTab());
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    await user.click(inClaude().getAllByRole('tab', { name: /^Session / })[0]);
    await waitFor(() => expect(fake.lastClaudeBounds()).toBeNull());
    await user.click(cloudTab());
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    await user.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    await waitFor(() => expect(fake.lastClaudeBounds()).toBeNull());
  });

  it('follows the slot when the layout moves it, and hides the view for good when the pane goes', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    vi.restoreAllMocks();
    stubWorkspaceGeometry({ claude: { x: 900, y: 170, width: 480, height: 700 } });
    act(() => { window.dispatchEvent(new Event('resize')); });
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual({ x: 900, y: 170, width: 480, height: 700 }));
    app.unmount();
    expect(fake.lastClaudeBounds()).toBeNull();
  });

  it('leaves the Cloud tab for a session when a session tab is chosen, and goes back to the one that was shown before', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp({ native: createFakeNative() });
    await user.click(inClaude().getByRole('tab', { name: /^Session b7c8d9e0/ }));
    await user.click(cloudTab());
    expect(cloudTab().getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.ms-input')).toBeNull();
    await user.click(inClaude().getByRole('tab', { name: /^Session b7c8d9e0/ }));
    expect(cloudTab().getAttribute('aria-selected')).toBe('false');
    expect(document.querySelector('.ms-input')?.textContent).toContain('b7c8d9e0');
  });

  it('leaves the Cloud tab for the session a notification names, even the one that was chosen before', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await user.click(inClaude().getByRole('tab', { name: /^Session b7c8d9e0/ }));
    await user.click(cloudTab());
    act(() => app.fake.navigate({ view: 'workspace', projectId: IDS.gitManager, sessionKey: IDS.s.gmPermission as never }));
    await waitFor(() => expect(cloudTab().getAttribute('aria-selected')).toBe('false'));
    expect(inClaude().getByRole('tab', { name: /^Session b7c8d9e0/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('is chosen for each project on its own, and kept when the person looks at another project', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp({ native: createFakeNative() });
    await user.click(cloudTab());
    await user.click(screen.getByRole('button', { name: /^Atlas API/ }));
    expect(cloudTab().getAttribute('aria-selected')).toBe('false'); // Atlas API has its own choice
    await user.click(screen.getByRole('button', { name: /^GitManager/ }));
    expect(cloudTab().getAttribute('aria-selected')).toBe('true');
  });

  it('is in memory only: the window opens on the last local session again after a restart', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const first = await renderApp({ native: createFakeNative(), storage });
    await user.click(cloudTab());
    expect(cloudTab().getAttribute('aria-selected')).toBe('true');
    first.unmount();
    first.runtime.dispose();
    await renderApp({ native: createFakeNative(), storage });
    expect(cloudTab().getAttribute('aria-selected')).toBe('false');
    expect(inClaude().getByRole('tab', { name: /^Session a1b2c3d4/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('goes away when the repository is removed from the project, and the pane shows a local session again', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await user.click(cloudTab());
    await act(async () => { await app.demo.call('projects.update', { params: { id: IDS.gitManager }, body: { githubRepo: null } }); });
    await waitFor(() => expect(inClaude().queryByRole('tab', { name: /^Cloud/ })).toBeNull());
    expect(app.runtime.route.getState().cloudShown[IDS.gitManager]).toBeUndefined();
    expect(inClaude().getByRole('tab', { name: /^Session a1b2c3d4/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the controls of the Cloud tab', () => {
  async function cloud(over: Parameters<typeof createFakeNative>[0] = {}) {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative(over);
    const app = await renderApp({ native: fake });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    return { user, fake, app, panel: () => inClaude().getByRole('tabpanel', { name: /^Cloud/ }) };
  }

  it('goes back and forward only where the page can, reloads, and opens the page in the browser', async () => {
    const { user, fake, panel } = await cloud();
    const back = () => within(panel()).getByRole('button', { name: 'Back' }) as HTMLButtonElement;
    const forward = () => within(panel()).getByRole('button', { name: 'Forward' }) as HTMLButtonElement;
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(true);
    act(() => fake.emitClaudeView({ url: SESSION, canGoBack: true, canGoForward: false }));
    await waitFor(() => expect(back().disabled).toBe(false));
    expect(forward().disabled).toBe(true);
    await user.click(back());
    await user.click(within(panel()).getByRole('button', { name: 'Reload' }));
    expect(fake.native.claudeWeb!.back).toHaveBeenCalledTimes(1);
    expect(fake.native.claudeWeb!.reload).toHaveBeenCalledTimes(1);
    act(() => fake.emitClaudeView({ canGoForward: true }));
    await waitFor(() => expect(forward().disabled).toBe(false));
    await user.click(forward());
    expect(fake.native.claudeWeb!.forward).toHaveBeenCalledTimes(1);
    await user.click(within(panel()).getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenLastCalledWith(SESSION);
  });

  it('opens the start page in the browser when the view is not on a page of Claude Code, such as a sign in page', async () => {
    const { user, fake, panel } = await cloud();
    act(() => fake.emitClaudeView({ url: 'https://accounts.example.org/signin', status: 'login_required' }));
    await user.click(within(panel()).getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenLastCalledWith(START('acme/git-manager'));
  });

  it('shows the address of the page, cut short, without the scheme or the query', async () => {
    const { fake, panel } = await cloud();
    expect(panel().querySelector('.ms-cloud__address')).toBeNull();
    act(() => fake.emitClaudeView({ url: page('session_abc123', '?utm=1#top') }));
    const address = await waitFor(() => { const el = panel().querySelector('.ms-cloud__address') as HTMLElement; expect(el).toBeTruthy(); return el; });
    expect(address.textContent).toBe(SESSION.replace('https://', ''));
    expect(address.className).toContain('ms-truncate');
    expect(address.getAttribute('title')).toContain('session_abc123');
  });

  it('offers to copy the command that continues a cloud session in a terminal, and only for a session', async () => {
    const { user, fake, panel } = await cloud();
    const copy = () => within(panel()).queryByRole('button', { name: 'Copy command to continue in a terminal' });
    act(() => fake.emitClaudeView({ url: claudeCodeUrl({ repo: 'acme/git-manager' }) }));
    expect(copy()).toBeNull(); // the start page is not a session
    act(() => fake.emitClaudeView({ url: SESSION }));
    await waitFor(() => expect(copy()).toBeTruthy());
    await user.click(copy()!);
    expect(fake.native.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(fake.native.clipboard.writeText).toHaveBeenCalledWith('claude --teleport session_abc123');
    expect(teleportCommand('session_abc123')).toBe('claude --teleport session_abc123');
    act(() => fake.emitClaudeView({ url: page('code-review') }));
    await waitFor(() => expect(copy()).toBeNull()); // another page of Claude Code on the web
  });

  it('says in plain words that the page asks to sign in, and what to do, then goes away when the page is ready', async () => {
    const { fake, panel } = await cloud();
    expect(within(panel()).queryByRole('status')).toBeNull();
    act(() => fake.emitClaudeView({ status: 'login_required', note: null }));
    const note = await within(panel()).findByRole('status');
    expect(note.textContent).toContain('asking you to sign in');
    expect(note.textContent).toContain('Sign in on the page');
    expect(note.textContent).toContain('If Google sign in is refused here, use Open in your browser');
    expect(note.textContent).not.toMatch(/will work|works in/i); // no claim that was not tested
    act(() => fake.emitClaudeView({ status: 'ready' }));
    await waitFor(() => expect(within(panel()).queryByRole('status')).toBeNull());
  });

  it('says it when the page was blocked, or could not be loaded, with the way on', async () => {
    const { fake, panel } = await cloud();
    act(() => fake.emitClaudeView({ status: 'blocked', note: null }));
    expect((await within(panel()).findByRole('status')).textContent).toBe('Claude Code on the web could not be shown in this tab. Use Open in your browser.');
    act(() => fake.emitClaudeView({ status: 'error', note: null }));
    await waitFor(() => expect(within(panel()).getByRole('status').textContent).toBe('Claude Code on the web could not be loaded. Check your connection, then reload.'));
    expect(within(panel()).getByRole('status').getAttribute('data-tone')).toBe('error');
  });

  it('puts the host\'s own reason first, because it knows why', async () => {
    const { fake, panel } = await cloud();
    act(() => fake.emitClaudeView({ status: 'login_required', note: 'Claude asked for a new sign in.' }));
    const note = await within(panel()).findByRole('status');
    expect(note.textContent?.startsWith('Claude asked for a new sign in. Sign in on the page.')).toBe(true);
    expect(note.textContent).not.toContain('is asking you to sign in');
  });

  it('shows no notice while the page loads, only a busy mark beside the address', async () => {
    const { fake, panel } = await cloud();
    act(() => fake.emitClaudeView({ status: 'loading', url: SESSION }));
    await waitFor(() => expect(panel().querySelector('.ms-cloud__busy')).toBeTruthy());
    expect(within(panel()).queryByRole('status')).toBeNull();
    act(() => fake.emitClaudeView({ status: 'ready' }));
    await waitFor(() => expect(panel().querySelector('.ms-cloud__busy')).toBeNull());
  });
});

describe('where the host cannot embed Claude Code on the web', () => {
  it('offers to open it in the browser, through the shell, with the repository preselected, and says why it is not embedded', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative({ embedded: false });
    await renderApp({ native: fake });
    expect(fake.native.claudeWeb).toBeUndefined();
    await user.click(cloudTab());
    const panel = inClaude().getByRole('tabpanel', { name: /^Cloud/ });
    expect(within(panel).getByText(/runs in a browser, which cannot embed Claude Code on the web/)).toBeTruthy();
    expect(panel.querySelector('[data-native-slot]')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Open Claude Code on the web in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenCalledWith('https://claude.ai/code?repositories=acme/git-manager');
    expect(within(panel).getByText(CLOUD_LINE_BROWSER)).toBeTruthy();
    expect(fake.lastClaudeBounds()).toBeUndefined();
  });

  it('says so for a desktop app that cannot do it yet, and opens the page the person was last on', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative({ claudeWeb: false });
    const app = await renderApp({ native: fake });
    act(() => app.runtime.route.getState().selectCloudUrl(IDS.gitManager, SESSION));
    await user.click(cloudTab());
    const panel = inClaude().getByRole('tabpanel', { name: /^Cloud/ });
    expect(within(panel).getByText('This build of the desktop app cannot embed Claude Code on the web yet.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Open Claude Code on the web in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenCalledWith(SESSION);
  });

  it('keeps its one button quiet while another main button is on screen', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp({ native: createFakeNative({ claudeWeb: false }) });
    await user.click(cloudTab());
    const open = within(inClaude().getByRole('tabpanel', { name: /^Cloud/ })).getByRole('button', { name: 'Open Claude Code on the web in your browser' });
    // GitManager has a report waiting for its handoff, so the strip holds the main button.
    expect(open.className).not.toContain('sm-btn--primary');
    expect(primaries()).toEqual([]);
  });
});

describe('the page each project was last on', () => {
  const seedWithPage = (project: string, url: string) => {
    const seed = createSeed();
    seed.settings.ui = { perProject: { [project]: { cloudUrl: url } } };
    return seed;
  };

  it('is remembered, as the core remembers the rest of what the window shows, when the view moves to a session', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake, uiSync: { delayMs: 20, retry: { firstMs: 40, maxMs: 80 } } });
    await app.runtime.uiSync.flush();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalled());
    act(() => fake.emitClaudeView({ url: page('session_abc123', '?x=1#top') }));
    await waitFor(() => expect(app.runtime.route.getState().cloudUrlByProject[IDS.gitManager]).toBe(SESSION)); // without the query and the fragment
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.cloudUrl).toBe(SESSION), { timeout: 3000 });
    const writes = (calls.mock.calls as unknown[][]).filter((c) => c[0] === 'settings.update').map((c) => (c[1] as { body: { ui?: { perProject?: Record<string, unknown> } } }).body.ui?.perProject?.[IDS.gitManager]).filter(Boolean);
    expect(writes).toContainEqual(expect.objectContaining({ cloudUrl: SESSION }));
  });

  it('is opened again the next time the tab is shown for that project, instead of the start page', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake, seed: seedWithPage(IDS.gitManager, SESSION), storage: createMemoryStorage() });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledWith(SESSION));
    expect(fake.native.claudeWeb!.navigate).not.toHaveBeenCalledWith(START('acme/git-manager'));
  });

  it('is kept by this window too, so it is there after a restart even before the core has answered', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const first = await renderApp({ native: createFakeNative(), storage });
    act(() => first.runtime.route.getState().selectCloudUrl(IDS.gitManager, SESSION));
    first.unmount();
    first.runtime.dispose();
    const fake = createFakeNative();
    await renderApp({ native: fake, storage });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledWith(SESSION));
  });

  it('opens the start page of the repository again for a remembered start page, which is kept without its query', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake, seed: seedWithPage(IDS.gitManager, 'https://claude.ai/code') });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledWith(START('acme/git-manager')));
  });

  it.each([
    ['another site', 'https://example.com/code/session_abc123'],
    ['a sign in page of the same site', 'https://claude.ai/login?returnTo=%2Fcode'],
    ['a page of Claude that is not Claude Code', 'https://claude.ai/chat/abc123'],
    ['an address that is not https', 'http://claude.ai/code'],
    ['an address with a user name', 'https://someone@claude.ai/code'],
    ['something that is not an address', 'not an address'],
  ])('refuses to remember %s', async (_label, url) => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalled());
    act(() => fake.emitClaudeView({ url }));
    await new Promise((r) => setTimeout(r, 60));
    expect(app.runtime.route.getState().cloudUrlByProject[IDS.gitManager]).toBeUndefined();
    // ... and the next page of Claude Code is remembered as usual, so refusing did not switch the memory off.
    act(() => fake.emitClaudeView({ url: SESSION }));
    await waitFor(() => expect(app.runtime.route.getState().cloudUrlByProject[IDS.gitManager]).toBe(SESSION));
  });

  it('is forgotten with a project that is removed', async () => {
    stubWorkspaceGeometry();
    const app = await renderApp({ seed: seedWithPage(IDS.docs, SESSION), storage: createMemoryStorage() });
    expect(app.runtime.route.getState().cloudUrlByProject[IDS.docs]).toBe(SESSION);
    await act(async () => { await app.demo.call('projects.remove', { params: { id: IDS.docs }, query: { mode: 'delete' } }); });
    await waitFor(() => expect(app.runtime.route.getState().cloudUrlByProject[IDS.docs]).toBeUndefined());
  });

  it('is shown to the view again when the person goes back to a project: one view for the window, each project\'s own page', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const seed = createSeed();
    seed.settings.ui = { perProject: { [IDS.gitManager]: { cloudUrl: SESSION }, [IDS.atlas]: { cloudUrl: OTHER_SESSION } } };
    const app = await renderApp({ native: fake, seed });
    const navigate = fake.native.claudeWeb!.navigate as ReturnType<typeof vi.fn>;
    const lastNavigation = () => navigate.mock.calls.at(-1)?.[0];

    await user.click(cloudTab());
    await waitFor(() => expect(lastNavigation()).toBe(SESSION));
    act(() => fake.emitClaudeView({ url: SESSION }));

    await user.click(screen.getByRole('button', { name: /^Atlas API/ }));
    await user.click(cloudTab());
    await waitFor(() => expect(lastNavigation()).toBe(OTHER_SESSION));
    // The view still reports the page it is leaving for a moment: that is not Atlas API's page.
    act(() => fake.emitClaudeView({ url: SESSION }));
    await new Promise((r) => setTimeout(r, 60));
    expect(app.runtime.route.getState().cloudUrlByProject[IDS.atlas]).toBe(OTHER_SESSION);
    act(() => fake.emitClaudeView({ url: OTHER_SESSION }));

    await user.click(screen.getByRole('button', { name: /^GitManager/ }));
    await waitFor(() => expect(lastNavigation()).toBe(SESSION));
    expect(navigate.mock.calls.map((c) => c[0])).toEqual([SESSION, OTHER_SESSION, SESSION]);
    expect(app.runtime.route.getState().cloudUrlByProject).toMatchObject({ [IDS.gitManager]: SESSION, [IDS.atlas]: OTHER_SESSION });
  });

  it('does not load a page again that the view is already showing for this project', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake, seed: seedWithPage(IDS.gitManager, SESSION) });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledTimes(1));
    act(() => fake.emitClaudeView({ url: OTHER_SESSION })); // the person went on in the page
    await user.click(inClaude().getAllByRole('tab', { name: /^Session / })[0]);
    await user.click(cloudTab());
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.native.claudeWeb!.navigate).toHaveBeenCalledTimes(1); // it stays on the page the person went to
  });

  it('"New cloud session" opens the start page even when a session was remembered, and the next time the tab opens there', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake, seed: seedWithPage(IDS.gitManager, SESSION) });
    await user.click(cloudTab());
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenLastCalledWith(SESSION));
    act(() => fake.emitClaudeView({ url: SESSION }));
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'New cloud session' }));
    await waitFor(() => expect(fake.native.claudeWeb!.navigate).toHaveBeenLastCalledWith(START('acme/git-manager')));
    expect(app.runtime.route.getState().cloudStart[IDS.gitManager]).toBeUndefined(); // asked once, done once
    act(() => fake.emitClaudeView({ url: SESSION })); // still the page being left
    act(() => fake.emitClaudeView({ url: 'https://claude.ai/code' }));
    await waitFor(() => expect(app.runtime.route.getState().cloudUrlByProject[IDS.gitManager]).toBe('https://claude.ai/code'));
  });
});
