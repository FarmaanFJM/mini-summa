// Things the tests do inside (or read from) the Electron main process of the app under test, through Playwright's
// electronApp.evaluate. Everything passed to evaluate is serialised, so the functions below use only their arguments.
//
// The only product behaviour these helpers change is what the OPERATING SYSTEM would have done: the native folder picker and
// the quit confirmation are answered, and (for the notification test, and only when asked) the platform's notification layer
// is simulated. Nothing of Mini-Summa's own code is replaced.
import type { ElectronApplication } from 'playwright';
import type { Rect } from '@minisumma/shared';

export interface WindowInfo {
  bounds: Rect;
  contentSize: [number, number];
  visible: boolean;
  focused: boolean;
  maximized: boolean;
  minimized: boolean;
}

export const windowInfo = (app: ElectronApplication): Promise<WindowInfo> => app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return {
    bounds: win.getBounds(), contentSize: win.getContentSize() as [number, number], visible: win.isVisible(), focused: win.isFocused(),
    maximized: win.isMaximized(), minimized: win.isMinimized(),
  };
});

/** Resizes the real BrowserWindow, as dragging its edge would. Resolves when the new content size is in place. */
export async function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<WindowInfo> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(size.width, size.height);
  }, { width, height });
  const deadline = Date.now() + 5000;
  for (;;) {
    const info = await windowInfo(app);
    if (info.contentSize[0] === width && info.contentSize[1] === height) return info;
    if (Date.now() > deadline) return info;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface ChatGptViewInfo {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  /** Where the native view sits inside the window, in DIP. */
  bounds: Rect | null;
  visible: boolean | null;
  focused: boolean;
  userAgent: string;
}

/** The embedded ChatGPT view (the WebContentsView in the persist:chatgpt session), or null while it does not exist. */
export const chatgptView = (app: ElectronApplication): Promise<ChatGptViewInfo | null> => app.evaluate(({ BrowserWindow, session, webContents }) => {
  const partition = session.fromPartition('persist:chatgpt');
  const contents = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === partition);
  if (!contents) return null;
  const win = BrowserWindow.getAllWindows()[0];
  const view = win.contentView.children.find((c) => (c as unknown as { webContents?: unknown }).webContents === contents);
  return {
    id: contents.id, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
    bounds: view ? view.getBounds() : null, visible: view ? view.getVisible() : null, focused: contents.isFocused(),
    userAgent: contents.getUserAgent(),
  };
});

/** Every web contents the app has, with its address: the ground truth of what is on screen where. */
export const allWebContentsUrls = (app: ElectronApplication): Promise<string[]> => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => !w.isDestroyed()).map((w) => w.getURL()));

/** Reads the page state the stand-in keeps (events seen, text in the composer). The product never reads this; the test does. */
export const standInPageState = (app: ElectronApplication): Promise<{ events: string[]; composer: string } | null> => app.evaluate(async ({ session, webContents }) => {
  const partition = session.fromPartition('persist:chatgpt');
  const contents = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === partition);
  if (!contents) return null;
  try {
    return await contents.executeJavaScript('({ events: (window.__standin && window.__standin.events) || [], composer: (document.getElementById("composer") || {}).value || "" })', true);
  } catch { return null; }
});

export const readClipboard = (app: ElectronApplication): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText());
export const writeClipboard = (app: ElectronApplication, text: string): Promise<void> => app.evaluate(({ clipboard }, value) => { clipboard.writeText(value); }, text);

// ---------------------------------------------------------------------------------------------------------------
// State the helpers below keep on globalThis inside the app's main process. Types only: the functions that use it are serialised.

export interface OpenDialogCall { title?: string; defaultPath?: string; properties?: string[] }
export interface MessageBoxCall { message?: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number }
export interface NotificationSpyState {
  /** How many times the main process asked whether the platform can show notifications (once per notify attempt). */
  supportedChecks: number;
  /** What Electron itself answered the last time it was asked (without any simulation). */
  platformSupported: boolean;
  /** Native notifications Mini-Summa asked for, with the options it gave them (simulated platform only). */
  created: { title: string; body: string; silent: boolean; urgency: string | null; timeoutType: string | null }[];
  simulated: boolean;
}
interface E2EState {
  openDialogs: OpenDialogCall[];
  messageBoxes: MessageBoxCall[];
  notify?: NotificationSpyState & { live: { emit(event: string): void }[] };
}
type MainGlobal = { __e2e?: E2EState };

// ---------------------------------------------------------------------------------------------------------------
// Native dialogs: there is no person to click them

/**
 * Answers the native folder picker with `folder` (or "cancelled" with null) and records how it was asked. The renderer still
 * goes through the real preload, IPC validation and `dialog.showOpenDialog(window, options)` call in the main process.
 */
export const answerFolderPicker = (app: ElectronApplication, folder: string | null): Promise<void> => app.evaluate(({ dialog }, answer) => {
  const g = globalThis as unknown as MainGlobal;
  const state = (g.__e2e ??= { openDialogs: [], messageBoxes: [] });
  (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async (...args: unknown[]) => {
    state.openDialogs.push(JSON.parse(JSON.stringify(args[args.length - 1] ?? {})));
    return answer === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [answer] };
  };
}, folder);

export const folderPickerCalls = (app: ElectronApplication): Promise<OpenDialogCall[]> => app.evaluate(() => {
  const g = globalThis as unknown as MainGlobal;
  return g.__e2e?.openDialogs ?? [];
});

/**
 * Quitting with running terminals asks "Quit Mini-Summa?". `button` is the answer: 0 is "Quit and end terminal(s)", 1 is Cancel.
 * The question is recorded in the main process, and appended to `recordTo` when given (the app may exit right after asking).
 */
export const answerMessageBoxes = (app: ElectronApplication, button: 0 | 1, recordTo?: string): Promise<void> => app.evaluate(({ dialog }, args) => {
  const g = globalThis as unknown as MainGlobal;
  const state = (g.__e2e ??= { openDialogs: [], messageBoxes: [] });
  (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...a: unknown[]) => {
    const options = JSON.parse(JSON.stringify(a[a.length - 1] ?? {}));
    state.messageBoxes.push(options);
    if (args.recordTo) process.getBuiltinModule('node:fs').appendFileSync(args.recordTo, `${JSON.stringify(options)}\n`);
    return { response: args.button, checkboxChecked: false };
  };
}, { button, recordTo });

export const messageBoxCalls = (app: ElectronApplication): Promise<MessageBoxCall[]> => app.evaluate(() => {
  const g = globalThis as unknown as MainGlobal;
  return g.__e2e?.messageBoxes ?? [];
});

// ---------------------------------------------------------------------------------------------------------------
// Notifications

/**
 * Watches the main process's native notification attempts.
 *
 *   simulate: false  Counts calls to Notification.isSupported() and passes every answer through unchanged. This is what the
 *                    product sees on this machine.
 *   simulate: true   Pretends the platform has a notification service: isSupported() is true and show() reports `show` at
 *                    once. Mini-Summa's own code (notifier, bridge, window router, renderer) is untouched; only the operating
 *                    system's part is played by the test. A click is then `clickNotification`.
 */
export const spyOnNotifications = (app: ElectronApplication, simulate: boolean): Promise<void> => app.evaluate(({ Notification }, simulated) => {
  const g = globalThis as unknown as MainGlobal;
  const root = (g.__e2e ??= { openDialogs: [], messageBoxes: [] });
  const state = { supportedChecks: 0, platformSupported: false, created: [] as NotificationSpyState['created'], simulated, live: [] as { emit(event: string): void }[] };
  root.notify = state;
  const klass = Notification as unknown as { isSupported(): boolean; prototype: Record<string, unknown> };
  const original = klass.isSupported.bind(klass);
  klass.isSupported = () => {
    state.supportedChecks += 1;
    state.platformSupported = original();
    return simulated ? true : state.platformSupported;
  };
  if (simulated) {
    const proto = klass.prototype as { show: () => void; close: () => void; emit: (e: string) => boolean; title: string; body: string; silent: boolean; urgency?: string; timeoutType?: string };
    proto.show = function show(this: typeof proto) {
      state.created.push({ title: this.title, body: this.body, silent: this.silent, urgency: this.urgency ?? null, timeoutType: this.timeoutType ?? null });
      state.live.push(this);
      queueMicrotask(() => this.emit('show'));
    };
    proto.close = function close(this: typeof proto) { this.emit('close'); };
  }
}, simulate);

export const notificationSpy = (app: ElectronApplication): Promise<NotificationSpyState> => app.evaluate(() => {
  const g = globalThis as unknown as MainGlobal;
  const s = g.__e2e?.notify;
  return s ? { supportedChecks: s.supportedChecks, platformSupported: s.platformSupported, created: s.created, simulated: s.simulated } : { supportedChecks: 0, platformSupported: false, created: [], simulated: false };
});

/** The user clicks the n-th notification Mini-Summa showed (simulated platform only). */
export const clickNotification = (app: ElectronApplication, index: number): Promise<boolean> => app.evaluate((_electron, i) => {
  const g = globalThis as unknown as MainGlobal;
  const n = g.__e2e?.notify?.live[i];
  if (!n) return false;
  n.emit('click');
  return true;
}, index);

// ---------------------------------------------------------------------------------------------------------------

export const hideWindow = (app: ElectronApplication): Promise<void> => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); });

/** A second launch of the app with this command line: Electron hands it to the running instance as `second-instance`. */
export const secondInstance = (app: ElectronApplication, argv: string[]): Promise<void> => app.evaluate(({ app: electronApp }, args) => { electronApp.emit('second-instance', {}, args, '', {}); }, argv);
