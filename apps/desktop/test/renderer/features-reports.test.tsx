import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@minisumma/shared';
import { describe, expect, it, vi } from 'vitest';
import { changeDelivery } from '../../src/renderer/src/dev/demo/features-handlers';
import { FEATURE_IDS } from '../../src/renderer/src/dev/demo/features-seed';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { callsTo, renderFeature, textOf } from './features-helpers';

const card = () => screen.getByRole('region', { name: 'Handoff to ChatGPT' });
const buttons = (root: HTMLElement) => within(root).queryAllByRole('button').map((b) => textOf(b));

describe('the report queue', () => {
  it('lists reports across projects, newest first, each with its project, a plain claim, the time and where the handoff stands', async () => {
    await renderFeature();
    const list = screen.getByRole('list', { name: 'Reports' });
    const rows = within(list).getAllByRole('button');
    const names = rows.map((r) => r.getAttribute('aria-label') ?? '');
    // Newest first: the fenced report (4 min), the first seeded one (9 min), the long one (35 min), ...
    expect(names[0]).toContain('Make the release script fail fast');
    expect(names[1]).toContain('Fix flaky push retry test');
    expect(names[2]).toContain('Move the clone pipeline to libgit2 1.9');
    const first = names[0];
    expect(first).toContain('GitManager');
    expect(first).toContain('Declared complete by Claude');
    expect(first).toContain('Ready for handoff');
    expect(first).toContain('Unread');
    expect(names.join(' ')).not.toMatch(/completed/i);
    // Other projects keep their own name on their rows.
    expect(names.find((n) => n.includes('Migrate auth middleware'))).toContain('Atlas API');
    expect(names.find((n) => n.includes('Migrate auth middleware'))).toContain('Declared blocked by Claude');
  });

  it('shows delivery states in plain words, and the review once a report was sent', async () => {
    await renderFeature();
    const row = (title: string) => screen.getByRole('button', { name: new RegExp(title) });
    expect(row('Add branch protection checks').getAttribute('aria-label')).toContain('Awaiting your send');
    expect(row('Upgrade libgit2').getAttribute('aria-label')).toContain('Review awaiting you');
    expect(row('Rewrite the install guide').getAttribute('aria-label')).toContain('No conversation chosen');
    expect(row('Candle chart zoom bug').getAttribute('aria-label')).toContain('Delivery uncertain');
    expect(row('Websocket reconnect backoff').getAttribute('aria-label')).toContain('Discarded');
    expect(row('Migrate auth middleware').getAttribute('aria-label')).toContain('Ready, conversation not verified');
    expect(row('Add pagination to the audit log').getAttribute('aria-label')).toContain('Copied, not sent yet');
  });

  it('filters by project and by waiting for handoff', async () => {
    const user = userEvent.setup();
    await renderFeature();
    const list = () => within(screen.getByRole('list', { name: 'Reports' })).getAllByRole('button');
    const total = list().length;

    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'Atlas API' }));
    expect(list().every((r) => (r.getAttribute('aria-label') ?? '').includes('Atlas API'))).toBe(true);
    expect(list().length).toBeLessThan(total);

    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'All projects' }));
    const waiting = screen.getByRole('button', { name: /^Waiting for handoff/ });
    expect(waiting.getAttribute('aria-pressed')).toBe('false');
    await user.click(waiting);
    expect(waiting.getAttribute('aria-pressed')).toBe('true');
    const labels = list().map((r) => r.getAttribute('aria-label') ?? '');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.join('\n')).not.toMatch(/You confirmed it was sent|Review awaiting you|Discarded|Delivery uncertain/);
    expect(labels.join('\n')).toContain('Awaiting your send');
  });

  it('says when nothing matches and offers to clear the filters', async () => {
    const user = userEvent.setup();
    await renderFeature();
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'Docs site' }));
    await user.click(screen.getByRole('button', { name: /^Waiting for handoff/ }));
    expect(within(screen.getByRole('list', { name: 'Reports' })).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: 'Trading dashboard' }));
    expect(await screen.findByText('No reports match these filters.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(screen.getByRole('list', { name: 'Reports' })).getAllByRole('button').length).toBeGreaterThan(5);
  });

  it('opens a report from the queue and marks it as read', async () => {
    const user = userEvent.setup();
    const app = await renderFeature();
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: /Make the release script fail fast/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Make the release script fail fast' })).toBeTruthy();
    await waitFor(() => expect(callsTo(spy, 'reports.markRead')).toEqual([{ params: { id: FEATURE_IDS.fenced } }]));
    await waitFor(() => expect(screen.getByRole('button', { name: /Make the release script fail fast/ }).getAttribute('aria-label')).not.toContain('Unread'));
    expect(screen.getByRole('button', { name: /Make the release script fail fast/ }).getAttribute('aria-current')).toBe('true');
  });
});

describe('the report', () => {
  it('shows the full text, monospace and selectable, with the claim and who owns it', async () => {
    const app = await renderFeature({ route: { reportId: FEATURE_IDS.long } });
    const text = await screen.findByRole('region', { name: 'Full report text' });
    const body = app.server.data.reports.find((r) => r.id === FEATURE_IDS.long)!.body;
    expect(body.length).toBeGreaterThan(29_000);
    // Every character of the report is on screen: nothing is cut off, whatever its length. (The fence lines become code blocks.)
    const shown = text.cloneNode(true) as HTMLElement;
    shown.querySelectorAll('figcaption').forEach((c) => c.remove());
    const withoutFences = body.split('\n').filter((line) => !/^`{3,}/.test(line)).join('\n');
    expect(shown.textContent!.replace(/\s+/g, '')).toBe(withoutFences.replace(/\s+/g, ''));
    expect(text.className).toContain('ms-mono');
    const about = document.querySelector('dl[aria-label="About this report"]')!;
    expect(textOf(about)).toContain('GitManager');
    expect(textOf(about)).toContain('Declared partial by Claude');
    expect(textOf(about)).toContain('This is a claim by the model, not proof that the work was done or tested.');
  });

  it('renders fenced blocks as code and treats markup as plain text', async () => {
    await renderFeature({ route: { reportId: FEATURE_IDS.fenced } });
    const text = await screen.findByRole('region', { name: 'Full report text' });
    const blocks = text.querySelectorAll('pre code');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].textContent).toContain('if git rev-parse');
    expect(text.querySelector('figcaption')?.textContent).toBe('bash');
    // The attack strings are visible text, not elements.
    expect(text.querySelector('img')).toBeNull();
    expect(text.querySelector('script')).toBeNull();
    expect(blocks[1].textContent).toContain('<img src=x onerror="alert(1)">');
    expect(blocks[1].textContent).toContain('<script>document.title = "hijacked"</script>');
    expect(document.title).not.toBe('hijacked');
    // Indentation outside code is kept.
    expect(text.textContent).toContain('   Indented text keeps its indentation.');
  });

  it('says how many credential-like strings were hidden, and only when some were', async () => {
    await renderFeature({ route: { reportId: FEATURE_IDS.fenced } });
    expect(await screen.findByText('3 credential-like strings were hidden when this report was captured.')).toBeTruthy();
  });

  it('does not mention hidden strings when there were none', async () => {
    await renderFeature({ route: { reportId: 'rpt_gm_1' } });
    await screen.findByRole('region', { name: 'Full report text' });
    expect(document.body.textContent).not.toContain('credential-like');
  });

  it('copies the full report text', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ route: { reportId: 'rpt_gm_1' } });
    await screen.findByRole('region', { name: 'Full report text' });
    await user.click(screen.getByRole('button', { name: 'Copy full report text' }));
    const body = app.server.data.reports.find((r) => r.id === 'rpt_gm_1')!.body;
    expect(app.fake.native.clipboard.writeText).toHaveBeenCalledWith(body);
  });

  it('saves the message as a file and then shows it in its folder', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ route: { reportId: 'rpt_gm_1' } });
    await screen.findByRole('region', { name: 'Full report text' });
    await user.click(screen.getByRole('button', { name: 'Save as file' }));
    await waitFor(() => expect(app.fake.native.shell.showItemInFolder).toHaveBeenCalledWith('C:\\Users\\dev\\Documents\\report.md'));
  });

  it('does nothing more when the save dialog was closed', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ route: { reportId: 'rpt_gm_1' } });
    app.demoState.savePath = null;
    await screen.findByRole('region', { name: 'Full report text' });
    await user.click(screen.getByRole('button', { name: 'Save as file' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as file' }).getAttribute('aria-busy')).toBeNull());
    expect(app.fake.native.shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('opens the project and the session it came from', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ route: { reportId: 'rpt_gm_1' } });
    await screen.findByRole('region', { name: 'Full report text' });
    await user.click(screen.getByRole('button', { name: 'Open session a1b2c3d4' }));
    expect(app.runtime.route.getState()).toMatchObject({ view: 'workspace', projectId: IDS.gitManager });
    expect(app.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(IDS.s.gmWorking);
  });

  it('says so when the report no longer exists', async () => {
    await renderFeature({ route: { reportId: 'rpt_gone' } });
    expect(await screen.findByText(/This report no longer exists/)).toBeTruthy();
  });

  it('says what went wrong when the report cannot be loaded, and loads it again on request', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ route: { reportId: 'rpt_gm_1' }, view: 'workspace' });
    app.demoState.failNext.set('reports.get', new ApiError(500, 'boom', 'The database is locked.'));
    app.runtime.route.getState().go({ view: 'reports', reportId: 'rpt_gm_1' });
    expect(await screen.findByText(/The report could not be loaded. The database is locked./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Full report text' })).toBeTruthy();
  });
});

describe('the handoff card in every state', () => {
  const openReport = async (reportId: string, patch?: (app: Awaited<ReturnType<typeof renderFeature>>) => void) => {
    const app = await renderFeature({ route: { reportId } });
    patch?.(app);
    await screen.findByRole('region', { name: 'Handoff to ChatGPT' });
    return app;
  };

  it('ready for handoff: Copy and open, a way to check first, and nothing that claims a send', async () => {
    await openReport('rpt_gm_1');
    const labels = buttons(card());
    expect(labels).toEqual(expect.arrayContaining(['Copy and open', 'Open to check it first', 'Discard', 'Change destination']));
    expect(labels).not.toContain('I sent it');
    expect(textOf(card())).not.toMatch(/\b(delivered|submitted)\b/i);
    expect(within(card()).getByRole('button', { name: 'Copy and open' }).className).toContain('sm-btn--primary');
  });

  it('awaiting your send: I sent it is the main action and the state is not called sent', async () => {
    await openReport('rpt_gm_2');
    const labels = buttons(card());
    expect(labels).toEqual(expect.arrayContaining(['I sent it', 'Open conversation', 'Copy again', 'Not sure', 'Discard']));
    expect(within(card()).getByRole('button', { name: 'I sent it' }).className).toContain('sm-btn--primary');
    expect(textOf(card())).toContain('Awaiting your send');
    expect(textOf(card())).toContain('It is not marked as sent yet');
    expect(textOf(card())).not.toMatch(/You confirmed it was sent/);
  });

  it('destination not verified: copy and open, with an honest word about the address', async () => {
    await openReport('rpt_atlas_1');
    expect(buttons(card())).toEqual(expect.arrayContaining(['Copy and open', 'Open to check it first']));
    expect(textOf(card())).toContain('has not confirmed that this address opens the conversation');
    expect(textOf(card())).toContain('Not verified yet');
  });

  it('no destination: choose one among the project\'s conversations, or add one', async () => {
    const app = await openReport('rpt_docs_1');
    expect(buttons(card())).toEqual(expect.arrayContaining(['Add a ChatGPT conversation', 'Discard']));
    expect(buttons(card())).not.toContain('Copy and open');
    expect(textOf(card())).toContain('No ChatGPT conversation is mapped to this project yet.');
    void app;
  });

  it('uncertain: Reopen is the main action, with I sent it and Open conversation', async () => {
    await openReport('rpt_dash_1');
    expect(buttons(card())).toEqual(expect.arrayContaining(['Reopen', 'I sent it', 'Open conversation']));
    expect(within(card()).getByRole('button', { name: 'Reopen' }).className).toContain('sm-btn--primary');
    expect(buttons(card())).not.toContain('Copy and open');
  });

  it('sent: a read-only record that says whose statement it is', async () => {
    await openReport('rpt_gm_3');
    expect(textOf(card())).toContain('You confirmed it was sent');
    expect(textOf(card())).toContain('this is your statement');
    expect(buttons(card())).toEqual(expect.arrayContaining(['Open conversation']));
    expect(buttons(card())).not.toContain('I sent it');
    expect(buttons(card())).not.toContain('Copy and open');
    expect(buttons(card())).not.toContain('Discard');
  });

  it('discarded: a read-only record that can be reopened', async () => {
    await openReport('rpt_dash_2');
    expect(textOf(card())).toContain('It is not recorded as sent.');
    expect(buttons(card())).toContain('Reopen');
    expect(buttons(card())).not.toContain('Copy and open');
  });
});

// ---------------------------------------------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof renderFeature>>;

const stateOf = (app: App, id: string) => app.server.data.deliveries.find((d) => d.id === id)!;
const open = async (reportId: string) => {
  const app = await renderFeature({ route: { reportId } });
  await screen.findByRole('region', { name: 'Handoff to ChatGPT' });
  return app;
};
const press = async (name: string | RegExp, root: HTMLElement = card()) => userEvent.setup().click(within(root).getByRole('button', { name }));

/** user-event installs its own clipboard on navigator when a user is set up; replace it afterwards with one that behaves as the test needs. */
function browserClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('Copy and open', () => {
  it('copies what the core returned, opens the conversation, and then waits for the person: awaiting, not sent', async () => {
    const app = await open('rpt_gm_1');
    const spy = vi.spyOn(app.demo, 'call');
    await press('Copy and open');
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'I sent it' })).toBeTruthy());

    expect(callsTo(spy, 'deliveries.handoff')).toEqual([{ params: { id: 'dlv_gm_1' }, body: {} }]);
    const written = vi.mocked(app.fake.native.clipboard.writeText).mock.calls.at(-1)![0];
    // The text on the clipboard is the whole message the core built: project header, the fenced report, the review request.
    expect(written).toContain('Project: GitManager');
    expect(written).toContain('Status declared by Claude: complete (a declaration by the model, not verified)');
    expect(written).toContain('<<<MINI-SUMMA REPORT rpt_gm_1 BEGIN>>>');
    expect(written).toContain(app.server.data.reports.find((r) => r.id === 'rpt_gm_1')!.body);
    expect(written).toContain('Please review this implementation report');

    const text = textOf(card());
    expect(text).toContain('Awaiting your send');
    expect(text).toContain('The message is on your clipboard.');
    expect(text).toContain('Opened in the ChatGPT view inside Mini-Summa.');
    expect(text).toContain('It is not marked as sent yet');
    expect(text).not.toContain('You confirmed it was sent');
    expect(stateOf(app, 'dlv_gm_1').state).toBe('awaiting_user_send');
  });

  it('does not wait on a core that already wrote the clipboard itself', async () => {
    const app = await open('rpt_gm_1');
    app.demoState.clipboard = 'native';
    await press('Copy and open');
    await waitFor(() => expect(textOf(card())).toContain('The message is on your clipboard.'));
    expect(app.fake.native.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('tells the person plainly when the clipboard refuses, and gives them the text to copy by hand', async () => {
    const user = userEvent.setup();
    const app = await open('rpt_gm_1');
    vi.mocked(app.fake.native.clipboard.writeText).mockRejectedValue(new Error('Access is denied'));
    browserClipboard(async () => { throw new Error('Document is not focused'); });
    await user.click(within(card()).getByRole('button', { name: 'Copy and open' }));
    const alert = await within(card()).findByRole('alert');
    expect(textOf(alert)).toContain('Mini-Summa could not put the text on your clipboard (Document is not focused).');
    expect(textOf(alert)).toContain('your clipboard does not have it');
    const fallback = within(card()).getByRole('textbox', { name: 'Text to copy by hand' }) as HTMLTextAreaElement;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toContain('<<<MINI-SUMMA REPORT rpt_gm_1 BEGIN>>>');
    // The card must not say that the text is on the clipboard.
    expect(textOf(card())).not.toContain('is on your clipboard');
  });

  it('falls back to the browser clipboard when the host refuses', async () => {
    const user = userEvent.setup();
    const app = await open('rpt_gm_1');
    const browser = vi.fn(async () => {});
    browserClipboard(browser);
    vi.mocked(app.fake.native.clipboard.writeText).mockRejectedValue(new Error('Access is denied'));
    await user.click(within(card()).getByRole('button', { name: 'Copy and open' }));
    await waitFor(() => expect(textOf(card())).toContain('The message is on your clipboard.'));
    expect(browser).toHaveBeenCalledTimes(1);
    expect(browser.mock.calls[0]).toEqual([expect.stringContaining('<<<MINI-SUMMA REPORT rpt_gm_1 BEGIN>>>')]);
    expect(within(card()).queryByRole('alert')).toBeNull();
  });

  it('reports a core that did not send the text to copy', async () => {
    const app = await open('rpt_gm_1');
    const real = app.demo.call;
    vi.spyOn(app.demo, 'call').mockImplementation((async (name: string, input?: unknown) => {
      const result = await (real as (n: string, i?: unknown) => Promise<unknown>)(name, input);
      return name === 'deliveries.handoff' ? { ...(result as object), text: null } : result;
    }) as never);
    await press('Copy and open');
    expect(textOf(await within(card()).findByRole('alert'))).toContain('Mini-Summa did not send the text to copy.');
  });

  it('shows what the host observed when it opened the page, not more', async () => {
    const app = await open('rpt_gm_1');
    app.demoState.open = (url) => ({ ok: true, mode: 'external', opened: true, focused: false, verified: null, finalUrl: url, title: null, note: null });
    await press('Copy and open');
    await waitFor(() => expect(textOf(card())).toContain('Opened your default browser.'));
    expect(textOf(card())).toContain('cannot see the browser window');
    expect(textOf(card())).toContain('could not check which page loaded');
  });

  it('shows a failed open as a failure, keeps the copy, and does not claim the conversation was reached', async () => {
    const app = await open('rpt_gm_1');
    app.demoState.open = () => ({ ok: false, mode: 'none', opened: false, focused: false, verified: null, finalUrl: null, title: null, note: 'No browser host is available.' });
    await press('Copy and open');
    await waitFor(() => expect(textOf(card())).toContain('Mini-Summa could not open ChatGPT. No browser host is available.'));
    expect(textOf(card())).toContain('The message is on your clipboard.');
    expect(stateOf(app, 'dlv_gm_1').state).toBe('copied');
    expect(textOf(card())).toContain('Copied, not sent yet');
    expect(textOf(card())).toContain('Last problem: No browser host is available.');
  });

  it('opens the conversation without copying when asked to check it first, and changes nothing else', async () => {
    const app = await open('rpt_gm_1');
    const spy = vi.spyOn(app.demo, 'call');
    await press('Open to check it first');
    await waitFor(() => expect(textOf(card())).toContain('Opened in the ChatGPT view'));
    expect(callsTo(spy, 'deliveries.open')).toHaveLength(1);
    expect(callsTo(spy, 'deliveries.copy')).toHaveLength(0);
    expect(app.fake.native.clipboard.writeText).not.toHaveBeenCalled();
    expect(stateOf(app, 'dlv_gm_1').state).toBe('ready_for_handoff');
  });

  it('shows the reason the core gives when it refuses, and nothing changes', async () => {
    const app = await open('rpt_gm_1');
    app.demoState.failNext.set('deliveries.handoff', new ApiError(502, 'clipboard_failed', 'Mini-Summa could not write to the clipboard (busy). Nothing was changed, so you can try again.'));
    await press('Copy and open');
    expect(textOf(await within(card()).findByRole('alert'))).toContain('Nothing was changed, so you can try again.');
    expect(stateOf(app, 'dlv_gm_1').state).toBe('ready_for_handoff');
    expect(within(card()).getByRole('button', { name: 'Copy and open' })).toBeTruthy();
  });
});

describe('after the person says what happened', () => {
  it('I sent it records the person\'s statement and starts the review', async () => {
    const app = await open('rpt_gm_2');
    const spy = vi.spyOn(app.demo, 'call');
    await press('I sent it');
    await waitFor(() => expect(textOf(card())).toContain('You confirmed it was sent'));
    expect(callsTo(spy, 'deliveries.confirmSent')).toEqual([{ params: { id: 'dlv_gm_2' }, body: {} }]);
    expect(stateOf(app, 'dlv_gm_2')).toMatchObject({ state: 'user_confirmed_sent', review: 'requested' });
    expect(await screen.findByRole('region', { name: 'Review' })).toBeTruthy();
    expect(buttons(card())).not.toContain('I sent it');
  });

  it('Not sure marks it uncertain, and Reopen brings back the first step without retrying anything', async () => {
    const app = await open('rpt_gm_2');
    const spy = vi.spyOn(app.demo, 'call');
    await press('Not sure');
    await waitFor(() => expect(textOf(card())).toContain('Delivery uncertain'));
    expect(textOf(card())).toContain('Nothing is retried for you.');
    await press('Reopen');
    await waitFor(() => expect(textOf(card())).toContain('Ready for handoff'));
    expect(callsTo(spy, 'deliveries.handoff')).toHaveLength(0);
    expect(callsTo(spy, 'deliveries.copy')).toHaveLength(0);
    expect(callsTo(spy, 'deliveries.open')).toHaveLength(0);
  });

  it('Discard is recorded at once and can be undone from the notice', async () => {
    const user = userEvent.setup();
    const app = await open('rpt_gm_2');
    await press('Discard');
    await waitFor(() => expect(textOf(card())).toContain('You discarded this handoff. It is not recorded as sent.'));
    expect(stateOf(app, 'dlv_gm_2').state).toBe('user_discarded');
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(stateOf(app, 'dlv_gm_2').state).toBe('awaiting_user_send'.replace('awaiting_user_send', 'ready_for_handoff')));
  });

  it('I sent it another way is there for a message handed over by hand, and only where the core accepts it', async () => {
    const user = userEvent.setup();
    const app = await open('rpt_gm_1');
    await user.click(within(card()).getByRole('button', { name: /Other ways to hand it over/ }));
    await user.click(within(card()).getByRole('button', { name: 'Copy the whole message' }));
    await waitFor(() => expect(textOf(card())).toContain('The whole message ('));
    expect(textOf(card())).toContain('This is not recorded as a handoff step.');
    expect(stateOf(app, 'dlv_gm_1').state).toBe('ready_for_handoff');
    await user.click(within(card()).getByRole('button', { name: 'I sent it another way' }));
    await waitFor(() => expect(stateOf(app, 'dlv_gm_1').state).toBe('user_confirmed_sent'));
  });
});

describe('the destination', () => {
  it('shows exactly which conversation receives the report, how it was chosen, and that it is fixed', async () => {
    await open('rpt_gm_1');
    const dest = within(card()).getByLabelText('Destination');
    expect(textOf(dest)).toContain('Release planning');
    expect(textOf(dest)).toContain('https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
    expect(textOf(dest)).toContain('Verified: Release planning for GitManager');
    expect(textOf(dest)).toContain('Chosen because it is the project\'s preferred conversation.');
    expect(textOf(dest)).toContain('fixed when the report was captured');
    expect(textOf(dest)).toContain('does not follow the open tab, the selected project or later changes to the project\'s preferred conversation');
  });

  it('keeps the frozen destination when the project\'s preferred conversation changes later, and when the selection moves elsewhere', async () => {
    const app = await open('rpt_gm_1');
    expect(textOf(within(card()).getByLabelText('Destination'))).toContain('Release planning');
    await app.demo.call('conversations.setPreferred', { params: { id: IDS.gitManager }, body: { conversationId: IDS.c.gmReview } });
    app.runtime.route.getState().selectSession(IDS.atlas, IDS.s.atlasIdle as never);
    await waitFor(() => expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.gitManager)?.preferredConversationId).toBe(IDS.c.gmReview));
    const dest = within(card()).getByLabelText('Destination');
    expect(textOf(dest)).toContain('Release planning');
    expect(textOf(dest)).not.toContain('Code review notes');
    // What Copy and open would use is the same: the delivery, not the project.
    const opened: string[] = [];
    app.server.onOpen = (url) => opened.push(url);
    await press('Copy and open');
    await waitFor(() => expect(stateOf(app, 'dlv_gm_1').state).toBe('awaiting_user_send'));
    expect(stateOf(app, 'dlv_gm_1').destination?.title).toBe('Release planning');
    expect(opened).toEqual(['https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b']);
  });

  it('says so when the conversation was removed or its address edited after the destination was fixed', async () => {
    const app = await open('rpt_gm_1');
    await app.demo.call('conversations.update', { params: { id: IDS.c.gmRelease }, body: { url: 'https://chatgpt.com/c/ffffffff-4d5e-4f60-8a9b-0c1d2e3f4a5b' } });
    await waitFor(() => expect(textOf(card())).toContain('now has a different address'));
    expect(textOf(card())).toContain('https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
  });

  it('changes the destination only after an explicit choice and a confirm, and writes it to the history', async () => {
    const user = userEvent.setup();
    const app = await open('rpt_gm_1');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(card()).getByRole('button', { name: 'Change destination' }));
    const dialog = screen.getByRole('dialog', { name: 'Change where this report goes?' });
    // Only this project's conversations can be chosen, and the current one cannot be chosen again.
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Release planning, current destination', 'Code review notes']);
    expect((radios[0] as HTMLInputElement).disabled).toBe(true);
    const confirm = within(dialog).getByRole('button', { name: 'Change destination' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(callsTo(spy, 'deliveries.setDestination')).toHaveLength(0);

    await user.click(within(dialog).getByRole('radio', { name: 'Code review notes' }));
    expect(callsTo(spy, 'deliveries.setDestination')).toHaveLength(0); // choosing is not confirming
    await user.click(confirm);
    await waitFor(() => expect(callsTo(spy, 'deliveries.setDestination')).toEqual([{ params: { id: 'dlv_gm_1' }, body: { conversationId: IDS.c.gmReview } }]));
    await waitFor(() => expect(textOf(within(card()).getByLabelText('Destination'))).toContain('Code review notes'));
    expect(textOf(within(card()).getByLabelText('Destination'))).toContain('Chosen by you.');
    expect(textOf(within(card()).getByLabelText('Destination'))).toMatch(/^Goes toCode review notes/);
    // The project's own preference did not move.
    expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.gitManager)?.preferredConversationId).toBe(IDS.c.gmRelease);

    await user.click(within(card()).getByRole('button', { name: /History/ }));
    expect(textOf(within(card()).getByRole('list', { name: 'History of this handoff' }))).toContain('Destination changed from Release planning to Code review notes');
  });

  it('closing the dialog changes nothing', async () => {
    const user = userEvent.setup();
    const app = await open('rpt_gm_1');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(card()).getByRole('button', { name: 'Change destination' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('radio', { name: 'Code review notes' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo(spy, 'deliveries.setDestination')).toHaveLength(0);
    expect(textOf(within(card()).getByLabelText('Destination'))).toContain('Release planning');
  });

  it('with no destination, offers the project\'s conversations and then the usual first step', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ route: { reportId: 'rpt_docs_1' } });
    // The Docs project has no conversation: add one the way the project dialog would.
    await screen.findByRole('region', { name: 'Handoff to ChatGPT' });
    await user.click(within(card()).getByRole('button', { name: 'Add a ChatGPT conversation' }));
    expect(app.runtime.ui.getState().projectDialog).toEqual({ mode: 'edit', projectId: IDS.docs });
    app.runtime.ui.getState().closeProjectDialog();
    await app.demo.call('conversations.add', { params: { id: IDS.docs }, body: { url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555', title: 'Docs planning' } });
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Choose a conversation' })).toBeTruthy());
    // The report still has no destination: adding a conversation does not choose it.
    expect(stateOf(app, 'dlv_docs_1').destination).toBeNull();
    await user.click(within(card()).getByRole('button', { name: 'Choose a conversation' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose a conversation' });
    await user.click(within(dialog).getByRole('radio', { name: 'Docs planning' }));
    await user.click(within(dialog).getByRole('button', { name: 'Use this conversation' }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy and open' })).toBeTruthy());
    expect(textOf(card())).toContain('Docs planning');
    expect(textOf(card())).toContain('Chosen by you.');
    expect(textOf(card())).toContain('Destination not verified'.replace('Destination not', 'Not'));
  });
});

describe('long reports in parts', () => {
  it('names the part on the main button, lists the parts, and advances one part at a time', async () => {
    const user = userEvent.setup();
    const app = await open(FEATURE_IDS.long);
    const id = `dlv_${FEATURE_IDS.long}`;
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy part 1 of 3 and open' })).toBeTruthy());
    const parts = within(card()).getByRole('list', { name: 'Parts of the message' });
    expect(within(parts).getAllByRole('listitem')).toHaveLength(3);
    expect(textOf(parts)).toContain('Part 1 of 3');
    expect(within(parts).getAllByRole('img', { name: 'Not copied yet' })).toHaveLength(3);
    expect(textOf(card())).toContain('it has 3 parts');

    await user.click(within(card()).getByRole('button', { name: 'Copy part 1 of 3 and open' }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy part 2 of 3 and open' })).toBeTruthy());
    expect(within(parts).getAllByRole('img', { name: 'Copied' })).toHaveLength(1);
    expect(textOf(card())).toContain('Part 1 of 3 is on your clipboard.');
    const first = vi.mocked(app.fake.native.clipboard.writeText).mock.calls.at(-1)![0];
    expect(first.startsWith('[Mini-Summa report rpt_long, part 1 of 3]')).toBe(true);
    expect(first.endsWith('[End of part 1 of 3. More parts follow. Do not answer yet.]')).toBe(true);
    // I sent it is not offered while parts are missing, and the state is still waiting.
    expect(buttons(card())).not.toContain('I sent it');
    expect(stateOf(app, id).state).toBe('awaiting_user_send');

    // Any part can be copied again or out of order.
    await user.click(within(card()).getByRole('button', { name: 'Copy part 3 of 3' }));
    await waitFor(() => expect(within(parts).getAllByRole('img', { name: 'Copied' })).toHaveLength(2));
    const third = vi.mocked(app.fake.native.clipboard.writeText).mock.calls.at(-1)![0];
    expect(third.startsWith('[Mini-Summa report rpt_long, part 3 of 3]')).toBe(true);
    expect(third.endsWith('[End of part 3 of 3. That was the complete report.]')).toBe(true);
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy part 2 of 3 and open' })).toBeTruthy());

    await user.click(within(card()).getByRole('button', { name: 'Copy part 2 of 3' }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'I sent it' })).toBeTruthy());
    expect(within(parts).getAllByRole('img', { name: 'Copied' })).toHaveLength(3);
  });

  it('the parts put back together are the message, nothing lost', async () => {
    const user = userEvent.setup();
    const app = await open(FEATURE_IDS.long);
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy part 1 of 3 and open' })).toBeTruthy());
    for (const n of [1, 2, 3]) await user.click(within(card()).getByRole('button', { name: `Copy part ${n} of 3` }));
    const copies = vi.mocked(app.fake.native.clipboard.writeText).mock.calls.map((c) => c[0]);
    expect(copies).toHaveLength(3);
    const payloads = copies.map((t) => t.replace(/^\[Mini-Summa report [^\]]+\]\n/, '').replace(/\n\[End of part \d+ of \d+\.[^\]]*\]$/, ''));
    await user.click(within(card()).getByRole('button', { name: /Other ways to hand it over/ }));
    await user.click(within(card()).getByRole('button', { name: 'Copy the whole message' }));
    await waitFor(() => expect(vi.mocked(app.fake.native.clipboard.writeText).mock.calls).toHaveLength(4));
    const whole = vi.mocked(app.fake.native.clipboard.writeText).mock.calls[3][0];
    expect(payloads.join('')).toBe(whole);
    expect(whole).toContain(app.server.data.reports.find((r) => r.id === FEATURE_IDS.long)!.body);
  });

  it('Copy again after the destination changes starts from part 1', async () => {
    const user = userEvent.setup();
    const app = await open(FEATURE_IDS.long);
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy part 1 of 3 and open' })).toBeTruthy());
    await user.click(within(card()).getByRole('button', { name: 'Copy part 1 of 3 and open' }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy part 2 of 3 and open' })).toBeTruthy());
    await user.click(within(card()).getByRole('button', { name: 'Change destination' }));
    const dialog = screen.getByRole('dialog');
    expect(textOf(dialog)).toContain('Parts you already copied are cleared');
    await user.click(within(dialog).getByRole('radio', { name: 'Code review notes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Change destination' }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy part 1 of 3 and open' })).toBeTruthy());
    expect(stateOf(app, `dlv_${FEATURE_IDS.long}`).parts.every((p) => p.copiedAt === null)).toBe(true);
  });
});

describe('the handoff follows the core live', () => {
  it('updates when the delivery changes elsewhere, without reloading', async () => {
    const app = await open('rpt_gm_1');
    expect(textOf(card())).toContain('Ready for handoff');
    changeDelivery(app.server, 'dlv_gm_1', { state: 'user_confirmed_sent', review: 'requested' });
    await waitFor(() => expect(textOf(card())).toContain('You confirmed it was sent'));
    expect(buttons(card())).not.toContain('Copy and open');
    expect(await screen.findByRole('region', { name: 'Review' })).toBeTruthy();
    // The queue row follows too.
    expect(screen.getByRole('button', { name: /Fix flaky push retry test/ }).getAttribute('aria-label')).toContain('Review awaiting you');
  });

  it('keeps a collapsed history that opens to plain sentences', async () => {
    const user = userEvent.setup();
    await open('rpt_gm_3');
    expect(within(card()).queryByRole('list', { name: 'History of this handoff' })).toBeNull();
    const toggle = within(card()).getByRole('button', { name: /^History/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    const history = within(card()).getByRole('list', { name: 'History of this handoff' });
    const text = textOf(history);
    expect(text).toContain('Handoff created');
    expect(text).toContain('Destination fixed: Release planning');
    expect(text).toContain('You confirmed it was sent');
    expect(text).not.toMatch(/destination_resolved|confirmed_sent|part_copied/);
  });

  it('offers to prepare a handoff for a report that has none', async () => {
    const user = userEvent.setup();
    const app = await renderFeature();
    const report = { ...app.server.data.reports.find((r) => r.id === 'rpt_gm_1')!, id: 'rpt_nodelivery', taskTitle: 'A report without a handoff', delivery: null, deliveries: [] };
    app.server.data.reports.unshift(report);
    app.server.transport.emit({ type: 'report.upserted', report });
    app.runtime.route.getState().go({ reportId: 'rpt_nodelivery' });
    expect(await screen.findByText('No handoff has been prepared for this report yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy and open' })).toBeTruthy());
    expect(app.server.data.deliveries.some((d) => d.reportId === 'rpt_nodelivery')).toBe(true);
  });
});

describe('Other final messages', () => {
  it('lists the messages that carried no report marker and keeps them apart from reports', async () => {
    const user = userEvent.setup();
    await renderFeature();
    await user.click(await screen.findByRole('tab', { name: 'Other messages (2)' }));
    const list = await screen.findByRole('list', { name: 'Other final messages' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(textOf(list)).toContain('The final message has no report marker.');
    expect(textOf(list)).toContain('The report marker is missing the task title.');
    // The promoted one is not listed any more.
    expect(textOf(list)).not.toContain('Old note that was already promoted');
  });

  it('promotes one only after a confirm that explains what it becomes', async () => {
    const user = userEvent.setup();
    const app = await renderFeature();
    await user.click(await screen.findByRole('tab', { name: /Other messages/ }));
    const list = await screen.findByRole('list', { name: 'Other final messages' });
    await user.click(within(list).getByRole('button', { name: /I looked at the failing push test/ }));
    expect(await screen.findByRole('heading', { level: 1, name: /I looked at the failing push test/ })).toBeTruthy();
    expect(textOf(screen.getByRole('region', { name: 'Final message' }))).toContain('Not a report: The final message has no report marker.');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Make this a report' }));
    const dialog = screen.getByRole('dialog', { name: 'Make this message a report?' });
    expect(textOf(dialog)).toContain('Claude did not mark this message as a report, so you are deciding that it is one.');
    expect(textOf(dialog)).toContain('listed as partial');
    expect(callsTo(spy, 'candidates.promote')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Make it a report' }));
    await waitFor(() => expect(callsTo(spy, 'candidates.promote')).toEqual([{ params: { id: FEATURE_IDS.candidates.plain } }]));
    // It is now a report, in the queue, with a handoff, and the view moved to it.
    expect(await screen.findByRole('heading', { level: 1, name: /I looked at the failing push test/ })).toBeTruthy();
    await waitFor(() => expect(app.runtime.route.getState().reportId).toBe(FEATURE_IDS.candidates.plain));
    expect(await screen.findByText('A final message without a report marker. You made it a report.')).toBeTruthy();
    expect(app.server.data.deliveries.some((d) => d.reportId === FEATURE_IDS.candidates.plain)).toBe(true);
  });

  it('cancelling the confirm promotes nothing', async () => {
    const user = userEvent.setup();
    const app = await renderFeature();
    await user.click(await screen.findByRole('tab', { name: /Other messages/ }));
    await user.click(within(await screen.findByRole('list', { name: 'Other final messages' })).getAllByRole('button')[0]);
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(await screen.findByRole('button', { name: 'Make this a report' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(callsTo(spy, 'candidates.promote')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const review = () => screen.getByRole('region', { name: 'Review' });
const stepper = () => within(review()).getByRole('list', { name: 'Review progress' });
const stepStatus = (label: string) => within(stepper()).getByText(label).closest('li')!.getAttribute('data-status');

describe('the review, step by step', () => {
  it('shows the six steps and where the review stands, from delivery.review', async () => {
    await open('rpt_gm_3');
    const items = within(stepper()).getAllByRole('listitem');
    expect(items.map((i) => i.textContent!.replace(/, (done|current step|not reached)$/, ''))).toEqual(['Report ready', 'Sent by you', 'Review awaiting you', 'Review noted', 'Follow-up prepared', 'Sent to Claude']);
    expect(stepStatus('Report ready')).toBe('done');
    expect(stepStatus('Sent by you')).toBe('done');
    expect(stepStatus('Review awaiting you')).toBe('current');
    expect(stepStatus('Review noted')).toBe('todo');
    expect(within(stepper()).getByText('Review awaiting you').closest('li')!.getAttribute('aria-current')).toBe('step');
    expect(textOf(review())).toContain('Mini-Summa cannot see ChatGPT');
  });

  it('moves only when the person says so: read, then a follow-up, then closing and reopening', async () => {
    const user = userEvent.setup();
    const app = await open('rpt_gm_3');
    const spy = vi.spyOn(app.demo, 'call');
    // Nothing moves by itself.
    await new Promise((r) => setTimeout(r, 200));
    expect(callsTo(spy, 'deliveries.setReview')).toHaveLength(0);
    expect(within(review()).getByRole('button', { name: 'I have read the review' }).className).toContain('sm-btn--primary');

    await user.click(within(review()).getByRole('button', { name: 'I have read the review' }));
    await waitFor(() => expect(stepStatus('Review noted')).toBe('done'));
    expect(callsTo(spy, 'deliveries.setReview')).toEqual([{ params: { id: 'dlv_gm_3' }, body: { review: 'received' } }]);
    expect(stepStatus('Follow-up prepared')).toBe('current');
    expect(within(review()).queryByRole('button', { name: 'I have read the review' })).toBeNull();
    expect(within(review()).getByRole('button', { name: 'Write a follow-up for Claude' }).className).toContain('sm-btn--primary');

    await user.click(within(review()).getByRole('button', { name: 'Close review' }));
    await waitFor(() => expect(textOf(review())).toContain('You closed this review.'));
    expect(within(review()).getByRole('button', { name: 'Reopen review' })).toBeTruthy();
    expect(within(review()).queryByRole('button', { name: 'Close review' })).toBeNull();

    await user.click(within(review()).getByRole('button', { name: 'Reopen review' }));
    await waitFor(() => expect(stepStatus('Review noted')).toBe('done'));
    expect(callsTo(spy, 'deliveries.setReview').map((c) => (c as { body: { review: string } }).body.review)).toEqual(['received', 'closed', 'received']);
  });

  it('is not shown before the message was sent', async () => {
    await open('rpt_gm_2');
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
  });

  it('explains a send without a review request instead of offering steps that cannot happen', async () => {
    const app = await renderFeature({ route: { reportId: 'rpt_gm_3' } });
    changeDelivery(app.server, 'dlv_gm_3', { review: 'none' });
    await screen.findByRole('region', { name: 'Review' });
    await waitFor(() => expect(textOf(review())).toContain('No review was requested with this message'));
    expect(within(review()).queryByRole('button', { name: 'I have read the review' })).toBeNull();
  });
});

describe('the follow-up to Claude', () => {
  async function composer(options: { eligibleOrigin?: boolean } = {}) {
    const user = userEvent.setup();
    const app = await renderFeature({ route: { reportId: 'rpt_gm_3' } });
    if (options.eligibleOrigin) {
      // The session that wrote the report is waiting for the person.
      const s = app.server.data.sessions.find((x) => x.key === IDS.s.gmExternal)!;
      Object.assign(s, { origin: 'managed', state: 'waiting_for_you', stateLabel: 'Waiting for you', terminal: { cols: 120, rows: 32, exited: false } });
      app.server.transport.emit({ type: 'session.upserted', session: structuredClone(s) });
    }
    await screen.findByRole('region', { name: 'Review' });
    changeDelivery(app.server, 'dlv_gm_3', { review: 'received' });
    await user.click(await within(review()).findByRole('button', { name: 'Write a follow-up for Claude' }));
    return { user, app };
  }
  const target = (name: RegExp) => within(review()).getByRole('radio', { name });

  it('lists the project\'s sessions with who they are, and disables the ones that cannot take it, with the reason', async () => {
    await composer();
    const group = within(review()).getByRole('radiogroup', { name: 'Claude session' });
    const rows = within(group).getAllByRole('radio');
    expect(rows).toHaveLength(5); // GitManager has five sessions in the demo
    const row = (short: string) => target(new RegExp(`session ${short}`)).closest('.ms-rep-target') as HTMLElement;

    // Eligible: managed, live, waiting for the person.
    expect((target(/session e5f6a7b8/) as HTMLInputElement).disabled).toBe(false);
    expect(textOf(row('e5f6a7b8'))).toBe('GitManager, session e5f6a7b8managed, Windows, live, Waiting for you, generation 1');

    // Working, waiting for permission, observed, ended: each is disabled and says why.
    expect((target(/session a1b2c3d4/) as HTMLInputElement).disabled).toBe(true);
    expect(textOf(row('a1b2c3d4'))).toContain('Not ready: Claude is working. Wait until it is waiting for you.');
    expect((target(/session b7c8d9e0/) as HTMLInputElement).disabled).toBe(true);
    expect(textOf(row('b7c8d9e0'))).toContain('Not ready: Claude is waiting for permission. Answer that first.');
    expect((target(/session d4e5f6a1/) as HTMLInputElement).disabled).toBe(true);
    expect(textOf(row('d4e5f6a1'))).toContain('observed, Windows, live, Idle, generation 1');
    expect(textOf(row('d4e5f6a1'))).toContain('Observed session: Mini-Summa only watches sessions it did not start, so it cannot type into them. You can continue it from the Claude app with Remote Control.');
    expect((target(/session 2a3b4c5d/) as HTMLInputElement).disabled).toBe(true);
    expect(textOf(row('2a3b4c5d'))).toContain('Ended: this session is not running. Resume it in its project first.');
    // A disabled option is described by its reason for assistive technology.
    const described = target(/session a1b2c3d4/).getAttribute('aria-describedby')!;
    expect(document.getElementById(described)?.textContent).toContain('Not ready');
  });

  it('chooses nothing by itself when the session that wrote the report cannot take it', async () => {
    await composer();
    expect(within(review()).getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(textOf(review())).toContain('The session that wrote the report cannot take it right now. Choose another one, or wait.');
    expect(textOf(review())).toContain('(wrote this report)');
  });

  it('defaults to the session that wrote the report when it can take it', async () => {
    await composer({ eligibleOrigin: true });
    expect((target(/session d4e5f6a1/) as HTMLInputElement).checked).toBe(true);
    expect(textOf(review())).not.toContain('cannot take it right now');
  });

  it('will not send until the exact text has been inspected, and an edit takes the inspection back', async () => {
    const { user } = await composer({ eligibleOrigin: true });
    const send = () => within(review()).getByRole('button', { name: 'Send to Claude' }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    await user.type(within(review()).getByRole('textbox', { name: 'Feedback for Claude' }), 'Use the fake clock in the second backoff test too.');
    expect(send().disabled).toBe(true);
    expect(textOf(review())).toContain('Inspect the exact text first. Nothing is sent until you confirm.');

    await user.click(within(review()).getByRole('button', { name: 'Inspect exact text' }));
    const shown = within(review()).getByRole('region', { name: 'Exact text that will be typed' });
    expect(textOf(shown)).toContain('Mini-Summa will type this into GitManager, session d4e5f6a1 (managed, Windows) and press Enter.');
    expect(textOf(shown)).toContain('Use the fake clock in the second backoff test too.');
    expect(send().disabled).toBe(false);

    await user.type(within(review()).getByRole('textbox', { name: 'Feedback for Claude' }), ' And run it on Linux.');
    // The inspection panel is open and shows the new text, so it counts as inspected again.
    expect(textOf(within(review()).getByRole('region', { name: 'Exact text that will be typed' }))).toContain('And run it on Linux.');
    expect(send().disabled).toBe(false);
    await user.click(within(review()).getByRole('button', { name: 'Hide exact text' }));
    await user.type(within(review()).getByRole('textbox', { name: 'Feedback for Claude' }), ' More.');
    expect(send().disabled).toBe(true);
  });

  it('asks in a dialog that names the destination, starts on Cancel, and sends nothing until confirmed', async () => {
    const { user, app } = await composer({ eligibleOrigin: true });
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(review()).getByRole('textbox', { name: 'Feedback for Claude' }), 'Fix the second backoff test.');
    await user.click(within(review()).getByRole('button', { name: 'Inspect exact text' }));
    await user.click(within(review()).getByRole('button', { name: 'Send to Claude' }));

    const dialog = screen.getByRole('dialog', { name: 'Send to GitManager, session d4e5f6a1 (managed, Windows)?' });
    expect(textOf(dialog)).toContain('Mini-Summa will type this text into that terminal and press Enter.');
    expect(within(dialog).getByLabelText('Text that will be typed').textContent).toBe('Fix the second backoff test.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(callsTo(spy, 'actions.create')).toHaveLength(0);
    expect(callsTo(spy, 'deliveries.setReview')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo(spy, 'actions.create')).toHaveLength(0);
  });

  it('keeps the draft, types it, and reports the true outcome', async () => {
    const { user, app } = await composer({ eligibleOrigin: true });
    const spy = vi.spyOn(app.demo, 'call');
    await user.type(within(review()).getByRole('textbox', { name: 'Feedback for Claude' }), 'Fix the second backoff test.');
    await user.click(within(review()).getByRole('button', { name: 'Inspect exact text' }));
    await user.click(within(review()).getByRole('button', { name: 'Send to Claude' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send to Claude' }));

    await waitFor(() => expect(callsTo(spy, 'actions.create')).toHaveLength(1));
    // The draft is saved first, so the record holds exactly what was typed; then the prompt goes with the session's generation and the report.
    expect(callsTo(spy, 'deliveries.setReview')).toEqual([{ params: { id: 'dlv_gm_3' }, body: { review: 'follow_up_drafted', followUpDraft: 'Fix the second backoff test.' } }]);
    expect(callsTo(spy, 'actions.create')).toEqual([{ body: { sessionKey: IDS.s.gmExternal, text: 'Fix the second backoff test.', expectGeneration: 1, reportId: 'rpt_gm_3', deliveryId: 'dlv_gm_3' } }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(review()).findByText(/^Typed into GitManager, session d4e5f6a1 \(managed, Windows\) and sent with Enter at /)).toBeTruthy();
    await waitFor(() => expect(stepStatus('Sent to Claude')).toBe('done'));
    expect(textOf(review())).toContain('What was typed:');
    expect(textOf(review())).toContain('Fix the second backoff test.');
    expect(app.server.data.deliveries.find((d) => d.id === 'dlv_gm_3')!.review).toBe('follow_up_sent');
  });

  it('shows the failure text and keeps everything for another try when the terminal could not take it', async () => {
    const { user, app } = await composer({ eligibleOrigin: true });
    app.demoState.promptFailure = 'Typing failed unexpectedly (the terminal closed). Look at the terminal to see whether anything arrived.';
    await user.type(within(review()).getByRole('textbox', { name: 'Feedback for Claude' }), 'Try again later.');
    await user.click(within(review()).getByRole('button', { name: 'Inspect exact text' }));
    await user.click(within(review()).getByRole('button', { name: 'Send to Claude' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send to Claude' }));
    const outcome = await within(review()).findByText(/^Not sent: /);
    expect(outcome.textContent).toBe('Not sent: Typing failed unexpectedly (the terminal closed). Look at the terminal to see whether anything arrived. Nothing is retried for you, and your text is kept.');
    expect(outcome.getAttribute('role')).toBe('alert');
    expect((within(review()).getByRole('textbox', { name: 'Feedback for Claude' }) as HTMLTextAreaElement).value).toBe('Try again later.');
    expect(app.server.data.deliveries.find((d) => d.id === 'dlv_gm_3')!.review).toBe('follow_up_drafted');
    expect((within(review()).getByRole('button', { name: 'Send to Claude' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the core\'s refusal inside the dialog when the session changed since it was inspected', async () => {
    const { user, app } = await composer({ eligibleOrigin: true });
    await user.type(within(review()).getByRole('textbox', { name: 'Feedback for Claude' }), 'Check the logs.');
    await user.click(within(review()).getByRole('button', { name: 'Inspect exact text' }));
    await user.click(within(review()).getByRole('button', { name: 'Send to Claude' }));
    // While the dialog is open the session starts working again: the core re-checks and refuses.
    const s = app.server.data.sessions.find((x) => x.key === IDS.s.gmExternal)!;
    s.state = 'working'; s.stateLabel = 'Working';
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send to Claude' }));
    expect(textOf(await within(dialog).findByRole('alert'))).toContain('Claude is not ready for input (working). Wait until it is waiting for you.');
    expect(app.server.data.actions.some((a) => a.kind === 'claude_prompt' && a.text === 'Check the logs.')).toBe(false);
    expect((within(review()).getByRole('textbox', { name: 'Feedback for Claude' }) as HTMLTextAreaElement).value).toBe('Check the logs.');
  });

  it('saves a draft on request and says so, and never loses the text when saving fails', async () => {
    const { user, app } = await composer();
    const field = within(review()).getByRole('textbox', { name: 'Feedback for Claude' });
    await user.type(field, 'Draft for later.');
    expect(textOf(review())).toContain('Not saved yet');
    app.demoState.failNext.set('deliveries.setReview', new ApiError(500, 'x', 'The database is locked.'));
    await user.click(within(review()).getByRole('button', { name: 'Save draft' }));
    expect(textOf(await within(review()).findByRole('alert'))).toContain('The database is locked.');
    expect((field as HTMLTextAreaElement).value).toBe('Draft for later.');
    await user.click(within(review()).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(textOf(review())).toContain('Draft saved'));
    expect(app.server.data.deliveries.find((d) => d.id === 'dlv_gm_3')).toMatchObject({ review: 'follow_up_drafted', followUpDraft: 'Draft for later.' });
    expect(stepStatus('Follow-up prepared')).toBe('done');
  });

  it('comes back with the saved draft', async () => {
    const app = await renderFeature({ route: { reportId: 'rpt_gm_3' } });
    changeDelivery(app.server, 'dlv_gm_3', { review: 'follow_up_drafted', followUpDraft: 'Saved earlier.' });
    const field = await within(await screen.findByRole('region', { name: 'Review' })).findByRole('textbox', { name: 'Feedback for Claude' });
    expect((field as HTMLTextAreaElement).value).toBe('Saved earlier.');
    expect(textOf(review())).toContain('Draft saved');
  });

  it('says so when the project has no session to send to', async () => {
    const app = await renderFeature({ route: { reportId: 'rpt_docs_1' } });
    changeDelivery(app.server, 'dlv_docs_1', { state: 'user_confirmed_sent', review: 'received' });
    await userEvent.setup().click(await within(await screen.findByRole('region', { name: 'Review' })).findByRole('button', { name: 'Write a follow-up for Claude' }));
    // The Docs project has one session, and it is disconnected.
    expect(textOf(review())).toContain('Disconnected: Mini-Summa lost this terminal');
    expect((within(review()).getByRole('button', { name: 'Send to Claude' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
