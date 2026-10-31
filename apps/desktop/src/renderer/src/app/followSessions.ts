// A managed terminal can go on as another Claude session: /clear or /resume inside it replaces the conversation, the terminal (its
// process, its screen, its scrollback) stays, and the core keeps it managed under the NEW session key. The old session becomes history
// and names its successor (`replacedBy`). The window follows: the tab of the old session becomes the tab of the new one, in the same
// place, and so does the remembered choice of the project, so that the person is not left on an ended tab and a restart opens on the
// session that is running.
//
// It works on the stores, not on what is on screen, so it covers every project (not only the selected one), the order in which the two
// sessions reach the window (either may come first), and a tab or a choice that comes back later (a notification, a restored choice).
// The old session is not lost: it stays in the session list as ended history, and the Sessions menu opens it (and then it stays).
import type { RouteStore } from './route';
import type { AppStore } from './store';
import type { UiStore } from './uiStore';
import { replacementMoves } from '../features/workspace/tabs';
import type { TabMove } from '../features/workspace/tabs';
import type { TerminalRegistry } from '../terminals/terminals';

export interface SessionFollowerDeps {
  store: AppStore;
  ui: UiStore;
  route: RouteStore;
  terminals: Pick<TerminalRegistry, 'hostOf'>;
}

export interface SessionFollower {
  /** Look again now. Called by the subscriptions; exposed for tests. */
  run(): TabMove[];
  dispose(): void;
}

export function createSessionFollower({ store, ui, route, terminals }: SessionFollowerDeps): SessionFollower {
  let running = false;

  function apply(move: TabMove): void {
    const { projectId, from, to } = move;
    const chosen = route.getState().sessionByProject[projectId];
    // If the person was typing in the old terminal, they go on typing in the new one without clicking.
    const host = terminals.hostOf(from);
    const hadFocus = Boolean(host && typeof document !== 'undefined' && document.activeElement && host.contains(document.activeElement));
    ui.getState().replaceTab(projectId, from, to);
    // The remembered choice moves with the terminal; where the person is looking (the Cloud tab, say) does not.
    if (chosen === from) route.getState().selectSession(projectId, to, { keepCloud: true });
    if (hadFocus) ui.getState().focusTerminal(to);
  }

  function run(): TabMove[] {
    if (running) return [];
    running = true;
    const done: TabMove[] = [];
    try {
      // A move can make another possible (a second /clear arrives while the first is applied): look again, a few times at most.
      for (let round = 0; round < 4; round += 1) {
        const { openTabs, dismissed, history } = ui.getState();
        const moves = replacementMoves({ openTabs, dismissed }, route.getState().sessionByProject, store.getState().sessions, history);
        if (moves.length === 0) break;
        for (const move of moves) apply(move);
        done.push(...moves);
      }
    } finally { running = false; }
    return done;
  }

  const offStore = store.subscribe((state, prev) => { if (state.sessions !== prev.sessions) run(); });
  const offUi = ui.subscribe((state, prev) => { if (state.openTabs !== prev.openTabs || state.history !== prev.history) run(); });
  const offRoute = route.subscribe((state, prev) => { if (state.sessionByProject !== prev.sessionByProject) run(); });
  run();

  return { run, dispose() { offStore(); offUi(); offRoute(); } };
}
