// The ChatGPT Project of a project: a link to an existing one. Only its address and a title are kept; nothing in the ChatGPT Project is
// imported or kept in step. Linking, changing, retitling and unlinking each reach the core as soon as they are done.
import type { ChatGptProjectLink, Project } from '@minisumma/shared';
import { useEffect, useState } from 'react';
import { useApi } from '../../app/runtime';
import { Button, Field, TextInput } from '../../ui';
import { AddressHint, SettingsSection } from './parts';
import { automaticTitleOf, readChatGptAddress } from './readings';
import { failureText, useAddText, useCommitText, useSavedFlag, useTrack } from './useCommit';

const TITLE_MAX = 120;

export interface ChatGptProjectSectionProps {
  project: Project;
  /** Selects the project and shows the ChatGPT pane. The dialog finishes what is typed first. */
  onOpen(): void;
}

export function ChatGptProjectSection({ project, onOpen }: ChatGptProjectSectionProps) {
  const { saved, flash } = useSavedFlag();
  const link = project.chatgptProject;
  return (
    <SettingsSection title="ChatGPT Project" saved={saved}>
      {link ? <Linked project={project} link={link} onSaved={flash} onOpen={onOpen} /> : <Unlinked project={project} onSaved={flash} />}
    </SettingsSection>
  );
}

interface LinkedProps { project: Project; link: ChatGptProjectLink; onSaved(): void; onOpen(): void }

function Linked({ project, link, onSaved, onOpen }: LinkedProps) {
  const api = useApi();
  const [changing, setChanging] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const automatic = automaticTitleOf(link.url) ?? 'ChatGPT Project';

  // A title the person typed is theirs: it is sent again with a new address. One that came from the old address is not.
  const keepTitle = link.title !== automatic;

  const title = useCommitText<string>({
    saved: link.title,
    check: (text) => {
      const value = text.trim();
      if (value.length > TITLE_MAX) return { ok: false, message: `Use ${TITLE_MAX} characters or fewer.` };
      // An empty title is the one the address gives.
      return { ok: true, value, shown: value || automatic };
    },
    apply: async (value) => { await api.call('projects.update', { params: { id: project.id }, body: { chatgptProject: { url: link.url, title: value } } }); },
    onSaved,
  });

  const track = useTrack();
  const unlink = () => track(async () => {
    setUnlinking(true);
    setProblem(null);
    try {
      await api.call('projects.update', { params: { id: project.id }, body: { chatgptProject: null } });
      onSaved();
      return true;
    } catch (err) {
      setProblem(failureText(err));
      return false;
    } finally {
      setUnlinking(false);
    }
  });

  return (
    <>
      <Field label="Title of the ChatGPT Project" error={title.error ?? undefined} className="ms-pj-bare">
        <TextInput {...title.inputProps} maxLength={TITLE_MAX} autoComplete="off" />
      </Field>
      {changing ? (
        <ChangeAddress
          project={project}
          link={link}
          keepTitle={keepTitle}
          onDone={() => setChanging(false)}
          onSaved={onSaved}
        />
      ) : (
        <p className="ms-pj-address ms-mono" title={link.url}>{link.url}</p>
      )}
      <div className="ms-pj-actions">
        <Button size="sm" icon="external" onClick={onOpen}>Open</Button>
        {changing ? null : <Button size="sm" onClick={() => setChanging(true)}>Change</Button>}
        <Button size="sm" loading={unlinking} onClick={() => { void unlink(); }}>Unlink</Button>
      </div>
      {problem ? <p className="ms-field__error" role="alert">{problem}</p> : null}
    </>
  );
}

interface ChangeProps { project: Project; link: ChatGptProjectLink; keepTitle: boolean; onDone(): void; onSaved(): void }

/** The address of a linked project, edited in place: Enter or leaving the field sends it, and so does closing the dialog. */
function ChangeAddress({ project, link, keepTitle, onDone, onSaved }: ChangeProps) {
  const api = useApi();
  const address = useCommitText<string>({
    saved: link.url,
    check: (text) => {
      const read = readChatGptAddress(text);
      if (read.kind === 'project' || read.kind === 'as-pasted') return { ok: true, value: text.trim(), shown: read.url };
      return { ok: false, message: read.kind === 'invalid' ? read.message : 'Paste the address of the ChatGPT Project, or leave it as it is.', quiet: read.kind === 'empty' };
    },
    apply: async (url) => {
      await api.call('projects.update', { params: { id: project.id }, body: { chatgptProject: keepTitle ? { url, title: link.title } : { url } } });
    },
    onSaved: () => { onSaved(); onDone(); },
  });
  const reading = readChatGptAddress(address.text);
  const field = address.inputProps.ref;
  // Changing starts with the address selected, ready to be replaced by a paste.
  useEffect(() => { field.current?.focus({ preventScroll: true }); field.current?.select(); }, [field]);

  return (
    <Field label="Address of the ChatGPT Project" error={address.error ?? undefined} hint={<AddressHint reading={reading} />}>
      <TextInput
        {...address.inputProps}
        placeholder="https://chatgpt.com/g/g-p-.../project"
        spellCheck={false}
        autoComplete="off"
      />
    </Field>
  );
}

function Unlinked({ project, onSaved }: { project: Project; onSaved(): void }) {
  const api = useApi();
  const add = useAddText<string>({
    check: (text) => {
      const read = readChatGptAddress(text);
      if (read.kind === 'project' || read.kind === 'as-pasted') return { ok: true, value: text.trim(), shown: read.url };
      return { ok: false, message: read.kind === 'invalid' ? read.message : 'Paste the address of the ChatGPT Project.', quiet: read.kind === 'empty' };
    },
    apply: async (url) => { await api.call('projects.update', { params: { id: project.id }, body: { chatgptProject: { url } } }); },
    onSaved,
  });
  const reading = readChatGptAddress(add.text);
  const ready = reading.kind === 'project' || reading.kind === 'as-pasted';
  return (
    <Field label="Address of an existing ChatGPT Project" error={add.error ?? undefined} hint={<AddressHint reading={reading} />}>
      <div className="ms-pj-inline">
        <TextInput {...add.inputProps} placeholder="https://chatgpt.com/g/g-p-.../project" spellCheck={false} autoComplete="off" />
        <Button loading={add.busy} disabled={!ready} onClick={() => { void add.commit(); }}>Link</Button>
      </div>
    </Field>
  );
}
