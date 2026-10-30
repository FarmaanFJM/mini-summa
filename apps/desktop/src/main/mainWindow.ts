// The main window: hidden until its first paint, remembers where it was, and shows only the core's own UI.
import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { VERSION_ARG_PREFIX } from './channels.ts';
import type { Logger } from './log.ts';
import { guardMainWindowNavigation } from './security.ts';
import { loadWindowState, MIN_WINDOW, placeWindow, saveWindowState } from './windowState.ts';

export interface MainWindowOptions {
  preloadPath: string;
  iconPath?: string;
  /** Directory for the window state file (the Electron profile). */
  stateDir: string;
  version: string;
  coreOrigin: string;
  openExternal: (url: string) => void;
  /** F12 / Ctrl+Shift+I open developer tools. Development builds only. */
  devTools: boolean;
  log: Logger;
}

const BACKGROUND = '#141515';

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const stateFile = path.join(opts.stateDir, 'window-state.json');
  const placement = placeWindow(loadWindowState(stateFile), screen.getAllDisplays());

  const win = new BrowserWindow({
    ...(placement.x !== undefined && placement.y !== undefined ? { x: placement.x, y: placement.y } : {}),
    width: placement.width,
    height: placement.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: 'Mini-Summa',
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    ...(opts.iconPath ? { icon: opts.iconPath } : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      additionalArguments: [`${VERSION_ARG_PREFIX}${opts.version}`],
    },
  });

  win.once('ready-to-show', () => {
    if (placement.maximized) win.maximize();
    win.show();
  });

  // Window state: debounced while it changes, and once more when it closes.
  let timer: NodeJS.Timeout | undefined;
  const remember = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.getNormalBounds();
    saveWindowState(stateFile, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
  };
  const rememberSoon = (): void => { clearTimeout(timer); timer = setTimeout(remember, 400); };
  const windowEvents: NodeJS.EventEmitter = win;
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) windowEvents.on(event, rememberSoon);
  win.on('close', () => { clearTimeout(timer); remember(); });

  guardMainWindowNavigation(win.webContents, opts.coreOrigin, opts.openExternal, opts.log);

  // A crashed renderer would leave a blank window over still-running terminals. Reload it, a few times at most.
  const crashes: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    opts.log.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    if (crashes.length <= 3 && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 500);
  });

  if (opts.devTools) {
    win.webContents.on('before-input-event', (event, input) => {
      const toggle = input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'));
      if (toggle) { event.preventDefault(); win.webContents.toggleDevTools(); }
    });
  }
  return win;
}
