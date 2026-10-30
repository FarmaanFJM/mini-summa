import { envLabel, normalizeRootInput } from '@minisumma/shared';
import type { EnvId, EnvironmentInfo } from '@minisumma/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp } from '../../app/runtime';
import { Button, Field, Icon, IconButton, Select, TextInput } from '../../ui';
import { addRoot, removeRoot } from './projectDraft';
import type { ProjectDraft } from './projectDraft';

export interface RootsEditorProps {
  draft: ProjectDraft;
  onChange: (draft: ProjectDraft) => void;
}

type HostPlatform = 'win32' | 'linux' | 'darwin';
const isHostPlatform = (v: unknown): v is HostPlatform => v === 'win32' || v === 'linux' || v === 'darwin';

/** Folders of the repository, per environment. Typed or browsed, with the reading of the path shown as you type. */
export function RootsEditor({ draft, onChange }: RootsEditorProps) {
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

  const commit = () => {
    if (!result || !result.ok) return;
    const added = addRoot(draft, result.env, result.path);
    if (!added.ok) { setNote(added.message); return; }
    onChange(added.draft);
    setText('');
    setDistro(null);
    setNote(null);
  };

  const browse = async () => {
    try {
      const picked = await native.dialogs.selectDirectory({ title: 'Choose the repository folder' });
      if (picked) { setText(picked); setDistro(null); setNote(null); }
    } catch {
      setNote('The folder picker could not be opened. Type the path instead.');
    }
  };

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
