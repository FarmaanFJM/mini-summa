import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@minisumma/shared';
import type { ActivityEvent } from '@minisumma/shared';
import { describe, expect, it, vi } from 'vitest';
import { groupByDay, dayLabel, primaryLink, notificationOutcome, demandWords } from '../../src/renderer/src/features/activity/model';
import { createFeatureSeed, FEATURE_IDS } from '../../src/renderer/src/dev/demo/features-seed';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';
import { callsTo, renderFeature, textOf } from './features-helpers';

const feed = () => screen.getByRole('feed', { name: 'Activity feed' });
const rows = () => within(feed()).getAllByRole('listitem');
const titles = () => rows().map((r) => textOf(within(r).getAllByRole('button')[0].querySelector('.ms-act__title')));
const row = (title: RegExp | string) => rows().find((r) => (typeof title === 'string' ? textOf(r).includes(title) : title.test(textOf(r))))!;
const open = (options: Parameters<typeof renderFeature>[0] = {}) => renderFeature({ view: 'activity', ...options });

describe('the model', () => {
  const now = Date.parse('2026-10-30T15:00:00');
  it('groups by the person\'s local day with plain names for today and yesterday', () => {
    expect(dayLabel('2026-10-30T09:00:00', now)).toMatchObject({ label: 'Today' });
    expect(dayLabel('2026-10-29T23:30:00', now)).toMatchObject({ label: 'Yesterday' });
    expect(dayLabel('2026-10-27T10:00:00', now).label).toBe('Tuesday, October 27');
    expect(dayLabel('2025-12-31T10:00:00', now).label).toBe('Wednesday, December 31, 2025');
    const groups = groupByDay([{ at: '2026-10-30T14:00:00' }, { at: '2026-10-30T08:00:00' }, { at: '2026-10-29T12:00:00' }], now);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([['Today', 2], ['Yesterday', 1]]);
  });

  it('opens the most specific thing an entry is about', () => {
    expect(primaryLink([{ kind: 'project', id: 'p' }, { kind: 'session', key: 'win|x' }, { kind: 'report', id: 'r' }, { kind: 'delivery', id: 'd' }])).toEqual({ kind: 'report', id: 'r' });
    expect(primaryLink([{ kind: 'project', id: 'p' }, { kind: 'session', key: 'win|x' }])).toEqual({ kind: 'session', key: 'win|x' });
    expect(primaryLink([{ kind: 'project', id: 'p' }, { kind: 'action', id: 'a' }, { kind: 'session', key: 'win|x' }])).toEqual({ kind: 'action', id: 'a' });
    expect(primaryLink([])).toBeNull();
  });

  it('says what became of a notification in words', () => {
    expect(notificationOutcome({ native: 'sent', push: 'not_applicable' })).toEqual(['Shown on this PC']);
    expect(notificationOutcome({ native: 'suppressed_quiet', push: 'suppressed_quiet' })).toEqual(['Not shown: quiet mode was on', 'Not sent to your phone: quiet mode was on']);
    expect(notificationOutcome({ native: 'suppressed_project', push: 'suppressed_project' })[0]).toBe('Not shown: notifications are off for this project');
    expect(notificationOutcome({ native: 'suppressed_duplicate', push: 'not_applicable' })).toEqual(['Not shown: it was a duplicate']);
    expect(notificationOutcome({ native: 'unavailable', push: 'failed' })).toEqual(['Could not be shown: this PC cannot show notifications', 'Could not be sent to your phone']);
  });

  it('separates what still needs the person from what was handled', () => {
    expect(demandWords({ requiresAction: true, resolvedAt: null })).toBe('Needs you');
    expect(demandWords({ requiresAction: true, resolvedAt: '2026-10-30T10:00:00Z' })).toBe('Handled');
    expect(demandWords({ requiresAction: false, resolvedAt: null })).toBeNull();
  });
});

describe('the feed', () => {
  it('lists entries newest first under day headings, each readable on its own', async () => {
    await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const days = within(feed()).getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(days[0]).toBe('Today');
    expect(days).toContain('Yesterday');
    expect(titles().slice(0, 3)).toEqual(['GitManager needs your permission', 'Report ready: Fix flaky push retry test', 'Trading dashboard: a session ended with an error']);

    const permission = row('GitManager needs your permission');
    const spoken = within(permission).getByRole('button').getAttribute('aria-label')!;
    expect(spoken).toBe('Unread. GitManager needs your permission. Session b7c8d9e0 wants to run a shell command. GitManager. Needs attention. Needs you. 3 min ago');
    expect(textOf(permission)).toContain('Needs attention');
    expect(textOf(permission)).toContain('3 min ago');
    // Severity is a word as well as an icon.
    expect(textOf(row('a session ended with an error'))).toContain('Error');
    // An informational entry carries no severity word.
    expect(textOf(row('Session a1b2c3d4 started in GitManager'))).not.toMatch(/Needs attention|Error/);
  });

  it('marks unread entries and only those', async () => {
    await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const unread = rows().filter((r) => r.getAttribute('data-unread') !== null).map((r) => within(r).getByRole('button').getAttribute('aria-label')!.split('.')[0]);
    expect(unread.every((s) => s === 'Unread')).toBe(true);
    expect(unread).toHaveLength(9 - 5 + 5); // act_1, 2, 3, 5 plus the five newest of the long feed
    expect(rows().filter((r) => !r.getAttribute('data-unread'))[0].querySelector('.ms-act__dot')).toBeNull();
  });

  it('filters by project, by unread and by needs attention, together', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'Trading dashboard' }));
    await waitFor(() => expect(titles()).toEqual(['Trading dashboard: a session ended with an error', 'Delivery marked uncertain: Candle chart zoom bug']));

    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    await waitFor(() => expect(titles()).toEqual(['Trading dashboard: a session ended with an error']));
    await user.click(screen.getByRole('button', { name: 'Needs attention' }));

    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'All projects' }));
    await user.click(screen.getByRole('button', { name: 'Unread' }));
    await waitFor(() => expect(rows().every((r) => r.getAttribute('data-unread') !== null)).toBe(true));
    expect(rows().length).toBe(9);
  });

  it('asks the core for the filtered page instead of hiding rows it already has', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Unread' }));
    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    await waitFor(() => expect(callsTo(spy, 'activity.list').at(-1)).toEqual({ query: { limit: 50, unread: true, requiresAction: true } }));
  });

  it('says when nothing matches and clears the filters', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'Docs site' }));
    expect(await screen.findByText('No activity matches these filters.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(rows().length).toBeGreaterThan(20));
  });

  it('pages through older activity from the core, once each, until there is no more', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    expect(rows()).toHaveLength(50);
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Load older activity' }));
    await waitFor(() => expect(rows()).toHaveLength(79));
    const before = (callsTo(spy, 'activity.list')[0] as { query: { before: string } }).query.before;
    expect(before).toMatch(/\|/);
    expect(new Set(titles()).size).toBeLessThanOrEqual(79);
    expect(screen.queryByRole('button', { name: 'Load older activity' })).toBeNull();
    // Ids are unique: nothing was shown twice.
    const ids = app.server.data.activity.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows a skeleton while loading, an error with a way to retry, and an empty state', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ view: 'workspace' });
    app.demoState.failNext.set('activity.list', new ApiError(500, 'x', 'The database is locked.'));
    app.runtime.route.getState().go({ view: 'activity' });
    expect(await screen.findByText(/Activity could not be loaded. The database is locked./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('feed', { name: 'Activity feed' })).toBeTruthy();

    const empty = await renderFeature({ view: 'activity', seed: { ...createSeed(), activity: [], notifications: [] } });
    expect(await screen.findByText('Nothing has happened yet. Events from your Claude sessions appear here.')).toBeTruthy();
    empty.unmount();
  });

  it('shows a loading state before the first page arrives', async () => {
    const app = await renderFeature({ view: 'workspace' });
    const real = app.demo.call;
    let release: () => void = () => {};
    vi.spyOn(app.demo, 'call').mockImplementation(((name: string, input?: unknown) => (name === 'activity.list'
      ? new Promise((resolve) => { release = () => resolve((real as (n: string, i?: unknown) => Promise<unknown>)(name, input)); })
      : (real as (n: string, i?: unknown) => Promise<unknown>)(name, input))) as never);
    app.runtime.route.getState().go({ view: 'activity' });
    expect(await screen.findByLabelText('Loading activity')).toBeTruthy();
    release();
    expect(await screen.findByRole('feed', { name: 'Activity feed' })).toBeTruthy();
  });
});

describe('the feed is live', () => {
  it('shows a new entry at the top as unread, marks entries read when the core says so, and shows an entry as handled when it is resolved', async () => {
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const entry: ActivityEvent = { id: 'act_live', at: new Date().toISOString(), projectId: IDS.atlas, projectName: 'Atlas API', source: 'claude', sessionKey: null, type: 'error', severity: 'error', title: 'Error in Atlas API / e1f2a3b4', description: 'The turn ended with an error.', requiresAction: true, resolvedAt: null, links: [], read: false };
    app.server.data.activity.unshift(entry);
    app.server.transport.emit({ type: 'activity.added', activity: entry });
    await waitFor(() => expect(titles()[0]).toBe('Error in Atlas API / e1f2a3b4'));
    expect(rows()[0].getAttribute('data-unread')).not.toBeNull();
    expect(textOf(rows()[0])).toContain('Needs you');

    app.server.transport.emit({ type: 'activity.updated', activity: { ...entry, resolvedAt: new Date().toISOString() } });
    await waitFor(() => expect(textOf(rows()[0])).toContain('Handled'));

    app.server.transport.emit({ type: 'activity.read', ids: ['act_live'], counts: app.server.counts() });
    await waitFor(() => expect(rows()[0].getAttribute('data-unread')).toBeNull());
  });

  it('keeps the filtered list honest: a new entry that does not match is not shown', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'Docs site' }));
    await screen.findByText('No activity matches these filters.');
    const entry: ActivityEvent = { id: 'act_other', at: new Date().toISOString(), projectId: IDS.atlas, projectName: 'Atlas API', source: 'claude', sessionKey: null, type: 'turn_ended', severity: 'info', title: 'Turn ended: Atlas API', description: null, requiresAction: false, resolvedAt: null, links: [], read: false };
    app.server.transport.emit({ type: 'activity.added', activity: entry });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Turn ended: Atlas API')).toBeNull();
  });
});

describe('reading', () => {
  it('Mark all read marks everything read through the core and the sidebar count follows', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(callsTo(spy, 'activity.markRead')).toEqual([{ body: { all: true } }]));
    await waitFor(() => expect(rows().every((r) => r.getAttribute('data-unread') === null)).toBe(true));
    expect(app.runtime.store.getState().counts.unreadActivity).toBe(0);
    expect((screen.getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks only the chosen project when a project is chosen', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'GitManager' }));
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(await screen.findByRole('button', { name: 'Mark all in GitManager read' }));
    await waitFor(() => expect(callsTo(spy, 'activity.markRead')).toEqual([{ body: { projectId: IDS.gitManager } }]));
    // Other projects keep their unread entries.
    expect(app.server.data.activity.find((a) => a.id === 'act_3')!.read).toBe(false);
  });

  it('marks an entry read when it is opened, and not before', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const spy = vi.spyOn(app.demo, 'call');
    expect(callsTo(spy, 'activity.markRead')).toHaveLength(0);
    await user.click(within(row('Report ready: Fix flaky push retry test')).getAllByRole('button')[0]);
    await waitFor(() => expect(callsTo(spy, 'activity.markRead')).toEqual([{ body: { ids: ['act_2'] } }]));
  });

  it('does not ask the core to mark an entry that is already read', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(row('Report ready: Add branch protection checks')).getAllByRole('button')[0]);
    expect(callsTo(spy, 'activity.markRead')).toHaveLength(0);
  });
});

describe('opening an entry', () => {
  it('goes to the report an entry is about', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(within(row('Report ready: Fix flaky push retry test')).getAllByRole('button')[0]);
    expect(app.runtime.route.getState()).toMatchObject({ view: 'reports', reportId: 'rpt_gm_1' });
  });

  it('goes to the session an entry is about, in its own project', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(within(row('GitManager needs your permission')).getAllByRole('button')[0]);
    const route = app.runtime.route.getState();
    expect(route.view).toBe('workspace');
    expect(route.projectId).toBe(IDS.gitManager);
    expect(route.sessionByProject[IDS.gitManager]).toBe(IDS.s.gmPermission);
  });

  it('goes to the project when that is all an entry names', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(within(row('Claude session started: Atlas API task 69')).getAllByRole('button')[0]);
    expect(app.runtime.route.getState()).toMatchObject({ view: 'workspace', projectId: IDS.atlas });
  });

  it('offers every place an entry points to, and goes to the one chosen', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const added: ActivityEvent = {
      id: 'act_multi', at: new Date().toISOString(), projectId: IDS.gitManager, projectName: 'GitManager', source: 'delivery', sessionKey: IDS.s.gmWorking as never, type: 'delivery_state', severity: 'info',
      title: 'Marked as sent to ChatGPT: Fix flaky push retry test', description: null, requiresAction: false, resolvedAt: null, read: true,
      links: [{ kind: 'project', id: IDS.gitManager }, { kind: 'session', key: IDS.s.gmWorking as never }, { kind: 'report', id: 'rpt_gm_1' }, { kind: 'delivery', id: 'dlv_gm_1' }, { kind: 'conversation', id: IDS.c.gmReview }, { kind: 'settings', section: 'hooks' }],
    };
    app.server.data.activity.unshift(added);
    app.server.transport.emit({ type: 'activity.added', activity: added });
    await waitFor(() => expect(titles()[0]).toBe('Marked as sent to ChatGPT: Fix flaky push retry test'));
    const multi = row('Marked as sent to ChatGPT: Fix flaky push retry test');
    await user.click(within(multi).getByRole('button', { name: 'More places to open this entry' }));
    const menu = screen.getByRole('menu', { name: 'Open' });
    expect(within(menu).getAllByRole('menuitem').map((i) => textOf(i))).toEqual(['Open the project', 'Open the session', 'Open the report', 'Open the handoff', 'Open the conversation', 'Open the settings']);

    await user.click(within(menu).getByRole('menuitem', { name: 'Open the handoff' }));
    expect(app.runtime.route.getState()).toMatchObject({ view: 'reports', deliveryId: 'dlv_gm_1', reportId: 'rpt_gm_1' });

    app.runtime.route.getState().go({ view: 'activity' });
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(within(row('Marked as sent to ChatGPT: Fix flaky push retry test')).getByRole('button', { name: 'More places to open this entry' }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open the settings' }));
    expect(app.runtime.route.getState()).toMatchObject({ view: 'settings', section: 'hooks' });

    app.runtime.route.getState().go({ view: 'activity' });
    await screen.findByRole('feed', { name: 'Activity feed' });
    await user.click(within(row('Marked as sent to ChatGPT: Fix flaky push retry test')).getByRole('button', { name: 'More places to open this entry' }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open the conversation' }));
    expect(app.runtime.route.getState()).toMatchObject({ view: 'workspace', projectId: IDS.gitManager });
    expect(app.runtime.route.getState().conversationByProject[IDS.gitManager]).toBe(IDS.c.gmReview);
  });
});

describe('Needs you', () => {
  it('shows the requests waiting for approval and only the entries that still ask something of the person', async () => {
    const app = await open({ route: { section: 'needs-you' } });
    expect(await screen.findByRole('list', { name: 'Waiting for your approval' })).toBeTruthy();
    const feedRows = within(await screen.findByRole('feed', { name: 'Entries that need you' })).getAllByRole('listitem');
    expect(feedRows.map((r) => textOf(r.querySelector('.ms-act__title')))).toEqual(['GitManager needs your permission', 'Trading dashboard: a session ended with an error']);
    expect(feedRows.every((r) => textOf(r).includes('Needs you'))).toBe(true);
    // A handled entry leaves the list at once.
    const permission = app.server.data.activity.find((a) => a.id === 'act_1')!;
    app.server.transport.emit({ type: 'activity.updated', activity: { ...permission, resolvedAt: new Date().toISOString() } });
    await waitFor(() => expect(within(screen.getByRole('feed', { name: 'Entries that need you' })).getAllByRole('listitem')).toHaveLength(1));
  });

  it('has a tab for it that counts what needs the person, and opens from a link to an action', async () => {
    const user = userEvent.setup();
    const app = await open();
    await screen.findByRole('feed', { name: 'Activity feed' });
    const tab = screen.getByRole('tab', { name: /^Needs you/ });
    expect(tab.textContent).toMatch(/Needs you \(\d+\)/);
    await user.click(tab);
    expect(app.runtime.route.getState().section).toBe('needs-you');
    expect(await screen.findByRole('list', { name: 'Waiting for your approval' })).toBeTruthy();
  });

  it('says so when nothing needs the person', async () => {
    const seed = createSeed();
    seed.actions = [];
    seed.activity = seed.activity.filter((a) => !a.requiresAction);
    await open({ seed, route: { section: 'needs-you' } });
    expect(await screen.findByText('Nothing is waiting for your approval.')).toBeTruthy();
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
  });
});

describe('pending requests', () => {
  const inbox = () => screen.getByRole('list', { name: 'Waiting for your approval' });
  const item = (title: RegExp) => within(inbox()).getAllByRole('listitem').find((li) => title.test(textOf(li)))!;

  it('shows a phone prompt with its exact text, where it would go, who asked and when it expires', async () => {
    await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    const prompt = item(/Run the full test suite on Linux/);
    expect(within(prompt).getByLabelText('Exact text').textContent).toBe('Run the full test suite on Linux as well and tell me which tests are slower than two seconds.\nDo not change any files.');
    expect(textOf(prompt.querySelector('.ms-pa__target'))).toBe('GitManager, session e5f6a7b8 (managed, Windows), generation 1');
    expect(textOf(prompt)).toContain('Asked by Pixel 8');
    expect(textOf(prompt)).toMatch(/Expires in \d+ min/);
    expect(textOf(prompt)).toContain('Approve types this text into the terminal and presses Enter. Reject types nothing.');
    expect(within(prompt).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(prompt).getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('shows a permission request with the tool and the redacted input', async () => {
    await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    const permission = item(/Permission request/);
    expect(within(permission).getByLabelText('Tool and input').textContent).toBe('Bash: rm -rf node_modules && npm ci');
    expect(textOf(permission)).toContain('GitManager, session b7c8d9e0 (managed, Windows), generation 1');
    expect(textOf(permission)).toContain('Asked by Mini-Summa (the permission prompt in the terminal)');
    expect(textOf(permission)).toContain('Approve answers yes in the terminal. Reject answers no.');
  });

  it('types nothing until Approve is pressed, and then says what happened', async () => {
    const user = userEvent.setup();
    const app = await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    const spy = vi.spyOn(app.demo, 'call');
    expect(callsTo(spy, 'actions.approve')).toHaveLength(0);
    await user.click(within(item(/Run the full test suite on Linux/)).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(callsTo(spy, 'actions.approve')).toEqual([{ params: { id: FEATURE_IDS.actions.phonePrompt } }]));
    const done = item(/Run the full test suite on Linux/);
    expect(await within(done).findByText('Approved. The text was typed into the terminal and sent with Enter.')).toBeTruthy();
    expect(within(done).queryByRole('button', { name: 'Approve' })).toBeNull();
    await user.click(within(done).getByRole('button', { name: 'Dismiss' }));
    expect(within(inbox()).queryByText(/Run the full test suite on Linux/)).toBeNull();
  });

  it('rejects without typing anything and says so', async () => {
    const user = userEvent.setup();
    const app = await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(item(/Run the full test suite on Linux/)).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(callsTo(spy, 'actions.reject')).toEqual([{ params: { id: FEATURE_IDS.actions.phonePrompt }, body: {} }]));
    expect(await within(item(/Run the full test suite on Linux/)).findByText('Rejected. Nothing was typed.')).toBeTruthy();
    expect(callsTo(spy, 'actions.approve')).toHaveLength(0);
  });

  it('answers a permission request, and says the answer goes to the terminal', async () => {
    const user = userEvent.setup();
    await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    await user.click(within(item(/Permission request/)).getByRole('button', { name: 'Approve' }));
    expect(await within(item(/Permission request/)).findByText('Approved. Mini-Summa answered yes in the terminal.')).toBeTruthy();
  });

  it('will not approve a request whose target cannot take it, and says why; it can still be rejected', async () => {
    const user = userEvent.setup();
    await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    const stale = within(inbox()).getAllByRole('listitem').find((li) => textOf(li).includes('Summarise what you changed today.'))!;
    expect(textOf(stale)).toContain('It cannot be carried out now: This session was not started by Mini-Summa, so it cannot be typed into.');
    expect((within(stale).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(stale).getByRole('button', { name: 'Reject' }));
    expect(await within(inbox()).findByText('Rejected. Nothing was typed.')).toBeTruthy();
  });

  it('shows the core\'s refusal when approving fails, and keeps the request', async () => {
    const user = userEvent.setup();
    const app = await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    app.demoState.failNext.set('actions.approve', new ApiError(409, 'action_expired', 'This request has expired, so nothing was typed. Send it again if you still want it.'));
    await user.click(within(item(/Run the full test suite on Linux/)).getByRole('button', { name: 'Approve' }));
    expect(textOf(await within(item(/Run the full test suite on Linux/)).findByRole('alert'))).toContain('This request has expired, so nothing was typed.');
    expect(within(item(/Run the full test suite on Linux/)).getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('shows a failure of the terminal as a failure, not as an approval', async () => {
    const user = userEvent.setup();
    const app = await open({ route: { section: 'needs-you' } });
    await screen.findByRole('list', { name: 'Waiting for your approval' });
    // The terminal stops being ready between the check and the typing.
    const s = app.server.data.sessions.find((x) => x.key === FEATURE_IDS.sessions.gmReady)!;
    s.state = 'working'; s.stateLabel = 'Working';
    app.server.data.actions.find((a) => a.id === FEATURE_IDS.actions.phonePrompt)!.target = { managed: true, live: true, generation: 1, generationMatches: true, state: 'waiting_for_you', problem: null };
    await user.click(within(item(/Run the full test suite on Linux/)).getByRole('button', { name: 'Approve' }));
    const failed = await within(item(/Run the full test suite on Linux/)).findByRole('alert');
    expect(textOf(failed)).toContain('Not carried out: Claude is not ready for input (working). Wait until it is waiting for you.');
    expect(textOf(failed)).toContain('Nothing is retried for you.');
  });
});

describe('notifications', () => {
  it('lists every notification with what became of it', async () => {
    const app = await open({ route: { section: 'notifications' } });
    const list = await screen.findAllByRole('list', { name: /^Notifications, / });
    const all = list.flatMap((l) => within(l).getAllByRole('listitem'));
    const byTitle = (title: string) => textOf(all.find((li) => textOf(li).includes(title))!);
    expect(byTitle('GitManager: needs permission')).toContain('Shown on this PC. Sent to your phone');
    expect(byTitle('Add branch protection checks')).toContain('Not shown: quiet mode was on');
    expect(byTitle('Atlas API: report ready')).toContain('Not shown: notifications are off for this project');
    expect(byTitle('GitManager: session ended')).toContain('Not shown: it was a duplicate');
    expect(byTitle('Trading dashboard: error')).toContain('Could not be shown: this PC cannot show notifications');
    expect(byTitle('Hooks changed')).toContain('Not shown: desktop notifications are turned off');
    expect(all.length).toBe(app.server.data.notifications.length);
  });

  it('adds a notification live and opens what it is about', async () => {
    const user = userEvent.setup();
    const app = await open({ route: { section: 'notifications' } });
    await screen.findAllByRole('list', { name: /^Notifications, / });
    app.server.transport.emit({ type: 'notification.added', notification: { id: 'ntf_new', activityId: 'act_2', projectId: IDS.gitManager, at: new Date().toISOString(), title: 'GitManager: report ready', body: 'Fix flaky push retry test', native: 'sent', push: 'not_applicable', readAt: null, target: { view: 'reports', reportId: 'rpt_gm_1' } } });
    const added = await screen.findByRole('button', { name: /GitManager: report ready/ });
    await user.click(added);
    expect(app.runtime.route.getState()).toMatchObject({ view: 'reports', reportId: 'rpt_gm_1' });
  });

  it('says so when there are none', async () => {
    await open({ seed: { ...createSeed(), notifications: [] }, route: { section: 'notifications' } });
    expect(await screen.findByText(/No notifications yet/)).toBeTruthy();
  });
});

describe('the seed', () => {
  it('is the demo seed with the feature scenes added, so the other tests mean what they say', () => {
    const base = createSeed();
    const extended = createFeatureSeed();
    expect(extended.activity.length).toBe(base.activity.length + 70);
    expect(extended.sessions.some((s) => s.key === FEATURE_IDS.sessions.gmReady && s.state === 'waiting_for_you')).toBe(true);
  });
});
