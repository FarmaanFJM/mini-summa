// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChatGptView } from '../../src/main/chatgptView.ts';
import type { Timing, ViewContents, ViewHandle } from '../../src/main/chatgptView.ts';

const ID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER = '11111111-2222-4333-8444-555555555555';
const CONV = `https://chatgpt.com/c/${ID}`;
const LOGIN = 'https://auth.openai.com/log-in';

type Plan =
  | { type: 'ok'; finalUrl?: string; title?: string; later?: { afterMs: number; url: string; title?: string } }
  | { type: 'fail'; code: number; description: string }
  | { type: 'redirect'; to: string }
  | { type: 'hang' };

interface PolicyEvent { prevented: boolean; preventDefault(): void }
const policyEvent = (): PolicyEvent => { const e: PolicyEvent = { prevented: false, preventDefault() { e.prevented = true; } }; return e; };

/** A stand-in for Electron's WebContents that behaves like one for the events the controller listens to. */
class FakeContents extends EventEmitter implements ViewContents {
  url = '';
  title = '';
  loading = false;
  focused = false;
  focusWorks = true;
  destroyed = false;
  loads: string[] = [];
  focusCalls = 0;
  reloads = 0;
  backs = 0;
  forwards = 0;
  history = 0;
  windowOpen: ((d: { url: string }) => { action: 'deny' }) | null = null;
  constructor(public plan: (url: string) => Plan) { super(); }

  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  isFocused() { return this.focused; }
  isDestroyed() { return this.destroyed; }
  reload() { this.reloads += 1; }
  stop() { this.loading = false; }
  canGoBack() { return this.history > 0; }
  canGoForward() { return false; }
  goBack() { this.backs += 1; }
  goForward() { this.forwards += 1; }
  focus() { this.focusCalls += 1; if (this.focusWorks) this.focused = true; }
  setWindowOpenHandler(h: (d: { url: string }) => { action: 'deny' }) { this.windowOpen = h; }

  loadURL(url: string): Promise<void> {
    this.loads.push(url);
    const plan = this.plan(url);
    this.loading = true;
    this.emit('did-start-loading');
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (plan.type === 'hang') return;
        if (plan.type === 'fail') {
          this.loading = false;
          this.emit('did-fail-load', {}, plan.code, plan.description, url, true);
          this.emit('did-stop-loading');
          reject(new Error(plan.description));
          return;
        }
        if (plan.type === 'redirect') {
          const event = policyEvent();
          this.emit('will-redirect', event, plan.to);
          if (event.prevented) {
            this.loading = false;
            this.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true);
            this.emit('did-stop-loading');
            reject(new Error('ERR_ABORTED'));
            return;
          }
          this.finish(plan.to, 'Redirected');
          resolve();
          return;
        }
        this.finish(plan.finalUrl ?? url, plan.title ?? 'ChatGPT');
        resolve();
        const later = plan.later;
        if (later) {
          setTimeout(() => {
            this.loading = true;
            this.emit('did-start-loading');
            setTimeout(() => this.finish(later.url, later.title ?? 'ChatGPT'), 2);
          }, later.afterMs);
        }
      }, 1);
    });
  }

  private finish(url: string, title: string) {
    this.url = url;
    this.title = title;
    this.emit('did-navigate', {}, url);
    this.emit('page-title-updated', {}, title);
    this.loading = false;
    this.emit('did-finish-load');
    this.emit('did-stop-loading');
  }
}

const TIMING: Partial<Timing> = { boundsWaitMs: 60, loadTimeoutMs: 250, settleMs: 20, focusWaitMs: 5 };
const RECT = { x: 300, y: 50, width: 700, height: 800 };

function setup(opts: { plan?: (url: string) => Plan; timing?: Partial<Timing>; window?: { width: number; height: number; zoomFactor: number } | null; bounds?: boolean } = {}) {
  const contents = new FakeContents(opts.plan ?? (() => ({ type: 'ok' })));
  const handle = { contents, setBounds: vi.fn(), setVisible: vi.fn() } satisfies ViewHandle;
  const win = { current: opts.window === undefined ? { width: 1600, height: 900, zoomFactor: 1 } : opts.window };
  const deps = {
    createView: vi.fn(() => handle),
    content: () => win.current,
    requestWorkspace: vi.fn(),
    revealWindow: vi.fn(),
    openExternal: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    timing: { ...TIMING, ...opts.timing },
  };
  const view = new ChatGptView(deps);
  if (opts.bounds !== false) view.setBounds(RECT);
  return { view, contents, handle, deps, win };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('navigation policy of the view', () => {
  async function ready() {
    const s = setup();
    await s.view.open(CONV, { focus: false, reason: 'user' });
    return s;
  }

  it.each([
    ['chatgpt.com', 'https://chatgpt.com/c/abc'],
    ['a chatgpt subdomain', 'https://cdn.oaistatic.com/x'],
    ['the sign-in host', 'https://auth.openai.com/authorize'],
    ['Google sign-in', 'https://accounts.google.com/o/oauth2/v2/auth'],
    ['Microsoft sign-in', 'https://login.microsoftonline.com/common'],
    ['the Cloudflare check', 'https://challenges.cloudflare.com/cdn-cgi/x'],
  ])('lets will-navigate and will-redirect stay for %s', async (_name, url) => {
    const { contents, deps } = await ready();
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const e = policyEvent();
      contents.emit(eventName, e, url);
      expect(e.prevented).toBe(false);
    }
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('cancels a navigation to another website and hands it to the system browser', async () => {
    const { contents, deps } = await ready();
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const e = policyEvent();
      contents.emit(eventName, e, 'https://example.org/page?x=1');
      expect(e.prevented).toBe(true);
    }
    expect(deps.openExternal).toHaveBeenCalledTimes(2);
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.org/page?x=1');
  });

  it.each([
    ['plain http', 'http://chatgpt.com/'],
    ['a file', 'file:///C:/Windows/win.ini'],
    ['javascript', 'javascript:alert(1)'],
    ['a data page', 'data:text/html,<script>1</script>'],
    ['an app protocol', 'ms-msdt:/id PCWDiagnostic'],
    ['our own protocol', 'minisumma://settings'],
    ['no scheme', 'chatgpt.com/'],
  ])('cancels %s and does not open it anywhere', async (_name, url) => {
    const { contents, deps } = await ready();
    const e = policyEvent();
    contents.emit('will-navigate', e, url);
    expect(e.prevented).toBe(true);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('window.open is always denied; ChatGPT and sign-in pages navigate this same view instead', async () => {
    const { contents, deps } = await ready();
    expect(contents.windowOpen).not.toBeNull();
    contents.loads.length = 0;
    expect(contents.windowOpen!({ url: `https://chatgpt.com/c/${OTHER}` })).toEqual({ action: 'deny' });
    expect(contents.windowOpen!({ url: LOGIN })).toEqual({ action: 'deny' });
    await tick(5);
    expect(contents.loads).toEqual([`https://chatgpt.com/c/${OTHER}`, LOGIN]);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('window.open to another website opens the system browser, never a new window', async () => {
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
    for (const url of ['about:blank', 'http://example.org/', 'file:///x', 'javascript:1']) {
      expect(contents.windowOpen!({ url })).toEqual({ action: 'deny' });
    }
    await tick(5);
    expect(contents.loads).toEqual([]);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});

describe('open(): what it claims', () => {
  it('refuses an address that is not a ChatGPT page, without creating the view', async () => {
    const { view, deps, contents } = setup();
    for (const bad of ['https://example.org/', 'http://chatgpt.com/', 'javascript:alert(1)', '']) {
      const r = await view.open(bad, { focus: true, reason: 'handoff' });
      expect(r).toMatchObject({ ok: false, mode: 'embedded', opened: false, focused: false, verified: null, finalUrl: null, title: null });
      expect(r.note).toMatch(/Nothing was opened/);
    }
    expect(deps.createView).not.toHaveBeenCalled();
    expect(contents.loads).toEqual([]);
  });

  it('opens the requested conversation and verifies the address', async () => {
    const { view, contents } = setup();
    const r = await view.open(CONV, { focus: false, reason: 'verify' });
    expect(contents.loads).toEqual([CONV]);
    expect(r).toMatchObject({ ok: true, mode: 'embedded', opened: true, focused: false, verified: true, finalUrl: CONV, title: 'ChatGPT' });
    expect(r.note).toMatch(/cannot read the page/);
    expect(view.getState()).toMatchObject({ status: 'ready', url: CONV, note: null });
  });

  it('normalizes the address before loading it (legacy host, query, fragment)', async () => {
    const { view, contents } = setup();
    await view.open(`https://chat.openai.com/c/${ID.toUpperCase()}?model=x#frag`, { focus: false, reason: 'user' });
    expect(contents.loads).toEqual([CONV]);
  });

  it('claims focus only when the web contents reports it', async () => {
    const yes = setup();
    const r1 = await yes.view.open(CONV, { focus: true, reason: 'handoff' });
    expect(r1.focused).toBe(true);
    expect(yes.contents.focusCalls).toBe(1);
    expect(yes.deps.revealWindow).toHaveBeenCalled();

    const no = setup();
    no.contents.focusWorks = false;
    const r2 = await no.view.open(CONV, { focus: true, reason: 'handoff' });
    expect(r2.focused).toBe(false);
    expect(r2.opened).toBe(true);
    expect(r2.note).toMatch(/did not report keyboard focus/);
  });

  it('does not focus or raise anything when focus was not asked for', async () => {
    const { view, contents, deps } = setup();
    const r = await view.open(CONV, { focus: false, reason: 'user' });
    expect(r.focused).toBe(false);
    expect(contents.focusCalls).toBe(0);
    expect(deps.revealWindow).not.toHaveBeenCalled();
  });

  it('verify() is open without focus', async () => {
    const { view, contents, deps } = setup();
    const r = await view.verify(CONV);
    expect(r.verified).toBe(true);
    expect(r.focused).toBe(false);
    expect(contents.focusCalls).toBe(0);
    expect(deps.revealWindow).not.toHaveBeenCalled();
  });

  it('a redirect to the sign-in page is opened but NOT verified', async () => {
    const { view } = setup({ plan: () => ({ type: 'redirect', to: LOGIN }) });
    const r = await view.open(CONV, { focus: true, reason: 'handoff' });
    expect(r).toMatchObject({ ok: true, opened: true, verified: false, finalUrl: LOGIN });
    expect(r.note).toMatch(/sign-in/i);
    expect(view.getState().status).toBe('login_required');
  });

  it('a client-side redirect just after the first load is still caught', async () => {
    const { view } = setup({ plan: () => ({ type: 'ok', later: { afterMs: 5, url: LOGIN, title: 'Log in' } }) });
    const r = await view.open(CONV, { focus: false, reason: 'verify' });
    expect(r.verified).toBe(false);
    expect(r.finalUrl).toBe(LOGIN);
    expect(r.title).toBe('Log in');
    expect(view.getState().status).toBe('login_required');
  });

  it('landing on a different page inside ChatGPT is not verified either', async () => {
    const { view } = setup({ plan: () => ({ type: 'ok', finalUrl: `https://chatgpt.com/c/${OTHER}` }) });
    const r = await view.open(CONV, { focus: false, reason: 'verify' });
    expect(r).toMatchObject({ ok: true, opened: true, verified: false });
    expect(r.note).toMatch(/different page/);
  });

  it('the right address under a security check is not verified', async () => {
    const { view } = setup({ plan: () => ({ type: 'ok', title: 'Just a moment...' }) });
    const r = await view.open(CONV, { focus: false, reason: 'verify' });
    expect(r).toMatchObject({ ok: true, opened: true, verified: false, finalUrl: CONV });
    expect(r.note).toMatch(/security check/);
    expect(view.getState().status).toBe('challenge');
  });

  it('a failed load is reported as not opened, with the reason', async () => {
    const { view } = setup({ plan: () => ({ type: 'fail', code: -106, description: 'ERR_INTERNET_DISCONNECTED' }) });
    const r = await view.open(CONV, { focus: true, reason: 'handoff' });
    expect(r).toMatchObject({ ok: false, opened: false, focused: false, verified: null });
    expect(r.note).toMatch(/ERR_INTERNET_DISCONNECTED/);
    expect(view.getState()).toMatchObject({ status: 'error' });
  });

  it('a policy refusal is reported as blocked', async () => {
    const { view } = setup({ plan: () => ({ type: 'fail', code: -27, description: 'ERR_BLOCKED_BY_RESPONSE' }) });
    const r = await view.open(CONV, { focus: false, reason: 'user' });
    expect(r).toMatchObject({ ok: false, opened: false });
    expect(view.getState().status).toBe('blocked');
  });

  it('a redirect to another website is cancelled, opened in the browser, and not claimed as opened', async () => {
    const { view, deps } = setup({ plan: () => ({ type: 'redirect', to: 'https://example.org/landing' }) });
    const r = await view.open(CONV, { focus: false, reason: 'user' });
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.org/landing');
    expect(r).toMatchObject({ ok: false, opened: false, verified: null });
    expect(r.note).toMatch(/another site/);
  });

  it('a load that never ends is reported as still loading, unverified', async () => {
    const { view } = setup({ plan: () => ({ type: 'hang' }), timing: { loadTimeoutMs: 40 } });
    const r = await view.open(CONV, { focus: true, reason: 'handoff' });
    expect(r).toMatchObject({ ok: true, opened: true, verified: null });
    expect(r.note).toMatch(/still loading/);
    expect(r.focused).toBe(false);
  });

  it('leaves the page alone when it already shows the same conversation', async () => {
    const { view, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    expect(contents.loads).toHaveLength(1);
    const again = await view.open(`${CONV}?model=gpt#x`, { focus: true, reason: 'handoff' });
    expect(contents.loads).toHaveLength(1);
    expect(again).toMatchObject({ ok: true, opened: true, verified: true, focused: true });
  });

  it('loads again when a different conversation is requested', async () => {
    const { view, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    const r = await view.open(`https://chatgpt.com/c/${OTHER}`, { focus: false, reason: 'user' });
    expect(contents.loads).toEqual([CONV, `https://chatgpt.com/c/${OTHER}`]);
    expect(r.verified).toBe(true);
    expect(r.finalUrl).toBe(`https://chatgpt.com/c/${OTHER}`);
  });

  it('retries a page that failed to load instead of treating it as already open', async () => {
    let attempt = 0;
    const { view, contents } = setup({ plan: () => (attempt++ === 0 ? { type: 'fail', code: -105, description: 'ERR_NAME_NOT_RESOLVED' } : { type: 'ok' }) });
    expect((await view.open(CONV, { focus: false, reason: 'user' })).ok).toBe(false);
    const second = await view.open(CONV, { focus: false, reason: 'user' });
    expect(contents.loads).toEqual([CONV, CONV]);
    expect(second).toMatchObject({ ok: true, verified: true });
  });

  it('does not touch the page while a dialog covers the pane, and says so', async () => {
    const { view, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    view.setOverlayActive(true);
    const r = await view.open(CONV, { focus: true, reason: 'handoff' });
    expect(r.focused).toBe(false);
    expect(contents.focusCalls).toBe(0);
    expect(r.note).toMatch(/covered by a dialog/);
  });

  it('runs opens one at a time, in order', async () => {
    const order: string[] = [];
    const { view, contents } = setup({
      plan: (url) => { order.push(url); return { type: 'ok' }; },
    });
    const a = view.open(CONV, { focus: false, reason: 'user' });
    const b = view.open(`https://chatgpt.com/c/${OTHER}`, { focus: false, reason: 'verify' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(order).toEqual([CONV, `https://chatgpt.com/c/${OTHER}`]);
    expect(ra.verified).toBe(true);
    expect(rb.verified).toBe(true);
    expect(contents.loads).toHaveLength(2);
  });

  it('reports a closed window instead of throwing', async () => {
    const { view, deps } = setup({ window: null, bounds: false });
    const r = await view.open(CONV, { focus: false, reason: 'user' });
    expect(r).toMatchObject({ ok: false, opened: false });
    expect(r.note).toMatch(/window is closed/);
    expect(deps.createView).not.toHaveBeenCalled();
  });
});

describe('open(): the pane has to be on screen first', () => {
  it('asks the renderer for the workspace, and when no bounds arrive says nothing was opened', async () => {
    const { view, deps, contents } = setup({ bounds: false });
    const r = await view.open(CONV, { focus: true, reason: 'handoff' });
    expect(deps.requestWorkspace).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, opened: false, focused: false, verified: null });
    expect(r.note).toMatch(/not on screen/);
    expect(contents.loads).toEqual([]);
    expect(deps.createView).not.toHaveBeenCalled();
  });

  it('carries on when the renderer places the pane within the wait', async () => {
    const { view, deps, contents } = setup({ bounds: false });
    deps.requestWorkspace.mockImplementation(() => { setTimeout(() => view.setBounds(RECT), 10); });
    const r = await view.open(CONV, { focus: false, reason: 'handoff' });
    expect(deps.requestWorkspace).toHaveBeenCalledTimes(1);
    expect(contents.loads).toEqual([CONV]);
    expect(r).toMatchObject({ ok: true, opened: true, verified: true });
  });

  it('does not ask for the workspace when the pane is already placed', async () => {
    const { view, deps } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    expect(deps.requestWorkspace).not.toHaveBeenCalled();
  });

  it('waits for the pane even if it was hidden again with null before the open', async () => {
    const { view, deps } = setup();
    view.setBounds(null);
    const r = await view.open(CONV, { focus: false, reason: 'user' });
    expect(deps.requestWorkspace).toHaveBeenCalledTimes(1);
    expect(r.opened).toBe(false);
  });
});

describe('placement of the native view', () => {
  it('creates the view lazily and only once', async () => {
    const { view, deps } = setup();
    expect(deps.createView).not.toHaveBeenCalled();
    view.setBounds({ x: 1, y: 1, width: 10, height: 10 });
    view.setOverlayActive(true);
    view.setBounds(null);
    expect(deps.createView).not.toHaveBeenCalled();
    view.setBounds(RECT);
    view.setOverlayActive(false);
    await view.navigate(CONV);
    await view.open(`https://chatgpt.com/c/${OTHER}`, { focus: false, reason: 'user' });
    expect(deps.createView).toHaveBeenCalledTimes(1);
  });

  it('places the view with converted bounds and shows it', async () => {
    const { view, handle } = setup({ window: { width: 1600, height: 900, zoomFactor: 1.25 } });
    await view.navigate(CONV);
    expect(handle.setBounds).toHaveBeenLastCalledWith({ x: 375, y: 63, width: 875, height: 900 - 63 });
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.showing).toBe(true);
  });

  it('hides on null and when an overlay is active; shows again after, without touching the page', async () => {
    const { view, handle, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    expect(view.showing).toBe(true);
    view.setBounds(null);
    expect(handle.setVisible).toHaveBeenLastCalledWith(false);
    view.setBounds(RECT);
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
    view.setOverlayActive(true);
    expect(handle.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.showing).toBe(false);
    view.setOverlayActive(false);
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
    expect(contents.loads).toEqual([CONV]);
    expect(contents.destroyed).toBe(false);
  });

  it('does not repeat native calls for an unchanged placement', async () => {
    const { view, handle } = setup();
    await view.navigate(CONV);
    handle.setBounds.mockClear();
    handle.setVisible.mockClear();
    view.setBounds(RECT);
    view.setBounds({ ...RECT });
    view.reapply();
    expect(handle.setBounds).not.toHaveBeenCalled();
    expect(handle.setVisible).not.toHaveBeenCalled();
  });

  it('re-derives the bounds when the window changes (resize, maximize, fullscreen)', async () => {
    const { view, handle, win } = setup();
    await view.navigate(CONV);
    expect(handle.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 50, width: 700, height: 800 });
    win.current = { width: 1000, height: 600, zoomFactor: 1 };
    view.reapply();
    expect(handle.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 50, width: 700, height: 550 });
    win.current = { width: 1920, height: 1080, zoomFactor: 1 };
    view.reapply();
    expect(handle.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 50, width: 700, height: 800 });
  });

  it('hides when the window shrinks past the pane and returns when it grows back', async () => {
    const { view, handle, win } = setup();
    await view.navigate(CONV);
    win.current = { width: 250, height: 600, zoomFactor: 1 };
    view.reapply();
    expect(handle.setVisible).toHaveBeenLastCalledWith(false);
    win.current = { width: 1600, height: 900, zoomFactor: 1 };
    view.reapply();
    expect(handle.setVisible).toHaveBeenLastCalledWith(true);
  });
});

describe('navigate, history and state', () => {
  it('navigate rejects anything that is not a ChatGPT address', async () => {
    const { view } = setup();
    await expect(view.navigate('https://example.org/')).rejects.toThrow();
  });

  it('navigate loads the normalized address and skips a page that is already shown', async () => {
    const { view, contents } = setup();
    await view.navigate(`https://chatgpt.com/c/${ID}?x=1`);
    await tick(10);
    expect(contents.loads).toEqual([CONV]);
    await view.navigate(CONV);
    expect(contents.loads).toEqual([CONV]);
  });

  it('reload, back, forward and focus do nothing before the view exists', () => {
    const { view, deps } = setup();
    view.reload(); view.back(); view.forward(); view.focus();
    expect(deps.createView).not.toHaveBeenCalled();
  });

  it('back and forward only when the history allows', async () => {
    const { view, contents } = setup();
    await view.navigate(CONV);
    await tick(10);
    view.back();
    expect(contents.backs).toBe(0);
    contents.history = 1;
    view.back();
    expect(contents.backs).toBe(1);
    view.forward();
    expect(contents.forwards).toBe(0);
  });

  it('reload and focus reach the page once it exists', async () => {
    const { view, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    view.reload();
    view.focus();
    expect(contents.reloads).toBe(1);
    expect(contents.focusCalls).toBe(1);
  });

  it('pushes a state only when it changed, and stops after unsubscribe', async () => {
    const { view } = setup();
    const seen: ReturnType<typeof view.getState>[] = [];
    const off = view.onState((s) => seen.push(s));
    await view.open(CONV, { focus: false, reason: 'user' });
    const statuses = seen.map((s) => s.status).filter((status, i, all) => i === 0 || status !== all[i - 1]);
    expect(statuses).toEqual(['loading', 'ready']);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toEqual(seen[i - 1]);
    expect(seen.at(-1)).toMatchObject({ status: 'ready', url: CONV });
    const count = seen.length;
    off();
    await view.open(`https://chatgpt.com/c/${OTHER}`, { focus: false, reason: 'user' });
    expect(seen).toHaveLength(count);
  });

  it('follows in-page navigation and title changes of the single-page app', async () => {
    const { view, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    contents.emit('did-navigate-in-page', {}, `https://chatgpt.com/c/${OTHER}`, true);
    contents.emit('page-title-updated', {}, 'Other chat');
    expect(view.getState()).toMatchObject({ url: `https://chatgpt.com/c/${OTHER}`, title: 'Other chat', status: 'ready' });
    contents.emit('did-navigate-in-page', {}, 'https://chatgpt.com/ignored', false);
    expect(view.getState().url).toBe(`https://chatgpt.com/c/${OTHER}`);
  });

  it('ignores failures of subframes and aborted loads', async () => {
    const { view, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.example/', false);
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', CONV, true);
    expect(view.getState().status).toBe('ready');
  });

  it('shows an error when the page process dies', async () => {
    const { view, contents } = setup();
    await view.open(CONV, { focus: false, reason: 'user' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(view.getState().status).toBe('error');
    expect(view.getState().note).toMatch(/crashed/);
  });
});
