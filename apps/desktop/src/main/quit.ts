// Leaving the app. Managed Claude terminals end with the app (they are children of this process), so quitting while any
// run asks first and never claims they survive. The core is stopped before the process exits so that it can record why
// each terminal ended; the ChatGPT login is flushed to disk so it is still there next time.
import type { Logger } from './log.ts';

export interface QuitDeps {
  /** Number of managed Claude terminals that are running right now. */
  countTerminals(): number;
  /** Ask the user. Resolves true to go ahead. */
  confirm(terminals: number): Promise<boolean>;
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
  log: Logger;
  stopTimeoutMs?: number;
}

export interface QuitFlow {
  /** Window close, tray Quit, Ctrl+Q, a second app.quit(): all come here. Safe to call repeatedly. */
  request(): Promise<void>;
  /**
   * The operating system is ending the session (Windows shutdown, log-off, or an installer asking the app to close). There is
   * nobody to ask and no time to wait: no dialog, a short stop, then exit. Electron does not emit `before-quit` for this on
   * Windows, so this is the only path that runs.
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

/** Windows ends a process a few seconds after it has agreed to the end of the session, so the work there is cut short. */
const SESSION_END_STOP_MS = 3000;
const SESSION_END_FLUSH_MS = 1000;

export function createQuitFlow(deps: QuitDeps): QuitFlow {
  let quitting = false;
  let asking = false;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;
  const hide = (): void => {
    try { deps.hideWindow?.(); } catch (err) { deps.log.warn('hiding the window failed', { error: err }); }
  };

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
      try {
        await withTimeout(deps.stopCore(), stopTimeoutMs, () => deps.log.warn('core did not stop in time; exiting anyway'));
      } catch (err) {
        deps.log.error('core stop failed', { error: err });
      }
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
      try {
        await withTimeout(deps.stopCore(), Math.min(stopTimeoutMs, SESSION_END_STOP_MS), () => deps.log.warn('core did not stop in time at session end'));
      } catch (err) {
        deps.log.error('core stop failed at session end', { error: err });
      }
      try { await withTimeout(deps.flushStorage(), SESSION_END_FLUSH_MS, () => deps.log.warn('storage flush timed out at session end')); } catch (err) {
        deps.log.warn('storage flush failed at session end', { error: err });
      }
      deps.exit(0);
    },
  };
}
