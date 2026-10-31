// The embedded Claude Code on the web view (https://claude.ai/code): behaviour only, no Electron imports (claudeElectronView.ts adapts a
// real WebContentsView). It follows the ChatGPT view (chatgptView.ts) where the two are the same and is smaller, because nothing in the
// core drives it: only the renderer does, through ipc.ts.
//
// This is a browser based integration, NOT session control. Mini-Summa shows a web page. Rules this file keeps:
//  * It never reads or touches the page: no scripts, no DOM access, no clicks, no typing, no injected CSS, no user-agent change, and it
//    never looks at cookies or tokens. It looks only at the address, the title, whether a load is running and why a load failed. A view
//    of a page is not control of the session behind it: nothing here can tell whether a cloud session is working, finished or waiting.
//  * The view is created the first time something asks it to load a page and is never destroyed because of layout changes, so the page,
//    its scroll position, a half written prompt and the sign-in survive the renderer showing, hiding or moving the pane. Hiding is
//    setVisible(false), moving is setBounds, a dialog over the pane is setOverlayActive: none of them can destroy it, because
//    ClaudeViewHandle has no way to. Do not add one.
//  * Navigation of the top frame is restricted with the shared classifyClaudeNavigation policy: claude and auth addresses load in the
//    view (sign-in and the GitHub authorisation pages must be able to finish), other websites open in the person's browser through the
//    same https-only check as the ChatGPT view, anything else is refused. A new window is never opened.
//  * A refusal by a sign-in provider (Google refusing an embedded window) is REPORTED in the state. Nothing here works around it.
//
// Local decisions on top of the contract (also in the report):
//  * setBounds on its own does not create the view. native.ts says the view is created the first time it is asked to load something, and
//    a blank native view laid over the renderer's pane would cover whatever the renderer shows there until the first page arrives (an
//    empty state, a message). The rectangle is remembered and used the moment the first navigate creates the view.
//  * Addresses are compared with their query: claude.ai/code?repositories=a/b and claude.ai/code are different pages (the first
//    preselects a repository), so only an identical address counts as "already showing it".
//  * Logs carry no addresses: a prefilled prompt travels in the query, and a prompt is the person's.
import { classifyClaudeNavigation } from '@minisumma/shared';
import type { ClaudeWebViewState, Rect } from '@minisumma/shared';
import { sameRect, toViewBounds } from './bounds.ts';
import type { Logger } from './log.ts';
import { isExternalUrl, validateClaudeWebUrl } from './validation.ts';
import { classifyFailure, deriveClaudeViewState, EMPTY_CLAUDE_VIEW_STATE } from './viewState.ts';
import type { ViewObservation } from './viewState.ts';

/**
 * The part of Electron's WebContents that this controller uses, so a fake can stand in for it in tests. Smaller than the ChatGPT view's:
 * no zoom (the page is shown at the browser's own size), no focus query, no stop.
 */
export interface ClaudeViewContents {
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  focus(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}

export interface ClaudeViewHandle {
  contents: ClaudeViewContents;
  setBounds(rect: Rect): void;
  setVisible(visible: boolean): void;
}

export interface ClaudeWebViewDeps {
  /** Creates the native view and attaches it to the window. Called at most once. */
  createView(): ClaudeViewHandle;
  /** Window content area in DIP and the renderer page's zoom factor; null when there is no window. */
  content(): { width: number; height: number; zoomFactor: number } | null;
  /** Hands a link to the system browser. Called only with a plain https link (isExternalUrl). */
  openExternal(url: string): void;
  log: Logger;
}

/** The scheme of an address, for a log line: never more than that, because the rest of an address can hold a prefilled prompt. */
const schemeOf = (url: string): string => /^([a-z][a-z0-9+.-]{0,30}):/i.exec(url.trim())?.[1].toLowerCase() ?? 'none';

/** Which page an address names: host without www, path without a trailing slash, and the query. The fragment is not part of it. */
function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch { return null; }
}

const samePage = (a: string, b: string): boolean => {
  const x = pageKey(a);
  return x !== null && x === pageKey(b);
};

export class ClaudeWebView {
  private view: ClaudeViewHandle | null = null;
  private rect: Rect | null = null;
  private overlay = false;
  private applied: { bounds: Rect | null; visible: boolean } = { bounds: null, visible: false };
  private obs: ViewObservation = { url: null, title: null, loading: false, failure: null };
  /** The address of a load that navigate() started and that has not ended yet, so asking for the same page twice does not restart it. */
  private pending: string | null = null;
  private state: ClaudeWebViewState = EMPTY_CLAUDE_VIEW_STATE;
  private readonly listeners = new Set<(s: ClaudeWebViewState) => void>();

  constructor(private readonly deps: ClaudeWebViewDeps) {}

  // ---- what the renderer controls ------------------------------------------------------------------------------

  /** Where the pane is (CSS pixels of the renderer), or null to hide the view. Hiding keeps the page. */
  setBounds(rect: Rect | null): void {
    this.rect = rect;
    this.reapply();
  }

  /**
   * A menu, dialog or toast of the renderer is open over the pane: a native view always draws above web content, so it is hidden while
   * one is open. When it closes the view is shown again only if it has a place on screen, so a view that was hidden stays hidden.
   */
  setOverlayActive(active: boolean): void {
    this.overlay = active;
    this.reapply();
  }

  /**
   * Re-derives the native bounds from the last rectangle; called on resize, maximize, fullscreen, zoom and display changes.
   * Hiding never destroys anything: a null rectangle, a covered pane and a window too small for the pane all end in setVisible(false).
   */
  reapply(): void {
    const view = this.view;
    if (!view || view.contents.isDestroyed()) return;
    const content = this.deps.content();
    const bounds = this.rect && content ? toViewBounds(this.rect, content.zoomFactor, content) : null;
    const visible = bounds !== null && !this.overlay;
    if (bounds && !sameRect(bounds, this.applied.bounds)) { view.setBounds(bounds); this.applied.bounds = bounds; }
    if (visible !== this.applied.visible) { view.setVisible(visible); this.applied.visible = visible; }
  }

  /** Whether the pane is placed and not covered by an overlay right now. */
  get showing(): boolean { return this.applied.visible; }

  getState(): ClaudeWebViewState { return this.state; }

  /** Called with the new state whenever it changed, never with an unchanged one. Returns the function that stops it. */
  onState(listener: (s: ClaudeWebViewState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Loads an address of Claude Code on the web (https, claude.ai, under /code; see validateClaudeWebUrl) and creates the view if this is
   * the first one. Throws for any other address, loading nothing. Resolves as soon as the load has started: how it went arrives as state.
   */
  async navigate(rawUrl: string): Promise<void> {
    const url = validateClaudeWebUrl(rawUrl);
    const view = this.ensureView();
    // A view that went with its window cannot load anything, and must not be left saying "loading".
    if (view.contents.isDestroyed()) throw new Error('The Claude Code view is gone: its window was closed.');
    if (this.isShowingPage(url) || (this.obs.loading && this.pending !== null && samePage(this.pending, url))) return;
    this.pending = url;
    this.obs.loading = true;
    this.refresh();
    view.contents.loadURL(url).catch(() => { /* failures arrive as did-fail-load */ });
  }

  reload(): void {
    const c = this.view?.contents;
    if (c && !c.isDestroyed() && c.getURL() !== '') c.reload();
  }

  back(): void { const c = this.view?.contents; if (c && !c.isDestroyed() && c.canGoBack()) c.goBack(); }

  forward(): void { const c = this.view?.contents; if (c && !c.isDestroyed() && c.canGoForward()) c.goForward(); }

  /** Gives the page the keyboard, but only while the pane is on screen: a hidden or covered view must not take typing meant for the app. */
  focus(): void { const c = this.view?.contents; if (c && !c.isDestroyed() && this.applied.visible) c.focus(); }

  // ---- internals -----------------------------------------------------------------------------------------------

  /** Only a page that loaded fine counts: a failed or sign-in page is loaded again when it is asked for. */
  private isShowingPage(url: string): boolean {
    return this.obs.url !== null && this.state.status === 'ready' && samePage(this.obs.url, url);
  }

  private ensureView(): ClaudeViewHandle {
    if (this.view) return this.view;
    const handle = this.deps.createView();
    this.view = handle;
    // One line per creation: a second one in the log would mean something destroyed the view, which nothing is meant to do.
    this.deps.log.info('claude web view created');
    this.wire(handle.contents);
    this.reapply();
    return handle;
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
    const next = deriveClaudeViewState(this.obs, { canGoBack: alive && c.canGoBack(), canGoForward: alive && c.canGoForward() });
    const prev = this.state;
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    this.state = next;
    if (prev.status !== next.status) {
      // The status and, for a failure, the reason Chromium gave; never an address.
      const failed = (next.status === 'error' || next.status === 'blocked') && this.obs.failure !== null;
      this.deps.log.info('claude web view status', { status: next.status, ...(failed ? { failure: this.obs.failure!.description } : {}) });
    }
    for (const l of [...this.listeners]) {
      try { l(next); } catch (err) { this.deps.log.warn('claude web state listener failed', { error: err }); }
    }
  }

  /** A load has ended one way or another. */
  private loadEnded(): void {
    this.pending = null;
    this.obs.loading = false;
  }

  private openOutside(url: string): void {
    if (isExternalUrl(url)) this.deps.openExternal(url);
    else this.deps.log.info('claude web link not opened externally (not a plain https link)');
  }

  private guard = (event: { preventDefault(): void }, url: string): void => {
    const cls = classifyClaudeNavigation(url);
    if (cls === 'claude' || cls === 'auth') return;
    event.preventDefault();
    if (cls === 'external') this.openOutside(url);
    else this.deps.log.info('claude web navigation blocked', { scheme: schemeOf(url) });
  };

  private wire(c: ClaudeViewContents): void {
    c.on('will-navigate', (event: { preventDefault(): void }, url: string) => this.guard(event, url));
    c.on('will-redirect', (event: { preventDefault(): void }, url: string) => this.guard(event, url));
    c.setWindowOpenHandler((details) => {
      const cls = classifyClaudeNavigation(details.url);
      // about:blank popups (used to write a page into the new window) are denied outright; loading them here would wipe the page.
      if (details.url.trim().toLowerCase() === 'about:blank') return { action: 'deny' };
      // A page that asks for a new window (target=_blank, window.open) is shown in this view instead, or in the browser, never in a window of ours.
      if (cls === 'claude' || cls === 'auth') setImmediate(() => { if (!c.isDestroyed()) c.loadURL(details.url).catch(() => undefined); });
      else if (cls === 'external') this.openOutside(details.url);
      else this.deps.log.info('claude web new window refused', { scheme: schemeOf(details.url) });
      return { action: 'deny' };
    });
    c.on('did-start-loading', () => { this.obs.loading = true; this.refresh(); });
    c.on('did-stop-loading', () => { this.loadEnded(); this.syncFromContents(); this.refresh(); });
    c.on('did-finish-load', () => { this.loadEnded(); this.syncFromContents(); this.refresh(); });
    c.on('did-navigate', (_e: unknown, url: string) => { this.obs.url = url; this.obs.failure = null; this.refresh(); });
    c.on('did-navigate-in-page', (_e: unknown, url: string, isMainFrame: boolean) => { if (isMainFrame) { this.obs.url = url; this.refresh(); } });
    c.on('page-title-updated', (_e: unknown, title: string) => { this.obs.title = title; this.refresh(); });
    c.on('did-fail-load', (_e: unknown, code: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      if (classifyFailure(code, description) === 'aborted') {
        // Replaced by another load, or cancelled by our own policy: the page did not fail. Whether a load is still running is for the
        // web contents to say (a load that replaced this one is).
        this.obs.loading = !c.isDestroyed() && c.isLoading();
        if (!this.obs.loading) this.pending = null;
      } else {
        this.loadEnded();
        this.obs.failure = { code, description };
        if (validatedUrl) this.obs.url = validatedUrl;
      }
      this.refresh();
    });
    c.on('render-process-gone', (_e: unknown, details: { reason?: string }) => {
      this.loadEnded();
      this.obs.failure = { code: -1, description: `the page process ended (${details?.reason ?? 'unknown'})` };
      this.refresh();
    });
  }
}
