// X08: the ChatGPT page follows its pane, and the pane's page is never replaced by a change of layout.
//
// The report behind it: ChatGPT's floating navigation and overflow controls overlap the writing blocks when ChatGPT is shown inside
// Mini-Summa. The cause is a HYPOTHESIS that nobody could check against the real site (it needs a login and cannot be reached from
// where this was built): ChatGPT lays itself out by the width it is given in CSS pixels, a split pane on a 1280 to 1440 pixel window
// is only about 500 to 650 of them, and a responsive site tends to switch to its compact layout there. The mitigation gives the page
// more CSS pixels by zooming the view out (Settings, ChatGPT, page size: Automatic keeps about 900, never below 70 percent), without
// touching the page. What this file can show is the mechanism, in the real window, against a stand-in page that reports its own
// window.innerWidth the way a responsive site sees its width. It shows nothing about ChatGPT's own breakpoints, and the overlap
// itself was NOT reproduced.
//
// Nothing here types into, clicks in or scripts the page on behalf of Mini-Summa: the product only sets the view's zoom. The test
// plays the person (types a draft, clicks Copy, selects a word, scrolls) and plays the Settings control (the same route it calls).
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import type { ElectronApplication, Page } from 'playwright';
import type { Rect } from '@minisumma/shared';
import { launchApp } from '../helpers/app.ts';
import type { AppHandle } from '../helpers/app.ts';
import { createProject } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { arrangement, viewMatchesSlot } from '../helpers/layout.ts';
import { readClipboard, setWindowSize, writeClipboard } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationPath, conversationUrl, STANDIN_MARKDOWN, uuidOf } from '../helpers/standin.ts';
import { openNewProject, openSettings, showWorkspace } from '../helpers/ui.ts';
import { until, untilEqual } from '../helpers/wait.ts';

const A = uuidOf('a');

/** What Automatic promises, restated here on purpose and not imported: if the judgement in pageScale.ts changes, this test must be told. */
const TARGET_CSS_WIDTH = 900;
const FLOOR_ZOOM = 0.7;

type PageScale = 'auto' | '100' | '90' | '80' | '70';

// ---------------------------------------------------------------------------------------------------------------
// The two places that know how this test drives the window. When the workspace layout control changes (Split, ChatGPT, Claude
// instead of Maximize and Restore buttons in the pane headers), only showPanes needs to learn it.

type Panes = 'both' | 'chatgpt' | 'claude';

async function showPanes(page: Page, panes: Panes): Promise<void> {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const press = async (name: string): Promise<void> => { await button(name).click(); };
  // Whatever is maximized now is restored first, so every call starts from both panes.
  if (await button('Restore ChatGPT pane').isVisible()) await press('Restore ChatGPT pane');
  if (await button('Restore Claude pane').isVisible()) await press('Restore Claude pane');
  if (panes === 'chatgpt') await press('Maximize ChatGPT pane');
  if (panes === 'claude') await press('Maximize Claude pane');
}

/** Changes the page size setting the way the Settings control does: through the core's settings route; the main process hears it on the event bus. */
const choosePageScale = async (h: AppHandle, scale: PageScale): Promise<void> => { await h.api.call('settings.update', { body: { chatgpt: { pageScale: scale } } }); };

// ---------------------------------------------------------------------------------------------------------------
// Reading the page and the view from the main process. The product never does this; the test is allowed to look.

interface PageFacts {
  /** webContents id of the embedded view: the same number means the same view. */
  id: number;
  /** How many web contents the ChatGPT session has: one, always. */
  views: number;
  /** The view's own browser zoom. */
  zoom: number;
  bounds: Rect | null;
  visible: boolean | null;
  /** The page's own id, new for every document: the same value means the page was not reloaded. */
  instance: string;
  /** window.innerWidth as the stand-in page reports it: its CSS pixels. */
  innerWidth: number;
  composer: string;
  scrollY: number;
  selection: string;
  copy: { ok: boolean; error?: string } | null;
}
type PlacedFacts = PageFacts & { bounds: Rect };

const pageFacts = (app: ElectronApplication): Promise<PageFacts | null> => app.evaluate(async ({ BrowserWindow, session, webContents }) => {
  const partition = session.fromPartition('persist:chatgpt');
  const all = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.session === partition);
  const contents = all[0];
  if (!contents) return null;
  const win = BrowserWindow.getAllWindows()[0];
  const view = win.contentView.children.find((c) => (c as unknown as { webContents?: unknown }).webContents === contents);
  try {
    const page = await contents.executeJavaScript(
      '({ instance: window.__standinPage.instance, innerWidth: window.innerWidth, composer: document.getElementById("composer").value, scrollY: window.scrollY, selection: String(window.getSelection()), copy: window.__standinPage.copy })',
      true,
    ) as Pick<PageFacts, 'instance' | 'innerWidth' | 'composer' | 'scrollY' | 'selection' | 'copy'>;
    return { id: contents.id, views: all.length, zoom: contents.getZoomFactor(), bounds: view ? view.getBounds() : null, visible: view ? view.getVisible() : null, ...page };
  } catch { return null; }
});

/** Runs a short expression in the stand-in page, as a person's devtools console would. */
const inPage = <T>(app: ElectronApplication, expression: string): Promise<T> => app.evaluate(({ session, webContents }, code) => {
  const partition = session.fromPartition('persist:chatgpt');
  const contents = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === partition);
  if (!contents) throw new Error('There is no ChatGPT view.');
  return contents.executeJavaScript(code, true);
}, expression) as Promise<T>;

/** The person types into the page's text area: it is focused, then the text goes in through Chromium's own input path. */
const typeIntoPage = (app: ElectronApplication, text: string): Promise<void> => app.evaluate(async ({ session, webContents }, value) => {
  const partition = session.fromPartition('persist:chatgpt');
  const contents = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === partition);
  if (!contents) throw new Error('There is no ChatGPT view.');
  await contents.executeJavaScript('document.getElementById("composer").focus()', true);
  contents.insertText(value);
}, text);

interface MouseStep { type: 'mouseDown' | 'mouseUp' | 'mouseWheel'; x: number; y: number; clickCount?: number; deltaY?: number }

/** The person's mouse: real input events into the view, at points in the view's own device independent pixels. */
const mouse = (app: ElectronApplication, steps: MouseStep[]): Promise<void> => app.evaluate(({ session, webContents }, list) => {
  const partition = session.fromPartition('persist:chatgpt');
  const contents = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === partition);
  if (!contents) throw new Error('There is no ChatGPT view.');
  contents.focus();
  for (const step of list) {
    if (step.type === 'mouseWheel') contents.sendInputEvent({ type: 'mouseWheel', x: step.x, y: step.y, deltaX: 0, deltaY: step.deltaY ?? 0, canScroll: true });
    else contents.sendInputEvent({ type: step.type, x: step.x, y: step.y, button: 'left', clickCount: step.clickCount ?? 1 });
  }
}, steps);

const mainLog = (h: AppHandle): string => {
  try { return fs.readFileSync(path.join(h.sandbox.data, 'electron-profile', 'logs', 'main.log'), 'utf8'); } catch { return ''; }
};
const viewCreations = (h: AppHandle): number => mainLog(h).split('\n').filter((line) => line.includes('chatgpt view created')).length;
const rendererZoom = (app: ElectronApplication): Promise<number> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());

/**
 * Waits until the page has caught up with its view (its innerWidth is the view's width divided by the zoom, give or take the
 * pixel the browser rounds away) AND `accept` holds. The failure message carries the last facts.
 */
async function settled(h: AppHandle, what: string, accept: (p: PlacedFacts) => boolean = () => true): Promise<PlacedFacts> {
  let last = '';
  try {
    return await until(what, async () => {
      const p = await pageFacts(h.app);
      last = JSON.stringify(p && { zoom: p.zoom, innerWidth: p.innerWidth, bounds: p.bounds, visible: p.visible });
      if (!p || !p.bounds) return null;
      if (Math.abs(p.innerWidth - Math.floor(p.bounds.width / p.zoom)) > 1) return null;
      return accept(p as PlacedFacts) ? (p as PlacedFacts) : null;
    }, { timeout: 20_000 });
  } catch (error) {
    throw new Error(`${(error as Error).message}; last seen ${last}`);
  }
}

/** Automatic's promise, as a property of what the page itself reports: at least the narrower of 900 and what the 70 percent floor allows. */
const meetsAutomatic = (p: PlacedFacts): boolean =>
  p.zoom >= FLOOR_ZOOM - 1e-9 && p.zoom <= 1 + 1e-9 && p.innerWidth >= Math.min(TARGET_CSS_WIDTH, Math.floor(p.bounds.width / FLOOR_ZOOM)) - 1;
const isHundredPercent = (p: PlacedFacts): boolean => Math.abs(p.zoom - 1) < 1e-9 && p.innerWidth === p.bounds.width;

/** A project with one conversation, the page loaded in the embedded view, and the first facts of it. */
async function start(size: { width: number; height: number }): Promise<{ h: AppHandle; first: PlacedFacts }> {
  const h = await launchApp({ size });
  h.standIn.name(A, 'Stand-in: Scale');
  await createProject(h, 'Scale', { conversations: [conversationUrl(A)] });
  await h.page.getByRole('heading', { level: 1, name: 'Scale' }).waitFor();
  const first = await settled(h, 'the stand-in conversation to be on screen in the embedded view');
  return { h, first };
}

// ---------------------------------------------------------------------------------------------------------------

scenario('[X08] Automatic gives a narrow pane a wider page, fixed sizes apply, and a wide pane stays at 100 percent', async () => {
  const { h, first } = await start({ width: 1400, height: 850 });
  expect((await h.api.call('settings.get')).chatgpt.pageScale, 'the default is Automatic').toBe('auto');
  expect(first.views).toBe(1);

  // --- Different window sizes, split side by side or stacked: the minimum window, the owner's range, a big one, a tall one.
  const rows: string[] = [];
  const seen: { zoom: number; width: number }[] = [];
  const sizes = [
    { width: 960, height: 600 }, { width: 1280, height: 720 }, { width: 1440, height: 900 },
    { width: 1920, height: 1080 }, { width: 1000, height: 1300 },
  ];
  for (const size of sizes) {
    await setWindowSize(h.app, size.width, size.height);
    await viewMatchesSlot(h); // Mini-Summa's own geometry: the view fills its pane exactly, whatever the size
    const p = await settled(h, `Automatic to give the page its width in a ${size.width}x${size.height} window`, meetsAutomatic);
    const layout = (await arrangement(h.page)).layout;
    expect(p.visible).toBe(true);
    seen.push({ zoom: p.zoom, width: p.bounds.width });
    rows.push(`${size.width}x${size.height} ${layout}: pane ${p.bounds.width} DIP, zoom ${Math.round(p.zoom * 100)}%, page ${p.innerWidth} CSS px`);
    if (p.bounds.width >= TARGET_CSS_WIDTH) expect(isHundredPercent(p), `a ${p.bounds.width} DIP pane stays at 100 percent`).toBe(true);
  }
  // Both ends and the middle were exercised: a pane held at the floor, one zoomed part of the way, and one left alone.
  expect(seen.some((s) => Math.abs(s.zoom - FLOOR_ZOOM) < 1e-9 && s.width < 630), 'a pane narrower than the floor needs').toBe(true);
  expect(seen.some((s) => s.zoom > FLOOR_ZOOM + 0.01 && s.zoom < 0.995), 'a pane between 630 and 900 DIP gets a zoom between the floor and 100 percent').toBe(true);

  // --- Different split widths in one window: the divider's proportion, from narrow to wide.
  await setWindowSize(h.app, 1600, 900);
  const widths: number[] = [];
  for (const ratio of [0.3, 0.5, 0.7, 0.85]) {
    await h.api.call('settings.update', { body: { layout: { landscapeRatio: ratio } } });
    await untilEqual(`the divider to show ${Math.round(ratio * 100)} percent`, async () => (await arrangement(h.page)).percent, Math.round(ratio * 100));
    await viewMatchesSlot(h);
    const p = await settled(h, `Automatic to follow a divider at ${Math.round(ratio * 100)} percent`, (q) => meetsAutomatic(q) && Math.abs(q.bounds.width - (widths.at(-1) ?? -1)) > 5);
    widths.push(p.bounds.width);
    rows.push(`1600x900 divider ${Math.round(ratio * 100)}%: pane ${p.bounds.width} DIP, zoom ${Math.round(p.zoom * 100)}%, page ${p.innerWidth} CSS px`);
    if (p.bounds.width >= TARGET_CSS_WIDTH) expect(isHundredPercent(p), `a ${p.bounds.width} DIP pane stays at 100 percent`).toBe(true);
  }
  expect(widths.every((w, i) => i === 0 || w > widths[i - 1]), 'each proportion gave a wider pane than the one before').toBe(true);
  expect(widths[0]).toBeLessThan(630);
  expect(widths.at(-1)).toBeGreaterThanOrEqual(TARGET_CSS_WIDTH);

  // --- The fixed sizes apply as they are, in a narrow pane, whatever Automatic would have done.
  await h.api.call('settings.update', { body: { layout: { landscapeRatio: 0.5 } } });
  await setWindowSize(h.app, 1280, 720);
  await untilEqual('the divider to show 50 percent', async () => (await arrangement(h.page)).percent, 50);
  const narrow = await settled(h, 'Automatic in the narrow pane again', (p) => meetsAutomatic(p) && p.bounds.width < 630);
  const fixedRows: string[] = [];
  for (const [scale, factor] of [['100', 1], ['90', 0.9], ['80', 0.8], ['70', 0.7]] as const) {
    await choosePageScale(h, scale);
    const p = await settled(h, `${scale} percent to be applied`, (q) => Math.abs(q.zoom - factor) < 1e-9);
    expect(Math.abs(p.innerWidth - Math.floor(p.bounds.width / factor)), `${scale} percent: the page gets the pane's width divided by ${factor}`).toBeLessThanOrEqual(1);
    expect(p.bounds.width, 'a fixed size does not change the pane').toBe(narrow.bounds.width);
    fixedRows.push(`${scale}% gives ${p.innerWidth}`);
  }
  // A fixed size also holds in a wide pane (Automatic would leave that at 100 percent).
  await setWindowSize(h.app, 1920, 1080);
  await choosePageScale(h, '80');
  const wideFixed = await settled(h, '80 percent in a big window', (q) => Math.abs(q.zoom - 0.8) < 1e-9 && q.bounds.width > narrow.bounds.width);
  // And Automatic is a setting that can be chosen again.
  await choosePageScale(h, 'auto');
  const back = await settled(h, 'Automatic to return', (q) => meetsAutomatic(q) && Math.abs(q.zoom - 0.8) > 1e-9);
  expect((await h.api.call('settings.get')).chatgpt.pageScale).toBe('auto');

  // --- The renderer's own zoom was never touched, and the page was the same page throughout.
  expect(await rendererZoom(h.app), 'the Mini-Summa window itself is not zoomed').toBe(1);
  expect(back.instance, 'no change of size reloaded the page').toBe(first.instance);
  expect(back.id).toBe(first.id);
  expect(viewCreations(h), 'one view for the whole run').toBe(1);
  expect(h.standIn.requests.filter((r) => r.path === conversationPath(A)), 'the page was fetched once').toHaveLength(1);

  evidence('X08', `the stand-in page reported window.innerWidth through the real window. Automatic by window and pane: ${rows.join('; ')}. A pane narrower than 630 DIP was held at 70 percent, one between 630 and 900 DIP got a zoom in between, and from 900 DIP the page stayed at 100 percent with innerWidth equal to the pane. In the ${narrow.bounds.width} DIP pane the fixed sizes gave ${fixedRows.join(', ')} CSS px (100, 90, 80 and 70 percent apply exactly); 80 percent also held in a ${wideFixed.bounds.width} DIP pane; Automatic came back at ${Math.round(back.zoom * 100)} percent. The native view equalled its pane slot at every size, the Mini-Summa window itself stayed at zoom 1, the page was fetched once and never reloaded. This proves the mechanism against a stand-in page, not ChatGPT's own layout: the overlap was not reproduced`);
}, { timeout: 180_000 });

// ---------------------------------------------------------------------------------------------------------------

scenario('[X08] Changing the layout, opening Settings or a dialog and changing the page size keep the same ChatGPT page', async () => {
  const { h, first } = await start({ width: 1400, height: 850 });
  await typeIntoPage(h.app, 'a draft that must survive');
  const draft = await settled(h, 'the draft to be in the text area', (p) => p.composer === 'a draft that must survive');
  expect(viewCreations(h)).toBe(1);
  const steps: string[] = [];

  /** The same view, the same page, the same draft; the view is as visible as the step says. */
  async function expectSamePage(step: string, visible: boolean): Promise<PlacedFacts> {
    const p = await settled(h, `${step}: the view to be ${visible ? 'visible' : 'hidden'}`, (q) => q.visible === visible);
    expect(p.id, `${step}: the web contents id`).toBe(first.id);
    expect(p.instance, `${step}: the page was not reloaded`).toBe(first.instance);
    expect(p.composer, `${step}: the draft is still in the text area`).toBe('a draft that must survive');
    expect(p.views, `${step}: one web contents in the ChatGPT session`).toBe(1);
    steps.push(`${step} (${visible ? `visible ${p.bounds.width} DIP, zoom ${Math.round(p.zoom * 100)}%` : 'hidden'})`);
    return p;
  }

  const both = await expectSamePage('both panes', true);

  // ChatGPT alone, Claude alone (the ChatGPT pane is then hidden), and both again.
  await showPanes(h.page, 'chatgpt');
  const alone = await settled(h, 'ChatGPT alone to be wider than in the split', (p) => p.visible === true && p.bounds.width > both.bounds.width + 100);
  expect(alone.id).toBe(first.id);
  await expectSamePage('ChatGPT alone', true);
  await showPanes(h.page, 'claude');
  await expectSamePage('Claude alone', false);
  await showPanes(h.page, 'both');
  const returned = await expectSamePage('both panes again', true);
  expect(returned.bounds, 'the view came back where it was').toEqual(both.bounds);

  // Settings replaces the workspace: the view is hidden, not closed. The page size is changed there, with the view hidden, and applies at once.
  await openSettings(h.page);
  await expectSamePage('Settings open', false);
  await choosePageScale(h, '80');
  const whileHidden = await settled(h, '80 percent to apply to the hidden view', (p) => Math.abs(p.zoom - 0.8) < 1e-9 && p.visible === false);
  expect(whileHidden.id).toBe(first.id);
  await showWorkspace(h.page);
  await viewMatchesSlot(h);
  const afterSettings = await expectSamePage('back from Settings', true);
  expect(afterSettings.zoom, 'the size chosen while the view was hidden is in force').toBeCloseTo(0.8, 9);
  await choosePageScale(h, 'auto');
  await settled(h, 'Automatic to return', (p) => meetsAutomatic(p) && Math.abs(p.zoom - 0.8) > 1e-9);

  // A dialog covers the pane: the view hides so the dialog is not drawn under it, and returns when the dialog closes.
  const dialog = await openNewProject(h.page);
  await expectSamePage('a dialog open', false);
  await h.page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await viewMatchesSlot(h);
  await expectSamePage('dialog closed', true);

  // The window changes shape and size.
  await setWindowSize(h.app, 1000, 1300);
  await viewMatchesSlot(h);
  await expectSamePage('tall window', true);
  await setWindowSize(h.app, 1920, 1080);
  await viewMatchesSlot(h);
  const big = await expectSamePage('big window', true);
  await setWindowSize(h.app, 960, 600);
  await viewMatchesSlot(h);
  const small = await expectSamePage('smallest window', true);
  expect(small.bounds.width).toBeLessThan(big.bounds.width);

  // Nothing created a second view, nothing loaded the page again, nothing was typed or submitted by Mini-Summa.
  expect(viewCreations(h), 'the log shows one view created in the whole run').toBe(1);
  expect(h.standIn.requests.filter((r) => r.path === conversationPath(A)), 'the page was fetched once').toHaveLength(1);
  const last = await pageFacts(h.app);
  expect(last?.id).toBe(first.id);
  expect(last?.composer).toBe(draft.composer);
  evidence('X08', `a draft typed into the stand-in's text area and the page's own id (set once per document) stayed the same, and the view kept its web contents id (${first.id}) and was the only one in the ChatGPT session, through: ${steps.join('; ')}. The page size was changed in Settings while the view was hidden and was in force when the workspace returned. The log shows one "chatgpt view created" and the stand-in served the page once, so nothing recreated or reloaded it`);
}, { timeout: 180_000 });

// ---------------------------------------------------------------------------------------------------------------

scenario('[X08] While zoomed out, the page still takes clicks, text selection, scrolling and its own Copy button (the one clipboard permission)', async () => {
  const { h } = await start({ width: 1280, height: 720 });
  const p = await settled(h, 'Automatic to zoom the narrow pane', (q) => meetsAutomatic(q) && q.zoom < 0.95);
  expect(p.bounds.width).toBeLessThan(TARGET_CSS_WIDTH);

  /** Where a part of the page is, in the view's device independent pixels: its CSS position times the zoom the view has. */
  const centerOf = async (expression: string): Promise<{ x: number; y: number }> => {
    const r = await inPage<{ x: number; y: number; width: number; height: number }>(h.app, `(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const zoom = (await pageFacts(h.app))!.zoom;
    return { x: Math.round((r.x + r.width / 2) * zoom), y: Math.round((r.y + r.height / 2) * zoom) };
  };

  // The page's own Copy button, clicked with a real mouse event at its place on the zoomed page: the Markdown arrives on the clipboard.
  await writeClipboard(h.app, 'something else');
  const copy = await centerOf('document.getElementById("copy")');
  await mouse(h.app, [{ type: 'mouseDown', ...copy }, { type: 'mouseUp', ...copy }]);
  await until('the page\'s Copy button to put its Markdown on the clipboard', async () => (await readClipboard(h.app)) === STANDIN_MARKDOWN);
  expect((await pageFacts(h.app))?.copy).toEqual({ ok: true });

  // The only permission is writing: the page may not read the clipboard, whatever the gesture.
  const read = await inPage<string>(h.app, 'navigator.clipboard.readText().then((text) => "READ " + text.length, (error) => "DENIED " + error.name)');
  expect(read).toMatch(/^DENIED /);
  // ...and the other permissions the stand-in could ask for are refused as well (a sample: the camera, notifications, the location).
  const others = await inPage<string[]>(h.app, 'Promise.all([navigator.mediaDevices.getUserMedia({ video: true }).then(() => "camera granted", (e) => "camera " + e.name), Notification.requestPermission().then((r) => "notifications " + r), new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("location granted"), (e) => resolve("location denied " + e.code)))])');
  expect(others.join(' / ')).not.toMatch(/granted/);

  // A double click selects the word under it. (Where the word is, is again its CSS place times the zoom.)
  const word = await centerOf('(() => { const t = document.getElementById("sentence").firstChild; const range = document.createRange(); range.setStart(t, 0); range.setEnd(t, 9); return range; })()');
  await mouse(h.app, [
    { type: 'mouseDown', ...word, clickCount: 1 }, { type: 'mouseUp', ...word, clickCount: 1 },
    { type: 'mouseDown', ...word, clickCount: 2 }, { type: 'mouseUp', ...word, clickCount: 2 },
  ]);
  const selected = await until('the double-clicked word to be selected', async () => {
    const facts = await pageFacts(h.app);
    return facts && facts.selection.trim() === 'Selecting' ? facts : null;
  });
  expect(selected.selection.trim()).toBe('Selecting');

  // The wheel scrolls the page.
  expect(selected.scrollY).toBe(0);
  const middle = { x: Math.round(p.bounds.width / 2), y: Math.round(p.bounds.height / 2) };
  await mouse(h.app, [{ type: 'mouseWheel', ...middle, deltaY: -400 }]);
  const scrolled = await until('the page to scroll with the wheel', async () => {
    const facts = await pageFacts(h.app);
    return facts && facts.scrollY > 0 ? facts : null;
  });

  // Still the same zoom throughout: using the page did not change it.
  expect(scrolled.zoom).toBe(p.zoom);
  expect(h.standIn.submissions()).toEqual([]);
  evidence('X08', `at ${Math.round(p.zoom * 100)} percent (a ${p.bounds.width} DIP pane in Automatic, the page seeing ${p.innerWidth} CSS px) a real mouse click at the zoomed position of the page's Copy button put its Markdown (${STANDIN_MARKDOWN.length} characters) on the clipboard, a double click selected the word under it, the wheel scrolled the page by ${Math.round(scrolled.scrollY)} CSS px; reading the clipboard from the page was refused, as were camera, notifications and location. The one permission the view grants is clipboard-sanitized-write`);
}, { timeout: 150_000 });
