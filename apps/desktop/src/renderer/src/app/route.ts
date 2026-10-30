// Which view, project, session and report the person is looking at. Persisted (guarded) so the app reopens where it was left.
import { isSessionKey } from '@minisumma/shared';
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
  selectSession(projectId: string, key: SessionKey | null): void;
  selectConversation(projectId: string, conversationId: string | null): void;
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
  return out;
}

export function createRouteStore(options: RouteOptions = {}): RouteStore {
  const { storage, resolveSessionProject } = options;
  const saved = storage ? readJson(storage, STORAGE_KEY, validate) : null;

  const store = createStore<RouteState & RouteActions>((set, get) => ({
    view: 'workspace',
    projectId: null,
    sessionByProject: {},
    conversationByProject: {},
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
        const changedView = view !== s.view;
        return {
          view,
          projectId,
          sessionByProject,
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
    selectSession(projectId, key) {
      set((s) => {
        const next = { ...s.sessionByProject };
        if (key) next[projectId] = key; else delete next[projectId];
        return { sessionByProject: next };
      });
    },
    selectConversation(projectId, conversationId) {
      set((s) => {
        const next = { ...s.conversationByProject };
        if (conversationId) next[projectId] = conversationId; else delete next[projectId];
        return { conversationByProject: next };
      });
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
      });
    });
  }
  return store;
}
