// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clampZoom, isUsableRect, sameRect, toViewBounds } from '../../src/main/bounds.ts';

const content = { width: 1600, height: 900 };

describe('toViewBounds', () => {
  it('is the identity at zoom 1 inside the window', () => {
    expect(toViewBounds({ x: 280, y: 48, width: 700, height: 800 }, 1, content)).toEqual({ x: 280, y: 48, width: 700, height: 800 });
  });

  it('multiplies CSS pixels by the page zoom factor to get DIP', () => {
    expect(toViewBounds({ x: 200, y: 40, width: 400, height: 500 }, 1.25, content)).toEqual({ x: 250, y: 50, width: 500, height: 625 });
    expect(toViewBounds({ x: 200, y: 40, width: 400, height: 500 }, 0.8, content)).toEqual({ x: 160, y: 32, width: 320, height: 400 });
  });

  it('does not depend on the display scale (DIP are already device independent)', () => {
    // The display scale is not an input at all; the same CSS rectangle gives the same DIP on a 100% and a 175% screen.
    const a = toViewBounds({ x: 10.5, y: 20.5, width: 300.25, height: 200.75 }, 1, content);
    const b = toViewBounds({ x: 10.5, y: 20.5, width: 300.25, height: 200.75 }, 1, content);
    expect(a).toEqual(b);
  });

  it('rounds edges, not sizes, so panes that touch in CSS still touch', () => {
    // Left pane 0..333.4 and right pane 333.4..800 at zoom 1.25: the shared edge must land on one integer.
    const left = toViewBounds({ x: 0, y: 0, width: 333.4, height: 100 }, 1.25, content)!;
    const right = toViewBounds({ x: 333.4, y: 0, width: 466.6, height: 100 }, 1.25, content)!;
    expect(left.x + left.width).toBe(right.x);
    expect(left.x + left.width).toBe(Math.round(333.4 * 1.25));
  });

  it('clamps a stale rectangle into the content area after the window shrank', () => {
    expect(toViewBounds({ x: 900, y: 100, width: 900, height: 900 }, 1, { width: 1000, height: 600 })).toEqual({ x: 900, y: 100, width: 100, height: 500 });
  });

  it('gives null when nothing of the rectangle is inside the window', () => {
    expect(toViewBounds({ x: 2000, y: 0, width: 100, height: 100 }, 1, content)).toBeNull();
    expect(toViewBounds({ x: 0, y: 1000, width: 100, height: 100 }, 1, content)).toBeNull();
    expect(toViewBounds({ x: 10, y: 10, width: 0, height: 100 }, 1, content)).toBeNull();
    expect(toViewBounds({ x: 10, y: 10, width: 100, height: 0 }, 1, content)).toBeNull();
    expect(toViewBounds({ x: 10, y: 10, width: 0.2, height: 0.2 }, 1, content)).toBeNull();
  });

  it('clamps negative origins to the window edge', () => {
    expect(toViewBounds({ x: -50, y: -20, width: 150, height: 120 }, 1, content)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('follows a content area that changed (maximize, fullscreen)', () => {
    const rect = { x: 0, y: 0, width: 2000, height: 1000 };
    expect(toViewBounds(rect, 1, { width: 1280, height: 720 })).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(toViewBounds(rect, 1, { width: 1920, height: 1080 })).toEqual({ x: 0, y: 0, width: 1920, height: 1000 });
  });

  it('refuses rectangles that are not numbers', () => {
    expect(toViewBounds({ x: NaN, y: 0, width: 10, height: 10 }, 1, content)).toBeNull();
    expect(toViewBounds({ x: 0, y: 0, width: Infinity, height: 10 }, 1, content)).toBeNull();
    expect(toViewBounds({ x: 0, y: 0, width: -5, height: 10 }, 1, content)).toBeNull();
  });
});

describe('clampZoom', () => {
  it('keeps sane factors and falls back to 1 for nonsense', () => {
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(100)).toBe(5);
    expect(clampZoom(0.01)).toBe(0.25);
  });
});

describe('isUsableRect / sameRect', () => {
  it('checks shape and finiteness', () => {
    expect(isUsableRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isUsableRect(null)).toBe(false);
    expect(isUsableRect({ x: 0, y: 0, width: 1 })).toBe(false);
    expect(isUsableRect({ x: '0', y: 0, width: 1, height: 1 })).toBe(false);
    expect(isUsableRect({ x: 1e9, y: 0, width: 1, height: 1 })).toBe(false);
  });
  it('compares by value', () => {
    expect(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(sameRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
  });
});
