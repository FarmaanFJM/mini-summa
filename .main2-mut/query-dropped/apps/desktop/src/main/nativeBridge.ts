// What the core gets from its host (NativeBridge). Electron objects are injected by index.ts so this stays testable.
import path from 'node:path';
import type { NativeBridge } from '@minisumma/shared';
import type { ChatGptView } from './chatgptView.ts';
import type { Notifier } from './notifications.ts';
import { validateClipboardText, validateExternalUrl } from './validation.ts';

export interface NativeBridgeDeps {
  chatgpt: Pick<ChatGptView, 'open' | 'verify' | 'getState'>;
  notifier: Pick<Notifier, 'notify'>;
  notificationsSupported(): boolean;
  clipboard: { writeText(text: string): Promise<void>; readText(): Promise<string> };
  openExternal(url: string): Promise<void>;
  showSaveDialog(opts: { defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>;
  writeFile(file: string, text: string): Promise<void>;
  documentsDir(): string;
}

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A file name that is safe to offer in a save dialog on any platform: no path parts, no reserved names. */
export function sanitizeFileName(name: unknown, fallback = 'mini-summa-report.md'): string {
  if (typeof name !== 'string') return fallback;
  let n = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  if (n === '' || RESERVED_WINDOWS_NAMES.test(n)) n = n === '' ? fallback : `_${n}`;
  return n;
}

const normalizeNewlines = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\0+$/, '');

export function createNativeBridge(deps: NativeBridgeDeps): NativeBridge {
  return {
    // The extension is composed by the core itself, so the host never claims it.
    capabilities: () => ({
      clipboard: true, chatgptEmbedded: true, extensionBridge: false,
      notifications: deps.notificationsSupported(), openExternal: true, saveFile: true,
    }),

    chatgpt: {
      open: (url, opts) => deps.chatgpt.open(url, opts),
      verify: (url) => deps.chatgpt.verify(url),
      state: () => deps.chatgpt.getState(),
    },

    clipboard: {
      async writeText(text) {
        const value = validateClipboardText(text);
        await deps.clipboard.writeText(value);
        // A clipboard another program is holding can reject a write without any error. Pasting a stale clipboard into
        // ChatGPT would be worse than a visible failure, so the write is read back.
        if (normalizeNewlines(await deps.clipboard.readText()) !== normalizeNewlines(value)) {
          throw new Error('The clipboard did not accept the text. Another program may be using it; try again.');
        }
      },
    },

    notify: (n) => deps.notifier.notify(n),

    async openExternal(url) {
      await deps.openExternal(validateExternalUrl(url));
    },

    async saveTextFile({ suggestedName, text }) {
      if (typeof text !== 'string' || text.length > 50_000_000) throw new Error('Invalid file contents.');
      const chosen = await deps.showSaveDialog({ defaultPath: path.join(deps.documentsDir(), sanitizeFileName(suggestedName)) });
      if (chosen.canceled || !chosen.filePath) return { path: null };
      await deps.writeFile(chosen.filePath, text);
      return { path: chosen.filePath };
    },
  };
}
