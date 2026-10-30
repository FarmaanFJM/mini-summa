// Where things live, in the three layouts the app runs from: electron-vite output (dev and the smoke test) and the
// packaged app. `moduleDir` is the directory of the bundled main script (<root>/out/main, or .../app.asar/out/main).
import path from 'node:path';

export interface Locations {
  /** Built renderer, served by the core under /ui/. Inside app.asar when packaged. */
  uiDir: string;
  preloadPath: string;
  /** Window icon (PNG). */
  iconPath: string;
  /** The tray icon files in order of preference. Windows takes a multi-size .ico first, everything else the PNG. */
  trayIcons: string[];
  /** The PNG tray icon (tray@2x.png beside it serves high-density displays where the platform uses it). */
  trayIconPath: string;
  /** Unpacked hook script. Only set when packaged; in development the core finds the script in its own package. */
  captureScript: string | undefined;
}

export function resolveLocations(opts: { moduleDir: string; isPackaged: boolean; resourcesPath: string; platform?: NodeJS.Platform }): Locations {
  const root = path.resolve(opts.moduleDir, '..', '..');
  const icons = opts.isPackaged ? path.join(opts.resourcesPath, 'icons') : path.join(root, 'resources');
  const trayPng = path.join(icons, 'tray.png');
  // Electron builds the Windows tray icon from the 1x bitmap of a PNG, here 32 pixels, and Windows then shrinks it to the
  // 16, 20, 24 or 32 pixels the notification area wants. An .ico lets it pick the frame of exactly the right size.
  const trayIcons = (opts.platform ?? process.platform) === 'win32' ? [path.join(icons, 'tray.ico'), trayPng] : [trayPng];
  return {
    uiDir: path.join(root, 'out', 'renderer'),
    preloadPath: path.join(root, 'out', 'preload', 'index.cjs'),
    iconPath: path.join(icons, 'icon.png'),
    trayIcons,
    trayIconPath: trayPng,
    captureScript: opts.isPackaged ? path.join(opts.resourcesPath, 'hook', 'capture.mjs') : undefined,
  };
}
