// One queue for everything that changes what the Claude layer knows: spool drains, discovery calls, rebuilds. Two passes
// never overlap, which is what keeps "ingest, then apply everything after lastAppliedSeq" and the discovery interval
// classification (a discovery call must not run while that environment's spool is being drained) correct.

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  /**
   * Runs `fn` after everything queued before it. The returned promise carries fn's result or error; the queue itself
   * always moves on, so one failing pass never blocks the next. Callers that do not await must attach a catch.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    this.waiting++;
    const result = this.tail.then(() => fn());
    this.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.waiting--; });
  }

  /** Number of passes queued or running. */
  get size(): number {
    return this.waiting;
  }

  /** Resolves once everything queued so far has finished (later additions are not awaited). */
  idle(): Promise<void> {
    return this.tail;
  }
}
