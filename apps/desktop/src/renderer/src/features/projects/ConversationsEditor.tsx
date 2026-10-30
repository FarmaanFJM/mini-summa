import { parseChatGptUrl } from '@minisumma/shared';
import type { ChatGptUrlKind, ConversationVerification } from '@minisumma/shared';
import { useMemo, useState } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp } from '../../app/runtime';
import { Button, Field, Icon, IconButton, Radio, TextInput, toast } from '../../ui';
import { addConversation, removeConversation, renameConversation, setPreferred } from './projectDraft';
import type { DraftConversation, ProjectDraft } from './projectDraft';

export const KIND_LABEL: Record<ChatGptUrlKind, string> = {
  chat: 'Conversation',
  project_chat: 'Conversation in a ChatGPT project',
  gpt_chat: 'Conversation with a custom GPT',
  project: 'ChatGPT project page',
  other: 'ChatGPT page',
};

/** The verification state in plain words. "Verified" only ever means a page title matched; nothing is read from the page. */
export function verificationText(state: ConversationVerification, title: string | null): string {
  switch (state) {
    case 'unverified': return 'Not verified yet';
    case 'verified': return title ? `Verified: ${title}` : 'Verified';
    case 'mismatch': return 'The page that opened did not match this conversation';
    case 'unreachable': return 'ChatGPT could not be reached';
    case 'login_required': return 'Sign in to ChatGPT, then verify again';
  }
}

export interface ConversationsEditorProps {
  draft: ProjectDraft;
  onChange: (draft: ProjectDraft) => void;
}

/** ChatGPT conversations mapped to the project: add by pasted address, rename, choose the preferred one, open and verify. */
export function ConversationsEditor({ draft, onChange }: ConversationsEditorProps) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const parsed = useMemo(() => (text.trim() === '' ? null : parseChatGptUrl(text)), [text]);

  const commit = () => {
    if (!parsed || !parsed.ok) return;
    const added = addConversation(draft, parsed.info);
    if (!added.ok) { setNote(added.message); return; }
    onChange(added.draft);
    setText('');
    setNote(null);
  };

  const error = parsed && !parsed.ok ? parsed.message : note;
  return (
    <div className="ms-conversations">
      {draft.conversations.length > 0 ? (
        <div role="radiogroup" aria-label="Preferred conversation" className="ms-rows">
          {draft.conversations.map((c) => (
            <ConversationRow
              key={c.key}
              item={c}
              preferred={draft.preferredKey === c.key}
              onPrefer={() => onChange(setPreferred(draft, c.key))}
              onRename={(title) => onChange(renameConversation(draft, c.key, title))}
              onRemove={() => onChange(removeConversation(draft, c.key))}
            />
          ))}
        </div>
      ) : null}

      <Field label="Add a conversation" error={error ?? undefined}>
        <div className="ms-inline">
          <TextInput
            value={text}
            placeholder="https://chatgpt.com/c/..."
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setText(e.target.value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          />
          <Button onClick={commit} disabled={!parsed || !parsed.ok}>Add conversation</Button>
        </div>
      </Field>

      <div className="ms-feedback" aria-live="polite">
        {parsed && parsed.ok ? (
          <>
            <p><span className="ms-feedback__label">{KIND_LABEL[parsed.info.kind]}</span> <span className="ms-mono ms-break">{parsed.info.url}</span></p>
            {parsed.info.warnings.map((w) => (
              <p key={w} className="ms-feedback__warn"><Icon name="triangle-alert" size={14} /><span>{w}</span></p>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

interface RowProps {
  item: DraftConversation;
  preferred: boolean;
  onPrefer: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
}

function ConversationRow({ item, preferred, onPrefer, onRename, onRemove }: RowProps) {
  const api = useApi();
  const native = useNative();
  // Verification lives in the core. A saved conversation shows the core's current value, so Verify updates the row live.
  const saved = useApp((s) => (item.id ? s.conversations.find((c) => c.id === item.id) ?? null : null));
  const [busy, setBusy] = useState<'verify' | 'open' | null>(null);

  const run = async (kind: 'verify' | 'open') => {
    if (!item.id) return;
    setBusy(kind);
    try {
      if (kind === 'verify') await api.call('conversations.verify', { params: { id: item.id } });
      else {
        const result = await api.call('conversations.open', { params: { id: item.id } });
        if (!result.opened) {
          // The host could not show it; a browser can always open the address.
          await native.shell.openExternal(item.url);
          if (result.note) toast({ title: 'Opened in your browser', body: result.note });
        }
      }
    } catch (err) {
      toast({ title: kind === 'verify' ? 'Could not verify the conversation' : 'Could not open the conversation', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const state = saved ? verificationText(saved.verification, saved.verifiedTitle) : 'Saved when you save the project';
  return (
    <div className="ms-row-item ms-row-item--conversation">
      <Radio name="preferred-conversation" checked={preferred} onChange={onPrefer} aria-label={`Preferred: ${item.title}`} />
      <div className="ms-row-item__main">
        <TextInput aria-label={`Title of ${item.title}`} value={item.title} onChange={(e) => onRename(e.target.value)} maxLength={200} />
        <span className="ms-row-item__sub ms-break">
          <span className="ms-mono">{item.url}</span>
        </span>
        <span className="ms-row-item__sub" data-verification={saved?.verification ?? 'new'}>
          {preferred ? 'Preferred. ' : ''}{state}
        </span>
      </div>
      <div className="ms-row-item__actions">
        <Button size="sm" variant="ghost" icon="external" disabled={!item.id} loading={busy === 'open'} onClick={() => { void run('open'); }} aria-label={`Open ${item.title}`}>Open</Button>
        <Button size="sm" variant="ghost" icon="circle-check" disabled={!item.id} loading={busy === 'verify'} onClick={() => { void run('verify'); }} aria-label={`Verify ${item.title}`}>Verify</Button>
        <IconButton label={`Remove ${item.title}`} icon="x" size="sm" onClick={onRemove} />
      </div>
    </div>
  );
}
