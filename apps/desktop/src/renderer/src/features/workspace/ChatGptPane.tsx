import { parseChatGptUrl, sameChatGptPage } from '@minisumma/shared';
import type { ChatGptViewState, Conversation, Project } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNative } from '../../app/native';
import { conversationsOf } from '../../app/selectors';
import { useApi, useApp, useRoute, useRuntime, useUi } from '../../app/runtime';
import { Button, EmptyState, Icon, IconButton, Select, Spinner, toast } from '../../ui';
import { describeStatus } from './chatgptStatus';
import { useNativeBounds } from './useNativeBounds';

export interface ChatGptPaneProps {
  project: Project;
  /** On screen: the workspace is the current view and the other pane is not shown alone. */
  visible: boolean;
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

/**
 * What the pane shows for a project, in this order: a conversation mapped to it (the page for reports to go to), else the ChatGPT
 * Project the person linked (its page, nothing of it imported or synced), else nothing and a way to add either. A project needs
 * neither to be complete.
 */
export function ChatGptPane({ project, visible }: ChatGptPaneProps) {
  const native = useNative();
  const api = useApi();
  const route = useRoute();
  const setFocusedPane = useUi((s) => s.setFocusedPane);
  const focused = useUi((s) => s.focusedPane === 'chatgpt');
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const mode = useApp((s) => s.settings?.chatgpt.mode ?? 'embedded');
  const allConversations = useApp((s) => s.conversations);
  const conversations = useMemo(() => conversationsOf(allConversations, project.id), [allConversations, project.id]);
  const selected = pickConversation(conversations, project, route.conversationByProject[project.id]);
  const linked = project.chatgptProject;
  const hasPage = selected !== null || linked !== null;

  const embedded = mode === 'embedded' && native.hasEmbeddedChatGpt;
  const view = useChatGptViewState(embedded);
  const bodyRef = useRef<HTMLDivElement>(null);
  useNativeBounds(bodyRef, embedded && visible && hasPage);

  // The conversation the view really shows may be another one of this project (a handoff opened it): follow reality.
  const shown = view?.url ? conversations.find((c) => sameChatGptPage(c.url, view.url ?? '')) ?? null : null;
  const current = shown ?? selected;

  // The page to load for the project: its mapped conversation, else its linked ChatGPT Project.
  const desired = selected
    ? { marker: `${selected.id}|${selected.url}`, url: selected.url }
    : linked ? { marker: `project|${linked.url}`, url: linked.url } : null;

  // Load it when the project or the choice changes, but never reload a page that is already there. This pane owns what the view
  // shows: when the project settings ask for the linked ChatGPT Project's page ("Open"), the pane loads that instead of the
  // project's conversation, and takes it as the page the person is on, so the conversation does not replace it afterwards.
  const lastNavigated = useRef<string | null>(null);
  const desiredMarker = desired?.marker ?? null;
  const desiredUrl = desired?.url ?? null;
  const { route: routeStore } = useRuntime();
  const projectRequested = route.chatgptProjectOpen[project.id] === true;
  const linkedUrl = linked?.url ?? null;
  useEffect(() => {
    if (!projectRequested) return undefined;
    if (!embedded || linkedUrl === null) { routeStore.getState().finishChatGptProjectOpen(project.id); return undefined; }
    if (!visible) return undefined; // asked while another view is on screen: done as soon as the workspace is
    let cancelled = false;
    (async () => {
      const state = await native.chatgpt.getState().catch(() => null);
      if (cancelled) return;
      lastNavigated.current = desiredMarker;
      if (!(state?.url && sameChatGptPage(state.url, linkedUrl))) await native.chatgpt.navigate(linkedUrl);
      routeStore.getState().finishChatGptProjectOpen(project.id);
    })().catch(() => { routeStore.getState().finishChatGptProjectOpen(project.id); });
    return () => { cancelled = true; };
  }, [projectRequested, embedded, linkedUrl, visible, desiredMarker, native, routeStore, project.id]);

  useEffect(() => {
    if (!embedded || desiredMarker === null || desiredUrl === null || projectRequested) return undefined;
    if (lastNavigated.current === desiredMarker) return undefined;
    let cancelled = false;
    (async () => {
      const state = await native.chatgpt.getState().catch(() => null);
      if (cancelled) return;
      lastNavigated.current = desiredMarker;
      if (state?.url && sameChatGptPage(state.url, desiredUrl)) return;
      await native.chatgpt.navigate(desiredUrl);
    })().catch(() => { lastNavigated.current = null; });
    return () => { cancelled = true; };
  }, [embedded, desiredMarker, desiredUrl, projectRequested, native]);

  const choose = useCallback((id: string) => {
    const target = conversations.find((c) => c.id === id);
    if (!target) return;
    route.selectConversation(project.id, id);
    if (embedded) {
      lastNavigated.current = `${target.id}|${target.url}`;
      void native.chatgpt.navigate(target.url).catch(() => {});
    }
  }, [conversations, embedded, native, project.id, route]);

  const browserFailed = (err: unknown) => {
    toast({ title: 'Could not open your browser', body: err instanceof Error ? err.message : undefined, kind: 'error' });
  };

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

  const openProjectExternal = () => {
    if (linked) native.shell.openExternal(linked.url).catch(browserFailed);
  };

  const openInBrowser = () => {
    if (current) {
      if (!embedded) { void openExternal(current); return; }
      native.shell.openExternal(view?.url ?? current.url).catch(browserFailed);
    } else if (linked) {
      native.shell.openExternal(embedded ? view?.url ?? linked.url : linked.url).catch(browserFailed);
    }
  };

  const status = describeStatus(view);
  // A page of ChatGPT that is not one of the project's conversations. With conversations mapped it is only said (handoffs go to the
  // mapped one); with none mapped and a conversation open, it can become the one reports go to.
  const onPage = embedded && view?.status === 'ready' && view.url ? view.url : null;
  const unmapped = onPage && conversations.length > 0 && !shown ? onPage : null;
  const pageInfo = onPage ? parseChatGptUrl(onPage) : null;
  const canMap = pageInfo?.ok === true && pageInfo.info.chatgptConversationId !== null;
  const offered = onPage && conversations.length === 0 && linked && canMap ? onPage : null;

  const mapThisPage = async (url: string) => {
    try {
      await api.call('conversations.add', { params: { id: project.id }, body: { url } });
      toast({ title: `Added to ${project.name}`, kind: 'success' });
    } catch (err) {
      toast({ title: 'Could not add the conversation', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    }
  };

  const openSettings = () => openProjectDialog({ mode: 'edit', projectId: project.id });

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
          ) : current ? (
            <span className="ms-pane__current ms-truncate" title={current.title}>{current.title}</span>
          ) : linked ? (
            <span className="ms-pane__current ms-truncate" title={linked.title}>{linked.title}</span>
          ) : null}
        </div>
        {hasPage ? (
          <div className="ms-pane__tools">
            {embedded ? (
              <>
                <IconButton label="Back" icon="arrow-left" size="sm" tooltipPlacement="top" disabled={!view?.canGoBack} onClick={() => { void native.chatgpt.back(); }} />
                <IconButton label="Forward" icon="arrow-right" size="sm" tooltipPlacement="top" disabled={!view?.canGoForward} onClick={() => { void native.chatgpt.forward(); }} />
                <IconButton label="Reload" icon="refresh" size="sm" tooltipPlacement="top" onClick={() => { void native.chatgpt.reload(); }} />
              </>
            ) : null}
            <IconButton label="Open in your browser" icon="external" size="sm" tooltipPlacement="top" onClick={openInBrowser} />
          </div>
        ) : null}
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
            {canMap ? <Button size="sm" variant="ghost" onClick={() => { void mapThisPage(unmapped); }}>Add to {project.name}</Button> : null}
          </span>
        </div>
      ) : null}
      {offered && !status ? (
        <div className="ms-notice" role="status">
          <Icon name="info" />
          <span className="ms-notice__text">No conversation receives reports for {project.name} yet.</span>
          <span className="ms-notice__actions">
            <Button size="sm" variant="ghost" onClick={() => { void mapThisPage(offered); }}>Use this conversation for reports</Button>
          </span>
        </div>
      ) : null}

      {!hasPage ? (
        <div className="ms-pane__body ms-pane__empty">
          <EmptyState
            center
            action={(
              <div className="ms-ws-starts">
                <Button onClick={openSettings}>Link a ChatGPT Project</Button>
                <Button onClick={openSettings}>Add a conversation</Button>
              </div>
            )}
          >
            This project has no ChatGPT Project or conversation yet.
          </EmptyState>
        </div>
      ) : embedded ? (
        <div className="ms-pane__body ms-pane__body--native" ref={bodyRef} data-native-slot aria-label="Embedded ChatGPT view" />
      ) : (
        <ExternalPanel
          conversations={conversations}
          preferredId={project.preferredConversationId}
          linkedTitle={linked?.title ?? null}
          embeddedUnavailable={mode === 'embedded'}
          onOpen={(c) => { void openExternal(c); }}
          onOpenProject={openProjectExternal}
        />
      )}
    </section>
  );
}

interface ExternalPanelProps {
  conversations: Conversation[];
  preferredId: string | null;
  /** The title of the linked ChatGPT Project, when the project has one. */
  linkedTitle: string | null;
  embeddedUnavailable: boolean;
  onOpen: (c: Conversation) => void;
  onOpenProject: () => void;
}

function ExternalPanel({ conversations, preferredId, linkedTitle, embeddedUnavailable, onOpen, onOpenProject }: ExternalPanelProps) {
  return (
    <div className="ms-pane__body ms-external">
      <h2 className="ms-external__title">ChatGPT opens in your browser</h2>
      <p className="ms-external__text">
        {embeddedUnavailable
          ? 'The embedded ChatGPT view is only available in the desktop app.'
          : 'External browser mode is on. Mini-Summa opens the conversation you choose and never reads or writes in the page.'}
      </p>
      {conversations.length > 0 ? (
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
      ) : null}
      {linkedTitle !== null ? (
        <ul className="ms-rows" aria-label="Linked ChatGPT Project">
          <li className="ms-row-item">
            <span className="ms-row-item__main">
              <span className="ms-truncate">{linkedTitle}</span>
              <span className="ms-row-item__sub">ChatGPT Project</span>
            </span>
            <Button size="sm" icon="external" onClick={onOpenProject} aria-label="Open ChatGPT Project">Open</Button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
