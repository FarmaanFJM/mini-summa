// Mini-Summa desktop shell: starts the embedded core, shows its UI in one window, and provides the things a web page
// cannot do (native ChatGPT view, clipboard, folder picker, notifications, tray, minisumma:// links).
//
// Local decisions (also in the report):
//  * app.setName alone does not move Electron's userData (it is computed from package.json before this file runs), so
//    userData is also set explicitly to %APPDATA%/Mini-Summa.
//  * The renderer is loaded from the core's /ui/ only. `electron-vite dev` therefore needs a built renderer (out/renderer).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCore } from '@minisumma/core';
import type { Core, CoreOptions } from '@minisumma/core';
import { app, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, session, shell, Tray } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { badgeBitmap, badgeDescription } from './badge.ts';
import { CH } from './channels.ts';
import { ChatGptView } from './chatgptView.ts';
import { chatGptSession, createChatGptViewHandle } from './electronView.ts';
import { registerIpc } from './ipc.ts';
import { resolveLocations } from './locations.ts';
import { createFileLogger } from './log.ts';
import { createMainWindow } from './mainWindow.ts';
import { createNativeBridge } from './nativeBridge.ts';
import { createNotifier } from './notifications.ts';
import { findProtocolUrl, parseProtocolUrl, PROTOCOL_SCHEME } from './protocol.ts';
import { countRunningTerminals, createQuitFlow, quitDialogText } from './quit.ts';
import { hardenMainSession, hardenWebContentsCreation } from './security.ts';
import { applyHostRules, installCertificateTrust, readTestSeams, resolveDataDir, resolveUserDataDir } from './testSeams.ts';
import type { TestSeams } from './testSeams.ts';
import { createAppTray } from './tray.ts';
import { createWindowRouter } from './windowRouter.ts';

// ---- before ready: identity and paths --------------------------------------------------------------------------------

const seams = readTestSeams(process.env, app.isPackaged);
applyHostRules(app.commandLine, seams);

app.setName('Mini-Summa');
const userDataDir = resolveUserDataDir(seams, path.join(app.getPath('appData'), 'Mini-Summa'));
fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);
app.setAppLogsPath(path.join(userDataDir, 'logs'));
app.setAppUserModelId('com.minisumma.app');

const dataDir = resolveDataDir(seams, userDataDir);
const log = createFileLogger(app.getPath('logs'), { echo: !app.isPackaged });
for (const why of seams.ignored) log.warn('test seam ignored', { why });

process.on('uncaughtException', (error) => log.error('uncaught exception', { error }));
process.on('unhandledRejection', (error) => log.error('unhandled rejection', { error }));

const locations = resolveLocations({
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});

// ---- state shared by the pieces below --------------------------------------------------------------------------------

let core: Core | null = null;
let mainWindow: BrowserWindow | null = null;
let trayHandle: { destroy(): void } | null = null;

const windowAlive = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

const openExternalLink = (url: string): void => {
  shell.openExternal(url).catch((error) => log.warn('opening a link failed', { error }));
};

const router = createWindowRouter(windowAlive, log);

const notifier = createNotifier({
  create: (options) => new Notification(options),
  isSupported: () => Notification.isSupported(),
  onClick: (target) => router.navigate(target),
  ...(fs.existsSync(locations.iconPath) ? { icon: locations.iconPath } : {}),
  log,
});

const chatgpt = new ChatGptView({
  createView: () => {
    const win = windowAlive();
    if (!win) throw new Error('There is no window to attach the ChatGPT view to.');
    return createChatGptViewHandle(win);
  },
  content: () => {
    const win = windowAlive();
    if (!win) return null;
    const [width, height] = win.getContentSize();
    return { width, height, zoomFactor: win.webContents.getZoomFactor() };
  },
  requestWorkspace: () => router.navigate({ view: 'workspace' }),
  revealWindow: () => { router.reveal(); },
  openExternal: openExternalLink,
  log,
});

const bridge = createNativeBridge({
  chatgpt,
  notifier,
  notificationsSupported: () => Notification.isSupported(),
  clipboard,
  openExternal: (url) => shell.openExternal(url),
  showSaveDialog: (opts) => {
    const options = { defaultPath: opts.defaultPath, filters: [{ name: 'Markdown or text', extensions: ['md', 'txt'] }, { name: 'All files', extensions: ['*'] }] };
    const win = windowAlive();
    return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
  },
  writeFile: (file, text) => fs.promises.writeFile(file, text, 'utf8'),
  documentsDir: () => app.getPath('documents'),
});

const quit = createQuitFlow({
  countTerminals: () => {
    try { return core ? countRunningTerminals(core.services.sessions.list()) : 0; } catch { return 0; }
  },
  confirm: async (terminals) => {
    const text = quitDialogText(terminals);
    const options = { type: 'warning' as const, buttons: [text.confirm, text.cancel], defaultId: 1, cancelId: 1, noLink: true, title: 'Mini-Summa', message: text.message, detail: text.detail };
    const win = windowAlive();
    const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return answer.response === 0;
  },
  stopCore: async () => {
    trayHandle?.destroy();
    trayHandle = null;
    notifier.closeAll();
    await core?.stop();
  },
  flushStorage: async () => {
    const ses = chatGptSession();
    await ses.cookies.flushStore();
    ses.flushStorageData();
  },
  exit: (code) => app.exit(code),
  log,
});

// ---- minisumma:// links ------------------------------------------------------------------------------------------------

function handleLink(raw: string): void {
  const parsed = parseProtocolUrl(raw);
  if (!parsed.ok) {
    log.warn('minisumma link rejected', { reason: parsed.reason });
    router.reveal();
    return;
  }
  router.navigate(parsed.target);
}

// ---- start ---------------------------------------------------------------------------------------------------------------

type CreateCore = (options: CoreOptions) => Promise<Core>;

async function loadCreateCore(s: TestSeams): Promise<CreateCore> {
  if (!s.coreModule) return createCore;
  // Test seam (never reachable when packaged): a module that exports createCore, used to run against a stub core.
  const mod = (await import(/* @vite-ignore */ pathToFileURL(s.coreModule).href)) as { createCore?: CreateCore };
  if (typeof mod.createCore !== 'function') throw new Error(`${s.coreModule} does not export createCore`);
  return mod.createCore;
}

function coreOptions(): CoreOptions {
  return {
    dataDir,
    mode: 'embedded',
    version: app.getVersion(),
    native: bridge,
    port: 0,
    uiDir: locations.uiDir,
    log,
    overrides: {
      // Hooks run as `Mini-Summa.exe capture.mjs` in Node mode, so no separate Node install is needed.
      captureScript: locations.captureScript,
      nodeRuntime: { command: process.execPath, runAsNode: true },
      ...(seams.claudeBin ? { claudeBin: seams.claudeBin } : {}),
    },
  };
}

async function start(launchLink: string | null): Promise<void> {
  await app.whenReady();
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  installCertificateTrust({ app, sessions: [chatGptSession()], seams });

  const create = await loadCreateCore(seams);
  core = await create(coreOptions());
  await core.start();
  const running = core;
  const coreOrigin = new URL(running.baseUrl).origin;
  log.info('core started', { origin: coreOrigin, dataDir });

  hardenMainSession(session.defaultSession, coreOrigin);

  const win = createMainWindow({
    preloadPath: locations.preloadPath,
    ...(fs.existsSync(locations.iconPath) ? { iconPath: locations.iconPath } : {}),
    stateDir: userDataDir,
    version: app.getVersion(),
    coreOrigin,
    openExternal: openExternalLink,
    devTools: !app.isPackaged,
    log,
  });
  mainWindow = win;
  if (!fs.existsSync(locations.preloadPath)) log.error('preload script is missing', { path: locations.preloadPath });

  // The native ChatGPT view follows the window.
  const reapply = (): void => chatgpt.reapply();
  const windowEvents: NodeJS.EventEmitter = win;
  for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore', 'show']) windowEvents.on(event, reapply);
  win.webContents.on('zoom-changed', reapply);
  win.webContents.on('did-finish-load', reapply);
  const screenEvents: NodeJS.EventEmitter = screen;
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screenEvents.on(event, reapply);
    win.once('closed', () => screenEvents.removeListener(event, reapply));
  }
  chatgpt.onState((state) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CH.chatgptState, state);
  });

  win.webContents.on('did-start-loading', () => router.setRendererReady(false));
  win.webContents.on('did-finish-load', () => router.setRendererReady(true));
  win.on('close', (event) => {
    if (quit.quitting) return;
    event.preventDefault();
    void quit.request();
  });
  win.on('session-end', () => { void running.stop().catch((error) => log.error('core stop at session end failed', { error })); });

  registerIpc({
    ipcMain,
    coreOrigin,
    mainContentsId: () => (win.isDestroyed() ? null : win.webContents.id),
    connection: () => ({ baseUrl: running.baseUrl, token: running.desktopToken }),
    chatgpt,
    writeClipboard: (text) => bridge.clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    selectDirectory: async (opts) => {
      const options = { ...opts, properties: ['openDirectory' as const, 'createDirectory' as const] };
      const answer = await dialog.showOpenDialog(win, options);
      return answer.canceled || answer.filePaths.length === 0 ? null : answer.filePaths[0];
    },
    showItemInFolder: (target) => shell.showItemInFolder(target),
    setBadgeCount: (count) => {
      app.setBadgeCount(count);
      if (process.platform === 'win32' && !win.isDestroyed()) {
        win.setOverlayIcon(count > 0 ? nativeImage.createFromBitmap(badgeBitmap().data, { width: 16, height: 16 }) : null, count > 0 ? badgeDescription(count) : '');
      }
    },
    paths: () => ({ dataDir, logsDir: app.getPath('logs') }),
    log,
  });

  startTray(running);

  try {
    await win.loadURL(`${running.baseUrl}/ui/`);
  } catch (error) {
    log.error('the core UI did not load', { error });
    if (!win.isDestroyed()) win.show();
  }
  if (launchLink) handleLink(launchLink);
}

function startTray(running: Core): void {
  try {
    if (!fs.existsSync(locations.trayIconPath)) { log.warn('tray icon missing; no tray'); return; }
    trayHandle = createAppTray({
      createTray: () => new Tray(nativeImage.createFromPath(locations.trayIconPath)),
      buildMenu: (template) => Menu.buildFromTemplate(template as MenuItemConstructorOptions[]),
      source: {
        counts: () => running.counts(),
        quietMode: () => running.services.settings.get().notifications.quiet.enabled,
        setQuietMode: (enabled) => { running.services.settings.update({ notifications: { quiet: { enabled, until: null } } }); },
        subscribe: (listener) => running.base.bus.subscribe((_seq, event) => { if (event.type === 'counts' || event.type === 'settings.changed') listener(); }),
      },
      onOpen: () => { router.reveal(); },
      onQuit: () => { void quit.request(); },
      log,
    });
  } catch (error) {
    log.warn('tray unavailable', { error });
  }
}

async function failStartup(error: unknown): Promise<void> {
  log.error('startup failed', { error });
  const message = error instanceof Error ? error.message : String(error);
  try { dialog.showErrorBox('Mini-Summa could not start', `${message}\n\nDetails are in ${log.file}`); } catch { /* no display */ }
  try { await core?.stop(); } catch { /* already failed */ }
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is running; it receives our arguments (including a minisumma:// link) and takes over.
  app.quit();
} else {
  hardenWebContentsCreation(app);
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  app.on('second-instance', (_event, argv) => {
    const link = findProtocolUrl(argv);
    if (link) handleLink(link);
    else router.reveal();
  });
  app.on('open-url', (event, url) => { event.preventDefault(); handleLink(url); });
  app.on('before-quit', (event) => {
    if (quit.quitting) return;
    event.preventDefault();
    void quit.request();
  });
  start(findProtocolUrl(process.argv)).catch((error) => { void failStartup(error); });
}
