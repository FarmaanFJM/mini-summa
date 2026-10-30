// The ChatGPT conversations a project hands its reports to. Each change (a title, the preferred one, adding, removing) reaches the
// core as soon as it is made. Opening and verifying act on a saved conversation, which is now every conversation in the list.
import { parseChatGptUrl, suggestConversationTitle } from '@minisumma/shared';
import type { Conversation, Project } from '@minisumma/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNative } from '../../app/native';
import { conversationsOf } from '../../app/selectors';
import { useApi, useApp } from '../../app/runtime';
import { Button, Field, Icon, IconButton, Radio, TextInput } from '../../ui';
import { KIND_LABEL, verificationText } from './conversationText';
import { SettingsSection } from './parts';
import { failureText, useAddText, useCommitText, useSavedFlag, useTrack } from './useCommit';

const TITLE_MAX = 200;

export function ConversationsSection({ project }: { project: Project }) {
  const api = useApi();
  const { saved, flash } = useSavedFlag();
  const all = useApp((s) => s.conversations);
  const items = useMemo(() => conversationsOf(all, project.id), [all, project.id]);
  const [problem, setProblem] = useState<string | null>(null);

  // The radio answers at once; the core's answer arrives a moment later and takes over.
  const [chosen, setChosen] = useState<string | null>(null);
  const preferredId = chosen ?? project.preferredConversationId;
  useEffect(() => { if (chosen !== null && project.preferredConversationId === chosen) setChosen(null); }, [chosen, project.preferredConversationId]);

  const track = useTrack();
  const prefer = (conversation: Conversation) => track(async () => {
    setChosen(conversation.id);
    setProblem(null);
    try {
      await api.call('conversations.setPreferred', { params: { id: project.id }, body: { conversationId: conversation.id } });
      flash();
      return true;
    } catch (err) {
      setChosen(null);
      setProblem(failureText(err));
      return false;
    }
  });

  const remove = (conversation: Conversation) => track(async () => {
    setProblem(null);
    try {
      await api.call('conversations.remove', { params: { id: conversation.id } });
      flash();
      return true;
    } catch (err) {
      setProblem(failureText(err));
      return false;
    }
  });

  const add = useAddText<string>({
    check: (text) => {
      const read = parseChatGptUrl(text);
      return read.ok ? { ok: true, value: text.trim(), shown: read.info.url } : { ok: false, message: read.message };
    },
    apply: async (url) => { await api.call('conversations.add', { params: { id: project.id }, body: { url } }); },
    onSaved: flash,
  });
  const parsed = add.text.trim() === '' ? null : parseChatGptUrl(add.text);

  const noneChosen = items.length > 1 && !items.some((c) => c.id === preferredId);
  return (
    <SettingsSection title="ChatGPT conversations used for reports" saved={saved}>
      {items.length > 0 ? (
        <div role="radiogroup" aria-label="Preferred conversation" className="ms-pj-rows">
          {items.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              preferred={c.id === preferredId}
              groupName={`preferred-${project.id}`}
              onPrefer={() => { void prefer(c); }}
              onRemove={() => { void remove(c); }}
              onSaved={flash}
            />
          ))}
        </div>
      ) : null}
      {noneChosen ? <p className="ms-pj-note">No conversation is preferred. A report will ask where to go.</p> : null}
      {problem ? <p className="ms-field__error" role="alert">{problem}</p> : null}
      <Field label="Conversation address" error={add.error ?? undefined}>
        <div className="ms-pj-inline">
          <TextInput {...add.inputProps} placeholder="https://chatgpt.com/c/..." spellCheck={false} autoComplete="off" />
          <Button loading={add.busy} disabled={!parsed || !parsed.ok} onClick={() => { void add.commit(); }}>Add conversation</Button>
        </div>
      </Field>
      <div className="ms-pj-reading" aria-live="polite">
        {parsed && parsed.ok ? (
          <>
            <p><span className="ms-pj-reading__label">{KIND_LABEL[parsed.info.kind]}</span> <span className="ms-mono ms-break">{parsed.info.url}</span></p>
            {parsed.info.warnings.map((w) => (
              <p key={w} className="ms-pj-reading__warn"><Icon name="triangle-alert" size={14} /><span>{w}</span></p>
            ))}
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}

interface RowProps {
  conversation: Conversation;
  preferred: boolean;
  groupName: string;
  onPrefer(): void;
  onRemove(): void;
  onSaved(): void;
}

function ConversationRow({ conversation, preferred, groupName, onPrefer, onRemove, onSaved }: RowProps) {
  const api = useApi();
  const native = useNative();
  const [busy, setBusy] = useState<'verify' | 'open' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const title = useCommitText<string>({
    saved: conversation.title,
    check: (text) => {
      const value = text.trim();
      if (value.length > TITLE_MAX) return { ok: false, message: `Use ${TITLE_MAX} characters or fewer.` };
      // An empty title is the one the address gives, as the core does it.
      return { ok: true, value, shown: value || suggestConversationTitle(conversation) };
    },
    apply: async (value) => { await api.call('conversations.update', { params: { id: conversation.id }, body: { title: value } }); },
    onSaved,
  });

  const run = async (kind: 'verify' | 'open') => {
    setBusy(kind);
    setProblem(null);
    setNote(null);
    try {
      if (kind === 'verify') await api.call('conversations.verify', { params: { id: conversation.id } });
      else {
        const result = await api.call('conversations.open', { params: { id: conversation.id } });
        if (!result.opened) {
          // The host could not show it; a browser can always open the address.
          await native.shell.openExternal(conversation.url);
          setNote(result.note ? `Opened in your browser. ${result.note}` : 'Opened in your browser.');
        }
      }
    } catch (err) {
      setProblem(`${kind === 'verify' ? 'Could not verify the conversation' : 'Could not open the conversation'}. ${failureText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ms-pj-row ms-pj-row--conversation">
      <Radio name={groupName} checked={preferred} onChange={onPrefer} aria-label={`Preferred: ${conversation.title}`} />
      <div className="ms-pj-row__main">
        <TextInput {...title.inputProps} aria-label={`Title of ${conversation.title}`} maxLength={TITLE_MAX} autoComplete="off" />
        {title.error ? <span className="ms-field__error" role="alert">{title.error}</span> : null}
        <span className="ms-pj-row__sub ms-break"><span className="ms-mono">{conversation.url}</span></span>
        <span className="ms-pj-row__sub" data-verification={conversation.verification}>
          {preferred ? 'Preferred. ' : ''}{verificationText(conversation.verification, conversation.verifiedTitle)}
        </span>
        {note ? <span className="ms-pj-row__sub">{note}</span> : null}
        {problem ? <span className="ms-field__error" role="alert">{problem}</span> : null}
      </div>
      <div className="ms-pj-row__actions">
        <Button size="sm" variant="ghost" icon="external" loading={busy === 'open'} onClick={() => { void run('open'); }} aria-label={`Open ${conversation.title}`}>Open</Button>
        <Button size="sm" variant="ghost" icon="circle-check" loading={busy === 'verify'} onClick={() => { void run('verify'); }} aria-label={`Verify ${conversation.title}`}>Verify</Button>
        <IconButton label={`Remove ${conversation.title}`} icon="x" size="sm" onClick={onRemove} />
      </div>
    </div>
  );
}
