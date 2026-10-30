// A host for tests: records everything the core asks of it and can be told to fail. `focusedUrl` models "whichever
// ChatGPT tab happens to be focused right now"; routing must never depend on it, and tests change it on purpose.
import type { ChatGptOpenResult, ChatGptViewState, NativeBridge, NativeCapabilities, NativeNotification } from '@minisumma/shared';

export interface FakeNative extends NativeBridge {
  clipboardWrites: string[];
  opened: { url: string; focus: boolean; reason: string }[];
  notifications: NativeNotification[];
  externalOpened: string[];
  savedFiles: { suggestedName: string; text: string }[];
  /** The page that "is in front" in the fake browser. Setting it must not change where reports go. */
  focusedUrl: string | null;
  failClipboard: boolean;
  /** What `chatgpt.open` reports. Default: embedded, opened, focused, verified. */
  openResult: (url: string) => ChatGptOpenResult;
  caps: NativeCapabilities;
}

export function createFakeNative(overrides: Partial<NativeCapabilities> = {}): FakeNative {
  const fake: FakeNative = {
    clipboardWrites: [], opened: [], notifications: [], externalOpened: [], savedFiles: [], focusedUrl: null, failClipboard: false,
    caps: { clipboard: true, chatgptEmbedded: true, extensionBridge: false, notifications: true, openExternal: true, saveFile: true, ...overrides },
    openResult: (url) => ({ ok: true, mode: 'embedded', opened: true, focused: true, verified: true, finalUrl: url, title: 'ChatGPT', note: null }),
    capabilities() { return fake.caps; },
    chatgpt: {
      async open(url, opts) {
        fake.opened.push({ url, focus: opts.focus, reason: opts.reason });
        const result = fake.openResult(url);
        if (result.ok) fake.focusedUrl = url;
        return result;
      },
      async verify(url) { return fake.openResult(url); },
      state(): ChatGptViewState { return { mode: 'embedded', status: 'ready', url: fake.focusedUrl, title: 'ChatGPT', canGoBack: false, canGoForward: false, note: null }; },
    },
    clipboard: {
      async writeText(text) {
        if (fake.failClipboard) throw new Error('The clipboard is locked by another application.');
        fake.clipboardWrites.push(text);
      },
    },
    async notify(n) { fake.notifications.push(n); return { shown: true }; },
    async openExternal(url) { fake.externalOpened.push(url); },
    async saveTextFile(opts) { fake.savedFiles.push(opts); return { path: `/tmp/${opts.suggestedName}` }; },
  };
  return fake;
}
