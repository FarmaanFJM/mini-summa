// The quick switcher: Ctrl+Shift+P from anywhere, or the search entry of the sidebar, then a filter, the arrow keys, Enter.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@minisumma/shared';
import { filterProjects, isQuickSwitcherChord } from '../../src/renderer/src/features/shell/QuickSwitcher';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { renderApp } from './helpers';

// The other views belong to the feature worker: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

const CHORD = '{Control>}{Shift>}p{/Shift}{/Control}';
const switcher = () => screen.getByRole('dialog', { name: 'Switch project' });
const filter = () => within(switcher()).getByRole('combobox', { name: 'Search projects' });
const options = () => within(switcher()).getAllByRole('option');
const optionNames = () => options().map((o) => o.querySelector('.ms-quick__name')?.textContent);
const active = () => options().filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.querySelector('.ms-quick__name')?.textContent);

describe('the chord', () => {
  it('is Ctrl+Shift+P and nothing else, so the plain Ctrl+letter chords stay with Claude\'s terminal', () => {
    const e = (over: Partial<KeyboardEvent>) => ({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...over });
    expect(isQuickSwitcherChord(e({}))).toBe(true);
    expect(isQuickSwitcherChord(e({ key: 'p' }))).toBe(true);
    expect(isQuickSwitcherChord(e({ shiftKey: false, key: 'p' }))).toBe(false); // Ctrl+P
    expect(isQuickSwitcherChord(e({ key: 'k', code: 'KeyK', shiftKey: false }))).toBe(false); // Ctrl+K
    expect(isQuickSwitcherChord(e({ key: 'K', code: 'KeyK' }))).toBe(false); // Ctrl+Shift+K
    expect(isQuickSwitcherChord(e({ altKey: true }))).toBe(false);
    expect(isQuickSwitcherChord(e({ metaKey: true }))).toBe(false);
    expect(isQuickSwitcherChord(e({ ctrlKey: false }))).toBe(false);
  });
});

describe('filtering', () => {
  const p = (name: string, githubRepo: string | null, paths: string[] = []) => ({ id: name, name, githubRepo, roots: paths.map((path) => ({ path })) }) as unknown as Project;
  const list = [p('GitManager', 'acme/git-manager', ['C:\\Dev\\GitManager']), p('Atlas API', 'acme/atlas-api'), p('Docs site', null, ['/home/me/docs'])];

  it('matches every word against the name, the repository or a folder, in any case, and keeps the sidebar order', () => {
    expect(filterProjects(list, '').map((x) => x.name)).toEqual(['GitManager', 'Atlas API', 'Docs site']);
    expect(filterProjects(list, 'ATLAS').map((x) => x.name)).toEqual(['Atlas API']);
    expect(filterProjects(list, 'acme').map((x) => x.name)).toEqual(['GitManager', 'Atlas API']);
    expect(filterProjects(list, 'acme api').map((x) => x.name)).toEqual(['Atlas API']);
    expect(filterProjects(list, 'docs me').map((x) => x.name)).toEqual(['Docs site']);
    expect(filterProjects(list, 'dev git').map((x) => x.name)).toEqual(['GitManager']);
    expect(filterProjects(list, 'nothing like it')).toEqual([]);
  });
});

describe('the quick switcher', () => {
  it('opens with Ctrl+Shift+P, focuses the filter, lists the projects, and starts on the project the person is in', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull();
    await user.keyboard(CHORD);
    expect(switcher()).toBeTruthy();
    expect(document.activeElement).toBe(filter());
    expect(optionNames()).toEqual(['GitManager', 'Atlas API', 'Docs site', 'Trading dashboard']);
    expect(active()).toEqual(['GitManager']);
    expect(filter().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(within(switcher()).getByRole('listbox', { name: 'Projects' })).toBeTruthy();
  });

  it('shows which projects have a session that needs the person, and which one this is', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard(CHORD);
    const byName = (name: string) => options().find((o) => o.querySelector('.ms-quick__name')?.textContent === name)!;
    expect(within(byName('GitManager')).getByRole('img', { name: 'Needs your attention' })).toBeTruthy();
    expect(within(byName('Trading dashboard')).getByRole('img', { name: 'Needs your attention' })).toBeTruthy();
    expect(within(byName('Atlas API')).queryByRole('img', { name: 'Needs your attention' })).toBeNull();
    expect(within(byName('Docs site')).queryByRole('img', { name: 'Needs your attention' })).toBeNull();
    // The same facts a screen reader gets in the sidebar.
    expect(byName('Trading dashboard').getAttribute('aria-label')).toBe('Trading dashboard, 1 live session, needs your attention');
  });

  it('moves with the arrow keys (and wraps), and Enter switches to the project and closes', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await user.keyboard(CHORD);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(active()).toEqual(['Docs site']);
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}'); // Atlas API, GitManager, then around to the last one
    expect(active()).toEqual(['Trading dashboard']);
    await user.keyboard('{ArrowDown}'); // and around to the first again
    expect(active()).toEqual(['GitManager']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull();
    expect(app.runtime.route.getState().projectId).toBe(IDS.atlas);
    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas API' })).toBeTruthy();
  });

  it('filters as the person types, puts the first match under the cursor, and Enter picks it', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await user.keyboard(CHORD);
    await user.type(filter(), 'trad');
    expect(optionNames()).toEqual(['Trading dashboard']);
    expect(active()).toEqual(['Trading dashboard']);
    await user.keyboard('{Enter}');
    expect(app.runtime.route.getState().projectId).toBe(IDS.dashboard);
  });

  it('finds a project by its repository, and says plainly when nothing matches (Enter then does nothing)', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await user.keyboard(CHORD);
    await user.type(filter(), 'acme/atlas');
    expect(optionNames()).toEqual(['Atlas API']);
    await user.clear(filter());
    await user.type(filter(), 'zzz');
    expect(within(switcher()).queryAllByRole('option')).toHaveLength(0);
    expect(within(switcher()).getByText('No project matches.')).toBeTruthy();
    const before = app.runtime.route.getState().projectId;
    await user.keyboard('{Enter}');
    expect(switcher()).toBeTruthy(); // still open
    expect(app.runtime.route.getState().projectId).toBe(before);
  });

  it('closes on Escape without switching, and hands the keyboard back to where it was', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const before = app.runtime.route.getState().projectId;
    const search = screen.getByRole('button', { name: 'Search projects' });
    search.focus();
    await user.keyboard(CHORD);
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull();
    expect(app.runtime.route.getState().projectId).toBe(before);
    expect(document.activeElement).toBe(search);
  });

  it('switches on a click, and is opened by the search entry of the sidebar as well', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const search = screen.getByRole('button', { name: 'Search projects' });
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+P');
    expect(search.textContent).toContain('Ctrl+Shift+P'); // the shortcut is shown where the person looks for it
    await user.click(search);
    await user.click(options().find((o) => o.querySelector('.ms-quick__name')?.textContent === 'Docs site')!);
    expect(app.runtime.route.getState().projectId).toBe(IDS.docs);
    expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull();
  });

  it('toggles: the chord a second time closes it', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard(CHORD);
    expect(switcher()).toBeTruthy();
    await user.keyboard(CHORD);
    expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull();
  });

  it('ignores Ctrl+K, Ctrl+P and the other chords, which belong to the terminal', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('{Control>}p{/Control}');
    await user.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');
    await user.keyboard('{Control>}{Alt>}{Shift>}p{/Shift}{/Alt}{/Control}');
    expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull();
  });

  it('takes the chord before anything else on the page sees it, so the terminal never gets it', async () => {
    const user = userEvent.setup();
    await renderApp();
    const seen = vi.fn();
    document.addEventListener('keydown', seen); // where a terminal's own handler would be
    await user.keyboard(CHORD);
    document.removeEventListener('keydown', seen);
    const chordSeen = seen.mock.calls.filter(([e]) => (e as KeyboardEvent).ctrlKey && (e as KeyboardEvent).shiftKey && (e as KeyboardEvent).code === 'KeyP');
    expect(chordSeen).toHaveLength(0);
    expect(switcher()).toBeTruthy();
  });

  it('does not stack on a dialog that is already asking for a decision', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeTruthy();
    await user.keyboard(CHORD);
    expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('works with the sidebar collapsed, and from another view it brings the person to the project\'s workspace', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    act(() => app.runtime.route.getState().setView('activity'));
    await user.keyboard(CHORD);
    await user.type(filter(), 'atlas');
    await user.keyboard('{Enter}');
    expect(app.runtime.route.getState()).toMatchObject({ view: 'workspace', projectId: IDS.atlas });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch project' })).toBeNull());
  });

  it('starts clean each time it opens', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard(CHORD);
    await user.type(filter(), 'atlas');
    await user.keyboard('{Escape}');
    await user.keyboard(CHORD);
    expect((filter() as HTMLInputElement).value).toBe('');
    expect(optionNames()).toHaveLength(4);
  });
});
