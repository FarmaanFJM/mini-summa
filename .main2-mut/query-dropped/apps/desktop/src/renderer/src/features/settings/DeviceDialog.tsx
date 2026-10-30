import type { Device, Scope } from '@minisumma/shared';
import { useState } from 'react';
import { useApi } from '../../app/runtime';
import { Button, Checkbox, ConfirmDialog, Dialog, Field, Icon, TextInput } from '../../ui';
import { errorText } from '../reports/support';
import { SwitchRow } from './controls';
import { GRANTABLE_SCOPES, PLATFORM_WORDS, SCOPE_WORDS } from './model';
import type { GrantableScope } from './model';

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

export interface EditDeviceDialogProps { device: Device; onClose: () => void }

/**
 * Name, permissions and trust of one device. What the person types stays in the form when a save fails, and a device that
 * is trusted gets the plain warning while the switch is still in the person's hand, not after.
 */
export function EditDeviceDialog({ device, onClose }: EditDeviceDialogProps) {
  const api = useApi();
  const isExtension = device.platform === 'extension';
  const [name, setName] = useState(device.name);
  const [scopes, setScopes] = useState<Scope[]>(device.scopes);
  const [trusted, setTrusted] = useState(device.trusted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameProblem = trimmed === '' ? 'A device needs a name, such as "My phone".' : trimmed.length > 80 ? 'The name can be at most 80 characters.' : undefined;
  const changed = trimmed !== device.name || trusted !== device.trusted || (!isExtension && !sameSet(scopes, device.scopes));
  const trustingNow = trusted && !device.trusted;

  const toggleScope = (scope: GrantableScope, on: boolean) => {
    setScopes((cur) => (on ? [...new Set<Scope>([...cur, scope])] : cur.filter((s) => s !== scope)));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: { name?: string; trusted?: boolean; scopes?: GrantableScope[] } = {};
      if (trimmed !== device.name) body.name = trimmed;
      if (trusted !== device.trusted) body.trusted = trusted;
      if (!isExtension && !sameSet(scopes, device.scopes)) body.scopes = scopes.filter((s): s is GrantableScope => (GRANTABLE_SCOPES as readonly string[]).includes(s));
      await api.call('devices.update', { params: { id: device.id }, body });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title={`Edit ${device.name}`}
      description={`${PLATFORM_WORDS[device.platform]}. Changes apply to the next request the device makes.`}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!changed || nameProblem !== undefined} onClick={() => { void save(); }}>
            {trustingNow ? 'Save and trust this device' : 'Save'}
          </Button>
        </>
      )}
    >
      <div className="ms-x-stack">
        <Field label="Name" error={nameProblem}>
          <TextInput value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>

        {isExtension ? (
          <p className="ms-x-note">The browser extension can only focus or open the ChatGPT tab. Its permission cannot be changed.</p>
        ) : (
          <fieldset className="ms-set-fieldset">
            <legend className="ms-x-label">Permissions</legend>
            <div className="ms-x-stack ms-x-stack--tight">
              {GRANTABLE_SCOPES.map((scope) => (
                <Checkbox
                  key={scope}
                  checked={scopes.includes(scope)}
                  onChange={(on) => toggleScope(scope, on)}
                  label={<span className="ms-set-choice__text"><span className="ms-x-row__label">{SCOPE_WORDS[scope].label}</span><span className="ms-x-row__hint">{SCOPE_WORDS[scope].description}</span></span>}
                />
              ))}
            </div>
          </fieldset>
        )}

        {isExtension ? null : (
          <div className="ms-x-stack ms-x-stack--tight">
            <SwitchRow
              label="Trust this device"
              hint="A trusted device's prompts are typed into Claude without waiting for your approval on this PC. This matters only while the Prompt permission is on."
              checked={trusted}
              onChange={setTrusted}
            />
            {trusted ? (
              <div className="ms-notice" data-tone="attention" role="note">
                <Icon name="triangle-alert" />
                <span className="ms-notice__text">Anyone who can unlock this device can make Claude type into your sessions, with no question asked on this PC. Trust only a phone that only you use, and turn it off if the phone is lost.</span>
              </div>
            ) : null}
          </div>
        )}

        {error ? <p className="ms-dialog__error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}

export interface RevokeDeviceDialogProps { device: Device; onClose: () => void }

/** Revoking ends a device's access at once. It is one decision with its consequence in the text and a verb on the button. */
export function RevokeDeviceDialog({ device, onClose }: RevokeDeviceDialogProps) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call('devices.revoke', { params: { id: device.id } });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      destructive
      title={`Revoke ${device.name}?`}
      description={`${device.name} stops having access to Mini-Summa as soon as you confirm. Requests it still has waiting are dropped. To use it again, pair it again.`}
      confirmLabel="Revoke access"
      busy={busy}
      error={error}
      onConfirm={revoke}
      onCancel={onClose}
    />
  );
}
