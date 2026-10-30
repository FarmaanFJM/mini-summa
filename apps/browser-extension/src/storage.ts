// What the extension remembers, in chrome.storage.local: the core address, the bearer token from pairing, and a little
// display information. The token is only read by the background worker; pages use PublicState, which has no token.
import { DEFAULT_CORE_URL, normalizeCoreUrl } from './core-address.ts';

/** The subset of chrome.storage.local that is used, so tests can pass an in-memory area. */
export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface StoredState {
  coreUrl: string;
  token: string | null;
  deviceId: string | null;
  deviceName: string | null;
  pairedAt: number | null;
  /** Set when Mini-Summa unpaired this browser (the server closed the socket with code 4003). */
  revokedAt: number | null;
}

export type PublicState = Omit<StoredState, 'token'> & { paired: boolean };

const KEYS = ['coreUrl', 'token', 'deviceId', 'deviceName', 'pairedAt', 'revokedAt'] as const;
/** Storage keys whose change the background worker must react to. */
export const WATCHED_KEYS: readonly string[] = ['coreUrl', 'token', 'revokedAt'];

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function loadState(area: StorageAreaLike): Promise<StoredState> {
  const raw = await area.get([...KEYS]);
  const storedUrl = str(raw.coreUrl);
  const checked = storedUrl ? normalizeCoreUrl(storedUrl) : null;
  return {
    coreUrl: checked?.ok ? checked.url : DEFAULT_CORE_URL,
    token: str(raw.token),
    deviceId: str(raw.deviceId),
    deviceName: str(raw.deviceName),
    pairedAt: num(raw.pairedAt),
    revokedAt: num(raw.revokedAt),
  };
}

export const toPublicState = ({ token, ...rest }: StoredState): PublicState => ({ ...rest, paired: token !== null });

export interface PairingRecord { coreUrl: string; token: string; deviceId: string | null; deviceName: string; pairedAt: number }

// Each of these is a single write. chrome.storage.onChanged fires per write and the background worker reloads on it, so
// a two step update would let it observe a half-finished state (for example "revoked" with the old token still stored).
export async function savePairing(area: StorageAreaLike, p: PairingRecord): Promise<void> {
  await area.set({ coreUrl: p.coreUrl, token: p.token, deviceId: p.deviceId, deviceName: p.deviceName, pairedAt: p.pairedAt, revokedAt: null });
}

export const saveCoreUrl = (area: StorageAreaLike, coreUrl: string): Promise<void> => area.set({ coreUrl });

/** The person pressed Unpair: forget everything about the pairing but keep the address. */
export const clearPairing = (area: StorageAreaLike): Promise<void> =>
  area.remove(['token', 'deviceId', 'deviceName', 'pairedAt', 'revokedAt']);

/** Mini-Summa revoked this device: drop the token and remember why, so the options page can say so. */
export const markRevoked = (area: StorageAreaLike, at: number): Promise<void> =>
  area.set({ revokedAt: at, token: null, deviceId: null, deviceName: null, pairedAt: null });
