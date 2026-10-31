/*
 * Handling of the shared `bridge.request` actions (focus_or_open, list_chatgpt_tabs).
 *
 * CHROME APIS USED FOR TABS AND WINDOWS (this is the complete list; test/policy.test.ts fails if the code and this list
 * disagree, and if any other file touches chrome.tabs or chrome.windows)
 *
 *   chrome.tabs.query     find open tabs whose URL matches the ChatGPT patterns (always called with a `url` filter,
 *                         never without one)
 *   chrome.tabs.get       re-read one tab: status, final URL, title
 *   chrome.tabs.update    make an existing tab the active tab of its window (only { active: true })
 *   chrome.tabs.create    open the conversation when no tab shows it (only { url })
 *   chrome.windows.update bring that tab's window to the front (only { focused: true, drawAttention: false })
 *
 * PERMISSIONS. None of these calls needs the "tabs" permission, and the manifest does not request it. A browser shows an
 * extension the address (`url`, `pendingUrl`) and `title` of a tab only when the extension has host access to that tab's
 * site: here chatgpt.com, www.chatgpt.com, chat.openai.com and the loopback core. So this code can never see the
 * address or title of a tab on any other site; such a tab comes back without those fields. A tab that has finished
 * loading but shows no address is therefore on another site (for example a sign-in page after a redirect) and is
 * reported as not being the requested page.
 *
 * Not used, on purpose: chrome.scripting, content scripts, chrome.tabs.executeScript, chrome.webNavigation,
 * chrome.webRequest, chrome.debugger, chrome.tabs.sendMessage, chrome.tabs.captureVisibleTab, chrome.windows.create,
 * chrome.tabs.remove, chrome.tabs.reload, chrome.tabs.move, chrome.history, chrome.cookies. This code never reads page
 * content, never types, clicks or submits anything in ChatGPT. It only reads tab metadata (URL, title, status).
 *
 * Other chrome.* APIs used elsewhere in the extension (none of them touch tabs or windows):
 *   chrome.storage.local, chrome.storage.onChanged   storage.ts, background.ts, options.ts
 *   chrome.alarms.create/get/clear/onAlarm           background.ts
 *   chrome.runtime.onMessage/sendMessage/openOptionsPage/id   background.ts, options.ts
 *   chrome.action.onClicked                           background.ts
 *
 * The `chrome` object is passed in (dependency injection) so the unit tests can run against a fake.
 */
import { parseChatGptUrl, sameChatGptPage } from '@minisumma/shared';
import type { BridgeTabInfo } from '@minisumma/shared';

/** Query filters for chrome.tabs.query. www.chatgpt.com is accepted by parseChatGptUrl, so it is queried too. */
export const CHATGPT_TAB_PATTERNS: readonly string[] = [
  'https://chatgpt.com/*',
  'https://www.chatgpt.com/*',
  'https://chat.openai.com/*',
];

export const LOAD_TIMEOUT_MS = 15_000;
export const POLL_MS = 100;
/** A freshly opened tab must stay complete at the same address this long before the address is reported. */
export const SETTLE_MS = 500;

/** The part of the `chrome` namespace this module may call. Anything else is a compile error. */
export interface BridgeChrome {
  tabs: {
    query(queryInfo: { url: string[] }): Promise<chrome.tabs.Tab[]>;
    get(tabId: number): Promise<chrome.tabs.Tab>;
    update(tabId: number, updateProperties: { active: true }): Promise<chrome.tabs.Tab | undefined>;
    create(createProperties: { url: string }): Promise<chrome.tabs.Tab>;
  };
  windows: {
    update(windowId: number, updateInfo: { focused: true; drawAttention: false }): Promise<chrome.windows.Window>;
  };
}

export interface BridgeDeps {
  chrome: BridgeChrome;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  loadTimeoutMs?: number;
}

/** `data` of a successful focus_or_open. */
export interface FocusOrOpenData {
  // The agreed contract.
  mode: 'focused' | 'opened';
  tabId: number;
  windowId: number;
  /** The tab address as the browser reports it after the action. Empty when the browser did not expose one. */
  url: string;
  title: string;
  /** True only when the final tab address is the same ChatGPT page as requested. An address check, not a content check. */
  urlMatches: boolean;
  // Additive: what the browser said about the window, and a plain explanation when something is not as requested.
  /** What the browser reported for the window after the focus request. False means it was not confirmed. */
  windowFocused: boolean;
  note?: string;
  // Additive: the same facts under the names packages/core/src/http/bridge.ts reads into ChatGptOpenResult.
  /** The tab is the active tab and the browser confirmed its window is in front (same as windowFocused). */
  focused: boolean;
  /** A new tab was opened (mode is "opened"). */
  opened: boolean;
  /** The address check as a ChatGptOpenResult.verified: urlMatches, or null when the page had not finished loading. */
  verified: boolean | null;
}

export type BridgeOutcome =
  | { ok: true; data: FocusOrOpenData | BridgeTabInfo[] }
  | { ok: false; error: string };

type Tab = chrome.tabs.Tab;
type IdentifiedTab = Tab & { id: number; windowId: number; url: string };

const fail = (error: string): BridgeOutcome => ({ ok: false, error });

/**
 * When a load fails at the network, the browser still reports the requested address for the tab it replaced with its
 * own error page, and labels that tab with the site name only. The extension never reads page content, so that label
 * is the only hint it has; when it sees it, it does not claim the conversation loaded.
 */
const looksLikeErrorPage = (tab: Tab, url: string): boolean => {
  const title = (tab.title ?? '').trim().toLowerCase();
  if (title === '') return false;
  try { return title === new URL(url).hostname.toLowerCase(); } catch { return false; }
};

const OTHER_SITE_NOTE = 'The tab finished loading on another site, for example a sign-in page. The browser does not show this extension that address.';
const ERROR_PAGE_NOTE = 'The browser may be showing an error page instead of the conversation: it labelled the tab with the site name only.';
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isIdentified = (t: Tab): t is IdentifiedTab => typeof t.id === 'number' && typeof t.windowId === 'number' && typeof t.url === 'string' && t.url !== '';

/** Active tab first, then the most recently accessed, then the lowest id so the choice is deterministic. */
export function rankTabs<T extends Tab>(tabs: readonly T[]): T[] {
  return [...tabs].sort((a, b) => {
    if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
    const byAccess = (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    if (byAccess !== 0) return byAccess;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

export interface Bridge {
  /** Never rejects: every failure becomes `{ ok: false, error }` with a plain sentence. */
  handle(action: unknown): Promise<BridgeOutcome>;
}

export function createBridge(deps: BridgeDeps): Bridge {
  const { chrome } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const loadTimeoutMs = deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS;

  const queryChatGptTabs = async (): Promise<IdentifiedTab[]> => {
    const tabs = await chrome.tabs.query({ url: [...CHATGPT_TAB_PATTERNS] });
    // The match patterns ignore ports and credentials; parseChatGptUrl does not, so it has the last word.
    return tabs.filter(isIdentified).filter((t) => parseChatGptUrl(t.url).ok);
  };

  /** Ask the browser to bring the window to the front and report what it says, without claiming more. */
  const focusWindow = async (windowId: number): Promise<{ focused: boolean; problem?: string }> => {
    try {
      const win = await chrome.windows.update(windowId, { focused: true, drawAttention: false });
      return win?.focused === true ? { focused: true } : { focused: false, problem: 'The browser did not confirm that the window is in front.' };
    } catch (err) {
      return { focused: false, problem: `The browser window could not be brought to the front: ${errorText(err)}` };
    }
  };

  /**
   * Poll until the tab has been complete at one address for SETTLE_MS, or give up after the load timeout.
   * Without the "tabs" permission the browser leaves out the address of a tab on a site this extension has no host access
   * to. A tab that is complete with no visible address has therefore finished loading on another site, and counts as
   * loaded; a tab that is still loading has no address yet either, and does not.
   */
  const waitForLoad = async (tabId: number): Promise<{ tab: Tab; settled: boolean }> => {
    const deadline = now() + loadTimeoutMs;
    let stableSince: number | null = null;
    let stableUrl = '';
    for (;;) {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url ?? '';
      if (tab.status === 'complete' && url !== 'about:blank') {
        if (stableSince === null || url !== stableUrl) { stableSince = now(); stableUrl = url; }
        if (now() - stableSince >= SETTLE_MS) return { tab, settled: true };
      } else {
        stableSince = null;
      }
      const left = deadline - now();
      if (left <= 0) return { tab, settled: false };
      await sleep(Math.min(POLL_MS, left));
    }
  };

  const focusExisting = async (tab: IdentifiedTab, target: string): Promise<BridgeOutcome> => {
    try {
      await chrome.tabs.update(tab.id, { active: true });
    } catch (err) {
      return fail(`The ChatGPT tab could not be selected: ${errorText(err)}`);
    }
    const win = await focusWindow(tab.windowId);
    let fresh: Tab;
    try { fresh = await chrome.tabs.get(tab.id); } catch { fresh = tab; }
    const url = fresh.url ?? '';
    const sameUrl = sameChatGptPage(url, target);
    const errorPage = sameUrl && looksLikeErrorPage(fresh, url);
    const urlMatches = sameUrl && !errorPage;
    const note = [win.problem, !sameUrl ? 'The tab no longer shows the requested conversation.' : undefined, errorPage ? ERROR_PAGE_NOTE : undefined].filter(Boolean).join(' ') || undefined;
    return {
      ok: true,
      data: {
        mode: 'focused', tabId: tab.id, windowId: fresh.windowId ?? tab.windowId, url, title: fresh.title ?? '',
        urlMatches, windowFocused: win.focused, ...(note ? { note } : {}),
        focused: win.focused, opened: false, verified: urlMatches,
      },
    };
  };

  const openNew = async (target: string): Promise<BridgeOutcome> => {
    let created: Tab;
    try {
      created = await chrome.tabs.create({ url: target });
    } catch (err) {
      return fail(`The browser could not open a new tab: ${errorText(err)}`);
    }
    if (typeof created.id !== 'number') return fail('The browser did not return the new tab.');
    // Raise the window first so the person sees the page loading, then wait to learn where it really ended up.
    const win = typeof created.windowId === 'number' ? await focusWindow(created.windowId) : { focused: false, problem: 'The browser did not say which window holds the new tab.' };
    let loaded: { tab: Tab; settled: boolean };
    try { loaded = await waitForLoad(created.id); } catch (err) {
      return fail(`The new tab was closed before it finished loading: ${errorText(err)}`);
    }
    const url = loaded.tab.url ?? '';
    const sameUrl = loaded.settled && sameChatGptPage(url, target);
    const errorPage = sameUrl && looksLikeErrorPage(loaded.tab, url);
    const urlMatches = sameUrl && !errorPage;
    const note = [
      !loaded.settled ? `The tab was opened but did not finish loading within ${Math.round(loadTimeoutMs / 1000)} seconds.`
        : url === '' ? OTHER_SITE_NOTE
          : !sameUrl ? 'The tab finished loading at a different address, for example a sign-in page.'
            : errorPage ? ERROR_PAGE_NOTE : undefined,
      win.problem,
    ].filter(Boolean).join(' ') || undefined;
    return {
      ok: true,
      data: {
        mode: 'opened', tabId: created.id, windowId: loaded.tab.windowId ?? created.windowId ?? -1, url, title: loaded.tab.title ?? '',
        urlMatches, windowFocused: win.focused, ...(note ? { note } : {}),
        focused: win.focused, opened: true, verified: loaded.settled ? urlMatches : null,
      },
    };
  };

  const focusOrOpen = async (rawUrl: unknown): Promise<BridgeOutcome> => {
    if (typeof rawUrl !== 'string') return fail('A ChatGPT address is required.');
    const parsed = parseChatGptUrl(rawUrl);
    if (!parsed.ok) return fail(parsed.message);
    const target = parsed.info.url;
    const candidates = (await queryChatGptTabs()).filter((t) => sameChatGptPage(t.url, target));
    const best = rankTabs(candidates)[0];
    return best ? focusExisting(best, target) : openNew(target);
  };

  const listTabs = async (): Promise<BridgeOutcome> => {
    const tabs = await queryChatGptTabs();
    const infos: BridgeTabInfo[] = tabs
      .sort((a, b) => a.windowId - b.windowId || (a.index ?? 0) - (b.index ?? 0))
      .map((t) => ({ tabId: t.id, windowId: t.windowId, url: t.url, title: t.title ?? '', active: Boolean(t.active) }));
    return { ok: true, data: infos };
  };

  // One request at a time: a second focus_or_open for the same page must see the tab the first one just opened,
  // otherwise two quick requests would open two tabs.
  let queue: Promise<unknown> = Promise.resolve();
  const run = (job: () => Promise<BridgeOutcome>): Promise<BridgeOutcome> => {
    const result = queue.then(job, job);
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    handle(action: unknown): Promise<BridgeOutcome> {
      return run(async () => {
        try {
          const a = (typeof action === 'object' && action !== null ? action : {}) as { kind?: unknown; url?: unknown };
          if (a.kind === 'focus_or_open') return await focusOrOpen(a.url);
          if (a.kind === 'list_chatgpt_tabs') return await listTabs();
          return fail('This browser extension does not support that request.');
        } catch (err) {
          return fail(`The browser refused the request: ${errorText(err)}`);
        }
      });
    },
  };
}
