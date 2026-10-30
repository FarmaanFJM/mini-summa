import { describe, expect, it } from 'vitest';
import type { BridgeAction } from '@minisumma/shared';
import { CHATGPT_TAB_PATTERNS, createBridge, rankTabs } from '../src/bridge.ts';
import type { BridgeOutcome, FocusOrOpenData } from '../src/bridge.ts';
import { FakeBrowser } from './fake-chrome.ts';
import { FakeClock } from './fake-clock.ts';
import { EM_DASH } from './em-dash.ts';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const U1 = `https://chatgpt.com/c/${ID1}`;
const U2 = `https://chatgpt.com/c/${ID2}`;
const LOGIN = 'https://chatgpt.com/auth/login';

function setup() {
  const clock = new FakeClock();
  const browser = new FakeBrowser(clock);
  const bridge = createBridge({ chrome: browser.chrome, now: clock.now, sleep: (ms) => clock.advance(ms) });
  const focus = (url: unknown) => bridge.handle({ kind: 'focus_or_open', url } as BridgeAction);
  return { clock, browser, bridge, focus };
}

function data(outcome: BridgeOutcome): FocusOrOpenData {
  if (!outcome.ok) throw new Error(`expected ok, got error: ${outcome.error}`);
  return outcome.data as FocusOrOpenData;
}

describe('focus_or_open with an existing tab', () => {
  it('activates the tab of the requested conversation and focuses its window', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    const a = browser.addTab({ windowId: w, url: U1, active: true, title: 'Conversation one' });
    const b = browser.addTab({ windowId: w, url: U2, title: 'Conversation two' });

    const d = data(await focus(U2));

    expect(d).toMatchObject({ mode: 'focused', tabId: b, windowId: w, url: U2, title: 'Conversation two', urlMatches: true, windowFocused: true });
    expect(d).toMatchObject({ focused: true, opened: false, verified: true }); // the names the core reads
    expect(d.note).toBeUndefined();
    expect(browser.tab(b).active).toBe(true);
    expect(browser.tab(a).active).toBe(false);
    expect(browser.callsTo('tabs.create')).toEqual([]);
    expect(browser.callsTo('tabs.update')).toEqual([[b, { active: true }]]);
    expect(browser.callsTo('windows.update')).toEqual([[w, { focused: true, drawAttention: false }]]);
  });

  it('brings a different window to the front when the tab lives there', async () => {
    const { browser, focus } = setup();
    const w1 = browser.addWindow(true);
    const w2 = browser.addWindow(false);
    browser.addTab({ windowId: w1, url: U1, active: true });
    const y = browser.addTab({ windowId: w2, url: U2, active: true });
    expect(browser.focusedWindow()?.id).toBe(w1);

    const d = data(await focus(U2));

    expect(d.windowId).toBe(w2);
    expect(d.tabId).toBe(y);
    expect(d.windowFocused).toBe(true);
    expect(browser.focusedWindow()?.id).toBe(w2);
    expect(browser.callsTo('windows.update')).toEqual([[w2, { focused: true, drawAttention: false }]]);
  });

  it('does not claim a match when the existing tab is the browser error page for that address', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    browser.addTab({ windowId: w, url: U1, title: 'chatgpt.com', active: true });
    const d = data(await focus(U1));
    expect(d.mode).toBe('focused');
    expect(d.urlMatches).toBe(false);
    expect(d.note).toMatch(/error page/);
  });

  it('does not focus a tab of another conversation, it opens the requested one instead', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    const other = browser.addTab({ windowId: w, url: U1, active: true });

    const d = data(await focus(U2));

    expect(d.mode).toBe('opened');
    expect(d.tabId).not.toBe(other);
    expect(browser.callsTo('tabs.create')).toEqual([[{ url: U2 }]]);
    expect(browser.callsTo('tabs.update').some(([id]) => id === other)).toBe(false);
  });

  it('treats query strings, fragments, trailing slashes, upper case ids, www and the legacy host as the same page', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    const target = browser.addTab({ windowId: w, url: `https://www.chatgpt.com/c/${ID2}/?model=x#top` });
    browser.addTab({ windowId: w, url: U1, active: true });

    const d = data(await focus(`https://chat.openai.com/c/${ID2.toUpperCase()}`));

    expect(d.mode).toBe('focused');
    expect(d.tabId).toBe(target);
    expect(d.urlMatches).toBe(true);
    expect(browser.callsTo('tabs.create')).toEqual([]);
  });

  it('ignores lookalike hosts, ports and credentials', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    browser.addTab({ windowId: w, url: `https://chatgpt.com.evil.example/c/${ID1}`, active: true });
    browser.addTab({ windowId: w, url: `https://example.com/c/${ID1}` });
    browser.addTab({ windowId: w, url: `https://chatgpt.com:8443/c/${ID1}` });
    browser.addTab({ windowId: w, url: `https://user:pw@chatgpt.com/c/${ID1}` });

    const d = data(await focus(U1));

    expect(d.mode).toBe('opened');
    expect(browser.callsTo('tabs.create')).toEqual([[{ url: U1 }]]);
  });

  it('always queries with the ChatGPT url filter and never without one', async () => {
    const { browser, focus, bridge } = setup();
    const w = browser.addWindow(true);
    browser.addTab({ windowId: w, url: 'https://example.com/private', active: true });
    await focus(U1);
    await bridge.handle({ kind: 'list_chatgpt_tabs' });
    const queries = browser.callsTo('tabs.query');
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const [arg] of queries) expect(arg).toEqual({ url: [...CHATGPT_TAB_PATTERNS] });
    expect(CHATGPT_TAB_PATTERNS).toEqual(['https://chatgpt.com/*', 'https://www.chatgpt.com/*', 'https://chat.openai.com/*']);
  });
});

describe('which tab is chosen when several show the same conversation', () => {
  it('prefers the active tab even when another one was accessed more recently', async () => {
    const { browser, focus } = setup();
    const w1 = browser.addWindow(true);
    const w2 = browser.addWindow();
    browser.addTab({ windowId: w1, url: U1, lastAccessed: 500 });
    const active = browser.addTab({ windowId: w1, url: U1, active: true, lastAccessed: 100 });
    browser.addTab({ windowId: w2, url: U1, lastAccessed: 900 });
    browser.addTab({ windowId: w2, url: 'https://example.com/', active: true });

    expect(data(await focus(U1)).tabId).toBe(active);
  });

  it('then prefers the most recently accessed one', async () => {
    const { browser, focus } = setup();
    const w1 = browser.addWindow(true);
    const w2 = browser.addWindow();
    browser.addTab({ windowId: w1, url: 'https://example.com/a', active: true });
    browser.addTab({ windowId: w1, url: U1, lastAccessed: 500 });
    browser.addTab({ windowId: w2, url: 'https://example.com/b', active: true });
    const recent = browser.addTab({ windowId: w2, url: U1, lastAccessed: 900 });

    const d = data(await focus(U1));

    expect(d.tabId).toBe(recent);
    expect(d.windowId).toBe(w2);
  });

  it('among several active tabs takes the most recently accessed, and the lowest id on a tie', () => {
    const t = (id: number, active: boolean, lastAccessed?: number) => ({ id, active, lastAccessed }) as chrome.tabs.Tab;
    expect(rankTabs([t(1, true, 100), t(2, true, 300), t(3, false, 900)]).map((x) => x.id)).toEqual([2, 1, 3]);
    expect(rankTabs([t(7, false, 5), t(4, false, 5), t(9, false)]).map((x) => x.id)).toEqual([4, 7, 9]);
  });
});

describe('focus_or_open without a tab', () => {
  it('creates a tab with the normalized address and reports where it ended up', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    browser.pages.set(U1, { title: 'Conversation one' });

    const d = data(await focus(U1));

    expect(browser.callsTo('tabs.create')).toEqual([[{ url: U1 }]]);
    expect(d).toMatchObject({ mode: 'opened', windowId: w, url: U1, title: 'Conversation one', urlMatches: true, windowFocused: true });
    expect(d).toMatchObject({ focused: true, opened: true, verified: true });
    expect(d.tabId).toBe(browser.tabs[0].id);
    expect(d.note).toBeUndefined();
    expect(browser.callsTo('windows.update')).toEqual([[w, { focused: true, drawAttention: false }]]);
  });

  it('opens the canonical address for a legacy host, odd case and extra query', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    await focus(`https://chat.openai.com/c/${ID1.toUpperCase()}/?utm=1#x`);
    expect(browser.callsTo('tabs.create')).toEqual([[{ url: U1 }]]);
  });

  it('waits for the load to finish before answering', async () => {
    const { browser, clock, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { loadMs: 3000 });

    const d = data(await focus(U1));

    expect(d.urlMatches).toBe(true);
    expect(clock.now()).toBeGreaterThanOrEqual(3000);
    expect(clock.now()).toBeLessThan(3000 + 1000);
  });

  it('reports urlMatches false when the load ends on the sign-in page', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { finalUrl: LOGIN });

    const d = data(await focus(U1));

    expect(d.mode).toBe('opened');
    expect(d.url).toBe(LOGIN);
    expect(d.urlMatches).toBe(false);
    expect(d.verified).toBe(false);
    expect(d.note).toMatch(/different address/);
  });

  it('reports urlMatches false when the load ends on another site', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { finalUrl: 'https://auth.example.com/log-in' });
    const d = data(await focus(U1));
    expect(d.urlMatches).toBe(false);
    expect(d.url).toBe('https://auth.example.com/log-in');
  });

  it('notices a client side redirect that happens shortly after the load event', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { redirectAfterMs: 200, redirectTo: LOGIN });
    const d = data(await focus(U1));
    expect(d.url).toBe(LOGIN);
    expect(d.urlMatches).toBe(false);
  });

  it('does not claim a match when the tab carries the browser error page label (site name only as title)', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { title: 'chatgpt.com' }); // what the browser shows for a failed network load, at the requested address
    const d = data(await focus(U1));
    expect(d.mode).toBe('opened');
    expect(d.url).toBe(U1);
    expect(d.urlMatches).toBe(false);
    expect(d.note).toMatch(/error page/);
  });

  it('still reports a match for a page whose title merely contains the site name', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { title: 'chatgpt.com notes' });
    expect(data(await focus(U1)).urlMatches).toBe(true);
  });

  it('gives up after 15 seconds and says the page did not finish loading', async () => {
    const { browser, clock, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { hang: true });

    const d = data(await focus(U1));

    expect(d.mode).toBe('opened');
    expect(d.urlMatches).toBe(false);
    expect(d.url).toBe('');
    expect(d.note).toMatch(/15 seconds/);
    expect(d.verified).toBeNull(); // not checked: the page never finished loading
    expect(d.opened).toBe(true);
    expect(clock.now()).toBeGreaterThanOrEqual(15_000);
    expect(clock.now()).toBeLessThan(15_200);
  });

  it('answers with an error when the tab is closed while it loads', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    browser.pages.set(U1, { closeAfterMs: 150 });
    const out = await focus(U1);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/closed before it finished loading/);
  });

  it('answers with an error when the browser refuses to create the tab', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    browser.failures.create = 'Tabs cannot be edited right now (user may be dragging a tab).';
    const out = await focus(U1);
    expect(out).toEqual({ ok: false, error: 'The browser could not open a new tab: Tabs cannot be edited right now (user may be dragging a tab).' });
  });

  it('serializes requests so two quick requests for one page open one tab', async () => {
    const { browser, focus } = setup();
    browser.addWindow(true);
    const [first, second] = await Promise.all([focus(U1), focus(U1)]);
    expect(browser.callsTo('tabs.create')).toHaveLength(1);
    expect(data(first).mode).toBe('opened');
    expect(data(second).mode).toBe('focused');
    expect(data(second).tabId).toBe(data(first).tabId);
  });
});

describe('honest reporting when the browser does not cooperate', () => {
  it('returns a plain error when the tab cannot be selected and does not touch the window', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    browser.addTab({ windowId: w, url: U1 });
    browser.failures.update = 'Tabs cannot be edited right now.';
    const out = await focus(U1);
    expect(out).toEqual({ ok: false, error: 'The ChatGPT tab could not be selected: Tabs cannot be edited right now.' });
    expect(browser.callsTo('windows.update')).toEqual([]);
  });

  it('still answers ok but says the window was not brought to the front when windows.update throws', async () => {
    const { browser, focus } = setup();
    const w = browser.addWindow(true);
    browser.addTab({ windowId: w, url: U1 });
    browser.failures.windowUpdate = 'No window with id: 9.';
    const d = data(await focus(U1));
    expect(d.mode).toBe('focused');
    expect(d.windowFocused).toBe(false);
    expect(d.focused).toBe(false); // never claimed when the browser did not confirm it
    expect(d.note).toMatch(/could not be brought to the front/);
    expect(d.urlMatches).toBe(true);
  });

  it('does not claim the window is in front when the browser reports it is not', async () => {
    const { browser, focus } = setup();
    const w1 = browser.addWindow(true);
    const w2 = browser.addWindow();
    browser.addTab({ windowId: w1, url: 'https://example.com/', active: true });
    browser.addTab({ windowId: w2, url: U1, active: true });
    browser.windowRefusesFocus = true;
    const d = data(await focus(U1));
    expect(d.windowFocused).toBe(false);
    expect(d.focused).toBe(false);
    expect(d.note).toMatch(/did not confirm/);
    expect(browser.focusedWindow()?.id).toBe(w1);
  });

  it('never rejects: an unexpected browser error becomes ok false', async () => {
    const { browser, bridge } = setup();
    browser.chrome.tabs.query = async () => { throw new Error('boom'); };
    const out = await bridge.handle({ kind: 'list_chatgpt_tabs' });
    expect(out).toEqual({ ok: false, error: 'The browser refused the request: boom' });
  });
});

describe('refused requests', () => {
  const refused: [string, unknown][] = [
    ['an empty string', ''],
    ['only spaces', '   '],
    ['plain http', `http://chatgpt.com/c/${ID1}`],
    ['another site', `https://example.com/c/${ID1}`],
    ['a lookalike host', `https://chatgpt.com.evil.example/c/${ID1}`],
    ['a host with a port', `https://chatgpt.com:8443/c/${ID1}`],
    ['a javascript url', 'javascript:alert(1)'],
    ['a file url', 'file:///etc/passwd'],
    ['a data url', 'data:text/html,hello'],
    ['not a web address', 'hello world'],
    ['a missing url', undefined],
    ['a number', 42],
    ['an object', { href: U1 }],
  ];
  for (const [name, url] of refused) {
    it(`refuses ${name} with a plain error and touches no tab`, async () => {
      const { browser, focus } = setup();
      browser.addWindow(true);
      const out = await focus(url);
      expect(out.ok).toBe(false);
      const error = out.ok ? '' : out.error;
      expect(error.length).toBeGreaterThan(5);
      expect(error).not.toContain(EM_DASH);
      expect(browser.calls).toEqual([]);
    });
  }

  it('refuses actions it does not know', async () => {
    const { browser, bridge } = setup();
    for (const action of [null, undefined, 'focus_or_open', {}, { kind: 'close_all_tabs' }]) {
      const out = await bridge.handle(action);
      expect(out).toEqual({ ok: false, error: 'This browser extension does not support that request.' });
    }
    expect(browser.calls).toEqual([]);
  });
});

describe('list_chatgpt_tabs', () => {
  it('returns BridgeTabInfo for ChatGPT tabs only, ordered by window and position', async () => {
    const { browser, bridge } = setup();
    const w1 = browser.addWindow(true);
    const w2 = browser.addWindow();
    const a = browser.addTab({ windowId: w1, url: U1, title: 'One', active: true });
    browser.addTab({ windowId: w1, url: 'https://example.com/secret', title: 'Not ChatGPT' });
    const b = browser.addTab({ windowId: w1, url: `${U2}?model=x`, title: 'Two' });
    const c = browser.addTab({ windowId: w2, url: 'https://chatgpt.com/', title: 'Home', active: true });
    browser.addTab({ windowId: w2, url: `https://chatgpt.com:8443/c/${ID1}`, title: 'Port' });

    const out = await bridge.handle({ kind: 'list_chatgpt_tabs' });

    expect(out).toEqual({
      ok: true,
      data: [
        { tabId: a, windowId: w1, url: U1, title: 'One', active: true },
        { tabId: b, windowId: w1, url: `${U2}?model=x`, title: 'Two', active: false },
        { tabId: c, windowId: w2, url: 'https://chatgpt.com/', title: 'Home', active: true },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('example.com');
  });

  it('returns an empty list when no ChatGPT tab is open', async () => {
    const { browser, bridge } = setup();
    browser.addTab({ windowId: browser.addWindow(true), url: 'https://example.com/' });
    expect(await bridge.handle({ kind: 'list_chatgpt_tabs' })).toEqual({ ok: true, data: [] });
  });
});
