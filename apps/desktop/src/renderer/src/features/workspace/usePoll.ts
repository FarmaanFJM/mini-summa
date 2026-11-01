import { useEffect, useRef } from 'react';

/** Calls `fn` now and then every `ms` while `active`, never overlapping itself. Stops on unmount. */
export function usePoll(fn: () => Promise<unknown>, active: boolean, ms: number): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try { await latest.current(); } catch { /* the next tick tries again */ }
      if (!stopped) timer = setTimeout(() => { void tick(); }, ms);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [active, ms]);
}
