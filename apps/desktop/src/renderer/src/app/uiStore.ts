// View state that is not persisted and not the core's business: which session tabs are open, which pane has focus.
import type { SessionKey, SessionView } from '@minisumma/shared';
import { createStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { closeTab, emptyTabs, openTab, replaceTab, withAutoTabs } from '../features/workspace/tabs';
import type { TabModel } from '../features/workspace/tabs';

export type PaneId = 'chatgpt' | 'claude';

export type ProjectDialogState = { mode: 'create' } | { mode: 'edit'; projectId: string };

export interface UiState extends TabModel {
  /** The pane the person last interacted with. A neutral marker only; it never decides where input goes. */
  focusedPane: PaneId | null;
  /** The project dialog is opened from the sidebar and from empty states, and rendered once by the shell. */
  projectDialog: ProjectDialogState | null;
  /** A request to put keyboard focus into a terminal (after a tab click, a new session, a resume). Consumed by its slot. */
  terminalFocus: { key: SessionKey; nonce: number } | null;
}

export interface UiActions {
  /** Called with every sessions update: opens tabs for newly live managed sessions. */
  noteSessions(sessions: readonly SessionView[]): void;
  openTab(projectId: string, key: SessionKey): void;
  closeTab(projectId: string, key: SessionKey): void;
  replaceTab(projectId: string, oldKey: SessionKey, newKey: SessionKey): void;
  setFocusedPane(pane: PaneId | null): void;
  openProjectDialog(state: ProjectDialogState): void;
  closeProjectDialog(): void;
  focusTerminal(key: SessionKey): void;
}

export type UiStore = StoreApi<UiState & UiActions>;

export function createUiStore(): UiStore {
  return createStore<UiState & UiActions>((set, get) => ({
    ...emptyTabs(),
    focusedPane: null,
    projectDialog: null,
    terminalFocus: null,
    noteSessions(sessions) {
      const current = get();
      const next = withAutoTabs({ openTabs: current.openTabs, dismissed: current.dismissed }, sessions);
      if (next.openTabs !== current.openTabs) set({ openTabs: next.openTabs });
    },
    openTab(projectId, key) { set((s) => openTab(s, projectId, key)); },
    closeTab(projectId, key) { set((s) => closeTab(s, projectId, key)); },
    replaceTab(projectId, oldKey, newKey) { set((s) => replaceTab(s, projectId, oldKey, newKey)); },
    setFocusedPane(pane) { if (get().focusedPane !== pane) set({ focusedPane: pane }); },
    openProjectDialog(state) { set({ projectDialog: state }); },
    closeProjectDialog() { set({ projectDialog: null }); },
    focusTerminal(key) { set((s) => ({ terminalFocus: { key, nonce: (s.terminalFocus?.nonce ?? 0) + 1 } })); },
  }));
}
