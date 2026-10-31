// A rename that Windows refuses for a moment.
//
// Replacing a file (write a temp file, rename it over the old one) fails on Windows with EPERM or EBUSY while another program has
// the old file open, and also for a moment after a file is written: an antivirus scanner or the search indexer holds it. The refusal
// passes, so the rename is tried again a few times with a short pause before the error is reported. Nothing else is retried.
import fs from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 6; // pauses of 15, 30, 60, 120, 240 and 480 ms: about 0.95 s before the error is reported

export const isRenameRefusal = (err: unknown): boolean => RETRYABLE.has((err as NodeJS.ErrnoException | undefined)?.code ?? '');

/** Blocks this thread for `ms`. For the few places that must stay synchronous (the settings file is written before the process starts). */
export function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** fs.renameSync that survives a short refusal. `pause` is a test seam. */
export function renameSyncWithRetry(from: string, to: string, pause: (ms: number) => void = pauseSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RETRIES || !isRenameRefusal(err)) throw err;
      pause(15 * 2 ** attempt);
    }
  }
}
