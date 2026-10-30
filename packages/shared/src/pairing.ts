// QR payload for pairing a phone. A pairing offer is single use and short lived; the payload carries the one-time
// code and the addresses to try. The long-lived bearer token is only returned by the redeem call, never in the QR.

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
  const q = new URLSearchParams();
  q.set('v', '1');
  q.set('c', p.code);
  q.set('o', p.offerId);
  q.set('n', p.name);
  for (const u of p.urls) q.append('u', u);
  return `minisumma://pair?${q.toString()}`;
}

export function decodePairingPayload(text: string): PairingPayload | null {
  const raw = (text ?? '').trim();
  if (!raw.toLowerCase().startsWith('minisumma://pair?')) return null;
  const q = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
  const code = q.get('c');
  const offerId = q.get('o');
  const urls = q.getAll('u').filter((u) => /^https?:\/\//i.test(u));
  if (q.get('v') !== '1' || !code || !offerId || urls.length === 0) return null;
  return { version: 1, code, offerId, urls, name: q.get('n') ?? 'Mini-Summa' };
}
