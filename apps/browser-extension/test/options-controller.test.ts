import { describe, expect, it } from 'vitest';
import { encodePairingPayload } from '@minisumma/shared';
import { createOptionsController } from '../src/options-controller.ts';
import type { OptionsFields, OptionsModel, OptionsView } from '../src/options-controller.ts';
import { DEFAULT_CORE_URL } from '../src/core-address.ts';
import type { ConnectionStatus } from '../src/status.ts';
import { loadState, markRevoked, savePairing } from '../src/storage.ts';
import { MemoryArea } from './fake-socket.ts';

const CODE = 'abcd-efgh-1234-5678';

class FakeView implements OptionsView {
  fields: OptionsFields = { coreUrl: '', link: '', offerId: '', code: '', deviceName: '' };
  renders: OptionsModel[] = [];
  render(model: OptionsModel): void { this.renders.push(model); }
  readFields(): OptionsFields { return { ...this.fields }; }
  writeFields(patch: Partial<OptionsFields>): void { Object.assign(this.fields, patch); }
  get last(): OptionsModel { return this.renders[this.renders.length - 1]; }
}

function setup(opts: { redeem?: () => Promise<Response>; status?: () => Promise<ConnectionStatus | null> } = {}) {
  const view = new FakeView();
  const area = new MemoryArea();
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const okResponse = () => new Response(JSON.stringify({
    device: { id: 'dev-7', name: 'Chrome on Windows' }, token: 'secret-token', server: { name: 'Mini-Summa', apiVersion: 1 },
  }), { status: 200 });
  const controller = createOptionsController({
    area,
    view,
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) });
      return opts.redeem ? opts.redeem() : okResponse();
    },
    requestStatus: opts.status ?? (async () => ({ state: 'not_paired', since: 0, coreUrl: DEFAULT_CORE_URL })),
    defaultDeviceName: 'Chrome on Windows',
    now: () => 5_000,
  });
  return { view, area, requests, controller };
}

describe('options page logic', () => {
  it('starts with the default address and the browser based device name, and shows the live status', async () => {
    const { view, controller } = setup();
    await controller.init();
    expect(view.fields).toMatchObject({ coreUrl: DEFAULT_CORE_URL, deviceName: 'Chrome on Windows', link: '', offerId: '', code: '' });
    expect(view.last).toMatchObject({ paired: false, busy: false, message: null, statusText: { headline: 'Not paired' } });
  });

  it('says so when the background worker does not answer', async () => {
    const { view, controller } = setup({ status: async () => null });
    await controller.init();
    expect(view.last.statusText.headline).toBe('The extension did not answer');
  });

  it('fills offer id, code and address from a pasted pairing link', async () => {
    const { view, controller } = setup();
    await controller.init();
    view.fields.link = encodePairingPayload({ version: 1, code: CODE, offerId: 'offer-9', name: 'PC', urls: ['https://pc.tail1234.ts.net', 'http://127.0.0.1:48000'] });
    controller.onLinkInput();
    expect(view.fields).toMatchObject({ offerId: 'offer-9', code: CODE, coreUrl: 'http://127.0.0.1:48000' });
  });

  it('pairs with a pasted link: one request, token stored, spent code removed from the page', async () => {
    const { view, area, requests, controller } = setup();
    await controller.init();
    view.fields.link = encodePairingPayload({ version: 1, code: CODE, offerId: 'offer-9', name: 'PC', urls: ['http://127.0.0.1:48000'] });
    controller.onLinkInput();

    await controller.pair();

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:48000/api/v1/pairing/redeem',
      body: { offerId: 'offer-9', code: CODE, deviceName: 'Chrome on Windows', platform: 'extension' },
    }]);
    expect(await loadState(area)).toEqual({ coreUrl: 'http://127.0.0.1:48000', token: 'secret-token', deviceId: 'dev-7', deviceName: 'Chrome on Windows', pairedAt: 5_000, revokedAt: null });
    expect(view.fields).toMatchObject({ link: '', offerId: '', code: '', coreUrl: 'http://127.0.0.1:48000' });
    expect(view.last).toMatchObject({ paired: true, pairedLine: 'Paired as Chrome on Windows.', busy: false, message: null });
    expect(JSON.stringify(view.renders)).not.toContain('secret-token');
  });

  it('pairs with a typed offer id and code and a changed device name', async () => {
    const { view, requests, controller } = setup();
    await controller.init();
    Object.assign(view.fields, { coreUrl: 'localhost:5000', offerId: 'offer-1', code: CODE, deviceName: 'Work laptop' });
    await controller.pair();
    expect(requests[0]).toEqual({ url: 'http://localhost:5000/api/v1/pairing/redeem', body: { offerId: 'offer-1', code: CODE, deviceName: 'Work laptop', platform: 'extension' } });
  });

  it('shows busy while the request runs and ignores a second click', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    const { view, requests, controller } = setup({ redeem: () => gate });
    await controller.init();
    Object.assign(view.fields, { offerId: 'offer-1', code: CODE });

    const first = controller.pair();
    const second = controller.pair();
    await Promise.resolve();
    expect(view.last.busy).toBe(true);
    release(new Response(JSON.stringify({ device: { id: 'd', name: 'n' }, token: 't' }), { status: 200 }));
    await Promise.all([first, second]);

    expect(requests).toHaveLength(1);
    expect(view.last.busy).toBe(false);
    expect(view.renders.some((m) => m.busy)).toBe(true);
  });

  it('explains a refusal and keeps what was typed so it can be corrected', async () => {
    const { view, area, controller } = setup({ redeem: async () => new Response(JSON.stringify({ error: { code: 'bad_code', message: 'The code does not match.' } }), { status: 400 }) });
    await controller.init();
    Object.assign(view.fields, { offerId: 'offer-1', code: CODE });
    await controller.pair();
    expect(view.last.message).toEqual({ kind: 'error', text: 'Mini-Summa refused the pairing: The code does not match.' });
    expect(view.fields).toMatchObject({ offerId: 'offer-1', code: CODE });
    expect((await loadState(area)).token).toBeNull();
    expect(view.last.paired).toBe(false);
  });

  it('refuses an incomplete form without sending anything', async () => {
    const { view, requests, controller } = setup();
    await controller.init();
    await controller.pair();
    expect(requests).toEqual([]);
    expect(view.last.message?.kind).toBe('error');
    view.fields.link = 'not a link';
    await controller.pair();
    expect(view.last.message?.text).toMatch(/not a Mini-Summa pairing link/);
    expect(requests).toEqual([]);
  });

  it('unpairing clears the token but keeps the address', async () => {
    const { view, area, controller } = setup();
    await savePairing(area, { coreUrl: 'http://localhost:5000', token: 'tok', deviceId: 'd', deviceName: 'Chrome on Windows', pairedAt: 1 });
    await controller.init();
    expect(view.last.paired).toBe(true);

    await controller.unpair();

    expect(await loadState(area)).toMatchObject({ token: null, coreUrl: 'http://localhost:5000', revokedAt: null });
    expect(view.last.paired).toBe(false);
  });

  it('shows the revoked wording and the pairing form again after Mini-Summa unpaired this browser', async () => {
    const { view, area, controller } = setup({
      status: async () => ({ state: 'revoked', since: 1, coreUrl: DEFAULT_CORE_URL }),
    });
    await savePairing(area, { coreUrl: DEFAULT_CORE_URL, token: 'tok', deviceId: 'd', deviceName: 'n', pairedAt: 1 });
    await markRevoked(area, 2);
    await controller.init();
    expect(view.last.paired).toBe(false);
    expect(view.last.statusText.headline).toBe('This browser was unpaired in Mini-Summa');
  });

  describe('changing the address of a paired browser', () => {
    it('offers Save only when the field differs, rejects bad addresses and stores a good one', async () => {
      const { view, area, controller } = setup();
      await savePairing(area, { coreUrl: DEFAULT_CORE_URL, token: 'tok', deviceId: 'd', deviceName: 'n', pairedAt: 1 });
      await controller.init();
      expect(view.last.addressDirty).toBe(false);

      view.fields.coreUrl = 'localhost:6000';
      controller.onInput();
      expect(view.last.addressDirty).toBe(true);

      view.fields.coreUrl = 'https://example.com';
      await controller.saveAddress();
      expect(view.last.message?.kind).toBe('error');
      expect((await loadState(area)).coreUrl).toBe(DEFAULT_CORE_URL);

      view.fields.coreUrl = 'localhost:6000';
      await controller.saveAddress();
      expect((await loadState(area)).coreUrl).toBe('http://localhost:6000');
      expect(view.fields.coreUrl).toBe('http://localhost:6000');
      expect(view.last.addressDirty).toBe(false);
      expect(view.last.message).toBeNull();
    });

    it('does not show Save while not paired', async () => {
      const { view, controller } = setup();
      await controller.init();
      view.fields.coreUrl = 'localhost:6000';
      controller.onInput();
      expect(view.last.addressDirty).toBe(false);
    });
  });
});
