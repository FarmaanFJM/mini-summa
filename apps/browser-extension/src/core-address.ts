// The core listens on 127.0.0.1 only, so the extension only ever talks to this computer. Restricting the address here
// (and in the manifest CSP) means the bearer token can never be sent to a remote host by a typo or a pasted link.
export const DEFAULT_CORE_URL = 'http://127.0.0.1:47811';

export type CoreAddressResult = { ok: true; url: string } | { ok: false; message: string };

const HINT = `Use the address of Mini-Summa on this computer, for example ${DEFAULT_CORE_URL}.`;

/** Accepts "127.0.0.1:47811", "http://localhost:47811/" and similar; returns the origin without path or query. */
export function normalizeCoreUrl(input: string): CoreAddressResult {
  const text = (input ?? '').trim();
  if (text === '') return { ok: false, message: 'Enter the address of Mini-Summa. ' + HINT };
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try { url = new URL(candidate); } catch { return { ok: false, message: 'That is not a valid address. ' + HINT }; }
  if (url.protocol !== 'http:') return { ok: false, message: 'Only http addresses on this computer are accepted. ' + HINT };
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return { ok: false, message: 'Only 127.0.0.1 and localhost are accepted. ' + HINT };
  if (url.username !== '' || url.password !== '') return { ok: false, message: 'The address must not contain a user name or password. ' + HINT };
  return { ok: true, url: url.origin };
}

/** WebSocket endpoint of a normalized core address. */
export const wsUrlOf = (coreUrl: string): string => `${coreUrl.replace(/\/+$/, '').replace(/^http/i, 'ws')}/ws`;

/** REST endpoint of a normalized core address. The path comes from the shared route table; a test keeps them equal. */
export const redeemUrlOf = (coreUrl: string): string => `${coreUrl.replace(/\/+$/, '')}/api/v1/pairing/redeem`;
