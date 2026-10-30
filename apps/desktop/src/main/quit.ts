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
  log: Logger;
  stopTimeoutMs?: number;
}

export interface QuitFlow {
  /** Window close, tray Quit, Ctrl+Q, a second app.quit(): all come here. Safe to call repeatedly. */
  request(): Promise<void>;
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

export function createQuitFlow(deps: QuitDeps): QuitFlow {
  let quitting = false;
  let asking = false;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;

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
      }
      quitting = true;
      deps.log.info('quitting', { terminals });
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
  };
}
