// The rectangles the panes last reported to their native views, kept so that floating UI (menus, tooltips, toasts) can tell
// whether it would be drawn underneath a native layer. There are two native views: the ChatGPT page and Claude Code on the web.
// A view that is hidden has no rectangle.
import type { Rect } from '@minisumma/shared';

export type NativeViewId = 'chatgpt' | 'claudeWeb';

const views = new Map<NativeViewId, Rect>();

/** Record where a native view is now (null: it is hidden). The ChatGPT view is the default, as it was when it was the only one. */
export function setNativeBounds(rect: Rect | null, view: NativeViewId = 'chatgpt'): void {
  if (rect === null) views.delete(view); else views.set(view, rect);
}

/** Forget every view (tests, and a window that is going away). */
export function clearNativeBounds(): void { views.clear(); }

/** Do two rectangles share any area? Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const visible = (r: Rect): boolean => r.width > 0 && r.height > 0;

/** The rectangles of the native views that are on screen. */
export function nativeViewRects(): Rect[] { return [...views.values()].filter(visible); }

/**
 * The area the native views cover, as one rectangle: the view itself when one is on screen, the box around both when two are
 * (floating UI asks for one rectangle to stay clear of, and a box that is too big only makes it hide the views sooner, never
 * draw underneath one). null means no native view is on screen.
 */
export function getNativeBounds(): Rect | null {
  const list = [...views.values()];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const left = Math.min(...list.map((r) => r.x));
  const top = Math.min(...list.map((r) => r.y));
  const right = Math.max(...list.map((r) => r.x + r.width));
  const bottom = Math.max(...list.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Would an element at this rectangle be covered by a native view right now? Each view is checked on its own. */
export function overlapsNativeView(rect: Rect): boolean {
  return nativeViewRects().some((native) => rectsOverlap(rect, native));
}

export function toRect(box: { left: number; top: number; width: number; height: number }): Rect {
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}
