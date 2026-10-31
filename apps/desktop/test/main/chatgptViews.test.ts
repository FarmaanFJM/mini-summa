// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ViewContents } from '../../src/main/chatgptView.ts';
import { ChatGptViews, MAX_LIVE_CHATGPT_VIEWS } from '../../src/main/chatgptViews.ts';
import type { ChatGptViewNotice, PooledViewHandle } from '../../src/main/chatgptViews.ts';

const uuid = (c: string): string => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const page = (c: string): string => `https://chatgpt.com/c/${uuid(c)}`;
const RECT = { x: 0, y: 40, width: 700, height: 800 };

/** A web contents whose loads succeed at once. */
class Contents extends EventEmitter implements ViewContents {
  url = '';
  title = '';
  destroyed = false;
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return false; }
  isFocused() { return false; }
  isDestroyed() { return this.destroyed; }
  async loadURL(url: string) {
    this.url = url;
    this.title = `title ${url.slice(-4)}`;
    this.emit('did-start-loading');
    this.emit('did-navigate', {}, url);
    this.emit('did-finish-load');
    this.emit('did-stop-loading');
  }
  reload() { /* not needed */ }
  stop() { /* not needed */ }
  canGoBack() { return false; }
  canGoForward() { return false; }
  goBack() { /* not needed */ }
  goForward() { /* not needed */ }
  focus() { /* not needed */ }
  getZoomFactor() { return 1; }
  setZoomFactor() { /* not needed */ }
  setWindowOpenHandler() { /* not needed */ }
}

interface Fake { contents: Contents; bounds: unknown[]; visible: boolean[]; destroyed: number; handle: PooledViewHandle }

function setup(maxLive?: number) {
  const made: Fake[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const requestWorkspace = vi.fn();
  const views = new ChatGptViews({
    createView: () => {
      const contents = new Contents();
      const fake: Fake = { contents, bounds: [], visible: [], destroyed: 0, handle: null as never };
      fake.handle = { contents, setBounds: (r) => { fake.bounds.push(r); }, setVisible: (v) => { fake.visible.push(v); }, destroy: () => { fake.destroyed += 1; contents.destroyed = true; } };
      made.push(fake);
      return fake.handle;
    },
    content: () => ({ width: 1400, height: 900, zoomFactor: 1 }),
    requestWorkspace,
    revealWindow: vi.fn(),
    openExternal: vi.fn(),
    log,
    timing: { boundsWaitMs: 100, settleMs: 1, loadTimeoutMs: 500, focusWaitMs: 1 },
    ...(maxLive === undefined ? {} : { maxLive }),
  });
  const notices: ChatGptViewNotice[] = [];
  views.onNotice((n) => notices.push(n));
  const states: { key: string | null; url: string | null }[] = [];
  views.onState((s, key) => states.push({ key, url: s.url }));
  /** The pane of a project is shown and navigates, as the renderer does when a project is selected. */
  const show = async (key: string, url: string): Promise<void> => { views.setBounds(RECT, key); await views.navigate(url, key); };
  return { views, made, notices, states, log, show, requestWorkspace };
}

describe('the bound', () => {
  it('is four live views by default', () => { expect(MAX_LIVE_CHATGPT_VIEWS).toBe(4); });

  it('keeps every view alive up to the bound, each with its own page, and creates a view only when a project first loads something', async () => {
    const s = setup();
    s.views.setBounds(RECT, 'a'); // placed, nothing loaded: no view yet
    expect(s.made).toHaveLength(0);
    await s.show('a', page('1'));
    await s.show('b', page('2'));
    await s.show('c', page('3'));
    await s.show('d', page('4'));
    expect(s.made).toHaveLength(4);
    expect(s.views.liveKeys().sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(s.views.getState('a').url).toBe(page('1'));
    expect(s.views.getState('c').url).toBe(page('3'));
    expect(s.made.map((m) => m.destroyed)).toEqual([0, 0, 0, 0]);
    expect(s.notices).toEqual([]);
  });

  it('evicts the least recently used view that is not the active one when a fifth is needed, and says so with the address it will reload at', async () => {
    const s = setup();
    for (const [k, c] of [['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']] as const) await s.show(k, page(c));
    s.views.setBounds(RECT, 'a'); // a is used again: b is now the oldest
    await s.show('e', page('5'));
    expect(s.notices).toEqual([{ kind: 'unloaded', key: 'b', url: page('2') }]);
    expect(s.made.map((m) => m.destroyed)).toEqual([0, 1, 0, 0, 0]);
    expect(s.views.liveKeys().sort()).toEqual(['a', 'c', 'd', 'e']);
    expect(s.views.getState('b').url).toBeNull(); // idle: nothing there until it is asked again
    expect(s.states.at(-1)).toEqual({ key: 'e', url: page('5') });
    expect(s.states.some((x) => x.key === 'b' && x.url === null)).toBe(true); // the window is told its view is gone
  });

  it('evicts in least-recently-used order over several rounds', async () => {
    const s = setup(2);
    await s.show('a', page('1'));
    await s.show('b', page('2'));
    await s.show('c', page('3')); // a goes
    await s.show('a', page('1')); // b goes (c is the active view's predecessor and newer)
    await s.show('b', page('2')); // c goes
    expect(s.notices.map((n) => n.key)).toEqual(['a', 'b', 'c']);
  });

  it('never evicts the active view, even when it is the oldest', async () => {
    const s = setup(1);
    await s.show('a', page('1'));
    await s.show('b', page('2'));
    expect(s.notices.map((n) => n.key)).toEqual(['a']);
    expect(s.views.liveKeys()).toEqual(['b']);
    expect(s.views.activeKey).toBe('b');
    expect(s.made[1].destroyed).toBe(0);
  });

  it('a project that was unloaded gets a new view when it loads again, at the address it is given', async () => {
    const s = setup(1);
    await s.show('a', page('1'));
    await s.show('b', page('2'));
    await s.show('a', page('1'));
    expect(s.made).toHaveLength(3);
    expect(s.views.getState('a').url).toBe(page('1'));
    expect(s.notices.map((n) => n.key)).toEqual(['a', 'b']);
  });
});

describe('a view is never destroyed because of layout, hiding, an overlay or a window change', () => {
  it('hiding, moving, overlays, reapply and page size changes destroy nothing', async () => {
    const s = setup();
    for (const [k, c] of [['a', '1'], ['b', '2'], ['c', '3']] as const) await s.show(k, page(c));
    for (let i = 0; i < 3; i += 1) {
      s.views.setBounds(null, 'c');
      s.views.setBounds({ ...RECT, width: 500 + i }, 'a');
      s.views.setOverlayActive(true);
      s.views.reapply();
      s.views.setOverlayActive(false);
      s.views.setPageScale('80');
      s.views.setBounds(null);
    }
    expect(s.made.map((m) => m.destroyed)).toEqual([0, 0, 0]);
    expect(s.views.liveKeys().sort()).toEqual(['a', 'b', 'c']);
    expect(s.notices).toEqual([]);
  });

  it('placing one project\'s view takes the others off the screen without destroying them', async () => {
    const s = setup();
    await s.show('a', page('1'));
    await s.show('b', page('2'));
    expect(s.made[1].visible.at(-1)).toBe(true);
    expect(s.made[0].visible.at(-1)).toBe(false);
    s.views.setBounds(RECT, 'a');
    expect(s.made[0].visible.at(-1)).toBe(true);
    expect(s.made[1].visible.at(-1)).toBe(false);
    expect(s.made.map((m) => m.destroyed)).toEqual([0, 0]);
  });

  it('an overlay covers every view, and a view created while it is on starts covered', async () => {
    const s = setup();
    await s.show('a', page('1'));
    s.views.setOverlayActive(true);
    expect(s.made[0].visible.at(-1)).toBe(false);
    await s.show('b', page('2'));
    expect(s.made[1].visible.at(-1) ?? false).toBe(false);
    s.views.setOverlayActive(false);
    expect(s.made[1].visible.at(-1)).toBe(true);
    expect(s.made[0].visible.at(-1)).toBe(false); // not the placed one
  });
});

describe('calls without a key', () => {
  it('act on the active view, and on one default view when nothing was ever given a key (the old single view)', async () => {
    const s = setup();
    await s.views.navigate(page('1'));
    s.views.setBounds(RECT);
    expect(s.made).toHaveLength(1);
    expect(s.views.getState().url).toBe(page('1'));
    expect(s.views.activeKey).toBeNull();
    await s.show('a', page('2'));
    expect(s.views.getState().url).toBe(page('2')); // a is the active view now
    expect(s.views.getState('a').url).toBe(page('2'));
  });

  it('the state of a key nobody loaded is idle, and asking creates nothing', () => {
    const s = setup();
    expect(s.views.getState('nobody')).toMatchObject({ status: 'idle', url: null });
    expect(s.made).toHaveLength(0);
  });
});

describe('the core hands pages to the view on screen', () => {
  it('open() goes to the active project\'s view', async () => {
    const s = setup();
    await s.show('a', page('1'));
    await s.show('b', page('2'));
    const result = await s.views.open(page('3'), { focus: false, reason: 'handoff' });
    expect(result.opened).toBe(true);
    expect(s.views.getState('b').url).toBe(page('3'));
    expect(s.views.getState('a').url).toBe(page('1'));
  });

  it('open() with no pane on screen asks for the workspace and waits for a pane to be placed, then uses the project that placed it', async () => {
    const s = setup();
    const pending = s.views.open(page('7'), { focus: false, reason: 'handoff' });
    expect(s.requestWorkspace).toHaveBeenCalled();
    setTimeout(() => s.views.setBounds(RECT, 'late'), 20);
    const result = await pending;
    expect(result.opened).toBe(true);
    expect(s.views.getState('late').url).toBe(page('7'));
  });
});
