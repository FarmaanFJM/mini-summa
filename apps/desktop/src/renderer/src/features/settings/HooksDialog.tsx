import { ApiError } from '@minisumma/shared';
import type { EnvId, HookPlan } from '@minisumma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../app/runtime';
import { Button, Checkbox, Dialog, Spinner, toast } from '../../ui';
import { errorText } from '../reports/support';
import { diffCounts, envName, parseDiff } from './model';

export interface HooksDialogProps {
  env: EnvId;
  action: 'install' | 'uninstall';
  onClose: () => void;
}

const VERB = { install: { title: 'Install hooks', button: 'Install hooks', done: 'installed' }, uninstall: { title: 'Remove hooks', button: 'Remove hooks', done: 'removed' } } as const;

/** The exact lines that will change, one per line, with the + and - kept as text so meaning never rests on colour. */
export function DiffView({ diff, label }: { diff: string; label: string }) {
  const lines = parseDiff(diff);
  return (
    <div className="ms-diff ms-mono" role="region" aria-label={label} tabIndex={0}>
      {lines.map((l, i) => <div key={i} className="ms-diff__line" data-kind={l.kind}>{l.text === '' ? ' ' : l.text}</div>)}
    </div>
  );
}

/**
 * Changing Claude Code's settings.json, step by step: the plan is made first and shown as the exact diff, the person agrees
 * to that file, and only then is that exact plan applied. If the file changed in between, nothing is written and the new
 * plan has to be read and agreed to again.
 */
export function HooksDialog({ env, action, onClose }: HooksDialogProps) {
  const api = useApi();
  const [plan, setPlan] = useState<HookPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [consent, setConsent] = useState(false);
  const [applying, setApplying] = useState(false);
  const label = envName(env);
  const verb = VERB[action];

  const makePlan = useCallback(async (): Promise<void> => {
    setPlan(null);
    try {
      setPlan(await api.call('hooks.plan', { body: { env, action } }));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [api, env, action]);
  useEffect(() => { void makePlan(); }, [makePlan]);

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      await api.call('hooks.apply', { body: { env, action, planHash: plan.planHash } });
      toast({
        title: `Hooks ${verb.done} for ${label}`,
        body: action === 'install' ? 'Claude Code reads hooks when a session starts, so sessions that are already running report only after they are restarted.' : 'Sessions started by Mini-Summa still get their own hooks.',
        kind: 'success',
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'plan_stale') {
        // The file changed after the plan was shown: what was agreed to is no longer what would be written.
        setConsent(false);
        setStale(true);
        await makePlan();
      } else setError(errorText(err));
    } finally {
      setApplying(false);
    }
  };

  const counts = plan ? diffCounts(parseDiff(plan.unifiedDiff)) : null;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      busy={applying}
      title={`${verb.title} for ${label}`}
      footer={(
        <>
          <Button onClick={onClose} disabled={applying}>{plan?.action === 'noop' ? 'Close' : 'Cancel'}</Button>
          {plan && plan.action !== 'noop' ? <Button variant="primary" loading={applying} disabled={!consent} onClick={() => { void apply(); }}>{verb.button}</Button> : null}
        </>
      )}
    >
      {!plan && !error ? <p className="ms-x-note" role="status"><Spinner /> Reading the settings file</p> : null}
      {stale ? <p className="ms-x-result" data-tone="warning" role="alert">settings.json changed since you looked, so nothing was written. Read the new changes below and agree to them again.</p> : null}
      {plan?.action === 'noop' ? <p className="ms-x-note">Nothing to change: {action === 'install' ? 'the hooks are already installed' : 'no Mini-Summa hooks are in this file'}.</p> : null}
      {plan && plan.action !== 'noop' ? (
        <>
          <dl className="ms-x-kv" aria-label="Where">
            <dt>File</dt><dd className="ms-mono ms-break">{plan.settingsPath}</dd>
            <dt>Backup</dt><dd className="ms-mono ms-break">{plan.backupPath === '' ? 'None needed: the file does not exist yet.' : plan.backupPath}</dd>
          </dl>
          {plan.warnings.length > 0 ? (
            <ul className="ms-set-warnings" aria-label="Things to know">{plan.warnings.map((w) => <li key={w} className="ms-x-note">{w}</li>)}</ul>
          ) : null}
          <div className="ms-x-stack ms-x-stack--tight">
            <span className="ms-x-label">Exact changes{counts ? `, ${counts.added} added, ${counts.removed} removed` : ''}</span>
            <DiffView diff={plan.unifiedDiff} label={`Changes to ${plan.settingsPath}`} />
          </div>
          <Checkbox checked={consent} onChange={setConsent} label={<>I have read these changes to <span className="ms-mono ms-break">{plan.settingsPath}</span></>} />
        </>
      ) : null}
      {error ? <p className="ms-dialog__error" role="alert">{error}</p> : null}
    </Dialog>
  );
}
