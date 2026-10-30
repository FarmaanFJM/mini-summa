// What the renderer can ask of its host. In Electron this is window.miniSumma; in a plain browser (dev, tests,
// screenshots) it is a fallback that does what a web page can and says so through its flags.
import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';
import type { ChatGptViewState, NativeApi } from '@minisumma/shared';

export interface RendererNative extends Omit<NativeApi, 'kind'> {
  readonly kind: 'electron' | 'browser';
  /** The embedded ChatGPT view exists only inside the desktop shell. */
  readonly hasEmbeddedChatGpt: boolean;
  /** "Browse" can open a real folder picker only inside the desktop shell. */
  readonly hasFolderPicker: boolean;
}

const IDLE_EXTERNAL: ChatGptViewState = {
  mode: 'external', status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null,
};

async function copyWithFallback(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Insecure contexts have no async clipboard. A temporary textarea and execCommand is the portable fallback.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('The browser refused to copy.');
  } finally {
    area.remove();
  }
}

const noop = async (): Promise<void> => {};

const SAFE_PROTOCOLS = new Set(['https:', 'http:']);

export function createBrowserNative(): RendererNative {
  const nav = typeof navigator !== 'undefined' ? navigator.platform : '';
  const platform = /win/i.test(nav) ? 'win32' : /mac/i.test(nav) ? 'darwin' : 'linux';
  return {
    kind: 'browser',
    appVersion: 'browser',
    platform,
    hasEmbeddedChatGpt: false,
    hasFolderPicker: false,
    connection: async () => { throw new Error('The browser build takes its address and token from the URL hash.'); },
    chatgpt: {
      setBounds: noop, setOverlayActive: noop, navigate: noop, reload: noop, back: noop, forward: noop, focus: noop,
      getState: async () => IDLE_EXTERNAL,
      onState: () => () => {},
    },
    clipboard: { writeText: copyWithFallback },
    dialogs: { selectDirectory: async () => null },
    shell: {
      openExternal: async (url) => {
        const parsed = new URL(url);
        if (!SAFE_PROTOCOLS.has(parsed.protocol)) throw new Error('Only web addresses can be opened.');
        window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
      },
      showItemInFolder: noop,
    },
    app: { onNavigate: () => () => {}, setBadgeCount: noop, getPaths: async () => ({ dataDir: '', logsDir: '' }) },
  };
}

export function fromElectron(api: NativeApi): RendererNative {
  return { ...api, kind: 'electron', hasEmbeddedChatGpt: true, hasFolderPicker: true };
}

let browserSingleton: RendererNative | null = null;
function browserNative(): RendererNative {
  browserSingleton ??= createBrowserNative();
  return browserSingleton;
}

/** window.miniSumma if the preload exposed it, otherwise the browser fallback. */
export function detectNative(): RendererNative {
  const api = typeof window !== 'undefined' ? window.miniSumma : undefined;
  return api ? fromElectron(api) : browserNative();
}

const NativeContext = createContext<RendererNative | null>(null);

export function NativeProvider({ native, children }: { native: RendererNative; children?: ReactNode }) {
  return createElement(NativeContext.Provider, { value: native }, children);
}

/** window.miniSumma, or a browser fallback when there is no desktop shell (and no provider, as in isolated tests). */
export function useNative(): RendererNative {
  return useContext(NativeContext) ?? browserNative();
}
