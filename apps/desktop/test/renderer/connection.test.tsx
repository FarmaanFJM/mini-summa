// What the person sees before there is data and when the connection to Mini-Summa goes away: loading, empty, error and
// offline, each said plainly, and never a screen that looks live while it is not.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { renderApp } from './helpers';

// The activity, reports and settings views belong to another worker: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

const LOST = 'Connection to Mini-Summa lost. Reconnecting.';
const appRoot = () => document.querySelector('.ms-app') as HTMLElement;

describe('loading', () => {
  it('shows placeholders in the sidebar and the workspace, marked busy, and says nothing is missing', async () => {
    const app = await renderApp({ scenario: 'loading' });
    expect(await screen.findByLabelText('Loading projects')).toBeTruthy();
    expect(screen.getByLabelText('Loading projects').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
    expect(screen.queryByText('No projects yet.')).toBeNull();
    expect(screen.queryByText(LOST)).toBeNull(); // it is connected, only waiting
    app.runtime.dispose();
  });
});

describe('empty', () => {
  it('says there are no projects and offers the one thing to do, in the sidebar and the workspace', async () => {
    const user = userEvent.setup();
    await renderApp({ scenario: 'empty' });
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
    expect(screen.getByText(/Create your first project/)).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create project' });
    expect(create.className).toContain('sm-btn--primary');
    await user.click(create);
    expect(await screen.findByRole('dialog', { name: 'New project' })).toBeTruthy();
  });
});

describe('error', () => {
  it('says the data could not be loaded, why, and retries on request', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ scenario: 'error' });
    expect(await screen.findByText(/Mini-Summa could not load its data\./)).toBeTruthy();
    expect(screen.getByText(/The demo core could not read its database\./)).toBeTruthy();
    expect(screen.queryByText('No projects yet.')).toBeNull(); // an error is not an empty list
    expect(screen.getByText('Could not load projects.')).toBeTruthy(); // and nothing pretends to be on its way
    expect(screen.queryByLabelText('Loading projects')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/The demo core could not read its database\./)).toBeTruthy(); // still failing, still said

    app.demo.demo.server.failSnapshot = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^GitManager/ })).toBeTruthy();
    expect(screen.queryByText(/could not load its data/)).toBeNull();
  });
});

describe('offline', () => {
  it('from the start: says it cannot reach Mini-Summa, and loads by itself once it can', async () => {
    const app = await renderApp({ scenario: 'offline' });
    expect(await screen.findByText(LOST)).toBeTruthy();
    expect(screen.getByText('Mini-Summa is not reachable. Reconnecting.')).toBeTruthy();
    expect(screen.getByText('Waiting for Mini-Summa.')).toBeTruthy();
    expect(screen.queryByLabelText('Loading projects')).toBeNull();
    expect(appRoot().getAttribute('data-connection')).toBe('reconnecting');

    act(() => app.demo.demo.setOffline(false));
    expect(await screen.findByRole('button', { name: /^GitManager/ }, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(LOST)).toBeNull());
    expect(appRoot().getAttribute('data-connection')).toBe('live');
    app.runtime.dispose();
  }, 10_000);

  it('after the connection drops: keeps the last known state in view, says so, and catches up on what it missed', async () => {
    const app = await renderApp();
    act(() => { app.demo.demo.setOffline(true); app.demo.demo.drop(); });
    expect(await screen.findByText(LOST)).toBeTruthy();
    expect(screen.getByText('Showing the last known state.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^GitManager/ })).toBeTruthy(); // not blanked out
    expect(appRoot().getAttribute('data-connection')).toBe('reconnecting');
    // What is live is dimmed while it cannot be trusted: the attention marker of a project and the counts of the sections.
    expect(within(screen.getByRole('button', { name: /^GitManager/ })).getByRole('img', { name: 'Needs your attention' }).closest('.ms-live')).toBeTruthy();
    expect(screen.getByTitle('4 unread').closest('.ms-live')).toBeTruthy();

    // Something changes in the core while the window is away.
    await app.demo.demo.server.call('projects.update', { params: { id: IDS.atlas }, body: { name: 'Atlas Gateway' } });
    act(() => app.demo.demo.setOffline(false));

    expect(await screen.findByRole('button', { name: /^Atlas Gateway/ }, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(LOST)).toBeNull());
    expect(screen.queryByRole('button', { name: /^Atlas API/ })).toBeNull();
    app.runtime.dispose();
  }, 10_000);
});
