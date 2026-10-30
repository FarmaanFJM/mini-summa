// The embedded ChatGPT view: behaviour only, no Electron imports (electronView.ts adapts a real WebContentsView).
//
// Rules this file keeps:
//  * Mini-Summa never reads or touches the page: no scripts, no DOM access, no clicks, no typing, no user-agent change.
//    It looks only at the address, the title, whether a load is running and why a load failed.
//  * The view is created on first need and never destroyed because of layout changes, so scroll position, drafts and the
//    login survive the renderer showing, hiding or moving the pane.
//  * Navigation of the top frame is restricted with the shared classifyNavigation policy.
//  * open() reports only what it could observe. `verified` is true when the final address is the requested page AND the
//    view does not look like a sign-in page, a security check or a failed load. It is an address check, not a content check.
//
// Local decisions on top of the contract (also in the report):
//  * If the renderer has not placed the pane when open() is called, the view is NOT navigated: the result says the pane
//    is not on screen. Loading a hidden pane would change what the user sees later without any action of theirs.
//  * A view that was never asked to load anything does not exist, so the renderer's empty state is never covered.
import { classifyNavigation, parseChatGptUrl, sameChatGptPage } from '@minisumma/shared';
import type { ChatGptOpenResult, ChatGptViewState, Rect } from '@minisumma/shared';
import { sameRect, toViewBounds } from './bounds.ts';
import type { Logger } from './log.ts';
import { isExternalUrl } from './validation.ts';
import { classifyFailure, deriveViewState, EMPTY_VIEW_STATE } from './viewState.ts';
import type { ViewObservation } from './viewState.ts';

/** The part of Electron's WebContents that the controller uses, so a fake can stand in for it in tests. */
export interface ViewContents {
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  isFocused(): boolean;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  focus(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}

export interface ViewHandle {
  contents: ViewContents;
  setBounds(rect: Rect): void;
  setVisible(visible: boolean): void;
}

export type OpenReason = 'handoff' | 'user' | 'verify';

export interface ChatGptViewDeps {
  /** Creates the native view and attaches it to the window. Called at most once. */
  createView(): ViewHandle;
  /** Window content area in DIP and the renderer page's zoom factor; null when there is no window. */
  content(): { width: number; height: number; zoomFactor: number } | null;
  /** Ask the renderer to show the workspace, which places the pane. */
  requestWorkspace(): void;
  /** Bring the app window to the front (restore, show, focus). */
  revealWindow(): void;
  /** Hand a link to the system browser. The caller has already checked it is a plain https link. */
  openExternal(url: string): void;
  log: Logger;
  timing?: Partial<Timing>;
}

export interface Timing { boundsWaitMs: number; loadTimeoutMs: number; settleMs: number; focusWaitMs: number }

const DEFAULT_TIMING: Timing = { boundsWaitMs: 2000, loadTimeoutMs: 20_000, settleMs: 1000, focusWaitMs: 200 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type LoadOutcome =
  | { kind: 'finished' }
  | { kind: 'failed'; code: number; description: string }
  | { kind: 'cancelled'; url: string; decision: 'blocked' | 'external' }
  | { kind: 'timeout' };

export class ChatGptView {
  private view: ViewHandle | null = null;
  private rect: Rect | null = null;
  private overlay = false;
  private applied: { bounds: Rect | null; visible: boolean } = { bounds: null, visible: false };
  private obs: ViewObservation = { url: null, title: null, loading: false, failure: null };
  private state: ChatGptViewState = EMPTY_VIEW_STATE;
  private readonly listeners = new Set<(s: ChatGptViewState) => void>();
  private readonly boundsWaiters = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCancel: { url: string; decision: 'blocked' | 'external'; at: number } | null = null;
  private readonly timing: Timing;

  constructor(private readonly deps: ChatGptViewDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  // ---- what the renderer controls ------------------------------------------------------------------------------

  setBounds(rect: Rect | null): void {
    this.rect = rect;
    this.reapply();
    if (rect !== null) for (const wake of [...this.boundsWaiters]) wake();
  }

  setOverlayActive(active: boolean): void {
    this.overlay = active;
    this.reapply();
  }

  /** Re-derives the native bounds from the last rectangle; called on resize, maximize, fullscreen, zoom and display changes. */
  reapply(): void {
    const view = this.view;
    if (!view) return;
    const content = this.deps.content();
    const bounds = this.rect && content ? toViewBounds(this.rect, content.zoomFactor, content) : null;
    const visible = bounds !== null && !this.overlay;
    if (bounds && !sameRect(bounds, this.applied.bounds)) { view.setBounds(bounds); this.applied.bounds = bounds; }
    if (visible !== this.applied.visible) { view.setVisible(visible); this.applied.visible = visible; }
  }

  /** Whether the pane is placed and not covered by an overlay right now. */
  get showing(): boolean { return this.applied.visible; }

  getState(): ChatGptViewState { return this.state; }

  onState(listener: (s: ChatGptViewState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async navigate(rawUrl: string): Promise<void> {
    const parsed = parseChatGptUrl(rawUrl);
    if (!parsed.ok) throw new Error(parsed.message);
    const view = this.ensureView();
    if (this.isShowingPage(parsed.info.url)) return;
    this.obs.loading = true;
    this.refresh();
    view.contents.loadURL(parsed.info.url).catch(() => { /* failures arrive as did-fail-load */ });
  }

  reload(): void {
    const c = this.view?.contents;
    if (c && !c.isDestroyed() && c.getURL() !== '') c.reload();
  }

  back(): void { const c = this.view?.contents; if (c && !c.isDestroyed() && c.canGoBack()) c.goBack(); }

  forward(): void { const c = this.view?.contents; if (c && !c.isDestroyed() && c.canGoForward()) c.goForward(); }

  focus(): void { const c = this.view?.contents; if (c && !c.isDestroyed() && this.applied.visible) c.focus(); }

  // ---- what the core controls ----------------------------------------------------------------------------------

  open(rawUrl: string, opts: { focus: boolean; reason: OpenReason }): Promise<ChatGptOpenResult> {
    // One open at a time: a verify must not interleave with a handoff.
    const run = (): Promise<ChatGptOpenResult> => this.openNow(rawUrl, opts);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  verify(rawUrl: string): Promise<ChatGptOpenResult> {
    return this.open(rawUrl, { focus: false, reason: 'verify' });
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  private result(partial: Partial<ChatGptOpenResult> & Pick<ChatGptOpenResult, 'ok' | 'opened' | 'note'>): ChatGptOpenResult {
    return { mode: 'embedded', focused: false, verified: null, finalUrl: this.obs.url, title: this.obs.title, ...partial };
  }

  private isShowingPage(url: string): boolean {
    return this.obs.url !== null && this.state.status === 'ready' && sameChatGptPage(this.obs.url, url);
  }

  private async openNow(rawUrl: string, opts: { focus: boolean; reason: OpenReason }): Promise<ChatGptOpenResult> {
    const parsed = parseChatGptUrl(rawUrl);
    if (!parsed.ok) {
      return this.result({ ok: false, opened: false, finalUrl: null, title: null, note: `Nothing was opened. ${parsed.message}` });
    }
    const url = parsed.info.url;
    this.deps.log.info('chatgpt open', { reason: opts.reason, focus: opts.focus });

    if (this.deps.content() === null) {
      return this.result({ ok: false, opened: false, note: 'The ChatGPT pane is not available because the window is closed.' });
    }
    if (this.rect === null) {
      this.deps.requestWorkspace();
      if (!(await this.waitForBounds())) {
        return this.result({
          ok: false, opened: false,
          note: 'The ChatGPT pane is not on screen, so nothing was opened. Show the workspace with the ChatGPT pane visible and try again.',
        });
      }
    }
    let view: ViewHandle;
    try { view = this.ensureView(); } catch (err) {
      this.deps.log.warn('chatgpt view could not be created', { error: err });
      return this.result({ ok: false, opened: false, note: 'The ChatGPT pane could not be created.' });
    }

    let outcome: LoadOutcome = { kind: 'finished' };
    const deadline = Date.now() + this.timing.loadTimeoutMs;
    if (this.isShowingPage(url)) {
      // Same page already on screen: leave it alone so scroll position and any draft survive.
    } else {
      if (this.obs.loading && this.obs.url && sameChatGptPage(this.obs.url, url)) outcome = await this.waitForLoadEnd(this.timing.loadTimeoutMs);
      else outcome = await this.loadAndWait(view, url);
      if (outcome.kind === 'finished') await this.settle(deadline);
    }

    this.syncFromContents();
    this.refresh();
    return this.describe(url, outcome, opts);
  }

  private async describe(requested: string, outcome: LoadOutcome, opts: { focus: boolean }): Promise<ChatGptOpenResult> {
    if (outcome.kind === 'failed') {
      return this.result({ ok: false, opened: false, verified: null, finalUrl: this.obs.url, note: this.state.note ?? `The page could not be loaded (${outcome.description}).` });
    }
    if (outcome.kind === 'cancelled') {
      const where = outcome.decision === 'external' ? 'another site, which was opened in your browser instead' : 'an address that is not allowed here';
      return this.result({ ok: false, opened: false, verified: null, note: `ChatGPT tried to go to ${where}, so the conversation was not opened.` });
    }
    if (outcome.kind === 'timeout') {
      return this.result({ ok: true, opened: true, verified: null, note: 'ChatGPT is still loading after 20 seconds. The pane will show the page when it arrives; the address has not been checked.' });
    }

    const status = this.state.status;
    const finalUrl = this.obs.url;
    const samePage = finalUrl !== null && sameChatGptPage(finalUrl, requested);
    const verified = samePage && status === 'ready';

    const notes: string[] = [];
    if (verified) notes.push('The address matches the requested conversation. Mini-Summa cannot read the page, so it cannot confirm the content.');
    else if (status === 'login_required' || status === 'challenge' || status === 'blocked') notes.push(this.state.note ?? 'The requested page is not showing.');
    else if (!samePage) notes.push('ChatGPT showed a different page than the one requested.');
    else notes.push(this.state.note ?? 'The requested page could not be confirmed.');

    let focused = false;
    if (opts.focus && this.applied.visible) {
      this.deps.revealWindow();
      focused = await this.focusAndCheck();
      if (!focused) notes.push('The pane did not report keyboard focus. Click in it before pasting.');
    } else if (opts.focus && !this.applied.visible) {
      notes.push('The pane is covered by a dialog or hidden, so it was not focused.');
    }
    return this.result({ ok: true, opened: true, focused, verified, note: notes.join(' ') });
  }

  private async focusAndCheck(): Promise<boolean> {
    const c = this.view?.contents;
    if (!c || c.isDestroyed()) return false;
    c.focus();
    const until = Date.now() + this.timing.focusWaitMs;
    while (!c.isFocused() && Date.now() < until) await sleep(10);
    return c.isFocused();
  }

  private ensureView(): ViewHandle {
    if (this.view) return this.view;
    const handle = this.deps.createView();
    this.view = handle;
    this.wire(handle.contents);
    this.reapply();
    return handle;
  }

  private waitForBounds(): Promise<boolean> {
    if (this.rect !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = (): void => { clearTimeout(timer); this.boundsWaiters.delete(wake); resolve(true); };
      const timer = setTimeout(() => { this.boundsWaiters.delete(wake); resolve(false); }, this.timing.boundsWaitMs);
      this.boundsWaiters.add(wake);
    });
  }

  /**
   * The tail of an earlier load (a failed page "finishes loading" shortly after the failure, then stops) must not be
   * mistaken for the outcome of the next one, so a new load starts only once the previous one has stopped.
   */
  private async quiesce(c: ViewContents): Promise<void> {
    if (!c.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); c.removeListener('did-stop-loading', done); resolve(); };
      const timer = setTimeout(done, 3000);
      c.on('did-stop-loading', done);
    });
  }

  private async loadAndWait(view: ViewHandle, url: string): Promise<LoadOutcome> {
    const c = view.contents;
    await this.quiesce(c);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let done = false;
      const end = (outcome: LoadOutcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        c.removeListener('did-finish-load', onFinish);
        c.removeListener('did-fail-load', onFail);
        c.removeListener('did-stop-loading', onStop);
        resolve(outcome);
      };
      const onFinish = (): void => end({ kind: 'finished' });
      // A navigation that our own policy cancelled (a redirect to another site) ends with did-stop-loading and no
      // failure event at all. A stop with nothing cancelled means the load ended without a page (a download, say).
      const onStop = (): void => {
        const cancel = this.lastCancel;
        end(cancel && cancel.at >= startedAt ? { kind: 'cancelled', url: cancel.url, decision: cancel.decision } : { kind: 'finished' });
      };
      const onFail = (_e: unknown, code: number, description: string, _url: string, isMainFrame: boolean): void => {
        if (!isMainFrame) return;
        const kind = classifyFailure(code, description);
        if (kind === 'aborted') {
          // Aborted is ambiguous: either another navigation replaced this one (keep waiting for that one), or our own
          // policy cancelled a redirect during this load.
          const cancel = this.lastCancel;
          if (cancel && cancel.at >= startedAt) end({ kind: 'cancelled', url: cancel.url, decision: cancel.decision });
          return;
        }
        end({ kind: 'failed', code, description });
      };
      const timer = setTimeout(() => end({ kind: 'timeout' }), this.timing.loadTimeoutMs);
      c.on('did-finish-load', onFinish);
      c.on('did-fail-load', onFail);
      c.on('did-stop-loading', onStop);
      this.obs.loading = true;
      this.refresh();
      c.loadURL(url).catch(() => { /* reported through did-fail-load */ });
    });
  }

  private waitForLoadEnd(ms: number): Promise<LoadOutcome> {
    const c = this.view?.contents;
    if (!c) return Promise.resolve({ kind: 'finished' });
    return new Promise((resolve) => {
      const end = (outcome: LoadOutcome): void => { clearTimeout(timer); c.removeListener('did-stop-loading', onStop); resolve(outcome); };
      const onStop = (): void => end(this.obs.failure ? { kind: 'failed', code: this.obs.failure.code, description: this.obs.failure.description } : { kind: 'finished' });
      const timer = setTimeout(() => end({ kind: 'timeout' }), ms);
      c.on('did-stop-loading', onStop);
    });
  }

  /** Client-side redirects (to a sign-in page, say) often start just after the first load finished. */
  private async settle(deadline: number): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await sleep(this.timing.settleMs);
      if (!this.obs.loading) return;
      await this.waitForLoadEnd(Math.max(0, deadline - Date.now()));
    }
  }

  private syncFromContents(): void {
    const c = this.view?.contents;
    if (!c || c.isDestroyed()) return;
    const url = c.getURL();
    if (url) this.obs.url = url;
    this.obs.title = c.getTitle() || this.obs.title;
  }

  private refresh(): void {
    const c = this.view?.contents;
    const alive = !!c && !c.isDestroyed();
    const next = deriveViewState(this.obs, { canGoBack: alive && c.canGoBack(), canGoForward: alive && c.canGoForward() });
    const prev = this.state;
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    this.state = next;
    for (const l of [...this.listeners]) {
      try { l(next); } catch (err) { this.deps.log.warn('chatgpt state listener failed', { error: err }); }
    }
  }

  private guard = (event: { preventDefault(): void }, url: string): void => {
    const cls = classifyNavigation(url);
    if (cls === 'chatgpt' || cls === 'auth') return;
    event.preventDefault();
    this.lastCancel = { url, decision: cls === 'external' ? 'external' : 'blocked', at: Date.now() };
    if (cls === 'external') this.openOutside(url);
    else this.deps.log.info('chatgpt navigation blocked', { scheme: url.split(':')[0] });
  };

  private openOutside(url: string): void {
    if (isExternalUrl(url)) this.deps.openExternal(url);
    else this.deps.log.info('chatgpt link not opened externally (not a plain https link)');
  }

  private wire(c: ViewContents): void {
    c.on('will-navigate', (event: { preventDefault(): void }, url: string) => this.guard(event, url));
    c.on('will-redirect', (event: { preventDefault(): void }, url: string) => this.guard(event, url));
    c.setWindowOpenHandler((details) => {
      const cls = classifyNavigation(details.url);
      // about:blank popups (used to write a page into the new window) are denied outright; loading them here would wipe the page.
      if (details.url.trim().toLowerCase() === 'about:blank') return { action: 'deny' };
      if (cls === 'chatgpt' || cls === 'auth') setImmediate(() => { if (!c.isDestroyed()) c.loadURL(details.url).catch(() => undefined); });
      else if (cls === 'external') this.openOutside(details.url);
      return { action: 'deny' };
    });
    c.on('did-start-loading', () => { this.obs.loading = true; this.refresh(); });
    c.on('did-stop-loading', () => { this.obs.loading = false; this.syncFromContents(); this.refresh(); });
    c.on('did-finish-load', () => { this.obs.loading = false; this.syncFromContents(); this.refresh(); });
    c.on('did-navigate', (_e: unknown, url: string) => { this.obs.url = url; this.obs.failure = null; this.refresh(); });
    c.on('did-navigate-in-page', (_e: unknown, url: string, isMainFrame: boolean) => { if (isMainFrame) { this.obs.url = url; this.refresh(); } });
    c.on('page-title-updated', (_e: unknown, title: string) => { this.obs.title = title; this.refresh(); });
    c.on('did-fail-load', (_e: unknown, code: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      this.obs.loading = false;
      if (classifyFailure(code, description) !== 'aborted') {
        this.obs.failure = { code, description };
        if (validatedUrl) this.obs.url = validatedUrl;
      }
      this.refresh();
    });
    c.on('render-process-gone', (_e: unknown, details: { reason?: string }) => {
      this.obs.loading = false;
      this.obs.failure = { code: -1, description: `the page process ended (${details?.reason ?? 'unknown'})` };
      this.refresh();
    });
  }
}
