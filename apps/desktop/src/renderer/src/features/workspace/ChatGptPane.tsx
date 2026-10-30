import { parseChatGptUrl, sameChatGptPage } from '@minisumma/shared';
import type { ChatGptViewState, Conversation, Project } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNative } from '../../app/native';
import { conversationsOf } from '../../app/selectors';
import { useApi, useApp, useRoute, useUi } from '../../app/runtime';
import { Button, EmptyState, Icon, IconButton, Select, Spinner, toast } from '../../ui';
import { describeStatus } from './chatgptStatus';
import { useNativeBounds } from './useNativeBounds';

export interface ChatGptPaneProps {
  project: Project;
  /** On screen: the workspace is the current view and the other pane is not maximised. */
  visible: boolean;
  maximized: boolean;
  onToggleMaximize: () => void;
}

/** The conversation the pane should show for a project: the one chosen last, else the preferred one, else the first. */
export function pickConversation(list: readonly Conversation[], project: Pick<Project, 'preferredConversationId'>, chosenId: string | undefined): Conversation | null {
  return list.find((c) => c.id === chosenId) ?? list.find((c) => c.id === project.preferredConversationId) ?? list[0] ?? null;
}

function useChatGptViewState(enabled: boolean): ChatGptViewState | null {
  const native = useNative();
  const [state, setState] = useState<ChatGptViewState | null>(null);
  useEffect(() => {
    if (!enabled) { setState(null); return undefined; }
    let cancelled = false;
    native.chatgpt.getState().then((s) => { if (!cancelled) setState(s); }, () => {});
    const off = native.chatgpt.onState((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; off(); };
  }, [enabled, native]);
  return state;
}

export function ChatGptPane({ project, visible, maximized, onToggleMaximize }: ChatGptPaneProps) {
  const native = useNative();
  const api = useApi();
  const route = useRoute();
  const setFocusedPane = useUi((s) => s.setFocusedPane);
  const focused = useUi((s) => s.focusedPane === 'chatgpt');
  const mode = useApp((s) => s.settings?.chatgpt.mode ?? 'embedded');
  const allConversations = useApp((s) => s.conversations);
  const conversations = useMemo(() => conversationsOf(allConversations, project.id), [allConversations, project.id]);
  const selected = pickConversation(conversations, project, route.conversationByProject[project.id]);

  const embedded = mode === 'embedded' && native.hasEmbeddedChatGpt;
  const view = useChatGptViewState(embedded);
  const bodyRef = useRef<HTMLDivElement>(null);
  useNativeBounds(bodyRef, embedded && visible && conversations.length > 0);

  // The conversation the view really shows may be another one of this project (a handoff opened it): follow reality.
  const shown = view?.url ? conversations.find((c) => sameChatGptPage(c.url, view.url ?? '')) ?? null : null;
  const current = shown ?? selected;

  // Load the mapped conversation when the project or the choice changes, but never reload a page that is already there.
  const lastNavigated = useRef<string | null>(null);
  useEffect(() => {
    if (!embedded || !selected) return undefined;
    const marker = `${selected.id}|${selected.url}`;
    if (lastNavigated.current === marker) return undefined;
    let cancelled = false;
    (async () => {
      const state = await native.chatgpt.getState().catch(() => null);
      if (cancelled) return;
      lastNavigated.current = marker;
      if (state?.url && sameChatGptPage(state.url, selected.url)) return;
      await native.chatgpt.navigate(selected.url);
    })().catch(() => { lastNavigated.current = null; });
    return () => { cancelled = true; };
  }, [embedded, selected, native]);

  const choose = useCallback((id: string) => {
    const target = conversations.find((c) => c.id === id);
    if (!target) return;
    route.selectConversation(project.id, id);
    if (embedded) {
      lastNavigated.current = `${target.id}|${target.url}`;
      void native.chatgpt.navigate(target.url).catch(() => {});
    }
  }, [conversations, embedded, native, project.id, route]);

  const openExternal = async (c: Conversation) => {
    try {
      const result = await api.call('conversations.open', { params: { id: c.id } });
      if (!result.opened) {
        await native.shell.openExternal(c.url);
        if (result.note) toast({ title: 'Opened in your browser', body: result.note });
      }
    } catch (err) {
      toast({ title: 'Could not open the conversation', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    }
  };

  const openInBrowser = () => {
    if (!current) return;
    if (!embedded) { void openExternal(current); return; }
    native.shell.openExternal(view?.url ?? current.url).catch((err: unknown) => {
      toast({ title: 'Could not open your browser', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    });
  };

  const status = describeStatus(view);
  const unmapped = embedded && view?.status === 'ready' && view.url && conversations.length > 0 && !shown ? view.url : null;
  const unmappedInfo = unmapped ? parseChatGptUrl(unmapped) : null;
  const canMap = unmappedInfo?.ok === true && unmappedInfo.info.chatgptConversationId !== null;

  const mapThisPage = async () => {
    if (!unmapped) return;
    try {
      await api.call('conversations.add', { params: { id: project.id }, body: { url: unmapped } });
      toast({ title: `Added to ${project.name}`, kind: 'success' });
    } catch (err) {
      toast({ title: 'Could not add the conversation', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    }
  };

  const openProjectDialog = useUi((s) => s.openProjectDialog);

  return (
    <section
      className="ms-pane ms-pane--chatgpt"
      aria-label="ChatGPT"
      data-focused={focused || undefined}
      onPointerDownCapture={() => setFocusedPane('chatgpt')}
      onFocusCapture={() => setFocusedPane('chatgpt')}
    >
      <header className="ms-pane__head">
        <span className="ms-pane__title">ChatGPT</span>
        <div className="ms-pane__select">
          {conversations.length > 1 && current ? (
            <Select
              quiet
              aria-label="Conversation"
              value={current.id}
              onChange={choose}
              options={conversations.map((c) => ({ value: c.id, label: c.title, description: c.id === project.preferredConversationId ? 'Preferred' : undefined }))}
            />
          ) : (
            <span className="ms-pane__current ms-truncate" title={current?.title}>{current ? current.title : 'No conversation'}</span>
          )}
        </div>
        <div className="ms-pane__tools">
          {embedded ? (
            <>
              <IconButton label="Back" icon="arrow-left" size="sm" tooltipPlacement="top" disabled={!view?.canGoBack} onClick={() => { void native.chatgpt.back(); }} />
              <IconButton label="Forward" icon="arrow-right" size="sm" tooltipPlacement="top" disabled={!view?.canGoForward} onClick={() => { void native.chatgpt.forward(); }} />
              <IconButton label="Reload" icon="refresh" size="sm" tooltipPlacement="top" onClick={() => { void native.chatgpt.reload(); }} />
            </>
          ) : null}
          {current ? (
            <IconButton
              label="Open in your browser"
              icon="external"
              size="sm"
              tooltipPlacement="top"
              onClick={openInBrowser}
            />
          ) : null}
          <IconButton label={maximized ? 'Restore ChatGPT pane' : 'Maximize ChatGPT pane'} icon={maximized ? 'minimize' : 'maximize'} size="sm" tooltipPlacement="top" pressed={maximized} onClick={onToggleMaximize} />
        </div>
      </header>

      {status ? (
        <div className="ms-notice" data-tone={status.tone} role="status">
          {status.tone === 'busy' ? <Spinner /> : <Icon name={status.tone === 'error' ? 'circle-alert' : 'info'} />}
          <span className="ms-notice__text">{status.text}</span>
        </div>
      ) : null}
      {unmapped && !status ? (
        <div className="ms-notice" role="status">
          <Icon name="info" />
          <span className="ms-notice__text">This page is not one of {project.name}&apos;s conversations. Handoffs still go to the one you mapped.</span>
          <span className="ms-notice__actions">
            {selected ? <Button size="sm" variant="ghost" onClick={() => choose(selected.id)}>Back to {selected.title}</Button> : null}
            {canMap ? <Button size="sm" variant="ghost" onClick={() => { void mapThisPage(); }}>Add to {project.name}</Button> : null}
          </span>
        </div>
      ) : null}

      {conversations.length === 0 ? (
        <div className="ms-pane__body">
          <EmptyState center action={<Button onClick={() => openProjectDialog({ mode: 'edit', projectId: project.id })}>Add a conversation</Button>}>
            No ChatGPT conversation is mapped to {project.name}. Add the address of the conversation you use for it.
          </EmptyState>
        </div>
      ) : embedded ? (
        <div className="ms-pane__body ms-pane__body--native" ref={bodyRef} data-native-slot aria-label="Embedded ChatGPT view" />
      ) : (
        <ExternalPanel conversations={conversations} preferredId={project.preferredConversationId} embeddedUnavailable={mode === 'embedded'} onOpen={(c) => { void openExternal(c); }} />
      )}
    </section>
  );
}

function ExternalPanel({ conversations, preferredId, embeddedUnavailable, onOpen }: { conversations: Conversation[]; preferredId: string | null; embeddedUnavailable: boolean; onOpen: (c: Conversation) => void }) {
  return (
    <div className="ms-pane__body ms-external">
      <h2 className="ms-external__title">ChatGPT opens in your browser</h2>
      <p className="ms-external__text">
        {embeddedUnavailable
          ? 'The embedded ChatGPT view is only available in the desktop app.'
          : 'External browser mode is on. Mini-Summa opens the conversation you choose and never reads or writes in the page.'}
      </p>
      <ul className="ms-rows" aria-label="Mapped conversations">
        {conversations.map((c) => (
          <li key={c.id} className="ms-row-item">
            <span className="ms-row-item__main">
              <span className="ms-truncate">{c.title}</span>
              <span className="ms-row-item__sub">{c.id === preferredId ? 'Preferred' : ''}</span>
            </span>
            <Button size="sm" icon="external" onClick={() => onOpen(c)} aria-label={`Open ${c.title}`}>Open</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
