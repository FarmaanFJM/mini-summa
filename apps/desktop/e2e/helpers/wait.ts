// Waiting on conditions. The suite never sleeps for a fixed time to "let something happen": it polls for the thing itself
// and fails with a description of what it was waiting for.

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface UntilOptions {
  /** Milliseconds before giving up. */
  timeout?: number;
  /** Milliseconds between probes. */
  interval?: number;
}

/**
 * Probes until `probe` returns something truthy, then returns it. Exceptions thrown by the probe count as "not yet" (the
 * page may be mid-navigation); the last one is part of the failure message.
 */
export async function until<T>(what: string, probe: () => T | Promise<T>, options: UntilOptions = {}): Promise<NonNullable<T>> {
  const timeout = options.timeout ?? 15_000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<T>;
      last = undefined;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeout} ms waiting for ${what}${last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ''}`);
    }
    await sleep(interval);
  }
}

/** Like `until`, but the probe returns a value to compare and the failure message shows the last value seen. */
export async function untilEqual<T>(what: string, read: () => T | Promise<T>, expected: T, options: UntilOptions = {}): Promise<void> {
  const timeout = options.timeout ?? 15_000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;
  let seen: unknown;
  for (;;) {
    try {
      seen = await read();
      if (JSON.stringify(seen) === JSON.stringify(expected)) return;
    } catch (error) {
      seen = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeout} ms waiting for ${what} to equal ${JSON.stringify(expected)}; last value ${JSON.stringify(seen)}`);
    }
    await sleep(interval);
  }
}

/** Never resolves to a value later than `ms`: a promise that must not hang a test forever. */
export async function within<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${what}`)), ms); });
  try { return await Promise.race([work, limit]); } finally { clearTimeout(timer); }
}
