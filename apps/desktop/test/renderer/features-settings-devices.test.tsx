// Settings, second half: phones and devices, remote access, push, review and handoff, data and privacy, about.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, DEFAULT_REVIEW_REQUEST } from '@minisumma/shared';
import { describe, expect, it, vi } from 'vitest';
import { defaultTailscale, redeemOffer } from '../../src/renderer/src/dev/demo/features-handlers';
import { createFakeNative } from './helpers';
import { pruneWords } from '../../src/renderer/src/features/settings/model';
import { callsTo, factsOf, renderFeature, textOf } from './features-helpers';

const open = (section: string, options: Parameters<typeof renderFeature>[0] = {}) => renderFeature({ view: 'settings', route: { section }, ...options });
const nav = () => screen.getByRole('navigation', { name: 'Settings sections' });
const patchOf = (spy: Parameters<typeof callsTo>[0]) => callsTo(spy, 'settings.update').map((c) => (c as { body: unknown }).body);
const card = (name: string) => screen.getByRole('heading', { level: 3, name }).closest('li') as HTMLElement;

describe('paired devices', () => {
  it('lists each device with what it is, when it was seen and what it may do, and keeps revoked ones apart', async () => {
    await open('phones');
    const list = await screen.findByRole('list', { name: 'Paired devices' });
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => textOf(h))).toEqual(['Pixel 8', 'Galaxy Tab', 'Chrome extension']);

    const pixel = factsOf(within(list).getByLabelText('Pixel 8 details'));
    expect(pixel).toMatchObject({ Kind: 'Android phone', May: 'Read, notify, prompt', Push: 'Not registered' });
    expect(pixel.Seen).toMatch(/^Last seen .* on this PC$/);
    const tab = factsOf(within(list).getByLabelText('Galaxy Tab details'));
    expect(tab.May).toBe('Read, notify, prompt, approve');
    expect(tab.Push).toBe('Registered for push notifications');
    expect(tab.Seen).toMatch(/over Tailscale$/);
    expect(within(card('Galaxy Tab')).getByText('Trusted')).toBeTruthy(); // trust is shown, and only where it is true
    expect(within(card('Pixel 8')).queryByText('Trusted')).toBeNull();
    expect(factsOf(within(list).getByLabelText('Chrome extension details'))).not.toHaveProperty('Push');

    const revoked = screen.getByText('Revoked devices (1)');
    await userEvent.setup().click(revoked);
    expect(textOf(screen.getByRole('list', { name: 'Revoked devices' }))).toMatch(/Old phone\s+Revoked .* ago/);
  });

  it('edits the name and permissions and sends only what changed', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(card('Pixel 8')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Pixel 8' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true); // nothing changed yet

    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Anna phone');
    await user.click(within(dialog).getByRole('checkbox', { name: /Approve/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Prompt/ }));
    expect(save).toHaveProperty('disabled', false);
    await user.click(save);
    await waitFor(() => expect(callsTo(spy, 'devices.update')).toEqual([{ params: { id: 'dev_pixel' }, body: { name: 'Anna phone', scopes: ['read', 'notify', 'approve'] } }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Edit / })).toBeNull());
    expect(factsOf(within(card('Anna phone')).getByLabelText('Anna phone details')).May).toBe('Read, notify, approve');
  });

  it('warns about trusting a device while the switch is still in hand, and names the consequence on the button', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(card('Pixel 8')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Pixel 8' });
    expect(within(dialog).queryByRole('note')).toBeNull();
    await user.click(within(dialog).getByRole('switch', { name: 'Trust this device' }));
    expect(textOf(within(dialog).getByRole('note'))).toMatch(/Anyone who can unlock this device can make Claude type into your sessions, with no question asked on this PC/);
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save and trust this device' }));
    await waitFor(() => expect(callsTo(spy, 'devices.update')).toEqual([{ params: { id: 'dev_pixel' }, body: { trusted: true } }]));
    await waitFor(() => expect(within(card('Pixel 8')).getByText('Trusted')).toBeTruthy());
  });

  it('keeps what was typed when a save fails, and says why', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    await user.click(within(card('Pixel 8')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Pixel 8' });
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Work phone');
    app.demoState.failNext.set('devices.update', new ApiError(409, 'device_revoked', 'This device was revoked, so it cannot be changed. Pair it again to use it.'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('This device was revoked, so it cannot be changed. Pair it again to use it.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Work phone');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false); // and it can be tried again
  });

  it('refuses an empty name before sending anything', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(card('Pixel 8')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Pixel 8' });
    await user.clear(within(dialog).getByLabelText('Name'));
    expect(within(dialog).getByText('A device needs a name, such as "My phone".')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(callsTo(spy, 'devices.update')).toHaveLength(0);
  });

  it('does not offer permissions or trust for the browser extension', async () => {
    const user = userEvent.setup();
    await open('phones');
    await user.click(within(card('Chrome extension')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Chrome extension' });
    expect(textOf(dialog)).toContain('The browser extension can only focus or open the ChatGPT tab. Its permission cannot be changed.');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });

  it('revokes only after a clear question that names the consequence, and the device moves to the revoked list', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(within(card('Pixel 8')).getByRole('button', { name: 'Revoke access' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke Pixel 8?' });
    expect(textOf(dialog)).toContain('stops having access to Mini-Summa as soon as you confirm');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })); // the safe answer has focus
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(callsTo(spy, 'devices.revoke')).toHaveLength(0);

    await user.click(within(card('Pixel 8')).getByRole('button', { name: 'Revoke access' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Revoke Pixel 8?' })).getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(callsTo(spy, 'devices.revoke')).toEqual([{ params: { id: 'dev_pixel' } }]));
    await waitFor(() => expect(screen.queryByRole('heading', { level: 3, name: 'Pixel 8' })).toBeNull());
    expect(await screen.findByText('Revoked devices (2)')).toBeTruthy();
  });

  it('shows why a revoke failed and leaves the device where it was', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    app.demoState.failNext.set('devices.revoke', new ApiError(500, 'locked', 'The database is locked.'));
    await user.click(within(card('Galaxy Tab')).getByRole('button', { name: 'Revoke access' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke Galaxy Tab?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke access' }));
    expect(await within(dialog).findByText('The database is locked.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Galaxy Tab' })).toBeTruthy();
  });
});

describe('pairing a phone', () => {
  const pair = () => screen.getByRole('region', { name: 'Pair a phone' });

  it('starts with the permissions most people want, asks for at least one, and sends the chosen ones', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    const spy = vi.spyOn(app.demo, 'call');
    const box = (name: RegExp) => within(pair()).getByRole('checkbox', { name }) as HTMLInputElement;
    expect([box(/^Read/).checked, box(/^Notify/).checked, box(/^Prompt/).checked, box(/^Approve/).checked]).toEqual([true, true, false, false]);

    await user.click(box(/^Read/));
    await user.click(box(/^Notify/));
    expect(within(pair()).getByText('Choose at least one permission.')).toBeTruthy();
    expect(within(pair()).getByRole('button', { name: 'Create pairing code' })).toHaveProperty('disabled', true);

    await user.click(box(/^Prompt/));
    await user.click(box(/^Read/));
    await user.click(within(pair()).getByRole('button', { name: 'Create pairing code' }));
    await screen.findByLabelText('Pairing code');
    expect(callsTo(spy, 'pairing.createOffer')).toEqual([{ body: { kind: 'phone', scopes: ['read', 'prompt'] } }]);
  });

  it('shows a QR code, the same code as text, and a countdown from five minutes', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    await user.click(within(pair()).getByRole('button', { name: 'Create pairing code' }));
    const panel = await screen.findByLabelText('Pairing code');
    const qr = (await within(panel).findByRole('img', { name: 'QR code that holds the pairing code' })) as HTMLImageElement;
    expect(qr.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(qr.src)).toContain('<svg');

    const facts = factsOf(within(panel).getByLabelText('The pairing code as text'));
    const offers = [...app.demoState.offers.entries()];
    expect(offers).toHaveLength(1);
    expect(facts.Offer).toBe(offers[0][0]);
    expect(facts.Code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(facts.Allows).toBe('Read, Notify');
    expect(textOf(panel)).toMatch(/It works for [45]:\d\d more, and only once/);
    expect(textOf(panel)).toMatch(/No camera\? Open the app, choose to enter the details by hand, and type the offer and the code/);
  });

  it('replaces the code with a plain confirmation when the phone has paired, and lists the new device', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    await user.click(within(pair()).getByRole('button', { name: 'Create pairing code' }));
    await screen.findByLabelText('Pairing code');
    const offerId = [...app.demoState.offers.keys()][0];

    act(() => { redeemOffer(app.server, offerId, 'Pixel 9'); });
    expect(await within(pair()).findByText('Pixel 9 is paired. It may read, notify.')).toBeTruthy();
    expect(screen.queryByLabelText('Pairing code')).toBeNull(); // the code was used up, so it leaves the screen
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Pixel 9' })).toBeTruthy();
    await user.click(within(pair()).getByRole('button', { name: 'Done' }));
    expect(within(pair()).getByRole('button', { name: 'Create pairing code' })).toBeTruthy();
  });

  it('does not mistake the extension or a revoked device for the phone', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    await user.click(within(pair()).getByRole('button', { name: 'Create pairing code' }));
    await screen.findByLabelText('Pairing code');
    const offerId = [...app.demoState.offers.keys()][0];
    act(() => { redeemOffer(app.server, offerId, 'Another browser', 'extension'); });
    await screen.findByRole('heading', { level: 3, name: 'Another browser' });
    expect(screen.getByLabelText('Pairing code')).toBeTruthy(); // still waiting for a phone
  });

  it('removes the code and the QR image when the five minutes are over, and offers a new one', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    app.demoState.now = () => Date.now() - (5 * 60_000 - 1200); // the offer will end 1.2 seconds from now
    await user.click(within(pair()).getByRole('button', { name: 'Create pairing code' }));
    await screen.findByRole('img', { name: 'QR code that holds the pairing code' });
    expect(textOf(screen.getByLabelText('Pairing code'))).toMatch(/It works for 0:0[12] more/);

    expect(await screen.findByText(/This pairing code expired\. A code works for five minutes and only once\./, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(screen.queryByLabelText('The pairing code as text')).toBeNull();
    expect(document.body.textContent).not.toMatch(/[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/);

    app.demoState.now = Date.now;
    await user.click(screen.getByRole('button', { name: 'Create a new code' }));
    expect(await screen.findByLabelText('The pairing code as text')).toBeTruthy();
    expect(app.demoState.offers.size).toBe(2);
  });

  it('says why a code could not be made', async () => {
    const user = userEvent.setup();
    const app = await open('phones');
    app.demoState.failNext.set('pairing.createOffer', new ApiError(500, 'locked', 'The database is locked.'));
    await user.click(within(pair()).getByRole('button', { name: 'Create pairing code' }));
    expect(await within(pair()).findByText('The database is locked.')).toBeTruthy();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  });
});

describe('remote access', () => {
  const SWITCH = 'Allow my phone to reach Mini-Summa through Tailscale Serve';
  const status = () => factsOf(screen.getByLabelText('Tailscale status'));

  it('shows what Tailscale is doing and publishes through Serve only when asked, remembering the choice', async () => {
    const user = userEvent.setup();
    const app = await open('remote');
    const spy = vi.spyOn(app.demo, 'call');
    await screen.findByLabelText('Tailscale status');
    expect(status()).toMatchObject({ Installed: 'Installed', Service: 'Running', Account: 'Signed in as dev@example.com', 'Mini-Summa': 'Not published' });
    const sw = screen.getByRole('switch', { name: SWITCH });
    expect(sw.getAttribute('aria-checked')).toBe('false');

    await user.click(sw);
    await waitFor(() => expect(callsTo(spy, 'tailscale.setServe')).toEqual([{ body: { enabled: true } }]));
    await waitFor(() => expect(patchOf(spy)).toEqual([{ mobile: { remoteAccess: 'tailscale' } }]));
    await waitFor(() => expect(status()['Mini-Summa']).toBe('Published to your tailnet'));
    expect(status().Address).toBe('https://dev-pc.tail1a2b3.ts.net');
    expect(status()['To test']).toContain('https://dev-pc.tail1a2b3.ts.net/api/v1/health');
    expect(screen.getByRole('switch', { name: SWITCH }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Copy the address' })).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: SWITCH }));
    await waitFor(() => expect(callsTo(spy, 'tailscale.setServe').at(-1)).toEqual({ body: { enabled: false } }));
    await waitFor(() => expect(patchOf(spy).at(-1)).toEqual({ mobile: { remoteAccess: 'off' } }));
    await waitFor(() => expect(status()['Mini-Summa']).toBe('Not published'));
  });

  it('says what the requirements are and that Funnel is never used', async () => {
    await open('remote');
    const needs = textOf(screen.getByRole('region', { name: 'What it needs' }));
    expect(needs).toContain('MagicDNS and HTTPS Certificates');
    expect(needs).toContain('Mini-Summa never uses Tailscale Funnel');
  });

  it('shows Tailscale\'s own explanation word for word, and cannot be switched on while Tailscale is missing', async () => {
    const user = userEvent.setup();
    const app = await open('remote');
    const problem = 'Tailscale is not installed on this PC. Install it from https://tailscale.com/download, sign in, then turn remote access on again.';
    app.demoState.tailscale = { ...defaultTailscale(), installed: false, running: false, loggedIn: false, backendState: null, hostName: null, dnsName: null, tailnet: null, tailscaleIps: [], problem };
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(problem)).toBeTruthy();
    expect(callsTo(spy, 'tailscale.status').at(-1)).toEqual({ query: { refresh: true } });
    expect(status()).toMatchObject({ Installed: 'Not installed', Service: 'Not checked', Account: 'Not checked' });
    expect(screen.getByRole('switch', { name: SWITCH })).toHaveProperty('disabled', true);
  });

  it('shows the reason Serve could not be started, word for word, and does not remember a choice that did not work', async () => {
    const user = userEvent.setup();
    const app = await open('remote');
    const spy = vi.spyOn(app.demo, 'call');
    const reason = 'Tailscale Serve is not enabled for your tailnet. A tailnet admin must enable it at https://login.tailscale.com/f/serve?node=abc123, then turn remote access on again.';
    app.demoState.serveProblem = reason;
    await screen.findByLabelText('Tailscale status');
    await user.click(screen.getByRole('switch', { name: SWITCH }));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(patchOf(spy)).toEqual([]);
    expect(screen.getByRole('switch', { name: SWITCH }).getAttribute('aria-checked')).toBe('false');
    expect(status()['Mini-Summa']).toBe('Not published');
  });

  it('treats Funnel only as a warning: it is named, it is not offered, and turning on achieves nothing while it is on', async () => {
    const user = userEvent.setup();
    const app = await open('remote');
    const spy = vi.spyOn(app.demo, 'call');
    app.demoState.tailscale = { ...defaultTailscale(), serve: { configured: false, url: null, target: null, funnelDetected: true }, problem: null };
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    const warning = await screen.findByText(/Tailscale Funnel is on for this PC\. Funnel makes services reachable from the whole internet/);
    expect(textOf(warning)).toContain('tailscale funnel reset');
    expect(status()['Mini-Summa']).toBe('Funnel is on');
    await user.click(screen.getByRole('switch', { name: SWITCH }));
    await waitFor(() => expect(callsTo(spy, 'tailscale.setServe')).toHaveLength(1));
    expect(patchOf(spy)).toEqual([]);
    expect(screen.getByRole('switch', { name: SWITCH }).getAttribute('aria-checked')).toBe('false');
    expect(document.body.textContent).not.toMatch(/Turn on Funnel|Enable Funnel/i);
  });

  it('uses the core\'s own sentence when it explains the Funnel, instead of adding a second one', async () => {
    const user = userEvent.setup();
    const app = await open('remote');
    const own = 'Tailscale Funnel is turned on for this PC (dev-pc:443). Funnel makes services reachable from the whole internet. Mini-Summa never uses Funnel and will not turn on remote access while it is on. Turn it off by running "tailscale funnel reset" in a terminal, then refresh.';
    app.demoState.tailscale = { ...defaultTailscale(), serve: { configured: false, url: null, target: null, funnelDetected: true }, problem: own };
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(own)).toBeTruthy();
    expect(screen.getAllByText(/Funnel makes services reachable from the whole internet/)).toHaveLength(1);
  });
});

describe('push notifications', () => {
  const key = (over: Record<string, unknown> = {}) => JSON.stringify({
    type: 'service_account', project_id: 'mini-summa-push', client_email: 'push@example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n', ...over,
  });
  const field = () => screen.getByLabelText('Service account key') as HTMLTextAreaElement;

  it('starts not set up, explains what push is and what it carries, and only imports what was given', async () => {
    const app = await open('push');
    expect(factsOf(screen.getByLabelText('Push status')).Push).toBe('Not set up');
    expect(factsOf(screen.getByLabelText('Push status')).Phones).toBe('Galaxy Tab is registered.');
    const carried = textOf(screen.getByRole('region', { name: 'What a push contains' }));
    expect(carried).toContain('The project name and one fixed sentence');
    expect(carried).toContain('Report text, prompts, task titles, file paths and command text never go into a push');
    expect(carried).toContain('If the PC is asleep or off, no push is sent');
    expect(screen.getByRole('button', { name: 'Import the key' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Send a test push' })).toBeNull();
    expect(app.runtime.store.getState().settings?.mobile.push.configured).toBe(false);
  });

  it('keeps the pasted text and shows the core\'s own words when the key is refused', async () => {
    const user = userEvent.setup();
    await open('push');
    await user.click(field());
    await user.paste('this is not json');
    await user.click(screen.getByRole('button', { name: 'Import the key' }));
    expect(await screen.findByText('That is not valid JSON. Import the service account file exactly as Firebase gave it to you.')).toBeTruthy();
    expect(field().value).toBe('this is not json');
    fireEvent.change(field(), { target: { value: key({ private_key: undefined }) } });
    await user.click(screen.getByRole('button', { name: 'Import the key' }));
    expect(await screen.findByText(/That file is not a Firebase service account\. It needs client_email, private_key and project_id\./)).toBeTruthy();
  });

  it('imports a key, then clears it from the screen because it is a secret, and shows what is set up', async () => {
    const user = userEvent.setup();
    const app = await open('push');
    const spy = vi.spyOn(app.demo, 'call');
    fireEvent.change(field(), { target: { value: key() } });
    await user.click(screen.getByRole('button', { name: 'Import the key' }));
    await waitFor(() => expect(callsTo(spy, 'push.configure')).toHaveLength(1));
    expect(await screen.findByText('Set up with the Firebase project mini-summa-push')).toBeTruthy();
    expect(field().value).toBe('');
    expect(document.body.textContent).not.toContain('BEGIN PRIVATE KEY');
    expect(app.runtime.store.getState().settings?.mobile.push).toEqual({ provider: 'fcm', configured: true });
    expect(screen.getByRole('button', { name: 'Send a test push' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace the key' })).toBeTruthy();
  });

  it('reads a key file the person picks, and says which file it came from', async () => {
    const user = userEvent.setup();
    await open('push');
    const picker = screen.getByLabelText('Choose the key file') as HTMLInputElement;
    await user.upload(picker, new File([key()], 'firebase-adminsdk.json', { type: 'application/json' }));
    await waitFor(() => expect(field().value).toContain('mini-summa-push'));
    expect(screen.getByText('Loaded from firebase-adminsdk.json.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import the key' })).toHaveProperty('disabled', false);
  });

  it('tests the push and says what Firebase did, not that the phone got it', async () => {
    const user = userEvent.setup();
    const app = await open('push');
    await app.demo.call('push.configure', { body: { serviceAccountJson: key() } });
    await user.click(await screen.findByRole('button', { name: 'Send a test push' }));
    expect(await screen.findByText(/Firebase accepted 1 message\. It should reach the phone within a few seconds\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/delivered/i);
  });

  it('says why a test sent nothing, in the core\'s words', async () => {
    const user = userEvent.setup();
    const app = await open('push');
    await app.demo.call('push.configure', { body: { serviceAccountJson: key() } });
    for (const d of app.server.data.devices) d.pushRegistered = false;
    await user.click(await screen.findByRole('button', { name: 'Send a test push' }));
    expect(await screen.findByText('No phone has registered for push yet. Open the Android app and allow notifications.')).toBeTruthy();
  });

  it('removes the key only after a question that says what it does', async () => {
    const user = userEvent.setup();
    const app = await open('push');
    await app.demo.call('push.configure', { body: { serviceAccountJson: key() } });
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(await screen.findByRole('button', { name: 'Remove the key' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the Firebase key?' });
    expect(textOf(dialog)).toContain('the key file is deleted from this PC');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(callsTo(spy, 'push.clear')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Remove the key' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove the key' }));
    await waitFor(() => expect(callsTo(spy, 'push.clear')).toHaveLength(1));
    await waitFor(() => expect(factsOf(screen.getByLabelText('Push status')).Push).toBe('Not set up'));
  });
});

describe('review and handoff', () => {
  const template = () => screen.getByLabelText('Request to the reviewer') as HTMLTextAreaElement;
  const preview = () => textOf(screen.getByLabelText('Message preview'));
  const partSize = () => screen.getByLabelText('Longest part, in characters') as HTMLInputElement;

  it('shows the saved request, the session line and the part size, and a preview built from them', async () => {
    await open('review');
    expect(template().value).toBe(DEFAULT_REVIEW_REQUEST);
    expect(screen.getByRole('switch', { name: 'Name the Claude session' }).getAttribute('aria-checked')).toBe('true');
    expect(partSize().value).toBe('12000');
    expect(preview()).toContain('Project: GitManager');
    expect(preview()).toContain('Claude session: a1b2c3d4, managed, Windows, generation 1');
    expect(preview()).toContain('<<<MINI-SUMMA REPORT rpt_example0123456789 BEGIN>>>');
    expect(preview()).toContain('Please review this implementation report as the reviewer for this project.');
  });

  it('updates the preview as the request is typed, and saves only when told to', async () => {
    const user = userEvent.setup();
    const app = await open('review');
    const spy = vi.spyOn(app.demo, 'call');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(template(), { target: { value: 'Check the security side first.' } });
    expect(preview().endsWith('Check the security side first.')).toBe(true);
    expect(patchOf(spy)).toEqual([]);
    await user.click(save);
    await waitFor(() => expect(patchOf(spy)).toEqual([{ review: { requestTemplate: 'Check the security side first.' } }]));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(app.runtime.store.getState().settings?.review.requestTemplate).toBe('Check the security side first.');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('switches the session line on and off at once, in the settings and in the preview', async () => {
    const user = userEvent.setup();
    const app = await open('review');
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('switch', { name: 'Name the Claude session' }));
    expect(preview()).not.toContain('Claude session:');
    await waitFor(() => expect(patchOf(spy)).toEqual([{ review: { includeSessionRef: false } }]));
    await waitFor(() => expect(app.runtime.store.getState().settings?.review.includeSessionRef).toBe(false));
  });

  it('accepts a part size with separators, refuses one that is out of range, and never sends a refused one', async () => {
    const user = userEvent.setup();
    const app = await open('review');
    const spy = vi.spyOn(app.demo, 'call');
    fireEvent.change(partSize(), { target: { value: '1,000' } });
    expect(screen.getByText('Use a whole number from 2,000 to 100,000.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    fireEvent.change(partSize(), { target: { value: '8,000' } });
    expect(screen.queryByText('Use a whole number from 2,000 to 100,000.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchOf(spy)).toEqual([{ review: { maxPartChars: 8000 } }]));
  });

  it('keeps everything that was typed when the save fails, and says why', async () => {
    const user = userEvent.setup();
    const app = await open('review');
    app.demoState.failNext.set('settings.update', new ApiError(500, 'locked', 'The database is locked.'));
    fireEvent.change(template(), { target: { value: 'My own request.' } });
    fireEvent.change(partSize(), { target: { value: '9000' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save: The database is locked.')).toBeTruthy();
    expect(template().value).toBe('My own request.');
    expect(partSize().value).toBe('9000');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('button', { name: 'Save' })); // and a second try works
    await waitFor(() => expect(app.runtime.store.getState().settings?.review).toMatchObject({ requestTemplate: 'My own request.', maxPartChars: 9000 }));
  });

  it('can go back to the standard request, and can discard what was typed', async () => {
    const user = userEvent.setup();
    const app = await open('review');
    await app.demo.call('settings.update', { body: { review: { requestTemplate: 'Custom.' } } });
    await waitFor(() => expect(template().value).toBe('Custom.'));
    await user.click(screen.getByRole('button', { name: 'Use the standard request' }));
    expect(template().value).toBe(DEFAULT_REVIEW_REQUEST);
    expect(screen.getByRole('button', { name: 'Use the standard request' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(template().value).toBe('Custom.');
  });
});

describe('data and privacy', () => {
  const stored = () => factsOf(screen.getByLabelText('Storage details'));

  it('says what is stored and where, with the numbers the core reports', async () => {
    const app = await open('data');
    await screen.findByLabelText('Storage details');
    const facts = stored();
    expect(facts['Data folder']).toContain('C:\\Users\\dev\\AppData\\Roaming\\Mini-Summa');
    expect(facts.Reports).toBe(String(app.server.data.reports.length));
    expect(facts['Activity entries']).toBe(String(app.server.data.activity.length));
    expect(facts['Database size']).toMatch(/MB$/);
    expect(facts['Hook events']).toMatch(/^2,410, the oldest .*ago$/);
    const where = textOf(screen.getByRole('region', { name: 'Where things live' }));
    expect(where).toContain('Nothing is uploaded to an account');
    expect(where).toContain('strings that look like credentials are hidden when a report is captured');
    expect(where).toContain('does not read or store your ChatGPT sign-in or conversations');
  });

  it('opens the data folder through the desktop shell, and offers only the path in a plain browser', async () => {
    const user = userEvent.setup();
    const native = createFakeNative();
    await open('data', { native });
    await user.click(await screen.findByRole('button', { name: 'Show data folder' }));
    expect(native.native.shell.showItemInFolder).toHaveBeenCalledWith('C:\\Users\\dev\\AppData\\Roaming\\Mini-Summa');
  });

  it('has no button for the folder where there is no shell to open it', async () => {
    await open('data', { native: createFakeNative({ embedded: false }) });
    await screen.findByLabelText('Storage details');
    expect(screen.queryByRole('button', { name: 'Show data folder' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy the folder path' })).toBeTruthy();
  });

  it('shows the limits, refuses what is not a number of days, and saves only what changed', async () => {
    const user = userEvent.setup();
    const app = await open('data');
    const spy = vi.spyOn(app.demo, 'call');
    const days = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
    expect([days('Hook events, days').value, days('Activity feed, days').value, days('Notification records, days').value, days('Reports and handoffs, days').value]).toEqual(['90', '180', '90', '0']);
    expect(screen.getByRole('button', { name: 'Save limits' })).toHaveProperty('disabled', true);

    fireEvent.change(days('Hook events, days'), { target: { value: 'ninety' } });
    expect(screen.getByText('Use a whole number of days from 0 to 3650.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save limits' })).toHaveProperty('disabled', true);
    fireEvent.change(days('Hook events, days'), { target: { value: '30' } });
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(patchOf(spy)).toEqual([{ retention: { rawEventsDays: 30 } }]));
    await waitFor(() => expect(app.runtime.store.getState().settings?.retention.rawEventsDays).toBe(30));
  });

  it('keeps the typed limits when saving fails', async () => {
    const user = userEvent.setup();
    const app = await open('data');
    app.demoState.failNext.set('settings.update', new ApiError(500, 'locked', 'The database is locked.'));
    fireEvent.change(screen.getByLabelText('Activity feed, days'), { target: { value: '45' } });
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(await screen.findByText('Could not save: The database is locked.')).toBeTruthy();
    expect((screen.getByLabelText('Activity feed, days') as HTMLInputElement).value).toBe('45');
  });

  it('previews a cleanup without removing anything, then removes it only after a confirmation that names what goes', async () => {
    const user = userEvent.setup();
    const app = await open('data');
    await app.demo.call('settings.update', { body: { retention: { activityDays: 3 } } }); // some of the seeded feed is older than that
    await waitFor(() => expect((screen.getByLabelText('Activity feed, days') as HTMLInputElement).value).toBe('3'));
    const words = pruneWords(await app.demo.call('data.prune', { body: { dryRun: true } })).lines.join(', ');
    expect(words).toMatch(/^612 hook events, \d+ activity entries/);
    const spy = vi.spyOn(app.demo, 'call');
    const before = app.server.data.activity.length;

    await user.click(screen.getByRole('button', { name: 'Preview the cleanup' }));
    await screen.findByText(`This cleanup would remove ${words}. Nothing has been removed yet.`);
    expect(callsTo(spy, 'data.prune')).toEqual([{ body: { dryRun: true } }]);
    expect(app.server.data.activity.length).toBe(before); // a preview removes nothing

    await user.click(screen.getByRole('button', { name: 'Remove these records' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove old records?' });
    expect(textOf(dialog)).toBe(`Remove old records?This removes ${words} from this PC. It cannot be undone.CancelRemove old records`);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(callsTo(spy, 'data.prune')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Remove these records' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove old records' }));
    await waitFor(() => expect(callsTo(spy, 'data.prune')).toHaveLength(2));
    expect(callsTo(spy, 'data.prune')[1]).toEqual({ body: { dryRun: false } });
    expect(await screen.findByText(`Removed ${words}.`)).toBeTruthy();
    expect(app.server.data.activity.length).toBeLessThan(before);
    await waitFor(() => expect(stored()['Activity entries']).toBe(String(app.server.data.activity.length))); // the numbers were read again
    expect(callsTo(spy, 'data.usage').length).toBeGreaterThanOrEqual(1);
  });

  it('says plainly when nothing is older than the limits', async () => {
    const user = userEvent.setup();
    const app = await open('data');
    await app.demo.call('settings.update', { body: { retention: { rawEventsDays: 0, activityDays: 0, notificationsDays: 0, reportsDays: 0 } } });
    await user.click(screen.getByRole('button', { name: 'Preview the cleanup' }));
    expect(await screen.findByText('Nothing is older than your limits, so there is nothing to remove.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove these records' })).toBeNull();
  });

  it('asks for the new limits to be saved before it previews, so the preview is about what will be used', async () => {
    const app = await open('data');
    fireEvent.change(screen.getByLabelText('Activity feed, days'), { target: { value: '10' } });
    expect(screen.getByRole('button', { name: 'Preview the cleanup' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Save the new limits first, so the preview matches them.')).toBeTruthy();
    expect(callsTo(vi.spyOn(app.demo, 'call'), 'data.prune')).toHaveLength(0);
  });

  it('shows why a cleanup could not run, and what the confirmation could not do', async () => {
    const user = userEvent.setup();
    const app = await open('data');
    await user.click(screen.getByRole('button', { name: 'Preview the cleanup' }));
    await screen.findByRole('button', { name: 'Remove these records' });
    await user.click(screen.getByRole('button', { name: 'Remove these records' }));
    app.demoState.failNext.set('data.prune', new ApiError(500, 'locked', 'The database is locked.'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove old records?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove old records' }));
    expect(await within(dialog).findByText('The database is locked.')).toBeTruthy();
    expect(await screen.findByText(/Nothing has been removed yet\./)).toBeTruthy();
  });
});

describe('about and setup', () => {
  it('says which version of what is running', async () => {
    await open('about');
    const about = factsOf(await screen.findByLabelText('About Mini-Summa'));
    expect(about).toMatchObject({ Version: '0.1.0-demo', Computer: 'Windows', 'API version': '1' });
    expect(about['Running as']).toBe('The desktop app, with its own core');
    expect(about['This window']).toBe('The desktop app, version test');
  });

  it('shows the setup steps with ticks read from the core, and the way back to the start screen checklist', async () => {
    const app = await open('about');
    const steps = await screen.findByRole('list', { name: 'Setup steps' });
    await waitFor(() => expect(within(steps).getByRole('heading', { level: 3, name: /Claude Code is installed/ }).textContent).toMatch(/^Done: /));
    const title = (name: RegExp) => textOf(within(steps).getByRole('heading', { level: 3, name }));
    expect(title(/Create your first project/)).toMatch(/^Done: /); // the demo has projects
    expect(title(/Install Claude hooks/)).toMatch(/^Done: .*\(optional\)$/); // Windows has them
    expect(title(/Start a Claude session/)).toMatch(/^Done: /);
    expect(app.runtime.store.getState().projects.length).toBeGreaterThan(0);
  });
});
