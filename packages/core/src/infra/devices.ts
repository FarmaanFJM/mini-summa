// DevicesService: who may call the core. Pairing, bearer tokens, scopes, push registration.
//
// Tokens
//   desktop  `msd_` + 32 random bytes, generated per process and kept only in memory. Compared by SHA-256 with
//            timingSafeEqual, and refused when the request arrived through Tailscale: the desktop shell talks to the
//            core on this computer, so a desktop token that shows up over the tailnet is a leaked one.
//   device   `msv_` + 32 random bytes, handed out once by redeem(). Only its SHA-256 hex is stored.
// Pairing offers
//   A 24-byte one-time code, stored as a hash, valid 5 minutes, single use. Each wrong code counts; the fifth burns the
//   offer. Phone offers can grant read, notify, prompt and approve (never desktop); an extension offer grants only
//   `extension`. The offer kind is not a column: it is whether the offer's scopes are ['extension'].
// Not emitted: touching last_seen_at (at most every 30 s per device) is silent, so a phone that polls does not flood
// the event buffer. Everything else about a device (pair, update, revoke, push token) emits device.upserted.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { API_VERSION, encodePairingPayload } from '@minisumma/shared';
import type { ActorRef, Device, DevicePlatform, PairingOffer, PairingRedeemResult, Scope } from '@minisumma/shared';
import { bool, fromJson, newId, toJson } from '@minisumma/storage';
import type { SqlValue } from '@minisumma/storage';
import type { CoreBase, DevicesService, Principal } from '../contracts.ts';
import { CoreError, badRequest, conflict } from '../errors.ts';

export interface DevicesDeps {
  base: Pick<CoreBase, 'db' | 'bus' | 'clock' | 'log'>;
  /** Shown on the phone before the user confirms pairing. Default: this computer's host name. */
  machineName?: string;
}

export const OFFER_TTL_MS = 5 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const LAST_SEEN_INTERVAL_MS = 30_000;

const PHONE_SCOPES: readonly Scope[] = ['read', 'notify', 'prompt', 'approve'];
/** What an offer grants when the caller names no scopes: enough for the companion to show status and receive alerts. */
const DEFAULT_PHONE_SCOPES: Scope[] = ['read', 'notify'];
const KNOWN_SCOPES: readonly Scope[] = ['desktop', 'read', 'notify', 'prompt', 'approve', 'extension'];
const OFFER_RETENTION_MS = 24 * 60 * 60_000;

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  scopes_json: string;
  trusted: number;
  token_hash: string;
  push_provider: string | null;
  push_token: string | null;
  created_at: string;
  last_seen_at: string | null;
  last_seen_via: string | null;
  revoked_at: string | null;
}

interface OfferRow {
  id: string;
  code_hash: string;
  scopes_json: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  failed_attempts: number;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
/** Both sides are SHA-256 digests (32 bytes), so timingSafeEqual never sees different lengths unless a row is corrupt. */
const sameDigest = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
const newToken = (prefix: 'msd_' | 'msv_'): string => `${prefix}${randomBytes(32).toString('base64url')}`;

/** Stored scopes as the core trusts them: known names only, and a device never holds `desktop`, whatever the row says. */
function parseScopes(json: string): Scope[] {
  const raw = fromJson<unknown>(json, []);
  if (!Array.isArray(raw)) return [];
  const out: Scope[] = [];
  for (const s of raw) if (KNOWN_SCOPES.includes(s as Scope) && s !== 'desktop' && !out.includes(s as Scope)) out.push(s as Scope);
  return out;
}

function cleanDeviceName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (s === '') throw badRequest('A device needs a name. Enter a name such as "My phone".', { field: 'deviceName' }, 'invalid_name');
  if (s.length > 80) throw badRequest('The device name is too long (at most 80 characters). Shorten it and try again.', { field: 'deviceName' }, 'invalid_name');
  return s;
}

function phoneScopes(input: unknown, what: string): Scope[] {
  if (!Array.isArray(input)) throw badRequest(`${what} must be a list of permissions. Choose from read, notify, prompt and approve.`, undefined, 'invalid_scopes');
  const out: Scope[] = [];
  for (const s of input) {
    if (!PHONE_SCOPES.includes(s as Scope)) {
      throw badRequest(
        `The permission "${String(s)}" cannot be given to a phone. Choose from read, notify, prompt and approve; the desktop permission is never granted to a device.`,
        { scope: s },
        'scope_not_allowed',
      );
    }
    if (!out.includes(s as Scope)) out.push(s as Scope);
  }
  return out;
}

function cleanUrls(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw badRequest('A pairing code needs at least one address the phone can reach this PC on. Turn on remote access or check that the local server is running, then try again.', undefined, 'no_urls');
  }
  const out: string[] = [];
  for (const u of input) {
    if (typeof u !== 'string' || !/^https?:\/\/\S+$/i.test(u)) throw badRequest('Pairing addresses must start with http:// or https://.', undefined, 'invalid_url');
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, 8);
}

export function createDevicesService(deps: DevicesDeps): DevicesService {
  const { db, bus, clock, log } = deps.base;
  const machineName = (deps.machineName ?? os.hostname()).trim() || 'Mini-Summa';
  const desktopToken = newToken('msd_');
  const desktopDigest = sha256(desktopToken);

  const nowMs = (): number => clock.now().getTime();
  const nowIso = (): string => clock.now().toISOString();

  const deviceRow = (id: string) => db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
  const requireRow = (id: string): DeviceRow => deviceRow(id) ?? (() => { throw new CoreError(404, 'not_found', 'That device was not found. It may have been removed, so reload the device list.'); })();

  const deviceOf = (r: DeviceRow): Device => ({
    id: r.id,
    name: r.name,
    platform: r.platform as DevicePlatform,
    scopes: parseScopes(r.scopes_json),
    trusted: bool(r.trusted),
    pushRegistered: r.push_token !== null && r.push_token !== '',
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    lastSeenVia: (r.last_seen_via as Device['lastSeenVia']) ?? null,
    revokedAt: r.revoked_at,
  });

  const emitDevice = (id: string): void => {
    const row = deviceRow(id);
    if (row) bus.emit({ type: 'device.upserted', device: deviceOf(row) });
  };

  function principalOf(row: DeviceRow, via: Principal['via']): Principal {
    return {
      kind: row.platform === 'extension' ? 'extension' : 'device',
      deviceId: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes_json),
      trusted: bool(row.trusted),
      via,
    };
  }

  /** Records that the device was seen, but not more often than every 30 s. Silent: no event. */
  function touch(row: DeviceRow, via: Principal['via']): void {
    const last = row.last_seen_at ? Date.parse(row.last_seen_at) : Number.NaN;
    const now = nowMs();
    if (Number.isFinite(last) && Math.abs(now - last) < LAST_SEEN_INTERVAL_MS) return;
    db.run('UPDATE devices SET last_seen_at = ?, last_seen_via = ? WHERE id = ?', [nowIso(), via, row.id]);
  }

  const offerIsExtension = (scopes: Scope[]): boolean => scopes.length === 1 && scopes[0] === 'extension';

  return {
    desktopToken,

    authenticate(token, via) {
      if (typeof token !== 'string' || token.length < 8 || token.length > 512) return null;
      const digest = sha256(token);
      if (token.startsWith('msd_')) {
        if (via === 'tailscale' || !sameDigest(digest, desktopDigest)) return null;
        return { kind: 'desktop', deviceId: null, name: 'Desktop', scopes: ['desktop'], trusted: true, via };
      }
      if (!token.startsWith('msv_')) return null;
      const row = db.get<DeviceRow>('SELECT * FROM devices WHERE token_hash = ?', [digest.toString('hex')]);
      if (!row || !sameDigest(Buffer.from(row.token_hash, 'hex'), digest) || row.revoked_at !== null) return null;
      touch(row, via);
      return principalOf(row, via);
    },

    createOffer(scopesIn, urlsIn, kind): PairingOffer {
      if (kind !== 'phone' && kind !== 'extension') throw badRequest('The pairing kind must be "phone" or "extension".', undefined, 'invalid_kind');
      let scopes: Scope[];
      if (kind === 'extension') scopes = ['extension'];
      else {
        scopes = phoneScopes(scopesIn ?? [], 'The permissions for a phone');
        if (scopes.length === 0) scopes = [...DEFAULT_PHONE_SCOPES];
      }
      const urls = cleanUrls(urlsIn);
      const code = randomBytes(24).toString('base64url');
      const id = newId('off');
      const createdAt = nowIso();
      const expiresAt = new Date(nowMs() + OFFER_TTL_MS).toISOString();

      db.tx(() => {
        db.run('DELETE FROM pairing_offers WHERE expires_at < ?', [new Date(nowMs() - OFFER_RETENTION_MS).toISOString()]);
        db.run(
          'INSERT INTO pairing_offers (id, code_hash, scopes_json, created_at, expires_at, redeemed_at, redeemed_by, failed_attempts) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)',
          [id, sha256(code).toString('hex'), toJson(scopes), createdAt, expiresAt],
        );
      });

      return { id, code, expiresAt, scopes, urls, qrPayload: encodePairingPayload({ version: 1, code, offerId: id, urls, name: machineName }) };
    },

    redeem(req, via): PairingRedeemResult {
      const deviceName = cleanDeviceName(req.deviceName);
      if (!['android', 'ios', 'extension', 'other'].includes(req.platform)) {
        throw badRequest('The platform must be android, ios, extension or other.', { field: 'platform' }, 'invalid_platform');
      }
      const offer = db.get<OfferRow>('SELECT * FROM pairing_offers WHERE id = ?', [String(req.offerId ?? '')]);
      if (!offer) throw new CoreError(404, 'offer_not_found', 'This pairing code is not known to this PC. Create a new one on the PC and scan it again.');
      if (offer.failed_attempts >= MAX_CODE_ATTEMPTS) {
        throw new CoreError(410, 'offer_burned', 'This pairing code was cancelled after too many wrong attempts. Create a new one on the PC and scan it again.');
      }
      if (offer.redeemed_at !== null) throw new CoreError(410, 'offer_used', 'This pairing code was already used. Create a new one on the PC to pair another device.');
      if (nowMs() >= Date.parse(offer.expires_at)) throw new CoreError(410, 'offer_expired', 'This pairing code has expired (codes last 5 minutes). Create a new one on the PC and scan it again.');

      const codeMatches = sameDigest(sha256(typeof req.code === 'string' ? req.code : ''), Buffer.from(offer.code_hash, 'hex'));
      if (!codeMatches) {
        // The failure is counted even though the request fails, so this runs in its own small transaction.
        const attempts = db.tx(() => {
          db.run('UPDATE pairing_offers SET failed_attempts = failed_attempts + 1 WHERE id = ?', [offer.id]);
          return db.get<{ failed_attempts: number }>('SELECT failed_attempts FROM pairing_offers WHERE id = ?', [offer.id])?.failed_attempts ?? MAX_CODE_ATTEMPTS;
        });
        if (attempts >= MAX_CODE_ATTEMPTS) {
          log.warn('A pairing offer was cancelled after too many wrong codes.', { offerId: offer.id });
          throw new CoreError(429, 'too_many_attempts', 'Too many wrong codes. This pairing code is cancelled. Create a new one on the PC and scan it again.');
        }
        throw new CoreError(403, 'invalid_code', 'That pairing code is not correct. Scan the QR code on the PC again, or create a new one.', { attemptsLeft: MAX_CODE_ATTEMPTS - attempts });
      }

      const scopes = parseScopes(offer.scopes_json);
      const extensionOffer = offerIsExtension(scopes);
      if (req.platform === 'extension' && !extensionOffer) {
        throw badRequest('This pairing code is for a phone, not for the browser extension. Create an extension pairing code on the PC.', undefined, 'platform_mismatch');
      }
      if (req.platform !== 'extension' && extensionOffer) {
        throw badRequest('This pairing code is for the browser extension. Create a phone pairing code on the PC.', undefined, 'platform_mismatch');
      }

      const token = newToken('msv_');
      const id = newId('dev');
      const at = nowIso();
      db.tx(() => {
        const claimed = db.run('UPDATE pairing_offers SET redeemed_at = ?, redeemed_by = ? WHERE id = ? AND redeemed_at IS NULL', [at, id, offer.id]);
        if (claimed.changes !== 1) throw new CoreError(410, 'offer_used', 'This pairing code was already used. Create a new one on the PC to pair another device.');
        db.run(
          `INSERT INTO devices (id, name, platform, scopes_json, trusted, token_hash, push_provider, push_token, created_at, last_seen_at, last_seen_via, revoked_at)
           VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, NULL)`,
          [id, deviceName, req.platform, toJson(scopes), sha256(token).toString('hex'), at, at, via],
        );
      });

      const device = deviceOf(requireRow(id));
      bus.emit({ type: 'device.upserted', device });
      return { device, token, server: { name: machineName, apiVersion: API_VERSION } };
    },

    list: () => db.all<DeviceRow>('SELECT * FROM devices ORDER BY created_at, id').map(deviceOf),

    get: (id) => { const row = deviceRow(id); return row ? deviceOf(row) : null; },

    update(id, patch) {
      const row = requireRow(id);
      if (row.revoked_at !== null) throw conflict('This device was revoked, so it cannot be changed. Pair it again to use it.', 'device_revoked');
      const sets: string[] = [];
      const params: SqlValue[] = [];
      const set = (col: string, v: SqlValue): void => { sets.push(`${col} = ?`); params.push(v); };

      if (patch.name !== undefined) {
        const name = cleanDeviceName(patch.name);
        if (name !== row.name) set('name', name);
      }
      if (patch.trusted !== undefined) {
        if (typeof patch.trusted !== 'boolean') throw badRequest('"trusted" must be true or false.', { field: 'trusted' }, 'invalid_trusted');
        if (patch.trusted !== bool(row.trusted)) set('trusted', patch.trusted ? 1 : 0);
      }
      if (patch.scopes !== undefined) {
        let scopes: Scope[];
        if (row.platform === 'extension') {
          if (!Array.isArray(patch.scopes) || patch.scopes.length !== 1 || patch.scopes[0] !== 'extension') {
            throw badRequest('The browser extension always has the "extension" permission and nothing else. Leave its permissions as they are.', undefined, 'scope_not_allowed');
          }
          scopes = ['extension'];
        } else scopes = phoneScopes(patch.scopes, 'The permissions');
        if (toJson(scopes) !== toJson(parseScopes(row.scopes_json))) set('scopes_json', toJson(scopes));
      }
      if (sets.length === 0) return deviceOf(row);

      db.run(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      emitDevice(id);
      return deviceOf(requireRow(id));
    },

    revoke(id) {
      const row = requireRow(id);
      if (row.revoked_at !== null) return;
      // Keep token_hash: a revoked token must keep answering "no" rather than look unknown or collide with a new one.
      db.run('UPDATE devices SET revoked_at = ?, push_provider = NULL, push_token = NULL WHERE id = ?', [nowIso(), id]);
      emitDevice(id);
    },

    registerPush(deviceId, provider, token) {
      const row = requireRow(deviceId);
      if (row.revoked_at !== null) throw conflict('This device was revoked, so it cannot receive notifications. Pair it again first.', 'device_revoked');
      if (provider !== 'fcm') throw badRequest('Only Firebase Cloud Messaging ("fcm") push tokens are supported.', undefined, 'invalid_provider');
      if (typeof token !== 'string' || token.length < 10 || token.length > 4096) throw badRequest('The push token looks wrong. Open the app and let it register again.', undefined, 'invalid_push_token');
      // One app install has one token. If an older pairing of the same phone still holds it, move it, or the phone
      // would be notified twice.
      const others = db.all<{ id: string }>('SELECT id FROM devices WHERE push_token = ? AND id <> ?', [token, deviceId]);
      db.tx(() => {
        db.run('UPDATE devices SET push_provider = NULL, push_token = NULL WHERE push_token = ? AND id <> ?', [token, deviceId]);
        db.run('UPDATE devices SET push_provider = ?, push_token = ? WHERE id = ?', [provider, token, deviceId]);
      });
      for (const o of others) emitDevice(o.id);
      emitDevice(deviceId);
    },

    clearPushToken(deviceId) {
      const row = requireRow(deviceId);
      if (row.push_token === null && row.push_provider === null) return;
      db.run('UPDATE devices SET push_provider = NULL, push_token = NULL WHERE id = ?', [deviceId]);
      emitDevice(deviceId);
    },

    pushTargets() {
      return db
        .all<DeviceRow>("SELECT * FROM devices WHERE revoked_at IS NULL AND push_provider = 'fcm' AND push_token IS NOT NULL AND push_token <> '' ORDER BY created_at, id")
        .filter((r) => parseScopes(r.scopes_json).includes('notify'))
        .map((r) => ({ deviceId: r.id, provider: 'fcm' as const, token: r.push_token as string, projectIds: 'all' as const }));
    },

    actorOf(principal): ActorRef {
      if (principal.kind === 'desktop') return { kind: 'desktop' };
      if (principal.deviceId !== null) return { kind: 'device', deviceId: principal.deviceId, name: principal.name };
      return { kind: 'system' };
    },
  };
}
