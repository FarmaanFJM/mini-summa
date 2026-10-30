import { createHash } from 'node:crypto';
import { API_VERSION, decodePairingPayload } from '@minisumma/shared';
import type { Scope } from '@minisumma/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevicesService, Principal } from '../../src/contracts.ts';
import { LAST_SEEN_INTERVAL_MS, MAX_CODE_ATTEMPTS, OFFER_TTL_MS, createDevicesService } from '../../src/infra/devices.ts';
import { expectPlainText, failure, makeBase } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';

// Count every call of crypto.timingSafeEqual (the real one still runs) to prove the secret comparisons use it.
const compare = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => { compare.calls += 1; return actual.timingSafeEqual(a, b); };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

const URLS = ['https://pc.tail1234.ts.net', 'http://127.0.0.1:4317'];
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

let base: TestBase;
let devices: DevicesService;
beforeEach(() => {
  base = makeBase();
  devices = createDevicesService({ base, machineName: 'Farmaan-PC' });
});
afterEach(() => base.close());

/** Pairs a phone and returns what the phone would hold. */
function pair(scopes: Scope[] = ['read', 'notify'], name = 'Pixel 9', platform: 'android' | 'ios' | 'other' = 'android') {
  const offer = devices.createOffer(scopes, URLS, 'phone');
  const result = devices.redeem({ offerId: offer.id, code: offer.code, deviceName: name, platform }, 'tailscale');
  return { offer, ...result };
}

const wholeDatabase = (): string => JSON.stringify(['devices', 'pairing_offers', 'kv', 'idempotency', 'raw_events'].map((t) => base.db.all(`SELECT * FROM ${t}`)));

describe('creating a pairing offer', () => {
  it('makes a one-time code that lasts 5 minutes and is stored only as a hash', () => {
    const offer = devices.createOffer(['read', 'notify', 'prompt'], URLS, 'phone');
    expect(offer.id).toMatch(/^off_[0-9a-f]{16}$/);
    expect(offer.code).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 random bytes
    expect(offer.scopes).toEqual(['read', 'notify', 'prompt']);
    expect(offer.urls).toEqual(URLS);
    expect(Date.parse(offer.expiresAt) - base.clock.now().getTime()).toBe(OFFER_TTL_MS);
    expect(OFFER_TTL_MS).toBe(5 * 60_000);

    const row = base.db.get<{ code_hash: string; scopes_json: string; expires_at: string; failed_attempts: number; redeemed_at: string | null }>('SELECT * FROM pairing_offers WHERE id = ?', [offer.id]);
    expect(row?.code_hash).toBe(sha256Hex(offer.code));
    expect(JSON.stringify(row)).not.toContain(offer.code);
    expect(row).toMatchObject({ scopes_json: '["read","notify","prompt"]', expires_at: offer.expiresAt, failed_attempts: 0, redeemed_at: null });
  });

  it('puts everything the phone needs in the QR payload, named after this computer', () => {
    const offer = devices.createOffer(['read'], URLS, 'phone');
    expect(offer.qrPayload.startsWith('minisumma://pair?')).toBe(true);
    expect(decodePairingPayload(offer.qrPayload)).toEqual({ version: 1, code: offer.code, offerId: offer.id, urls: URLS, name: 'Farmaan-PC' });
  });

  it('never gives two offers the same id or code', () => {
    const offers = Array.from({ length: 20 }, () => devices.createOffer(['read'], URLS, 'phone'));
    expect(new Set(offers.map((o) => o.id)).size).toBe(20);
    expect(new Set(offers.map((o) => o.code)).size).toBe(20);
  });

  it('offers read and notify when no scope is named, and removes duplicates', () => {
    expect(devices.createOffer([], URLS, 'phone').scopes).toEqual(['read', 'notify']);
    expect(devices.createOffer(['approve', 'read', 'approve'], URLS, 'phone').scopes).toEqual(['approve', 'read']);
  });

  it('never grants the desktop permission to a phone, nor the extension permission', () => {
    for (const bad of [['desktop'], ['read', 'desktop'], ['extension'], ['admin']] as unknown as Scope[][]) {
      const err = failure(() => devices.createOffer(bad, URLS, 'phone'));
      expect(err).toMatchObject({ status: 400, code: 'scope_not_allowed' });
      expectPlainText(err.message);
    }
    expect(base.db.get('SELECT COUNT(*) AS n FROM pairing_offers')).toEqual({ n: 0 });
  });

  it('gives an extension offer the extension permission only, whatever was asked', () => {
    expect(devices.createOffer(['read', 'prompt'], URLS, 'extension').scopes).toEqual(['extension']);
    expect(devices.createOffer(['desktop'], URLS, 'extension').scopes).toEqual(['extension']);
    expect(devices.createOffer([], URLS, 'extension').scopes).toEqual(['extension']);
  });

  it('needs at least one http(s) address the phone can try', () => {
    for (const bad of [[], ['ftp://x'], ['javascript:alert(1)'], ['pc.local'], [42]] as unknown as string[][]) {
      expect(failure(() => devices.createOffer(['read'], bad, 'phone')).status).toBe(400);
    }
    expect(failure(() => devices.createOffer(['read'], URLS, 'tablet' as never)).code).toBe('invalid_kind');
    expect(devices.createOffer(['read'], [URLS[0], URLS[0], URLS[1]], 'phone').urls).toEqual(URLS);
  });

  it('forgets offers that expired more than a day ago', () => {
    const old = devices.createOffer(['read'], URLS, 'phone');
    base.clock.advance(OFFER_TTL_MS + 60_000);
    const recent = devices.createOffer(['read'], URLS, 'phone');
    expect(base.db.get('SELECT COUNT(*) AS n FROM pairing_offers')).toEqual({ n: 2 });
    base.clock.advance(25 * 60 * 60_000);
    devices.createOffer(['read'], URLS, 'phone');
    const ids = base.db.all<{ id: string }>('SELECT id FROM pairing_offers').map((r) => r.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(recent.id);
  });
});

describe('pairing a phone', () => {
  it('turns a valid code into a device and a token, once', () => {
    const offer = devices.createOffer(['read', 'notify', 'prompt'], URLS, 'phone');
    const result = devices.redeem({ offerId: offer.id, code: offer.code, deviceName: '  Farmaan\'s   Pixel  ', platform: 'android' }, 'tailscale');

    expect(result.token).toMatch(/^msv_[A-Za-z0-9_-]{43}$/);
    expect(result.server).toEqual({ name: 'Farmaan-PC', apiVersion: API_VERSION });
    expect(result.device).toMatchObject({
      name: "Farmaan's Pixel", platform: 'android', scopes: ['read', 'notify', 'prompt'], trusted: false, pushRegistered: false,
      createdAt: base.clock.iso(), lastSeenAt: base.clock.iso(), lastSeenVia: 'tailscale', revokedAt: null,
    });
    expect(result.device.id).toMatch(/^dev_[0-9a-f]{16}$/);
    expect(devices.get(result.device.id)).toEqual(result.device);
    expect(devices.list()).toEqual([result.device]);
    expect(result).not.toHaveProperty('device.token');

    const events = base.eventsOf('device.upserted');
    expect(events).toHaveLength(1);
    expect(events[0].device).toEqual(result.device);
    expect(JSON.stringify(base.events)).not.toContain(result.token);
    expect(base.db.get<{ redeemed_at: string; redeemed_by: string }>('SELECT redeemed_at, redeemed_by FROM pairing_offers WHERE id = ?', [offer.id])).toEqual({ redeemed_at: base.clock.iso(), redeemed_by: result.device.id });
  });

  it('pairs an extension with an extension offer, and a phone only with a phone offer', () => {
    const ext = devices.createOffer([], URLS, 'extension');
    const paired = devices.redeem({ offerId: ext.id, code: ext.code, deviceName: 'Chrome', platform: 'extension' }, 'localhost');
    expect(paired.device).toMatchObject({ platform: 'extension', scopes: ['extension'] });
    expect(devices.authenticate(paired.token, 'localhost')).toMatchObject({ kind: 'extension', scopes: ['extension'], deviceId: paired.device.id });

    for (const platform of ['android', 'ios', 'other'] as const) {
      const offer = devices.createOffer(['read'], URLS, 'extension');
      const err = failure(() => devices.redeem({ offerId: offer.id, code: offer.code, deviceName: 'x', platform }, 'localhost'));
      expect(err).toMatchObject({ status: 400, code: 'platform_mismatch' });
      expectPlainText(err.message);
    }
    const phone = devices.createOffer(['read'], URLS, 'phone');
    expect(failure(() => devices.redeem({ offerId: phone.id, code: phone.code, deviceName: 'x', platform: 'extension' }, 'localhost')).code).toBe('platform_mismatch');
    // a refused platform does not use up the offer or count as a wrong code
    expect(base.db.get('SELECT failed_attempts, redeemed_at FROM pairing_offers WHERE id = ?', [phone.id])).toEqual({ failed_attempts: 0, redeemed_at: null });
    expect(devices.redeem({ offerId: phone.id, code: phone.code, deviceName: 'x', platform: 'ios' }, 'localhost').device.platform).toBe('ios');
    expect(failure(() => devices.redeem({ offerId: phone.id, code: 'x'.repeat(20), deviceName: 'x', platform: 'tablet' as never }, 'localhost')).code).toBe('invalid_platform');
  });

  it('needs a usable device name', () => {
    const offer = devices.createOffer(['read'], URLS, 'phone');
    for (const bad of ['', '   ', 'x'.repeat(81), 7 as never]) {
      expect(failure(() => devices.redeem({ offerId: offer.id, code: offer.code, deviceName: bad, platform: 'android' }, 'localhost')).status).toBe(400);
    }
    expect(devices.list()).toEqual([]);
    expect(devices.redeem({ offerId: offer.id, code: offer.code, deviceName: 'x'.repeat(80), platform: 'android' }, 'localhost').device.name).toHaveLength(80);
  });

  it('refuses to use a redeemed code again, even with the right code, and keeps the first device intact', () => {
    const first = pair();
    const err = failure(() => devices.redeem({ offerId: first.offer.id, code: first.offer.code, deviceName: 'Intruder', platform: 'android' }, 'tailscale'));
    expect(err).toMatchObject({ status: 410, code: 'offer_used' });
    expectPlainText(err.message);
    expect(devices.list()).toHaveLength(1);
    expect(devices.authenticate(first.token, 'tailscale')?.deviceId).toBe(first.device.id);
  });

  it('refuses an expired code from the 5-minute mark on', () => {
    const justInTime = devices.createOffer(['read'], URLS, 'phone');
    const tooLate = devices.createOffer(['read'], URLS, 'phone');
    base.clock.advance(OFFER_TTL_MS - 1);
    expect(devices.redeem({ offerId: justInTime.id, code: justInTime.code, deviceName: 'ok', platform: 'android' }, 'localhost').device.name).toBe('ok');
    base.clock.advance(1);
    const err = failure(() => devices.redeem({ offerId: tooLate.id, code: tooLate.code, deviceName: 'late', platform: 'android' }, 'localhost'));
    expect(err).toMatchObject({ status: 410, code: 'offer_expired' });
    expect(err.message).toMatch(/new one/);
    expectPlainText(err.message);
    expect(devices.list()).toHaveLength(1);
    // an expired offer is not burned further by guessing
    expect(base.db.get('SELECT failed_attempts FROM pairing_offers WHERE id = ?', [tooLate.id])).toEqual({ failed_attempts: 0 });
  });

  it('counts wrong codes and burns the offer on the fifth, even for the right code afterwards', () => {
    const offer = devices.createOffer(['read'], URLS, 'phone');
    const wrong = (): ReturnType<typeof failure> => failure(() => devices.redeem({ offerId: offer.id, code: 'definitely-not-the-code-abcdef', deviceName: 'x', platform: 'android' }, 'tailscale'));
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      const err = wrong();
      expect(err).toMatchObject({ status: 403, code: 'invalid_code', details: { attemptsLeft: MAX_CODE_ATTEMPTS - i } });
      expectPlainText(err.message);
    }
    const burned = wrong();
    expect(burned).toMatchObject({ status: 429, code: 'too_many_attempts' });
    expect(burned.message).toMatch(/new one/);
    expect(base.db.get('SELECT failed_attempts FROM pairing_offers WHERE id = ?', [offer.id])).toEqual({ failed_attempts: MAX_CODE_ATTEMPTS });

    const after = failure(() => devices.redeem({ offerId: offer.id, code: offer.code, deviceName: 'x', platform: 'android' }, 'tailscale'));
    expect(after).toMatchObject({ status: 410, code: 'offer_burned' });
    expect(devices.list()).toEqual([]);
    expect(base.eventsOf('device.upserted')).toHaveLength(0);
    expect(base.log.lines.filter((l) => /cancelled after too many/.test(l.msg))).toHaveLength(1);
  });

  it('does not burn the offer on a few mistakes: the right code still works after four wrong ones', () => {
    const offer = devices.createOffer(['read'], URLS, 'phone');
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) failure(() => devices.redeem({ offerId: offer.id, code: `wrong-${i}-wrong-wrong`, deviceName: 'x', platform: 'android' }, 'tailscale'));
    expect(devices.redeem({ offerId: offer.id, code: offer.code, deviceName: 'x', platform: 'android' }, 'tailscale').device.name).toBe('x');
  });

  it('treats a code of the wrong shape as a wrong code, never as an error of its own', () => {
    for (const bad of ['', 'a', '\u0000', 'é'.repeat(500), undefined as never, 12345 as never]) {
      const offer = devices.createOffer(['read'], URLS, 'phone');
      const err = failure(() => devices.redeem({ offerId: offer.id, code: bad, deviceName: 'x', platform: 'android' }, 'tailscale'));
      expect(err).toMatchObject({ status: 403, code: 'invalid_code' });
      expect(devices.redeem({ offerId: offer.id, code: offer.code, deviceName: 'x', platform: 'android' }, 'tailscale').device.name).toBe('x');
    }
  });

  it('knows nothing of an offer id it never made', () => {
    const err = failure(() => devices.redeem({ offerId: 'off_0000000000000000', code: 'whatever-whatever-1234', deviceName: 'x', platform: 'android' }, 'tailscale'));
    expect(err).toMatchObject({ status: 404, code: 'offer_not_found' });
    expectPlainText(err.message);
    expect(failure(() => devices.redeem({ offerId: undefined as never, code: 'x', deviceName: 'x', platform: 'android' }, 'tailscale')).status).toBe(404);
  });

  it('keeps one offer from being redeemed twice under any interleaving of the two claims', () => {
    const offer = devices.createOffer(['read'], URLS, 'phone');
    const results = [1, 2, 3].map((n) => {
      try { return devices.redeem({ offerId: offer.id, code: offer.code, deviceName: `phone ${n}`, platform: 'android' }, 'tailscale'); } catch (e) { return e; }
    });
    expect(results.filter((r) => !(r instanceof Error))).toHaveLength(1);
    expect(devices.list()).toHaveLength(1);
  });
});

describe('secrets are not stored', () => {
  it('keeps neither a device token, nor a pairing code, nor the desktop token anywhere in the database, events or log', () => {
    const { offer, token } = pair(['read', 'notify', 'prompt', 'approve']);
    devices.registerPush(devices.list()[0].id, 'fcm', 'fcm-registration-token-1234567890');
    const everything = wholeDatabase() + JSON.stringify(base.events) + JSON.stringify(base.log.lines);
    for (const secret of [token, token.slice(4), offer.code, devices.desktopToken, devices.desktopToken.slice(4)]) expect(everything).not.toContain(secret);
    // only the hash of the token is there
    expect(base.db.get<{ token_hash: string }>('SELECT token_hash FROM devices')?.token_hash).toBe(sha256Hex(token));
    expect(base.db.get<{ code_hash: string }>('SELECT code_hash FROM pairing_offers WHERE id = ?', [offer.id])?.code_hash).toBe(sha256Hex(offer.code));
  });

  it('returns the token exactly once: nothing the service returns later contains it', () => {
    const { token, device } = pair();
    const later = JSON.stringify([devices.get(device.id), devices.list(), devices.pushTargets(), devices.update(device.id, { name: 'Renamed' })]);
    expect(later).not.toContain(token);
  });
});

describe('authenticating a token', () => {
  it('gives a paired device exactly the scopes it was granted, and says how it arrived', () => {
    const { token, device } = pair(['read', 'prompt']);
    expect(devices.authenticate(token, 'tailscale')).toEqual<Principal>({ kind: 'device', deviceId: device.id, name: 'Pixel 9', scopes: ['read', 'prompt'], trusted: false, via: 'tailscale' });
    expect(devices.authenticate(token, 'localhost')?.via).toBe('localhost');
  });

  it('knows the desktop token: owner scope, no device', () => {
    expect(devices.desktopToken).toMatch(/^msd_[A-Za-z0-9_-]{43}$/);
    expect(devices.authenticate(devices.desktopToken, 'localhost')).toEqual<Principal>({ kind: 'desktop', deviceId: null, name: 'Desktop', scopes: ['desktop'], trusted: true, via: 'localhost' });
    expect(devices.authenticate(devices.desktopToken, 'unknown')?.kind).toBe('desktop');
  });

  it('generates a different desktop token for every process, and does not accept another process\'s token', () => {
    const other = createDevicesService({ base: makeBase(), machineName: 'x' });
    expect(other.desktopToken).not.toBe(devices.desktopToken);
    expect(devices.authenticate(other.desktopToken, 'localhost')).toBeNull();
    expect(devices.authenticate(`${devices.desktopToken.slice(0, -1)}${devices.desktopToken.endsWith('A') ? 'B' : 'A'}`, 'localhost')).toBeNull();
  });

  it('does not accept the desktop token when the request came through Tailscale', () => {
    expect(devices.authenticate(devices.desktopToken, 'tailscale')).toBeNull();
  });

  it('does not take a device token for the desktop, or the desktop token for a device', () => {
    const { token } = pair(['read', 'notify', 'prompt', 'approve']);
    expect(devices.authenticate(token, 'localhost')?.scopes).not.toContain('desktop');
    expect(devices.authenticate(token.replace(/^msv_/, 'msd_'), 'localhost')).toBeNull();
    expect(devices.authenticate(devices.desktopToken.replace(/^msd_/, 'msv_'), 'localhost')).toBeNull();
    // the stored hash of a device token is not a token
    expect(devices.authenticate(sha256Hex(token), 'localhost')).toBeNull();
    expect(devices.authenticate(`msv_${sha256Hex(token)}`, 'localhost')).toBeNull();
  });

  it('can never be given the desktop scope: not by an offer, not by an update, not even by a tampered row', () => {
    const { token, device } = pair(['read']);
    expect(failure(() => devices.update(device.id, { scopes: ['desktop'] })).code).toBe('scope_not_allowed');
    expect(failure(() => devices.update(device.id, { scopes: ['read', 'extension'] })).code).toBe('scope_not_allowed');
    base.db.run('UPDATE devices SET scopes_json = ? WHERE id = ?', [JSON.stringify(['desktop', 'read', 'bogus', 'read']), device.id]);
    expect(devices.authenticate(token, 'localhost')?.scopes).toEqual(['read']);
    expect(devices.get(device.id)?.scopes).toEqual(['read']);
  });

  it('answers null, never an error, for anything that is not a known token', () => {
    const { token } = pair();
    const junk = ['', ' ', 'x', 'msv_', 'msd_', 'msv_short', `${token} `, ` ${token}`, token.toUpperCase(), `${token}extra`, 'Bearer ' + token, 'a'.repeat(100_000), '\u0000\u0001', 'é'.repeat(300), undefined, null, 42, {}] as unknown as string[];
    for (const j of junk) expect(devices.authenticate(j, 'tailscale'), JSON.stringify(j)?.slice(0, 40)).toBeNull();
  });

  it('rejects a revoked device\'s token from then on', () => {
    const { token, device } = pair();
    expect(devices.authenticate(token, 'tailscale')).not.toBeNull();
    devices.revoke(device.id);
    expect(devices.authenticate(token, 'tailscale')).toBeNull();
    expect(devices.authenticate(token, 'localhost')).toBeNull();
    // a new pairing is a new device with a new token; the old one stays dead
    const again = pair();
    expect(again.token).not.toBe(token);
    expect(devices.authenticate(again.token, 'tailscale')).not.toBeNull();
    expect(devices.authenticate(token, 'tailscale')).toBeNull();
  });

  it('uses timingSafeEqual for every comparison of a secret', () => {
    const { offer, token } = pair();
    compare.calls = 0;
    devices.authenticate(devices.desktopToken, 'localhost');
    const afterDesktop = compare.calls;
    expect(afterDesktop).toBeGreaterThanOrEqual(1);
    devices.authenticate('msd_' + 'x'.repeat(43), 'localhost');
    devices.authenticate('msd_xxxxxxxx', 'localhost'); // shorter than a real token: hashing first keeps the lengths equal
    expect(compare.calls).toBeGreaterThanOrEqual(afterDesktop + 2);
    const afterWrongDesktop = compare.calls;
    devices.authenticate(token, 'localhost');
    expect(compare.calls).toBeGreaterThan(afterWrongDesktop);
    const afterDevice = compare.calls;
    const offer2 = devices.createOffer(['read'], URLS, 'phone');
    failure(() => devices.redeem({ offerId: offer2.id, code: 'wrong-code-of-another-length', deviceName: 'x', platform: 'android' }, 'localhost'));
    devices.redeem({ offerId: offer2.id, code: offer2.code, deviceName: 'x', platform: 'android' }, 'localhost');
    expect(compare.calls).toBeGreaterThanOrEqual(afterDevice + 2);
    expect(offer.code).toBeTruthy();
  });
});

describe('last seen', () => {
  it('is written at most every 30 seconds per device, silently', () => {
    const { token, device } = pair();
    const eventsAtStart = base.events.length;
    const seen = (): { at: string | null; via: string | null } => {
      const d = devices.get(device.id);
      return { at: d?.lastSeenAt ?? null, via: d?.lastSeenVia ?? null };
    };
    const t0 = base.clock.iso();
    expect(seen()).toEqual({ at: t0, via: 'tailscale' });

    base.clock.advance(LAST_SEEN_INTERVAL_MS - 1);
    devices.authenticate(token, 'localhost');
    expect(seen()).toEqual({ at: t0, via: 'tailscale' }); // too soon

    base.clock.advance(1);
    devices.authenticate(token, 'localhost');
    expect(seen()).toEqual({ at: base.clock.iso(), via: 'localhost' });
    const t1 = base.clock.iso();

    base.clock.advance(5_000);
    devices.authenticate(token, 'tailscale');
    base.clock.advance(5_000);
    devices.authenticate(token, 'tailscale');
    expect(seen()).toEqual({ at: t1, via: 'localhost' });

    base.clock.advance(LAST_SEEN_INTERVAL_MS);
    devices.authenticate(token, 'tailscale');
    expect(seen()).toEqual({ at: base.clock.iso(), via: 'tailscale' });
    expect(base.events).toHaveLength(eventsAtStart);
  });

  it('is tracked per device, and a failed authentication touches nothing', () => {
    const a = pair(['read'], 'A');
    const b = pair(['read'], 'B');
    base.clock.advance(60_000);
    devices.authenticate(a.token, 'localhost');
    devices.authenticate('msv_' + 'z'.repeat(43), 'localhost');
    expect(devices.get(a.device.id)?.lastSeenAt).toBe(base.clock.iso());
    expect(devices.get(b.device.id)?.lastSeenAt).not.toBe(base.clock.iso());
  });

  it('is not updated for a revoked device', () => {
    const { token, device } = pair();
    devices.revoke(device.id);
    const before = devices.get(device.id)?.lastSeenAt;
    base.clock.advance(120_000);
    devices.authenticate(token, 'localhost');
    expect(devices.get(device.id)?.lastSeenAt).toBe(before);
  });
});

describe('managing devices', () => {
  it('lists devices oldest first, revoked ones included', () => {
    const a = pair(['read'], 'A');
    base.clock.advance(1000);
    const b = pair(['read'], 'B');
    devices.revoke(a.device.id);
    expect(devices.list().map((d) => [d.name, d.revokedAt !== null])).toEqual([['A', true], ['B', false]]);
    expect(devices.get('dev_nope')).toBeNull();
    expect(b.device.createdAt > a.device.createdAt).toBe(true);
  });

  it('renames, trusts and re-scopes a device, telling clients each time', () => {
    const { device, token } = pair(['read']);
    const renamed = devices.update(device.id, { name: '  Work   phone ' });
    expect(renamed.name).toBe('Work phone');
    const trusted = devices.update(device.id, { trusted: true });
    expect(trusted.trusted).toBe(true);
    const scoped = devices.update(device.id, { scopes: ['read', 'prompt', 'approve'] });
    expect(scoped.scopes).toEqual(['read', 'prompt', 'approve']);
    expect(base.eventsOf('device.upserted').slice(-3).map((e) => e.device)).toEqual([renamed, trusted, scoped]);
    // the token already handed out follows the new scopes at once
    expect(devices.authenticate(token, 'tailscale')).toMatchObject({ scopes: ['read', 'prompt', 'approve'], trusted: true, name: 'Work phone' });
  });

  it('says nothing for an update that changes nothing', () => {
    const { device } = pair(['read']);
    const before = base.events.length;
    devices.update(device.id, { name: 'Pixel 9', trusted: false, scopes: ['read'] });
    devices.update(device.id, {});
    expect(base.events).toHaveLength(before);
  });

  it('refuses bad values and unknown devices', () => {
    const { device } = pair(['read']);
    expect(failure(() => devices.update(device.id, { name: ' ' })).status).toBe(400);
    expect(failure(() => devices.update(device.id, { trusted: 'yes' as never })).status).toBe(400);
    expect(failure(() => devices.update(device.id, { scopes: 'read' as never })).status).toBe(400);
    expect(failure(() => devices.update('dev_nope', { name: 'x' })).status).toBe(404);
    expect(failure(() => devices.revoke('dev_nope')).status).toBe(404);
    expect(failure(() => devices.registerPush('dev_nope', 'fcm', 'token-token-token')).status).toBe(404);
  });

  it('keeps the browser extension at the extension permission', () => {
    const offer = devices.createOffer([], URLS, 'extension');
    const { device } = devices.redeem({ offerId: offer.id, code: offer.code, deviceName: 'Chrome', platform: 'extension' }, 'localhost');
    expect(devices.update(device.id, { scopes: ['extension'] })).toEqual(device);
    for (const bad of [['read'], ['extension', 'read'], []] as Scope[][]) expect(failure(() => devices.update(device.id, { scopes: bad })).code).toBe('scope_not_allowed');
  });

  it('revokes: marks the time, drops the push token, tells clients, and is a no-op the second time', () => {
    const { device } = pair(['read', 'notify']);
    devices.registerPush(device.id, 'fcm', 'fcm-registration-token-1234567890');
    expect(devices.pushTargets()).toHaveLength(1);
    base.clock.advance(5000);
    devices.revoke(device.id);

    const revoked = devices.get(device.id);
    expect(revoked).toMatchObject({ revokedAt: base.clock.iso(), pushRegistered: false });
    expect(base.eventsOf('device.upserted').at(-1)?.device).toEqual(revoked);
    expect(base.db.get('SELECT push_provider, push_token FROM devices WHERE id = ?', [device.id])).toEqual({ push_provider: null, push_token: null });
    expect(devices.pushTargets()).toEqual([]);

    const events = base.events.length;
    base.clock.advance(5000);
    devices.revoke(device.id);
    expect(devices.get(device.id)?.revokedAt).toBe(revoked?.revokedAt);
    expect(base.events).toHaveLength(events);
  });

  it('does not let a revoked device be changed, trusted or registered for notifications', () => {
    const { device } = pair(['read', 'notify']);
    devices.revoke(device.id);
    expect(failure(() => devices.update(device.id, { name: 'x' }))).toMatchObject({ status: 409, code: 'device_revoked' });
    expect(failure(() => devices.registerPush(device.id, 'fcm', 'fcm-registration-token-1234567890'))).toMatchObject({ status: 409, code: 'device_revoked' });
  });
});

describe('push registration', () => {
  it('registers a token, shows it as registered, and offers it as a target only with the notify scope', () => {
    const withNotify = pair(['read', 'notify'], 'Notified');
    const withoutNotify = pair(['read'], 'Quiet');
    const never = pair(['read', 'notify'], 'No token');
    devices.registerPush(withNotify.device.id, 'fcm', 'token-for-the-notified-phone');
    devices.registerPush(withoutNotify.device.id, 'fcm', 'token-for-the-quiet-phone');
    expect(devices.get(withNotify.device.id)?.pushRegistered).toBe(true);
    expect(devices.get(never.device.id)?.pushRegistered).toBe(false);
    expect(base.eventsOf('device.upserted').at(-1)?.device.id).toBe(withoutNotify.device.id);
    expect(devices.pushTargets()).toEqual([{ deviceId: withNotify.device.id, provider: 'fcm', token: 'token-for-the-notified-phone', projectIds: 'all' }]);
    // removing the notify scope takes the device out of the targets without losing its token
    devices.update(withNotify.device.id, { scopes: ['read'] });
    expect(devices.pushTargets()).toEqual([]);
    devices.update(withNotify.device.id, { scopes: ['read', 'notify'] });
    expect(devices.pushTargets()).toHaveLength(1);
  });

  it('clears a token on request, once', () => {
    const { device } = pair(['notify']);
    devices.registerPush(device.id, 'fcm', 'token-for-the-phone-123');
    devices.clearPushToken(device.id);
    expect(devices.get(device.id)?.pushRegistered).toBe(false);
    expect(devices.pushTargets()).toEqual([]);
    const events = base.events.length;
    devices.clearPushToken(device.id);
    expect(base.events).toHaveLength(events);
    expect(failure(() => devices.clearPushToken('dev_nope')).status).toBe(404);
  });

  it('moves a token that a new pairing of the same phone brings, so the phone is not notified twice', () => {
    const oldPairing = pair(['notify'], 'Pixel (old)');
    devices.registerPush(oldPairing.device.id, 'fcm', 'one-app-install-one-token');
    const newPairing = pair(['notify'], 'Pixel (new)');
    devices.registerPush(newPairing.device.id, 'fcm', 'one-app-install-one-token');
    expect(devices.pushTargets().map((t) => t.deviceId)).toEqual([newPairing.device.id]);
    expect(devices.get(oldPairing.device.id)?.pushRegistered).toBe(false);
    const announced = base.eventsOf('device.upserted').slice(-2).map((e) => e.device.id);
    expect(announced).toEqual([oldPairing.device.id, newPairing.device.id]);
  });

  it('refuses providers and tokens it cannot use', () => {
    const { device } = pair(['notify']);
    expect(failure(() => devices.registerPush(device.id, 'apns' as never, 'token-token-token-token')).code).toBe('invalid_provider');
    for (const bad of ['', 'short', 'x'.repeat(4097), 42 as never]) expect(failure(() => devices.registerPush(device.id, 'fcm', bad)).code).toBe('invalid_push_token');
    expect(devices.pushTargets()).toEqual([]);
  });
});

describe('actorOf', () => {
  it('names who acted in the shapes the audit trail uses', () => {
    const { token, device } = pair(['read']);
    const desktop = devices.authenticate(devices.desktopToken, 'localhost') as Principal;
    const phone = devices.authenticate(token, 'tailscale') as Principal;
    expect(devices.actorOf(desktop)).toEqual({ kind: 'desktop' });
    expect(devices.actorOf(phone)).toEqual({ kind: 'device', deviceId: device.id, name: 'Pixel 9' });
    expect(devices.actorOf({ kind: 'device', deviceId: null, name: 'anonymous', scopes: [], trusted: false, via: 'unknown' })).toEqual({ kind: 'system' });
    const ext = devices.createOffer([], URLS, 'extension');
    const extDevice = devices.redeem({ offerId: ext.id, code: ext.code, deviceName: 'Chrome', platform: 'extension' }, 'localhost');
    expect(devices.actorOf(devices.authenticate(extDevice.token, 'localhost') as Principal)).toEqual({ kind: 'device', deviceId: extDevice.device.id, name: 'Chrome' });
  });
});
