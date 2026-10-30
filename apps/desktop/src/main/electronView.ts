// Adapts a real Electron WebContentsView to the ViewHandle the ChatGptView controller drives.
import { WebContentsView, session } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import type { ViewHandle } from './chatgptView.ts';

export const CHATGPT_PARTITION = 'persist:chatgpt';
const BACKGROUND = '#141515';

/**
 * Everything the embedded site asks for is refused: camera, microphone, screen capture, clipboard-read, notifications,
 * geolocation, device access. (Typing and pasting by the user need none of these.)
 */
export function hardenChatGptSession(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
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
