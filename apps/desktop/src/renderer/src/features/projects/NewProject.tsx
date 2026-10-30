// The New project dialog: one decision at a time. The person picks how the project starts (a ChatGPT Project, a GitHub repository,
// a local folder, or nothing), gives the one thing that source needs, confirms the name and creates it. Everything else about a
// project is added afterwards in its settings, so a GitHub-only project is never asked about a folder.
import type { EnvId } from '@minisumma/shared';
import { useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNative } from '../../app/native';
import { useApi, useRoute } from '../../app/runtime';
import { Button, Dialog, Field, Tabs, tabPanelProps, TextInput } from '../../ui';
import { FolderReadingView, useHostPlatform } from './FolderInput';
import { AddressHint } from './parts';
import { failureField, NAME_MAX, planCreate, readChatGptAddress, readFolder, readGithub, SOURCES, suggestName } from './readings';
import type { FailureField, NewProjectInput, SourceId } from './readings';

const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

export interface NewProjectProps { onClose(): void }

export function NewProject({ onClose }: NewProjectProps) {
  const api = useApi();
  const route = useRoute();
  const native = useNative();
  const hostPlatform = useHostPlatform();
  const formId = useId();

  const [source, setSource] = useState<SourceId>('chatgpt');
  const [address, setAddress] = useState('');
  const [repo, setRepo] = useState('');
  const [folder, setFolder] = useState('');
  const [distro, setDistro] = useState<EnvId | null>(null);
  // The name is the source's own until the person types one: it is derived, not copied, so changing the source changes it.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<{ field: FailureField; message: string } | null>(null);
  const busy = useRef(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const repoRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const suggestion = suggestName({ source, address, repo, folder, hostPlatform, distro });
  const name = typedName ?? suggestion;
  const input: NewProjectInput = { source, address, repo, folder, hostPlatform, distro, name };
  const plan = planCreate(input);
  const errors = plan.ok ? {} : plan.errors;
  const dirty = typedName !== null || address.trim() !== '' || repo.trim() !== '' || folder.trim() !== '';

  const addressReading = readChatGptAddress(address);
  const repoReading = readGithub(repo);
  const folderReading = readFolder(folder, hostPlatform, distro);

  // What is wrong with the source's text shows as it is typed; an empty field says so only once Create has been pressed.
  const livePart = (() => {
    switch (source) {
      case 'chatgpt': return addressReading.kind === 'invalid' ? addressReading.message : undefined;
      case 'github': return repoReading.kind === 'invalid' ? repoReading.message : undefined;
      case 'folder': return folderReading.kind === 'invalid' ? folderReading.message : undefined;
      default: return undefined;
    }
  })();
  const sourceError = (failure?.field === 'source' ? failure.message : undefined) ?? livePart ?? (attempted ? errors.source : undefined);
  const nameError = (failure?.field === 'name' ? failure.message : undefined) ?? (attempted ? errors.name : undefined);
  const generalError = failure?.field === 'general' ? failure.message : null;

  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setFailure(null); };
  const onText = (set: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => edit(set)(event.target.value);

  const browse = async () => {
    let picked: string | null;
    try {
      picked = await native.dialogs.selectDirectory({ title: 'Choose the project folder' });
    } catch {
      setFailure({ field: 'source', message: 'The folder picker could not be opened. Type the path instead.' });
      return;
    }
    // The chosen folder is the project's folder: it is the field's value, and Create uses it. There is no second button to press.
    if (!picked) return;
    setFolder(picked);
    setDistro(null);
    setFailure(null);
  };

  const submit = async () => {
    if (busy.current) return;
    setAttempted(true);
    const made = planCreate(input);
    if (!made.ok) {
      if (made.errors.source) ({ chatgpt: addressRef, github: repoRef, folder: folderRef, empty: nameRef })[source].current?.focus();
      else nameRef.current?.focus();
      return;
    }
    busy.current = true;
    setCreating(true);
    setFailure(null);
    try {
      const project = await api.call('projects.create', { body: made.body });
      route.selectProject(project.id);
      onClose();
    } catch (err) {
      setFailure({ field: failureField(err as { code?: string; details?: unknown }), message: messageOf(err) });
    } finally {
      busy.current = false;
      setCreating(false);
    }
  };

  const panel = (() => {
    switch (source) {
      case 'chatgpt':
        return (
          <Field label="Address of an existing ChatGPT Project" error={sourceError} hint={<AddressHint reading={addressReading} />}>
            <TextInput
              ref={addressRef}
              value={address}
              placeholder="https://chatgpt.com/g/g-p-.../project"
              spellCheck={false}
              autoComplete="off"
              onChange={onText(setAddress)}
            />
          </Field>
        );
      case 'github':
        return (
          <Field
            label="Repository"
            error={sourceError}
            hint={repoReading.kind === 'ok' && repoReading.changed ? `Will be saved as ${repoReading.value}.` : undefined}
          >
            <TextInput
              ref={repoRef}
              value={repo}
              placeholder="owner/repo or the address of the repository"
              spellCheck={false}
              autoComplete="off"
              onChange={onText(setRepo)}
            />
          </Field>
        );
      case 'folder':
        return (
          <>
            <Field label="Folder" error={sourceError}>
              <div className="ms-pj-inline">
                <TextInput
                  ref={folderRef}
                  value={folder}
                  placeholder="C:\Dev\App or /home/me/app"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={onText(setFolder)}
                />
                {native.hasFolderPicker ? <Button onClick={() => { void browse(); }}>Browse</Button> : null}
              </div>
            </Field>
            <FolderReadingView reading={folderReading} distro={distro} onDistro={edit(setDistro)} />
          </>
        );
      default:
        return null;
    }
  })();

  return (
    <Dialog
      open
      onClose={onClose}
      title="New project"
      size="md"
      busy={creating}
      dismissOnBackdrop={!dirty}
      initialFocus={addressRef}
      footer={(
        <>
          <Button onClick={onClose} disabled={creating}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={creating}>Create project</Button>
        </>
      )}
    >
      <form id={formId} className="ms-pj-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="ms-field">
          <span className="ms-field__label" aria-hidden="true">Start from</span>
          <Tabs
            label="Start from"
            idPrefix="np-source"
            items={SOURCES.map((s) => ({ id: s.id, label: s.label }))}
            value={source}
            onChange={(id) => { setSource(id as SourceId); setFailure(null); }}
          />
        </div>
        <div {...tabPanelProps('np-source', source)} className="ms-pj-panel">{panel}</div>
        <Field label="Name" required error={nameError}>
          <TextInput
            ref={nameRef}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(e) => { setTypedName(e.target.value); setFailure(null); }}
          />
        </Field>
        {generalError ? <p className="ms-dialog__error" role="alert">{generalError}</p> : null}
      </form>
    </Dialog>
  );
}
