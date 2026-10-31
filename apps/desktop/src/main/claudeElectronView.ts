// Adapts a real Electron WebContentsView to the ClaudeViewHandle the ClaudeWebView controller drives: the second native view, which
// shows Claude Code on the web (claude.ai/code) next to the ChatGPT one.
//
// It is built exactly like the ChatGPT view (electronView.ts) and differs in one thing that matters: its OWN browser profile. The
// partition below is not the ChatGPT one, so the two sites never share cookies, local storage, caches or permissions, and signing out
// of one has no effect on the other.
import { session } from 'electron';
import type { BrowserWindow, Session } from 'electron';
import type { ClaudeViewHandle } from './claudeView.ts';
import { createEmbeddedView } from './electronView.ts';

export const CLAUDE_PARTITION = 'persist:claude';

export function claudeWebSession(): Session {
  return session.fromPartition(CLAUDE_PARTITION);
}

export function createClaudeWebViewHandle(win: BrowserWindow): ClaudeViewHandle {
  // The same view, preferences and permission rule as the ChatGPT one, written once (createEmbeddedView): the one permission the site may
  // have is a sanitized clipboard write (what a "Copy" button uses after a click). Camera, microphone, screen capture, clipboard-read,
  // notifications, geolocation and device access are refused, and there is no prompt for any of them.
  const view = createEmbeddedView(win, CLAUDE_PARTITION);
  const wc = view.webContents;
  return {
    setBounds: (r) => view.setBounds(r),
    setVisible: (v) => view.setVisible(v),
    contents: {
      getURL: () => wc.getURL(),
      getTitle: () => wc.getTitle(),
      isLoading: () => wc.isLoading(),
      isDestroyed: () => wc.isDestroyed(),
      loadURL: (url) => wc.loadURL(url),
      reload: () => wc.reload(),
      canGoBack: () => wc.navigationHistory.canGoBack(),
      canGoForward: () => wc.navigationHistory.canGoForward(),
      goBack: () => wc.navigationHistory.goBack(),
      goForward: () => wc.navigationHistory.goForward(),
      focus: () => wc.focus(),
      on: (event, listener) => wc.on(event as never, listener as never),
      setWindowOpenHandler: (handler) => wc.setWindowOpenHandler(handler),
    },
  };
}
