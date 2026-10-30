import { envLabel, normalizeRootInput } from '@minisumma/shared';
import type { EnvId, EnvironmentInfo } from '@minisumma/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp } from '../../app/runtime';
import { Button, Field, Icon, IconButton, Select, TextInput } from '../../ui';
import { addRoot, removeRoot } from './projectDraft';
import type { ProjectDraft } from './projectDraft';

/**
 * What is still in the "Add a folder" field when the person presses Save. A path that was typed (or that the picker returned but
 * could not be read) has not been added to the draft yet; Save must not drop it silently, so it either adds it or says why it cannot.
 */
export type PendingFolder =
  | { kind: 'none' }
  | { kind: 'added'; draft: ProjectDraft }
  | { kind: 'invalid'; message: string };

export interface RootsEditorProps {
  draft: ProjectDraft;
  onChange: (draft: ProjectDraft) => void;
  /** The form reads this when Save is pressed: it adds a valid path left in the field, or reports why it cannot. */
  pending?: MutableRefObject<(draft: ProjectDraft) => PendingFolder>;
  /** Tells the form whether the field holds something that Save would add, so that closing the dialog asks first. */
  onPendingChange?: (hasPending: boolean) => void;
}

type HostPlatform = 'win32' | 'linux' | 'darwin';
const isHostPlatform = (v: unknown): v is HostPlatform => v === 'win32' || v === 'linux' || v === 'darwin';

/** Folders of the repository, per environment. Typed or browsed, with the reading of the path shown as you type. */
export function RootsEditor({ draft, onChange, pending, onPendingChange }: RootsEditorProps) {
  const native = useNative();
  const api = useApi();
  const systemPlatform = useApp((s) => s.system?.platform);
  const hostPlatform: HostPlatform = isHostPlatform(systemPlatform) ? systemPlatform : native.platform;

  const [text, setText] = useState('');
  const [distro, setDistro] = useState<EnvId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentInfo[] | null>(null);

  // The reading of what is typed. A Linux path on Windows needs to know which WSL distribution it lives in.
  const result = useMemo(() => {
    if (text.trim() === '') return null;
    const first = normalizeRootInput(text, { hostPlatform });
    return !first.ok && first.needsEnv && distro ? normalizeRootInput(text, { hostPlatform, env: distro }) : first;
  }, [text, hostPlatform, distro]);
  const needsEnv = result !== null && !result.ok && result.needsEnv === true;

  useEffect(() => {
    if (!needsEnv || environments !== null) return;
    let cancelled = false;
    api.call('environments.list').then((list) => { if (!cancelled) setEnvironments(list); }, () => { if (!cancelled) setEnvironments([]); });
    return () => { cancelled = true; };
  }, [needsEnv, environments, api]);

  const distros = useMemo(() => (environments ?? []).filter((e) => e.id.startsWith('wsl:')), [environments]);

  // The draft as of the latest render: the folder picker answers later than the render that asked for it.
  const latest = useRef(draft);
  latest.current = draft;

  const commit = () => {
    if (!result || !result.ok) return;
    const added = addRoot(draft, result.env, result.path);
    if (!added.ok) { setNote(added.message); return; }
    onChange(added.draft);
    setText('');
    setDistro(null);
    setNote(null);
  };

  /**
   * The person chose a folder in the operating system's picker. That is a decision, not a suggestion, so a folder that can be read
   * is added to the list at once (a second "Add folder" press used to be needed, and Save without it dropped the folder). A path
   * that cannot be read, such as a Linux path that needs a WSL distribution, stays in the field with its explanation.
   */
  const browse = async () => {
    let picked: string | null;
    try {
      picked = await native.dialogs.selectDirectory({ title: 'Choose the repository folder' });
    } catch {
      setNote('The folder picker could not be opened. Type the path instead.');
      return;
    }
    if (!picked) return;
    const read = normalizeRootInput(picked, { hostPlatform });
    if (read.ok) {
      const added = addRoot(latest.current, read.env, read.path);
      if (!added.ok) { setNote(added.message); return; }
      onChange(added.draft);
      setText('');
      setDistro(null);
      setNote(null);
      return;
    }
    setText(picked);
    setDistro(null);
    setNote(null);
  };

  const holdsText = text.trim() !== '';
  useEffect(() => { onPendingChange?.(holdsText); }, [holdsText, onPendingChange]);
  if (pending) {
    pending.current = (current) => {
      if (!holdsText || !result) return { kind: 'none' };
      if (!result.ok) {
        const message = result.needsEnv ? 'Choose which WSL distribution this folder is in, or clear the folder field.' : result.message;
        setNote(message);
        return { kind: 'invalid', message };
      }
      const added = addRoot(current, result.env, result.path);
      setText('');
      setDistro(null);
      setNote(null);
      // A folder that is already in the list is what the person wanted; there is nothing to add and nothing to refuse.
      return added.ok ? { kind: 'added', draft: added.draft } : { kind: 'none' };
    };
  }

  return (
    <div className="ms-roots">
      {draft.roots.length > 0 ? (
        <ul className="ms-rows" aria-label="Repository folders">
          {draft.roots.map((root) => (
            <li key={root.key} className="ms-row-item">
              <Icon name="folder" />
              <span className="ms-row-item__main">
                <span className="ms-mono ms-truncate" title={root.path}>{root.path}</span>
                <span className="ms-row-item__sub">{envLabel(root.env)}</span>
              </span>
              <IconButton label={`Remove folder ${root.path}`} icon="x" size="sm" onClick={() => onChange(removeRoot(draft, root.key))} />
            </li>
          ))}
        </ul>
      ) : null}

      <Field label="Add a folder" error={result && !result.ok && !result.needsEnv ? result.message : note ?? undefined}>
        <div className="ms-inline">
          <TextInput
            value={text}
            placeholder="C:\Dev\App or /home/me/app"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setText(e.target.value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          />
          {native.hasFolderPicker ? <Button onClick={() => { void browse(); }}>Browse</Button> : null}
          <Button onClick={commit} disabled={!result || !result.ok}>Add folder</Button>
        </div>
      </Field>

      <div className="ms-feedback" aria-live="polite">
        {result && result.ok ? (
          <>
            <p><span className="ms-feedback__label">{envLabel(result.env)}</span> <span className="ms-mono">{result.path}</span></p>
            {result.note ? <p className="ms-feedback__note">{result.note}</p> : null}
          </>
        ) : null}
        {needsEnv ? (
          <div className="ms-field">
            <p className="ms-feedback__note">{result && !result.ok ? result.message : ''}</p>
            {distros.length > 0 ? (
              <Select
                aria-label="WSL distribution"
                placeholder="Which WSL distribution is this path in?"
                value={distro}
                onChange={(v) => setDistro(v)}
                options={distros.map((d) => ({ value: d.id, label: d.label, description: d.available ? undefined : 'Not available' }))}
              />
            ) : (
              <p className="ms-feedback__note">{environments === null ? 'Looking for WSL distributions.' : 'No WSL distribution was found on this PC.'}</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
