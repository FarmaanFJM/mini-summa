// The unified "New Claude session" chooser: cloud (the official CLI), temporary local, existing local. The core is the demo core, so
// these tests prove what the interface asks of the core and shows, not what the real CLI or GitHub do (those are covered in packages/core).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { cloudDemoState } from '../../src/renderer/src/dev/demo/cloud-handlers';
import { draftStore } from '../../src/renderer/src/features/workspace/sessionModes';
import type { RenderedApp } from './helpers';
import { createFakeNative, renderApp, stubWorkspaceGeometry } from './helpers';

// Addresses are built from parts: the publish guard refuses a literal session address anywhere in the repository.
const CODE = 'https://claude.ai/code/';

vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

beforeEach(() => draftStore.clearAll());
afterEach(() => { clearNativeBounds(); vi.restoreAllMocks(); });

const claude = () => screen.getByRole('region', { name: 'Claude' });
const plus = () => within(claude()).getByRole('button', { name: 'New session' });
const callsOf = (spy: ReturnType<typeof vi.spyOn>, name: string) => (spy.mock.calls as unknown[][]).filter((c) => c[0] === name);

async function open(app: RenderedApp, user: ReturnType<typeof userEvent.setup>, project: { name: string; roots?: { path: string }[]; repo?: string }) {
  await app.demo.call('projects.create', { body: { name: project.name, githubRepo: project.repo, roots: project.roots ?? [] } });
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${project.name}(,|$)`) }));
  await screen.findByRole('heading', { level: 1, name: project.name });
}

/** A long, multi-line prompt with quotes, percent signs and a leading dash line: the kind that must survive untouched. */
const LONG = ['Implement the billing migration.', '', '- Keep "quotes", 100% of this text, `code` and $VARS.', ...Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: do the thing with care.`)].join('\n');

async function chooseMode(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(plus());
  await user.click(screen.getByRole('menuitem', { name: label }));
  return screen.findByRole('dialog', { name: 'New Claude session' });
}

describe('which ways a project can run Claude', () => {
  it('offers all three for a project with a repository and a folder, and the plus menu names them', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await open(app, user, { name: 'Both', roots: [{ path: 'C:\\Dev\\both' }], repo: 'acme/both' });
    await user.click(plus());
    const items = within(screen.getByRole('menu', { name: 'New session' })).getAllByRole('menuitem').map((i) => i.textContent ?? '');
    expect(items.slice(0, 3)).toEqual([
      expect.stringContaining('Cloud session'), expect.stringContaining('Temporary local session'), expect.stringContaining('Existing local session'),
    ]);
    expect(items.join(' ')).toContain('Runs Claude on remote infrastructure using the official CLI.');
  });

  it('a GitHub-only project can use cloud and temporary, not an existing folder; the radio says why', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await open(app, user, { name: 'Remote', repo: 'acme/remote' });
    const dialog = await chooseMode(user, 'Cloud session');
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.disabled)).toEqual([false, false, true]);
    expect(within(dialog).getByText(/Uses one of the project's configured local folders\. Needs a folder on this computer\./)).toBeTruthy();
  });

  it('a folder-only project can use only the existing folder', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await open(app, user, { name: 'Folder', roots: [{ path: 'C:\\Dev\\folder' }, { path: 'C:\\Dev\\other' }] });
    const dialog = await chooseMode(user, 'Existing local session');
    expect((within(dialog).getAllByRole('radio') as HTMLInputElement[]).map((r) => r.disabled)).toEqual([true, true, false]);
  });

  it('creating a session never creates another project', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await open(app, user, { name: 'One', roots: [{ path: 'C:\\Dev\\one' }], repo: 'acme/one' });
    const before = (await app.demo.call('projects.list', {})).length;
    const dialog = await chooseMode(user, 'Cloud session');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Task for Claude/ }), { target: { value: 'Do it' } });
    await user.click(within(dialog).getByRole('checkbox'));
    const send = await within(dialog).findByRole('button', { name: 'Send to Claude cloud' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    await user.click(send);
    await within(dialog).findByText('Session created');
    expect((await app.demo.call('projects.list', {})).length).toBe(before);
  });
});

describe('the cloud composer', () => {
  it('keeps the whole prompt exactly, needs the acknowledgement, and shows the dispatch as created with a link', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const spy = vi.spyOn(app.demo, 'call');
    await open(app, user, { name: 'Both', roots: [{ path: 'C:\\Dev\\both' }], repo: 'acme/both' });
    const dialog = await chooseMode(user, 'Cloud session');
    const box = within(dialog).getByRole('textbox', { name: /Task for Claude/ });
    fireEvent.change(box, { target: { value: LONG } });
    expect(await within(dialog).findByText(/passed to the Claude CLI exactly as written/)).toBeTruthy();
    const send = await within(dialog).findByRole('button', { name: 'Send to Claude cloud' });
    expect((send as HTMLButtonElement).disabled).toBe(true); // the acknowledgement comes first
    await user.click(within(dialog).getByRole('checkbox'));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    await user.click(send);
    await within(dialog).findByText('Session created');
    const dispatch = callsOf(spy, 'cloud.dispatch');
    expect(dispatch).toHaveLength(1);
    expect((dispatch[0][1] as { body: { prompt: string; acknowledgedLocalContent: boolean } }).body.prompt).toBe(LONG);
    expect((dispatch[0][1] as { body: { acknowledgedLocalContent: boolean } }).body.acknowledgedLocalContent).toBe(true);
    // The wording claims no more than the CLI printed, and the link opens in the person's browser on request.
    expect(within(dialog).getByText(/not that Claude has finished/i)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenCalledWith(`${CODE}session_abDemoDemoDemo`);
  });

  it('a prompt the command line cannot carry goes the browser route only after the person agrees, and is never cut', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    const spy = vi.spyOn(app.demo, 'call');
    await open(app, user, { name: 'Both', roots: [{ path: 'C:\\Dev\\both' }], repo: 'acme/both' });
    const dialog = await chooseMode(user, 'Cloud session');
    const huge = `${LONG}\n${'x'.repeat(9000)}`;
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Task for Claude/ }), { target: { value: huge } });
    expect(await within(dialog).findByText(/Mini-Summa will not shorten it/)).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: /Copy the prompt and open claude.ai\/code/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /I understand this runs on Anthropic/ }));
    const go = await within(dialog).findByRole('button', { name: 'Copy and open claude.ai/code' });
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    await user.click(go);
    await within(dialog).findByText('Result unknown');
    const body = (callsOf(spy, 'cloud.dispatch')[0][1] as { body: { prompt: string; useBrowserFallback: boolean } }).body;
    expect(body.prompt).toBe(huge);
    expect(body.useBrowserFallback).toBe(true);
    expect(within(dialog).getByText(/Paste it there and submit/)).toBeTruthy();
    // The link the person brings back is validated before it is kept.
    const paste = within(dialog).getByPlaceholderText('Paste the address of the session');
    fireEvent.change(paste, { target: { value: 'https://evil.example/code/session_abc' } });
    await user.click(within(dialog).getByRole('button', { name: 'Keep link' }));
    expect(cloudDemoState(app.demo.demo.server.data).records).toHaveLength(0);
  });

  it('keeps a half written prompt when the dialog is closed, when another project is opened, and says it is memory only', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await open(app, user, { name: 'Alpha', roots: [{ path: 'C:\\Dev\\a' }], repo: 'acme/a' });
    let dialog = await chooseMode(user, 'Cloud session');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Task for Claude/ }), { target: { value: 'half written\nsecond line' } });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Claude session' })).toBeNull());
    await open(app, user, { name: 'Beta', roots: [{ path: 'C:\\Dev\\b' }], repo: 'acme/b' });
    await user.click(await screen.findByRole('button', { name: /^Alpha(,|$)/ }));
    dialog = await chooseMode(user, 'Cloud session');
    expect((within(dialog).getByRole('textbox', { name: /Task for Claude/ }) as HTMLTextAreaElement).value).toBe('half written\nsecond line');
    // Beta has its own, empty draft.
    expect(draftStore.get('does-not-exist')).toBeUndefined();
    expect(JSON.stringify(Object.entries(globalThis.localStorage ?? {}))).not.toContain('half written');
  });
});

describe('the temporary local session', () => {
  it('checks the repository, downloads into a workspace, starts Claude in it and copies the optional prompt for the person to paste', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const spy = vi.spyOn(app.demo, 'call');
    await open(app, user, { name: 'Remote', repo: 'acme/remote' });
    const dialog = await chooseMode(user, 'Temporary local session');
    await user.click(within(dialog).getByRole('radio', { name: /Temporary local session/ }));
    expect((await within(dialog).findAllByText(/approximate/)).length).toBeGreaterThan(0);
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Prompt \(optional\)/ }), { target: { value: LONG } });
    fireEvent.change(within(dialog).getByPlaceholderText('feature/my-change'), { target: { value: 'feature/billing' } });
    await user.click(within(dialog).getByRole('button', { name: 'Download and start Claude' }));
    await waitFor(() => expect(callsOf(spy, 'sessions.start')).toHaveLength(1));
    expect((callsOf(spy, 'workspaces.create')[0][1] as { body: { featureBranch: string } }).body.featureBranch).toBe('feature/billing');
    const start = callsOf(spy, 'sessions.start')[0][1] as { body: { workspaceId?: string; rootId?: string } };
    expect(start.body.workspaceId).toMatch(/^00000000-0000-4000-8000-/);
    expect(start.body.rootId).toBeUndefined();
    expect(fake.native.clipboard.writeText).toHaveBeenCalledWith(LONG);
    // Nothing was typed into the terminal and no ChatGPT message was touched.
    expect(callsOf(spy, 'actions.create')).toHaveLength(0);
  });

  it('shows a way to review and clean up, and cleanup asks for the repository name', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await open(app, user, { name: 'Remote', repo: 'acme/remote' });
    const project = (await app.demo.call('projects.list', {})).find((p) => p.name === 'Remote')!;
    await app.demo.call('workspaces.create', { params: { id: project.id }, body: { confirmed: true } });
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'Temporary workspaces' }));
    const dialog = await screen.findByRole('dialog', { name: 'Temporary workspaces' });
    await user.click(await within(dialog).findByRole('button', { name: 'Review and clean up' }));
    const clean = await within(dialog).findByRole('button', { name: 'Clean up workspace' });
    expect((clean as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/Recycle Bin or Trash, so it can be restored/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Type acme/remote to confirm'), { target: { value: 'acme/remote' } });
    await waitFor(() => expect((clean as HTMLButtonElement).disabled).toBe(false));
    await user.click(clean);
    await waitFor(() => expect(within(dialog).getByText('No temporary workspaces.')).toBeTruthy());
  });

  it('does not offer clean up when something would be lost, and says why', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await open(app, user, { name: 'Remote', repo: 'acme/remote' });
    const project = (await app.demo.call('projects.list', {})).find((p) => p.name === 'Remote')!;
    await app.demo.call('workspaces.create', { params: { id: project.id }, body: { confirmed: true } });
    cloudDemoState(app.demo.demo.server.data).inspection = { safeToClean: false, unpushedCommits: 2, publication: 'unpublished', blockers: ['2 commits exist only here. Push them first.'] };
    await user.click(plus());
    await user.click(screen.getByRole('menuitem', { name: 'Temporary workspaces' }));
    const dialog = await screen.findByRole('dialog', { name: 'Temporary workspaces' });
    await user.click(await within(dialog).findByRole('button', { name: 'Review and clean up' }));
    expect(await within(dialog).findByText('2 commits exist only here. Push them first.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Clean up workspace' })).toBeNull();
  });
});

describe('the Cloud tab when the page cannot be shown', () => {
  it('replaces an empty panel with a native view, hides the native page, and still offers the CLI and the browser', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Both', roots: [{ path: 'C:\\Dev\\both' }], repo: 'acme/both' });
    await user.click(within(claude()).getByRole('tab', { name: /^Cloud/ }));
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
    act(() => fake.emitClaudeView({ url: 'https://claude.ai/code', status: 'blocked', note: 'claude.ai answered the embedded view with HTTP 403 (refused).', httpStatus: 403 }));
    const region = await screen.findByRole('region', { name: 'Claude Code on the web is not showing' });
    expect(within(region).getByText(/HTTP 403/)).toBeTruthy();
    expect(within(region).getByText(/Starting a task from Mini-Summa does not need this page/)).toBeTruthy();
    await waitFor(() => expect(fake.lastClaudeBounds()).toBeNull()); // no empty native panel over the fallback
    await user.click(within(region).getByRole('button', { name: 'Open in your browser' }));
    expect(fake.native.shell.openExternal).toHaveBeenCalled();
    await user.click(within(region).getByRole('button', { name: 'New cloud task' }));
    expect(await screen.findByRole('dialog', { name: 'New Claude session' })).toBeTruthy();
  });

  it('shows the page again when it loads', async () => {
    const places = stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Both', roots: [{ path: 'C:\\Dev\\both' }], repo: 'acme/both' });
    await user.click(within(claude()).getByRole('tab', { name: /^Cloud/ }));
    act(() => fake.emitClaudeView({ url: 'https://claude.ai/code', status: 'stalled', note: 'The page has been loading for a long time without finishing.' }));
    await screen.findByRole('region', { name: 'Claude Code on the web is not showing' });
    act(() => fake.emitClaudeView({ status: 'ready', note: null }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Claude Code on the web is not showing' })).toBeNull());
    await waitFor(() => expect(fake.lastClaudeBounds()).toEqual(places.claude));
  });

  it('lists the cloud sessions started here without calling them running', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    await open(app, user, { name: 'Both', roots: [{ path: 'C:\\Dev\\both' }], repo: 'acme/both' });
    const project = (await app.demo.call('projects.list', {})).find((p) => p.name === 'Both')!;
    await app.demo.call('cloud.recordLink', { params: { id: project.id }, body: { url: `${CODE}session_abKept`, title: 'Billing' } });
    await user.click(within(claude()).getByRole('tab', { name: /^Cloud/ }));
    act(() => fake.emitClaudeView({ url: 'https://claude.ai/code', status: 'error', note: 'The page could not be loaded (ERR_CONNECTION_RESET).' }));
    const region = await screen.findByRole('region', { name: 'Claude Code on the web is not showing' });
    expect(await within(region).findByText('Billing')).toBeTruthy();
    expect(within(region).getByText(/A saved link does not mean the session is running/)).toBeTruthy();
    await user.click(within(region).getAllByRole('button', { name: 'Copy' })[0]);
    expect(fake.native.clipboard.writeText).toHaveBeenCalledWith(`${CODE}session_abKept`);
  });
});

describe('follow-up messages', () => {
  it('sends the message whole through the core and shows accepted as the CLI taking it, not as Claude acting', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    const app = await renderApp({ native: fake });
    const spy = vi.spyOn(app.demo, 'call');
    await open(app, user, { name: 'Both', roots: [{ path: 'C:\\Dev\\both' }], repo: 'acme/both' });
    const project = (await app.demo.call('projects.list', {})).find((p) => p.name === 'Both')!;
    await app.demo.call('cloud.recordLink', { params: { id: project.id }, body: { url: `${CODE}session_abKept`, title: 'Billing' } });
    await user.click(within(claude()).getByRole('tab', { name: /^Cloud/ }));
    act(() => fake.emitClaudeView({ url: 'https://claude.ai/code', status: 'error', note: 'The page could not be loaded (ERR_CONNECTION_RESET).' }));
    const region = await screen.findByRole('region', { name: 'Claude Code on the web is not showing' });
    await user.click(await within(region).findByRole('button', { name: 'Follow up' }));
    const dialog = await screen.findByRole('dialog', { name: 'Follow-up message' });
    const message = 'Also add tests.\nAnd "quote" 50%.';
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Message/ }), { target: { value: message } });
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect(await within(dialog).findByText(/does not mean Claude has acted/)).toBeTruthy();
    expect(within(dialog).getByText('Accepted by the CLI')).toBeTruthy();
    expect((callsOf(spy, 'cloud.followUp')[0][1] as { body: { message: string } }).body.message).toBe(message);
  });
});
