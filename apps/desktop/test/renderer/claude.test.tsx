// The Claude pane on the demo core: which session typing reaches, what the notices say, and how a terminal that is still
// starting is presented. Time-dependent tests run on fake timers installed after the app has loaded.
import type { SessionKey } from '@minisumma/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { STARTING_HINT } from '../../src/renderer/src/features/workspace/sessionModel';
import type { RenderedApp } from './helpers';
import { renderApp, until } from './helpers';

// The activity, reports and settings views belong to another worker: the shell is tested with stand-ins (stubViews.tsx).
vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

const key = (k: string) => k as SessionKey;
const banner = () => document.querySelector('.ms-input') as HTMLElement;
const notice = () => document.querySelector('.ms-notice') as HTMLElement | null;
const project = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}(,|$)`) });
const tab = (id: RegExp) => screen.getByRole('tab', { name: id });
const adapterOf = (app: RenderedApp, k: string) => app.adapters.get(key(k))!;
const sessionOf = (app: RenderedApp, k: string) => app.runtime.store.getState().sessions.find((s) => s.key === k)!;

/** The terminal of a session has attached once its replay has been written. */
const attached = (app: RenderedApp, k: string, text: string) => until(() => adapterOf(app, k)?.text.includes(text) === true, `the terminal of ${k} to attach`);

async function newSession(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New or resumed session' }));
  await user.click(screen.getByRole('menuitem', { name: 'New session' }));
}

/** Atlas API has one folder, so "New session" starts at once. With the trust prompt on, it stays "Starting" until answered. */
async function startTrustSession(app: RenderedApp, user: ReturnType<typeof userEvent.setup>): Promise<string> {
  app.demo.demo.server.trustPrompt = true;
  await user.click(project('Atlas API'));
  await newSession(user);
  await waitFor(() => expect(app.runtime.store.getState().sessions.some((s) => s.state === 'unknown')).toBe(true));
  const started = app.runtime.store.getState().sessions.find((s) => s.state === 'unknown')!;
  await attached(app, started.key, 'Do you trust the files in this folder?');
  return started.key;
}

// Testing Library waits on a zero timeout after every async query, so the clock must keep moving by itself; tests then jump it forward.
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

describe('where typing goes', () => {
  it('names the project, the session and how it was started, above the terminal', async () => {
    await renderApp();
    expect(banner().textContent).toContain('Input goes to: GitManager / Session a1b2c3d4 (managed, Windows)');
    expect(banner().textContent).toContain('Working');
    expect(banner().getAttribute('data-kind')).toBe('managed');
  });

  it('sends keystrokes only to the terminal of the selected tab', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await attached(app, IDS.s.gmWorking, 'Running tests');
    const first = adapterOf(app, IDS.s.gmWorking);
    first.type('q');
    await until(() => first.text.endsWith('q'), 'the first terminal to echo');

    await user.click(tab(/b7c8d9e0/));
    expect(banner().textContent).toContain('Input goes to: GitManager / Session b7c8d9e0 (managed, Windows)');
    await attached(app, IDS.s.gmPermission, 'Do you want to proceed?');
    const second = adapterOf(app, IDS.s.gmPermission);
    first.type('z'); // a stale handle in a terminal that is no longer the active one
    second.type('w');
    await until(() => second.text.endsWith('w'), 'the second terminal to echo');
    expect(first.text).not.toContain('z');
    expect(app.runtime.terminals.canType(key(IDS.s.gmWorking))).toBe(false);
    expect(app.runtime.terminals.canType(key(IDS.s.gmPermission))).toBe(true);
  });

  it('keeps every terminal alive when the person switches tabs and projects', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await attached(app, IDS.s.gmWorking, 'Running tests');
    await user.click(tab(/b7c8d9e0/));
    await attached(app, IDS.s.gmPermission, 'Do you want to proceed?');
    await user.click(project('Atlas API'));
    await user.click(project('GitManager'));
    await user.click(tab(/a1b2c3d4/));
    expect(app.created.filter((a) => a.key === IDS.s.gmWorking)).toHaveLength(1);
    expect(app.created.filter((a) => a.key === IDS.s.gmPermission)).toHaveLength(1);
    expect([...app.adapters.values()].every((a) => !a.disposed && a.openCount === 1)).toBe(true);
  });

  it('says input is paused, and sends none, while the connection to Mini-Summa is down', async () => {
    const app = await renderApp();
    await attached(app, IDS.s.gmWorking, 'Running tests');
    act(() => { app.demo.demo.setOffline(true); app.demo.demo.drop(); });
    expect(await screen.findByText('Connection to Mini-Summa lost. Reconnecting.')).toBeTruthy();
    expect(banner().getAttribute('data-kind')).toBe('paused');
    expect(banner().textContent).toContain('Input is paused');
    expect(banner().textContent).toContain('Last known: Working');
    expect(app.runtime.terminals.canType(key(IDS.s.gmWorking))).toBe(false);
    app.runtime.dispose();
  });
});

describe('what a session is waiting for', () => {
  it('says what Claude asks permission for, and that the answer is given in the terminal', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(tab(/b7c8d9e0/));
    expect(notice()?.textContent).toBe('Claude is asking for permission: Bash: rm -rf node_modules && npm ci. Answer it in the terminal.');
    expect(within(notice()!).queryAllByRole('button')).toHaveLength(0); // Mini-Summa never answers for the person
  });

  it('offers to resume a terminal it lost, and does not call it ended', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(project('Docs site'));
    // Its tab opens by itself: the person has to decide what to do about a terminal Mini-Summa can no longer reach.
    expect(screen.getByRole('tab', { name: /c9d8e7f6/ }).getAttribute('aria-selected')).toBe('true');
    expect(banner().getAttribute('data-kind')).toBe('not_running');
    expect(notice()?.textContent).toContain('Mini-Summa lost its connection to this terminal');
    expect(notice()?.textContent).not.toContain('ended');
    expect(within(notice()!).getByRole('button', { name: 'Resume session' })).toBeTruthy();
    expect(screen.getByText('No terminal output is available for this session.')).toBeTruthy();
  });

  it('shows a session that ended badly with its reason, and no resume where there is nothing to resume', async () => {
    await renderApp();
    await userEvent.setup().click(project('Trading dashboard'));
    const failed = await screen.findByRole('tab', { name: /9f8e7d6c/ });
    expect(failed.getAttribute('aria-selected')).toBe('true');
    expect(notice()?.getAttribute('data-tone')).toBe('error');
    expect(notice()?.textContent).toContain('This session ended: The process exited with code 1.');
    expect(within(notice()!).queryByRole('button', { name: 'Resume session' })).toBeNull();
    expect(banner().getAttribute('data-kind')).toBe('not_running');
  });
});

describe('opening, resuming, closing and stopping', () => {
  it('starts a session in the only folder of the project at once, and shows it', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(project('Docs site'));
    await newSession(user);
    await waitFor(() => expect(calls).toHaveBeenCalledWith('sessions.start', expect.objectContaining({ params: { id: IDS.docs }, body: expect.objectContaining({ mode: 'new', rootId: `${IDS.docs}_root0` }) })));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2)); // the lost terminal stays beside it
    const started = app.runtime.store.getState().sessions.find((s) => s.projectId === IDS.docs && s.availability === 'live')!;
    expect(screen.getByRole('tab', { name: new RegExp(started.sessionId.slice(0, 8)) }).getAttribute('aria-selected')).toBe('true');
    expect(banner().textContent).toContain(`Input goes to: Docs site / Session ${started.sessionId.slice(0, 8)}`);
  });

  it('asks which folder when the project has several', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(project('Trading dashboard'));
    await newSession(user);
    const dialog = await screen.findByRole('dialog', { name: 'New Claude session' });
    expect(calls.mock.calls.some((c) => c[0] === 'sessions.start')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('sessions.start', expect.objectContaining({ body: expect.objectContaining({ mode: 'new', rootId: expect.stringContaining(IDS.dashboard) }) })));
  });

  it('closing a tab hides it and leaves the session running', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    const before = app.runtime.store.getState().sessions;
    await user.click(screen.getByRole('button', { name: /^Close tab a1b2c3d4/ }));
    expect(screen.queryByRole('tab', { name: /a1b2c3d4/ })).toBeNull();
    expect(tab(/b7c8d9e0/).getAttribute('aria-selected')).toBe('true');
    expect(calls.mock.calls.some((c) => c[0] === 'sessions.stop')).toBe(false);
    expect(app.runtime.store.getState().sessions).toBe(before);
    expect(sessionOf(app, IDS.s.gmWorking).availability).toBe('live');
  });

  it('asks before stopping a session, and says what stopping means', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Actions for session a1b2c3d4' }));
    await user.click(screen.getByRole('menuitem', { name: 'Stop session' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Stop session a1b2c3d4?' });
    expect(dialog.textContent).toContain('resume it later');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.mock.calls.some((c) => c[0] === 'sessions.stop')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Actions for session a1b2c3d4' }));
    await user.click(screen.getByRole('menuitem', { name: 'Stop session' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop session' }));
    await waitFor(() => expect(sessionOf(app, IDS.s.gmWorking).availability).toBe('resumable'));
    expect(calls).toHaveBeenCalledWith('sessions.stop', { params: { key: IDS.s.gmWorking }, body: {} });
    expect(notice()?.textContent).toContain('This session ended: You stopped the session.');
    expect(within(notice()!).getByRole('button', { name: 'Resume session' })).toBeTruthy();
  });

  it('does not offer to stop a session Mini-Summa did not start', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    await user.click(screen.getByRole('menuitem', { name: /d4e5f6a1/ }));
    await user.click(screen.getByRole('button', { name: 'Actions for session d4e5f6a1' }));
    expect(screen.queryByRole('menuitem', { name: 'Stop session' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Copy session id' })).toBeTruthy();
  });

  it('resumes from the plus menu, and the resumed session shows what the core says: Starting, then its own state', async () => {
    const app = await renderApp();
    app.demo.demo.server.firstHookDelayMs = 5000;
    fakeClock();
    const user = userEvent.setup({ delay: null });
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(project('Atlas API'));
    await user.click(screen.getByRole('button', { name: 'New or resumed session' }));
    await user.click(screen.getByRole('menuitem', { name: /^f0e1d2c3, WSL \(Ubuntu\)/ }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('sessions.start', expect.objectContaining({ body: expect.objectContaining({ mode: 'resume', resumeKey: IDS.s.atlasResumable }) })));
    await waitFor(() => expect(banner().textContent).toContain('Starting'));
    // The old session's tab was taken over by the resumed one; nothing of the earlier state is shown for it.
    expect(screen.queryByRole('tab', { name: /f0e1d2c3/ })).toBeNull();
    expect(banner().textContent).not.toContain('Finished a turn');
    expect(banner().textContent).not.toContain('Ended');
    await advance(5000);
    await waitFor(() => expect(banner().textContent).toContain('Waiting for you'));
  });
});

describe('observed sessions', () => {
  it('shows what is known, says why nothing can be typed, and never opens a terminal for it', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByRole('menu', { name: 'Observed sessions' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: /d4e5f6a1, external/ }));
    expect(banner().getAttribute('data-kind')).toBe('observed');
    expect(banner().textContent).toContain('No input: GitManager / Session d4e5f6a1 (external, Windows) is observed. Mini-Summa cannot type into it.');
    expect(screen.getByRole('heading', { name: 'Why you cannot type here' })).toBeTruthy();
    expect(screen.getByText(/started outside Mini-Summa, in another terminal/)).toBeTruthy();
    expect(app.adapters.has(key(IDS.s.gmExternal))).toBe(false);
  });

  it('assigns an unassigned session to the project being looked at', async () => {
    const user = userEvent.setup();
    const app = await renderApp();
    const calls = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    await user.click(screen.getByRole('menuitem', { name: /7c6b5a49, external/ }));
    expect(screen.getByText('Not assigned to a project')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Assign to project' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'GitManager' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('sessions.bind', { params: { key: IDS.s.unassigned }, body: { projectId: IDS.gitManager } }));
    await waitFor(() => expect(sessionOf(app, IDS.s.unassigned).projectId).toBe(IDS.gitManager));
  });
});

describe('a terminal that is still starting', () => {
  it('shows "Starting" at once and stays quiet for six seconds', async () => {
    const app = await renderApp();
    fakeClock();
    const user = userEvent.setup({ delay: null });
    await startTrustSession(app, user);
    expect(banner().textContent).toContain('Starting');
    expect(notice()).toBeNull();
    await advance(5000);
    expect(notice()).toBeNull();
  });

  it('then points to the terminal: Claude may be asking whether to trust the folder', async () => {
    const app = await renderApp();
    fakeClock();
    const user = userEvent.setup({ delay: null });
    await startTrustSession(app, user);
    await advance(6100);
    expect(notice()?.textContent).toBe('Claude may be waiting for you to answer a question in the terminal, such as whether you trust this folder.');
    expect(notice()?.textContent).toBe(STARTING_HINT);
    expect(notice()?.getAttribute('role')).toBe('status');
    expect(notice()?.getAttribute('data-tone')).toBe('info');
    // A hint, not an offer: nothing here types, approves or resumes for the person.
    expect(within(notice()!).queryAllByRole('button')).toHaveLength(0);
  });

  it('does not start counting again when the person looks at another tab and comes back', async () => {
    const app = await renderApp();
    fakeClock();
    const user = userEvent.setup({ delay: null });
    await startTrustSession(app, user);
    await advance(4000);
    await user.click(tab(/e1f2a3b4/));
    expect(notice()).toBeNull();
    await advance(500);
    await user.click(screen.getByRole('tab', { name: /Starting/ }));
    expect(notice()).toBeNull(); // about 4.5 seconds in
    await advance(1600);
    expect(notice()?.textContent).toBe(STARTING_HINT);
  });

  it('never shows the hint for a session that has a state', async () => {
    const app = await renderApp();
    fakeClock();
    await advance(30_000);
    expect(app.runtime.store.getState().sessions.some((s) => s.state === 'unknown')).toBe(false);
    expect(screen.queryByText(STARTING_HINT)).toBeNull();
  });

  it('lets the person answer in the terminal: their keystrokes are not held back, and the hint goes with the answer', async () => {
    const app = await renderApp();
    fakeClock();
    const user = userEvent.setup({ delay: null });
    const started = await startTrustSession(app, user);
    await advance(6100);
    expect(notice()?.textContent).toBe(STARTING_HINT);
    const terminal = adapterOf(app, started);
    expect(app.runtime.terminals.canType(key(started))).toBe(true);

    terminal.type('\x1b[A'); // Up: move to "Yes, proceed"
    await until(() => terminal.text.includes('❯ 1.'), 'the selection to move');
    terminal.type('\r');
    await until(() => terminal.text.includes('Type a message to start'), 'Claude to start');
    await advance(500); // the first hook arrives
    await waitFor(() => expect(sessionOf(app, started).state).toBe('waiting_for_you'));
    expect(banner().textContent).toContain('Waiting for you');
    expect(notice()).toBeNull();
  });

  it('shows what happened when the answer was the default, "No, exit"', async () => {
    const app = await renderApp();
    fakeClock();
    const user = userEvent.setup({ delay: null });
    const started = await startTrustSession(app, user);
    adapterOf(app, started).type('\r'); // "No, exit" is selected: a blind Enter ends the session
    await waitFor(() => expect(sessionOf(app, started).availability).toBe('ended'));
    expect(notice()?.textContent).toBe('This session ended: Claude exited at the trust prompt.');
    expect(within(notice()!).queryByRole('button', { name: 'Resume session' })).toBeNull();
    expect(screen.queryByText(STARTING_HINT)).toBeNull();
  });
});
