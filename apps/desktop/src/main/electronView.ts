// Adapts a real Electron WebContentsView to the ViewHandle the ChatGptView controller drives.
import { WebContentsView, session } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import type { ViewHandle } from './chatgptView.ts';

export const CHATGPT_PARTITION = 'persist:chatgpt';
const BACKGROUND = '#141515';

/**
 * Permissions the embedded site may have. Empty on purpose: everything it asks for is refused (camera, microphone, screen
 * capture, clipboard-read, notifications, geolocation, device access). Typing and pasting by the user need none of them.
 *
 * Known cost, measured in Electron 45: with nothing allowed, navigator.clipboard.writeText() in the page is rejected
 * ("Write permission denied"), so a copy button that uses it fails; selecting text and pressing Ctrl+C still works. Adding
 * 'clipboard-sanitized-write' here would allow write-only, sanitized, user-initiated copies. That is a product decision.
 */
/**
 * Everything is denied except sanitized clipboard writes: that is what a page's own "Copy" button uses after a click, it
 * can only put text or an image on the clipboard, and it cannot read anything. Without it ChatGPT's copy buttons fail
 * silently, which would make the embedded view feel broken. Reading the clipboard, the camera, the microphone,
 * notifications and the rest stay denied.
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
      on: (event, listener) => wc.on(event as never, listener as never),
      removeListener: (event, listener) => wc.removeListener(event as never, listener as never),
      setWindowOpenHandler: (handler) => wc.setWindowOpenHandler(handler),
    },
  };
}
