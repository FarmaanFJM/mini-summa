import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getNativeBounds } from '../app/nativeBounds';
import { cx } from './cx';
import { useNativeOverlay } from './nativeOverlay';
import { boxOf, computePosition } from './popover';
import type { Placement } from './popover';

const SHOW_DELAY_MS = 450;
let closeCurrent: (() => void) | null = null;

/** Only keyboard focus shows a tooltip at once. Older engines without :focus-visible are treated as keyboard focus. */
function isFocusVisible(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return true; }
}

export interface TooltipProps {
  content: ReactNode;
  /** The element the tooltip describes. It receives aria-describedby while the tip is visible. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: Placement;
  /** Disable without removing the wrapper (for example when the control already shows its label). */
  disabled?: boolean;
}

/**
 * Short, non-interactive description of a control. Appears after a hover delay or at once on keyboard focus, closes on
 * Esc, press, leave or blur. It moves away from the native ChatGPT view when it can, and hides that view when it cannot.
 */
export function Tooltip({ content, children, placement = 'bottom', disabled }: TooltipProps) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [overlaps, setOverlaps] = useState(false);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  }, []);

  const show = useCallback((delay: number) => {
    if (disabled) return;
    if (timer.current) clearTimeout(timer.current);
    const reveal = () => {
      closeCurrent?.();
      closeCurrent = hide;
      setOpen(true);
    };
    if (delay <= 0) reveal(); else timer.current = setTimeout(reveal, delay);
  }, [disabled, hide]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (closeCurrent === hide) closeCurrent = null;
  }, [hide]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hide]);

  useEffect(() => {
    if (!open) return;
    const target = wrap.current?.firstElementChild;
    const el = tip.current;
    if (!target || !el) return;
    const pos = computePosition(boxOf(target), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement, { gap: 6, avoid: getNativeBounds() });
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
    el.style.visibility = 'visible';
    setOverlaps(pos.overlapsAvoid);
  }, [open, placement]);

  useNativeOverlay(open && overlaps);

  const child = isValidElement(children) && open ? cloneElement(children, { 'aria-describedby': id }) : children;
  return (
    <>
      <span
        ref={wrap}
        className="ms-tooltip-wrap"
        onPointerEnter={(e) => { if (e.pointerType !== 'touch') show(SHOW_DELAY_MS); }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(e) => { if (isFocusVisible(e.target)) show(0); }}
        onBlur={hide}
      >
        {child}
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <div ref={tip} id={id} role="tooltip" className={cx('ms-tooltip')} style={{ left: 0, top: 0, visibility: 'hidden' }}>{content}</div>,
          document.body,
        )
        : null}
    </>
  );
}
