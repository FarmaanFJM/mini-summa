// Getting the user's attention onto the right place. A notification click, a tray item, a minisumma:// link or a second
// launch all end up here: bring the window forward first (restore if minimized, show if hidden, focus), then tell the
// renderer what to show. If the renderer is not ready yet (still loading, or the window does not exist yet) the latest
// target is held and delivered the moment it is.
import type { NavigationTarget } from '@minisumma/shared';
import { CH } from './channels.ts';
import type { Logger } from './log.ts';

export interface RoutableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void };
}

export interface WindowRouter {
  /** Restore, show and focus the window. False when there is no window to reveal. */
  reveal(): boolean;
  /** Reveal, then deliver now or as soon as the renderer is ready. */
  navigate(target: NavigationTarget): void;
  /** Told by the window code when the renderer page has finished loading (true) or started loading again (false). */
  setRendererReady(ready: boolean): void;
  pending(): NavigationTarget | null;
}

export function createWindowRouter(getWindow: () => RoutableWindow | null, log: Logger): WindowRouter {
  let ready = false;
  let queued: NavigationTarget | null = null;

  const live = (): RoutableWindow | null => {
    const w = getWindow();
    return w && !w.isDestroyed() && !w.webContents.isDestroyed() ? w : null;
  };

  const deliver = (): void => {
    const w = live();
    if (!w || !ready || queued === null) return;
    const target = queued;
    queued = null;
    w.webContents.send(CH.navigate, target);
  };

  const reveal = (): boolean => {
    const w = live();
    if (!w) return false;
    // Order matters: a minimized window must be restored before it can be shown or focused.
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    w.focus();
    return true;
  };

  return {
    reveal,
    navigate(target) {
      queued = target;
      if (!reveal()) log.info('navigation held: no window yet');
      deliver();
    },
    setRendererReady(value) {
      ready = value;
      if (value) deliver();
    },
    pending: () => queued,
  };
}
