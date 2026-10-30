import type { PairingOffer } from '@minisumma/shared';
import { Fragment, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { Button } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { errorText } from '../reports/support';
import { Group } from './controls';
import { lastSeenWords } from './model';
import { PairingPanel } from './PairingPanel';

/** The sentence continues after a comma, so its first letter is lower case. The rest keeps its capitals ("PC", "Tailscale"). */
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

export function ExtensionSection() {
  const api = useApi();
  const connected = useApp((s) => s.system?.nativeCapabilities.extensionBridge ?? false);
  const devices = useApp((s) => s.devices);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paired = devices.filter((d) => d.platform === 'extension' && d.revokedAt === null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try { setOffer(await api.call('pairing.createOffer', { body: { kind: 'extension' } })); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <div className="ms-set-page">
      <Group title="Connection" note="It brings a ChatGPT tab you already have open to the front, and cannot see the page.">
        <dl className="ms-x-kv" aria-label="Extension connection">
          <dt>Now</dt>
          <dd>{connected ? 'A browser extension is connected.' : 'No extension is connected.'}</dd>
          {paired.map((d) => (<Fragment key={d.id}><dt>Paired</dt><dd>{d.name}, {lowerFirst(lastSeenWords(d, formatRelative))}</dd></Fragment>))}
        </dl>
      </Group>

      <Group title="Set it up">
        <ol className="ms-set-steps">
          <li>Build it once, from the Mini-Summa source folder: <code className="ms-mono">node apps/browser-extension/build.mjs</code>. The result is the <code className="ms-mono">dist</code> folder inside <code className="ms-mono">apps/browser-extension</code>.</li>
          <li>In Chrome, Edge or Brave open <code className="ms-mono">chrome://extensions</code>, switch on Developer mode, choose Load unpacked and pick that <code className="ms-mono">dist</code> folder.</li>
          <li>Create a pairing code here. Open the extension from its toolbar button, paste the link into Pairing link and press Pair.</li>
        </ol>
        {offer ? (
          <PairingPanel offer={offer} kind="extension" onRenew={() => { void create(); }} onClose={() => setOffer(null)} />
        ) : (
          <div className="ms-x-actions">
            <Button variant="primary" loading={busy} onClick={() => { void create(); }}>Create a pairing code</Button>
          </div>
        )}
        {error ? <p className="ms-x-error" role="alert">{error}</p> : null}
      </Group>
    </div>
  );
}
