// An in-memory stand-in for the parts of `chrome.tabs` and `chrome.windows` that bridge.ts is allowed to call.
// It models what the real browser does that matters here: URL-filtered queries, one active tab per window, one
// focused window, a tab that is created with status "loading" and no URL, and pages that redirect or never load.
import type { BridgeChrome } from '../src/bridge.ts';
import type { FakeClock } from './fake-clock.ts';

export interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  url: string;
  pendingUrl?: string;
  title: string;
  status: 'loading' | 'complete';
  lastAccessed: number;
}

export interface FakeWindow { id: number; focused: boolean }

/** How the browser behaves when a tab navigates to a requested address. */
export interface PageBehavior {
  /** Address the tab ends up at. Defaults to the requested one (a redirect to sign-in sets another). */
  finalUrl?: string;
  title?: string;
  /** Milliseconds until status becomes complete. Default 300. */
  loadMs?: number;
  /** The load never completes. */
  hang?: boolean;
  /** After completing, the page navigates elsewhere this many ms later (client-side redirect). */
  redirectAfterMs?: number;
  redirectTo?: string;
  /** The user closes the tab while it is loading. */
  closeAfterMs?: number;
}

/** Match patterns the way the browser does for tabs.query: scheme and host, any port, `*` path wildcard. */
export function matchesPattern(pattern: string, url: string): boolean {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) throw new Error(`Invalid match pattern: ${pattern}`);
  // Credentials and port are not part of the match; the path part is matched against path plus query, never the fragment.
  const u = /^(https?):\/\/(?:[^/?#@]*@)?([^/?#:]+)(?::\d+)?([^#]*)/.exec(url);
  if (!u) return false;
  const [, pScheme, pHost, pPath] = m;
  if (pScheme !== '*' && pScheme !== u[1]) return false;
  if (pHost !== '*' && pHost !== u[2]) return false;
  const rest = u[3] === '' ? '/' : u[3].startsWith('?') ? `/${u[3]}` : u[3];
  const re = new RegExp(`^${pPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(rest);
}

/** Hosts the extension has host access to (the manifest's host_permissions). The extension has no "tabs" permission. */
export const DEFAULT_VISIBLE_HOSTS = ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com', '127.0.0.1', 'localhost'];

export class FakeBrowser {
  readonly tabs: FakeTab[] = [];
  readonly windows: FakeWindow[] = [];
  readonly calls: { api: string; args: unknown[] }[] = [];
  readonly pages = new Map<string, PageBehavior>();
  /** Make individual API calls fail the way the browser would. */
  failures: { update?: string; windowUpdate?: string; create?: string; get?: string } = {};
  /** Make windows.update succeed but report the window as not focused (the OS refused the focus). */
  windowRefusesFocus = false;
  /**
   * Like the real browser without the "tabs" permission: the address and title of a tab are only shown for these hosts.
   * Every other tab is listed without `url`, `pendingUrl` and `title`, and a url filter never matches it.
   */
  visibleHosts: string[] = [...DEFAULT_VISIBLE_HOSTS];
  private nextTabId = 100;
  private nextWindowId = 1;

  constructor(private readonly clock: FakeClock) {}

  addWindow(focused = false): number {
    const id = this.nextWindowId++;
    if (focused) for (const w of this.windows) w.focused = false;
    this.windows.push({ id, focused });
    return id;
  }

  addTab(init: { windowId: number; url: string; title?: string; active?: boolean; lastAccessed?: number }): number {
    const id = this.nextTabId++;
    const inWindow = this.tabs.filter((t) => t.windowId === init.windowId);
    if (init.active) for (const t of inWindow) t.active = false;
    this.tabs.push({
      id, windowId: init.windowId, index: inWindow.length, active: init.active ?? false, url: init.url,
      title: init.title ?? init.url, status: 'complete', lastAccessed: init.lastAccessed ?? 0,
    });
    return id;
  }

  tab(id: number): FakeTab { const t = this.tabs.find((x) => x.id === id); if (!t) throw new Error(`no fake tab ${id}`); return t; }
  activeTabOf(windowId: number): FakeTab | undefined { return this.tabs.find((t) => t.windowId === windowId && t.active); }
  focusedWindow(): FakeWindow | undefined { return this.windows.find((w) => w.focused); }
  callsTo(api: string): unknown[][] { return this.calls.filter((c) => c.api === api).map((c) => c.args); }

  private log(api: string, ...args: unknown[]): void { this.calls.push({ api, args }); }

  private hostOf(url: string): string | null {
    const m = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)/.exec(url);
    return m ? m[1] : null;
  }

  private canSee(url: string): boolean {
    const host = this.hostOf(url);
    return host !== null && this.visibleHosts.includes(host);
  }

  private snapshot(t: FakeTab): chrome.tabs.Tab {
    // Mirrors the real API: an unfinished navigation has no url yet, only pendingUrl. A tab on a site the extension has
    // no host access to has neither, nor a title.
    const out: Record<string, unknown> = { id: t.id, windowId: t.windowId, index: t.index, active: t.active, status: t.status, lastAccessed: t.lastAccessed, highlighted: t.active, pinned: false, incognito: false, discarded: false, autoDiscardable: true, groupId: -1 };
    if (t.url === '') {
      out.url = '';
      out.title = '';
      if (t.pendingUrl && this.canSee(t.pendingUrl)) out.pendingUrl = t.pendingUrl;
    } else if (this.canSee(t.url)) {
      out.url = t.url;
      out.title = t.title;
    }
    return out as unknown as chrome.tabs.Tab;
  }

  private navigate(t: FakeTab, requested: string): void {
    const page = this.pages.get(requested) ?? {};
    t.status = 'loading'; t.url = ''; t.title = ''; t.pendingUrl = requested;
    if (page.closeAfterMs !== undefined) {
      this.clock.setTimeout(() => { const i = this.tabs.indexOf(t); if (i >= 0) this.tabs.splice(i, 1); }, page.closeAfterMs);
    }
    if (page.hang) return;
    this.clock.setTimeout(() => {
      if (!this.tabs.includes(t)) return;
      t.url = page.finalUrl ?? requested; t.title = page.title ?? t.url; t.status = 'complete'; delete t.pendingUrl;
      if (page.redirectAfterMs !== undefined && page.redirectTo) {
        this.clock.setTimeout(() => { if (this.tabs.includes(t)) { t.url = page.redirectTo!; t.title = page.redirectTo!; } }, page.redirectAfterMs);
      }
    }, page.loadMs ?? 300);
  }

  readonly chrome: BridgeChrome = {
    tabs: {
      query: async (queryInfo) => {
        this.log('tabs.query', queryInfo);
        if (!Array.isArray(queryInfo.url)) throw new Error('tabs.query must always be called with a url filter');
        return this.tabs.filter((t) => t.url !== '' && this.canSee(t.url) && queryInfo.url.some((p) => matchesPattern(p, t.url))).map((t) => this.snapshot(t));
      },
      get: async (tabId) => {
        this.log('tabs.get', tabId);
        if (this.failures.get) throw new Error(this.failures.get);
        const t = this.tabs.find((x) => x.id === tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}.`);
        return this.snapshot(t);
      },
      update: async (tabId, props) => {
        this.log('tabs.update', tabId, props);
        if (this.failures.update) throw new Error(this.failures.update);
        const t = this.tabs.find((x) => x.id === tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}.`);
        for (const other of this.tabs) if (other.windowId === t.windowId) other.active = false;
        t.active = true; t.lastAccessed = this.clock.now();
        return this.snapshot(t);
      },
      create: async (props) => {
        this.log('tabs.create', props);
        if (this.failures.create) throw new Error(this.failures.create);
        const windowId = this.focusedWindow()?.id ?? this.windows[0]?.id ?? this.addWindow(true);
        const id = this.addTab({ windowId, url: '', active: true, lastAccessed: this.clock.now() });
        const t = this.tab(id);
        this.navigate(t, props.url);
        return this.snapshot(t);
      },
    },
    windows: {
      update: async (windowId, info) => {
        this.log('windows.update', windowId, info);
        if (this.failures.windowUpdate) throw new Error(this.failures.windowUpdate);
        const w = this.windows.find((x) => x.id === windowId);
        if (!w) throw new Error(`No window with id: ${windowId}.`);
        if (!this.windowRefusesFocus) { for (const o of this.windows) o.focused = false; w.focused = true; }
        return { id: w.id, focused: w.focused, alwaysOnTop: false, incognito: false } as chrome.windows.Window;
      },
    },
  };
}
