// window.miniSumma: the renderer's only door to native features. It exposes functions, never ipcRenderer itself, and
// every call goes to a handler in the main process that checks the sender and the arguments again.
//
// This file is bundled with everything it needs into one CommonJS script (a sandboxed preload can only require
// 'electron'), so it imports types from the shared package and constants from channels.ts and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import type { ChatGptViewState, NativeApi, NavigationTarget, Rect } from '@minisumma/shared';
import { CH, VERSION_ARG_PREFIX } from '../main/channels.ts';

const versionArg = process.argv.find((a) => a.startsWith(VERSION_ARG_PREFIX));
const appVersion = versionArg ? versionArg.slice(VERSION_ARG_PREFIX.length) : '0.0.0';
const platform: NativeApi['platform'] = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';

const invoke = <T = void>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

// A notification click or a minisumma:// link can arrive before the page has registered its listener (a cold start from
// a link, say). Keep the last few and hand them to the first listener instead of dropping them.
const navigateListeners = new Set<(target: NavigationTarget) => void>();
const early: NavigationTarget[] = [];
ipcRenderer.on(CH.navigate, (_event, target: NavigationTarget) => {
  if (navigateListeners.size === 0) {
    early.push(target);
    if (early.length > 5) early.shift();
    return;
  }
  for (const listener of [...navigateListeners]) listener(target);
});

const api: NativeApi = {
  kind: 'electron',
  appVersion,
  platform,
  connection: () => invoke<{ baseUrl: string; token: string }>(CH.connection),
  chatgpt: {
    setBounds: (rect: Rect | null) => invoke(CH.chatgptSetBounds, rect),
    setOverlayActive: (active: boolean) => invoke(CH.chatgptSetOverlayActive, active),
    navigate: (url: string) => invoke(CH.chatgptNavigate, url),
    reload: () => invoke(CH.chatgptReload),
    back: () => invoke(CH.chatgptBack),
    forward: () => invoke(CH.chatgptForward),
    focus: () => invoke(CH.chatgptFocus),
    getState: () => invoke<ChatGptViewState>(CH.chatgptGetState),
    onState: (listener) => subscribe<ChatGptViewState>(CH.chatgptState, listener),
  },
  clipboard: { writeText: (text: string) => invoke(CH.clipboardWriteText, text) },
  dialogs: { selectDirectory: (opts) => invoke<string | null>(CH.selectDirectory, opts) },
  shell: {
    openExternal: (url: string) => invoke(CH.openExternal, url),
    showItemInFolder: (path: string) => invoke(CH.showItemInFolder, path),
  },
  app: {
    onNavigate: (listener) => {
      navigateListeners.add(listener);
      for (const target of early.splice(0)) listener(target);
      return () => { navigateListeners.delete(listener); };
    },
    setBadgeCount: (count: number) => invoke(CH.setBadgeCount, count),
    getPaths: () => invoke<{ dataDir: string; logsDir: string }>(CH.getPaths),
  },
};

contextBridge.exposeInMainWorld('miniSumma', api);
