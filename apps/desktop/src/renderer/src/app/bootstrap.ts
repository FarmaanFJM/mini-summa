// Chooses how this window reaches the core and builds the runtime.
//   desktop shell   window.miniSumma exists: ask it for the address and token of the embedded core.
//   demo            `?demo=1`: an in-memory core with realistic data (tests, screenshots, design review).
//   browser         `#base=<url>&token=<token>` in the address: a plain web client of a running core.
import { MiniSummaClient } from '@minisumma/shared';
import { createXtermAdapterFactory } from '../terminals/xtermAdapter';
import type { ApiClient } from './api';
import { chooseClient } from './clientChoice';
import { detectNative } from './native';
import type { RendererNative } from './native';
import { createRuntime } from './runtime';
import type { Runtime } from './runtime';
import { safeLocalStorage } from './storage';

export type { ApiClient } from './api';
export { chooseClient } from './clientChoice';
export type { ClientChoice, DemoScenarioName, LocationLike } from './clientChoice';

export type BootstrapResult = { ok: true; runtime: Runtime } | { ok: false; message: string };

function build(api: ApiClient, native: RendererNative, mode: Runtime['mode']): Runtime {
  const desktopShell = mode === 'electron';
  return createRuntime({
    api,
    native,
    mode,
    storage: safeLocalStorage(),
    adapterFactory: createXtermAdapterFactory({
      webgl: desktopShell,
      conpty: desktopShell && native.platform === 'win32',
      openLink: (url) => { void native.shell.openExternal(url).catch(() => {}); },
      copyText: (text) => { void native.clipboard.writeText(text).catch(() => {}); },
    }),
  });
}

export async function bootstrap(): Promise<BootstrapResult> {
  const choice = chooseClient({ hasDesktopShell: typeof window.miniSumma !== 'undefined', location: window.location });
  try {
    switch (choice.kind) {
      case 'electron': {
        const native = detectNative();
        const { baseUrl, token } = await native.connection();
        return { ok: true, runtime: build(new MiniSummaClient({ baseUrl, token, clientName: 'desktop-renderer' }), native, 'electron') };
      }
      case 'remote': {
        const api = new MiniSummaClient({ baseUrl: choice.baseUrl, token: choice.token, clientName: 'desktop-renderer' });
        return { ok: true, runtime: build(api, detectNative(), 'browser') };
      }
      case 'demo': {
        const [{ createDemoClient }, { createDemoNative }] = await Promise.all([import('../dev/demoClient'), import('../dev/demoNative')]);
        const demo = createDemoClient({ scenario: choice.scenario });
        const native = choice.simulateNative
          ? createDemoNative({ titleFor: (url) => demo.demo.server.data.conversations.find((c) => c.url === url)?.title ?? null })
          : detectNative();
        demo.demo.server.onOpen = (url) => { void native.chatgpt.navigate(url); };
        // `&trust=1`: new sessions start on Claude's "Do you trust the files in this folder?" screen, to see the Starting hint.
        demo.demo.server.trustPrompt = new URLSearchParams(window.location.search).get('trust') === '1';
        (window as unknown as { __minisummaDemo?: unknown }).__minisummaDemo = demo.demo;
        return { ok: true, runtime: build(demo, native, 'demo') };
      }
      default:
        return { ok: false, message: choice.reason };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
