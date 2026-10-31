// window.miniSumma: the renderer's only door to native features. It exposes functions, never ipcRenderer itself, and
// every call goes to a handler in the main process that checks the sender and the arguments again.
//
// This file is bundled with everything it needs into one CommonJS script (a sandboxed preload can only require
// 'electron'), so it imports types from the shared package and constants from channels.ts and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import type { ChatGptViewNotice, ChatGptViewState, ClaudeWebViewState, NativeApi, NavigationTarget, Rect } from '@minisumma/shared';
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
    liveViews: true,
    // The key (a project id) is the last argument, and only sent when there is one.
    setBounds: (rect: Rect | null, key?: string) => invoke(CH.chatgptSetBounds, rect, ...(key === undefined ? [] : [key])),
    setOverlayActive: (active: boolean) => invoke(CH.chatgptSetOverlayActive, active),
    navigate: (url: string, key?: string) => invoke(CH.chatgptNavigate, url, ...(key === undefined ? [] : [key])),
    reload: (key?: string) => invoke(CH.chatgptReload, ...(key === undefined ? [] : [key])),
    back: (key?: string) => invoke(CH.chatgptBack, ...(key === undefined ? [] : [key])),
    forward: (key?: string) => invoke(CH.chatgptForward, ...(key === undefined ? [] : [key])),
    focus: (key?: string) => invoke(CH.chatgptFocus, ...(key === undefined ? [] : [key])),
    getState: (key?: string) => invoke<ChatGptViewState>(CH.chatgptGetState, ...(key === undefined ? [] : [key])),
    // Without a key: the active view's changes, as before. With one: that project's view, whether or not it is the active one.
    onState: (listener, key) => key === undefined
      ? subscribe<ChatGptViewState>(CH.chatgptState, listener)
      : subscribe<{ key: string | null; state: ChatGptViewState }>(CH.chatgptKeyedState, (payload) => { if (payload.key === key) listener(payload.state); }),
    onNotice: (listener) => subscribe<ChatGptViewNotice>(CH.chatgptNotice, listener),
  },
  // Claude Code on the web: the same shape as `chatgpt` without an overlay switch (the one above covers both native views).
  claudeWeb: {
    setBounds: (rect: Rect | null) => invoke(CH.claudeWebSetBounds, rect),
    navigate: (url: string) => invoke(CH.claudeWebNavigate, url),
    reload: () => invoke(CH.claudeWebReload),
    back: () => invoke(CH.claudeWebBack),
    forward: () => invoke(CH.claudeWebForward),
    focus: () => invoke(CH.claudeWebFocus),
    getState: () => invoke<ClaudeWebViewState>(CH.claudeWebGetState),
    onState: (listener) => subscribe<ClaudeWebViewState>(CH.claudeWebState, listener),
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
