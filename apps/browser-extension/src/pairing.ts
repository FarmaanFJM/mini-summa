// Pairing with Mini-Summa: turn what the person typed or pasted into one redeem request, and say plainly what went wrong.
// POST /api/v1/pairing/redeem is a public route: it carries the one-time code in the body and needs no bearer token.
import { decodePairingPayload } from '@minisumma/shared';
import { normalizeCoreUrl, redeemUrlOf } from './core-address.ts';

export interface PairingInput {
  /** The "Core address" field. */
  coreUrl: string;
  /** The pasted minisumma://pair?... link, or empty. */
  link: string;
  offerId: string;
  code: string;
  deviceName: string;
}

export interface PairingRequest { coreUrl: string; offerId: string; code: string; deviceName: string }
export type PairingFormResult = ({ ok: true } & PairingRequest) | { ok: false; message: string };

const OFFER_ID_MAX = 100;
const CODE_MIN = 8;
const CODE_MAX = 200;
const DEVICE_NAME_MAX = 80;

/** Check the fields against the same limits the core enforces, so mistakes are explained before any request is made. */
export function resolvePairingForm(input: PairingInput): PairingFormResult {
  let offerId = input.offerId.trim();
  let code = input.code.trim();
  let addressText = input.coreUrl;
  const link = input.link.trim();
  if (link !== '') {
    const payload = decodePairingPayload(link);
    if (!payload) return { ok: false, message: 'That is not a Mini-Summa pairing link. Copy the whole link that starts with minisumma://pair.' };
    offerId = payload.offerId;
    code = payload.code;
    // The extension can only reach this computer, so the first loopback address in the link is the one that counts.
    const local = payload.urls.map(normalizeCoreUrl).find((r) => r.ok);
    if (local?.ok) addressText = local.url;
  }
  const address = normalizeCoreUrl(addressText);
  if (!address.ok) return { ok: false, message: address.message };
  if (offerId === '') return { ok: false, message: 'Enter the offer id shown in Mini-Summa, or paste the pairing link.' };
  if (offerId.length > OFFER_ID_MAX) return { ok: false, message: 'The offer id is too long. Copy it again from Mini-Summa.' };
  if (code.length < CODE_MIN) return { ok: false, message: 'The code is too short. Copy the whole code from Mini-Summa.' };
  if (code.length > CODE_MAX) return { ok: false, message: 'The code is too long. Copy it again from Mini-Summa.' };
  const deviceName = input.deviceName.trim().slice(0, DEVICE_NAME_MAX) || 'Browser extension';
  return { ok: true, coreUrl: address.url, offerId, code, deviceName };
}

export type RedeemResult =
  | { ok: true; coreUrl: string; token: string; deviceId: string | null; deviceName: string; serverName: string | null }
  | { ok: false; message: string };

export interface RedeemDeps { fetch: typeof fetch; timeoutMs?: number }

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

/** Never put the code or the token in a message, a log line or an error: only the status and the server's own sentence. */
export async function redeemPairing(req: PairingRequest, deps: RedeemDeps): Promise<RedeemResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
  let res: Response;
  let body: Record<string, unknown> | null = null;
  try {
    res = await deps.fetch(redeemUrlOf(req.coreUrl), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ offerId: req.offerId, code: req.code, deviceName: req.deviceName, platform: 'extension' }),
      signal: controller.signal,
    });
    try { body = asRecord(await res.json()); } catch { body = null; }
    if (controller.signal.aborted) throw Object.assign(new Error('timeout'), { name: 'AbortError' });
  } catch (err) {
    const aborted = controller.signal.aborted || (err as { name?: string } | null)?.name === 'AbortError';
    return { ok: false, message: aborted ? 'Mini-Summa did not answer in time. Is the app running?' : `Could not reach Mini-Summa at ${req.coreUrl}. Is the app running?` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const serverMessage = asRecord(body?.error)?.message;
    if (typeof serverMessage === 'string' && serverMessage.trim() !== '') return { ok: false, message: `Mini-Summa refused the pairing: ${serverMessage.trim().slice(0, 300)}` };
    if ([400, 401, 403, 404, 410].includes(res.status)) return { ok: false, message: 'The pairing code was not accepted. It may have expired or been used already. Create a new one in Mini-Summa.' };
    return { ok: false, message: `Mini-Summa answered with status ${res.status}. Try again, or restart Mini-Summa.` };
  }

  const token = body?.token;
  const device = asRecord(body?.device);
  if (typeof token !== 'string' || token === '' || !device) {
    return { ok: false, message: 'Mini-Summa sent an answer this extension does not understand. Update Mini-Summa or this extension.' };
  }
  const server = asRecord(body?.server);
  return {
    ok: true,
    coreUrl: req.coreUrl,
    token,
    deviceId: typeof device.id === 'string' ? device.id : null,
    deviceName: typeof device.name === 'string' && device.name !== '' ? device.name : req.deviceName,
    serverName: typeof server?.name === 'string' ? server.name : null,
  };
}

export interface NavigatorInfo {
  userAgent?: string;
  userAgentData?: { brands?: { brand: string }[]; platform?: string };
}

/** "Chrome on Windows": what the person will recognise in Mini-Summa's device list. */
export function deviceNameFromNavigator(nav: NavigatorInfo): string {
  const brands = nav.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const ua = nav.userAgent ?? '';
  const named: [RegExp, string][] = [[/microsoft edge/i, 'Edge'], [/google chrome/i, 'Chrome'], [/brave/i, 'Brave'], [/opera/i, 'Opera'], [/vivaldi/i, 'Vivaldi']];
  let browser = named.find(([re]) => brands.some((b) => re.test(b)))?.[1];
  if (!browser) {
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Vivaldi\//.test(ua)) browser = 'Vivaldi';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else browser = brands.some((b) => /chromium/i.test(b)) ? 'Chromium' : 'Browser';
  }
  const platformHint = nav.userAgentData?.platform ?? '';
  let platform = '';
  if (/windows/i.test(platformHint) || /Windows/.test(ua)) platform = 'Windows';
  else if (/mac/i.test(platformHint) || /Mac OS X/.test(ua)) platform = 'macOS';
  else if (/chrome ?os/i.test(platformHint) || /CrOS/.test(ua)) platform = 'ChromeOS';
  else if (/android/i.test(platformHint) || /Android/.test(ua)) platform = 'Android';
  else if (/linux/i.test(platformHint) || /Linux/.test(ua)) platform = 'Linux';
  return (platform ? `${browser} on ${platform}` : browser).slice(0, DEVICE_NAME_MAX);
}
