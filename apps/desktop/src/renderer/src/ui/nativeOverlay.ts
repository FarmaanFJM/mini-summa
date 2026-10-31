// The embedded ChatGPT view is a native layer and always draws above web content. Anything that floats over it (dialogs,
// menus, tooltips, toasts) asks the host to hide the view while it is open. Several overlays can be open at once, so the
// requests are reference counted: the host hears "active" when the first opens and "inactive" when the last closes.
import { useLayoutEffect } from 'react';
import { useNative } from '../app/native';

export interface OverlayHost { setOverlayActive(active: boolean): Promise<void> }

const counts = new WeakMap<OverlayHost, number>();

function tell(host: OverlayHost, active: boolean): void {
  try {
    void Promise.resolve(host.setOverlayActive(active)).catch(() => { /* the view stays as it was; nothing else to do */ });
  } catch { /* a host that throws synchronously is treated the same */ }
}

/** Register one overlay. Returns the function that unregisters it (safe to call more than once). */
export function acquireNativeOverlay(host: OverlayHost): () => void {
  const next = (counts.get(host) ?? 0) + 1;
  counts.set(host, next);
  if (next === 1) tell(host, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = Math.max(0, (counts.get(host) ?? 1) - 1);
    counts.set(host, left);
    if (left === 0) tell(host, false);
  };
}

export function overlayCount(host: OverlayHost): number { return counts.get(host) ?? 0; }

/** While `active` is true the native ChatGPT view is hidden so this overlay is not drawn underneath it. */
export function useNativeOverlay(active: boolean): void {
  const native = useNative();
  const host = native.chatgpt;
  useLayoutEffect(() => {
    if (!active) return undefined;
    return acquireNativeOverlay(host);
  }, [active, host]);
}
