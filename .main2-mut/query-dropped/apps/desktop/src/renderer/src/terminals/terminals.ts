// One terminal per session, owned here, outside React.
//
// A terminal is created the first time its session is shown and then lives until its tab is closed or the session
// disappears. Layout changes, tab switches and project switches only MOVE its host element into whichever slot is
// visible (appendChild); the xterm instance is never recreated and open() is called exactly once. Hidden terminals keep
// receiving output (so they are up to date when shown again) but can never send input.
import type { SessionKey, TerminalHandle } from '@minisumma/shared';
import type { ApiClient } from '../app/api';

/** The few things the registry needs from a terminal emulator. xterm implements it; tests use a fake (jsdom has no canvas). */
export interface TerminalAdapter {
  readonly cols: number;
  readonly rows: number;
  /** Called once, with a host element that is already in the document. */
  open(host: HTMLElement): void;
  write(data: string): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  /** The size that fits the host's container right now, or null when it cannot be measured (hidden, zero size). */
  proposeSize(): { cols: number; rows: number } | null;
  focus(): void;
  blur(): void;
  /** Repaint after the host element moved to another parent. */
  refresh(): void;
  /** User input and terminal replies. The registry decides whether any of it may leave the window. */
  onData(listener: (data: string) => void): () => void;
  setReadOnly(readOnly: boolean): void;
  dispose(): void;
}

export type TerminalAdapterFactory = (key: SessionKey) => TerminalAdapter;

export type TerminalStatus = 'connecting' | 'attached' | 'exited' | 'error';

export interface TerminalInfo {
  status: TerminalStatus;
  exit: { code: number | null; signal: number | null; at: string; reason: string } | null;
  error: { code: string; message: string } | null;
  /** True once any output arrived, so the panel can tell "still starting" from "nothing was ever printed". */
  hasOutput: boolean;
}

interface Entry {
  key: SessionKey;
  adapter: TerminalAdapter;
  host: HTMLElement;
  opened: boolean;
  slot: HTMLElement | null;
  handle: TerminalHandle | null;
  info: TerminalInfo;
  observer: ResizeObserver | null;
  frame: number | null;
  /** The size the server's terminal is believed to have. */
  sent: { cols: number; rows: number } | null;
  offData: () => void;
}

export interface RegistryDeps {
  terminal: ApiClient['terminal'];
  createAdapter: TerminalAdapterFactory;
  /** Size used for a new session before any terminal has been measured. */
  defaultSize?: { cols: number; rows: number };
  /** Defer work to the next frame. Tests pass a synchronous version. */
  schedule?: (fn: () => void) => number;
  cancel?: (id: number) => void;
}

const DEFAULT_SIZE = { cols: 120, rows: 32 };

export class TerminalRegistry {
  private readonly entries = new Map<SessionKey, Entry>();
  private readonly listeners = new Set<() => void>();
  private activeKey: SessionKey | null = null;
  private connected = true;
  private parking: HTMLElement | null = null;
  private lastMeasured: { cols: number; rows: number } | null = null;

  constructor(private readonly deps: RegistryDeps) {}

  // ----------------------------------------------------------------------------------------------- queries

  has(key: SessionKey): boolean { return this.entries.has(key); }
  keys(): SessionKey[] { return [...this.entries.keys()]; }
  get active(): SessionKey | null { return this.activeKey; }
  /** The element that holds the terminal's DOM. Same element for the life of the session. */
  hostOf(key: SessionKey): HTMLElement | null { return this.entries.get(key)?.host ?? null; }
  adapterOf(key: SessionKey): TerminalAdapter | null { return this.entries.get(key)?.adapter ?? null; }
  info(key: SessionKey): TerminalInfo | null { return this.entries.get(key)?.info ?? null; }
  isMounted(key: SessionKey): boolean { return this.entries.get(key)?.slot != null; }
  /** Where a new session should size its PTY: what the visible terminal measured last, else a sensible default. */
  suggestedSize(): { cols: number; rows: number } { return this.lastMeasured ?? this.deps.defaultSize ?? DEFAULT_SIZE; }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(): void { for (const l of this.listeners) l(); }

  // ----------------------------------------------------------------------------------------------- mounting

  /**
   * Show the terminal of `key` inside `slot`. Creates it on first use. Returns the function that takes it out again,
   * which parks the host element instead of destroying anything.
   */
  mount(key: SessionKey, slot: HTMLElement): () => void {
    const entry = this.ensure(key);
    this.stopObserving(entry);
    entry.slot = slot;
    slot.appendChild(entry.host); // appendChild moves an element that already has a parent
    if (!entry.opened) {
      entry.adapter.open(entry.host);
      entry.opened = true;
    } else {
      entry.adapter.refresh();
    }
    this.observe(entry, slot);
    this.fitNow(entry);
    this.emit();
    return () => this.unmount(key, slot);
  }

  private unmount(key: SessionKey, slot: HTMLElement): void {
    const entry = this.entries.get(key);
    // A newer slot may already have taken over (layout switch); then the old one has nothing to give back.
    if (!entry || entry.slot !== slot) return;
    this.stopObserving(entry);
    entry.slot = null;
    this.park(entry.host);
    this.emit();
  }

  private ensure(key: SessionKey): Entry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const host = document.createElement('div');
    host.className = 'ms-term-host';
    host.dataset.sessionKey = key;
    const adapter = this.deps.createAdapter(key);
    const entry: Entry = {
      key, adapter, host, opened: false, slot: null, handle: null, observer: null, frame: null, sent: null, offData: () => {},
      info: { status: 'connecting', exit: null, error: null, hasOutput: false },
    };
    entry.offData = adapter.onData((data) => this.forward(entry, data));
    this.entries.set(key, entry);
    return entry;
  }

  private park(host: HTMLElement): void {
    if (!this.parking) {
      this.parking = document.createElement('div');
      this.parking.className = 'ms-term-parking';
      this.parking.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.parking);
    }
    this.parking.appendChild(host);
  }

  // ----------------------------------------------------------------------------------------------- sizing

  private observe(entry: Entry, slot: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    entry.observer = new ResizeObserver(() => this.scheduleFit(entry));
    entry.observer.observe(slot);
  }

  private stopObserving(entry: Entry): void {
    entry.observer?.disconnect();
    entry.observer = null;
    if (entry.frame !== null) { (this.deps.cancel ?? cancelAnimationFrame)(entry.frame); entry.frame = null; }
  }

  private scheduleFit(entry: Entry): void {
    if (entry.frame !== null) return;
    const schedule = this.deps.schedule ?? ((fn) => requestAnimationFrame(fn));
    entry.frame = schedule(() => { entry.frame = null; this.fitNow(entry); });
  }

  /** Fit to the visible slot, tell the server if the size changed, and attach for the first time once a size is known. */
  private fitNow(entry: Entry): void {
    if (!entry.slot || !entry.opened) return;
    const size = entry.adapter.proposeSize();
    if (!size) return; // hidden or zero-sized: do not shrink the PTY to nothing
    if (size.cols !== entry.adapter.cols || size.rows !== entry.adapter.rows) entry.adapter.resize(size.cols, size.rows);
    this.lastMeasured = size;
    if (!entry.handle) { this.attach(entry, size); return; }
    if (!entry.sent || entry.sent.cols !== size.cols || entry.sent.rows !== size.rows) {
      entry.sent = size;
      entry.handle.resize(size.cols, size.rows);
    }
  }

  // ----------------------------------------------------------------------------------------------- server link

  private attach(entry: Entry, size: { cols: number; rows: number }): void {
    entry.sent = size;
    entry.handle = this.deps.terminal.attach(entry.key, size, {
      onAttached: ({ replay, cols, rows }) => {
        // The replay is drawn at the size the server's terminal has, then the view is fitted to the pane again.
        entry.adapter.reset();
        if (cols !== entry.adapter.cols || rows !== entry.adapter.rows) entry.adapter.resize(cols, rows);
        entry.adapter.write(replay);
        entry.sent = { cols, rows };
        this.update(entry, { status: 'attached', error: null, hasOutput: entry.info.hasOutput || replay.length > 0 });
        this.fitNow(entry);
      },
      onData: (data) => {
        entry.adapter.write(data);
        if (!entry.info.hasOutput) this.update(entry, { hasOutput: true });
      },
      onExit: (exit) => {
        entry.adapter.setReadOnly(true);
        this.update(entry, { status: 'exited', exit });
      },
      onError: (code, message) => this.update(entry, { status: 'error', error: { code, message } }),
    });
  }

  private update(entry: Entry, patch: Partial<TerminalInfo>): void {
    entry.info = { ...entry.info, ...patch };
    this.emit();
  }

  // ----------------------------------------------------------------------------------------------- input

  /** Only the terminal of the selected tab in the visible Claude pane may send, and only while connected and attached. */
  canType(key: SessionKey): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry && this.activeKey === key && entry.slot && this.connected && entry.handle && entry.info.status === 'attached');
  }

  private forward(entry: Entry, data: string): void {
    if (!this.canType(entry.key)) return;
    entry.handle?.input(data);
  }

  /** Name the terminal that may send input, or null when none may (Claude pane hidden, observed session selected). */
  setActive(key: SessionKey | null): void {
    if (this.activeKey === key) return;
    const previous = this.activeKey ? this.entries.get(this.activeKey) : undefined;
    this.activeKey = key;
    previous?.adapter.blur();
    this.emit();
  }

  /** Move keyboard focus into the active terminal (the person chose to type there). */
  focus(key: SessionKey): void {
    const entry = this.entries.get(key);
    if (entry && entry.slot && this.activeKey === key) entry.adapter.focus();
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.emit();
  }

  // ----------------------------------------------------------------------------------------------- lifetime

  /** The session is gone or its tab was closed: detach from the server and dispose the emulator. */
  release(key: SessionKey): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.stopObserving(entry);
    entry.offData();
    try { entry.handle?.detach(); } catch { /* the stream may already be closed */ }
    entry.adapter.dispose();
    entry.host.remove();
    this.entries.delete(key);
    if (this.activeKey === key) this.activeKey = null;
    this.emit();
  }

  dispose(): void {
    for (const key of this.keys()) this.release(key);
    this.parking?.remove();
    this.parking = null;
  }
}
