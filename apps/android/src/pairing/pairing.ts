// Pairing: turn a scanned or typed offer into stored credentials.
//   1. decode the payload (QR text, or address + offer id + code typed by hand)
//   2. try each address in the order the desktop listed them, GET /api/v1/health with a short timeout
//   3. redeem the one-time code at the first address that answers as Mini-Summa
// Every failure ends in a sentence that says what is wrong and what to do.
import { ApiError, MiniSummaClient, decodePairingPayload } from '@minisumma/shared';
import type { Device, PairingPayload } from '@minisumma/shared';
import type { Credentials } from '../connection/credentials.ts';
import { classifyNetworkError, UNREACHABLE_HINT, UNREACHABLE_TEXT } from '../lib/errors.ts';

export type PairingErrorKind =
  | 'invalid_input' | 'unreachable' | 'tls' | 'cleartext' | 'not_mini_summa' | 'desktop_error'
  | 'code_expired' | 'code_used' | 'code_invalid' | 'too_many_attempts' | 'refused';

export interface UrlAttempt {
  url: string;
  outcome: 'ok' | 'no_answer' | 'timeout' | 'tls' | 'cleartext' | 'not_mini_summa' | 'http_error';
  /** HTTP status when the address answered with an error. */
  status?: number;
}

export class PairingError extends Error {
  constructor(readonly kind: PairingErrorKind, message: string, readonly attempts: UrlAttempt[] = []) {
    super(message);
    this.name = 'PairingError';
  }
}

const MESSAGES: Record<PairingErrorKind, string> = {
  invalid_input: 'Check the address, offer ID and pairing code, then try again.',
  unreachable: `Cannot reach your PC. ${UNREACHABLE_TEXT} ${UNREACHABLE_HINT}`,
  tls: 'The secure connection to your PC failed. Check that HTTPS is enabled for your tailnet and that Tailscale Serve is on in Mini-Summa. Also check that this phone has the correct date and time.',
  cleartext: 'This address starts with http. Android blocks plain http connections to other devices. Use the https address that Tailscale Serve shows in Mini-Summa on your PC.',
  not_mini_summa: 'That address answered, but it is not Mini-Summa. Check the address.',
  desktop_error: 'Your PC answered, but Mini-Summa returned an error. Make sure Mini-Summa is running on your PC, then try again.',
  code_expired: 'This pairing code has expired. In Mini-Summa on your PC, create a new pairing code and scan it.',
  code_used: 'This pairing code was already used. Each code works once. Create a new one in Mini-Summa on your PC.',
  code_invalid: 'Your PC did not recognise this code. Check the code, or create a new pairing code in Mini-Summa on your PC.',
  too_many_attempts: 'Too many wrong codes. This pairing code is cancelled. Create a new one in Mini-Summa on your PC and scan it.',
  refused: 'Your PC refused this pairing. Create a new pairing code in Mini-Summa on your PC and try again.',
};

export const pairingMessage = (kind: PairingErrorKind): string => MESSAGES[kind];

// ---- input ------------------------------------------------------------------------------------------------------

/** The QR code carries a minisumma://pair link. Anything else is not ours. */
export const parseScannedCode = (text: string): PairingPayload | null => decodePairingPayload(text);

/** "my-pc.tail1234.ts.net" becomes "https://my-pc.tail1234.ts.net". Paths and queries are dropped. null = not an address. */
export function normalizeAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const m = /^(https?):\/\/([^/?#]+)/i.exec(withScheme);
  if (!m) return null;
  const host = m[2];
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(host)) return null;
  return `${m[1].toLowerCase()}://${host}`;
}

export interface ManualPairingInput { address: string; offerId: string; code: string }

/** Typed by hand. A pasted pairing link in any field is accepted and wins. */
export function payloadFromManualInput(input: ManualPairingInput): PairingPayload {
  for (const candidate of [input.code, input.offerId, input.address]) {
    const decoded = decodePairingPayload(candidate);
    if (decoded) return decoded;
  }
  const url = normalizeAddress(input.address);
  const offerId = input.offerId.trim();
  const code = input.code.trim();
  if (!url || !offerId || code.length < 8) throw new PairingError('invalid_input', MESSAGES.invalid_input);
  return { version: 1, code, offerId, urls: [url], name: 'your PC' };
}

/** "Pixel 8" style name for the device list on the PC. The user can edit it before pairing. */
export function suggestDeviceName(constants: { Brand?: string; Model?: string; Manufacturer?: string } | undefined): string {
  const model = constants?.Model?.trim();
  const brand = (constants?.Brand ?? constants?.Manufacturer)?.trim();
  if (!model) return 'Android phone';
  if (brand && !model.toLowerCase().startsWith(brand.toLowerCase())) return `${brand[0].toUpperCase()}${brand.slice(1)} ${model}`;
  return model;
}

// ---- network ----------------------------------------------------------------------------------------------------

export interface PairOptions {
  deviceName: string;
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
  redeemTimeoutMs?: number;
}

export interface PairResult { credentials: Credentials; device: Device; attempts: UrlAttempt[] }

async function probe(url: string, opts: PairOptions): Promise<UrlAttempt> {
  const client = new MiniSummaClient({ baseUrl: url, token: '', fetch: opts.fetch, timeoutMs: opts.probeTimeoutMs ?? 4000 });
  try {
    const health = await client.call('system.health');
    return health && (health as { name?: string }).name === 'mini-summa-core' && (health as { ok?: boolean }).ok === true
      ? { url, outcome: 'ok' } : { url, outcome: 'not_mini_summa' };
  } catch (err) {
    if (err instanceof ApiError && err.status > 0) return { url, outcome: 'http_error', status: err.status };
    return { url, outcome: classifyNetworkError(err, url) };
  }
}

function failureFor(attempts: UrlAttempt[]): PairingError {
  const has = (o: UrlAttempt['outcome']) => attempts.some((a) => a.outcome === o);
  const kind: PairingErrorKind = has('tls') ? 'tls'
    : has('http_error') ? 'desktop_error'
      : has('not_mini_summa') && !has('no_answer') && !has('timeout') ? 'not_mini_summa'
        : attempts.length > 0 && attempts.every((a) => a.outcome === 'cleartext') ? 'cleartext'
          : 'unreachable';
  return new PairingError(kind, MESSAGES[kind], attempts);
}

/** Map what the desktop said about the code to words. The core's codes are matched loosely on purpose. */
export function redeemError(err: unknown, attempts: UrlAttempt[] = []): PairingError {
  if (err instanceof ApiError) {
    if (err.status === 0) return new PairingError('unreachable', MESSAGES.unreachable, attempts);
    const text = `${err.code} ${err.message}`.toLowerCase();
    if (err.status === 429 || /too.?many|rate/.test(text)) return new PairingError('too_many_attempts', MESSAGES.too_many_attempts, attempts);
    if (/expire/.test(text)) return new PairingError('code_expired', MESSAGES.code_expired, attempts);
    if (/already|\bused\b|redeemed|consumed/.test(text)) return new PairingError('code_used', MESSAGES.code_used, attempts);
    if (err.status === 404 || err.status === 400 || err.status === 401 || /invalid|not.?found|unknown|no such|mismatch/.test(text)) return new PairingError('code_invalid', MESSAGES.code_invalid, attempts);
    if (err.status === 403) return new PairingError('refused', MESSAGES.refused, attempts);
    if (err.status === 410) return new PairingError('code_expired', MESSAGES.code_expired, attempts);
    if (err.status === 409) return new PairingError('code_used', MESSAGES.code_used, attempts);
    return new PairingError('desktop_error', `${MESSAGES.desktop_error} (${err.message})`, attempts);
  }
  return new PairingError('unreachable', MESSAGES.unreachable, attempts);
}

export async function pairWithDesktop(payload: PairingPayload, opts: PairOptions): Promise<PairResult> {
  const attempts: UrlAttempt[] = [];
  let reachable: string | null = null;
  for (const url of payload.urls) {
    // A release build refuses plain http to another device without sending anything; classifyNetworkError says so.
    const a = await probe(url, opts);
    attempts.push(a);
    if (a.outcome === 'ok') { reachable = url; break; }
  }
  if (!reachable) throw failureFor(attempts);

  const client = new MiniSummaClient({ baseUrl: reachable, token: '', fetch: opts.fetch, timeoutMs: opts.redeemTimeoutMs ?? 20_000 });
  try {
    const res = await client.call('pairing.redeem', {
      body: { offerId: payload.offerId, code: payload.code, deviceName: opts.deviceName.trim() || 'Android phone', platform: 'android' },
    });
    return { credentials: { baseUrl: reachable, token: res.token, deviceId: res.device.id, serverName: res.server.name }, device: res.device, attempts };
  } catch (err) {
    throw redeemError(err, attempts);
  }
}
