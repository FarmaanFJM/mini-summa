// Adapts a real Electron WebContentsView to the ViewHandle the ChatGptView controller drives.
import { WebContentsView, session } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import type { PooledViewHandle } from './chatgptViews.ts';

export const CHATGPT_PARTITION = 'persist:chatgpt';
const BACKGROUND = '#141515';

/**
 * Permissions the embedded site may have: exactly one. Everything else it asks for is refused (camera, microphone, screen
 * capture, clipboard-read, notifications, geolocation, device access). Typing and pasting by the user need none of them.
 *
 * 'clipboard-sanitized-write' is what a page's own "Copy" button uses after a click: it can only put text or an image on the
 * clipboard, and it cannot read anything. Measured in Electron 45: with nothing allowed, navigator.clipboard.writeText() in
 * the page is rejected ("Write permission denied"), so ChatGPT's copy buttons (copying a writing block as Markdown, say) would
 * fail while selecting text and pressing Ctrl+C kept working, which makes the view feel broken. Any change to this list is a
 * product decision; electronView.test.ts pins it.
 */
export const CHATGPT_ALLOWED_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write'];

export function hardenChatGptSession(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(CHATGPT_ALLOWED_PERMISSIONS.includes(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => CHATGPT_ALLOWED_PERMISSIONS.includes(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

export function chatGptSession(): Session {
  return session.fromPartition(CHATGPT_PARTITION);
}

/**
 * The native view of an embedded site (ChatGPT, Claude Code on the web): a profile of its own (`partition`), the permission rule above
 * applied to that profile before anything loads, the strictest web preferences and NO preload, so nothing of Mini-Summa runs inside the
 * page. It is added to the window hidden; the controller of each site shows, moves and hides it, and nothing here can remove it.
 * Written once so that the settings that matter for security cannot drift apart between the sites.
 */
export function createEmbeddedView(win: BrowserWindow, partition: string): WebContentsView {
  hardenChatGptSession(session.fromPartition(partition));
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // No preload on purpose, and no user agent: the page sees the browser as it is.
    },
  });
  view.setBackgroundColor(BACKGROUND);
  view.setVisible(false);
  win.contentView.addChildView(view);
  return view;
}

/**
 * A ChatGPT view of one project. `destroy` takes it out of the window and closes its page; only the pool of views calls it, and only to
 * stay within the bound on live views (chatgptViews.ts). Hiding, moving and covering a view never reach it.
 */
export function createChatGptViewHandle(win: BrowserWindow): PooledViewHandle {
  const view = createEmbeddedView(win, CHATGPT_PARTITION);
  const wc = view.webContents;
  return {
    setBounds: (r) => view.setBounds(r),
    setVisible: (v) => view.setVisible(v),
    destroy: () => {
      if (!win.isDestroyed()) win.contentView.removeChildView(view);
      if (!wc.isDestroyed()) wc.close();
    },
    contents: {
      getURL: () => wc.getURL(),
      getTitle: () => wc.getTitle(),
      isLoading: () => wc.isLoading(),
      isFocused: () => wc.isFocused(),
      isDestroyed: () => wc.isDestroyed(),
      loadURL: (url) => wc.loadURL(url),
      reload: () => wc.reload(),
      stop: () => wc.stop(),
      canGoBack: () => wc.navigationHistory.canGoBack(),
      canGoForward: () => wc.navigationHistory.canGoForward(),
      goBack: () => wc.navigationHistory.goBack(),
      goForward: () => wc.navigationHistory.goForward(),
      focus: () => wc.focus(),
      // The view's own zoom, kept per host by Chromium in this view's partition. The main window's zoom (which bounds.ts converts
      // with) lives in another partition and is never read or set here.
      getZoomFactor: () => wc.getZoomFactor(),
      setZoomFactor: (factor) => wc.setZoomFactor(factor),
      on: (event, listener) => wc.on(event as never, listener as never),
      removeListener: (event, listener) => wc.removeListener(event as never, listener as never),
      setWindowOpenHandler: (handler) => wc.setWindowOpenHandler(handler),
    },
  };
}
