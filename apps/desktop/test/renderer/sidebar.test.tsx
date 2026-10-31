import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { dropOrder, moveId, orderBy, sameOrder } from '../../src/renderer/src/features/shell/projectOrder';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { renderApp, until } from './helpers';

// The activity, reports and settings views belong to another worker: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

const row = (name: RegExp | string) => screen.getByRole('button', { name: typeof name === 'string' ? new RegExp(`^${name}(,|$)`) : name });
const MUTATING = /^(sessions\.(start|stop|bind|setDefault)|projects\.(update|remove|create)|conversations\.(add|remove|update|setPreferred)|settings\.update)$/;

describe('sidebar', () => {
  it('lists each project with only the facts that are true', async () => {
    await renderApp();
    expect(row('GitManager').getAttribute('aria-label')).toBe('GitManager, 3 live sessions, needs your attention, 2 reports waiting for handoff');
    expect(row('Atlas API').getAttribute('aria-label')).toBe('Atlas API, 1 live session, 1 report waiting for handoff');
    // A disconnected session is not live, and nothing needs attention: only the waiting report is mentioned.
    expect(row('Docs site').getAttribute('aria-label')).toBe('Docs site, 1 report waiting for handoff');
    // A running background session counts as live; an ended session with an error needs attention; nothing waits for handoff.
    expect(row('Trading dashboard').getAttribute('aria-label')).toBe('Trading dashboard, 1 live session, needs your attention');
  });

  it('shows the attention marker only on projects with a session that needs the person', async () => {
    await renderApp();
    expect(within(row('GitManager')).getByRole('img', { name: 'Needs your attention' })).toBeTruthy();
    expect(within(row('Trading dashboard')).getByRole('img', { name: 'Needs your attention' })).toBeTruthy();
    expect(within(row('Atlas API')).queryByRole('img', { name: 'Needs your attention' })).toBeNull();
    expect(within(row('Docs site')).queryByRole('img', { name: 'Needs your attention' })).toBeNull();
  });

  it('keeps the row clean: the facts are in its name and tooltip, not in icons or numbers inside it', async () => {
    await renderApp();
    for (const name of ['GitManager', 'Atlas API', 'Docs site', 'Trading dashboard']) {
      const r = row(name);
      expect(r.getAttribute('title')).toBe(r.getAttribute('aria-label'));
      expect(r.textContent).toBe(name); // no count, no label, nothing but the name
      expect(r.querySelector('svg')).toBeNull(); // no terminal or report icon
    }
    expect(row('Docs site').getAttribute('title')).toBe('Docs site, 1 report waiting for handoff');
  });

  it('shows the unread and waiting counts at the bottom, and no count for Settings', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: 'Activity, 4 unread' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reports, 4 waiting for handoff' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('marks the selected project and moves the mark when another is chosen', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(row('GitManager').getAttribute('aria-current')).toBe('true');
    await user.click(row('Atlas API'));
    expect(row('Atlas API').getAttribute('aria-current')).toBe('true');
    expect(row('GitManager').getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Atlas API' })).toBeTruthy();
  });

  it('selecting a project never stops, starts, redirects or detaches a session', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await until(() => app.adapters.size === 1, 'the first terminal');
    const calls = vi.spyOn(app.demo, 'call');
    const sessionsBefore = app.runtime.store.getState().sessions;
    const detachBefore = app.runtime.terminals.keys().length;

    await user.click(row('Atlas API'));
    await until(() => app.adapters.size === 2, 'the second terminal');
    await user.click(row('Docs site'));
    await user.click(row('Trading dashboard'));
    await user.click(row('GitManager'));

    expect(calls.mock.calls.map((c) => c[0]).filter((n) => MUTATING.test(n))).toEqual([]);
    // Every session is exactly as it was.
    expect(app.runtime.store.getState().sessions).toBe(sessionsBefore);
    // Both terminals that were shown are still alive, and none was recreated.
    expect(app.runtime.terminals.keys().length).toBeGreaterThanOrEqual(detachBefore);
    expect([...app.adapters.values()].every((a) => !a.disposed && a.openCount === 1)).toBe(true);
    expect(app.created).toHaveLength(2);
  });

  it('returns to the workspace of a project when it is chosen from another view', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Activity, 4 unread' }));
    expect(screen.getByRole('region', { name: 'Activity' })).toBeTruthy();
    await user.click(row('Atlas API'));
    expect(screen.getByRole('heading', { level: 1, name: 'Atlas API' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Activity' })).toBeNull();
  });

  it('opens the project actions from the overflow button, by keyboard, and by right click', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Actions for Atlas API' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Project settings', 'Archive', 'Delete']); // the destructive one is last
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain('sm-menu__item--danger');
    expect(screen.getByRole('menuitem', { name: 'Delete' }).querySelector('svg')).not.toBeNull(); // danger text plus an icon (P19)
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.pointer({ keys: '[MouseRight]', target: row('Docs site') });
    expect(screen.getByRole('menu', { name: 'Actions for Docs site' })).toBeTruthy();
  });

  it('asks for a new project from the New project button, which is a plain button and not an accent', async () => {
    const user = userEvent.setup();
    await renderApp();
    const button = screen.getByRole('button', { name: 'New project' });
    expect(button.className).not.toContain('sm-btn--primary'); // emerald is for the one main action of a view
    await user.click(button);
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('opens project settings from the row menu, with the project the row belongs to', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Actions for Atlas API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Project settings' }));
    expect(app.runtime.ui.getState().projectDialog).toEqual({ mode: 'edit', projectId: IDS.atlas });
  });
});

describe('archiving and deleting', () => {
  it('archive states what is kept, takes the project out of the list, and can be restored', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for Docs site' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive Docs site?' });
    expect(dialog.textContent).toContain('kept');
    expect(dialog.textContent).toContain('1 report');
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Docs site(,|$)/ })).toBeNull());
    expect(calls).toHaveBeenCalledWith('projects.remove', { params: { id: IDS.docs }, query: { mode: 'archive' } });
    expect(app.runtime.store.getState().reports.some((r) => r.projectId === IDS.docs)).toBe(true); // history is kept

    await user.click(await screen.findByRole('button', { name: /Archived/ }));
    await user.click(screen.getByRole('button', { name: 'Restore Docs site' }));
    expect(await screen.findByRole('button', { name: /^Docs site(,|$)/ })).toBeTruthy();
  });

  it('delete is a solid destructive confirmation that says what goes with the project', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for Trading dashboard' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Trading dashboard?' });
    expect(dialog.textContent).toContain('removes the project');
    expect(dialog.textContent).toContain('2 reports');
    expect(dialog.textContent).toContain('2 deliveries');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain('not touched');
    const confirm = within(dialog).getByRole('button', { name: 'Delete project' });
    expect(confirm.className).toContain('sm-btn--danger');
    // Cancel is where focus starts, so Enter cannot delete by accident.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Trading dashboard(,|$)/ })).toBeNull());
    expect(calls).toHaveBeenCalledWith('projects.remove', { params: { id: IDS.dashboard }, query: { mode: 'delete' } });
    expect(app.runtime.store.getState().reports.some((r) => r.projectId === IDS.dashboard)).toBe(false);
  });

  it('cancelling a delete changes nothing', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for Atlas API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.mock.calls.some((c) => c[0] === 'projects.remove')).toBe(false);
    expect(row('Atlas API')).toBeTruthy();
  });

  it('shows why a delete failed and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const original = app.demo.call;
    vi.spyOn(app.demo, 'call').mockImplementation(((name: string, ...rest: unknown[]) => (
      name === 'projects.remove' ? Promise.reject(new Error('The database is locked.')) : (original as (...a: unknown[]) => unknown)(name, ...rest)
    )) as never);
    await user.click(screen.getByRole('button', { name: 'Actions for Atlas API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByText('The database is locked.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

describe('removing a project that has running Claude terminals', () => {
  it('says that its terminals end too, and asks the core to stop them', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for Atlas API' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive Atlas API?' });
    expect(dialog.textContent).toContain('Removing it also ends its running Claude terminal. You can resume the session later.');
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Atlas API(,|$)/ })).toBeNull());
    expect(calls).toHaveBeenCalledWith('projects.remove', { params: { id: IDS.atlas }, query: { mode: 'archive', stopSessions: true } });
    // The terminal was ended, not lost: the session is resumable.
    expect(app.runtime.store.getState().sessions.find((x) => x.key === IDS.s.atlasIdle)?.availability).toBe('resumable');
  });

  it('counts the terminals, and keeps sessions started elsewhere out of it', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for GitManager' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete GitManager?' });
    expect(dialog.textContent).toContain('Removing it also ends its 2 running Claude terminals. You can resume the sessions later.');
    expect(dialog.textContent).toContain('1 session started outside Mini-Summa keeps running.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^GitManager(,|$)/ })).toBeNull());
    expect(calls).toHaveBeenCalledWith('projects.remove', { params: { id: IDS.gitManager }, query: { mode: 'delete', stopSessions: true } });
  });

  it('does not ask for sessions to be stopped when nothing is running there, and does not mention it', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for Trading dashboard' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).not.toContain('terminal');
    expect(dialog.textContent).toContain('1 session started outside Mini-Summa keeps running.'); // the background session
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('projects.remove', { params: { id: IDS.dashboard }, query: { mode: 'delete' } }));
  });

  it('when the core knows of a terminal this window does not, it refuses once, says so, and stops it only on the next confirmation', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    // A terminal the renderer has not been told about (it exists in the core only).
    const template = structuredClone(app.runtime.store.getState().sessions.find((x) => x.key === IDS.s.atlasIdle)!);
    const hidden = { ...template, key: 'win|11111111-2222-4333-8444-555555555555', sessionId: '11111111-2222-4333-8444-555555555555', env: 'win' as const, projectId: IDS.docs, projectName: 'Docs site' };
    app.demo.demo.server.data.sessions.push(hidden as never);

    await user.click(screen.getByRole('button', { name: 'Actions for Docs site' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive Docs site?' });
    expect(dialog.textContent).not.toContain('terminal');
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));

    expect(await within(dialog).findByText(/This project has 1 running Claude terminal/)).toBeTruthy();
    expect(dialog.textContent).toContain('Removing it also ends its running Claude terminal.');
    expect(calls).toHaveBeenLastCalledWith('projects.remove', { params: { id: IDS.docs }, query: { mode: 'archive' } });
    expect(screen.getByRole('button', { name: /^Docs site(,|$)/ })).toBeTruthy(); // nothing was removed

    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Docs site(,|$)/ })).toBeNull());
    expect(calls).toHaveBeenLastCalledWith('projects.remove', { params: { id: IDS.docs }, query: { mode: 'archive', stopSessions: true } });
  });
});

describe('the sidebar before and without data', () => {
  it('shows skeleton rows while loading, not an empty list', async () => {
    await renderApp({ scenario: 'loading' });
    expect(await screen.findByLabelText('Loading projects')).toBeTruthy();
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });

  it('says plainly that there are no projects once it knows', async () => {
    await renderApp({ scenario: 'empty' });
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create project' }).className).toContain('sm-btn--primary');
  });
});

describe('the sidebar as a part of the shell', () => {
  const inOrder = (...nodes: Element[]) => nodes.every((n, i) => i === 0 || (nodes[i - 1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);

  it('is brand, New project, a search entry, one flat list of projects, then Activity, Reports and Settings', async () => {
    await renderApp();
    const side = screen.getByRole('complementary', { name: 'Mini-Summa navigation' });
    expect(within(side).getByText('Mini-Summa')).toBeTruthy();
    const newProject = within(side).getByRole('button', { name: 'New project' });
    const search = within(side).getByRole('button', { name: 'Search projects' });
    const projects = within(side).getByRole('navigation', { name: 'Projects' });
    const sections = within(side).getByRole('navigation', { name: 'Sections' });
    expect(inOrder(newProject, search, projects, sections)).toBe(true);
    // One flat list: no group headings, no nested lists.
    expect(projects.querySelectorAll('ul ul')).toHaveLength(0);
    expect(within(projects).queryAllByRole('heading')).toHaveLength(0);
    expect(within(sections).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Activity, 4 unread', 'Reports, 4 waiting for handoff', 'Settings']);
    // No initials and no avatars: nothing in the sidebar draws a letter in a circle.
    expect(side.querySelector('img:not(.ms-brand__logo), [class*="avatar"]')).toBeNull(); // the brand logo is the only image
  });

  it('marks one place as current: the project only while the workspace is shown, the section otherwise', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(row('GitManager').getAttribute('aria-current')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Activity, 4 unread' }));
    expect(screen.getByRole('button', { name: 'Activity, 4 unread' }).getAttribute('aria-current')).toBe('true');
    expect(within(screen.getByRole('navigation', { name: 'Projects' })).queryAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'true')).toHaveLength(0);
    await user.click(row('Docs site'));
    expect(row('Docs site').getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Activity, 4 unread' }).getAttribute('aria-current')).toBeNull();
  });

  it('collapses to nothing but a tab on the edge (no rail of icons), and the tab brings it back', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.queryByRole('navigation', { name: 'Projects' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    const tab = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(tab.getAttribute('aria-expanded')).toBe('false');
    // The tab is the only control left of the sidebar: no folder icon per project, no initials.
    expect(document.querySelectorAll('.ms-edge button')).toHaveLength(1);
    await user.click(tab);
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).toBeNull();
    expect(row('GitManager')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('tells, on the tab, that a session is waiting for the person while the sidebar is away', async () => {
    const user = userEvent.setup();
    await renderApp(); // GitManager and Trading dashboard have a session that needs the person
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    const tab = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(tab.getAttribute('aria-description')).toBe('A session needs your attention');
    expect(tab.querySelector('.ms-dot--attention')).not.toBeNull();
  });

  it('keeps nothing but the shell\'s own controls in the tab order of a collapsed sidebar', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    const side = document.querySelector('aside[aria-label="Mini-Summa navigation"]') as HTMLElement;
    expect(side.hasAttribute('hidden')).toBe(true); // display none: its buttons are not reachable by Tab or a screen reader
  });
});

describe('putting the projects in order', () => {
  const names = () => within(screen.getByRole('navigation', { name: 'Projects' })).getAllByRole('button').map((b) => (b.getAttribute('aria-label') ?? '').split(',')[0]).filter((n) => n !== '' && !n.startsWith('Actions for'));
  const item = (name: string) => row(name).closest('li') as HTMLElement;
  const dnd = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });
  // jsdom has no DragEvent, so the pointer position is put on the event by hand.
  const dragAt = (kind: 'dragOver' | 'drop', el: HTMLElement, clientY: number) => {
    const event = createEvent[kind](el, { dataTransfer: dnd() });
    Object.defineProperty(event, 'clientY', { value: clientY });
    fireEvent(el, event);
  };

  it('has plain functions for the new order', () => {
    expect(moveId(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveId(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveId(['a', 'b'], 'a', 9)).toEqual(['b', 'a']); // clamped
    expect(moveId(['a', 'b'], 'zzz', 0)).toEqual(['a', 'b']);
    expect(dropOrder(['a', 'b', 'c', 'd'], 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
    expect(dropOrder(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropOrder(['a', 'b', 'c', 'd'], 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropOrder(['a', 'b', 'c'], 'b', 'b', true)).toEqual(['a', 'b', 'c']);
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    const p = (id: string) => ({ id }) as never;
    expect(orderBy([p('a'), p('b'), p('c')], ['c', 'a']).map((x: { id: string }) => x.id)).toEqual(['c', 'a', 'b']); // what the order does not name keeps its place at the end
  });

  it('drops a dragged row before or after the one under the pointer, and tells the core the whole order', async () => {
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    expect(names()).toEqual(['GitManager', 'Atlas API', 'Docs site', 'Trading dashboard']);
    expect(item('Docs site').getAttribute('draggable')).toBe('true');

    fireEvent.dragStart(item('Docs site'), { dataTransfer: dnd() });
    dragAt('dragOver', item('GitManager'), -1); // the top half of the first row (jsdom rows have no height, so anything above 0)
    expect(item('GitManager').getAttribute('data-drop')).toBe('before'); // a line says where it will land
    expect(item('Docs site').getAttribute('data-dragging')).toBe('true');
    dragAt('drop', item('GitManager'), -1);

    expect(calls).toHaveBeenCalledWith('projects.reorder', { body: { ids: [IDS.docs, IDS.gitManager, IDS.atlas, IDS.dashboard] } });
    await waitFor(() => expect(names()).toEqual(['Docs site', 'GitManager', 'Atlas API', 'Trading dashboard']));
    expect(item('GitManager').hasAttribute('data-drop')).toBe(false);
    expect(item('Docs site').hasAttribute('data-dragging')).toBe(false);
    // The core's own list agrees, so a restart keeps it.
    await waitFor(() => expect(app.runtime.store.getState().projects.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id)).toEqual([IDS.docs, IDS.gitManager, IDS.atlas, IDS.dashboard]));
  });

  it('drops after the row when the pointer is in its lower half, and a drop on itself changes nothing', async () => {
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    fireEvent.dragStart(item('GitManager'), { dataTransfer: dnd() });
    dragAt('dragOver', item('Atlas API'), 5);
    expect(item('Atlas API').getAttribute('data-drop')).toBe('after');
    dragAt('drop', item('Atlas API'), 5);
    expect(calls).toHaveBeenCalledWith('projects.reorder', { body: { ids: [IDS.atlas, IDS.gitManager, IDS.docs, IDS.dashboard] } });

    calls.mockClear();
    fireEvent.dragStart(item('Docs site'), { dataTransfer: dnd() });
    dragAt('dragOver', item('Docs site'), 5);
    dragAt('drop', item('Docs site'), 5);
    expect(calls.mock.calls.some((c) => c[0] === 'projects.reorder')).toBe(false);
  });

  it('moves the focused project one place with Alt+Up and Alt+Down, keeps the keyboard on it, and says where it went', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    row('Atlas API').focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(calls).toHaveBeenCalledWith('projects.reorder', { body: { ids: [IDS.gitManager, IDS.docs, IDS.atlas, IDS.dashboard] } });
    await waitFor(() => expect(names()).toEqual(['GitManager', 'Docs site', 'Atlas API', 'Trading dashboard']));
    expect(document.activeElement).toBe(row('Atlas API'));
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('Atlas API moved to position 3 of 4');
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(names()).toEqual(['Atlas API', 'GitManager', 'Docs site', 'Trading dashboard']));
    // The first one cannot go higher: nothing is sent.
    calls.mockClear();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(calls.mock.calls.some((c) => c[0] === 'projects.reorder')).toBe(false);
    // Arrows without Alt are not this: they never reorder.
    await user.keyboard('{ArrowDown}');
    expect(calls.mock.calls.some((c) => c[0] === 'projects.reorder')).toBe(false);
  });

  it('puts the order back and says so when the core refuses', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const original = app.demo.call;
    vi.spyOn(app.demo, 'call').mockImplementation(((name: string, ...rest: unknown[]) => (
      name === 'projects.reorder' ? Promise.reject(new Error('The database is locked.')) : (original as (...a: unknown[]) => unknown)(name, ...rest)
    )) as never);
    row('GitManager').focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(await screen.findByText('Could not change the order')).toBeTruthy();
    await waitFor(() => expect(names()).toEqual(['GitManager', 'Atlas API', 'Docs site', 'Trading dashboard']));
  });

  it('leaves a lone project alone: nothing to drag it past', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    for (const id of [IDS.atlas, IDS.docs, IDS.dashboard]) await app.demo.demo.server.call('projects.update', { params: { id }, body: { archived: true } });
    await waitFor(() => expect(names()).toEqual(['GitManager']));
    expect(item('GitManager').hasAttribute('draggable')).toBe(false);
    row('GitManager').focus();
    const calls = vi.spyOn(app.demo, 'call');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(calls.mock.calls.some((c) => c[0] === 'projects.reorder')).toBe(false);
  });
});
