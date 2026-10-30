/** Sliding-window limiter: at most `max` hits in any `windowMs`. One instance per limited thing (not per caller). */
export function createSlidingWindowLimiter(opts: { max: number; windowMs: number; now: () => number }) {
  const hits: number[] = [];
  return {
    /** Records an attempt. When over the limit the attempt is NOT recorded, and `retryAfterSec` says when to retry. */
    take(): { ok: true } | { ok: false; retryAfterSec: number } {
      const now = opts.now();
      while (hits.length && now - hits[0] >= opts.windowMs) hits.shift();
      if (hits.length >= opts.max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0] + opts.windowMs - now) / 1000)) };
      }
      hits.push(now);
      return { ok: true };
    },
  };
}
