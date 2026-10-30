import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { getNativeBounds } from '../app/nativeBounds';
import { cx } from './cx';
import { useNativeOverlay } from './nativeOverlay';
import { boxOf, computePosition } from './popover';
import type { Placement } from './popover';

export type PopoverDismissReason = 'outside' | 'escape' | 'blur' | 'resize';

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  open: boolean;
  /** An element to attach to, or a point (context menu). */
  anchor: Element | { x: number; y: number } | null;
  placement?: Placement;
  onDismiss: (reason: PopoverDismissReason) => void;
  children: ReactNode;
  /** Give the surface at least the width of its anchor (dropdowns). */
  matchAnchorWidth?: boolean;
  surfaceRef?: Ref<HTMLDivElement>;
  /** Surface styling: a menu surface by default. */
  variant?: 'menu' | 'plain';
}

/**
 * A floating surface in a portal, positioned next to its anchor, flipped when there is no room and moved away from the
 * native ChatGPT view when it can be. When it still overlaps the native view, that view is hidden while it is open.
 */
export function Popover({ open, anchor, placement = 'bottom-start', onDismiss, children, matchAnchorWidth, surfaceRef, variant = 'menu', className, ...rest }: PopoverProps) {
  const local = useRef<HTMLDivElement | null>(null);
  const [overlapsNative, setOverlapsNative] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  const setRef = (node: HTMLDivElement | null) => {
    local.current = node;
    if (typeof surfaceRef === 'function') surfaceRef(node);
    else if (surfaceRef) (surfaceRef as { current: HTMLDivElement | null }).current = node;
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    const el = local.current;
    if (!el) return undefined;
    const update = () => {
      const box = anchor instanceof Element ? boxOf(anchor) : anchor ? { left: anchor.x, top: anchor.y, width: 0, height: 0 } : { left: 0, top: 0, width: 0, height: 0 };
      if (matchAnchorWidth && anchor instanceof Element) el.style.minWidth = `${Math.round(box.width)}px`;
      const pos = computePosition(box, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement, { avoid: getNativeBounds() });
      el.style.left = `${Math.round(pos.left)}px`;
      el.style.top = `${Math.round(pos.top)}px`;
      el.style.visibility = 'visible';
      setOverlapsNative(pos.overlapsAvoid);
    };
    update();
    // The list may change size while open (search filtering), so keep it placed.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [open, anchor, placement, matchAnchorWidth]);

  useNativeOverlay(open && overlapsNative);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (local.current?.contains(target)) return;
      if (anchor instanceof Element && anchor.contains(target)) return; // the trigger toggles itself
      dismiss.current('outside');
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss.current('escape'); };
    const onBlur = () => dismiss.current('blur'); // focus moved into the native view or another window
    const onResize = () => dismiss.current('resize');
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
    };
  }, [open, anchor]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      {...rest}
      ref={setRef}
      className={cx(variant === 'menu' && 'sm-menu sm-menu--floating', variant === 'plain' && 'ms-popover', className)}
      style={{ left: 0, top: 0, visibility: 'hidden', ...rest.style }}
    >
      {children}
    </div>,
    document.body,
  );
}
