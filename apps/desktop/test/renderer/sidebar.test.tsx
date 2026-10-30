import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Docs site/ })).toBeNull());
    expect(calls).toHaveBeenCalledWith('projects.remove', { params: { id: IDS.docs }, query: { mode: 'archive' } });
    expect(app.runtime.store.getState().reports.some((r) => r.projectId === IDS.docs)).toBe(true); // history is kept

    await user.click(await screen.findByRole('button', { name: /Archived/ }));
    await user.click(screen.getByRole('button', { name: 'Restore Docs site' }));
    expect(await screen.findByRole('button', { name: /^Docs site/ })).toBeTruthy();
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
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Trading dashboard/ })).toBeNull());
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
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Atlas API/ })).toBeNull());
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
    await waitFor(() => expect(screen.queryByRole('button', { name: /^GitManager/ })).toBeNull());
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
    expect(screen.getByRole('button', { name: /^Docs site/ })).toBeTruthy(); // nothing was removed

    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Docs site/ })).toBeNull());
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
    expect(side.querySelector('img, [class*="avatar"]')).toBeNull();
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
