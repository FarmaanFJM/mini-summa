// The embedded ChatGPT views of the projects: one live view per project, a bounded number of them, one browser session between them.
//
// A project is a persistent workspace, so leaving it must not throw its ChatGPT page away. Each project (the key the renderer passes,
// the project id) has a ChatGptView controller of its own with its own native view, and they all share the one `persist:chatgpt`
// session, so there is one login. Switching projects only hides one view and shows another: the conversation, the scroll position and
// an unsent draft stay.
//
// Memory is the limit. Every live view is a renderer process with a full ChatGPT page in it (see MAX_LIVE_CHATGPT_VIEWS), so the
// number of live views is bounded. When a view is needed beyond the bound, the least recently used view that is not the active one is
// destroyed, and the person is told (a notice the window shows): whatever was unsent in it is gone, and the page loads again at its last
// address the next time the project is opened. Mini-Summa never reads the page, so it cannot know whether a draft was there; the notice
// always says that unsent text is gone.
//
// What this file keeps from chatgptView.ts: a view is never destroyed because of layout, hiding, an overlay or a window change. The
// ONLY thing that destroys one is `evict`, called only when a new view is needed and the bound is reached.
//
// Calls without a key act on the active view (the one most recently placed or focused), and with nothing active on a default
// one, which is how the single view worked before there were keys.
import type { ChatGptOpenResult, ChatGptViewState, Rect } from '@minisumma/shared';
import { ChatGptView } from './chatgptView.ts';
import type { ChatGptViewDeps, OpenReason, ViewHandle } from './chatgptView.ts';
import type { PageScale } from './pageScale.ts';
import { EMPTY_VIEW_STATE } from './viewState.ts';

/**
 * How many ChatGPT views stay alive at once. Four.
 *
 * Why a bound at all: each live view keeps a full renderer process with the ChatGPT page, its scripts and its conversation in memory
 * even while hidden. Measured on Linux under Xvfb with the local stand-in page (docs/CHATGPT_PANE.md has the figures and how they were
 * taken), a view costs about the number given there; the real chatgpt.com page is much heavier than the stand-in, and OpenAI documents
 * nothing about it, so the figure to plan with for the real site is the 100 to 250 MB per view that Chromium renderers commonly use for a
 * single-page application of this kind. That is an estimate, not a measurement of the real site. Four live views are then roughly 0.4
 * to 1 GB, which a desktop that runs Claude Code beside it can afford; ten would not be. Raise it only with a measurement.
 */
export const MAX_LIVE_CHATGPT_VIEWS = 4;

/** What the shell needs to make a real view and to take it away again. */
export interface PooledViewHandle extends ViewHandle {
  /** Removes the native view from the window and closes its page. Called only by an eviction. */
  destroy(): void;
}

export interface ChatGptViewsDeps extends Omit<ChatGptViewDeps, 'createView'> {
  createView(): PooledViewHandle;
  /** The bound on live views. Default MAX_LIVE_CHATGPT_VIEWS. */
  maxLive?: number;
}

/** Said to the window when a view was destroyed to stay within the bound. */
export interface ChatGptViewNotice {
  kind: 'unloaded';
  /** The key of the project whose view was destroyed. */
  key: string | null;
  /** The last address the view showed. The page loads again there. */
  url: string | null;
}

interface Entry {
  view: ChatGptView;
  /** Taken from the handle when the native view is created. */
  destroy: (() => void) | null;
  /** Position in the use order: bigger is more recent. */
  used: number;
  off: () => void;
}

type StateListener = (state: ChatGptViewState, key: string | null) => void;

export class ChatGptViews {
  private readonly entries = new Map<string | null, Entry>();
  private active: string | null = null;
  private clock = 0;
  private overlay = false;
  private pageScale: PageScale = 'auto';
  private readonly listeners = new Set<StateListener>();
  private readonly noticeListeners = new Set<(n: ChatGptViewNotice) => void>();
  private readonly maxLive: number;

  constructor(private readonly deps: ChatGptViewsDeps) {
    // At least two: the active view is never unloaded, and a new view needs room that is not the active one's.
    this.maxLive = Math.max(2, deps.maxLive ?? MAX_LIVE_CHATGPT_VIEWS);
  }

  // ---- what the renderer controls (each call may name a project's view) ---------------------------------------------

  setBounds(rect: Rect | null, key?: string): void {
    const k = this.resolve(key);
    if (rect !== null) {
      // One pane shows one view: placing this one takes the others off the screen (they stay alive).
      this.active = k;
      for (const [other, entry] of this.entries) if (other !== k) entry.view.setBounds(null);
      this.touch(k);
    }
    const entry = this.entries.get(k);
    if (entry) entry.view.setBounds(rect);
    else if (rect !== null) this.entry(k).view.setBounds(rect); // remembered until the view is created
  }

  /** A menu, dialog or toast of the renderer covers every view. */
  setOverlayActive(active: boolean): void {
    this.overlay = active;
    for (const entry of this.entries.values()) entry.view.setOverlayActive(active);
  }

  reapply(): void { for (const entry of this.entries.values()) entry.view.reapply(); }

  setPageScale(scale: PageScale): void {
    this.pageScale = scale;
    for (const entry of this.entries.values()) entry.view.setPageScale(scale);
  }

  async navigate(rawUrl: string, key?: string): Promise<void> {
    const k = this.resolve(key);
    // Loading a page does not make a view the active one: placing it on screen does (setBounds). A late navigation of the project that was
    // just left must not take the active place, and so protection from eviction, away from the view that is on screen.
    this.touch(k);
    await this.entry(k).view.navigate(rawUrl);
  }

  reload(key?: string): void { this.entries.get(this.resolve(key))?.view.reload(); }
  back(key?: string): void { this.entries.get(this.resolve(key))?.view.back(); }
  forward(key?: string): void { this.entries.get(this.resolve(key))?.view.forward(); }

  focus(key?: string): void {
    const k = this.resolve(key);
    this.active = k;
    this.touch(k);
    this.entries.get(k)?.view.focus();
  }

  /** The state of a project's view; a project without a live view is idle (nothing was asked of it, or it was unloaded). */
  getState(key?: string): ChatGptViewState {
    return this.entries.get(this.resolve(key))?.view.getState() ?? EMPTY_VIEW_STATE;
  }

  get showing(): boolean { return this.entries.get(this.active)?.view.showing ?? false; }

  /** Every state change of every view, with the key of the view. */
  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onNotice(listener: (n: ChatGptViewNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => { this.noticeListeners.delete(listener); };
  }

  /** The key of the active view, and the keys that have a live view, most recently used last. For the log and the tests. */
  get activeKey(): string | null { return this.active; }
  liveKeys(): (string | null)[] {
    return [...this.entries].filter(([, e]) => e.view.hasView).sort((a, b) => a[1].used - b[1].used).map(([k]) => k);
  }

  // ---- what the core controls: the active view ------------------------------------------------------------------------

  async open(rawUrl: string, opts: { focus: boolean; reason: OpenReason }): Promise<ChatGptOpenResult> {
    // The pane that is on screen decides which project's view receives it: if none is placed yet, ask for the workspace and wait for it.
    if (!this.entries.get(this.active)?.view.placed) {
      this.deps.requestWorkspace();
      await this.waitForPlacement(this.deps.timing?.boundsWaitMs ?? 2000);
    }
    this.touch(this.active);
    return this.entry(this.active).view.open(rawUrl, opts);
  }

  verify(rawUrl: string): Promise<ChatGptOpenResult> {
    return this.open(rawUrl, { focus: false, reason: 'verify' });
  }

  // ---- internals -------------------------------------------------------------------------------------------------------

  private resolve(key: string | undefined | null): string | null { return key === undefined || key === null ? this.active : key; }

  private touch(key: string | null): void {
    const entry = this.entries.get(key);
    if (entry) entry.used = ++this.clock;
  }

  private entry(key: string | null): Entry {
    const have = this.entries.get(key);
    if (have) return have;
    const entry: Entry = { view: null as unknown as ChatGptView, destroy: null, used: ++this.clock, off: () => undefined };
    entry.view = new ChatGptView({
      ...this.deps,
      createView: () => this.createLive(key, entry),
    });
    entry.off = entry.view.onState((state) => { for (const l of [...this.listeners]) l(state, key); });
    entry.view.setPageScale(this.pageScale);
    entry.view.setOverlayActive(this.overlay);
    this.entries.set(key, entry);
    return entry;
  }

  /** Makes the native view of `key`; first makes room if the bound is reached. */
  private createLive(key: string | null, entry: Entry): ViewHandle {
    while ([...this.entries].filter(([k, e]) => k !== key && e.view.hasView).length >= this.maxLive) {
      if (!this.evictOne(key)) break; // nothing can go: only the active and the requested view are alive
    }
    const handle = this.deps.createView();
    entry.destroy = () => handle.destroy();
    return handle;
  }

  /** Destroys the least recently used live view that is neither `except` nor the active one. Returns false when there is none. */
  private evictOne(except: string | null): boolean {
    let victim: string | null | undefined;
    let oldest = Infinity;
    for (const [k, e] of this.entries) {
      if (k === except || k === this.active || !e.view.hasView) continue;
      if (e.used > oldest || oldest === Infinity) { oldest = e.used; victim = k; }
    }
    if (victim === undefined) return false;
    this.evict(victim);
    return true;
  }

  private evict(key: string | null): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const url = entry.view.address;
    this.entries.delete(key);
    entry.off();
    try { entry.destroy?.(); } catch (error) { this.deps.log.warn('chatgpt view could not be closed', { error }); }
    entry.view.retire();
    this.deps.log.info('chatgpt view unloaded to stay within the limit', { live: this.liveKeys().length, limit: this.maxLive });
    for (const l of [...this.listeners]) l(EMPTY_VIEW_STATE, key);
    for (const l of [...this.noticeListeners]) l({ kind: 'unloaded', key, url });
  }

  private waitForPlacement(ms: number): Promise<boolean> {
    const placed = (): boolean => this.entries.get(this.active)?.view.placed === true;
    if (placed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (placed()) { clearInterval(tick); resolve(true); }
        else if (Date.now() - started >= ms) { clearInterval(tick); resolve(false); }
      }, 20);
    });
  }
}
