import QRCode from 'qrcode';
import type { PairingOffer } from '@minisumma/shared';
import { useEffect, useState } from 'react';
import { Button, CopyButton } from '../../ui';
import { useNow } from '../reports/support';
import { countdown, SCOPE_WORDS } from './model';

/** The QR code as an image address. Black on white with a quiet zone: the colours a camera reads best, whatever the theme. */
export function useQrImage(payload: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!payload) { setSrc(null); return undefined; }
    let cancelled = false;
    QRCode.toString(payload, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then(
      (svg) => { if (!cancelled) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`); },
      () => { if (!cancelled) setSrc(null); },
    );
    return () => { cancelled = true; };
  }, [payload]);
  return src;
}

export interface PairingPanelProps {
  offer: PairingOffer;
  kind: 'phone' | 'extension';
  onRenew: () => void;
  onClose: () => void;
}

/**
 * A pairing code, shown while it is valid. Once it expires the code and the QR image are removed from the screen, not
 * greyed out: a secret that no longer works has no reason to stay readable.
 */
export function PairingPanel({ offer, kind, onRenew, onClose }: PairingPanelProps) {
  const now = useNow(1000);
  const left = countdown(offer.expiresAt, now);
  const qr = useQrImage(kind === 'phone' && !left.expired ? offer.qrPayload : null);

  if (left.expired) {
    return (
      <div className="ms-pair" aria-label="Pairing code">
        <div className="ms-pair__text">
          <p className="ms-x-note" role="status">This pairing code expired. A code works for five minutes and only once.</p>
          <div className="ms-x-actions">
            <Button variant="primary" onClick={onRenew}>Create a new code</Button>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ms-pair" aria-label="Pairing code">
      {kind === 'phone' ? (
        <div className="ms-pair__qr">
          {qr ? <img src={qr} width={232} height={232} alt="QR code that holds the pairing code" /> : <div className="ms-pair__qr-wait" aria-busy="true" />}
        </div>
      ) : null}
      <div className="ms-pair__text">
        <p className="ms-pair__lead">
          {kind === 'phone' ? 'Scan this with the Mini-Summa app on your phone.' : 'Paste this link into the extension and press Pair.'}
          {' '}It works for <strong aria-live="off">{left.text}</strong> more, and only once.
        </p>
        <dl className="ms-x-kv" aria-label="The pairing code as text">
          <dt>Offer</dt><dd className="ms-mono">{offer.id}</dd>
          <dt>Code</dt><dd className="ms-mono">{offer.code}</dd>
          <dt>Allows</dt><dd>{offer.scopes.map((s) => SCOPE_WORDS[s].label).join(', ')}</dd>
          {kind === 'extension' ? (<><dt>Link</dt><dd className="ms-mono ms-break">{offer.qrPayload}</dd></>) : null}
        </dl>
        <p className="ms-x-note">
          {kind === 'phone' ? 'No camera? Open the app, choose to enter the details by hand, and type the offer and the code.' : 'Or choose to enter the details by hand in the extension and type the offer and the code.'}
        </p>
        <div className="ms-x-actions">
          <CopyButton text={offer.code} variant="secondary" size="sm" announce={false}>Copy code</CopyButton>
          {kind === 'extension' ? <CopyButton text={offer.qrPayload} variant="secondary" size="sm" announce={false}>Copy link</CopyButton> : null}
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel pairing</Button>
        </div>
      </div>
    </div>
  );
}
