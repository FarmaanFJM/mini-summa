import { describe, expect, it } from 'vitest';
import { API_PREFIX, encodePairingPayload, routes } from '@minisumma/shared';
import { DEFAULT_CORE_URL, redeemUrlOf } from '../src/core-address.ts';
import { deviceNameFromNavigator, redeemPairing, resolvePairingForm } from '../src/pairing.ts';
import type { PairingRequest } from '../src/pairing.ts';

const CODE = 'abcd-efgh-1234-5678';
const form = (over: Partial<Parameters<typeof resolvePairingForm>[0]> = {}) =>
  resolvePairingForm({ coreUrl: DEFAULT_CORE_URL, link: '', offerId: 'offer-1', code: CODE, deviceName: 'Chrome on Windows', ...over });

describe('resolvePairingForm', () => {
  it('accepts an offer id and a code typed by hand', () => {
    expect(form()).toEqual({ ok: true, coreUrl: DEFAULT_CORE_URL, offerId: 'offer-1', code: CODE, deviceName: 'Chrome on Windows' });
  });

  it('decodes a pasted minisumma://pair link with the shared decoder and prefers its loopback address', () => {
    const link = encodePairingPayload({
      version: 1, code: CODE, offerId: 'offer-9', name: 'My PC',
      urls: ['https://my-pc.tail1234.ts.net', 'http://localhost:48000', 'http://127.0.0.1:48000'],
    });
    expect(form({ link, offerId: 'ignored', code: 'ignored-ignored', coreUrl: 'http://127.0.0.1:1' }))
      .toEqual({ ok: true, coreUrl: 'http://localhost:48000', offerId: 'offer-9', code: CODE, deviceName: 'Chrome on Windows' });
  });

  it('keeps the address field when the link has no address this computer can use', () => {
    const link = encodePairingPayload({ version: 1, code: CODE, offerId: 'offer-9', name: 'My PC', urls: ['https://my-pc.tail1234.ts.net'] });
    expect(form({ link, coreUrl: '127.0.0.1:47000' })).toMatchObject({ ok: true, coreUrl: 'http://127.0.0.1:47000', offerId: 'offer-9' });
  });

  it('explains a link that is not a pairing link', () => {
    for (const link of ['hello', 'https://example.com/pair?c=1', 'minisumma://pair?v=2&c=abcdefgh&o=x&u=http%3A%2F%2F127.0.0.1']) {
      const r = form({ link });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.message).toMatch(/not a Mini-Summa pairing link/);
    }
  });

  it('checks the same limits as the core before any request is made', () => {
    expect(form({ offerId: '  ' })).toMatchObject({ ok: false, message: expect.stringMatching(/offer id/) });
    expect(form({ offerId: 'x'.repeat(101) })).toMatchObject({ ok: false, message: expect.stringMatching(/offer id is too long/) });
    expect(form({ code: 'short' })).toMatchObject({ ok: false, message: expect.stringMatching(/too short/) });
    expect(form({ code: 'x'.repeat(201) })).toMatchObject({ ok: false, message: expect.stringMatching(/too long/) });
    expect(form({ coreUrl: 'https://example.com' })).toMatchObject({ ok: false });
    expect(form({ coreUrl: '' })).toMatchObject({ ok: false });
  });

  it('trims the fields, defaults the device name and cuts it to 80 characters', () => {
    expect(form({ offerId: '  offer-1  ', code: `  ${CODE}  `, deviceName: '   ' })).toMatchObject({ offerId: 'offer-1', code: CODE, deviceName: 'Browser extension' });
    const long = form({ deviceName: 'n'.repeat(120) });
    expect(long.ok && long.deviceName).toHaveLength(80);
  });

  it('never produces an error message that contains the code', () => {
    const r = form({ offerId: '', code: CODE });
    expect(JSON.stringify(r)).not.toContain(CODE);
  });
});

describe('redeemPairing', () => {
  const req: PairingRequest = { coreUrl: DEFAULT_CORE_URL, offerId: 'offer-1', code: CODE, deviceName: 'Chrome on Windows' };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const okBody = {
    device: { id: 'dev-7', name: 'Chrome on Windows', platform: 'extension', scopes: ['extension'] },
    token: 'secret-token-123',
    server: { name: 'Mini-Summa on PC', apiVersion: 1 },
  };

  it('sends one public POST with platform "extension" and no authorization header', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const result = await redeemPairing(req, { fetch: async (url, init) => { seen.push({ url: String(url), init: init as RequestInit }); return json(200, okBody); } });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://127.0.0.1:47811/api/v1/pairing/redeem');
    expect(seen[0].init.method).toBe('POST');
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ offerId: 'offer-1', code: CODE, deviceName: 'Chrome on Windows', platform: 'extension' });
    expect(result).toEqual({ ok: true, coreUrl: DEFAULT_CORE_URL, token: 'secret-token-123', deviceId: 'dev-7', deviceName: 'Chrome on Windows', serverName: 'Mini-Summa on PC' });
  });

  it('uses the address and the request body the shared route table defines', () => {
    const def = routes['pairing.redeem'];
    expect(def.method).toBe('POST');
    expect(def.scope).toBe('public');
    expect(redeemUrlOf(DEFAULT_CORE_URL)).toBe(`${DEFAULT_CORE_URL}${API_PREFIX}${def.path}`);
    const body = { offerId: req.offerId, code: req.code, deviceName: req.deviceName, platform: 'extension' };
    expect(def.body?.safeParse(body).success).toBe(true);
    expect(def.body?.safeParse({ ...body, platform: 'toaster' }).success).toBe(false);
  });

  it('shows the core\'s own sentence when it refuses', async () => {
    const r = await redeemPairing(req, { fetch: async () => json(410, { error: { code: 'offer_expired', message: 'This pairing code has expired.' } }) });
    expect(r).toEqual({ ok: false, message: 'Mini-Summa refused the pairing: This pairing code has expired.' });
  });

  it('explains common refusals that carry no message', async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      const r = await redeemPairing(req, { fetch: async () => new Response('', { status }) });
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/may have expired or been used already/) });
    }
    const r = await redeemPairing(req, { fetch: async () => new Response('oops', { status: 500 }) });
    expect(r).toEqual({ ok: false, message: 'Mini-Summa answered with status 500. Try again, or restart Mini-Summa.' });
  });

  it('says Mini-Summa could not be reached when the request fails', async () => {
    const r = await redeemPairing(req, { fetch: async () => { throw new TypeError('Failed to fetch'); } });
    expect(r).toEqual({ ok: false, message: 'Could not reach Mini-Summa at http://127.0.0.1:47811. Is the app running?' });
  });

  it('gives up when the core does not answer in time', async () => {
    const hang: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const r = await redeemPairing(req, { fetch: hang, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, message: 'Mini-Summa did not answer in time. Is the app running?' });
  });

  it('rejects an answer without a token', async () => {
    for (const body of [{}, { token: '', device: {} }, { token: 'x' }, { device: {} }, null]) {
      const r = await redeemPairing(req, { fetch: async () => json(200, body) });
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/does not understand/) });
    }
  });

  it('never repeats the code or the token in a failure message', async () => {
    const results = [
      await redeemPairing(req, { fetch: async () => json(404, { error: { code: 'x', message: 'No such offer.' } }) }),
      await redeemPairing(req, { fetch: async () => { throw new Error(`boom ${CODE}`); } }),
      await redeemPairing(req, { fetch: async () => json(200, { token: '', device: {} }) }),
    ];
    for (const r of results) expect(JSON.stringify(r)).not.toContain(CODE);
  });
});

describe('deviceNameFromNavigator', () => {
  const cases: [string, Parameters<typeof deviceNameFromNavigator>[0], string][] = [
    ['Chrome on Windows from client hints', { userAgentData: { brands: [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }], platform: 'Windows' } }, 'Chrome on Windows'],
    ['Edge on Windows', { userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }], platform: 'Windows' } }, 'Edge on Windows'],
    ['Brave on macOS', { userAgentData: { brands: [{ brand: 'Brave' }, { brand: 'Chromium' }], platform: 'macOS' } }, 'Brave on macOS'],
    ['Chrome from a user agent string', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }, 'Chrome on Windows'],
    ['Edge from a user agent string', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0' }, 'Edge on Windows'],
    ['Chromium on Linux', { userAgentData: { brands: [{ brand: 'Chromium' }], platform: 'Linux' } }, 'Chromium on Linux'],
    ['nothing known', {}, 'Browser'],
  ];
  for (const [name, nav, expected] of cases) it(name, () => expect(deviceNameFromNavigator(nav)).toBe(expected));
});
