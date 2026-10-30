// Adapts a real Electron WebContentsView to the ViewHandle the ChatGptView controller drives.
import { WebContentsView, session } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import type { ViewHandle } from './chatgptView.ts';

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

export function createChatGptViewHandle(win: BrowserWindow): ViewHandle {
  hardenChatGptSession(chatGptSession());
  const view = new WebContentsView({
    webPreferences: {
      partition: CHATGPT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // No preload on purpose: nothing of Mini-Summa runs inside the ChatGPT page.
    },
  });
  view.setBackgroundColor(BACKGROUND);
  view.setVisible(false);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  return {
    setBounds: (r) => view.setBounds(r),
    setVisible: (v) => view.setVisible(v),
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
