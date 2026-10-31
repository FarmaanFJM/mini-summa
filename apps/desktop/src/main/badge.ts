// Windows has no numeric app badge; the closest thing is a small overlay on the taskbar button. A dot is drawn here (no
// font or image asset needed) and the count goes into the overlay's accessible description. Best effort: NOT TESTED
// on a real Windows taskbar.
const SIZE = 16;
// Brand emerald (#10b981) as premultiplied BGRA, which is what nativeImage.createFromBitmap expects.
const BGR = [0x81, 0xb9, 0x10] as const;

export function badgeDescription(count: number): string {
  return count === 1 ? '1 item needs your attention' : `${count} items need your attention`;
}

/** A 16x16 anti-aliased disc, BGRA premultiplied. */
export function badgeBitmap(): { width: number; height: number; data: Buffer } {
  const data = Buffer.alloc(SIZE * SIZE * 4);
  const c = (SIZE - 1) / 2;
  const radius = 6.5;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.min(1, Math.max(0, radius + 0.5 - d));
      const i = (y * SIZE + x) * 4;
      data[i] = Math.round(BGR[0] * alpha);
      data[i + 1] = Math.round(BGR[1] * alpha);
      data[i + 2] = Math.round(BGR[2] * alpha);
      data[i + 3] = Math.round(255 * alpha);
    }
  }
  return { width: SIZE, height: SIZE, data };
}

/** What the badge needs from the running core. */
export interface BadgeSource {
  counts(): { actionsNeeded: number };
  /** Called whenever the counts may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Keeps the badge equal to the number of sessions that wait for the person (permission, input, error), from the moment it is
 * called and whenever the core's counts change. `apply` is only called when the number differs from the last one applied, so a
 * burst of count events draws the overlay once. Returns the function that stops watching.
 */
export function watchBadge(source: BadgeSource, apply: (count: number) => void): () => void {
  let last: number | null = null;
  const update = (): void => {
    const count = Math.max(0, Math.floor(source.counts().actionsNeeded));
    if (count === last) return;
    last = count;
    apply(count);
  };
  update();
  return source.subscribe(update);
}
