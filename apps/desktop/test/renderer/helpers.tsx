// Shared test doubles and a harness that boots the whole renderer on the in-memory demo core.
import type { ChatGptViewState, NavigationTarget, Rect, SessionKey } from '@minisumma/shared';
import { render, screen, waitFor } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type { RendererNative } from '../../src/renderer/src/app/native';
import { createRuntime, RuntimeProvider } from '../../src/renderer/src/app/runtime';
import type { Runtime } from '../../src/renderer/src/app/runtime';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import type { KeyValueStorage } from '../../src/renderer/src/app/storage';
import { Toaster } from '../../src/renderer/src/ui';
import { createDemoClient } from '../../src/renderer/src/dev/demoClient';
import type { DemoClient, DemoClientOptions } from '../../src/renderer/src/dev/demoClient';
import type { TerminalAdapter } from '../../src/renderer/src/terminals/terminals';

// ---------------------------------------------------------------------------------------------------------------
// A terminal emulator that records what it was asked to do.

export class FakeAdapter implements TerminalAdapter {
  cols = 80;
  rows = 24;
  openCount = 0;
  disposed = false;
  opened: HTMLElement | null = null;
  readonly writes: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  resets = 0;
  refreshes = 0;
  focusCount = 0;
  readOnly = false;
  /** Every mutating call in order, for tests that care about sequence ("reset", "resize:90x28", "write"). */
  readonly ops: string[] = [];
  /** What proposeSize returns; null means "cannot be measured" (hidden). */
  proposed: { cols: number; rows: number } | null = { cols: 100, rows: 30 };
  private readonly listeners = new Set<(data: string) => void>();

  constructor(readonly key: SessionKey) {}

  open(host: HTMLElement): void { this.openCount += 1; this.opened = host; }
  write(data: string): void { this.ops.push('write'); this.writes.push(data); }
  reset(): void { this.ops.push('reset'); this.resets += 1; this.writes.length = 0; }
  resize(cols: number, rows: number): void { this.ops.push(`resize:${cols}x${rows}`); this.cols = cols; this.rows = rows; this.resizes.push({ cols, rows }); }
  proposeSize(): { cols: number; rows: number } | null { return this.proposed; }
  focus(): void { this.focusCount += 1; }
  blur(): void {}
  refresh(): void { this.refreshes += 1; }
  onData(listener: (data: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setReadOnly(readOnly: boolean): void { this.readOnly = readOnly; }
  dispose(): void { this.disposed = true; this.listeners.clear(); }

  /** Pretend the person typed (or the emulator answered a query). */
  type(data: string): void { for (const l of [...this.listeners]) l(data); }
  get text(): string { return this.writes.join(''); }
}

export function adapterFactory(): { factory: (key: SessionKey) => FakeAdapter; adapters: Map<SessionKey, FakeAdapter>; created: FakeAdapter[] } {
  const adapters = new Map<SessionKey, FakeAdapter>();
  const created: FakeAdapter[] = [];
  return {
    adapters,
    created,
    factory: (key) => {
      const adapter = new FakeAdapter(key);
      adapters.set(key, adapter);
      created.push(adapter);
      return adapter;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// window.miniSumma, as a set of spies.

export interface FakeNative {
  native: RendererNative;
  /** Emit a ChatGPT view state to onState listeners. */
  emitView(state: Partial<ChatGptViewState>): void;
  /** Deliver a navigation request, as the main process does for a notification click. */
  navigate(target: NavigationTarget): void;
  lastBounds(): Rect | null | undefined;
}

export function createFakeNative(over: { embedded?: boolean; view?: Partial<ChatGptViewState> } = {}): FakeNative {
  let view: ChatGptViewState = { mode: 'embedded', status: 'ready', url: null, title: null, canGoBack: false, canGoForward: false, note: null, ...over.view };
  const listeners = new Set<(s: ChatGptViewState) => void>();
  let navigateListener: ((t: NavigationTarget) => void) | null = null;
  const bounds = vi.fn(async (_rect: Rect | null) => {});
  const embedded = over.embedded ?? true;
  const native: RendererNative = {
    kind: embedded ? 'electron' : 'browser',
    appVersion: 'test',
    platform: 'win32',
    hasEmbeddedChatGpt: embedded,
    hasFolderPicker: embedded,
    connection: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:0', token: 'test' })),
    chatgpt: {
      setBounds: bounds,
      setOverlayActive: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
      forward: vi.fn(async () => {}),
      focus: vi.fn(async () => {}),
      getState: vi.fn(async () => view),
      onState: vi.fn((l: (s: ChatGptViewState) => void) => { listeners.add(l); return () => { listeners.delete(l); }; }),
    },
    clipboard: { writeText: vi.fn(async () => {}) },
    dialogs: { selectDirectory: vi.fn(async () => null) },
    shell: { openExternal: vi.fn(async () => {}), showItemInFolder: vi.fn(async () => {}) },
    app: {
      onNavigate: vi.fn((l: (t: NavigationTarget) => void) => { navigateListener = l; return () => { navigateListener = null; }; }),
      setBadgeCount: vi.fn(async () => {}),
      getPaths: vi.fn(async () => ({ dataDir: '', logsDir: '' })),
    },
  };
  return {
    native,
    emitView(state) { view = { ...view, ...state }; for (const l of listeners) l(view); },
    navigate(target) { navigateListener?.(target); },
    lastBounds() { return bounds.mock.calls.at(-1)?.[0]; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The whole renderer on the demo core.

export interface HarnessOptions extends DemoClientOptions {
  native?: FakeNative;
  storage?: KeyValueStorage;
  /** Do not connect on creation (the test drives the loader itself). */
  startLoader?: boolean;
  /** Timing of the writes that keep the core's copy of what the window remembers. Tests make it short. */
  uiSync?: Parameters<typeof createRuntime>[0]['uiSync'];
  /** What happens to a remembered change as the page closes. */
  sendOnClose?: Parameters<typeof createRuntime>[0]['sendOnClose'];
}

export interface Harness {
  runtime: Runtime;
  demo: DemoClient;
  fake: FakeNative;
  adapters: Map<SessionKey, FakeAdapter>;
  created: FakeAdapter[];
  storage: KeyValueStorage;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const demo = createDemoClient({ latencyMs: 0, ...options });
  const fake = options.native ?? createFakeNative();
  const { factory, adapters, created } = adapterFactory();
  const storage = options.storage ?? createMemoryStorage();
  const runtime = createRuntime({
    api: demo, native: fake.native, mode: 'demo', adapterFactory: factory, storage, startLoader: options.startLoader,
    schedule: (fn) => { fn(); return 0; }, uiSync: options.uiSync, sendOnClose: options.sendOnClose,
  });
  return { runtime, demo, fake, adapters, created, storage };
}

export interface RenderedApp extends Harness, RenderResult {}

/**
 * Boot the shell on the demo core and wait until the project list is on screen. It is the shell without the onboarding gate:
 * the gate and the activity, reports and settings views belong to the feature worker. A test of the shell stands those views
 * in (see stubViews.tsx); a test of one of those views simply navigates to it. The shell is imported here, not at the top, so
 * a test file that only needs the doubles above never loads it.
 */
export async function renderApp(options: HarnessOptions = {}): Promise<RenderedApp> {
  const { Shell } = await import('../../src/renderer/src/features/shell/Shell');
  const harness = createHarness(options);
  // A fresh #root every time: RTL refuses to render again into a container whose root it has unmounted.
  document.getElementById('root')?.remove();
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  const view = render(<RuntimeProvider runtime={harness.runtime}><Shell /><Toaster /></RuntimeProvider>, { container });
  if (options.startLoader !== false && (options.scenario ?? 'normal') === 'normal') {
    await screen.findByRole('button', { name: /^GitManager/ });
  }
  return { ...harness, ...view };
}

export async function until(check: () => boolean, message = 'condition'): Promise<void> {
  await waitFor(() => { if (!check()) throw new Error(`Timed out waiting for ${message}`); });
}

/** Give a measured element a size (jsdom has no layout). */
export function stubRect(el: Element, rect: { x?: number; y?: number; width: number; height: number }): void {
  const { x = 0, y = 0, width, height } = rect;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) });
}
