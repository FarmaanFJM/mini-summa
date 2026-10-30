import type { TailscaleStatus } from '@minisumma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { Button, CopyButton, Icon } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { errorText } from '../reports/support';
import { Group, PageStatus, SwitchRow } from './controls';
import { tailscaleFacts } from './model';
import { useSettings } from './useSettings';

/** The newer of two answers about Tailscale. The live announcement and a direct check both feed the screen. */
function newest(a: TailscaleStatus | null, b: TailscaleStatus | null): TailscaleStatus | null {
  if (!a || !b) return a ?? b;
  return Date.parse(b.checkedAt) >= Date.parse(a.checkedAt) ? b : a;
}

const FUNNEL_WARNING = 'Tailscale Funnel is on for this PC. Funnel makes services reachable from the whole internet. Mini-Summa never uses Funnel and will not turn on remote access while it is on. Turn it off by running "tailscale funnel reset" in a terminal, then check again.';

export function RemoteAccessSection() {
  const api = useApi();
  const announced = useApp((s) => s.tailscale);
  const { settings, save, status: saveStatus } = useSettings();
  const [checked, setChecked] = useState<TailscaleStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ts = newest(announced, checked);

  const check = useCallback(async (refresh: boolean) => {
    setChecking(true);
    try {
      setChecked(await api.call('tailscale.status', { query: refresh ? { refresh: true } : {} }));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setChecking(false);
    }
  }, [api]);
  useEffect(() => { void check(false); }, [check]);

  if (!settings) return <p className="ms-x-note">Settings are not loaded yet.</p>;
  const wanted = settings.mobile.remoteAccess === 'tailscale';
  const facts = ts ? tailscaleFacts(ts) : null;

  const toggle = async (on: boolean) => {
    setSwitching(true);
    setError(null);
    try {
      const next = await api.call('tailscale.setServe', { body: { enabled: on } });
      setChecked(next);
      if (on) {
        // Remember the choice only when the address really works: a choice that cannot be kept would only look like it is on.
        if (next.serve.configured && !next.serve.funnelDetected && next.problem === null) await save({ mobile: { remoteAccess: 'tailscale' } });
      } else {
        await save({ mobile: { remoteAccess: 'off' } });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSwitching(false);
    }
  };

  const blocked = ts !== null && !ts.installed;
  const published = ts !== null && ts.serve.configured && !ts.serve.funnelDetected;

  return (
    <div className="ms-set-page">
      <PageStatus status={saveStatus} />

      <Group
        title="Phone access"
        note="Lets a paired phone reach Mini-Summa when it is away from this PC. Mini-Summa publishes itself only to your own tailnet, so only your devices signed in to your Tailscale account can even see it."
      >
        <SwitchRow
          label="Allow my phone to reach Mini-Summa through Tailscale Serve"
          hint="Uses tailscale serve. A phone still has to be paired before it can do anything."
          checked={wanted}
          disabled={switching || blocked}
          onChange={(v) => { void toggle(v); }}
        />
        {wanted && !published && ts && !ts.problem ? <p className="ms-x-note">Remote access is on, but Mini-Summa is not published right now. Check again in a moment.</p> : null}
        {error ? <p className="ms-x-error" role="alert">{error}</p> : null}
      </Group>

      <Group
        title="Tailscale on this PC"
        actions={<Button size="sm" icon="refresh" loading={checking} onClick={() => { void check(true); }}>Check again</Button>}
      >
        {!ts || !facts ? (
          <p className="ms-x-note" role="status">{checking ? 'Asking Tailscale.' : 'Tailscale has not been checked yet.'}</p>
        ) : (
          <>
            <dl className="ms-x-kv" aria-label="Tailscale status">
              <dt>Tailscale</dt><dd>{facts.installed}</dd>
              <dt>Service</dt><dd>{facts.running}</dd>
              <dt>Account</dt><dd>{facts.signedIn}</dd>
              <dt>Mini-Summa</dt><dd>{facts.serve}</dd>
              {published && ts.serve.url ? (
                <>
                  <dt>Address</dt>
                  <dd className="ms-set-inline"><span className="ms-mono ms-break">{ts.serve.url}</span><CopyButton text={ts.serve.url} label="Copy the address" size="sm" announce={false} /></dd>
                  <dt>To test</dt>
                  <dd>On the phone, with Tailscale on, open <span className="ms-mono ms-break">{ts.serve.url}/api/v1/health</span> in its browser. A short answer that mentions mini-summa-core means the phone can reach this PC.</dd>
                </>
              ) : null}
              <dt>Checked</dt><dd>{formatRelative(ts.checkedAt) || 'just now'}</dd>
            </dl>
            {ts.problem ? (
              <div className="ms-notice" data-tone={ts.serve.funnelDetected ? 'error' : 'attention'} role="alert">
                <Icon name={ts.serve.funnelDetected ? 'triangle-alert' : 'info'} />
                <span className="ms-notice__text">{ts.problem}</span>
              </div>
            ) : ts.serve.funnelDetected ? (
              <div className="ms-notice" data-tone="error" role="alert">
                <Icon name="triangle-alert" />
                <span className="ms-notice__text">{FUNNEL_WARNING}</span>
              </div>
            ) : null}
          </>
        )}
      </Group>

      <Group title="What it needs">
        <ul className="ms-set-points">
          <li>Tailscale installed and signed in on this PC and on the phone, in the same tailnet, with the phone's Tailscale switched on.</li>
          <li>MagicDNS and HTTPS Certificates turned on for the tailnet, in the Tailscale admin console under DNS.</li>
          <li>This PC awake and Mini-Summa running. When the PC sleeps the phone says so and shows nothing as live.</li>
        </ul>
        <p className="ms-x-note">Mini-Summa never uses Tailscale Funnel, which would make it reachable from the whole internet.</p>
      </Group>
    </div>
  );
}
