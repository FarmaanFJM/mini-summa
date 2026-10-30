// Contracts between the core and the thing that hosts it (Electron main, or nothing in headless mode),
// and between the renderer and the Electron preload.
import type { NavigationTarget } from './entities.ts';
import type { NativeCapabilities } from './entities.ts';

export interface Rect { x: number; y: number; width: number; height: number }

export type ChatGptViewStatus = 'idle' | 'loading' | 'ready' | 'login_required' | 'challenge' | 'blocked' | 'error';

export interface ChatGptViewState {
  mode: 'embedded' | 'external';
  status: ChatGptViewStatus;
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Plain-language reason for login_required, challenge, blocked or error. */
  note: string | null;
}

export type ClaudeWebViewStatus = 'idle' | 'loading' | 'ready' | 'login_required' | 'blocked' | 'error';

/**
 * What Mini-Summa can see of the embedded Claude Code on the web page: the address, the title, whether a load is running, why a
 * load failed and whether the page looks like a sign-in page. Never the content. A view of a page is not control of the session
 * behind it: Mini-Summa cannot tell whether a cloud session is working, finished or waiting.
 */
export interface ClaudeWebViewState {
  status: ClaudeWebViewStatus;
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Plain-language reason for login_required, blocked or error. */
  note: string | null;
}

export interface ChatGptOpenResult {
  ok: boolean;
  /** How the page was shown: the embedded view, a tab focused through the extension, or the default browser. */
  mode: 'embedded' | 'extension' | 'external' | 'none';
  opened: boolean;
  /** Only claimed when the host could actually observe it (embedded view, or the extension confirmed a tab). */
  focused: boolean;
  /** Whether the loaded page was confirmed to be the requested conversation. null = could not be checked. */
  verified: boolean | null;
  finalUrl: string | null;
  title: string | null;
  note: string | null;
}

export interface NativeNotification {
  title: string;
  body: string;
  /** Used to replace an earlier notification about the same thing. */
  tag: string;
  target: NavigationTarget;
  urgency: 'normal' | 'critical';
  silent: boolean;
  /**
   * The person may already be looking at what this is about (Claude finished in the session that is on screen). Only the host knows
   * whether its window is in front, so it may decide not to show this one and says so with `suppressed: 'viewing'`. Unset means
   * "always show"; a permission request, a question or an error is never marked.
   */
  suppressIfViewing?: boolean;
}

/** What the host answers to `notify`. `shown` is true only when the system accepted the notification. */
export interface NativeNotifyResult {
  shown: boolean;
  reason?: string;
  /** Not shown on purpose, which is different from a failure: the window was in front on the target of a `suppressIfViewing` notification. */
  suppressed?: 'viewing';
}

/**
 * What the core needs from its host. Electron main implements all of it; the headless runner implements a subset and
 * reports the rest as unavailable in `capabilities()`. The core never assumes a capability: it asks.
 */
export interface NativeBridge {
  capabilities(): NativeCapabilities;
  chatgpt: {
    /** Show the page and bring it to the user. In embedded mode this loads the URL in the ChatGPT view. */
    open(url: string, opts: { focus: boolean; reason: 'handoff' | 'user' | 'verify' }): Promise<ChatGptOpenResult>;
    /** Load the URL and report whether it opened the intended page, without pretending when that is not observable. */
    verify(url: string): Promise<ChatGptOpenResult>;
    state(): ChatGptViewState;
  };
  clipboard: { writeText(text: string): Promise<void> };
  notify(n: NativeNotification): Promise<NativeNotifyResult>;
  openExternal(url: string): Promise<void>;
  saveTextFile(opts: { suggestedName: string; text: string }): Promise<{ path: string | null }>;
}

/** Everything unavailable. Used by tests and as the base for partial hosts. */
export function unavailableBridge(): NativeBridge {
  const no = async (): Promise<ChatGptOpenResult> => ({ ok: false, mode: 'none', opened: false, focused: false, verified: null, finalUrl: null, title: null, note: 'No browser host is available.' });
  return {
    capabilities: () => ({ clipboard: false, chatgptEmbedded: false, extensionBridge: false, notifications: false, openExternal: false, saveFile: false }),
    chatgpt: { open: no, verify: no, state: () => ({ mode: 'external', status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null }) },
    clipboard: { async writeText() { throw new Error('Clipboard is not available in this host.'); } },
    async notify() { return { shown: false, reason: 'unavailable' }; },
    async openExternal() { throw new Error('Opening external links is not available in this host.'); },
    async saveTextFile() { return { path: null }; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// window.miniSumma, exposed by the Electron preload through contextBridge. The renderer is otherwise an ordinary web
// client of the core API; everything here is something a web page cannot do on its own.

export interface NativeApi {
  readonly kind: 'electron';
  readonly appVersion: string;
  readonly platform: 'win32' | 'linux' | 'darwin';
  /** Address and bearer token of the embedded core. The token never travels over HTTP. */
  connection(): Promise<{ baseUrl: string; token: string }>;
  chatgpt: {
    /** Place the native ChatGPT view over this rectangle (CSS pixels, window coordinates). null hides it. */
    setBounds(rect: Rect | null): Promise<void>;
    /** Hide the native view while a modal or menu is open, because a native view always draws above web content. */
    setOverlayActive(active: boolean): Promise<void>;
    navigate(url: string): Promise<void>;
    reload(): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    focus(): Promise<void>;
    getState(): Promise<ChatGptViewState>;
    onState(listener: (state: ChatGptViewState) => void): () => void;
  };
  /**
   * Claude Code on the web (claude.ai/code) in a second native view with its own browser profile, created the first time it is
   * asked to load something. Same shape as `chatgpt`; the overlay switch of `chatgpt` covers both views. Absent when the host
   * cannot embed it (then the renderer opens the address in the person's browser).
   */
  claudeWeb?: {
    setBounds(rect: Rect | null): Promise<void>;
    navigate(url: string): Promise<void>;
    reload(): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    focus(): Promise<void>;
    getState(): Promise<ClaudeWebViewState>;
    onState(listener: (state: ClaudeWebViewState) => void): () => void;
  };
  clipboard: { writeText(text: string): Promise<void> };
  dialogs: { selectDirectory(opts?: { title?: string; defaultPath?: string }): Promise<string | null> };
  shell: { openExternal(url: string): Promise<void>; showItemInFolder(path: string): Promise<void> };
  app: {
    /** Fired when a notification, tray item or minisumma:// link asks the app to show something. */
    onNavigate(listener: (target: NavigationTarget) => void): () => void;
    setBadgeCount(count: number): Promise<void>;
    getPaths(): Promise<{ dataDir: string; logsDir: string }>;
  };
}

declare global {
  interface Window { miniSumma?: NativeApi }
}
