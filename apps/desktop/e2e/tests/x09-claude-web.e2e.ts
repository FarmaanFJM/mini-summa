// X09: Claude Code on the web (claude.ai/code) is shown in a native view of its own, and Mini-Summa does nothing in the page.
//
// This is a browser based integration, not session control. The renderer's Cloud tab does not exist yet while this is written, so the
// test plays the renderer: it calls window.miniSumma.claudeWeb through the REAL preload and IPC, which is exactly what the tab will call.
// Everything it asserts is read from the other side: the main process (which web contents exists, where it sits, what it shows, which
// profile it uses, what the default browser was asked to open) and the claude.ai stand-in (which requests arrived, with which headers).
//
// What this proves: the view is created on demand, shows the address it was given and no more, makes one GET and nothing else, is hidden and
// shown without losing the page, follows the navigation policy for links, windows and sign-in, reports a signed-out visitor, refuses
// addresses that are not claude.ai/code, and keeps its cookies apart from the ChatGPT view's. What it cannot prove: how the real
// claude.ai behaves (its markup, its sign-in, whether it accepts an embedded browser). A page that is a stand-in answers to the test.
//
// The test also plays the PAGE in places (a script that sets location or opens a window, the way a link on the real site would). That is
// the stand-in page's behaviour, not Mini-Summa's: the product itself never runs a script in either embedded page.
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { claudeCodeUrl } from '@minisumma/shared';
import type { ClaudeWebViewState, NativeApi, Rect } from '@minisumma/shared';
import { launchApp } from '../helpers/app.ts';
import type { AppHandle } from '../helpers/app.ts';
import { evidence } from '../helpers/evidence.ts';
import { chatgptView, claudeWebView, inEmbeddedPage, openExternalCalls, profileCookies, setProfileCookie, setWindowSize, spyOnOpenExternal, typeIntoComposer, windowCounts } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { openNewProject } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const REPO = 'acme/webapp';
const NEW_SESSION = claudeCodeUrl({ repo: REPO });
const SESSION_ID = 'session_abc123'; // made up; the stand-in serves any /code/session_<letters and digits>
const SESSION = `https://claude.ai/code/${SESSION_ID}`;
const LOGIN = 'https://claude.ai/login';
const RECT: Rect = { x: 320, y: 60, width: 640, height: 520 };
const RECT_MOVED: Rect = { x: 300, y: 80, width: 700, height: 560 };
const CHATGPT_RECT: Rect = { x: 20, y: 80, width: 260, height: 560 };

type ClaudeApi = NonNullable<NativeApi['claudeWeb']>;

/** Calls window.miniSumma.claudeWeb in the real window: through the real preload, the real IPC check and the real main process. */
const claude = <K extends keyof ClaudeApi>(h: AppHandle, method: K, ...args: Parameters<ClaudeApi[K]>): Promise<Awaited<ReturnType<ClaudeApi[K]>>> =>
  h.page.evaluate(([name, params]) => (window.miniSumma!.claudeWeb as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...params), [method, args] as [string, unknown[]]) as never;

const chatgpt = (h: AppHandle, method: 'navigate' | 'setBounds' | 'setOverlayActive', arg: unknown): Promise<void> =>
  h.page.evaluate(([name, value]) => (window.miniSumma!.chatgpt as unknown as Record<string, (a: unknown) => Promise<void>>)[name as string](value), [method, arg] as [string, unknown]);

/** The state events the window heard, in order. */
const recordStates = (h: AppHandle): Promise<void> => h.page.evaluate(() => {
  const w = window as unknown as { __claudeStates: unknown[] };
  w.__claudeStates = [];
  window.miniSumma!.claudeWeb!.onState((state) => { w.__claudeStates.push(state); });
});
const statesHeard = (h: AppHandle): Promise<ClaudeWebViewState[]> => h.page.evaluate(() => (window as unknown as { __claudeStates: ClaudeWebViewState[] }).__claudeStates.slice());
const statuses = (states: ClaudeWebViewState[]): string[] => states.map((s) => s.status).filter((status, i, all) => i === 0 || status !== all[i - 1]);

/** The stand-in's log since `mark`, as "METHOD host/path?query". */
const heard = (h: AppHandle, mark: number): string[] => h.standIn.since(mark).map((r) => `${r.method} ${r.host}${r.path}${r.search}`);

const inClaude = <T = unknown>(h: AppHandle, code: string): Promise<T | undefined> => inEmbeddedPage<T>(h.app, 'persist:claude', code);

/** Waits for the Claude view to be on `url` and finished loading, and returns what the main process sees of it. */
const claudeShows = (h: AppHandle, url: string) => until(`the Claude view to show ${url}`, async () => {
  const view = await claudeWebView(h.app);
  return view && view.url === url && !view.loading ? view : null;
});

/** How many times the main process says it created the Claude view. Anything other than one would mean something destroyed it. */
const claudeViewCreations = (h: AppHandle): number => {
  try {
    return fs.readFileSync(path.join(h.sandbox.data, 'electron-profile', 'logs', 'main.log'), 'utf8').split('\n').filter((line) => line.includes('claude web view created')).length;
  } catch { return 0; }
};

/** A negative check needs a moment to be meaningful: if something else were going to be requested, it would have been by now. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

interface PageFacts { events: string[]; repositories: string; prompt: string; path: string }
const PAGE_FACTS = `({ events: window.__standin.events.slice(), repositories: document.getElementById('repositories').textContent, prompt: document.getElementById('prefilled-prompt').textContent, path: document.getElementById('path').textContent })`;

scenario('[X09] Claude Code on the web opens in a view of its own on demand: one GET of the address given, nothing typed or clicked, hidden and shown without losing the page', async () => {
  const h = await launchApp({ size: { width: 1280, height: 800 } });
  await recordStates(h);

  // Nothing exists until a page is asked for. A rectangle alone creates nothing (it would be a blank view over the renderer's pane).
  expect(await claudeWebView(h.app)).toBeNull();
  expect(await claude(h, 'getState')).toEqual({ status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null });
  await claude(h, 'setBounds', RECT);
  expect(await claudeWebView(h.app)).toBeNull();
  expect(h.standIn.claudeSince(0)).toEqual([]);

  // The new session page with the repository preselected, as claudeCodeUrl builds it.
  const mark = h.standIn.mark();
  await claude(h, 'navigate', NEW_SESSION);
  const view = await claudeShows(h, NEW_SESSION);
  expect(view.title).toBe('Stand-in Claude Code');
  expect(view.visible).toBe(true);
  expect(view.bounds).toEqual(RECT);
  await quiet();

  // One GET for the address, with its query, and nothing else of Mini-Summa's making.
  expect(heard(h, mark)).toEqual(['GET claude.ai/code?repositories=acme/webapp']);
  expect(h.standIn.since(mark).filter((r) => r.method !== 'GET')).toEqual([]);
  expect(h.standIn.strays()).toEqual([]);
  expect(h.standIn.submissions()).toEqual([]);
  // The page shows what the address carried, and recorded no input, key, paste, submit or click: nothing was typed or pressed for the person.
  expect(await inClaude<PageFacts>(h, PAGE_FACTS)).toEqual({ events: [], repositories: REPO, prompt: '', path: '/code' });
  // A fresh profile sends no cookie, and the browser's own identity is untouched: the web contents has no user agent set on it.
  const request = h.standIn.since(mark)[0];
  expect(request.headers.cookie).toBeUndefined();
  const profileAgent = await h.app.evaluate(({ session }) => session.fromPartition('persist:claude').getUserAgent());
  expect(view.userAgent).toBe(profileAgent);
  expect(request.headers['user-agent']).toBe(profileAgent);

  // The state went from loading to ready, with the title, and only changes were pushed.
  const first = await statesHeard(h);
  expect(statuses(first)).toEqual(['loading', 'ready']);
  expect(first.at(-1)).toEqual({ status: 'ready', url: NEW_SESSION, title: 'Stand-in Claude Code', canGoBack: false, canGoForward: false, note: null, httpStatus: 200 });
  for (let i = 1; i < first.length; i += 1) expect(first[i]).not.toEqual(first[i - 1]);
  expect(await claude(h, 'getState')).toEqual(first.at(-1));

  // Hiding keeps the page: the same web contents, the same address, the same document (a marker set in it is still there), no new request.
  const marker = await inClaude<string>(h, `window.__marker = 'kept-' + Math.random().toString(36).slice(2)`);
  expect(marker).toMatch(/^kept-/);
  await claude(h, 'setBounds', null);
  const hidden = await claudeWebView(h.app);
  expect(hidden).toMatchObject({ id: view.id, url: NEW_SESSION, visible: false });
  await claude(h, 'setBounds', RECT_MOVED);
  const shown = await claudeWebView(h.app);
  expect(shown).toMatchObject({ id: view.id, url: NEW_SESSION, visible: true, bounds: RECT_MOVED });
  expect(await inClaude<string>(h, 'window.__marker')).toBe(marker);
  expect(heard(h, mark)).toEqual(['GET claude.ai/code?repositories=acme/webapp']);
  expect(statuses(await statesHeard(h))).toEqual(['loading', 'ready']);

  // Asking again for the page that is already shown does nothing; a different page is a second GET in the same view.
  await claude(h, 'navigate', NEW_SESSION);
  await quiet();
  expect(heard(h, mark)).toHaveLength(1);
  await claude(h, 'navigate', SESSION);
  const second = await claudeShows(h, SESSION);
  expect(second.id).toBe(view.id);
  expect(second.title).toBe(`Stand-in Claude Code session ${SESSION_ID}`);
  expect(heard(h, mark)).toEqual(['GET claude.ai/code?repositories=acme/webapp', `GET claude.ai/code/${SESSION_ID}`]);
  await until('the history to allow going back', async () => (await claude(h, 'getState')).canGoBack);

  // Back, forward and reload go to the same view.
  await claude(h, 'back');
  await claudeShows(h, NEW_SESSION);
  await until('forward to be possible', async () => (await claude(h, 'getState')).canGoForward);
  await claude(h, 'forward');
  await claudeShows(h, SESSION);
  const beforeReload = h.standIn.mark();
  await claude(h, 'reload');
  await until('the reload to reach the stand-in', () => heard(h, beforeReload).includes(`GET claude.ai/code/${SESSION_ID}`));
  await claudeShows(h, SESSION);
  await claude(h, 'focus'); // resolves; whether the X server gives the window the keyboard is not something this test can promise
  expect((await claudeWebView(h.app))?.id).toBe(view.id);

  // The page is a page: no Node, no preload, no Mini-Summa API, and the other native view was never created by any of this.
  expect(await inClaude(h, `({ api: typeof window.miniSumma, require: typeof require, process: typeof process, electron: typeof electron })`)).toEqual({ api: 'undefined', require: 'undefined', process: 'undefined', electron: 'undefined' });
  expect(await chatgptView(h.app)).toBeNull();
  expect(await windowCounts(h.app)).toMatchObject({ windows: 1 });

  evidence('X09', `before any navigate no Claude view existed, and a rectangle alone created none; navigate(${NEW_SESSION}) created one in the persist:claude profile at ${RECT.width}x${RECT.height}, the stand-in received exactly one request (GET /code?repositories=acme/webapp, no cookie, the profile's own user agent), the page recorded no input, key, paste, submit or click, and the state went loading then ready with the page title; hiding (null rectangle) and showing again kept the same web contents, address and document and made no request; asking again for the shown page made none; a second page, back, forward and reload stayed in the same view; the page had no Node, preload or Mini-Summa API`);
});

scenario('[X09] Links and windows opened by the Claude page: other sites go to the default browser, refused addresses go nowhere, Claude and sign-in pages stay in the view; one overlay switch covers both native views', async () => {
  const h = await launchApp({ size: { width: 1280, height: 800 } });
  await spyOnOpenExternal(h.app);
  await recordStates(h);
  await claude(h, 'setBounds', RECT);
  await claude(h, 'navigate', NEW_SESSION);
  const view = await claudeShows(h, NEW_SESSION);
  const mark = h.standIn.mark();
  const counts = await windowCounts(h.app);
  const stays = async (): Promise<void> => {
    await quiet();
    expect((await claudeWebView(h.app))).toMatchObject({ id: view.id, url: NEW_SESSION });
    expect(await windowCounts(h.app)).toEqual(counts);
    expect(heard(h, mark)).toEqual([]);
  };

  // Another website: the page sets location, or opens a window. Neither is loaded here; both go to the default browser, once each.
  await inClaude(h, `location.href = 'https://example.org/docs?x=1'`);
  await until('the link to be handed to the default browser', async () => (await openExternalCalls(h.app)).includes('https://example.org/docs?x=1'));
  await inClaude(h, `window.open('https://example.org/popup', '_blank'); 1`);
  await until('the new window to be handed to the default browser', async () => (await openExternalCalls(h.app)).includes('https://example.org/popup'));
  await stays();
  expect(await openExternalCalls(h.app)).toEqual(['https://example.org/docs?x=1', 'https://example.org/popup']);

  // Addresses that are refused: nothing is opened anywhere and the page stays. (Plain http, a file, a mail link, an app protocol.)
  for (const code of [
    `location.href = 'mailto:someone@example.org'`,
    `location.href = 'ms-settings:privacy'`,
    `window.open('http://claude.ai/code'); 1`,
    `window.open('http://example.org/'); 1`,
    `window.open('file:///etc/passwd'); 1`,
    `window.open('about:blank'); 1`,
  ]) await inClaude(h, code);
  await stays();
  expect(await openExternalCalls(h.app)).toEqual(['https://example.org/docs?x=1', 'https://example.org/popup']);

  // A window the page asks for on a Claude address is shown in THIS view, never in a window of its own.
  await inClaude(h, `window.open('${SESSION}', '_blank'); 1`);
  const moved = await claudeShows(h, SESSION);
  expect(moved.id).toBe(view.id);
  expect(await windowCounts(h.app)).toEqual(counts);
  await until('the stand-in to have served the session page', () => heard(h, mark).includes(`GET claude.ai/code/${SESSION_ID}`));
  expect(heard(h, mark)).toEqual([`GET claude.ai/code/${SESSION_ID}`]);
  expect(await openExternalCalls(h.app)).toHaveLength(2);
  await until('the history to allow going back', async () => (await claude(h, 'getState')).canGoBack);

  // The overlay switch of the ChatGPT surface covers both native views, and puts back only the ones that were showing.
  const conv = conversationUrl(uuidOf('b'));
  await chatgpt(h, 'navigate', conv);
  await chatgpt(h, 'setBounds', CHATGPT_RECT);
  await until('the ChatGPT view to be on screen', async () => { const v = await chatgptView(h.app); return v?.url === conv && v.visible === true; });
  const visibility = async (): Promise<{ chatgpt: boolean | null; claude: boolean | null }> => ({ chatgpt: (await chatgptView(h.app))?.visible ?? null, claude: (await claudeWebView(h.app))?.visible ?? null });
  expect(await visibility()).toEqual({ chatgpt: true, claude: true });
  await chatgpt(h, 'setOverlayActive', true);
  expect(await visibility()).toEqual({ chatgpt: false, claude: false });
  await chatgpt(h, 'setOverlayActive', false);
  expect(await visibility()).toEqual({ chatgpt: true, claude: true });
  // Claude not on screen (null rectangle): the overlay going away does not bring it back.
  await claude(h, 'setBounds', null);
  expect(await visibility()).toEqual({ chatgpt: true, claude: false });
  await chatgpt(h, 'setOverlayActive', true);
  await chatgpt(h, 'setOverlayActive', false);
  expect(await visibility()).toEqual({ chatgpt: true, claude: false });
  // ChatGPT not on screen, Claude on screen: the same the other way round.
  await chatgpt(h, 'setBounds', null);
  await claude(h, 'setBounds', RECT);
  await chatgpt(h, 'setOverlayActive', true);
  expect(await visibility()).toEqual({ chatgpt: false, claude: false });
  await chatgpt(h, 'setOverlayActive', false);
  expect(await visibility()).toEqual({ chatgpt: false, claude: true });
  // A rectangle that arrives while a dialog is open shows its view only when the dialog closes.
  await chatgpt(h, 'setOverlayActive', true);
  await chatgpt(h, 'setBounds', CHATGPT_RECT);
  expect(await visibility()).toEqual({ chatgpt: false, claude: false });
  await chatgpt(h, 'setOverlayActive', false);
  expect(await visibility()).toEqual({ chatgpt: true, claude: true });
  await claude(h, 'setBounds', null);
  await chatgpt(h, 'setBounds', null);

  expect(h.standIn.strays()).toEqual([]);
  evidence('X09', `from the Claude page: location set to and window.open of another site were handed to shell.openExternal exactly once each and never loaded (the view, the window count and the stand-in log did not change); mailto:, ms-settings:, plain http, file: and about:blank went nowhere; window.open of a session address (claude.ai/code followed by the session id) loaded in the same view and made no window; one setOverlayActive switch hid and restored the ChatGPT and Claude views together and never showed a view whose rectangle was null`);
});

scenario('[X09] A signed-out visitor is reported as login_required, addresses that are not claude.ai/code are refused, and the Claude and ChatGPT views keep separate profiles', async () => {
  const h = await launchApp({ size: { width: 1280, height: 800 } });
  await recordStates(h);
  await claude(h, 'setBounds', RECT);

  // Signed out: claude.ai sends the visit to its sign-in page; the state says so in words and the page is left alone.
  h.standIn.claudeSignedIn(false);
  const mark = h.standIn.mark();
  await claude(h, 'navigate', NEW_SESSION);
  await until('login_required', async () => (await claude(h, 'getState')).status === 'login_required');
  await claudeShows(h, LOGIN);
  const signedOut = await claude(h, 'getState');
  expect(signedOut).toMatchObject({ status: 'login_required', url: LOGIN, title: 'Stand-in sign in' });
  expect(signedOut.note).toMatch(/sign-in page/);
  expect(signedOut.note).toMatch(/guess/);
  expect(signedOut.note).not.toContain(String.fromCharCode(0x2014));
  expect(heard(h, mark)).toEqual(['GET claude.ai/code?repositories=acme/webapp', 'GET claude.ai/login']);
  expect(await inClaude(h, 'window.__standin.events.slice()')).toEqual([]);
  expect(statuses(await statesHeard(h))).toEqual(['loading', 'login_required']);

  // Signed in again: the same address works, and the state leaves login_required.
  h.standIn.claudeSignedIn(true);
  await claude(h, 'navigate', NEW_SESSION);
  await claudeShows(h, NEW_SESSION);
  expect(await claude(h, 'getState')).toMatchObject({ status: 'ready', url: NEW_SESSION, note: null });

  // Addresses the view may not be given are refused with a reason; nothing is loaded and the page is the one it was.
  const afterRefusals = h.standIn.mark();
  for (const bad of [
    'https://example.org/', 'https://claude.ai.example.org/code', 'http://claude.ai/code', 'claude.ai/code', 'javascript:alert(1)', 'file:///etc/passwd',
    'https://claude.ai/chat/abc', 'https://claude.ai/login', 'https://chatgpt.com/', 'https://user:pw@claude.ai/code', 'https://claude.ai/code x', '',
  ]) {
    await expect(claude(h, 'navigate', bad), bad).rejects.toThrow(/Invalid Claude Code address/);
  }
  await expect(claude(h, 'navigate', 5 as unknown as string)).rejects.toThrow(/Invalid Claude Code address/);
  await expect(claude(h, 'setBounds', { x: 'a', y: 0, width: 1, height: 1 } as unknown as Rect)).rejects.toThrow(/Invalid bounds/);
  await expect(h.page.evaluate(() => window.miniSumma!.chatgpt.setOverlayActive('yes' as unknown as boolean))).rejects.toThrow(/Invalid overlay flag/);
  await quiet();
  expect(heard(h, afterRefusals)).toEqual([]);
  expect((await claudeWebView(h.app))?.url).toBe(NEW_SESSION);

  // The browser's permissions: nothing but a clipboard write. The page asks the browser what it would be given.
  const permissions = await inClaude<Record<string, string>>(h, `(async () => {
    const ask = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (error) { return 'unknown: ' + error.message; } };
    return { geolocation: await ask('geolocation'), notifications: await ask('notifications'), camera: await ask('camera'), microphone: await ask('microphone'), clipboardRead: await ask('clipboard-read'), clipboardWrite: await ask('clipboard-write') };
  })()`);
  expect(permissions).toMatchObject({ geolocation: 'denied', notifications: 'denied', camera: 'denied', microphone: 'denied', clipboardRead: 'denied', clipboardWrite: 'granted' });

  // Separate profiles. Both browser profiles get a cookie for each host, with a different value; each view must send only its own.
  const claudeJar = { url: 'https://claude.ai/', name: 'jar', value: 'claude-profile' };
  const chatgptJar = { url: 'https://chatgpt.com/', name: 'jar', value: 'chatgpt-profile' };
  await setProfileCookie(h.app, 'persist:claude', claudeJar);
  await setProfileCookie(h.app, 'persist:chatgpt', { ...claudeJar, value: 'chatgpt-profile' });
  await setProfileCookie(h.app, 'persist:chatgpt', chatgptJar);
  await setProfileCookie(h.app, 'persist:claude', { ...chatgptJar, value: 'claude-profile' });
  expect((await profileCookies(h.app, 'persist:claude', 'https://claude.ai/')).map((c) => c.value)).toEqual(['claude-profile']);
  expect((await profileCookies(h.app, 'persist:chatgpt', 'https://claude.ai/')).map((c) => c.value)).toEqual(['chatgpt-profile']);
  expect((await profileCookies(h.app, 'persist:chatgpt', 'https://chatgpt.com/')).map((c) => c.value)).toEqual(['chatgpt-profile']);
  expect((await profileCookies(h.app, 'persist:claude', 'https://chatgpt.com/')).map((c) => c.value)).toEqual(['claude-profile']);

  const cookieMark = h.standIn.mark();
  await claude(h, 'navigate', 'https://claude.ai/code/new');
  await claudeShows(h, 'https://claude.ai/code/new');
  const conv = conversationUrl(uuidOf('c'));
  await chatgpt(h, 'navigate', conv);
  await until('the ChatGPT view to show its page', async () => { const v = await chatgptView(h.app); return v?.url === conv && !v.loading; });
  const sent = h.standIn.since(cookieMark);
  expect(sent.find((r) => r.host === 'claude.ai')?.headers.cookie).toBe('jar=claude-profile');
  expect(sent.find((r) => r.host === 'chatgpt.com')?.headers.cookie).toBe('jar=chatgpt-profile');

  // Two web contents, two profiles, and the main window's own profile is a third.
  const [claudeView, chatGptView] = [await claudeWebView(h.app), await chatgptView(h.app)];
  expect(claudeView && chatGptView && claudeView.id !== chatGptView.id).toBe(true);
  const profiles = await h.app.evaluate(({ session, webContents }) => {
    const claudeSession = session.fromPartition('persist:claude');
    const chatgptSession = session.fromPartition('persist:chatgpt');
    const owners = (wanted: unknown): number => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.session === wanted).length;
    return { distinct: claudeSession !== chatgptSession && claudeSession !== session.defaultSession, claudeOwners: owners(claudeSession), chatgptOwners: owners(chatgptSession) };
  });
  expect(profiles).toEqual({ distinct: true, claudeOwners: 1, chatgptOwners: 1 });

  expect(h.standIn.strays()).toEqual([]);
  expect(h.standIn.submissions()).toEqual([]);
  evidence('X09', `signed out, claude.ai/code redirected to /login and the state was login_required with a note that calls itself a guess (GET /code?repositories=acme/webapp then GET /login, nothing typed); signed in again it was ready; 13 addresses that are not https claude.ai/code (other sites, http, no scheme, javascript:, file:, another part of claude.ai, credentials, a space, empty, a number) were rejected with "Invalid Claude Code address" and reached neither the view nor the stand-in; bad bounds and a bad overlay flag were rejected; the page was denied geolocation, notifications, camera, microphone and clipboard-read and granted clipboard-write; with a cookie for each host in each profile, each view sent only its own (jar=claude-profile, jar=chatgpt-profile) and the two profiles are different sessions`);
});

scenario('[X09] The Claude page, its web contents and a half written draft survive hiding, moving, resizing the window, the overlay switch and a dialog of the window', async () => {
  const h = await launchApp({ size: { width: 1280, height: 800 } });
  await claude(h, 'setBounds', RECT);
  const mark = h.standIn.mark();
  await claude(h, 'navigate', NEW_SESSION);
  const first = await claudeShows(h, NEW_SESSION);
  const counts = await windowCounts(h.app);
  expect(claudeViewCreations(h)).toBe(1);

  // The person writes a prompt on the page and leaves it unsent. The marker is a property of this very document: a reload would lose it.
  const draft = 'Fix the login bug, then add a test';
  await typeIntoComposer(h.app, 'persist:claude', draft);
  const marker = await inClaude<string>(h, `window.__marker = 'doc-' + Math.random().toString(36).slice(2)`);
  expect(marker).toMatch(/^doc-/);

  /** The same web contents, the same document, the same draft, no new request, no new view, no new window, no extra state: nothing replaced the page. */
  const untouched = async (what: string, written = draft): Promise<void> => {
    const view = await claudeWebView(h.app);
    expect(view, what).toMatchObject({ id: first.id, url: NEW_SESSION });
    expect(await inClaude(h, `({ draft: document.getElementById('composer').value, marker: window.__marker })`), what).toEqual({ draft: written, marker });
    expect(heard(h, mark), what).toEqual(['GET claude.ai/code?repositories=acme/webapp']);
    expect(claudeViewCreations(h), what).toBe(1);
    expect(await windowCounts(h.app), what).toEqual(counts);
    expect(await statesHeard(h), what).toEqual([]); // recording started after the page was ready: any state change since would be a reload
  };
  await recordStates(h);
  await untouched('after typing the draft');

  // Hide and show: what leaving the workspace and coming back does.
  await claude(h, 'setBounds', null);
  expect((await claudeWebView(h.app))?.visible).toBe(false);
  await untouched('while hidden');
  await claude(h, 'setBounds', RECT);
  expect((await claudeWebView(h.app))?.visible).toBe(true);
  await untouched('after showing again');

  // Move and resize the pane: a divider drag, a pane maximized and restored.
  for (const rect of [{ x: 0, y: 60, width: 1200, height: 700 }, { x: 700, y: 60, width: 300, height: 400 }, RECT_MOVED]) {
    await claude(h, 'setBounds', rect);
    expect((await claudeWebView(h.app))?.bounds).toEqual(rect);
    await untouched(`after moving the pane to ${JSON.stringify(rect)}`);
  }

  // Resize the window itself, as dragging its edge or maximizing would: the view follows, clamped into the content area, and the page is not replaced.
  for (const size of [{ width: 960, height: 600 }, { width: 1000, height: 1300 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    const info = await setWindowSize(h.app, size.width, size.height);
    const [contentWidth, contentHeight] = info.contentSize;
    await until(`the view to follow a ${size.width}x${size.height} window`, async () => {
      const bounds = (await claudeWebView(h.app))?.bounds;
      return !!bounds && bounds.x + bounds.width <= contentWidth && bounds.y + bounds.height <= contentHeight && bounds.width === Math.min(RECT_MOVED.width, contentWidth - RECT_MOVED.x);
    });
    expect((await claudeWebView(h.app))?.visible).toBe(true);
    await untouched(`after resizing the window to ${size.width}x${size.height}`);
  }

  // The overlay switch (a menu, a toast): hidden while it is on, back after, the page not touched.
  await chatgpt(h, 'setOverlayActive', true);
  expect((await claudeWebView(h.app))?.visible).toBe(false);
  await untouched('while the overlay switch is on');
  await chatgpt(h, 'setOverlayActive', false);
  expect((await claudeWebView(h.app))?.visible).toBe(true);
  await untouched('after the overlay switch is off');

  // A real dialog of the window: its own overlay request reaches the Claude view, which is hidden under it and comes back when it closes.
  const dialog = await openNewProject(h.page);
  await until('the Claude view to be hidden under the dialog', async () => (await claudeWebView(h.app))?.visible === false);
  await untouched('while a dialog of the window is open');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  await until('the Claude view to come back when the dialog is closed', async () => (await claudeWebView(h.app))?.visible === true);
  await untouched('after the dialog is closed');

  // And the page still works: the person carries on writing, and the recorder heard only that typing (no click, submit or paste by anything else).
  await typeIntoComposer(h.app, 'persist:claude', ' and explain it');
  await untouched('after typing more', `${draft} and explain it`);
  const events = await inClaude<string[]>(h, 'window.__standin.events.slice()');
  expect([...new Set(events)]).toEqual(['input']);
  expect(h.standIn.strays()).toEqual([]);
  expect(h.standIn.submissions()).toEqual([]);

  evidence('X09', `after the person typed a draft into the Claude page, the same web contents (id ${first.id}), the same document (a marker set in it) and the same draft were still there, with no second request, no second "view created" line in the main log, no new window and no state change, after: hiding and showing, three rectangles, four window sizes (960x600 to 1000x1300, the view clamped into the content area), the overlay switch, and a real New project dialog (its overlay request hid the view and closing the dialog brought it back); the person could then carry on typing, and the page recorded only that typing`);
});

scenario('[X09] The sign-in of each site stays in its own profile across a quit and a start, and only the Claude view sends the Claude cookie', async () => {
  const h = await launchApp({ size: { width: 1280, height: 800 } });
  // A cookie with an expiry is what a "stay signed in" cookie is; one without goes with the process by design, and is not what is tested.
  const inAYear = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  await setProfileCookie(h.app, 'persist:claude', { url: 'https://claude.ai/', name: 'kept', value: 'claude-login', expirationDate: inAYear });
  await setProfileCookie(h.app, 'persist:chatgpt', { url: 'https://chatgpt.com/', name: 'kept', value: 'chatgpt-login', expirationDate: inAYear });
  expect((await profileCookies(h.app, 'persist:claude', 'https://claude.ai/')).map((c) => c.value)).toEqual(['claude-login']);

  // Quit the way a person does (the quit flow flushes the cookies of both profiles), then start again on the same data directory.
  const quit = await h.quit();
  expect(quit.code).toBe(0);
  const second = await launchApp({ sandbox: h.sandbox, standIn: h.standIn, size: { width: 1280, height: 800 } });
  expect((await profileCookies(second.app, 'persist:claude', 'https://claude.ai/')).map((c) => `${c.name}=${c.value}`)).toEqual(['kept=claude-login']);
  expect((await profileCookies(second.app, 'persist:chatgpt', 'https://chatgpt.com/')).map((c) => `${c.name}=${c.value}`)).toEqual(['kept=chatgpt-login']);
  // Neither profile holds the other's cookie.
  expect(await profileCookies(second.app, 'persist:claude', 'https://chatgpt.com/')).toEqual([]);
  expect(await profileCookies(second.app, 'persist:chatgpt', 'https://claude.ai/')).toEqual([]);

  // The Claude view is not created by starting the app, and when it loads a page it sends the cookie of its own profile and nothing else.
  expect(await claudeWebView(second.app)).toBeNull();
  await claude(second, 'setBounds', RECT);
  const mark = second.standIn.mark();
  await claude(second, 'navigate', NEW_SESSION);
  await claudeShows(second, NEW_SESSION);
  const request = second.standIn.since(mark)[0];
  expect(request.headers.cookie).toBe('kept=claude-login');
  expect(second.standIn.strays()).toEqual([]);

  evidence('X09', `a cookie with an expiry in each profile (persist:claude for claude.ai, persist:chatgpt for chatgpt.com) was still there after a quit through the app's own quit flow and a start on the same data directory, each profile held only its own, the Claude view did not exist until a page was asked for, and its first request carried exactly the cookie of its own profile`);
});
