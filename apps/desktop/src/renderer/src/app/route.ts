// Which view, project, session and report the person is looking at. Persisted (guarded) so the app reopens where it was left.
import { isSessionKey, parseClaudeCodeUrl, UI_LIMITS } from '@minisumma/shared';
import type { NavigationTarget, SessionKey } from '@minisumma/shared';
import { createStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { readJson, writeJson } from './storage';
import type { KeyValueStorage } from './storage';

export type ViewId = NavigationTarget['view'];
export const VIEWS: readonly ViewId[] = ['workspace', 'activity', 'reports', 'settings'];
const STORAGE_KEY = 'minisumma.route.v1';

export interface RouteState {
  view: ViewId;
  projectId: string | null;
  /** The session each project was last showing. Selecting another project never touches these. */
  sessionByProject: Record<string, SessionKey>;
  /** The conversation each project's ChatGPT pane was last showing. */
  conversationByProject: Record<string, string>;
  /** The last page of Claude Code on the web each project's Cloud tab was on (an address on claude.ai/code, without query). */
  cloudUrlByProject: Record<string, string>;
  /**
   * Projects whose Claude pane shows the Cloud tab instead of a local session. In memory only, and never the persisted `sessionKey`:
   * choosing any session (a tab, a new session, a notification) takes the pane back to local sessions, and after a restart the pane
   * shows the last local session tab again.
   */
  cloudShown: Record<string, true>;
  /** "New cloud session" was chosen for these projects and the Cloud tab has not opened the start page for it yet. In memory only. */
  cloudStart: Record<string, true>;
  /**
   * The ChatGPT pane was asked to show the linked ChatGPT Project's page of these projects now (the project settings' "Open"). The
   * pane owns what the view shows, so it loads the page itself and clears this; a conversation it would load for the project in the
   * same moment does not take the page away. In memory only.
   */
  chatgptProjectOpen: Record<string, true>;
  reportId: string | null;
  deliveryId: string | null;
  activityId: string | null;
  /** Settings section, when the settings view has several. */
  section: string | null;
  /** Views visited before this one, newest last. `back()` pops it. In memory only. */
  previous: ViewId[];
}

export interface RouteActions {
  /** Apply a navigation target from a notification, a deep link or a click. Missing fields keep their current value. */
  go(target: Partial<NavigationTarget>): void;
  setView(view: ViewId): void;
  selectProject(projectId: string | null): void;
  /**
   * The session a project's Claude pane shows (or, with `keepCloud`, only the one it goes back to when the Cloud tab is left: a session
   * that moved on, a tab that was closed). Choosing one to look at takes the pane back from the Cloud tab.
   */
  selectSession(projectId: string, key: SessionKey | null, opts?: { keepCloud?: boolean }): void;
  selectConversation(projectId: string, conversationId: string | null): void;
  /** Remember the page of Claude Code on the web a project's Cloud tab is on (null forgets it). */
  selectCloudUrl(projectId: string, url: string | null): void;
  /** Show the Cloud tab of a project's Claude pane. `start`: open the start page of a new session (the repository preselected), not the remembered page. */
  showCloud(projectId: string, opts?: { start?: boolean }): void;
  /** Go back from the Cloud tab to the project's local sessions. */
  hideCloud(projectId: string): void;
  /** The Cloud tab has opened the start page that "New cloud session" asked for. */
  finishCloudStart(projectId: string): void;
  /** Ask the ChatGPT pane to show the project's linked ChatGPT Project now. The caller selects the project; the pane does the loading. */
  openChatGptProject(projectId: string): void;
  /** The pane has done what `openChatGptProject` asked (or cannot). */
  finishChatGptProjectOpen(projectId: string): void;
  /** Return to the view before this one (the back chevron of a view that replaced the sidebar). */
  back(fallback?: ViewId): void;
}

export type RouteStore = StoreApi<RouteState & RouteActions>;

export interface RouteOptions {
  storage?: KeyValueStorage;
  /** Finds the project a session belongs to, so a target with only a sessionKey still selects the right project. */
  resolveSessionProject?: (key: SessionKey) => string | null;
  initial?: Partial<RouteState>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validate(raw: unknown): Partial<RouteState> | null {
  if (!isRecord(raw)) return null;
  const out: Partial<RouteState> = {};
  if (typeof raw.view === 'string' && (VIEWS as readonly string[]).includes(raw.view)) out.view = raw.view as ViewId;
  if (typeof raw.projectId === 'string') out.projectId = raw.projectId;
  if (isRecord(raw.sessionByProject)) {
    out.sessionByProject = Object.fromEntries(Object.entries(raw.sessionByProject).filter((e): e is [string, SessionKey] => isSessionKey(e[1])));
  }
  if (isRecord(raw.conversationByProject)) {
    out.conversationByProject = Object.fromEntries(Object.entries(raw.conversationByProject).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  if (isRecord(raw.cloudUrlByProject)) {
    // Only a page of Claude Code on the web is kept, in its plain form: whatever else was stored is not an address this build opens.
    const pages: [string, string][] = [];
    for (const [id, value] of Object.entries(raw.cloudUrlByProject)) {
      const read = typeof value === 'string' && value.length <= UI_LIMITS.urlChars ? parseClaudeCodeUrl(value) : null;
      if (read?.ok) pages.push([id, read.info.url]);
    }
    out.cloudUrlByProject = Object.fromEntries(pages);
  }
  return out;
}

const without = <V>(map: Record<string, V>, id: string): Record<string, V> => {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
};

export function createRouteStore(options: RouteOptions = {}): RouteStore {
  const { storage, resolveSessionProject } = options;
  const saved = storage ? readJson(storage, STORAGE_KEY, validate) : null;

  const store = createStore<RouteState & RouteActions>((set, get) => ({
    view: 'workspace',
    projectId: null,
    sessionByProject: {},
    conversationByProject: {},
    cloudUrlByProject: {},
    cloudShown: {},
    cloudStart: {},
    chatgptProjectOpen: {},
    reportId: null,
    deliveryId: null,
    activityId: null,
    section: null,
    previous: [],
    ...saved,
    ...options.initial,

    go(target) {
      set((s) => {
        const view = target.view ?? s.view;
        let projectId = target.projectId ?? s.projectId;
        if (target.sessionKey && !target.projectId) projectId = resolveSessionProject?.(target.sessionKey) ?? projectId;
        const sessionByProject = target.sessionKey && projectId ? { ...s.sessionByProject, [projectId]: target.sessionKey } : s.sessionByProject;
        // A session that is named is the one to look at, even when the Cloud tab was showing.
        const cloudShown = target.sessionKey && projectId ? without(s.cloudShown, projectId) : s.cloudShown;
        const changedView = view !== s.view;
        return {
          view,
          projectId,
          sessionByProject,
          cloudShown,
          reportId: target.reportId ?? (changedView ? null : s.reportId),
          deliveryId: target.deliveryId ?? (changedView ? null : s.deliveryId),
          activityId: target.activityId ?? (changedView ? null : s.activityId),
          section: target.section ?? (changedView ? null : s.section),
          previous: changedView ? [...s.previous, s.view].slice(-10) : s.previous,
        };
      });
    },
    setView(view) { get().go({ view }); },
    selectProject(projectId) {
      set((s) => ({ projectId, view: 'workspace', previous: s.view === 'workspace' ? s.previous : [...s.previous, s.view].slice(-10) }));
    },
    selectSession(projectId, key, opts) {
      set((s) => {
        const next = { ...s.sessionByProject };
        if (key) next[projectId] = key; else delete next[projectId];
        return { sessionByProject: next, cloudShown: key && !opts?.keepCloud ? without(s.cloudShown, projectId) : s.cloudShown };
      });
    },
    selectConversation(projectId, conversationId) {
      set((s) => {
        const next = { ...s.conversationByProject };
        if (conversationId) next[projectId] = conversationId; else delete next[projectId];
        return { conversationByProject: next };
      });
    },
    selectCloudUrl(projectId, url) {
      set((s) => {
        if (url === null) return s.cloudUrlByProject[projectId] === undefined ? s : { cloudUrlByProject: without(s.cloudUrlByProject, projectId) };
        const read = parseClaudeCodeUrl(url);
        if (!read.ok || s.cloudUrlByProject[projectId] === read.info.url) return s; // not a page of Claude Code on the web, or nothing new
        return { cloudUrlByProject: { ...s.cloudUrlByProject, [projectId]: read.info.url } };
      });
    },
    showCloud(projectId, opts) {
      set((s) => ({
        cloudShown: s.cloudShown[projectId] ? s.cloudShown : { ...s.cloudShown, [projectId]: true },
        cloudStart: opts?.start ? { ...s.cloudStart, [projectId]: true } : s.cloudStart,
      }));
    },
    hideCloud(projectId) {
      set((s) => (s.cloudShown[projectId] ? { cloudShown: without(s.cloudShown, projectId) } : s));
    },
    finishCloudStart(projectId) {
      set((s) => (s.cloudStart[projectId] ? { cloudStart: without(s.cloudStart, projectId) } : s));
    },
    openChatGptProject(projectId) {
      set((s) => (s.chatgptProjectOpen[projectId] ? s : { chatgptProjectOpen: { ...s.chatgptProjectOpen, [projectId]: true } }));
    },
    finishChatGptProjectOpen(projectId) {
      set((s) => (s.chatgptProjectOpen[projectId] ? { chatgptProjectOpen: without(s.chatgptProjectOpen, projectId) } : s));
    },
    back(fallback = 'workspace') {
      set((s) => {
        const previous = s.previous.slice();
        const view = previous.pop() ?? fallback;
        return { view, previous, reportId: null, deliveryId: null, activityId: null, section: null };
      });
    },
  }));

  if (storage) {
    store.subscribe((s) => {
      writeJson(storage, STORAGE_KEY, {
        view: s.view, projectId: s.projectId, sessionByProject: s.sessionByProject, conversationByProject: s.conversationByProject,
        cloudUrlByProject: s.cloudUrlByProject,
      });
    });
  }
  return store;
}
