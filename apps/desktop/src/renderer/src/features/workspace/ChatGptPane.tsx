import { parseChatGptUrl, sameChatGptPage } from '@minisumma/shared';
import type { ChatGptProjectLink, ChatGptViewState, Conversation, Project } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatGptRecorder, recordableAddress } from '../../app/chatgptRecorder';
import { keyedChatGpt } from '../../app/keyedChatGpt';
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

export interface PageToOpen {
  /** Which rule chose it: the last page used in this project, its mapped conversation, or the linked ChatGPT Project's page. */
  from: 'last' | 'conversation' | 'project';
  url: string;
}

/**
 * The page the pane opens for a project, in this order: the last page the person was on in this project (remembered locally, and only
 * if it still belongs to the project: a page of another ChatGPT Project than the linked one is not used), else the conversation the
 * project has mapped (the one chosen last, else the preferred one), else the linked ChatGPT Project's page, else nothing.
 * `remembered` is only used when the pane is opened for the project (selecting it, starting the app); a change of the mapped
 * conversation while the pane is open is the person's explicit choice and wins, so it is asked for with `remembered: null`.
 */
export function pageToOpen(input: { projectId: string; remembered: string | null; selected: Pick<Conversation, 'url'> | null; linked: Pick<ChatGptProjectLink, 'url' | 'scopeId'> | null }): PageToOpen | null {
  const last = recordableAddress(input.remembered, { id: input.projectId, scopeId: input.linked?.scopeId ?? null });
  if (last !== null) return { from: 'last', url: last };
  if (input.selected) return { from: 'conversation', url: input.selected.url };
  if (input.linked) return { from: 'project', url: input.linked.url };
  return null;
}

function useChatGptViewState(enabled: boolean, key: string | undefined): ChatGptViewState | null {
  const native = useNative();
  const [state, setState] = useState<ChatGptViewState | null>(null);
  useEffect(() => {
    if (!enabled) { setState(null); return undefined; }
    let cancelled = false;
    setState(null); // another project's view: nothing of the previous one's page
    const chat = keyedChatGpt(native, key);
    chat.getState().then((s) => { if (!cancelled) setState(s); }, () => {});
    const off = chat.onState((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; off(); };
  }, [enabled, native, key]);
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
  const scopeId = linked?.scopeId ?? null;
  const rememberedUrl = route.chatgptUrlByProject[project.id] ?? null;
  const remembered = recordableAddress(rememberedUrl, { id: project.id, scopeId });
  const hasPage = selected !== null || linked !== null || remembered !== null;

  const embedded = mode === 'embedded' && native.hasEmbeddedChatGpt;
  // With live views (the desktop shell) each project has a ChatGPT view of its own, named by the project's id: switching projects shows
  // another view and the page, its scroll position and an unsent draft stay in the one that was left. A host with one view ignores it.
  const key = native.chatgpt.liveViews ? project.id : undefined;
  const chat = useMemo(() => keyedChatGpt(native, key), [native, key]);
  const view = useChatGptViewState(embedded, key);
  const bodyRef = useRef<HTMLDivElement>(null);
  useNativeBounds(bodyRef, embedded && visible && hasPage, 'chatgpt', key);

  // The conversation the view really shows may be another one of this project (a handoff opened it): follow reality.
  const shown = view?.url ? conversations.find((c) => sameChatGptPage(c.url, view.url ?? '')) ?? null : null;
  const current = shown ?? selected;

  const { route: routeStore, store: appStore } = useRuntime();

  // What the person does in the view is remembered per project, so that the project opens where it was left (the recorder decides
  // which pages count and guards the moment right after another project was selected, while the view still shows its page).
  const recorder = useMemo(() => new ChatGptRecorder(), []);
  const owner = useRef(0);
  const [missed, setMissed] = useState<string | null>(null);
  useEffect(() => { setMissed(null); }, [project.id]);
  useEffect(() => {
    if (!embedded) return undefined;
    let live = true;
    chat.getState().then((s) => { if (live) recorder.observe(s); }, () => {});
    const off = chat.onState((s) => {
      const hit = recorder.observe(s);
      // A report handed off to another project's conversation opens in the view on screen: that page belongs to the other project.
      const foreign = hit !== null && appStore.getState().conversations.some((c) => c.projectId !== hit.projectId && sameChatGptPage(c.url, hit.url));
      if (hit && !foreign) routeStore.getState().selectChatGptUrl(hit.projectId, hit.url);
      setMissed(recorder.missedPage(owner.current));
    });
    return () => { live = false; off(); };
  }, [embedded, chat, recorder, routeStore, appStore]);
  useEffect(() => {
    if (!embedded) return undefined;
    const token = recorder.begin({ id: project.id, scopeId });
    owner.current = token;
    return () => { recorder.end(token); };
    // The scope of the linked ChatGPT Project can change while the pane is open; that does not make the person's page a stranger's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, project.id, recorder]);
  useEffect(() => { recorder.retarget(owner.current, { id: project.id, scopeId }); }, [recorder, project.id, scopeId]);

  // The page to load for the project when its mapped conversation or linked ChatGPT Project is what is asked for.
  const normal = pageToOpen({ projectId: project.id, remembered: null, selected, linked });
  const normalMarker = normal ? `${normal.from}|${normal.from === 'conversation' ? `${selected?.id}|` : ''}${normal.url}` : null;
  const normalUrl = normal?.url ?? null;

  // Load it when the project or the choice changes, but never reload a page that is already there. This pane owns what the view
  // shows: when the project settings ask for the linked ChatGPT Project's page ("Open"), the pane loads that instead of the
  // project's conversation, and takes it as the page the person is on, so the conversation does not replace it afterwards.
  const lastNavigated = useRef<string | null>(null);
  const activated = useRef<string | null>(null);
  // Another project became the one on screen: its pane is being opened, even if the previous project's own opening never finished.
  useEffect(() => () => { activated.current = null; }, [project.id]);
  const projectRequested = route.chatgptProjectOpen[project.id] === true;
  const linkedUrl = linked?.url ?? null;
  useEffect(() => {
    if (!projectRequested) return undefined;
    if (!embedded || linkedUrl === null) { routeStore.getState().finishChatGptProjectOpen(project.id); return undefined; }
    if (!visible) return undefined; // asked while another view is on screen: done as soon as the workspace is
    let cancelled = false;
    const token = owner.current;
    (async () => {
      const state = await chat.getState().catch(() => null);
      if (cancelled) return;
      lastNavigated.current = normalMarker;
      activated.current = project.id;
      if (state?.url && sameChatGptPage(state.url, linkedUrl)) recorder.arm(token);
      else { recorder.expect(token, linkedUrl); await chat.navigate(linkedUrl); }
      routeStore.getState().finishChatGptProjectOpen(project.id);
    })().catch(() => { routeStore.getState().finishChatGptProjectOpen(project.id); });
    return () => { cancelled = true; };
  }, [projectRequested, embedded, linkedUrl, visible, normalMarker, chat, routeStore, project.id, recorder, key]);

  useEffect(() => {
    if (!embedded || projectRequested) return undefined;
    // Opening the pane for a project (selecting it, starting the app) goes back to the last page used in it; afterwards the mapped
    // conversation or the linked project is what is asked for.
    const activation = activated.current !== project.id;
    const rememberedNow = activation ? routeStore.getState().chatgptUrlByProject[project.id] ?? null : null;
    const target = pageToOpen({ projectId: project.id, remembered: rememberedNow, selected, linked });
    if (target === null) { activated.current = project.id; return undefined; }
    const marker = target.from === 'last' ? `last|${project.id}|${target.url}` : normalMarker;
    if (!activation && lastNavigated.current === marker) return undefined; // opening a project always looks; a repeat of the same request does not
    let cancelled = false;
    const token = owner.current;
    (async () => {
      const state = await chat.getState().catch(() => null);
      if (cancelled) return;
      lastNavigated.current = marker;
      activated.current = project.id;
      // A live view that already has a page is this project's own, kept while it was away: leave it as it is (its scroll position and an
      // unsent draft are in it). Only a project whose view was never loaded, or was unloaded, loads its page now.
      if (activation && key !== undefined && state?.url) { recorder.arm(token); return; }
      if (state?.url && sameChatGptPage(state.url, target.url)) { recorder.arm(token); return; }
      recorder.expect(token, target.url, { restore: target.from === 'last' });
      await chat.navigate(target.url);
    })().catch(() => { lastNavigated.current = null; });
    return () => { cancelled = true; };
    // `selected` and `linked` are read through the marker and the url: they change when the marker or the url does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, project.id, normalMarker, normalUrl, projectRequested, chat, routeStore, recorder, key]);

  const choose = useCallback((id: string) => {
    const target = conversations.find((c) => c.id === id);
    if (!target) return;
    route.selectConversation(project.id, id);
    if (embedded) {
      lastNavigated.current = `conversation|${target.id}|${target.url}`;
      recorder.expect(owner.current, target.url);
      void chat.navigate(target.url).catch(() => {});
    }
  }, [conversations, embedded, chat, project.id, route, recorder]);

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
                {linked ? <IconButton label="Open project page" icon="folder-open" size="sm" tooltipPlacement="top" onClick={() => { routeStore.getState().openChatGptProject(project.id); }} /> : null}
                <IconButton label="Back" icon="arrow-left" size="sm" tooltipPlacement="top" disabled={!view?.canGoBack} onClick={() => { void chat.back(); }} />
                <IconButton label="Forward" icon="arrow-right" size="sm" tooltipPlacement="top" disabled={!view?.canGoForward} onClick={() => { void chat.forward(); }} />
                <IconButton label="Reload" icon="refresh" size="sm" tooltipPlacement="top" onClick={() => { void chat.reload(); }} />
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
      {missed && rememberedUrl && !status ? (
        <div className="ms-notice" role="status">
          <Icon name="info" />
          <span className="ms-notice__text">ChatGPT did not open the last page of {project.name} and showed another page. The last page is still remembered until you open another one here.</span>
          <span className="ms-notice__actions">
            <Button size="sm" variant="ghost" onClick={() => { route.selectChatGptUrl(project.id, null); setMissed(null); }}>Forget the last page</Button>
          </span>
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
