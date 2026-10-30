// The local folders of a project. Adding and removing reach the core at once. A folder chosen with Browse is added the moment it is
// chosen; a typed one is added with Enter or the button. The core's refusal (the folder does not exist, is a file, belongs to another
// project) is shown beside the field in the core's own words. A project with no folder shows nothing about it: that is complete.
import { envLabel } from '@minisumma/shared';
import type { EnvId, Project } from '@minisumma/shared';
import { useState } from 'react';
import { useNative } from '../../app/native';
import { useApi } from '../../app/runtime';
import { Button, Field, Icon, IconButton, TextInput } from '../../ui';
import { FolderReadingView, useHostPlatform } from './FolderInput';
import { SettingsSection } from './parts';
import { NEEDS_DISTRO_NOTE, readFolder } from './readings';
import { failureText, useAddText, useSavedFlag } from './useCommit';

interface NewFolder { path: string; env: EnvId }

export function FoldersSection({ project }: { project: Project }) {
  const api = useApi();
  const native = useNative();
  const hostPlatform = useHostPlatform();
  const { saved, flash } = useSavedFlag();
  const [distro, setDistro] = useState<EnvId | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const add = useAddText<NewFolder>({
    check: (text) => {
      const read = readFolder(text, hostPlatform, distro);
      if (read.kind === 'ok') return { ok: true, value: { path: read.path, env: read.env }, shown: read.path };
      // A path that waits for the distribution is explained by the question under the field; it is only said as an error when the
      // person tries to finish without answering.
      if (read.kind === 'needs-distro') return { ok: false, message: NEEDS_DISTRO_NOTE, quiet: true };
      return { ok: false, message: read.kind === 'invalid' ? read.message : 'Enter the folder that holds the project.', quiet: read.kind === 'empty' };
    },
    apply: async ({ path, env }) => { await api.call('projects.addRoot', { params: { id: project.id }, body: { path, env } }); },
    onSaved: () => { setDistro(null); flash(); },
  });
  const reading = readFolder(add.text, hostPlatform, distro);

  /**
   * The person chose a folder in the operating system's picker. That is a decision, not a suggestion: a folder that can be read is
   * added at once. One that cannot (a Linux path that needs a WSL distribution) waits in the field with its question.
   */
  const browse = async () => {
    let picked: string | null;
    try {
      picked = await native.dialogs.selectDirectory({ title: 'Choose a folder for this project' });
    } catch {
      add.refuse('The folder picker could not be opened. Type the path instead.');
      return;
    }
    if (!picked) return;
    const read = readFolder(picked, hostPlatform, null);
    if (read.kind === 'ok') {
      setProblem(null);
      await add.send({ path: read.path, env: read.env }, picked);
      return;
    }
    setDistro(null);
    add.setText(picked);
  };

  const remove = async (id: string) => {
    setRemoving(id);
    setProblem(null);
    try {
      await api.call('projects.removeRoot', { params: { id: project.id, rootId: id } });
      flash();
    } catch (err) {
      setProblem(failureText(err));
    } finally {
      setRemoving(null);
    }
  };

  const roots = project.roots.slice().sort((a, b) => a.position - b.position);
  return (
    <SettingsSection title="Local folders" saved={saved}>
      {roots.length > 0 ? (
        <ul className="ms-pj-rows" aria-label="Local folders">
          {roots.map((root) => (
            <li key={root.id} className="ms-pj-row">
              <Icon name="folder" />
              <span className="ms-pj-row__main">
                <span className="ms-mono ms-truncate" title={root.path}>{root.path}</span>
                <span className="ms-pj-row__sub">{envLabel(root.env)}</span>
              </span>
              <IconButton label={`Remove folder ${root.path}`} icon="x" size="sm" disabled={removing === root.id} onClick={() => { void remove(root.id); }} />
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? <p className="ms-field__error" role="alert">{problem}</p> : null}
      <Field label="Folder path" error={add.error ?? undefined}>
        <div className="ms-pj-inline">
          <TextInput {...add.inputProps} placeholder="C:\Dev\App or /home/me/app" spellCheck={false} autoComplete="off" />
          {native.hasFolderPicker ? <Button disabled={add.busy} onClick={() => { void browse(); }}>Browse</Button> : null}
          <Button loading={add.busy} disabled={reading.kind !== 'ok'} onClick={() => { void add.commit(); }}>Add folder</Button>
        </div>
      </Field>
      <FolderReadingView reading={reading} distro={distro} onDistro={setDistro} />
    </SettingsSection>
  );
}
