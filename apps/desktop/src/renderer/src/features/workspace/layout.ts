// Layout decisions for the workspace, as pure functions.
import type { LayoutOrientation } from '@minisumma/shared';

export { clampRatio, MIN_RATIO, MAX_RATIO, DEFAULT_RATIO, roundRatio } from '../../ui/splitMath';

export type ResolvedOrientation = 'landscape' | 'portrait';

/** The panes sit side by side once the area is clearly wider than tall. */
export const LANDSCAPE_THRESHOLD = 1.15;

/**
 * Automatic mode looks at the shape of the pane area, not the window or the screen: landscape when width is at least
 * 1.15 times the height. A manual choice always wins. An area with no size yet (hidden) counts as landscape.
 */
export function decideOrientation(preference: LayoutOrientation, size: { width: number; height: number }): ResolvedOrientation {
  if (preference === 'landscape' || preference === 'portrait') return preference;
  if (!(size.width > 0) || !(size.height > 0)) return 'landscape';
  return size.width >= LANDSCAPE_THRESHOLD * size.height ? 'landscape' : 'portrait';
}

export const ORIENTATION_LABEL: Record<LayoutOrientation, string> = {
  auto: 'Automatic',
  landscape: 'Side by side',
  portrait: 'Stacked',
};

export type PaneName = 'chatgpt' | 'claude';

/** Maximising a pane that is already maximised restores the split. */
export const toggleMaximized = (current: PaneName | null, pane: PaneName): PaneName | null => (current === pane ? null : pane);

/** Which pane the SplitPane hides when `maximized` is set. */
export const collapsedFor = (maximized: PaneName | null): 'first' | 'second' | null =>
  maximized === 'chatgpt' ? 'second' : maximized === 'claude' ? 'first' : null;
