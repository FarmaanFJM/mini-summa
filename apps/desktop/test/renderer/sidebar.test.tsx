import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { createHarness, renderApp, until } from './helpers';

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

  it('shows no number where there is nothing to count', async () => {
    await renderApp();
    const docs = row('Docs site');
    expect(docs.querySelector('[title*="live session"]')).toBeNull();
    expect(docs.querySelector('[title*="report"]')).not.toBeNull();
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
    await screen.findByRole('textbox', { name: /^Input goes to/ }).catch(() => undefined);
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
    expect(screen.getByRole('menuitem', { name: 'Edit project' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Archive project' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete project' }).className).toContain('sm-menu__item--danger');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.pointer({ keys: '[MouseRight]', target: row('Docs site') });
    expect(screen.getByRole('menu', { name: 'Actions for Docs site' })).toBeTruthy();
  });

  it('asks for a new project from the plus button', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
  });
});

describe('archiving and deleting', () => {
  it('archive states what is kept, takes the project out of the list, and can be restored', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for Docs site' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archive project' }));
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
    await user.click(screen.getByRole('menuitem', { name: 'Delete project' }));
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
    await user.click(screen.getByRole('menuitem', { name: 'Delete project' }));
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
    await user.click(screen.getByRole('menuitem', { name: 'Delete project' }));
    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByText('The database is locked.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

describe('the sidebar before and without data', () => {
  it('shows skeleton rows while loading, not an empty list', async () => {
    await renderApp({ scenario: 'loading' });
    expect(await screen.findByLabelText('Loading projects')).toBeTruthy();
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });

  it('says plainly that there are no projects once it knows', async () => {
    createHarness({ scenario: 'empty' });
    await renderApp({ scenario: 'empty' });
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create project' }).className).toContain('sm-btn--primary');
  });
});
