import type { CloudDispatch, CloudPhase, CloudSessionRecord } from '@minisumma/shared';
import { useState } from 'react';
import { useNative } from '../../app/native';
import { useApi } from '../../app/runtime';
import { Button, Field, Spinner, Tag, TextInput, toast } from '../../ui';


export const PHASE_LABEL: Record<CloudPhase, string> = {
  preparing: 'Preparing',
  waiting_for_input: 'Waiting for you',
  submitting: 'Submitting',
  created: 'Session created',
  failed: 'Failed',
  unknown: 'Result unknown',
};

const KEYS: Array<{ key: 'enter' | 'up' | 'down' | 'escape' | 'y' | 'n'; label: string }> = [
  { key: 'enter', label: 'Enter' }, { key: 'up', label: 'Up' }, { key: 'down', label: 'Down' }, { key: 'escape', label: 'Esc' }, { key: 'y', label: 'y' }, { key: 'n', label: 'n' },
];

export interface DispatchStatusProps {
  projectId: string;
  dispatch: CloudDispatch;
  onChange: (d: CloudDispatch) => void;
  onShowInCloudTab: (url: string) => void;
  onDone: () => void;
}

/**
 * What happened to a cloud task, in words that do not claim more than Mini-Summa knows. "Session created" means the CLI printed a
 * session link that was validated; it never means Claude started, finished or is waiting.
 */
export function DispatchStatus({ projectId, dispatch, onChange, onShowInCloudTab, onDone }: DispatchStatusProps) {
  const api = useApi();
  const native = useNative();
  const [link, setLink] = useState('');
  const [recorded, setRecorded] = useState<CloudSessionRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const press = async (key: (typeof KEYS)[number]['key']) => {
    try { onChange(await api.call('cloud.dispatchKey', { params: { id: dispatch.id }, body: { key } })); }
    catch (err) { toast({ title: 'Could not send the key', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };
  const cancel = async () => {
    try { onChange(await api.call('cloud.dispatchCancel', { params: { id: dispatch.id } })); }
    catch (err) { toast({ title: 'Could not close Claude Code', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };
  const open = (url: string) => { native.shell.openExternal(url).catch((err: unknown) => toast({ title: 'Could not open your browser', body: err instanceof Error ? err.message : undefined, kind: 'error' })); };
  const copy = async (text: string) => {
    try { await native.clipboard.writeText(text); toast({ title: 'Link copied', kind: 'success', durationMs: 2000 }); }
    catch (err) { toast({ title: 'Could not copy', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };
  const keep = async () => {
    setBusy(true);
    try { setRecorded(await api.call('cloud.recordLink', { params: { id: projectId }, body: { url: link.trim() } })); }
    catch (err) { toast({ title: 'That link was not kept', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
    finally { setBusy(false); }
  };

  const url = dispatch.sessionUrl ?? recorded?.url ?? null;
  const working = dispatch.phase === 'preparing' || dispatch.phase === 'submitting';
  const browser = dispatch.method === 'clipboard_browser';

  return (
    <div className="ms-dispatch">
      <div className="ms-dispatch__head">
        <Tag>{PHASE_LABEL[dispatch.phase]}</Tag>
        {working ? <Spinner /> : null}
      </div>
      <p className="ms-dispatch__detail" role="status">{dispatch.detail}</p>

      {dispatch.phase === 'waiting_for_input' && dispatch.running ? (
        <div className="ms-dispatch__keys" role="group" aria-label="Answer Claude Code">
          {KEYS.map((k) => <Button key={k.key} size="sm" onClick={() => { void press(k.key); }}>{k.label}</Button>)}
        </div>
      ) : null}

      {dispatch.tail.length > 0 ? <pre className="ms-dispatch__tail" aria-label="What Claude Code printed">{dispatch.tail.join('\n')}</pre> : null}

      {url ? (
        <div className="ms-dispatch__link">
          <span className="ms-truncate ms-mono" title={url}>{url.replace(/^https:\/\//, '')}</span>
          <Button size="sm" icon="external" onClick={() => open(url)}>Open in your browser</Button>
          <Button size="sm" icon="copy" onClick={() => { void copy(url); }}>Copy link</Button>
          <Button size="sm" onClick={() => onShowInCloudTab(url)}>Show in Cloud tab</Button>
        </div>
      ) : null}

      {browser && !recorded ? (
        <Field label="Session link from claude.ai/code" hint="Mini-Summa cannot see the page. After you submit, paste the session address here to keep it with this project.">
          <div className="ms-dispatch__paste">
            <TextInput value={link} placeholder="Paste the address of the session" autoComplete="off" onChange={(e) => setLink(e.target.value)} />
            <Button size="sm" loading={busy} disabled={link.trim() === ''} onClick={() => { void keep(); }}>Keep link</Button>
          </div>
        </Field>
      ) : null}

      <div className="ms-dispatch__foot">
        {dispatch.running ? <Button size="sm" variant="ghost" onClick={() => { void cancel(); }}>Close Claude Code</Button> : null}
        <Button variant="primary" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
