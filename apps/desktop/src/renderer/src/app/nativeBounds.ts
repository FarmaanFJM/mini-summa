// The rectangle the ChatGPT pane last reported to the native view, kept so that floating UI (menus, tooltips, toasts)
// can tell whether it would be drawn underneath the native layer. null means the native view is hidden.
import type { Rect } from '@minisumma/shared';

let current: Rect | null = null;

export function setNativeBounds(rect: Rect | null): void { current = rect; }
export function getNativeBounds(): Rect | null { return current; }

/** Do two rectangles share any area? Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Would an element at this rectangle be covered by the native view right now? */
export function overlapsNativeView(rect: Rect): boolean {
  const native = current;
  return native !== null && native.width > 0 && native.height > 0 && rectsOverlap(rect, native);
}

export function toRect(box: { left: number; top: number; width: number; height: number }): Rect {
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}
