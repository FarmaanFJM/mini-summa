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
