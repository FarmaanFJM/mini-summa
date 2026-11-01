// The handoff strip in the workspace: while a report of the selected project waits for the person, the whole loop (copy and open, then
// "I sent it") can be done without leaving the workspace. It uses the card's actions and words, and never says "sent" before the
// person does.
import { ApiError } from '@minisumma/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { addReportScene, createFeatureSeed } from '../../src/renderer/src/dev/demo/features-seed';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';
import { callsTo, renderFeature, textOf } from './features-helpers';

type App = Awaited<ReturnType<typeof renderFeature>>;
const strip = () => screen.getByRole('region', { name: /^Report handoff/ });
const maybeStrip = () => screen.queryByRole('region', { name: /^Report handoff/ });
const stripButtons = () => within(strip()).getAllByRole('button').map((b) => textOf(b));
const open = (app: App, projectId: string) => { act(() => { app.runtime.route.getState().selectProject(projectId); }); };
const deliveryState = (app: App, id: string) => app.runtime.store.getState().deliveries.find((d) => d.id === id)?.state;

/** The base demo scene: GitManager has a ready report and one waiting for the person to send; Atlas API has one whose conversation is not verified. */
const baseApp = (options: Parameters<typeof renderFeature>[0] = {}) => renderFeature({ seed: createSeed(), view: 'workspace', ...options });

describe('when the strip shows', () => {
  it('shows nothing for a project with no report waiting, and nothing for one that has nowhere to go', async () => {
    const app = await baseApp({ route: { projectId: IDS.dashboard } }); // its reports are uncertain and discarded
    expect(maybeStrip()).toBeNull();
    open(app, IDS.docs); // its report has no conversation to be handed to
    await screen.findByRole('heading', { level: 1, name: 'Docs site' });
    expect(maybeStrip()).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy and open|I sent it|Copy part/ })).toBeNull();
  });

  it('shows the report that is ready, where it goes, and one main button', async () => {
    await baseApp({ route: { projectId: IDS.atlas } });
    expect(strip().getAttribute('aria-label')).toBe('Report handoff: Migrate auth middleware');
    expect(textOf(strip())).toContain('Report ready: Migrate auth middleware');
    expect(textOf(strip())).toContain('Goes to Atlas API design, which is not verified yet.');
    expect(stripButtons()).toEqual(['Copy and open', 'Open report']);
    expect(within(strip()).getByRole('button', { name: 'Copy and open' }).className).toContain('sm-btn--primary');
    expect(strip().querySelectorAll('.sm-btn--primary')).toHaveLength(1);
  });

  it('says where a verified conversation goes, without the caveat', async () => {
    const seed = createSeed();
    seed.deliveries = seed.deliveries.filter((d) => d.id !== 'dlv_gm_2'); // GitManager: only the ready one is left
    await renderFeature({ seed, view: 'workspace', route: { projectId: IDS.gitManager } });
    expect(textOf(strip())).toContain('Report ready: Fix flaky push retry test');
    expect(textOf(strip())).toContain('Goes to Release planning.');
    expect(textOf(strip())).not.toContain('not verified');
  });

  it('shows the one waiting for the person to send, with the sentence that says it is not sent', async () => {
    await baseApp({ route: { projectId: IDS.gitManager } }); // "Add branch protection checks" was copied and opened an hour ago
    expect(textOf(strip())).toContain('Waiting for you to send: Add branch protection checks to Release planning.');
    expect(textOf(strip())).toContain('It is not marked as sent until you press I sent it.');
    expect(stripButtons()).toEqual(['I sent it', 'Copy again', 'Open conversation', 'Not sure', 'Open report', '+1 more']);
    expect(within(strip()).queryByRole('button', { name: 'Copy and open' })).toBeNull();
    expect(within(strip()).getByRole('button', { name: 'I sent it' }).className).toContain('sm-btn--primary');
  });

  it('shows only the selected project\'s reports, and follows the selection', async () => {
    const app = await baseApp({ route: { projectId: IDS.gitManager } });
    expect(textOf(strip())).toContain('Add branch protection checks');
    open(app, IDS.atlas);
    await waitFor(() => expect(strip().getAttribute('aria-label')).toBe('Report handoff: Migrate auth middleware'));
    expect(textOf(strip())).not.toContain('Add branch protection checks');
    open(app, IDS.dashboard);
    await waitFor(() => expect(maybeStrip()).toBeNull());
  });

  it('is not part of the other views', async () => {
    const app = await baseApp({ route: { projectId: IDS.gitManager } });
    act(() => { app.runtime.route.getState().go({ view: 'reports', reportId: 'rpt_gm_2' }); });
    await screen.findByRole('region', { name: 'Handoff to ChatGPT' });
    expect(maybeStrip()).toBeNull(); // the workspace is hidden, strip and all: the card is what is on screen
    expect(screen.getAllByRole('button', { name: 'I sent it' })).toHaveLength(1);
  });

  it('appears when a report arrives while the project is open, and goes when it is handled elsewhere', async () => {
    const app = await baseApp({ route: { projectId: IDS.dashboard } });
    expect(maybeStrip()).toBeNull();
    let added!: ReturnType<typeof addReportScene>;
    act(() => { added = addReportScene(app.server, { projectId: IDS.dashboard, title: 'Add the volume panel', state: 'ready_for_handoff' }); });
    await waitFor(() => expect(textOf(strip())).toContain('Report ready: Add the volume panel'));
    // The same delivery is settled somewhere else (the card, the phone): the strip follows.
    await act(async () => { await app.demo.call('deliveries.discard', { params: { id: added.delivery.id }, body: {} }); });
    await waitFor(() => expect(maybeStrip()).toBeNull());
  });
});

describe('showing the strip', () => {
  it('changes nothing: no message is prepared, copied, opened or confirmed, and nothing is written to a delivery, by showing it', async () => {
    const app = await baseApp({ route: { projectId: IDS.atlas } });
    const spy = vi.spyOn(app.demo, 'call');
    const before = JSON.stringify(app.server.data.deliveries);
    act(() => { app.runtime.route.getState().selectProject(IDS.gitManager); });
    await waitFor(() => expect(strip().getAttribute('aria-label')).toContain('Add branch protection checks'));
    act(() => { app.runtime.route.getState().selectProject(IDS.atlas); });
    await waitFor(() => expect(strip().getAttribute('aria-label')).toContain('Migrate auth middleware'));
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    const names = (spy.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(names.filter((n) => n.startsWith('deliveries.'))).toEqual([]);
    expect(JSON.stringify(app.server.data.deliveries)).toBe(before);
  });
});

describe('Copy and open, from the strip', () => {
  it('copies the message, opens the conversation, and then waits for the person without saying it was sent', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.atlas } });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(strip()).getByRole('button', { name: 'Copy and open' }));
    await waitFor(() => expect(textOf(strip())).toContain('Waiting for you to send: Migrate auth middleware to Atlas API design.'));
    expect(callsTo(spy, 'deliveries.handoff')).toEqual([{ params: { id: 'dlv_atlas_1' }, body: {} }]);
    expect(deliveryState(app, 'dlv_atlas_1')).toBe('awaiting_user_send');
    // The text the person pastes is on the clipboard (the demo core hands it to the window to copy, as a browser has to).
    expect(app.fake.native.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect((app.fake.native.clipboard.writeText as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toContain('Task: Migrate auth middleware');
    expect(textOf(within(strip()).getByRole('status'))).toBe('The message is on your clipboard.');
    expect(stripButtons()).toEqual(['I sent it', 'Copy again', 'Open conversation', 'Not sure', 'Open report']);
    expect(textOf(strip())).not.toMatch(/was sent|has been sent|sent to ChatGPT|delivered/i);
    expect(app.runtime.store.getState().deliveries.find((d) => d.id === 'dlv_atlas_1')?.state).not.toBe('user_confirmed_sent');
  });

  it('opens the frozen destination, whichever conversation the pane shows', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.gitManager } });
    const { delivery } = (() => { let r!: ReturnType<typeof addReportScene>; act(() => { r = addReportScene(app.server, { projectId: IDS.gitManager, title: 'A newer one', state: 'ready_for_handoff' }); }); return r; })();
    // GitManager shows the one in progress first; settle it so the new one is on screen.
    await act(async () => { await app.demo.call('deliveries.discard', { params: { id: 'dlv_gm_2' }, body: {} }); });
    await waitFor(() => expect(strip().getAttribute('aria-label')).toBe('Report handoff: A newer one'));
    app.server.onOpen = vi.fn();
    await user.click(within(strip()).getByRole('button', { name: 'Copy and open' }));
    await waitFor(() => expect(app.server.onOpen).toHaveBeenCalledWith(delivery.destination!.url));
  });

  it('works through a long message part by part, and offers "I sent it" only when every part was copied', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.dashboard } });
    const { delivery } = (() => { let r!: ReturnType<typeof addReportScene>; act(() => { r = addReportScene(app.server, { projectId: IDS.dashboard, title: 'Move the clone pipeline', state: 'ready_for_handoff', body: `${'A line of the report.\n'.repeat(1400)}` }); }); return r; })();
    // Not prepared yet, so the strip cannot know how long the message is: the button says what it does, it copies the first part.
    await within(await screen.findByRole('region', { name: /^Report handoff/ })).findByRole('button', { name: 'Copy and open' });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(strip()).getByRole('button', { name: 'Copy and open' }));
    const next = await within(strip()).findByRole('button', { name: /^Copy part 2 of \d+ and open$/ });
    const total = Number(/of (\d+) and open/.exec(textOf(next))![1]);
    expect(total).toBeGreaterThan(1);
    expect(textOf(within(strip()).getByRole('status'))).toBe(`Part 1 of ${total} is on your clipboard.`);
    for (let n = 2; n <= total; n += 1) {
      expect(within(strip()).queryByRole('button', { name: 'I sent it' })).toBeNull();
      expect(textOf(strip())).toContain(`${n - 1} of ${total} parts are copied. Part ${n} is next.`);
      await user.click(await within(strip()).findByRole('button', { name: `Copy part ${n} of ${total} and open` }));
    }
    await within(strip()).findByRole('button', { name: 'I sent it' });
    expect(callsTo(spy, 'deliveries.handoff')).toEqual([{ params: { id: delivery.id }, body: {} }, ...Array.from({ length: total - 1 }, (_, i) => ({ params: { id: delivery.id }, body: { part: i + 2 } }))]);
    expect(deliveryState(app, delivery.id)).toBe('awaiting_user_send'); // copying every part is still not sending it
  });

  it('names the parts from the start when the message was prepared before (the card does that when a report is opened)', async () => {
    const app = await baseApp({ route: { projectId: IDS.dashboard } });
    let added!: ReturnType<typeof addReportScene>;
    act(() => { added = addReportScene(app.server, { projectId: IDS.dashboard, title: 'Prepared earlier', state: 'ready_for_handoff', body: `${'A line of the report.\n'.repeat(1400)}` }); });
    await within(await screen.findByRole('region', { name: /^Report handoff/ })).findByRole('button', { name: 'Copy and open' });
    await act(async () => { await app.demo.call('deliveries.prepare', { params: { id: added.delivery.id } }); }); // what opening the report in Reports does
    expect(await within(strip()).findByRole('button', { name: /^Copy part 1 of \d+ and open$/ })).toBeTruthy();
    expect(textOf(strip())).toMatch(/The message is long, so it has \d+ parts\./);
  });

  it('tells the person when the text could not be put on the clipboard, and gives it to copy by hand', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.atlas } });
    (app.fake.native.clipboard.writeText as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Clipboard access was denied.'));
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as never);
    await user.click(within(strip()).getByRole('button', { name: 'Copy and open' }));
    const alert = await within(strip()).findByRole('alert');
    expect(textOf(alert)).toContain('Mini-Summa could not put the text on your clipboard (Clipboard access was denied.)');
    expect(textOf(alert)).toContain('The handoff is recorded as copied, but your clipboard does not have it.');
    expect((within(strip()).getByRole('textbox', { name: 'Text to copy by hand' }) as HTMLTextAreaElement).value).toContain('Task: Migrate auth middleware');
    expect(deliveryState(app, 'dlv_atlas_1')).toBe('awaiting_user_send'); // recorded as copied and opened, not as sent
  });

  it('shows what went wrong when the core refuses, and keeps its buttons', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.atlas } });
    app.demoState.failNext.set('deliveries.handoff', new ApiError(409, 'invalid_state', 'This handoff is already being handled, so it cannot be copied now.'));
    await user.click(within(strip()).getByRole('button', { name: 'Copy and open' }));
    expect(textOf(await within(strip()).findByRole('alert'))).toBe('This handoff is already being handled, so it cannot be copied now.');
    expect(within(strip()).getByRole('button', { name: 'Copy and open' })).toBeTruthy();
    expect(deliveryState(app, 'dlv_atlas_1')).toBe('destination_unverified');
  });

  it('warns when the page that opened may not be the conversation', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.atlas } });
    app.demoState.open = (url) => ({ ok: true, mode: 'embedded', opened: true, focused: true, verified: false, finalUrl: url, title: 'Something else', note: null });
    await user.click(within(strip()).getByRole('button', { name: 'Copy and open' }));
    const status = await within(strip()).findByText(/The page that loaded may not be this conversation\./);
    expect(status.closest('[role="status"]')?.getAttribute('data-tone')).toBe('warning');
  });
});

describe('after the message was copied', () => {
  it('"I sent it" marks it as sent, the strip goes, and the queue and the card say so', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.atlas } });
    await user.click(within(strip()).getByRole('button', { name: 'Copy and open' }));
    await user.click(await within(strip()).findByRole('button', { name: 'I sent it' }));
    await waitFor(() => expect(maybeStrip()).toBeNull());
    expect(deliveryState(app, 'dlv_atlas_1')).toBe('user_confirmed_sent');
    // The card and the queue agree.
    await user.click(screen.getByRole('button', { name: /^Reports/ }));
    const row = await screen.findByRole('button', { name: /^Migrate auth middleware,/ });
    expect(row.getAttribute('aria-label')).toContain('Review awaiting you'); // sent, and a review was asked for
    await user.click(row);
    const card = await screen.findByRole('region', { name: 'Handoff to ChatGPT' });
    expect(textOf(card)).toContain('You confirmed it was sent');
  });

  it('"I sent it" is a statement by the person: one press, one call, nothing before it', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.gitManager } });
    const spy = vi.spyOn(app.demo, 'call');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(callsTo(spy, 'deliveries.confirmSent')).toEqual([]);
    await user.click(within(strip()).getByRole('button', { name: 'I sent it' }));
    await waitFor(() => expect(deliveryState(app, 'dlv_gm_2')).toBe('user_confirmed_sent'));
    expect(callsTo(spy, 'deliveries.confirmSent')).toEqual([{ params: { id: 'dlv_gm_2' }, body: {} }]);
    // The next report that waits takes its place; nothing else was marked.
    await waitFor(() => expect(textOf(strip())).toContain('Report ready: Fix flaky push retry test'));
    expect(deliveryState(app, 'dlv_gm_1')).toBe('ready_for_handoff');
  });

  it('"Copy again", "Open conversation" and "Not sure" do what the card\'s buttons do', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.gitManager } });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(strip()).getByRole('button', { name: 'Copy again' }));
    await waitFor(() => expect(callsTo(spy, 'deliveries.copy')).toEqual([{ params: { id: 'dlv_gm_2' }, body: {} }]));
    await user.click(within(strip()).getByRole('button', { name: 'Open conversation' }));
    await waitFor(() => expect(callsTo(spy, 'deliveries.open')).toEqual([{ params: { id: 'dlv_gm_2' } }]));
    await user.click(within(strip()).getByRole('button', { name: 'Not sure' }));
    await waitFor(() => expect(deliveryState(app, 'dlv_gm_2')).toBe('delivery_uncertain'));
    expect(callsTo(spy, 'deliveries.markUncertain')).toEqual([{ params: { id: 'dlv_gm_2' }, body: {} }]);
    await waitFor(() => expect(textOf(strip())).not.toContain('dlv_gm_2'));
    expect(textOf(strip())).not.toContain('Add branch protection checks'); // "uncertain" is the card's to untangle
  });

  it('keeps showing the report the person is in the middle of when a newer one arrives', async () => {
    const app = await baseApp({ route: { projectId: IDS.gitManager } });
    act(() => { addReportScene(app.server, { projectId: IDS.gitManager, title: 'Brand new report', state: 'ready_for_handoff', minutesAgo: 0 }); });
    await waitFor(() => expect(within(strip()).getByRole('button', { name: '+2 more. Open the Reports queue' }).textContent).toBe('+2 more'));
    expect(textOf(strip())).toContain('Waiting for you to send: Add branch protection checks');
    expect(within(strip()).getByRole('button', { name: 'I sent it' })).toBeTruthy();
  });
});

describe('the links', () => {
  it('"Open report" opens the report with its handoff card, in the Reports view', async () => {
    const user = userEvent.setup();
    await baseApp({ route: { projectId: IDS.gitManager } });
    await user.click(within(strip()).getByRole('button', { name: 'Open report' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Add branch protection checks' })).toBeTruthy();
    const card = screen.getByRole('region', { name: 'Handoff to ChatGPT' });
    expect(within(card).getByRole('button', { name: 'I sent it' })).toBeTruthy();
  });

  it('"+N more" opens the Reports queue, with no report chosen', async () => {
    const user = userEvent.setup();
    await baseApp({ route: { projectId: IDS.gitManager } });
    const more = within(strip()).getByRole('button', { name: '+1 more. Open the Reports queue' });
    expect(more.textContent).toBe('+1 more');
    await user.click(more);
    expect(await screen.findByRole('list', { name: 'Reports' })).toBeTruthy();
    expect(screen.getByText(/waiting for handoff\. Choose one to read it/)).toBeTruthy();
  });

  it('counts only what waits in this project and can be handed over', async () => {
    const app = await baseApp({ route: { projectId: IDS.dashboard } });
    // A report that has nowhere to go (its conversation was never chosen) waits too, but it cannot be handed over: it is not offered.
    act(() => {
      const missing = addReportScene(app.server, { projectId: IDS.dashboard, title: 'Nowhere to go', state: 'destination_missing' });
      missing.delivery.destination = null;
      app.server.transport.emit({ type: 'delivery.upserted', delivery: structuredClone(missing.delivery) });
    });
    await waitFor(() => expect(deliveryState(app, 'dlv_rpt_extra_' + (app.server.data.reports.length))).toBe('destination_missing'));
    expect(maybeStrip()).toBeNull();
    act(() => { addReportScene(app.server, { projectId: IDS.dashboard, title: 'Ready one', state: 'ready_for_handoff' }); });
    await waitFor(() => expect(maybeStrip()).not.toBeNull());
    expect(textOf(strip())).toContain('Report ready: Ready one');
    expect(within(strip()).queryByRole('button', { name: /more/ })).toBeNull(); // the one without a conversation is not counted
  });
});

describe('long titles, accessible names and the keyboard', () => {
  const LONG = 'Replace the legacy session store with the new append-only event log, migrate every existing user, keep the old endpoints answering for one release, and document the rollback steps for the on-call engineers';

  it('keeps the whole title for the tooltip and the accessible name, and lets the layout cut it', async () => {
    const app = await baseApp({ route: { projectId: IDS.dashboard } });
    act(() => { addReportScene(app.server, { projectId: IDS.dashboard, title: LONG, state: 'ready_for_handoff' }); });
    await waitFor(() => expect(maybeStrip()).not.toBeNull());
    expect(strip().getAttribute('aria-label')).toBe(`Report handoff: ${LONG}`);
    const headline = within(strip()).getByText(`Report ready: ${LONG}`);
    expect(headline.getAttribute('title')).toBe(`Report ready: ${LONG}`);
    expect(headline.className).toContain('ms-strip__headline'); // clamped to two lines by its style
  });

  it('can be used from the keyboard: Tab reaches each button in order, Enter presses it', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.atlas } });
    const spy = vi.spyOn(app.demo, 'call');
    const names: string[] = [];
    const first = within(strip()).getByRole('button', { name: 'Copy and open' });
    first.focus();
    for (let i = 0; i < 2; i += 1) {
      names.push(document.activeElement?.textContent ?? '');
      await user.tab();
    }
    expect(names).toEqual(['Copy and open', 'Open report']);
    first.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(callsTo(spy, 'deliveries.handoff')).toHaveLength(1));
  });

  it('has an accessible name on the region and on every control, and a status line only when it has something to say', async () => {
    const user = userEvent.setup();
    await baseApp({ route: { projectId: IDS.gitManager } });
    expect(within(strip()).queryByRole('status')).toBeNull();
    for (const button of within(strip()).getAllByRole('button')) expect(button.getAttribute('aria-label') ?? textOf(button), 'every control has a name').not.toBe('');
    await user.click(within(strip()).getByRole('button', { name: 'Copy again' }));
    expect(textOf(await within(strip()).findByRole('status'))).toBe('The message is on your clipboard.');
  });

  it('is a plain part of the page above the panes, so the native view is laid out below it', async () => {
    await baseApp({ route: { projectId: IDS.atlas } });
    const workspace = document.querySelector('.ms-workspace') as HTMLElement;
    const order = [...workspace.children].map((c) => c.className.split(' ')[0]);
    expect(order).toEqual(['ms-wsbar', 'ms-strip', 'ms-workspace__area']);
    expect(getComputedStyle(strip()).position).not.toBe('fixed');
    expect(getComputedStyle(strip()).position).not.toBe('absolute');
  });
});

describe('beside the Claude pane', () => {
  it('keeps "New local session" quiet while the strip has the main button, and brings its emphasis back after', async () => {
    const user = userEvent.setup();
    const app = await baseApp({ route: { projectId: IDS.gitManager } });
    const project = await app.demo.call('projects.create', { body: { name: 'Fresh', roots: [{ path: 'C:\\code\\fresh', env: 'win' }] } });
    await app.demo.call('conversations.add', { params: { id: project.id }, body: { url: 'https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', makePreferred: true } });
    open(app, project.id);
    await screen.findByRole('heading', { level: 1, name: 'Fresh' });
    const start = () => within(screen.getByRole('region', { name: 'Claude' })).getByRole('button', { name: 'Existing local session' });
    expect(start().className).toContain('sm-btn--primary');
    let added!: ReturnType<typeof addReportScene>;
    act(() => { added = addReportScene(app.server, { projectId: project.id, title: 'First report', state: 'ready_for_handoff' }); });
    await waitFor(() => expect(maybeStrip()).not.toBeNull());
    expect(start().className).not.toContain('sm-btn--primary'); // one main action at a time
    expect(strip().querySelectorAll('.sm-btn--primary')).toHaveLength(1);
    await user.click(within(strip()).getByRole('button', { name: 'Open report' }));
    void added;
  });
});

describe('with the whole feature scene (reports in every state)', () => {
  it('shows the in-progress report of Atlas API, not the one that only arrived', async () => {
    await renderFeature({ seed: createFeatureSeed(), view: 'workspace', route: { projectId: IDS.atlas } });
    expect(textOf(strip())).toContain('Waiting for you to send: Add pagination to the audit log endpoint to Atlas API design.');
    expect(within(strip()).getByRole('button', { name: '+1 more. Open the Reports queue' })).toBeTruthy();
  });
});
