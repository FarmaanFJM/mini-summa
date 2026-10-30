// Placing the native ChatGPT view over a rectangle the renderer measured.
//
// The renderer measures in CSS pixels relative to its own viewport (getBoundingClientRect). Electron places native
// views in device independent pixels (DIP) relative to the window content area. The two differ by exactly the page zoom
// factor: DIP = CSS px * zoomFactor. The display's DPI scale does not enter the conversion, because Electron multiplies
// DIP by the display scale itself when it reaches the screen; a 150% display and a 100% display give the same DIP numbers.
//
// Electron takes integer DIP. Edges are rounded rather than sizes, so two panes that touch in CSS pixels still touch
// after conversion, and the result is clamped into the content area so a stale rectangle can never hang outside the
// window while the renderer catches up with a resize.
import type { Rect } from '@minisumma/shared';

export interface ContentSize { width: number; height: number }

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const LIMIT = 1_000_000;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function isUsableRect(r: unknown): r is Rect {
  if (typeof r !== 'object' || r === null) return false;
  const { x, y, width, height } = r as Record<string, unknown>;
  return finite(x) && finite(y) && finite(width) && finite(height)
    && width >= 0 && height >= 0 && Math.abs(x) < LIMIT && Math.abs(y) < LIMIT && width < LIMIT && height < LIMIT;
}

export function clampZoom(zoomFactor: number): number {
  return finite(zoomFactor) && zoomFactor > 0 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomFactor)) : 1;
}

/** The rectangle to hand to View.setBounds, or null when nothing of it is inside the content area. */
export function toViewBounds(rect: Rect, zoomFactor: number, content: ContentSize): Rect | null {
  if (!isUsableRect(rect)) return null;
  const z = clampZoom(zoomFactor);
  const maxW = Math.max(0, Math.floor(content.width));
  const maxH = Math.max(0, Math.floor(content.height));
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
  const left = clamp(Math.round(rect.x * z), maxW);
  const top = clamp(Math.round(rect.y * z), maxH);
  const right = clamp(Math.round((rect.x + rect.width) * z), maxW);
  const bottom = clamp(Math.round((rect.y + rect.height) * z), maxH);
  const width = right - left;
  const height = bottom - top;
  return width >= 1 && height >= 1 ? { x: left, y: top, width, height } : null;
}

export const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
