// Ratio arithmetic for split panes. Pure, so keyboard steps and clamping are tested without a DOM.
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
export const DEFAULT_RATIO = 0.5;
export const KEY_STEP = 0.02;
export const KEY_STEP_LARGE = 0.1;

/** Keep a split ratio inside 0.15 to 0.85. Anything that is not a finite number falls back to an even split. */
export function clampRatio(value: number, min = MIN_RATIO, max = MAX_RATIO): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  return Math.min(max, Math.max(min, value));
}

/** Round to a tenth of a percent so persisted values do not carry floating point noise. */
export function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The ratio for a pointer position. `offset` is the pointer distance from the container start; the divider takes
 * `dividerSize` out of the space the two panes share, and the pointer is taken to hold the middle of the divider.
 */
export function ratioFromPointer(offset: number, containerSize: number, dividerSize: number): number {
  const usable = containerSize - dividerSize;
  if (!(usable > 0)) return DEFAULT_RATIO;
  return clampRatio(roundRatio((offset - dividerSize / 2) / usable));
}

export type SplitKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * The ratio after a key press, or null when the key means nothing for this splitter. A side-by-side split (the divider
 * is a vertical line) answers Left and Right; a stacked split answers Up and Down.
 */
export function ratioAfterKey(key: string, current: number, axis: 'horizontal' | 'vertical', large: boolean): number | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  if (key === 'Home') return MIN_RATIO;
  if (key === 'End') return MAX_RATIO;
  const dec = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const inc = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  if (key === dec) return clampRatio(roundRatio(current - step));
  if (key === inc) return clampRatio(roundRatio(current + step));
  return null;
}
