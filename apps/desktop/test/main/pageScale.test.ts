// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AUTO_MIN_ZOOM, AUTO_TARGET_CSS_WIDTH, chooseZoomFactor, isPageScale, PAGE_SCALES, sameZoom } from '../../src/main/pageScale.ts';

describe('the two judgements are pinned', () => {
  // They are guesses about ChatGPT, not measurements of it (see pageScale.ts and docs/CHATGPT_PANE.md). Changing either is a decision,
  // so it has to change this test and the page of the documentation that states them.
  it('Automatic aims for 900 CSS pixels and never goes below 70 percent', () => {
    expect(AUTO_TARGET_CSS_WIDTH).toBe(900);
    expect(AUTO_MIN_ZOOM).toBe(0.7);
  });
});

describe('fixed sizes', () => {
  it.each([['100', 1], ['90', 0.9], ['80', 0.8], ['70', 0.7]] as const)('%s percent is exactly %s, whatever the pane', (scale, factor) => {
    for (const width of [null, 0, 1, 300, 565, 630, 899, 900, 1400, 5000, Number.NaN]) expect(chooseZoomFactor(scale, width)).toBe(factor);
  });
});

describe('Automatic', () => {
  it('leaves a pane of 900 DIP or more at 100 percent', () => {
    for (const width of [900, 901, 1000, 1280, 1600, 1920, 3840, 100_000]) expect(chooseZoomFactor('auto', width)).toBe(1);
  });

  it('zooms a narrower pane out just enough for the page to get 900 CSS pixels', () => {
    // 800 DIP: 800 / 900 = 88.9 percent, rounded down to 88; the page then gets 800 / 0.88 = 909 CSS pixels.
    expect(chooseZoomFactor('auto', 800)).toBe(0.88);
    expect(chooseZoomFactor('auto', 700)).toBe(0.77);
    expect(chooseZoomFactor('auto', 899)).toBe(0.99);
    expect(chooseZoomFactor('auto', 720)).toBe(0.8);
    expect(chooseZoomFactor('auto', 810)).toBe(0.9);
  });

  it('reaches the floor at 630 DIP (630 / 900 is exactly 70 percent) and stays there for anything narrower', () => {
    expect(chooseZoomFactor('auto', 630)).toBe(0.7);
    expect(chooseZoomFactor('auto', 629)).toBe(0.7);
    expect(chooseZoomFactor('auto', 565)).toBe(0.7);
    expect(chooseZoomFactor('auto', 350)).toBe(0.7);
    expect(chooseZoomFactor('auto', 1)).toBe(0.7);
  });

  it('is 100 percent when the width is not known or makes no sense, instead of guessing', () => {
    for (const width of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(chooseZoomFactor('auto', width)).toBe(1);
  });

  it('never leaves the range 70 to 100 percent, never shrinks a wider pane more than a narrower one, and moves in whole percents', () => {
    let previous = 0;
    for (let width = 1; width <= 1200; width += 1) {
      const zoom = chooseZoomFactor('auto', width);
      expect(zoom).toBeGreaterThanOrEqual(0.7);
      expect(zoom).toBeLessThanOrEqual(1);
      expect(zoom).toBeGreaterThanOrEqual(previous);
      expect(Math.abs(zoom * 100 - Math.round(zoom * 100))).toBeLessThan(1e-9);
      previous = zoom;
    }
  });

  it('gives the page at least 900 CSS pixels wherever the floor does not bind, and as much as the floor allows where it does', () => {
    for (let width = 630; width < 900; width += 1) {
      const css = width / chooseZoomFactor('auto', width);
      expect(css, `pane ${width} DIP`).toBeGreaterThanOrEqual(AUTO_TARGET_CSS_WIDTH - 1e-9);
      expect(css, `pane ${width} DIP`).toBeLessThan(AUTO_TARGET_CSS_WIDTH * 1.02); // not wastefully small: within about 2 percent of the target
    }
    for (let width = 1; width < 630; width += 1) expect(width / chooseZoomFactor('auto', width), `pane ${width} DIP`).toBeCloseTo(width / AUTO_MIN_ZOOM, 9);
  });

  it('the cases of the report: a split pane on a 1280 to 1440 window, and 1920 pixels at 150 percent scaling', () => {
    // 1280 wide window, 260 sidebar, two panes of about 505 DIP; 1440 wide: about 585 DIP. 1920 at 150 percent is 1280 DIP, the same window.
    expect(1280 - 260 > 0 && chooseZoomFactor('auto', 505)).toBe(0.7);
    expect(chooseZoomFactor('auto', 585)).toBe(0.7);
    expect(Math.round(585 / chooseZoomFactor('auto', 585))).toBe(836);
    // A 1920 DIP wide window splits into panes of about 825 DIP: zoomed out a little.
    expect(chooseZoomFactor('auto', 825)).toBe(0.91);
  });

  it('a stored value this build does not know behaves like Automatic', () => {
    expect(chooseZoomFactor('150' as never, 600)).toBe(0.7);
    expect(chooseZoomFactor('150' as never, 1000)).toBe(1);
  });
});

describe('isPageScale / sameZoom', () => {
  it('knows the five settings and nothing else', () => {
    expect(PAGE_SCALES).toEqual(['auto', '100', '90', '80', '70']);
    for (const scale of PAGE_SCALES) expect(isPageScale(scale)).toBe(true);
    for (const other of ['', 'AUTO', '110', '60', 100, null, undefined, {}]) expect(isPageScale(other)).toBe(false);
  });

  it('treats factors that Chromium would round to the same level as the same', () => {
    expect(sameZoom(0.88, 0.88)).toBe(true);
    expect(sameZoom(0.88, 0.8800000000000001)).toBe(true);
    expect(sameZoom(0.88, 0.89)).toBe(false);
    expect(sameZoom(1, 0.9)).toBe(false);
  });
});
