// Where things live, in the three layouts the app runs from: electron-vite output (dev and the smoke test) and the
// packaged app. `moduleDir` is the directory of the bundled main script (<root>/out/main, or .../app.asar/out/main).
import path from 'node:path';

export interface Locations {
  /** Built renderer, served by the core under /ui/. Inside app.asar when packaged. */
  uiDir: string;
  preloadPath: string;
  /** Window icon (PNG). */
  iconPath: string;
  trayIconPath: string;
  /** Unpacked hook script. Only set when packaged; in development the core finds the script in its own package. */
  captureScript: string | undefined;
}

export function resolveLocations(opts: { moduleDir: string; isPackaged: boolean; resourcesPath: string }): Locations {
  const root = path.resolve(opts.moduleDir, '..', '..');
  const icons = opts.isPackaged ? path.join(opts.resourcesPath, 'icons') : path.join(root, 'resources');
  return {
    uiDir: path.join(root, 'out', 'renderer'),
    preloadPath: path.join(root, 'out', 'preload', 'index.cjs'),
    iconPath: path.join(icons, 'icon.png'),
    trayIconPath: path.join(icons, 'tray.png'),
    captureScript: opts.isPackaged ? path.join(opts.resourcesPath, 'hook', 'capture.mjs') : undefined,
  };
}
