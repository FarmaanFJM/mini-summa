// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeWebView } from '../../src/main/claudeView.ts';
import type { ClaudeViewContents, ClaudeViewHandle } from '../../src/main/claudeView.ts';

const HOME = 'https://claude.ai/code';
const NEW_SESSION = 'https://claude.ai/code?repositories=acme/webapp';
// The address of one page of Claude Code on the web, built from its last segment. Made-up ids only: nothing in this repository may look like a real session address.
const page = (segment: string, tail = ''): string => `https://claude.ai/code/${segment}${tail}`;
const SESSION = page('session_abc123');
const LOGIN = 'https://claude.ai/login?returnTo=%2Fcode';
const GOOGLE_REFUSAL = 'https://accounts.google.com/v3/signin/rejected?continue=x';

type Plan =
  | { type: 'ok'; finalUrl?: string; title?: string; delayMs?: number }
  | { type: 'fail'; code: number; description: string }
  /** A server redirect. When the policy cancels it, real Electron only emits did-stop-loading; `abortEvent` adds ERR_ABORTED too. */
  | { type: 'redirect'; to: string; abortEvent?: boolean }
  | { type: 'hang' };

interface PolicyEvent { prevented: boolean; preventDefault(): void }
const policyEvent = (): PolicyEvent => { const e: PolicyEvent = { prevented: false, preventDefault() { e.prevented = true; } }; return e; };

/** A stand-in for Electron's WebContents that behaves like one for the events the controller listens to. */
class FakeContents extends EventEmitter implements ClaudeViewContents {
  url = '';
  title = '';
  loading = false;
  destroyed = false;
  loads: string[] = [];
  focusCalls = 0;
  reloads = 0;
  backs = 0;
  forwards = 0;
  history = 0;
  forwardHistory = 0;
  windowOpen: ((d: { url: string }) => { action: 'deny' }) | null = null;
  private generation = 0;
  private loadingUrl = '';
  constructor(public plan: (url: string) => Plan) { super(); }

  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  reload() { this.reloads += 1; }
  canGoBack() { return this.history > 0; }
  canGoForward() { return this.forwardHistory > 0; }
  goBack() { this.backs += 1; }
  goForward() { this.forwards += 1; }
  focus() { this.focusCalls += 1; }
  setWindowOpenHandler(h: (d: { url: string }) => { action: 'deny' }) { this.windowOpen = h; }

  loadURL(url: string): Promise<void> {
    this.loads.push(url);
    const plan = this.plan(url);
    const generation = (this.generation += 1);
    if (this.loading) {
      // A load that replaces one still running: Chromium reports the old one as aborted and carries straight on, without a stop and a start.
      this.emit('did-fail-load', {}, -3, 'ERR_ABORTED', this.loadingUrl, true);
    } else {
      this.loading = true;
      this.emit('did-start-loading');
    }
    this.loadingUrl = url;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (generation !== this.generation) { reject(new Error('ERR_ABORTED')); return; }
        if (plan.type === 'hang') return;
        if (plan.type === 'fail') {
          // Observed in Electron 45: the failure comes first; the error page then "finishes loading" and loading stops a little later.
          this.url = url;
          this.title = url.replace('https://', '');
          this.emit('did-fail-load', {}, plan.code, plan.description, url, true);
          reject(new Error(plan.description));
          setTimeout(() => {
            this.emit('did-finish-load');
            this.loading = false;
            this.emit('did-stop-loading');
          }, 5);
          return;
        }
        if (plan.type === 'redirect') {
          const event = policyEvent();
          this.emit('will-redirect', event, plan.to);
          if (event.prevented) {
            this.loading = false;
            if (plan.abortEvent) this.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true);
            this.emit('did-stop-loading');
            reject(new Error('ERR_ABORTED'));
            return;
          }
          this.finish(plan.to, 'Redirected');
          resolve();
          return;
        }
        this.finish(plan.finalUrl ?? url, plan.title ?? 'Claude Code');
        resolve();
      }, plan.type === 'ok' ? (plan.delayMs ?? 1) : 1);
    });
  }

  finish(url: string, title: string) {
    this.url = url;
    this.title = title;
    this.emit('did-navigate', {}, url);
    this.emit('page-title-updated', {}, title);
    this.loading = false;
    this.emit('did-finish-load');
    this.emit('did-stop-loading');
  }
}

const RECT = { x: 300, y: 50, width: 700, height: 800 };

function setup(opts: { plan?: (url: string) => Plan; window?: { width: number; height: number; zoomFactor: number } | null; bounds?: boolean } = {}) {
  const contents = new FakeContents(opts.plan ?? (() => ({ type: 'ok' })));
  const handle = { contents, setBounds: vi.fn(), setVisible: vi.fn() } satisfies ClaudeViewHandle;
  const win = { current: opts.window === undefined ? { width: 1600, height: 900, zoomFactor: 1 } : opts.window };
  const deps = {
    createView: vi.fn(() => handle),
    content: () => win.current,
    openExternal: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const view = new ClaudeWebView(deps);
  if (opts.bounds !== false) view.setBounds(RECT);
  return { view, contents, handle, deps, win };
}

type Setup = ReturnType<typeof setup>;

/** Asks for a page and waits until the view says what became of it. */
async function show(s: Setup, url: string, until: 'ready' | 'login_required' | 'blocked' | 'error' | 'idle' = 'ready'): Promise<void> {
  await s.view.navigate(url);
  await vi.waitFor(() => expect(s.view.getState().status).toBe(until));
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const everythingLogged = (s: Setup): string => JSON.stringify(['debug', 'info', 'warn', 'error'].map((level) => s.deps.log[level as 'info'].mock.calls));

describe('the lifecycle of the view', () => {
  it('creates nothing until a page is asked for, then creates the view once', async () => {
    const { view, deps } = setup({ bounds: false });
    view.setBounds(RECT);
    view.setBounds(null);
    view.setBounds(RECT);
    view.setOverlayActive(true);
    view.setOverlayActive(false);
    view.reapply();
    view.reload(); view.back(); view.forward(); view.focus();
    view.getState();
    view.onState(() => undefined)();
    expect(deps.createView).not.toHaveBeenCalled();
    expect(view.showing).toBe(false);
    await view.navigate(HOME);
    await view.navigate(NEW_SESSION);
    await view.navigate(SESSION);
    expect(deps.createView).toHaveBeenCalledTimes(1);
    expect(deps.log.info.mock.calls.filter((c) => c[0] === 'claude web view created')).toHaveLength(1);
  });

  it('a rectangle given before the first page is used when the view is created, and shown', async () => {
    const { view, handle, win } = setup();
    expect(handle.setBounds).not.toHaveBeenCalled();
    win.current = { width: 1600, height: 900, zoomFactor: 1.25 };
    await view.navigate(HOME);
    expect(handle.setBounds).toHaveBeenLastCalledWith({ x: 375, y: 63, width: 875, height: 900 - 63 });
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.showing).toBe(true);
  });

  it('a page asked for before the pane is placed loads hidden, and appears when the pane is placed', async () => {
    const { view, handle, contents } = setup({ bounds: false });
    await view.navigate(HOME);
    await vi.waitFor(() => expect(view.getState().status).toBe('ready'));
    expect(contents.loads).toEqual([HOME]);
    expect(handle.setVisible).not.toHaveBeenCalledWith(true);
    expect(view.showing).toBe(false);
    view.setBounds(RECT);
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.showing).toBe(true);
  });

  it('hides on a null rectangle without destroying or navigating, and shows the same page again', async () => {
    const s = setup();
    await show(s, SESSION);
    const { view, handle, contents } = s;
    view.setBounds(null);
    expect(handle.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.showing).toBe(false);
    expect(view.getState()).toMatchObject({ status: 'ready', url: SESSION });
    view.setBounds(RECT);
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.getState()).toMatchObject({ status: 'ready', url: SESSION });
    expect(contents.loads).toEqual([SESSION]);
    expect(contents.reloads).toBe(0);
    expect(contents.destroyed).toBe(false);
  });

  it('does not repeat native calls for an unchanged placement', async () => {
    const s = setup();
    await show(s, HOME);
    s.handle.setBounds.mockClear();
    s.handle.setVisible.mockClear();
    s.view.setBounds(RECT);
    s.view.setBounds({ ...RECT });
    s.view.reapply();
    expect(s.handle.setBounds).not.toHaveBeenCalled();
    expect(s.handle.setVisible).not.toHaveBeenCalled();
  });

  it('re-derives the bounds when the window changes, and hides when it shrinks past the pane', async () => {
    const s = setup();
    await show(s, HOME);
    expect(s.handle.setBounds).toHaveBeenLastCalledWith(RECT);
    s.win.current = { width: 1000, height: 600, zoomFactor: 1 };
    s.view.reapply();
    expect(s.handle.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 50, width: 700, height: 550 });
    s.win.current = { width: 250, height: 600, zoomFactor: 1 };
    s.view.reapply();
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(false);
    s.win.current = { width: 1600, height: 900, zoomFactor: 1 };
    s.view.reapply();
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('survives the window going away: it hides and does not throw', async () => {
    const s = setup();
    await show(s, HOME);
    s.win.current = null;
    expect(() => s.view.reapply()).not.toThrow();
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(false);
    s.contents.destroyed = true;
    s.handle.setVisible.mockClear();
    expect(() => { s.view.reapply(); s.view.setBounds(RECT); s.view.setOverlayActive(true); s.view.reload(); s.view.back(); s.view.forward(); s.view.focus(); }).not.toThrow();
    expect(s.handle.setVisible).not.toHaveBeenCalled();
  });

  it('without a window the first page cannot be shown, and says so by throwing instead of loading', async () => {
    const created = vi.fn(() => { throw new Error('There is no window to attach the Claude Code view to.'); });
    const view = new ClaudeWebView({ createView: created, content: () => null, openExternal: vi.fn(), log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    await expect(view.navigate(HOME)).rejects.toThrow(/no window/);
    expect(view.getState().status).toBe('idle');
  });

  it('createView is called once across hide, show, resize, overlays, navigations, sign-in pages and a closed window', async () => {
    const s = setup();
    await show(s, HOME);
    const loads = [...s.contents.loads];
    s.view.setBounds(null);
    s.view.setBounds(RECT);
    s.win.current = { width: 1000, height: 600, zoomFactor: 1 };
    s.view.reapply();
    s.win.current = { width: 1920, height: 1080, zoomFactor: 1 };
    s.view.reapply();
    s.view.setBounds(null);
    s.view.setBounds({ x: 0, y: 50, width: 1700, height: 900 });
    s.view.setBounds(RECT);
    s.view.setOverlayActive(true);
    s.view.setOverlayActive(true);
    s.view.setOverlayActive(false);
    s.contents.finish(LOGIN, 'Sign in');
    s.contents.finish(SESSION, 'Session');
    s.win.current = null;
    s.view.reapply();
    s.win.current = { width: 1600, height: 900, zoomFactor: 1 };
    s.view.reapply();
    expect(s.deps.createView).toHaveBeenCalledTimes(1);
    expect(s.contents.destroyed).toBe(false);
    expect(s.contents.reloads).toBe(0);
    expect(s.contents.loads).toEqual(loads);
    expect(s.deps.log.info.mock.calls.filter((c) => c[0] === 'claude web view created')).toHaveLength(1);
  });
});

describe('the overlay switch', () => {
  it('hides the view while a menu or dialog is open and shows it again after, without touching the page', async () => {
    const s = setup();
    await show(s, HOME);
    s.view.setOverlayActive(true);
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(false);
    expect(s.view.showing).toBe(false);
    s.view.setOverlayActive(false);
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(true);
    expect(s.view.showing).toBe(true);
    expect(s.contents.loads).toEqual([HOME]);
  });

  it('several overlays at once end with one release, and a repeated switch changes nothing', async () => {
    const s = setup();
    await show(s, HOME);
    s.handle.setVisible.mockClear();
    s.view.setOverlayActive(true);
    s.view.setOverlayActive(true);
    expect(s.handle.setVisible).toHaveBeenCalledTimes(1);
    s.view.setOverlayActive(false);
    s.view.setOverlayActive(false);
    expect(s.handle.setVisible).toHaveBeenCalledTimes(2);
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('never shows a view that was hidden before: releasing the overlay leaves a null rectangle hidden', async () => {
    const s = setup();
    await show(s, HOME);
    s.view.setBounds(null);
    s.handle.setVisible.mockClear();
    s.view.setOverlayActive(true);
    s.view.setOverlayActive(false);
    expect(s.handle.setVisible).not.toHaveBeenCalledWith(true);
    expect(s.view.showing).toBe(false);
  });

  it('the rectangle that arrives while an overlay is open takes effect only when the overlay is released', async () => {
    const s = setup({ bounds: false });
    await show(s, HOME);
    s.view.setOverlayActive(true);
    s.view.setBounds(RECT);
    expect(s.handle.setVisible).not.toHaveBeenCalledWith(true);
    s.view.setOverlayActive(false);
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('an overlay that was already open when the view was created keeps the new view hidden until it is released', async () => {
    const s = setup();
    s.view.setOverlayActive(true);
    await show(s, HOME);
    expect(s.handle.setVisible).not.toHaveBeenCalledWith(true);
    s.view.setOverlayActive(false);
    expect(s.handle.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('keyboard focus goes to the page only while the pane is on screen', async () => {
    const s = setup();
    await show(s, HOME);
    s.view.focus();
    expect(s.contents.focusCalls).toBe(1);
    s.view.setOverlayActive(true);
    s.view.focus();
    s.view.setOverlayActive(false);
    s.view.setBounds(null);
    s.view.focus();
    expect(s.contents.focusCalls).toBe(1);
  });
});

describe('asking for a page', () => {
  it('loads the address with its query: the new session page with the repository preselected', async () => {
    const s = setup();
    await show(s, NEW_SESSION);
    expect(s.contents.loads).toEqual([NEW_SESSION]);
    expect(s.view.getState()).toEqual({ status: 'ready', url: NEW_SESSION, title: 'Claude Code', canGoBack: false, canGoForward: false, note: null });
  });

  it('normalises the address (www, trailing slash, fragment) and keeps the query', async () => {
    const s = setup();
    await show(s, 'https://www.claude.ai/code/?repositories=acme/webapp#frag');
    expect(s.contents.loads).toEqual([NEW_SESSION]);
  });

  it.each([
    ['another website', 'https://example.org/code'],
    ['a lookalike host', 'https://claude.ai.example.org/code'],
    ['plain http', 'http://claude.ai/code'],
    ['no scheme', 'claude.ai/code'],
    ['javascript', 'javascript:alert(1)'],
    ['a file', 'file:///etc/passwd'],
    ['a data page', 'data:text/html,<script>1</script>'],
    ['our own protocol', 'minisumma://settings'],
    ['another part of claude.ai', 'https://claude.ai/chat/abc'],
    ['the sign-in page', 'https://claude.ai/login'],
    ['credentials in the address', 'https://user:pw@claude.ai/code'],
    ['a port', 'https://claude.ai:8443/code'],
    ['a backslash', 'https://claude.ai\\@example.org/code'],
    ['a space', 'https://claude.ai/code?x=a b'],
    ['a line break', 'https://claude.ai/code\nhttps://example.org/'],
    ['nothing', ''],
    ['too long an address', `https://claude.ai/code?prompt=${'a'.repeat(3000)}`],
    ['a number', 5 as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('refuses %s with an error, loads nothing and creates no view', async (_name, url) => {
    const { view, deps, contents } = setup();
    await expect(view.navigate(url)).rejects.toThrow(/Invalid Claude Code address/);
    expect(deps.createView).not.toHaveBeenCalled();
    expect(contents.loads).toEqual([]);
    expect(view.getState().status).toBe('idle');
  });

  it('goes from loading to ready with the title, pushing a state only when it changed, and stops after unsubscribe', async () => {
    const { view } = setup();
    const seen: ReturnType<typeof view.getState>[] = [];
    const off = view.onState((s) => seen.push(s));
    await view.navigate(NEW_SESSION);
    await vi.waitFor(() => expect(view.getState().status).toBe('ready'));
    expect(seen[0]).toMatchObject({ status: 'loading', note: null });
    expect(seen.at(-1)).toMatchObject({ status: 'ready', url: NEW_SESSION, title: 'Claude Code', note: null });
    expect(seen.map((s) => s.status).filter((status, i, all) => i === 0 || status !== all[i - 1])).toEqual(['loading', 'ready']);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toEqual(seen[i - 1]);
    const count = seen.length;
    off();
    await view.navigate(SESSION);
    await vi.waitFor(() => expect(view.getState().url).toBe(SESSION));
    expect(seen).toHaveLength(count);
  });

  it('a listener that throws does not stop the others or the view', async () => {
    const s = setup();
    const good = vi.fn();
    s.view.onState(() => { throw new Error('boom'); });
    s.view.onState(good);
    await show(s, HOME);
    expect(good).toHaveBeenCalled();
    expect(s.deps.log.warn).toHaveBeenCalledWith('claude web state listener failed', expect.anything());
  });

  it('leaves a page alone when it already shows the same address, and loads another one', async () => {
    const s = setup();
    await show(s, NEW_SESSION);
    await s.view.navigate(NEW_SESSION);
    await s.view.navigate(`${NEW_SESSION}#later`);
    await s.view.navigate('https://www.claude.ai/code?repositories=acme/webapp');
    await tick(10);
    expect(s.contents.loads).toEqual([NEW_SESSION]);
    await s.view.navigate('https://claude.ai/code?repositories=acme/other');
    await s.view.navigate(HOME);
    await tick(10);
    expect(s.contents.loads).toEqual([NEW_SESSION, 'https://claude.ai/code?repositories=acme/other', HOME]);
  });

  it('asking again for the page that is still loading does not start it over, and a different page replaces it without a flicker to idle', async () => {
    const s = setup({ plan: (url) => (url === HOME ? { type: 'ok', delayMs: 40 } : { type: 'ok' }) });
    const seen: string[] = [];
    s.view.onState((st) => seen.push(st.status));
    await s.view.navigate(HOME);
    await s.view.navigate(HOME);
    expect(s.contents.loads).toEqual([HOME]);
    await s.view.navigate(SESSION);
    await vi.waitFor(() => expect(s.view.getState()).toMatchObject({ status: 'ready', url: SESSION }));
    await tick(60);
    expect(s.contents.loads).toEqual([HOME, SESSION]);
    // The address and title arrive while it is still loading, so 'loading' may be pushed more than once; 'idle' never is.
    expect(seen.filter((status, i, all) => i === 0 || status !== all[i - 1])).toEqual(['loading', 'ready']);
    expect(s.view.getState().url).toBe(SESSION);
  });

  it('retries a page that failed to load instead of treating it as already open', async () => {
    let attempt = 0;
    const s = setup({ plan: () => (attempt++ === 0 ? { type: 'fail', code: -105, description: 'ERR_NAME_NOT_RESOLVED' } : { type: 'ok' }) });
    await show(s, HOME, 'error');
    await vi.waitFor(() => expect(s.contents.loading).toBe(false));
    await show(s, HOME);
    expect(s.contents.loads).toEqual([HOME, HOME]);
  });

  it('a sign-in page is not "already showing" the page that was asked for', async () => {
    let attempt = 0;
    const s = setup({ plan: () => (attempt++ === 0 ? { type: 'redirect', to: LOGIN } : { type: 'ok' }) });
    await show(s, HOME, 'login_required');
    await show(s, HOME);
    expect(s.contents.loads).toEqual([HOME, HOME]);
    expect(s.view.getState()).toMatchObject({ status: 'ready', url: HOME });
  });

  it('reload, back, forward and focus do nothing before the view exists, and back and forward only when the history allows', async () => {
    const { view, deps, contents } = setup();
    view.reload(); view.back(); view.forward(); view.focus();
    expect(deps.createView).not.toHaveBeenCalled();
    await view.navigate(HOME);
    await vi.waitFor(() => expect(view.getState().status).toBe('ready'));
    view.back();
    view.forward();
    expect(contents.backs).toBe(0);
    expect(contents.forwards).toBe(0);
    contents.history = 1;
    contents.forwardHistory = 1;
    view.back();
    view.forward();
    expect(contents.backs).toBe(1);
    expect(contents.forwards).toBe(1);
    view.reload();
    expect(contents.reloads).toBe(1);
  });

  it('reports whether the history can go back or forward in the state', async () => {
    const s = setup();
    await show(s, HOME);
    expect(s.view.getState()).toMatchObject({ canGoBack: false, canGoForward: false });
    s.contents.history = 2;
    s.contents.forwardHistory = 1;
    s.contents.emit('did-navigate-in-page', {}, SESSION, true);
    expect(s.view.getState()).toMatchObject({ canGoBack: true, canGoForward: true });
  });

  it('follows in-page navigation and title changes of the single page app, and ignores those of frames', async () => {
    const s = setup();
    await show(s, NEW_SESSION);
    s.contents.emit('did-navigate-in-page', {}, SESSION, true);
    s.contents.emit('page-title-updated', {}, 'Fix the login bug');
    expect(s.view.getState()).toMatchObject({ url: SESSION, title: 'Fix the login bug', status: 'ready' });
    s.contents.emit('did-navigate-in-page', {}, 'https://claude.ai/code/ignored', false);
    expect(s.view.getState().url).toBe(SESSION);
  });
});

describe('what the state says', () => {
  it('a sign-in page after a redirect is login_required, with a note that says it is a guess', async () => {
    const s = setup({ plan: () => ({ type: 'redirect', to: LOGIN }) });
    await show(s, NEW_SESSION, 'login_required');
    expect(s.view.getState()).toMatchObject({ status: 'login_required', url: LOGIN });
    expect(s.view.getState().note).toMatch(/sign-in page/);
    expect(s.view.getState().note).toMatch(/guess/);
    expect(s.contents.loads).toEqual([NEW_SESSION]);
  });

  it('leaves login_required again when the next page is not a sign-in page', async () => {
    let attempt = 0;
    const s = setup({ plan: () => (attempt++ === 0 ? { type: 'redirect', to: LOGIN } : { type: 'ok' }) });
    await show(s, HOME, 'login_required');
    await show(s, SESSION);
    expect(s.view.getState()).toMatchObject({ status: 'ready', url: SESSION, note: null });
  });

  it('a sign-in provider that refused the embedded window is blocked, with the reason in words, and nothing is retried or worked around', async () => {
    const s = setup({ plan: () => ({ type: 'ok', finalUrl: GOOGLE_REFUSAL, title: 'Sign in' }) });
    await show(s, HOME, 'blocked');
    expect(s.view.getState().note).toMatch(/Google refused/);
    expect(s.view.getState().note).toMatch(/does not work around it/);
    expect(s.contents.loads).toEqual([HOME]);
    expect(s.deps.openExternal).not.toHaveBeenCalled();
  });

  it('a failed load is an error with the reason and the way out; a policy refusal is blocked', async () => {
    const offline = setup({ plan: () => ({ type: 'fail', code: -106, description: 'ERR_INTERNET_DISCONNECTED' }) });
    await show(offline, HOME, 'error');
    expect(offline.view.getState().note).toMatch(/ERR_INTERNET_DISCONNECTED/);
    expect(offline.view.getState().note).toMatch(/reload/);
    expect(offline.view.getState().note).toMatch(/Open in your browser/);

    const refused = setup({ plan: () => ({ type: 'fail', code: -27, description: 'ERR_BLOCKED_BY_RESPONSE' }) });
    await show(refused, HOME, 'blocked');
    expect(refused.view.getState().note).toMatch(/Some sites refuse embedded browsers/);
  });

  it('no note ever contains an em dash', async () => {
    const notes: string[] = [];
    for (const plan of [
      { type: 'redirect', to: LOGIN } as Plan,
      { type: 'ok', finalUrl: GOOGLE_REFUSAL } as Plan,
      { type: 'fail', code: -106, description: 'ERR_INTERNET_DISCONNECTED' } as Plan,
      { type: 'fail', code: -27, description: 'ERR_BLOCKED_BY_RESPONSE' } as Plan,
    ]) {
      const s = setup({ plan: () => plan });
      await s.view.navigate(HOME);
      await vi.waitFor(() => expect(s.view.getState().note).not.toBeNull());
      notes.push(s.view.getState().note ?? '');
    }
    expect(notes).toHaveLength(4);
    const emDash = String.fromCharCode(0x2014); // built from its code so this file holds no dash itself
    for (const note of notes) expect(note).not.toContain(emDash);
  });

  it('ignores failures of subframes and aborted loads', async () => {
    const s = setup();
    await show(s, HOME);
    s.contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.example/', false);
    s.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', HOME, true);
    expect(s.view.getState().status).toBe('ready');
  });

  it('shows an error when the page process dies, and a new page clears it', async () => {
    const s = setup();
    await show(s, HOME);
    s.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(s.view.getState().status).toBe('error');
    expect(s.view.getState().note).toMatch(/crashed/);
    await show(s, SESSION);
    expect(s.view.getState()).toMatchObject({ status: 'ready', url: SESSION, note: null });
  });

  it('writes the status into the log without any address', async () => {
    const s = setup({ plan: (url) => (url.includes('fail') ? { type: 'fail', code: -105, description: 'ERR_NAME_NOT_RESOLVED' } : { type: 'ok' }) });
    await show(s, NEW_SESSION);
    await show(s, 'https://claude.ai/code/fail', 'error');
    const statuses = s.deps.log.info.mock.calls.filter((c) => c[0] === 'claude web view status').map((c) => c[1]);
    expect(statuses).toEqual([{ status: 'loading' }, { status: 'ready' }, { status: 'loading' }, { status: 'error', failure: 'ERR_NAME_NOT_RESOLVED' }]);
  });
});

describe('navigation policy of the view', () => {
  async function ready() {
    const s = setup();
    await show(s, HOME);
    return s;
  }

  it.each([
    ['claude.ai', page('session_abc')],
    ['a claude.ai subdomain', 'https://api.claude.ai/x'],
    ['claude.com', 'https://claude.com/product'],
    ['anthropic.com', 'https://console.anthropic.com/settings'],
    ['Google sign-in', 'https://accounts.google.com/o/oauth2/v2/auth'],
    ['Microsoft sign-in', 'https://login.microsoftonline.com/common'],
    ['Apple sign-in', 'https://appleid.apple.com/auth/authorize'],
    ['the Cloudflare check', 'https://challenges.cloudflare.com/cdn-cgi/x'],
    ['GitHub authorisation', 'https://github.com/login/oauth/authorize?client_id=x'],
  ])('lets will-navigate and will-redirect stay for %s', async (_name, url) => {
    const { contents, deps } = await ready();
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const e = policyEvent();
      contents.emit(eventName, e, url);
      expect(e.prevented).toBe(false);
    }
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('cancels a navigation to another website and hands it to the browser', async () => {
    const { contents, deps } = await ready();
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const e = policyEvent();
      contents.emit(eventName, e, 'https://example.org/page?x=1');
      expect(e.prevented).toBe(true);
    }
    expect(deps.openExternal).toHaveBeenCalledTimes(2);
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.org/page?x=1');
  });

  it('an address that is another website but is not a plain https link is cancelled and not opened anywhere', async () => {
    const { contents, deps } = await ready();
    const e = policyEvent();
    contents.emit('will-navigate', e, 'https://user:secret@example.org/');
    expect(e.prevented).toBe(true);
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith('claude web link not opened externally (not a plain https link)');
  });

  it.each([
    ['plain http', 'http://claude.ai/code'],
    ['a file', 'file:///C:/Windows/win.ini'],
    ['javascript', 'javascript:alert(1)'],
    ['a data page', 'data:text/html,<script>1</script>'],
    ['an app protocol', 'ms-msdt:/id PCWDiagnostic'],
    ['our own protocol', 'minisumma://settings'],
    ['no scheme', 'claude.ai/code'],
    ['a mail link', 'mailto:someone@example.org'],
    ['a backslash that could be read two ways', 'https://claude.ai\\@example.org/'],
  ])('refuses %s: cancelled, not opened anywhere, and the page stays', async (_name, url) => {
    const { view, contents, deps } = await ready();
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const e = policyEvent();
      contents.emit(eventName, e, url);
      expect(e.prevented).toBe(true);
    }
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(view.getState()).toMatchObject({ status: 'ready', url: HOME });
    expect(contents.loads).toEqual([HOME]);
  });

  it('window.open is always denied; Claude and sign-in pages navigate this same view instead', async () => {
    const { contents, deps } = await ready();
    expect(contents.windowOpen).not.toBeNull();
    contents.loads.length = 0;
    expect(contents.windowOpen!({ url: SESSION })).toEqual({ action: 'deny' });
    expect(contents.windowOpen!({ url: 'https://github.com/apps/claude/installations/new' })).toEqual({ action: 'deny' });
    await tick(5);
    expect(contents.loads).toEqual([SESSION, 'https://github.com/apps/claude/installations/new']);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('window.open to another website opens the browser, never a new window and never this view', async () => {
    const { contents, deps } = await ready();
    contents.loads.length = 0;
    expect(contents.windowOpen!({ url: 'https://example.org/' })).toEqual({ action: 'deny' });
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.org/');
    await tick(5);
    expect(contents.loads).toEqual([]);
  });

  it('window.open to anything else, including about:blank, does nothing at all', async () => {
    const { contents, deps } = await ready();
    contents.loads.length = 0;
    for (const url of ['about:blank', '  ABOUT:BLANK ', 'http://example.org/', 'file:///x', 'javascript:1', 'mailto:a@b.c']) {
      expect(contents.windowOpen!({ url })).toEqual({ action: 'deny' });
    }
    await tick(5);
    expect(contents.loads).toEqual([]);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('a window.open to a Claude address after the view is gone loads nothing', async () => {
    const { contents } = await ready();
    contents.loads.length = 0;
    contents.windowOpen!({ url: SESSION });
    contents.destroyed = true;
    await tick(5);
    expect(contents.loads).toEqual([]);
  });

  it('a redirect to another website is cancelled and opened in the browser; with no page before it, the view stays idle', async () => {
    const s = setup({ plan: () => ({ type: 'redirect', to: 'https://example.org/landing' }) });
    await s.view.navigate(HOME);
    await vi.waitFor(() => expect(s.deps.openExternal).toHaveBeenCalledWith('https://example.org/landing'));
    await vi.waitFor(() => expect(s.contents.loading).toBe(false));
    expect(s.view.getState()).toMatchObject({ status: 'idle', url: null, note: null });
    expect(s.contents.loads).toEqual([HOME]);
  });

  it('also recognises a cancelled redirect that is announced with ERR_ABORTED', async () => {
    const s = setup({ plan: () => ({ type: 'redirect', to: 'https://example.org/landing', abortEvent: true }) });
    await s.view.navigate(HOME);
    await vi.waitFor(() => expect(s.deps.openExternal).toHaveBeenCalledWith('https://example.org/landing'));
    await vi.waitFor(() => expect(s.view.getState().status).toBe('idle'));
  });

  it('after a cancelled redirect the view still says ready for the page it showed before', async () => {
    let n = 0;
    const s = setup({ plan: () => (n++ === 0 ? { type: 'ok' } : { type: 'redirect', to: 'https://example.org/landing' }) });
    await show(s, HOME);
    await s.view.navigate(SESSION);
    await vi.waitFor(() => expect(s.deps.openExternal).toHaveBeenCalledWith('https://example.org/landing'));
    await vi.waitFor(() => expect(s.contents.loading).toBe(false));
    expect(s.view.getState()).toMatchObject({ status: 'ready', url: HOME });
  });

  it('a redirect to a scheme that is refused is cancelled and nothing is opened', async () => {
    const s = setup({ plan: () => ({ type: 'redirect', to: 'file:///etc/passwd' }) });
    await s.view.navigate(HOME);
    await vi.waitFor(() => expect(s.contents.loading).toBe(false));
    await tick(10);
    expect(s.deps.openExternal).not.toHaveBeenCalled();
    expect(s.view.getState().status).toBe('idle');
  });
});

describe('what the view never does', () => {
  it('never touches the page: whatever the controller does, the only members of the web contents it reaches for are the ones in ClaudeViewContents', async () => {
    // Every property the controller reads or calls on the contents is recorded. A script, a stylesheet, a click, typed text, a cookie
    // or a user-agent change would each need a member that is not in this list.
    const allowed = new Set([
      'getURL', 'getTitle', 'isLoading', 'isDestroyed', 'loadURL', 'reload', 'canGoBack', 'canGoForward', 'goBack', 'goForward', 'focus', 'on', 'setWindowOpenHandler',
    ]);
    const reached = new Set<string>();
    const fake = new FakeContents(() => ({ type: 'ok' }));
    const spy = new Proxy(fake, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof prop === 'string' && typeof value === 'function') { reached.add(prop); return (value as (...args: unknown[]) => unknown).bind(target); }
        return value;
      },
    });
    const handle = { contents: spy, setBounds: vi.fn(), setVisible: vi.fn() } satisfies ClaudeViewHandle;
    const view = new ClaudeWebView({
      createView: () => handle, content: () => ({ width: 1600, height: 900, zoomFactor: 1 }), openExternal: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    view.setBounds(RECT);
    await view.navigate(NEW_SESSION);
    await vi.waitFor(() => expect(view.getState().status).toBe('ready'));
    await view.navigate(SESSION);
    view.setBounds(null);
    view.setBounds(RECT);
    view.setOverlayActive(true);
    view.setOverlayActive(false);
    fake.history = 1;
    fake.forwardHistory = 1;
    view.back(); view.forward(); view.reload(); view.focus();
    fake.emit('will-navigate', policyEvent(), 'https://example.org/');
    fake.windowOpen!({ url: SESSION });
    await tick(5);
    fake.emit('render-process-gone', {}, { reason: 'crashed' });
    expect([...reached].filter((name) => !allowed.has(name))).toEqual([]);
    expect(reached.has('loadURL')).toBe(true);
  });

  it('writes no address into the log, because a prefilled prompt travels in it', async () => {
    const s = setup();
    const secret = 'https://claude.ai/code?repositories=acme/webapp&prompt=rotate%20the%20production%20key';
    await show(s, secret);
    s.contents.emit('will-navigate', policyEvent(), 'https://example.org/?token=abc123');
    s.contents.emit('will-navigate', policyEvent(), 'https://user:pw@example.org/?token=abc123');
    s.contents.emit('will-navigate', policyEvent(), 'javascript:alert("abc123")');
    s.contents.windowOpen!({ url: 'mailto:abc123@example.org' });
    s.contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', secret, true);
    const logged = everythingLogged(s);
    for (const piece of ['prompt=', 'production', 'repositories', 'abc123', 'example.org', 'claude.ai']) expect(logged, piece).not.toContain(piece);
    expect(logged).toContain('claude web view created');
  });
});
