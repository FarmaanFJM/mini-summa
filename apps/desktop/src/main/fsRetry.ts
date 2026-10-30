// A rename that Windows refuses for a moment.
//
// Replacing a file (write a temp file, rename it over the old one) fails on Windows with EPERM, EBUSY or EACCES while another
// program has the old file open without sharing it for delete, and also for a moment after a file is written: an antivirus scanner
// or the search indexer holds it. The refusal passes, so the rename is tried again a few times with a short pause before the error
// is reported. Nothing else is retried. (The core has the same helper in packages/core/src/claude/fsRetry.ts; the desktop shell
// keeps its own so that neither package reaches into the other.)
import fs from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Pauses of 15, 30, 60, 120, 240 and 480 ms: about 0.95 s in total before the error is reported. */
export const DEFAULT_RETRIES = 6;

export const isRenameRefusal = (err: unknown): boolean => RETRYABLE.has((err as NodeJS.ErrnoException | undefined)?.code ?? '');

/** Blocks this thread for `ms`. For the places that must stay synchronous (the window state is saved while the window closes). */
export function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RenameRetryOptions {
  /** Pauses between tries: 15 ms, doubling. Default {@link DEFAULT_RETRIES}. */
  retries?: number;
  /** Test seams. */
  rename?: (from: string, to: string) => void;
  pause?: (ms: number) => void;
}

/** fs.renameSync that survives a short refusal; any other error, and the last refusal, are thrown. */
export function renameSyncWithRetry(from: string, to: string, options: RenameRetryOptions = {}): void {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const rename = options.rename ?? fs.renameSync;
  const pause = options.pause ?? pauseSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (attempt >= retries || !isRenameRefusal(err)) throw err;
      pause(15 * 2 ** attempt);
    }
  }
}
