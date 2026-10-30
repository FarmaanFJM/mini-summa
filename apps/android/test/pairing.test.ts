import { encodePairingPayload } from '@minisumma/shared';
import type { PairingPayload } from '@minisumma/shared';
import {
  normalizeAddress, pairWithDesktop, PairingError, parseScannedCode, payloadFromManualInput, pairingMessage, suggestDeviceName,
} from '../src/pairing/pairing';
import { makeDevice } from './helpers/data';

const payload: PairingPayload = {
  version: 1, code: 'abcDEF123456', offerId: 'off_1', name: "Farmaan's PC",
  urls: ['https://pc.tail1234.ts.net', 'https://100.101.102.103:8443', 'http://192.168.1.20:4317'],
};

type Responder = (init: { method?: string; headers?: Record<string, string>; body?: string }, path: string) => { status?: number; body?: unknown } | Error;

/** A fetch that answers per host, and records every request in order. */
function hostFetch(hosts: Record<string, Responder>) {
  const log: { host: string; path: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fn = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const m = /^https?:\/\/([^/]+)(\/.*)$/.exec(url)!;
    const host = m[1]; const path = m[2].replace('/api/v1', '');
    log.push({ host, path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const responder = hosts[host];
    if (!responder) throw new TypeError('Network request failed');
    const reply = responder(init, path);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(reply.body ?? {}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, log };
}

const healthy: Responder = (_init, path) => (path === '/health'
  ? { body: { ok: true, name: 'mini-summa-core', version: '0.1.0', apiVersion: 1 } }
  : { body: { device: makeDevice({ id: 'dev_77' }), token: 'bearer-abc', server: { name: "Farmaan's PC", apiVersion: 1 } } });

describe('reading the QR code', () => {
  it('decodes a pairing link and ignores everything else', () => {
    expect(parseScannedCode(encodePairingPayload(payload))).toEqual(payload);
    expect(parseScannedCode('https://example.com/pair')).toBeNull();
    expect(parseScannedCode('minisumma://pair?v=2&c=x&o=y&u=https://a')).toBeNull();
    expect(parseScannedCode('minisumma://pair?v=1&c=x&o=y&u=javascript:alert(1)')).toBeNull();
    expect(parseScannedCode('')).toBeNull();
  });
});

describe('trying addresses in order', () => {
  it('skips an address that does not answer and one that is not Mini-Summa, then redeems at the first good one', async () => {
    const { fetch, log } = hostFetch({
      // pc.tail1234.ts.net is not in the table: no answer at all
      '100.101.102.103:8443': () => ({ body: { hello: 'not mini-summa' } }),
      '192.168.1.20:4317': healthy,
    });
    // The first two fail, the third (plain http) is the one that answers in this test.
    const result = await pairWithDesktop(payload, { deviceName: 'Pixel 8', fetch });

    expect(log.map((l) => `${l.host}${l.path}`)).toEqual([
      'pc.tail1234.ts.net/health', '100.101.102.103:8443/health', '192.168.1.20:4317/health', '192.168.1.20:4317/pairing/redeem',
    ]);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['no_answer', 'not_mini_summa', 'ok']);
    expect(result.credentials).toEqual({ baseUrl: 'http://192.168.1.20:4317', token: 'bearer-abc', deviceId: 'dev_77', serverName: "Farmaan's PC" });
  });

  it('redeems with the offer id, code, device name and platform android, and sends no bearer token', async () => {
    const { fetch, log } = hostFetch({ 'pc.tail1234.ts.net': healthy });
    const result = await pairWithDesktop({ ...payload, urls: [payload.urls[0]] }, { deviceName: '  Pixel 8  ', fetch });
    const redeem = log.find((l) => l.path === '/pairing/redeem')!;
    expect(redeem.method).toBe('POST');
    expect(redeem.body).toEqual({ offerId: 'off_1', code: 'abcDEF123456', deviceName: 'Pixel 8', platform: 'android' });
    expect(redeem.headers.authorization).toBeUndefined();
    expect(result.credentials.baseUrl).toBe('https://pc.tail1234.ts.net');
    expect(log.filter((l) => l.path === '/health')).toHaveLength(1); // stops at the first address that answers
  });
});

describe('when the desktop cannot be reached', () => {
  it('says the PC may be asleep, offline, or not on Tailscale', async () => {
    const { fetch } = hostFetch({});
    const err = (await pairWithDesktop(payload, { deviceName: 'Pixel 8', fetch }).catch((e) => e)) as PairingError;
    expect(err).toBeInstanceOf(PairingError);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toContain('Your PC may be asleep, offline, or not signed in to Tailscale on this phone');
    expect(err.attempts).toHaveLength(3);
  });

  it('names a certificate or HTTPS problem when the error says so', async () => {
    const { fetch } = hostFetch({ 'pc.tail1234.ts.net': () => new TypeError('SSL handshake failed: certificate chain validation failed') });
    const err = (await pairWithDesktop({ ...payload, urls: [payload.urls[0]] }, { deviceName: 'x', fetch }).catch((e) => e)) as PairingError;
    expect(err.kind).toBe('tls');
    expect(err.message).toContain('secure connection');
  });

  it('explains that Android blocks plain http to another device', async () => {
    const { fetch } = hostFetch({});
    const err = (await pairWithDesktop({ ...payload, urls: ['http://192.168.1.20:4317'] }, { deviceName: 'x', fetch }).catch((e) => e)) as PairingError;
    expect(err.kind).toBe('cleartext');
    expect(err.message).toContain('https address');
  });

  it('reports an address that answers with an error as a desktop problem, not a network one', async () => {
    const { fetch } = hostFetch({ 'pc.tail1234.ts.net': () => ({ status: 502, body: { error: { code: 'bad_gateway', message: 'upstream' } } }) });
    const err = (await pairWithDesktop({ ...payload, urls: [payload.urls[0]] }, { deviceName: 'x', fetch }).catch((e) => e)) as PairingError;
    expect(err.kind).toBe('desktop_error');
    expect(err.message).toContain('Make sure Mini-Summa is running');
  });
});

describe('what the desktop says about the code', () => {
  const redeemWith = async (status: number, code: string, message: string) => {
    const { fetch } = hostFetch({ 'pc.tail1234.ts.net': (_i, path) => (path === '/health' ? healthy(_i, path) : { status, body: { error: { code, message } } }) });
    return (await pairWithDesktop({ ...payload, urls: [payload.urls[0]] }, { deviceName: 'x', fetch }).catch((e) => e)) as PairingError;
  };

  it.each([
    [410, 'offer_expired', 'This pairing offer has expired.', 'code_expired', 'expired'],
    [409, 'offer_used', 'This pairing offer was already used.', 'code_used', 'already used'],
    [404, 'not_found', 'Pairing offer was not found.', 'code_invalid', 'did not recognise'],
    [400, 'bad_request', 'The code does not match.', 'code_invalid', 'did not recognise'],
    [429, 'rate_limited', 'Too many attempts.', 'too_many_attempts', 'Too many wrong codes'],
    [403, 'forbidden', 'No.', 'refused', 'refused'],
    // The messages and codes the real core uses (packages/core/src/infra/devices.ts).
    [404, 'offer_not_found', 'This pairing code is not known to this PC. Create a new one on the PC and scan it again.', 'code_invalid', 'did not recognise'],
    [410, 'offer_used', 'This pairing code was already used. Create a new one on the PC to pair another device.', 'code_used', 'already used'],
    [410, 'offer_expired', 'This pairing code has expired (codes last 5 minutes). Create a new one on the PC and scan it again.', 'code_expired', 'expired'],
    [410, 'offer_burned', 'This pairing code was cancelled after too many wrong attempts. Create a new one on the PC and scan it again.', 'too_many_attempts', 'cancelled'],
    [403, 'invalid_code', 'That pairing code is not correct. Scan the QR code on the PC again, or create a new one.', 'code_invalid', 'did not recognise'],
    [429, 'too_many_attempts', 'Too many wrong codes. This pairing code is cancelled. Create a new one on the PC and scan it again.', 'too_many_attempts', 'cancelled'],
  ])('maps %i %s to %s', async (status, code, message, kind, wording) => {
    const err = await redeemWith(status as number, code as string, message as string);
    expect(err.kind).toBe(kind);
    expect(err.message).toContain(wording as string);
  });

  it('tells an expired code from a used one by the words the desktop uses even without a distinct status', async () => {
    expect((await redeemWith(400, 'bad_request', 'The pairing offer has expired.')).kind).toBe('code_expired');
    expect((await redeemWith(400, 'bad_request', 'This code was already redeemed.')).kind).toBe('code_used');
  });

  it('every message says what to do next and has no em dash', () => {
    for (const kind of ['invalid_input', 'unreachable', 'tls', 'cleartext', 'not_mini_summa', 'desktop_error', 'code_expired', 'code_used', 'code_invalid', 'too_many_attempts', 'refused'] as const) {
      expect(pairingMessage(kind)).not.toContain('—');
      expect(pairingMessage(kind).length).toBeGreaterThan(30);
    }
  });
});

describe('typing the details by hand', () => {
  it('normalizes the address', () => {
    expect(normalizeAddress('pc.tail1234.ts.net')).toBe('https://pc.tail1234.ts.net');
    expect(normalizeAddress('  https://pc.tail1234.ts.net/some/path?x=1  ')).toBe('https://pc.tail1234.ts.net');
    expect(normalizeAddress('http://100.64.1.2:4317/')).toBe('http://100.64.1.2:4317');
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress('not an address')).toBeNull();
    expect(normalizeAddress('javascript:alert(1)')).toBeNull();
  });

  it('builds a payload from address, offer id and code', () => {
    expect(payloadFromManualInput({ address: 'pc.tail1234.ts.net', offerId: ' off_1 ', code: ' abcDEF123456 ' })).toEqual({
      version: 1, code: 'abcDEF123456', offerId: 'off_1', urls: ['https://pc.tail1234.ts.net'], name: 'your PC',
    });
  });

  it('accepts a pasted pairing link in any field', () => {
    const link = encodePairingPayload(payload);
    expect(payloadFromManualInput({ address: '', offerId: '', code: link })).toEqual(payload);
    expect(payloadFromManualInput({ address: link, offerId: '', code: '' })).toEqual(payload);
  });

  it('rejects incomplete input with a plain message', () => {
    expect(() => payloadFromManualInput({ address: 'pc.ts.net', offerId: '', code: 'abcDEF123456' })).toThrow(PairingError);
    expect(() => payloadFromManualInput({ address: 'pc.ts.net', offerId: 'off_1', code: 'short' })).toThrow(/Check the address/);
  });
});

describe('device name', () => {
  it('suggests a readable name from the phone model', () => {
    expect(suggestDeviceName({ Brand: 'google', Model: 'Pixel 8' })).toBe('Google Pixel 8');
    expect(suggestDeviceName({ Brand: 'samsung', Model: 'Samsung Galaxy S24' })).toBe('Samsung Galaxy S24');
    expect(suggestDeviceName(undefined)).toBe('Android phone');
  });
});
