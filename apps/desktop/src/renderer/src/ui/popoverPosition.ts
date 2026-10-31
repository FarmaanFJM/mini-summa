// Placement of floating surfaces (menus, listboxes, tooltips). Pure, so it is tested without a layout engine.
import type { Rect } from '@minisumma/shared';
import { rectsOverlap } from '../app/nativeBounds';

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top' | 'right-start' | 'left-start';

export interface Box { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }

export interface PositionOptions {
  gap?: number;
  /** Minimum distance kept from the viewport edges. */
  margin?: number;
  /** A region to stay clear of when another placement can (the native ChatGPT view draws above web content). */
  avoid?: Rect | null;
}

export interface Position { left: number; top: number; placement: Placement; /** True when the surface still overlaps `avoid`. */ overlapsAvoid: boolean }

const OPPOSITE: Record<Placement, Placement> = {
  'bottom-start': 'top-start', 'bottom-end': 'top-end', bottom: 'top',
  'top-start': 'bottom-start', 'top-end': 'bottom-end', top: 'bottom',
  'right-start': 'left-start', 'left-start': 'right-start',
};

function place(anchor: Box, size: Size, placement: Placement, gap: number): { left: number; top: number } {
  switch (placement) {
    case 'bottom-start': return { left: anchor.left, top: anchor.top + anchor.height + gap };
    case 'bottom-end': return { left: anchor.left + anchor.width - size.width, top: anchor.top + anchor.height + gap };
    case 'bottom': return { left: anchor.left + (anchor.width - size.width) / 2, top: anchor.top + anchor.height + gap };
    case 'top-start': return { left: anchor.left, top: anchor.top - size.height - gap };
    case 'top-end': return { left: anchor.left + anchor.width - size.width, top: anchor.top - size.height - gap };
    case 'top': return { left: anchor.left + (anchor.width - size.width) / 2, top: anchor.top - size.height - gap };
    case 'right-start': return { left: anchor.left + anchor.width + gap, top: anchor.top };
    case 'left-start': return { left: anchor.left - size.width - gap, top: anchor.top };
  }
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(v, Math.max(min, max)));

function fits(pos: { left: number; top: number }, size: Size, viewport: Size, margin: number): boolean {
  return pos.left >= margin - 0.5 && pos.top >= margin - 0.5
    && pos.left + size.width <= viewport.width - margin + 0.5 && pos.top + size.height <= viewport.height - margin + 0.5;
}

export function computePosition(anchor: Box, size: Size, viewport: Size, preferred: Placement, opts: PositionOptions = {}): Position {
  const gap = opts.gap ?? 4;
  const margin = opts.margin ?? 8;
  const avoid = opts.avoid ?? null;
  const finish = (placement: Placement): Position => {
    const raw = place(anchor, size, placement, gap);
    const left = clamp(raw.left, margin, viewport.width - size.width - margin);
    const top = clamp(raw.top, margin, viewport.height - size.height - margin);
    const overlapsAvoid = avoid !== null && rectsOverlap({ x: left, y: top, width: size.width, height: size.height }, avoid);
    return { left, top, placement, overlapsAvoid };
  };

  const first = finish(preferred);
  const flipped = finish(OPPOSITE[preferred]);
  const firstFits = fits(place(anchor, size, preferred, gap), size, viewport, margin);
  const flippedFits = fits(place(anchor, size, OPPOSITE[preferred], gap), size, viewport, margin);

  // Prefer a placement that fits and stays clear of the native view; then one that merely fits (the caller then hides the
  // native view); then the preferred one, clamped into the viewport.
  if (firstFits && !first.overlapsAvoid) return first;
  if (flippedFits && !flipped.overlapsAvoid) return flipped;
  if (firstFits) return first;
  if (flippedFits) return flipped;
  return first;
}

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
