// Leaving the app. Managed Claude terminals end with the app (they are children of this process), so quitting while any
// run asks first and never claims they survive. The core is stopped before the process exits so that it can record why each
// terminal ended and so that the terminals really are ended (on Windows a terminal's whole process tree is killed with taskkill
// inside core.stop(); a process that exits while that is still running leaves the tree behind). The ChatGPT login is flushed to
// disk so it is still there next time.
//
// The process therefore never exits while core.stop() is pending, on any path: the window close, the tray, a second app.quit()
// and the system ending the session. The one exception is the person's own answer to "still closing, keep waiting?", asked only
// after the stop has taken far longer than it should, so that a stop that never finishes cannot leave an invisible process
// holding the port and the database.
import type { Logger } from './log.ts';

export interface QuitDeps {
  /** Number of managed Claude terminals that are running right now. */
  countTerminals(): number;
  /** Ask the user. Resolves true to go ahead. */
  confirm(terminals: number): Promise<boolean>;
  /** Stops the core: HTTP, the managed terminals (Windows: their process trees), the database. The process does not exit before it settles. */
  stopCore(): Promise<void>;
  /** Persist cookies and storage of the embedded ChatGPT session. */
  flushStorage(): Promise<void>;
  exit(code: number): void;
  /**
   * Called once the decision to quit is final (after any confirmation) and before the slow part. Stopping the core takes a
   * moment (and longer with terminals to end), and a window that stays on screen meanwhile looks frozen or shows a lost
   * connection. Hiding it first makes closing the window look like closing it.
   */
  hideWindow?(): void;
  /**
   * The core has been stopping for longer than `stopPatienceMs`. Resolves true to keep waiting, false to quit anyway (a terminal
   * may then be left running). Without it the flow keeps waiting. Not used when the system ends the session: nobody can answer.
   */
  keepWaiting?(waitedMs: number): Promise<boolean>;
  log: Logger;
  /** How long the core may take before the person is asked whether to keep waiting. Default 20 s; a normal stop takes a few seconds. */
  stopPatienceMs?: number;
}

export interface QuitFlow {
  /** Window close, tray Quit, Ctrl+Q, a second app.quit(): all come here. Safe to call repeatedly. */
  request(): Promise<void>;
  /**
   * The operating system is ending the session (Windows shutdown, log-off, or an installer asking the app to close). Nobody can
   * be asked: no dialog; the core is stopped, however long that takes (the system ends the process when it has waited long
   * enough), and then the process exits. Electron does not emit `before-quit` for this on Windows, so this is the only path that runs.
   */
  endSession(): Promise<void>;
  readonly quitting: boolean;
}

/** Terminals that end when the app ends: Mini-Summa's own, still running. External sessions are not ours to end. */
export function countRunningTerminals(sessions: readonly { origin: string; availability: string; terminal: { exited: boolean } | null }[]): number {
  return sessions.filter((s) => s.origin === 'managed' && s.availability === 'live' && s.terminal !== null && !s.terminal.exited).length;
}

export function quitDialogText(terminals: number): { message: string; detail: string; confirm: string; cancel: string } {
  const one = terminals === 1;
  return {
    message: 'Quit Mini-Summa?',
    detail: `Closing Mini-Summa ends ${terminals} running Claude ${one ? 'terminal' : 'terminals'}. ${one ? 'It' : 'They'} can be resumed later.`,
    confirm: one ? 'Quit and end terminal' : 'Quit and end terminals',
    cancel: 'Cancel',
  };
}

const withTimeout = async (work: Promise<unknown>, ms: number, onTimeout: () => void): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { onTimeout(); resolve(); }, ms); });
  try { await Promise.race([work.then(() => undefined), timeout]); } finally { clearTimeout(timer); }
};

const SESSION_END_FLUSH_MS = 1000;

export function createQuitFlow(deps: QuitDeps): QuitFlow {
  let quitting = false;
  let asking = false;
  const patienceMs = deps.stopPatienceMs ?? 20_000;
  const hide = (): void => {
    try { deps.hideWindow?.(); } catch (err) { deps.log.warn('hiding the window failed', { error: err }); }
  };

  /**
   * Starts the stop and waits until it has settled (resolved or failed). If it takes longer than the patience, the person is asked
   * (when someone can be asked) whether to keep waiting. Returns false only when they chose to quit with the stop still pending.
   */
  async function stopCore(canAsk: boolean): Promise<boolean> {
    const started = Date.now();
    let settled = false;
    const stopping = Promise.resolve()
      .then(() => deps.stopCore())
      .then(() => undefined, (err) => { deps.log.error('core stop failed', { error: err }); })
      .finally(() => { settled = true; });
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const slow = new Promise<'slow'>((resolve) => { timer = setTimeout(() => resolve('slow'), patienceMs); });
      const winner = await Promise.race([stopping.then(() => 'done' as const), slow]);
      clearTimeout(timer);
      if (winner === 'done') return true;
      const waitedMs = Date.now() - started;
      deps.log.warn('the core is still stopping; not exiting yet', { waitedMs });
      if (!canAsk || !deps.keepWaiting) continue;
      const answer = deps.keepWaiting(waitedMs).then(
        (keep) => ({ keep }),
        (err) => { deps.log.warn('asking whether to keep waiting failed', { error: err }); return { keep: true }; },
      );
      // If the stop finishes while the question is open, the answer no longer matters: leave at once (the dialog goes with the process).
      const first = await Promise.race([answer, stopping.then(() => ({ done: true as const }))]);
      if ('done' in first || settled) return true;
      if (!first.keep) {
        deps.log.error('quitting while the core is still stopping; managed terminals may be left running', { waitedMs: Date.now() - started });
        return false;
      }
    }
  }

  return {
    get quitting() { return quitting; },
    async request() {
      if (quitting || asking) return;
      const terminals = deps.countTerminals();
      if (terminals > 0) {
        asking = true;
        try {
          if (!(await deps.confirm(terminals))) return;
        } finally { asking = false; }
        // The system may have ended the session while the question was open; that path has already taken over.
        if (quitting) return;
      }
      quitting = true;
      deps.log.info('quitting', { terminals });
      hide();
      await stopCore(true);
      try { await withTimeout(deps.flushStorage(), 3000, () => deps.log.warn('storage flush timed out')); } catch (err) {
        deps.log.warn('storage flush failed', { error: err });
      }
      deps.exit(0);
    },

    async endSession() {
      if (quitting) return;
      quitting = true;
      deps.log.info('the system is ending the session; stopping without asking');
      hide();
      // No question and no limit of its own: Windows ends this process when it has waited long enough, and until then the
      // terminals' process trees are better ended than left behind.
      await stopCore(false);
      try { await withTimeout(deps.flushStorage(), SESSION_END_FLUSH_MS, () => deps.log.warn('storage flush timed out at session end')); } catch (err) {
        deps.log.warn('storage flush failed at session end', { error: err });
      }
      deps.exit(0);
    },
  };
}
