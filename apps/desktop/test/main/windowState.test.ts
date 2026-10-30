// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, loadWindowState, MIN_WINDOW, placeWindow, sanitizeSavedState, saveWindowState } from '../../src/main/windowState.ts';

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const right = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

describe('sanitizeSavedState', () => {
  it('keeps a plausible state', () => {
    expect(sanitizeSavedState({ x: 10, y: 20, width: 1200, height: 800, maximized: true })).toEqual({ x: 10, y: 20, width: 1200, height: 800, maximized: true });
  });
  it('rounds and drops a position it cannot trust', () => {
    expect(sanitizeSavedState({ x: 10.4, y: 20.6, width: 1200.2, height: 800.7 })).toEqual({ x: 10, y: 21, width: 1200, height: 801, maximized: false });
    expect(sanitizeSavedState({ x: 'a', y: 2, width: 1200, height: 800 })).toMatchObject({ x: null, y: null });
    expect(sanitizeSavedState({ x: 5e6, y: 0, width: 1200, height: 800 })).toMatchObject({ x: null, y: null });
  });
  it.each([null, 5, 'x', [], {}, { width: 100, height: 100 }, { width: 99999, height: 800 }, { width: NaN, height: 800 }, { width: '1200', height: '800' }])(
    'rejects %j', (raw) => { expect(sanitizeSavedState(raw)).toBeNull(); },
  );
});

describe('placeWindow', () => {
  it('uses the defaults when nothing was saved', () => {
    expect(placeWindow(null, [primary])).toEqual({ width: DEFAULT_WINDOW.width, height: DEFAULT_WINDOW.height, maximized: false });
  });

  it('shrinks the default to fit a small screen but never below the minimum', () => {
    const small = { workArea: { x: 0, y: 0, width: 1100, height: 700 } };
    expect(placeWindow(null, [small])).toMatchObject({ width: 1100, height: 700 });
    const tiny = { workArea: { x: 0, y: 0, width: 800, height: 500 } };
    expect(placeWindow(null, [tiny])).toMatchObject({ width: MIN_WINDOW.width, height: MIN_WINDOW.height });
  });

  it('restores the saved position when it is still on a display', () => {
    const saved = { x: 100, y: 80, width: 1300, height: 850, maximized: false };
    expect(placeWindow(saved, [primary])).toEqual({ x: 100, y: 80, width: 1300, height: 850, maximized: false });
  });

  it('restores a position on a second display', () => {
    const saved = { x: 2200, y: 100, width: 1300, height: 850, maximized: true };
    expect(placeWindow(saved, [primary, right])).toEqual({ x: 2200, y: 100, width: 1300, height: 850, maximized: true });
  });

  it('drops the position when that display is gone but keeps the size', () => {
    const saved = { x: 2200, y: 100, width: 1300, height: 850, maximized: false };
    expect(placeWindow(saved, [primary])).toEqual({ width: 1300, height: 850, maximized: false });
  });

  it('drops a position that is only a sliver on screen', () => {
    const saved = { x: 1900, y: 100, width: 1300, height: 850, maximized: false };
    const r = placeWindow(saved, [primary]);
    expect(r.x).toBeUndefined();
    expect(r.y).toBeUndefined();
  });

  it('drops a position whose title bar is below the visible area', () => {
    const saved = { x: 100, y: 1030, width: 1300, height: 850, maximized: false };
    expect(placeWindow(saved, [primary]).y).toBeUndefined();
  });

  it('shrinks a saved size that no longer fits the display it sits on', () => {
    const saved = { x: 0, y: 0, width: 4000, height: 2000, maximized: false };
    expect(placeWindow(saved, [primary])).toMatchObject({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('keeps the maximized flag even when the position is dropped', () => {
    expect(placeWindow({ x: 9000, y: 9000, width: 1200, height: 800, maximized: true }, [primary]).maximized).toBe(true);
  });

  it('copes with no displays at all', () => {
    expect(placeWindow({ x: 0, y: 0, width: 1200, height: 800, maximized: false }, [])).toEqual({ width: 1200, height: 800, maximized: false });
  });
});

describe('load and save', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-win-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('round-trips through a file', () => {
    const file = path.join(tmp(), 'nested', 'window-state.json');
    const state = { x: 5, y: 6, width: 1111, height: 777, maximized: true };
    expect(saveWindowState(file, state)).toBe(true);
    expect(loadWindowState(file)).toEqual(state);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['window-state.json']);
  });

  it('treats a missing or corrupt file as no state', () => {
    const dir = tmp();
    expect(loadWindowState(path.join(dir, 'missing.json'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    expect(loadWindowState(path.join(dir, 'bad.json'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'odd.json'), JSON.stringify({ width: 'wide' }));
    expect(loadWindowState(path.join(dir, 'odd.json'))).toBeNull();
  });

  it('reports a failed save instead of throwing', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    expect(saveWindowState(path.join(blocker, 'sub', 'state.json'), { x: 0, y: 0, width: 1000, height: 700, maximized: false })).toBe(false);
  });
});
