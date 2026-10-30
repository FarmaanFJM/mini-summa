// View state that is not persisted and not the core's business: which session tabs are open, which pane has focus.
import type { SessionKey, SessionView } from '@minisumma/shared';
import { createStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { isStartingUp } from '../features/workspace/sessionModel';
import { closeTab, emptyTabs, openTab, replaceTab, withAutoTabs } from '../features/workspace/tabs';
import type { TabModel } from '../features/workspace/tabs';

export type PaneId = 'chatgpt' | 'claude';

export type ProjectDialogState = { mode: 'create' } | { mode: 'edit'; projectId: string };

/** When this window first saw a managed terminal without a state ("Starting"), and which run of the terminal that was. */
export interface StartingMark { since: number; run: string | null }

export interface UiState extends TabModel {
  /** The pane the person last interacted with. A neutral marker only; it never decides where input goes. */
  focusedPane: PaneId | null;
  /** The project dialog is opened from the sidebar and from empty states, and rendered once by the shell. */
  projectDialog: ProjectDialogState | null;
  /** A request to put keyboard focus into a terminal (after a tab click, a new session, a resume). Consumed by its slot. */
  terminalFocus: { key: SessionKey; nonce: number } | null;
  /** Managed terminals that are still starting, with the moment each was first seen so. Drives the "answer in the terminal" hint. */
  startingSince: Record<string, StartingMark>;
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

/** The previous marks, kept for sessions that are still starting in the same run; new ones start now. */
export function nextStartingMarks(previous: Record<string, StartingMark>, sessions: readonly SessionView[], now: number): Record<string, StartingMark> {
  const next: Record<string, StartingMark> = {};
  let same = true;
  for (const s of sessions) {
    if (!isStartingUp(s)) continue;
    const kept = previous[s.key];
    // A resume writes a new startedAt: that is a new run, so the clock starts again.
    const mark = kept && kept.run === s.startedAt ? kept : { since: now, run: s.startedAt };
    if (mark !== kept) same = false;
    next[s.key] = mark;
  }
  return same && Object.keys(next).length === Object.keys(previous).length ? previous : next;
}

export function createUiStore(now: () => number = Date.now): UiStore {
  return createStore<UiState & UiActions>((set, get) => ({
    ...emptyTabs(),
    focusedPane: null,
    projectDialog: null,
    terminalFocus: null,
    startingSince: {},
    noteSessions(sessions) {
      const current = get();
      const next = withAutoTabs({ openTabs: current.openTabs, dismissed: current.dismissed }, sessions);
      const starting = nextStartingMarks(current.startingSince, sessions, now());
      if (next.openTabs !== current.openTabs || starting !== current.startingSince) set({ openTabs: next.openTabs, startingSince: starting });
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
