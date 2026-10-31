// A virtual clock for deterministic tests: timers fire only when the test advances time, never on wall-clock time.
interface Timer { at: number; fn: () => void; every: number }

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class FakeClock {
  private t = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  readonly now = (): number => this.t;

  readonly setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn, every: 0 });
    return id;
  };

  readonly clearTimeout = (id: number | undefined | null): void => { if (id != null) this.timers.delete(id); };

  readonly setInterval = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  };

  readonly clearInterval = (id: number | undefined | null): void => { if (id != null) this.timers.delete(id); };

  /** Number of timers still waiting; tests use it to prove nothing is left running after a stop. */
  get pending(): number { return this.timers.size; }

  /** Move time forward, firing every timer that comes due in order and letting promise chains finish after each. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let nextId = -1;
      let next: Timer | null = null;
      for (const [id, tm] of this.timers) {
        if (tm.at > target) continue;
        if (!next || tm.at < next.at || (tm.at === next.at && id < nextId)) { next = tm; nextId = id; }
      }
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.every > 0) next.at += next.every; else this.timers.delete(nextId);
      next.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }

  /** Let already-resolved promises run without moving time. */
  flush(): Promise<void> { return settle(); }
}
