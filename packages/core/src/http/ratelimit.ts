/**
 * Sliding window over FAILURES. `retryAfterSec()` says whether the window is full without recording anything, and
 * `record()` adds one failure. Charging only failures means that requests which cannot guess anything (empty or invalid
 * bodies) and requests that succeed never use up the budget, so nobody can lock others out without actually trying codes.
 */
export function createFailureLimiter(opts: { max: number; windowMs: number; now: () => number }) {
  const failures: number[] = [];
  const trim = (now: number): void => { while (failures.length && now - failures[0] >= opts.windowMs) failures.shift(); };
  return {
    /** null while attempts are allowed; otherwise the seconds until the oldest failure leaves the window. */
    retryAfterSec(): number | null {
      const now = opts.now();
      trim(now);
      return failures.length >= opts.max ? Math.max(1, Math.ceil((failures[0] + opts.windowMs - now) / 1000)) : null;
    },
    record(): void {
      const now = opts.now();
      trim(now);
      failures.push(now);
      if (failures.length > opts.max * 2) failures.shift();
    },
  };
}
