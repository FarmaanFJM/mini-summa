import type { Device, PairingOffer } from '@minisumma/shared';
import { useRef, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { Button, Checkbox, EmptyState, Icon } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { errorText } from '../reports/support';
import { Group } from './controls';
import { EditDeviceDialog, RevokeDeviceDialog } from './DeviceDialog';
import { GRANTABLE_SCOPES, lastSeenWords, PLATFORM_WORDS, SCOPE_WORDS, scopesInWords } from './model';
import type { GrantableScope } from './model';
import { PairingPanel } from './PairingPanel';

const DEFAULT_SCOPES: GrantableScope[] = ['read', 'notify'];

/** A pairing code in progress: the offer, and the devices that already existed when it was made. */
interface Pairing { offer: PairingOffer; known: ReadonlySet<string> }

function DeviceCard({ device, onEdit, onRevoke }: { device: Device; onEdit: () => void; onRevoke: () => void }) {
  return (
    <li className="ms-set-card">
      <div className="ms-set-card__head">
        <h3 className="ms-set-card__title">{device.name}</h3>
        {device.trusted ? <span className="ms-set-card__state"><Icon name="shield" size={14} />Trusted</span> : null}
      </div>
      <dl className="ms-x-kv" aria-label={`${device.name} details`}>
        <dt>Kind</dt><dd>{PLATFORM_WORDS[device.platform]}</dd>
        <dt>Connection</dt><dd>{lastSeenWords(device, formatRelative)}</dd>
        <dt>Allowed</dt><dd>{scopesInWords(device.scopes)}</dd>
        {device.platform !== 'extension' ? (<><dt>Push</dt><dd>{device.pushRegistered ? 'Registered for push notifications' : 'Not registered'}</dd></>) : null}
      </dl>
      <div className="ms-x-actions">
        <Button size="sm" icon="pencil" onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" onClick={onRevoke}>Revoke access</Button>
      </div>
    </li>
  );
}

function PairPhone() {
  const api = useApi();
  const devices = useApp((s) => s.devices);
  const [scopes, setScopes] = useState<GrantableScope[]>(DEFAULT_SCOPES);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const offer = await api.call('pairing.createOffer', { body: { kind: 'phone', scopes } });
      setPairing({ offer, known: new Set(devicesRef.current.map((d) => d.id)) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // The phone redeemed the code: a device that was not here before has appeared. The code is spent, so it leaves the screen.
  const arrived = pairing ? devices.find((d) => !pairing.known.has(d.id) && d.revokedAt === null && d.platform !== 'extension') : undefined;
  const toggle = (scope: GrantableScope, on: boolean) => setScopes((cur) => (on ? GRANTABLE_SCOPES.filter((s) => s === scope || cur.includes(s)) : cur.filter((s) => s !== scope)));

  return (
    <Group title="Pair a phone" note="Install the Mini-Summa app on the phone, then scan the code below with it. The code works once, for five minutes.">
      {arrived ? (
        <div className="ms-x-result" role="status">
          <p>{arrived.name} is paired. It may {scopesInWords(arrived.scopes).toLowerCase()}.</p>
          <div className="ms-x-actions"><Button size="sm" onClick={() => setPairing(null)}>Done</Button></div>
        </div>
      ) : pairing ? (
        <PairingPanel offer={pairing.offer} kind="phone" onRenew={() => { void create(); }} onClose={() => setPairing(null)} />
      ) : (
        <>
          <fieldset className="ms-set-fieldset">
            <legend className="ms-x-label">What the phone may do</legend>
            <div className="ms-x-stack ms-x-stack--tight">
              {GRANTABLE_SCOPES.map((scope) => (
                <Checkbox
                  key={scope}
                  checked={scopes.includes(scope)}
                  onChange={(on) => toggle(scope, on)}
                  label={<span className="ms-set-choice__text"><span className="ms-x-row__label">{SCOPE_WORDS[scope].label}</span><span className="ms-x-row__hint">{SCOPE_WORDS[scope].description}</span></span>}
                />
              ))}
            </div>
          </fieldset>
          {scopes.length === 0 ? <p className="ms-x-note">Choose at least one permission.</p> : null}
          <div className="ms-x-actions">
            <Button variant="primary" loading={busy} disabled={scopes.length === 0} onClick={() => { void create(); }}>Create pairing code</Button>
          </div>
        </>
      )}
      {error ? <p className="ms-x-error" role="alert">{error}</p> : null}
    </Group>
  );
}

export function PhoneSection() {
  const devices = useApp((s) => s.devices);
  const status = useApp((s) => s.listStatus.devices);
  const [editing, setEditing] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const active = devices.filter((d) => d.revokedAt === null);
  const revoked = devices.filter((d) => d.revokedAt !== null);
  const editDevice = active.find((d) => d.id === editing);
  const revokeDevice = active.find((d) => d.id === revoking);

  return (
    <div className="ms-set-page">
      <Group title="Paired devices" note="Phones and the browser extension that can reach Mini-Summa. A device only sees what its permissions allow.">
        {status === 'loading' && devices.length === 0 ? (
          <div className="ms-skeleton-list ms-skeleton-list--wide" aria-busy="true" aria-label="Loading devices"><div className="ms-skeleton-row" /></div>
        ) : active.length === 0 ? (
          <EmptyState>No device is paired yet. Pair a phone below.</EmptyState>
        ) : (
          <ul className="ms-set-cards" aria-label="Paired devices">
            {active.map((d) => <DeviceCard key={d.id} device={d} onEdit={() => setEditing(d.id)} onRevoke={() => setRevoking(d.id)} />)}
          </ul>
        )}
        {revoked.length > 0 ? (
          <details className="ms-set-details">
            <summary>Revoked devices ({revoked.length})</summary>
            <ul className="ms-set-plain" aria-label="Revoked devices">
              {revoked.map((d) => <li key={d.id}><span>{d.name}</span> <span className="ms-x-note">{lastSeenWords(d, formatRelative)}</span></li>)}
            </ul>
          </details>
        ) : null}
      </Group>

      <PairPhone />

      {editDevice ? <EditDeviceDialog key={editDevice.id} device={editDevice} onClose={() => setEditing(null)} /> : null}
      {revokeDevice ? <RevokeDeviceDialog key={revokeDevice.id} device={revokeDevice} onClose={() => setRevoking(null)} /> : null}
    </div>
  );
}
