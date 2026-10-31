import type { DataUsage, PruneResult, RetentionSettings } from '@minisumma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../app/runtime';
import { useNative } from '../../app/native';
import { Button, ConfirmDialog, CopyButton, EmptyState, Field, TextInput } from '../../ui';
import { errorText } from '../reports/support';
import { formatRelative } from '../workspace/sessionModel';
import { Group, SaveStatus } from './controls';
import { count, formatBytes, parseDays, pruneWords, RETENTION_FIELDS } from './model';
import { useSettings } from './useSettings';

type Usage = { status: 'loading' } | { status: 'ready'; usage: DataUsage } | { status: 'error'; error: string };

function useUsage(): { usage: Usage; reload: () => Promise<void> } {
  const api = useApi();
  const [usage, setUsage] = useState<Usage>({ status: 'loading' });
  const reload = useCallback(async () => {
    try {
      setUsage({ status: 'ready', usage: await api.call('data.usage') });
    } catch (err) {
      setUsage({ status: 'error', error: errorText(err) });
    }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);
  return { usage, reload };
}

function Storage({ usage }: { usage: Usage }) {
  const native = useNative();
  if (usage.status === 'loading') return <div className="ms-skeleton-list ms-skeleton-list--wide" aria-busy="true" aria-label="Loading what is stored"><div className="ms-skeleton-row" /><div className="ms-skeleton-row" /></div>;
  if (usage.status === 'error') return <EmptyState tone="error">Mini-Summa could not read what is stored. {usage.error}</EmptyState>;
  const u = usage.usage;
  return (
    <>
      <dl className="ms-x-kv" aria-label="Storage details">
        <dt>Data folder</dt>
        <dd className="ms-set-inline"><span className="ms-mono ms-break">{u.dataDir}</span><CopyButton text={u.dataDir} label="Copy the folder path" size="sm" announce={false} /></dd>
        <dt>Database size</dt><dd>{formatBytes(u.databaseBytes)}</dd>
        <dt>Reports</dt><dd>{count(u.reports)}</dd>
        <dt>Handoffs</dt><dd>{count(u.deliveries)}</dd>
        <dt>Activity entries</dt><dd>{count(u.activity)}</dd>
        <dt>Notification records</dt><dd>{count(u.notifications)}</dd>
        <dt>Hook events</dt><dd>{count(u.rawEvents)}{u.oldestRawEventAt ? `, the oldest ${formatRelative(u.oldestRawEventAt)}` : ''}</dd>
      </dl>
      {native.kind === 'electron' ? (
        <div className="ms-x-actions">
          <Button icon="folder-open" onClick={() => { void native.shell.showItemInFolder(u.dataDir); }}>Show data folder</Button>
        </div>
      ) : null}
    </>
  );
}

type Draft = Partial<Record<keyof RetentionSettings, string>>;

/**
 * The limits. Until a field is typed in it shows what the core has, however late that arrives; once typed in, the text is
 * the person's until it is valid and saved. A failed save leaves every field as typed.
 */
function Retention({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const { settings, save, status } = useSettings();
  const stored = settings?.retention ?? null;
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);

  const text = (k: keyof RetentionSettings): string => draft[k] ?? (stored ? String(stored[k]) : '');
  const parsed = Object.fromEntries(RETENTION_FIELDS.map((f) => [f.key, parseDays(text(f.key))])) as Record<keyof RetentionSettings, number | null>;
  const dirtyKeys = stored ? RETENTION_FIELDS.filter((f) => draft[f.key] !== undefined && parsed[f.key] !== stored[f.key]).map((f) => f.key) : [];
  const valid = RETENTION_FIELDS.every((f) => parsed[f.key] !== null);
  const dirty = dirtyKeys.length > 0;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  if (!stored) return <p className="ms-x-note">Settings are not loaded yet.</p>;

  const apply = async () => {
    if (!valid) return;
    const sent = Object.fromEntries(dirtyKeys.map((k) => [k, draft[k] as string])) as Draft;
    setSaving(true);
    const ok = await save({ retention: Object.fromEntries(dirtyKeys.map((k) => [k, parsed[k] as number])) });
    setSaving(false);
    // Only what was sent is let go. A field typed in while the save ran stays as typed.
    if (ok) setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => sent[k as keyof RetentionSettings] !== v)) as Draft);
  };

  return (
    <Group
      title="How long to keep history"
      note="0 keeps everything. Nothing is removed until you run a cleanup below."
      actions={<SaveStatus status={status} />}
    >
      <div className="ms-set-fields">
        {RETENTION_FIELDS.map((f) => (
          <Field key={f.key} label={`${f.label}, days`} hint={f.hint} error={parsed[f.key] === null ? 'Use a whole number of days from 0 to 3650.' : undefined}>
            <TextInput inputMode="numeric" value={text(f.key)} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} autoComplete="off" />
          </Field>
        ))}
      </div>
      <div className="ms-x-actions">
        <Button variant="primary" loading={saving} disabled={!dirty || !valid} onClick={() => { void apply(); }}>Save limits</Button>
        <Button disabled={!dirty || saving} onClick={() => setDraft({})}>Discard changes</Button>
      </div>
    </Group>
  );
}

type Cleanup =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'preview'; result: PruneResult }
  | { step: 'removing'; result: PruneResult }
  | { step: 'done'; result: PruneResult }
  | { step: 'error'; error: string };

/** Cleanup is two steps on purpose: a dry run that only counts, then a confirmation that names what goes. */
function CleanUp({ onChanged, unsavedLimits }: { onChanged: () => Promise<void>; unsavedLimits: boolean }) {
  const api = useApi();
  const [state, setState] = useState<Cleanup>({ step: 'idle' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const preview = async () => {
    setState({ step: 'checking' });
    try {
      setState({ step: 'preview', result: await api.call('data.prune', { body: { dryRun: true } }) });
    } catch (err) {
      setState({ step: 'error', error: errorText(err) });
    }
  };

  const remove = async (result: PruneResult) => {
    setState({ step: 'removing', result });
    setConfirmError(null);
    try {
      const done = await api.call('data.prune', { body: { dryRun: false } });
      setConfirmOpen(false);
      setState({ step: 'done', result: done });
      await onChanged();
    } catch (err) {
      setConfirmError(errorText(err));
      setState({ step: 'preview', result });
    }
  };

  const shown = state.step === 'preview' || state.step === 'removing' || state.step === 'done' ? pruneWords(state.result) : null;
  const closeConfirm = () => { setConfirmOpen(false); setConfirmError(null); };

  return (
    <Group
      title="Clean up now"
      note="Activity that still needs you, entries you have not read, and handoffs that are still open always stay."
    >
      <div className="ms-x-actions">
        <Button loading={state.step === 'checking'} disabled={unsavedLimits || state.step === 'removing'} onClick={() => { void preview(); }}>Preview the cleanup</Button>
      </div>
      {unsavedLimits ? <p className="ms-x-note">Save the new limits first, so the preview matches them.</p> : null}

      {state.step === 'error' ? <p className="ms-x-error" role="alert">{state.error}</p> : null}
      {(state.step === 'preview' || state.step === 'removing') && shown ? (
        shown.total === 0 ? (
          <p className="ms-x-result" role="status">Nothing is older than your limits, so there is nothing to remove.</p>
        ) : (
          <div className="ms-x-result" role="status">
            <p>This cleanup would remove {shown.lines.join(', ')}. Nothing has been removed yet.</p>
            <div className="ms-x-actions"><Button variant="destructive" onClick={() => setConfirmOpen(true)}>Remove these records</Button></div>
          </div>
        )
      ) : null}
      {state.step === 'done' && shown ? (
        <p className="ms-x-result" role="status">{shown.total === 0 ? 'Nothing needed to be removed.' : `Removed ${shown.lines.join(', ')}.`}</p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen && (state.step === 'preview' || state.step === 'removing')}
        destructive
        title="Remove old records?"
        description={`This removes ${shown?.lines.join(', ') ?? 'the records'} from this PC. It cannot be undone.`}
        confirmLabel="Remove old records"
        busy={state.step === 'removing'}
        error={confirmError}
        onConfirm={() => (state.step === 'preview' ? remove(state.result) : undefined)}
        onCancel={closeConfirm}
      />
    </Group>
  );
}

export function DataSection() {
  const { usage, reload } = useUsage();
  const [unsavedLimits, setUnsavedLimits] = useState(false);

  return (
    <div className="ms-set-page">
      <Group title="What is stored">
        <Storage usage={usage} />
      </Group>

      <Group title="Where things live">
        <ul className="ms-set-points">
          <li>Everything Mini-Summa keeps is in the data folder above, on this PC. Nothing is uploaded to an account.</li>
          <li>Reports are kept exactly as Claude wrote them, except that strings that look like credentials are hidden when a report is captured.</li>
          <li>Mini-Summa does not read or store your ChatGPT sign-in or conversations. It keeps only the addresses and titles you added to a project.</li>
          <li>Pairing codes are kept only as hashes, so a copy of the database cannot sign in as a phone.</li>
          <li>The push key, if you set one up, is a separate file in the data folder that only your account can read.</li>
        </ul>
      </Group>

      <Retention onDirty={setUnsavedLimits} />
      <CleanUp onChanged={reload} unsavedLimits={unsavedLimits} />
    </div>
  );
}
