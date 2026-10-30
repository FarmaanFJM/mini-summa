import { describe, expect, it } from 'vitest';
import { decideOrientation, LANDSCAPE_THRESHOLD, onlyPane, toggleMaximized } from '../../src/renderer/src/features/workspace/layout';
import {
  clampRatio, DEFAULT_RATIO, MAX_RATIO, MIN_RATIO, ratioAfterKey, ratioFromPointer, roundRatio,
} from '../../src/renderer/src/ui/splitMath';
import { computePosition } from '../../src/renderer/src/ui/popover';

describe('decideOrientation', () => {
  it('goes landscape when the area is at least 1.15 times wider than tall', () => {
    expect(LANDSCAPE_THRESHOLD).toBe(1.15);
    expect(decideOrientation('auto', { width: 1150, height: 1000 })).toBe('landscape');
    expect(decideOrientation('auto', { width: 1180, height: 860 })).toBe('landscape');
  });

  it('goes portrait just below the threshold and for tall areas', () => {
    expect(decideOrientation('auto', { width: 1149, height: 1000 })).toBe('portrait');
    expect(decideOrientation('auto', { width: 640, height: 1100 })).toBe('portrait');
    expect(decideOrientation('auto', { width: 800, height: 800 })).toBe('portrait');
  });

  it('lets a manual choice win over the shape', () => {
    expect(decideOrientation('landscape', { width: 400, height: 1000 })).toBe('landscape');
    expect(decideOrientation('portrait', { width: 2000, height: 500 })).toBe('portrait');
  });

  it('treats an area without a size (hidden) as landscape rather than guessing', () => {
    expect(decideOrientation('auto', { width: 0, height: 0 })).toBe('landscape');
    expect(decideOrientation('auto', { width: 500, height: 0 })).toBe('landscape');
  });
});

describe('ratio clamping', () => {
  it('keeps ratios between 0.15 and 0.85', () => {
    expect(MIN_RATIO).toBe(0.15);
    expect(MAX_RATIO).toBe(0.85);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.01)).toBe(0.15);
    expect(clampRatio(0.99)).toBe(0.85);
    expect(clampRatio(-3)).toBe(0.15);
  });

  it('falls back to an even split for anything that is not a number', () => {
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RATIO);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RATIO);
  });

  it('rounds to a tenth of a percent so stored values stay tidy', () => {
    expect(roundRatio(0.123456)).toBe(0.123);
    expect(roundRatio(0.5)).toBe(0.5);
  });

  it('turns a pointer position into a ratio that accounts for the divider', () => {
    // 1000px area, 9px divider: the pointer holds the middle of the divider.
    expect(ratioFromPointer(500, 1000, 9)).toBeCloseTo(0.5, 2);
    expect(ratioFromPointer(0, 1000, 9)).toBe(0.15);
    expect(ratioFromPointer(1000, 1000, 9)).toBe(0.85);
    expect(ratioFromPointer(300, 0, 9)).toBe(DEFAULT_RATIO);
  });

  it('steps by 2 percent, 10 with Shift, and jumps to the ends with Home and End', () => {
    expect(ratioAfterKey('ArrowRight', 0.5, 'horizontal', false)).toBe(0.52);
    expect(ratioAfterKey('ArrowLeft', 0.5, 'horizontal', false)).toBe(0.48);
    expect(ratioAfterKey('ArrowRight', 0.5, 'horizontal', true)).toBe(0.6);
    expect(ratioAfterKey('ArrowDown', 0.5, 'vertical', false)).toBe(0.52);
    expect(ratioAfterKey('ArrowUp', 0.5, 'vertical', false)).toBe(0.48);
    expect(ratioAfterKey('Home', 0.5, 'horizontal', false)).toBe(MIN_RATIO);
    expect(ratioAfterKey('End', 0.5, 'horizontal', false)).toBe(MAX_RATIO);
  });

  it('answers only the axis the divider lies on, and never leaves the range', () => {
    expect(ratioAfterKey('ArrowUp', 0.5, 'horizontal', false)).toBeNull();
    expect(ratioAfterKey('ArrowLeft', 0.5, 'vertical', false)).toBeNull();
    expect(ratioAfterKey('a', 0.5, 'horizontal', false)).toBeNull();
    expect(ratioAfterKey('ArrowRight', 0.84, 'horizontal', true)).toBe(0.85);
    expect(ratioAfterKey('ArrowLeft', 0.16, 'horizontal', true)).toBe(0.15);
  });
});

describe('maximising a pane', () => {
  it('toggles: the same pane again restores the split', () => {
    expect(toggleMaximized(null, 'claude')).toBe('claude');
    expect(toggleMaximized('claude', 'claude')).toBeNull();
    expect(toggleMaximized('claude', 'chatgpt')).toBe('chatgpt');
  });

  it('shows ChatGPT (first child) or Claude (second child) alone', () => {
    expect(onlyPane('chatgpt')).toBe('first');
    expect(onlyPane('claude')).toBe('second');
    expect(onlyPane(null)).toBeNull();
  });
});

describe('computePosition', () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = { left: 100, top: 100, width: 80, height: 30 };
  const size = { width: 200, height: 150 };

  it('opens below the anchor when there is room', () => {
    expect(computePosition(anchor, size, viewport, 'bottom-start')).toMatchObject({ left: 100, top: 134, placement: 'bottom-start' });
  });

  it('flips above when it would run off the bottom', () => {
    const low = { left: 100, top: 700, width: 80, height: 30 };
    const pos = computePosition(low, size, viewport, 'bottom-start');
    expect(pos.placement).toBe('top-start');
    expect(pos.top).toBe(700 - 150 - 4);
  });

  it('stays inside the viewport horizontally', () => {
    const right = { left: 950, top: 100, width: 40, height: 30 };
    expect(computePosition(right, size, viewport, 'bottom-start').left).toBe(1000 - 200 - 8);
  });

  it('moves away from the native view when the opposite side fits and is clear of it', () => {
    const middle = { left: 100, top: 400, width: 80, height: 30 };
    const avoid = { x: 0, y: 440, width: 400, height: 300 };
    const pos = computePosition(middle, size, viewport, 'bottom-start', { avoid });
    expect(pos.placement).toBe('top-start');
    expect(pos.overlapsAvoid).toBe(false);
  });

  it('keeps the preferred side when the other would not fit, even if that overlaps the native view', () => {
    const avoid = { x: 0, y: 130, width: 400, height: 600 };
    const pos = computePosition(anchor, size, viewport, 'bottom-start', { avoid });
    expect(pos.placement).toBe('bottom-start');
    expect(pos.overlapsAvoid).toBe(true);
  });

  it('reports an overlap when neither side avoids the native view, so the caller can hide it', () => {
    const avoid = { x: 0, y: 0, width: 1000, height: 800 };
    expect(computePosition(anchor, size, viewport, 'bottom-start', { avoid }).overlapsAvoid).toBe(true);
  });
});
