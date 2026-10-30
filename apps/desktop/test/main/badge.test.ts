// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { watchBadge } from '../../src/main/badge.ts';

function source(initial: number) {
  let actionsNeeded = initial;
  const listeners = new Set<() => void>();
  return {
    counts: () => ({ actionsNeeded }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (n: number) => { actionsNeeded = n; for (const l of [...listeners]) l(); },
    listeners,
  };
}

describe('the taskbar badge', () => {
  it('shows the number of sessions waiting for the person from the start, even when it is zero', () => {
    const apply = vi.fn();
    watchBadge(source(2), apply);
    expect(apply).toHaveBeenCalledExactlyOnceWith(2);
    const quiet = vi.fn();
    watchBadge(source(0), quiet);
    expect(quiet).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('follows the core as sessions start and stop waiting, and draws only when the number changed', () => {
    const src = source(0);
    const apply = vi.fn();
    watchBadge(src, apply);
    src.set(1);
    src.set(1); // another count event with the same number: nothing to redraw
    src.set(3);
    src.set(0);
    expect(apply.mock.calls.map((c) => c[0])).toEqual([0, 1, 3, 0]);
  });

  it('never shows a negative or fractional number', () => {
    const src = source(0);
    const apply = vi.fn();
    watchBadge(src, apply);
    src.set(-4);
    src.set(2.9);
    expect(apply.mock.calls.map((c) => c[0])).toEqual([0, 2]);
  });

  it('stops when told to', () => {
    const src = source(1);
    const apply = vi.fn();
    const stop = watchBadge(src, apply);
    stop();
    expect(src.listeners.size).toBe(0);
    src.set(5);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
