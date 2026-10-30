// Remembering the main window's size, position and maximized state.
//
// The saved file can be stale: a monitor may have been unplugged or the resolution changed since. A saved position is
// used only if a useful part of the window would still be on some display; otherwise the size is kept and the system
// places the window.
import fs from 'node:fs';
import path from 'node:path';
import type { Rect } from '@minisumma/shared';

export interface SavedWindowState { x: number | null; y: number | null; width: number; height: number; maximized: boolean }

export interface WindowPlacement { x?: number; y?: number; width: number; height: number; maximized: boolean }

export interface DisplayArea { workArea: Rect }

export const MIN_WINDOW = { width: 960, height: 600 } as const;
export const DEFAULT_WINDOW = { width: 1440, height: 900 } as const;
const HARD_MAX = 20_000;

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** Reads whatever was saved; anything that is not a plausible state is dropped. */
export function sanitizeSavedState(raw: unknown): SavedWindowState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const width = int(r.width);
  const height = int(r.height);
  if (width === null || height === null || width < 200 || height < 150 || width > HARD_MAX || height > HARD_MAX) return null;
  const x = int(r.x);
  const y = int(r.y);
  const positioned = x !== null && y !== null && Math.abs(x) < HARD_MAX && Math.abs(y) < HARD_MAX;
  return { x: positioned ? x : null, y: positioned ? y : null, width, height, maximized: r.maximized === true };
}

const overlap = (a: Rect, b: Rect): { w: number; h: number } => ({
  w: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
  h: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
});

/**
 * Turns a saved state into window options. `displays` are the current work areas (taskbar excluded). With no saved
 * state, or no display to look at, the defaults are used and the system chooses the position.
 */
export function placeWindow(saved: SavedWindowState | null, displays: readonly DisplayArea[]): WindowPlacement {
  const areas = displays.map((d) => d.workArea).filter((a) => a.width > 0 && a.height > 0);
  const fit = (size: { width: number; height: number }, within: Rect | undefined) => ({
    width: Math.max(MIN_WINDOW.width, Math.min(size.width, within?.width ?? size.width)),
    height: Math.max(MIN_WINDOW.height, Math.min(size.height, within?.height ?? size.height)),
  });
  if (!saved) return { ...fit(DEFAULT_WINDOW, areas[0]), maximized: false };

  const size = fit(saved, undefined);
  if (saved.x !== null && saved.y !== null) {
    const rect: Rect = { x: saved.x, y: saved.y, ...size };
    // "Useful part on screen": at least a quarter of the window's width and a title bar's height on one display.
    const needW = Math.min(size.width / 4, 320);
    const needH = Math.min(size.height / 4, 120);
    const host = areas.find((a) => { const o = overlap(rect, a); return o.w >= needW && o.h >= needH; });
    if (host) {
      const clamped = fit(size, host);
      return { x: saved.x, y: saved.y, ...clamped, maximized: saved.maximized };
    }
  }
  return { ...fit(size, areas[0]), maximized: saved.maximized };
}

export function loadWindowState(file: string): SavedWindowState | null {
  try { return sanitizeSavedState(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

/** Atomic: write a sibling file, then rename over the target. A failed save is never worth interrupting the user for. */
export function saveWindowState(file: string, state: SavedWindowState): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
