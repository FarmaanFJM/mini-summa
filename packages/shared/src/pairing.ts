// QR payload for pairing a phone. A pairing offer is single use and short lived; the payload carries the one-time
// code and the addresses to try. The long-lived bearer token is only returned by the redeem call, never in the QR.
//
// Query handling is written by hand: React Native's URLSearchParams is incomplete (several methods throw), and this
// module must run unchanged in Hermes.

export const PAIRING_SCHEME = 'minisumma:';

export interface PairingPayload {
  version: 1;
  code: string;
  offerId: string;
  /** Candidate base URLs in preference order. Tailscale Serve URLs are https; localhost is for the same machine. */
  urls: string[];
  /** Display name of the desktop, shown on the phone before confirming. */
  name: string;
}

export function encodePairingPayload(p: PairingPayload): string {
  const parts = [`v=1`, `c=${encodeURIComponent(p.code)}`, `o=${encodeURIComponent(p.offerId)}`, `n=${encodeURIComponent(p.name)}`];
  for (const u of p.urls) parts.push(`u=${encodeURIComponent(u)}`);
  return `minisumma://pair?${parts.join('&')}`;
}

function parseQuery(query: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawVal = eq < 0 ? '' : pair.slice(eq + 1);
    let key: string; let val: string;
    try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); val = decodeURIComponent(rawVal.replace(/\+/g, ' ')); } catch { continue; }
    const list = out.get(key);
    if (list) list.push(val); else out.set(key, [val]);
  }
  return out;
}

export function decodePairingPayload(text: string): PairingPayload | null {
  const raw = (text ?? '').trim();
  if (!raw.toLowerCase().startsWith('minisumma://pair?')) return null;
  const q = parseQuery(raw.slice(raw.indexOf('?') + 1));
  const code = q.get('c')?.[0];
  const offerId = q.get('o')?.[0];
  const urls = (q.get('u') ?? []).filter((u) => /^https?:\/\//i.test(u));
  if (q.get('v')?.[0] !== '1' || !code || !offerId || urls.length === 0) return null;
  return { version: 1, code, offerId, urls, name: q.get('n')?.[0] ?? 'Mini-Summa' };
}
