// Wires the pieces together once and hands them to React through context. Nothing here is a module-level singleton, so
// each test (and each window) gets its own store, route and terminals.
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ApiClient } from './api';
import { createLoader } from './loader';
import type { Loader } from './loader';
import { NativeProvider } from './native';
import type { RendererNative } from './native';
import { createRouteStore } from './route';
import type { RouteActions, RouteState, RouteStore } from './route';
import { createMemoryStorage } from './storage';
import type { KeyValueStorage } from './storage';
import { createAppStore } from './store';
import type { AppState, AppStore } from './store';
import { createUiStore } from './uiStore';
import type { UiActions, UiState, UiStore } from './uiStore';
import { TerminalRegistry } from '../terminals/terminals';
import type { TerminalAdapterFactory } from '../terminals/terminals';

export interface Runtime {
  api: ApiClient;
  native: RendererNative;
  store: AppStore;
  route: RouteStore;
  ui: UiStore;
  terminals: TerminalRegistry;
  loader: Loader;
  /** Where small per-window preferences are remembered (guarded localStorage, or memory in tests). */
  storage: KeyValueStorage;
  /** How the client was chosen: the desktop shell, a browser tab pointed at a core, or the in-memory demo. */
  mode: 'electron' | 'browser' | 'demo';
  dispose(): void;
}

export interface RuntimeOptions {
  api: ApiClient;
  native: RendererNative;
  mode: Runtime['mode'];
  adapterFactory: TerminalAdapterFactory;
  /** Where the last selection is remembered. Default: in memory. */
  storage?: KeyValueStorage;
  /** Connect and load straight away. Tests that drive the loader themselves pass false. */
  startLoader?: boolean;
  /** Frame scheduler for terminal fitting. Tests pass a synchronous one. */
  schedule?: (fn: () => void) => number;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { api, native, mode } = options;
  const storage = options.storage ?? createMemoryStorage();
  const store = createAppStore();
  const ui = createUiStore();
  const route = createRouteStore({
    storage,
    resolveSessionProject: (key) => store.getState().sessions.find((s) => s.key === key)?.projectId ?? null,
  });
  const terminals = new TerminalRegistry({ terminal: api.terminal, createAdapter: options.adapterFactory, schedule: options.schedule });
  const loader = createLoader({ api, store });

  const cleanups: (() => void)[] = [];

  // Terminals may send input only while the stream is live.
  terminals.setConnected(store.getState().connection === 'live');
  cleanups.push(store.subscribe((s, prev) => {
    if (s.connection !== prev.connection) terminals.setConnected(s.connection === 'live');
    if (s.sessions !== prev.sessions) {
      ui.getState().noteSessions(s.sessions);
      // A session that vanished from the core takes its terminal with it.
      const alive = new Set(s.sessions.map((x) => x.key));
      for (const key of terminals.keys()) if (!alive.has(key)) terminals.release(key);
    }
  }));
  // A closed tab releases its terminal; the session itself is untouched.
  cleanups.push(ui.subscribe((s, prev) => {
    if (s.openTabs === prev.openTabs) return;
    const open = new Set(Object.values(s.openTabs).flat());
    for (const key of terminals.keys()) if (!open.has(key)) terminals.release(key);
  }));
  cleanups.push(native.app.onNavigate((target) => route.getState().go(target)));

  if (options.startLoader !== false) loader.start();

  return {
    api, native, store, route, ui, terminals, loader, storage, mode,
    dispose() {
      loader.stop();
      for (const off of cleanups.splice(0)) off();
      terminals.dispose();
    },
  };
}

const RuntimeContext = createContext<Runtime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: Runtime; children?: ReactNode }) {
  return (
    <RuntimeContext.Provider value={runtime}>
      <NativeProvider native={runtime.native}>{children}</NativeProvider>
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useRuntime must be used inside <RuntimeProvider>.');
  return runtime;
}

/** The typed client of the core. Features depend on this, never on a concrete class. */
export function useApi(): ApiClient { return useRuntime().api; }

/**
 * Select from the store. The selector must return a stable value (a primitive, or an existing array/object from the
 * state); derive new arrays with useMemo on the pieces you selected, or wrap the selector in useShallow.
 */
export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(useRuntime().store, selector);
}

export function useAppStore(): AppStore { return useRuntime().store; }

export function useRouteState<T>(selector: (state: RouteState & RouteActions) => T): T {
  return useStore(useRuntime().route, selector);
}

/** Current route plus the actions that change it (go, selectProject, selectSession, back, ...). */
export function useRoute(): RouteState & RouteActions {
  return useStore(useRuntime().route);
}

export function useUi<T>(selector: (state: UiState & UiActions) => T): T {
  return useStore(useRuntime().ui, selector);
}

export function useTerminals(): TerminalRegistry { return useRuntime().terminals; }

export { useNative } from './native';
export type { UiStore };
