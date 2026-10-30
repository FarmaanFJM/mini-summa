import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Rect } from '@minisumma/shared';
import { useNative } from '../../app/native';
import { setNativeBounds } from '../../app/nativeBounds';

const round = (n: number): number => Math.round(n * 100) / 100;
const same = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (a !== null && b !== null && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01);

/**
 * Tells the native ChatGPT view where its pane is. The pane body is an empty, measured element; the native view is laid
 * over that rectangle. It is reported after every render, on resize, on scroll, and on a slow timer as a safety net for
 * moves that fire no event. When the element is hidden, absent or `enabled` is false the view is hidden (null).
 */
export function useNativeBounds(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  const native = useNative();
  const last = useRef<Rect | null | undefined>(undefined);

  const report = useCallback(() => {
    const el = ref.current;
    let rect: Rect | null = null;
    if (enabled && el) {
      const r = el.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) rect = { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
    }
    if (last.current !== undefined && same(rect, last.current)) return;
    last.current = rect;
    setNativeBounds(rect);
    void Promise.resolve(native.chatgpt.setBounds(rect)).catch(() => { /* the next report tries again */ });
  }, [enabled, native, ref]);

  useLayoutEffect(() => { report(); });

  useEffect(() => {
    if (!enabled) return undefined;
    const el = ref.current;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(report) : null;
    if (el) observer?.observe(el);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    const poll = window.setInterval(report, 1000);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      window.clearInterval(poll);
    };
  }, [enabled, report, ref]);

  // Leaving the screen hides the native view.
  useEffect(() => () => {
    last.current = undefined;
    setNativeBounds(null);
    void Promise.resolve(native.chatgpt.setBounds(null)).catch(() => {});
  }, [native]);
}
