// Settings: the frame, ChatGPT, the extension, Claude Code, hooks and notifications, on the real renderer and the demo core.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@minisumma/shared';
import { describe, expect, it, vi } from 'vitest';
import { createFeatureSeed } from '../../src/renderer/src/dev/demo/features-seed';
import { IDS } from '../../src/renderer/src/dev/demo/seed';
import { createFakeNative } from './helpers';
import { callsTo, factsOf, renderFeature, textOf } from './features-helpers';

const open = (section: string, options: Parameters<typeof renderFeature>[0] = {}) => renderFeature({ view: 'settings', route: { section }, ...options });
const nav = () => screen.getByRole('navigation', { name: 'Settings sections' });
const heading = () => screen.getByRole('heading', { level: 1 });
const page = () => screen.getByRole('region', { name: 'Settings' });
const patchOf = (spy: Parameters<typeof callsTo>[0]) => callsTo(spy, 'settings.update').map((c) => (c as { body: unknown }).body);

describe('the settings frame', () => {
  it('takes over the sidebar with a back chevron and one item per section, and shows the chosen one', async () => {
    const user = userEvent.setup();
    const app = await open('chatgpt');
    const items = within(nav()).getAllByRole('button').map((b) => textOf(b));
    expect(items).toEqual([
      'ChatGPT', 'Browser extension', 'Claude Code', 'Claude hooks', 'Notifications', 'Phones and devices', 'Remote access', 'Push notifications',
      'Review and handoff', 'Data and privacy', 'About and setup',
    ]);
    expect(within(nav()).getByRole('button', { name: 'ChatGPT' }).getAttribute('aria-current')).toBe('true');
    expect(screen.queryByText('No projects yet.')).toBeNull(); // the project list stepped aside
    expect(textOf(heading())).toBe('ChatGPT');

    await user.click(within(nav()).getByRole('button', { name: 'Claude hooks' }));
    expect(textOf(heading())).toBe('Claude hooks');
    expect(app.runtime.route.getState().section).toBe('hooks');
    expect(within(nav()).getByRole('button', { name: 'Claude hooks' }).getAttribute('aria-current')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(app.runtime.route.getState().view).not.toBe('settings');
  });

  it('opens a section by an older or looser name, and the first section when none is given', async () => {
    const first = await open('Phone');
    expect(textOf(heading())).toBe('Phones and devices');
    first.unmount();
    await renderFeature({ view: 'settings' });
    expect(textOf(heading())).toBe('ChatGPT');
  });
});

describe('the settings frame with the sidebar collapsed', () => {
  const collapsedSeed = () => { const seed = createFeatureSeed(); seed.settings.layout.sidebarCollapsed = true; return seed; };

  it('shows the sections in the sidebar while Settings is open, never in a second column of the view', async () => {
    const user = userEvent.setup();
    const app = await open('hooks', { seed: collapsedSeed() });
    const side = screen.getByRole('complementary', { name: 'Mini-Summa navigation' });
    expect(side.hasAttribute('hidden')).toBe(false);
    expect(side.querySelector('.ms-sidebar__slot')?.hasAttribute('hidden')).toBe(false); // the sections went into the sidebar
    expect(screen.getAllByRole('complementary')).toHaveLength(1);
    expect(within(side).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? textOf(b))).toEqual(['Back', ...[
      'ChatGPT', 'Browser extension', 'Claude Code', 'Claude hooks', 'Notifications', 'Phones and devices', 'Remote access', 'Push notifications',
      'Review and handoff', 'Data and privacy', 'About and setup',
    ]]);
    expect(within(side).getByRole('button', { name: 'Claude hooks' }).getAttribute('aria-current')).toBe('true');
    await user.click(within(side).getByRole('button', { name: 'Notifications' }));
    expect(textOf(heading())).toBe('Notifications');
    await user.click(within(side).getByRole('button', { name: 'Back' }));
    expect(app.runtime.route.getState().view).not.toBe('settings');
  });

  it('gives the sidebar back to the person\'s choice once Settings is left, and expanding it keeps the sections where they are', async () => {
    const user = userEvent.setup();
    await open('chatgpt', { seed: collapsedSeed() });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    const expand = await screen.findByRole('button', { name: 'Expand sidebar' });
    await user.click(expand);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Expand sidebar' })).toBeNull());
    expect(screen.getByRole('navigation', { name: 'Projects' })).toBeTruthy();
  });
});

describe('ChatGPT', () => {
  it('offers both ways, saves the choice through the core, and says it was saved', async () => {
    const user = userEvent.setup();
    const app = await open('chatgpt');
    const spy = vi.spyOn(app.demo, 'call');
    const group = screen.getByRole('radiogroup', { name: 'How ChatGPT opens' });
    expect(within(group).getByRole('radio', { name: /Inside Mini-Summa/ })).toHaveProperty('checked', true);
    
    await user.click(within(group).getByRole('radio', { name: /In your browser/ }));
    await waitFor(() => expect(patchOf(spy)).toEqual([{ chatgpt: { mode: 'external' } }]));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(within(group).getByRole('radio', { name: /In your browser/ })).toHaveProperty('checked', true);
    // The browser choice appears, with the extension as an option and not a requirement.
    const tab = screen.getByRole('radiogroup', { name: 'Which browser tab' });
    await user.click(within(tab).getByRole('radio', { name: /Use the Mini-Summa browser extension/ }));
    await waitFor(() => expect(patchOf(spy).at(-1)).toEqual({ chatgpt: { externalBrowser: 'extension' } }));
    expect(app.runtime.store.getState().settings?.chatgpt).toEqual({ mode: 'external', externalBrowser: 'extension', pageScale: 'auto' });
  });

  it('shows the embedded view as it is, live, and offers the browser when sign-in or the page is refused', async () => {
    const user = userEvent.setup();
    const native = createFakeNative({ view: { status: 'ready', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' } });
    const app = await open('chatgpt', { native });
    const facts = await screen.findByLabelText('Embedded view status');
    await waitFor(() => expect(textOf(facts)).toContain('Ready'));
    expect(textOf(facts)).toContain('https://chatgpt.com/c/abc');
    expect(screen.queryByRole('button', { name: 'Use my browser instead' })).toBeNull();

    native.emitView({ status: 'login_required', note: 'Sign in to ChatGPT to continue.' });
    await waitFor(() => expect(textOf(screen.getByLabelText('Embedded view status'))).toContain('Sign-in needed'));
    expect(within(page()).getByText('Sign in to ChatGPT to continue.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use my browser instead' }));
    await waitFor(() => expect(app.runtime.store.getState().settings?.chatgpt.mode).toBe('external'));
  });

  it('says plainly that this window cannot show the embedded view', async () => {
    await open('chatgpt', { native: createFakeNative({ embedded: false }) });
    expect(await screen.findByText(/The embedded view exists only in the desktop app/)).toBeTruthy();
  });

  it('takes a refused change back and says why, instead of showing it saved', async () => {
    const user = userEvent.setup();
    const app = await open('chatgpt');
    app.demoState.failNext.set('settings.update', new ApiError(500, 'database_locked', 'The database is locked. Try again in a moment.'));
    const group = screen.getByRole('radiogroup', { name: 'How ChatGPT opens' });
    await user.click(within(group).getByRole('radio', { name: /In your browser/ }));
    expect(await screen.findByText('Could not save: The database is locked. Try again in a moment.')).toBeTruthy();
    await waitFor(() => expect(within(group).getByRole('radio', { name: /Inside Mini-Summa/ })).toHaveProperty('checked', true));
    expect(app.runtime.store.getState().settings?.chatgpt.mode).toBe('embedded');
  });
});

describe('the browser extension', () => {
  it('states whether an extension is connected, lists who is paired, and gives the load-unpacked steps', async () => {
    const app = await open('extension');
    expect(await screen.findByText('No extension is connected.')).toBeTruthy();
    expect(factsOf(screen.getByLabelText('Extension connection')).Paired).toMatch(/^Chrome extension, last seen .* on this PC$/);
    const steps = textOf(document.querySelector('.ms-set-steps'));
    expect(steps).toContain('node apps/browser-extension/build.mjs');
    expect(steps).toContain('chrome://extensions');
    expect(steps).toContain('Load unpacked');
    expect(app.runtime.store.getState().system?.nativeCapabilities.extensionBridge).toBe(false);
  });

  it('creates an extension pairing code with its id, code and link as text, and a countdown', async () => {
    const user = userEvent.setup();
    const app = await open('extension');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Create a pairing code' }));
    const panel = await screen.findByLabelText('Pairing code');
    expect(callsTo(spy, 'pairing.createOffer')).toEqual([{ body: { kind: 'extension' } }]);
    const facts = factsOf(within(panel).getByLabelText('The pairing code as text'));
    expect(facts.Offer).toMatch(/^ofr_/);
    expect(facts.Code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(facts.Allowed).toBe('Browser tab');
    expect(facts.Link).toMatch(/^minisumma:\/\/pair\?/);
    expect(textOf(panel)).toMatch(/It works for [45]:\d\d more, and only once/);
    expect(within(panel).queryByRole('img')).toBeNull(); // an extension takes a link, not a QR code
  });
});

describe('Claude Code', () => {
  it('shows each environment with what was found there', async () => {
    await open('claude-code');
    const list = await screen.findByRole('list', { name: 'Environments' });
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => textOf(h))).toEqual(['Windows', 'WSL (Ubuntu)', 'WSL (Debian)']);
    const windows = factsOf(within(list).getByLabelText('Windows details'));
    expect(windows['Claude Code']).toBe('C:\\Users\\dev\\.local\\bin\\claude.exe, version 2.1.4');
    expect(windows['Settings folder']).toBe('C:\\Users\\dev\\.claude');
    expect(windows.Hooks).toContain('Installed for 5 events');
    expect(windows['Hooks run with']).toBe('node, version 22.12.0');
  });

  it('gives the exact commands where Claude Code is missing, and Refresh looks again', async () => {
    const user = userEvent.setup();
    const app = await open('claude-code');
    const spy = vi.spyOn(app.demo, 'call');
    const list = await screen.findByRole('list', { name: 'Environments' });
    const debian = within(list).getByText('WSL (Debian)').closest('li') as HTMLElement;
    expect(textOf(debian)).toContain('Claude Code not found');
    expect(textOf(debian)).toContain('claude was not found in PATH.');
    expect(textOf(debian)).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(textOf(debian)).toContain('npm install -g @anthropic-ai/claude-code');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(callsTo(spy, 'environments.list').at(-1)).toEqual({ query: { refresh: true } }));
  });

  it('says it could not look, with the reason, and offers to try again', async () => {
    const user = userEvent.setup();
    const app = await open('chatgpt');
    app.demoState.failNext.set('environments.list', new ApiError(500, 'probe_failed', 'Windows did not answer.'));
    await user.click(within(nav()).getByRole('button', { name: 'Claude Code' }));
    expect(await screen.findByText(/Mini-Summa could not look for Claude Code\. Windows did not answer\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Environments' })).toBeTruthy();
  });
});

describe('Claude hooks', () => {
  const diffText = () => textOf(screen.getByRole('region', { name: /^Changes to / }));

  it('explains what installing does before it offers anything', async () => {
    await open('hooks');
    const points = textOf(document.querySelector('.ms-set-points'));
    expect(points).toContain('edits only its own entries');
    expect(points).toContain('No repository file is touched, and no CLAUDE.md is needed.');
    expect(points).toContain('Sessions that Mini-Summa starts get their hooks automatically');
    expect(points).toContain('Claude Code reads hooks when a session starts');
    expect(points).not.toContain('a backup of the file'); // the dialog shows the file and its backup; the page does not repeat it
    const cards = await screen.findByRole('list', { name: 'Hooks per environment' });
    expect(textOf(cards)).toContain('Installed for 5 events');
    expect(textOf(cards)).toContain('Not installed');
  });

  it('shows the exact diff, will not write until the person has agreed to that file, then applies exactly that plan', async () => {
    const user = userEvent.setup();
    const app = await open('hooks');
    const spy = vi.spyOn(app.demo, 'call');
    const list = await screen.findByRole('list', { name: 'Hooks per environment' });
    const ubuntu = within(list).getByText('WSL (Ubuntu)').closest('li') as HTMLElement;
    await user.click(within(ubuntu).getByRole('button', { name: 'Review changes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Install hooks for WSL (Ubuntu)' });
    await within(dialog).findByRole('region', { name: 'Changes to /home/dev/.claude/settings.json' });
    expect(callsTo(spy, 'hooks.plan')).toEqual([{ body: { env: 'wsl:Ubuntu', action: 'install' } }]);
    const where = factsOf(within(dialog).getByLabelText('Where'));
    expect(where.File).toBe('/home/dev/.claude/settings.json');
    expect(where.Backup).toMatch(/settings-wsl-Ubuntu-\d+-\d+\.json$/);
    expect(diffText()).toContain('+');
    expect(diffText()).toMatch(/"hooks"/);
    expect(textOf(dialog)).toMatch(/Exact changes, \d+ added, \d+ removed/);
    const diffLines = within(dialog).getByRole('region', { name: /^Changes to / }).querySelectorAll('[data-kind]');
    expect([...diffLines].some((l) => l.getAttribute('data-kind') === 'add' && (l.textContent ?? '').startsWith('+'))).toBe(true);

    const install = within(dialog).getByRole('button', { name: 'Install hooks' });
    expect(install).toHaveProperty('disabled', true);
    expect(callsTo(spy, 'hooks.apply')).toHaveLength(0);
    const consent = within(dialog).getByRole('checkbox', { name: 'I have read these changes to /home/dev/.claude/settings.json' });
    await user.click(consent);
    expect(install).toHaveProperty('disabled', false);

    const planned = await app.demo.call('hooks.plan', { body: { env: 'wsl:Ubuntu', action: 'install' } });
    await user.click(install);
    await waitFor(() => expect(callsTo(spy, 'hooks.apply')).toHaveLength(1));
    expect(callsTo(spy, 'hooks.apply')[0]).toEqual({ body: { env: 'wsl:Ubuntu', action: 'install', planHash: planned.planHash } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Install hooks/ })).toBeNull());
    const toast = await screen.findByText('Hooks installed for WSL (Ubuntu)');
    expect(textOf(toast.parentElement)).toContain('sessions that are already running report only after they are restarted');
    await waitFor(() => expect(textOf(screen.getByRole('list', { name: 'Hooks per environment' }))).not.toContain('Not installed'));
  });

  it('refuses to write when the file changed after it was shown, says so, and asks again for the new changes', async () => {
    const user = userEvent.setup();
    const app = await open('hooks');
    const spy = vi.spyOn(app.demo, 'call');
    const list = await screen.findByRole('list', { name: 'Hooks per environment' });
    const ubuntu = within(list).getByText('WSL (Ubuntu)').closest('li') as HTMLElement;
    await user.click(within(ubuntu).getByRole('button', { name: 'Review changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install hooks for WSL (Ubuntu)' });
    await within(dialog).findByRole('region', { name: /^Changes to / });
    const before = diffText();
    const consent = () => within(dialog).getByRole('checkbox', { name: /I have read these changes/ });

    app.demoState.hookDrift.add('wsl:Ubuntu'); // another program edits settings.json now
    await user.click(consent());
    await user.click(within(dialog).getByRole('button', { name: 'Install hooks' }));

    expect(await within(dialog).findByText(/settings\.json changed since you looked, so nothing was written/)).toBeTruthy();
    expect(callsTo(spy, 'hooks.plan')).toHaveLength(2); // a new plan was made
    await waitFor(() => expect(diffText()).toContain('editedElsewhere'));
    expect(diffText()).not.toBe(before);
    expect(app.runtime.store.getState().hooks.find((h) => h.env === 'wsl:Ubuntu')?.installed).toBe(false); // nothing was written
    // The old agreement does not carry over to the new changes.
    expect(consent()).toHaveProperty('checked', false);
    expect(within(dialog).getByRole('button', { name: 'Install hooks' })).toHaveProperty('disabled', true);

    await user.click(consent());
    await user.click(within(dialog).getByRole('button', { name: 'Install hooks' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Install hooks/ })).toBeNull());
    expect(callsTo(spy, 'hooks.apply')).toHaveLength(2);
    expect(app.runtime.store.getState().hooks.find((h) => h.env === 'wsl:Ubuntu')?.installed).toBe(true);
  });

  it('removes hooks the same way: the exact lines that go, agreement to that file, then the removal', async () => {
    const user = userEvent.setup();
    const app = await open('hooks');
    const spy = vi.spyOn(app.demo, 'call');
    const list = await screen.findByRole('list', { name: 'Hooks per environment' });
    const windows = within(list).getByText('Windows').closest('li') as HTMLElement;
    await user.click(within(windows).getByRole('button', { name: 'Review removal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove hooks for Windows' });
    await within(dialog).findByRole('region', { name: /^Changes to / });
    expect(textOf(dialog)).toContain('Only Mini-Summa\'s own hook entries are removed');
    const removed = [...within(dialog).getByRole('region', { name: /^Changes to / }).querySelectorAll('[data-kind="del"]')];
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((l) => (l.textContent ?? '').startsWith('-'))).toBe(true);
    await user.click(within(dialog).getByRole('checkbox'));
    expect(within(dialog).getByRole('button', { name: 'Remove hooks' }).className).toContain('sm-btn--danger'); // taking things out is a solid red button
    await user.click(within(dialog).getByRole('button', { name: 'Remove hooks' }));
    await waitFor(() => expect(callsTo(spy, 'hooks.apply')).toHaveLength(1));
    expect((callsTo(spy, 'hooks.apply')[0] as { body: { action: string } }).body.action).toBe('uninstall');
    await waitFor(() => expect(app.runtime.store.getState().hooks.find((h) => h.env === 'win')?.installed).toBe(false));
  });

  it('says there is nothing to change when the file already has the hooks, and offers no install button', async () => {
    const user = userEvent.setup();
    await open('hooks');
    const list = await screen.findByRole('list', { name: 'Hooks per environment' });
    const windows = within(list).getByText('Windows').closest('li') as HTMLElement;
    await user.click(within(windows).getByRole('button', { name: 'Review install again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install hooks for Windows' });
    expect(await within(dialog).findByText(/Nothing to change: the hooks are already installed/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Install hooks' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  });

  it('shows why a plan could not be made, and writes nothing', async () => {
    const user = userEvent.setup();
    const app = await open('hooks');
    const spy = vi.spyOn(app.demo, 'call');
    const list = await screen.findByRole('list', { name: 'Hooks per environment' });
    const ubuntu = within(list).getByText('WSL (Ubuntu)').closest('li') as HTMLElement;
    app.demoState.failNext.set('hooks.plan', new ApiError(422, 'settings_unreadable', 'settings.json is not valid JSON, so Mini-Summa will not touch it.'));
    await user.click(within(ubuntu).getByRole('button', { name: 'Review changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install hooks for WSL (Ubuntu)' });
    expect(await within(dialog).findByText('settings.json is not valid JSON, so Mini-Summa will not touch it.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Install hooks' })).toBeNull();
    expect(callsTo(spy, 'hooks.apply')).toHaveLength(0);
  });
});

describe('notifications', () => {
  it('switches desktop notifications and says when the window cannot show them', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const spy = vi.spyOn(app.demo, 'call');
    const sw = screen.getByRole('switch', { name: 'Show desktop notifications' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await user.click(sw);
    await waitFor(() => expect(patchOf(spy)).toEqual([{ notifications: { native: false } }]));
    expect(sw.getAttribute('aria-checked')).toBe('false'); // shown at once, and kept
    expect(await screen.findByText('Saved')).toBeTruthy();
    await waitFor(() => expect(app.runtime.store.getState().settings?.notifications.native).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('turns quiet mode on for a chosen time and off again, and says until when', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const spy = vi.spyOn(app.demo, 'call');
    expect(screen.getByText('Notifications are not silenced.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'How long' }));
    await user.click(screen.getByRole('option', { name: 'For 4 hours' }));
    expect(patchOf(spy)).toEqual([]); // choosing a length does not switch anything on by itself
    await user.click(screen.getByRole('switch', { name: 'Quiet now' }));
    await waitFor(() => expect(patchOf(spy)).toHaveLength(1));
    const quiet = (patchOf(spy)[0] as { notifications: { quiet: { enabled: boolean; until: string } } }).notifications.quiet;
    expect(quiet.enabled).toBe(true);
    expect(Date.parse(quiet.until) - Date.now()).toBeGreaterThan(3.9 * 3_600_000);
    expect(Date.parse(quiet.until) - Date.now()).toBeLessThanOrEqual(4 * 3_600_000);
    expect(await screen.findByText(/^Quiet until \d\d:\d\d/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Quiet now' }).getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByRole('switch', { name: 'Quiet now' }));
    await waitFor(() => expect(patchOf(spy).at(-1)).toEqual({ notifications: { quiet: { enabled: false, until: null } } }));
    expect(await screen.findByText('Notifications are not silenced.')).toBeTruthy();
  });

  it('keeps quiet mode on until it is turned off when that is the choice', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'How long' }));
    await user.click(screen.getByRole('option', { name: 'Until I turn it off' }));
    await user.click(screen.getByRole('switch', { name: 'Quiet now' }));
    await waitFor(() => expect(patchOf(spy)).toEqual([{ notifications: { quiet: { enabled: true, until: null } } }]));
    expect(await screen.findByText('Quiet until you turn it off.')).toBeTruthy();
  });

  it('sets a daily window, refuses a time that is not a time, and notes an empty window', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('switch', { name: 'Quiet every day' }));
    await waitFor(() => expect(patchOf(spy)).toEqual([{ notifications: { quiet: { schedule: { enabled: true } } } }]));
    expect(await screen.findByText('Quiet every day from 22:00 to 08:00.')).toBeTruthy();

    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '21:30' } });
    await waitFor(() => expect(patchOf(spy).at(-1)).toEqual({ notifications: { quiet: { schedule: { from: '21:30', to: '08:00' } } } }));

    const saves = patchOf(spy).length;
    fireEvent.change(from, { target: { value: '' } });
    expect(await screen.findByText('Use a time such as 22:00.')).toBeTruthy();
    expect(patchOf(spy)).toHaveLength(saves); // nothing half-typed is sent

    fireEvent.change(from, { target: { value: '08:00' } });
    expect(await screen.findByText(/From and To are the same time, so the window is empty and nothing is silenced/)).toBeTruthy();
  });

  it('sets what new projects start with, and the master switch turns the rest off', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const spy = vi.spyOn(app.demo, 'call');
    const group = screen.getByRole('region', { name: 'For new projects' });
    await user.click(within(group).getByRole('switch', { name: 'A session ended abnormally' }));
    await waitFor(() => expect(patchOf(spy)).toEqual([{ notifications: { defaults: { sessionEnded: true } } }]));
    await user.click(within(group).getByRole('switch', { name: 'Notify about new projects' }));
    await waitFor(() => expect(patchOf(spy).at(-1)).toEqual({ notifications: { defaults: { enabled: false } } }));
    await waitFor(() => expect(within(group).getByRole('switch', { name: 'Claude needs permission' })).toHaveProperty('disabled', true));
    expect(app.runtime.store.getState().settings?.notifications.defaults).toMatchObject({ enabled: false, sessionEnded: true });
  });

  it('has a switch for "Claude finished", on for everyone until turned off, for new projects and for each project', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const spy = vi.spyOn(app.demo, 'call');
    const group = screen.getByRole('region', { name: 'For new projects' });
    const defaults = within(group).getByRole('switch', { name: 'Claude finished' });
    expect(defaults.getAttribute('aria-checked')).toBe('true');
    // It says what it is, because the label alone could be read as "the task is done".
    expect(textOf(group)).toContain('A turn ending does not mean the task is complete.');
    await user.click(defaults);
    await waitFor(() => expect(patchOf(spy)).toEqual([{ notifications: { defaults: { turnEnded: false } } }]));
    expect(app.runtime.store.getState().settings?.notifications.defaults.turnEnded).toBe(false);

    const table = screen.getByRole('table', { name: 'Notifications per project' });
    const mine = within(table).getByRole('switch', { name: 'Claude finished, GitManager' });
    expect(mine.getAttribute('aria-checked')).toBe('true');
    await user.click(mine);
    await waitFor(() => expect(callsTo(spy, 'projects.update')).toEqual([{ params: { id: IDS.gitManager }, body: { notificationPrefs: { turnEnded: false } } }]));
    await waitFor(() => expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.gitManager)?.notificationPrefs.turnEnded).toBe(false));
    // Only that project, and only that kind.
    expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.atlas)?.notificationPrefs.turnEnded).toBe(true);
    expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.gitManager)?.notificationPrefs.report).toBe(true);
  });

  it('has one row per project with a switch for each kind, phone included, and saves one change at a time', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const spy = vi.spyOn(app.demo, 'call');
    const table = screen.getByRole('table', { name: 'Notifications per project' });
    const headers = within(table).getAllByRole('columnheader').map((h) => textOf(h));
    expect(headers).toEqual(['Project', 'Notify', 'Permission', 'Input', 'Error', 'Report', 'Finished', 'Ended', 'Lost', 'Phone']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => textOf(within(r).getAllByRole('rowheader')[0]))).toEqual(['GitManager', 'Atlas API', 'Docs site', 'Trading dashboard']);

    const phone = within(table).getByRole('switch', { name: 'Also send to my phone, Atlas API' });
    expect(phone.getAttribute('aria-checked')).toBe('true');
    await user.click(phone);
    await waitFor(() => expect(callsTo(spy, 'projects.update')).toEqual([{ params: { id: IDS.atlas }, body: { notificationPrefs: { push: false } } }]));
    expect(phone.getAttribute('aria-checked')).toBe('false');
    await waitFor(() => expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.atlas)?.notificationPrefs.push).toBe(false));
    // The other projects were not touched.
    expect(app.runtime.store.getState().projects.find((p) => p.id === IDS.gitManager)?.notificationPrefs.push).toBe(true);
  });

  it('takes a refused project change back and says why', async () => {
    const user = userEvent.setup();
    const app = await open('notifications');
    const table = screen.getByRole('table', { name: 'Notifications per project' });
    app.demoState.failNext.set('projects.update', new ApiError(500, 'locked', 'The database is locked.'));
    const report = within(table).getByRole('switch', { name: 'A report is ready, GitManager' });
    expect(report.getAttribute('aria-checked')).toBe('true');
    await user.click(report);
    expect(await screen.findByText('Could not save: The database is locked.')).toBeTruthy();
    await waitFor(() => expect(within(table).getByRole('switch', { name: 'A report is ready, GitManager' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('greys out a project\'s other switches while its master switch is off', async () => {
    const user = userEvent.setup();
    await open('notifications');
    const table = screen.getByRole('table', { name: 'Notifications per project' });
    await user.click(within(table).getByRole('switch', { name: 'Notify, Docs site' }));
    await waitFor(() => expect(within(table).getByRole('switch', { name: 'Claude needs permission, Docs site' })).toHaveProperty('disabled', true));
    expect(within(table).getByRole('switch', { name: 'Claude needs permission, GitManager' })).toHaveProperty('disabled', false);
  });
});
