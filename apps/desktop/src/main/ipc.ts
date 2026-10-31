// The renderer-facing IPC surface (the other half of window.miniSumma). Every handler checks who is asking and what was
// sent before touching a native API. The desktop token leaves this process only through `ms:connection`, and only to the
// main window's top frame on the core's origin.
import type { ChatGptViewState, ClaudeWebViewState, Rect } from '@minisumma/shared';
import { CH, INVOKE_CHANNELS } from './channels.ts';
import type { ClaudeWebView } from './claudeView.ts';
import type { Logger } from './log.ts';
import {
  isTrustedSender, validateAbsolutePath, validateBadgeCount, validateBounds, validateBoolean, validateChatGptUrl,
  validateClaudeWebUrl, validateClipboardText, validateDirectoryOptions, validateExternalUrl, validateViewKey,
} from './validation.ts';

/** The slice of Electron's IpcMainInvokeEvent that is used. */
export interface InvokeEventLike {
  sender: { id: number };
  senderFrame: { url: string; parent: unknown } | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/**
 * What the renderer's ChatGPT calls reach: the views of the projects (chatgptViews.ts). `key` names a project's view; without one the
 * call is about the active view, which is how the single view was addressed before there were keys.
 */
export interface ChatGptSurface {
  setBounds(rect: Rect | null, key?: string): void;
  setOverlayActive(active: boolean): void;
  navigate(url: string, key?: string): Promise<void>;
  reload(key?: string): void;
  back(key?: string): void;
  forward(key?: string): void;
  focus(key?: string): void;
  getState(key?: string): ChatGptViewState;
}

export interface IpcDeps {
  ipcMain: IpcMainLike;
  coreOrigin: string;
  /** Web contents id of the main window, or null when there is none. */
  mainContentsId(): number | null;
  connection(): { baseUrl: string; token: string };
  chatgpt: ChatGptSurface;
  /** Claude Code on the web, the second native view. It has no overlay channel of its own: the one for ChatGPT switches both. */
  claudeWeb: Pick<ClaudeWebView, 'setBounds' | 'setOverlayActive' | 'navigate' | 'reload' | 'back' | 'forward' | 'focus' | 'getState'>;
  writeClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  selectDirectory(opts: { title?: string; defaultPath?: string }): Promise<string | null>;
  showItemInFolder(path: string): void;
  setBadgeCount(count: number): void;
  paths(): { dataDir: string; logsDir: string };
  log: Logger;
}

export class UntrustedSenderError extends Error {
  constructor() { super('This request did not come from the Mini-Summa window.'); this.name = 'UntrustedSenderError'; }
}

export function registerIpc(deps: IpcDeps): () => void {
  const check = (channel: string, event: InvokeEventLike): void => {
    const frame = event.senderFrame;
    const ok = isTrustedSender(
      { frameUrl: frame?.url, isTopFrame: !!frame && frame.parent === null, contentsId: event.sender.id },
      deps.coreOrigin,
      deps.mainContentsId(),
    );
    if (!ok) {
      deps.log.warn('ipc rejected', { channel, frameUrl: frame?.url ? frame.url.split(/[?#]/)[0] : null });
      throw new UntrustedSenderError();
    }
  };

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    deps.ipcMain.handle(channel, async (event: InvokeEventLike, ...args: unknown[]) => {
      check(channel, event);
      return fn(...args);
    });
  };

  handle(CH.connection, () => deps.connection());

  // The key (a project id) is passed on only when there is one, so a caller without keys reaches the surface exactly as before.
  const keyed = <A extends unknown[]>(key: unknown, ...args: A): [...A, string] | A => {
    const k = validateViewKey(key);
    return k === undefined ? args : [...args, k];
  };
  handle(CH.chatgptSetBounds, (rect, key) => { deps.chatgpt.setBounds(...(keyed(key, validateBounds(rect)) as [Rect | null, string?])); });
  // A menu, dialog or toast of the renderer covers every native view, so the one switch drives both. Each view keeps its own flag and
  // places itself again from its own rectangle when the switch is released, so a view that was hidden before stays hidden. One view
  // failing must not leave the other drawn over the dialog.
  handle(CH.chatgptSetOverlayActive, (active) => {
    const flag = validateBoolean(active, 'overlay flag');
    for (const [name, view] of [['chatgpt', deps.chatgpt], ['claudeWeb', deps.claudeWeb]] as const) {
      try { view.setOverlayActive(flag); } catch (error) { deps.log.warn('overlay switch failed', { view: name, error }); }
    }
  });
  handle(CH.chatgptNavigate, (url, key) => deps.chatgpt.navigate(...(keyed(key, validateChatGptUrl(url)) as [string, string?])));
  handle(CH.chatgptReload, (key) => { deps.chatgpt.reload(...(keyed(key) as [string?])); });
  handle(CH.chatgptBack, (key) => { deps.chatgpt.back(...(keyed(key) as [string?])); });
  handle(CH.chatgptForward, (key) => { deps.chatgpt.forward(...(keyed(key) as [string?])); });
  handle(CH.chatgptFocus, (key) => { deps.chatgpt.focus(...(keyed(key) as [string?])); });
  handle(CH.chatgptGetState, (key): ChatGptViewState => deps.chatgpt.getState(...(keyed(key) as [string?])));

  handle(CH.claudeWebSetBounds, (rect) => { deps.claudeWeb.setBounds(validateBounds(rect)); });
  handle(CH.claudeWebNavigate, (url) => deps.claudeWeb.navigate(validateClaudeWebUrl(url)));
  handle(CH.claudeWebReload, () => { deps.claudeWeb.reload(); });
  handle(CH.claudeWebBack, () => { deps.claudeWeb.back(); });
  handle(CH.claudeWebForward, () => { deps.claudeWeb.forward(); });
  handle(CH.claudeWebFocus, () => { deps.claudeWeb.focus(); });
  handle(CH.claudeWebGetState, (): ClaudeWebViewState => deps.claudeWeb.getState());

  handle(CH.clipboardWriteText, (text) => deps.writeClipboard(validateClipboardText(text)));
  handle(CH.selectDirectory, (opts) => deps.selectDirectory(validateDirectoryOptions(opts)));
  handle(CH.openExternal, (url) => deps.openExternal(validateExternalUrl(url)));
  handle(CH.showItemInFolder, (p) => { deps.showItemInFolder(validateAbsolutePath(p)); });
  handle(CH.setBadgeCount, (n) => { deps.setBadgeCount(validateBadgeCount(n)); });
  handle(CH.getPaths, () => deps.paths());

  return () => { for (const channel of INVOKE_CHANNELS) deps.ipcMain.removeHandler(channel); };
}
