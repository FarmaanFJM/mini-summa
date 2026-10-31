// A12-A14: the two panes (ChatGPT beside or above Claude), the native ChatGPT view that is laid over the ChatGPT pane, and the
// divider between them. The window is resized from the main process, the way a user drags its edge; the arrangement is read
// from the renderer's DOM and from the native view's bounds in the main process, and the two must agree.
import { expect } from 'vitest';
import type { AppHandle } from '../helpers/app.ts';
import { launchApp } from '../helpers/app.ts';
import { createProject, startSession } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { areaOf, arrangement, box, chatgptSlot, divider, dragDivider, expectedRatio, inside, overlaps, viewMatchesSlot } from '../helpers/layout.ts';
import { chatgptView, setWindowSize, windowInfo } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { claudePane, screenSize, waitForScreen } from '../helpers/terminal.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { until, untilEqual } from '../helpers/wait.ts';

const LANDSCAPE = { width: 1400, height: 850 };
const PORTRAIT = { width: 1000, height: 1300 };

/** An app with a project that has a conversation and a running session, so both panes have something real in them. */
async function workspace(size: { width: number; height: number }, restartOf?: AppHandle): Promise<AppHandle> {
  const h = await launchApp(restartOf ? { sandbox: restartOf.sandbox, standIn: restartOf.standIn, size } : { size });
  if (!restartOf) {
    const { project } = await createProject(h, 'Layouts', { conversations: [conversationUrl(uuidOf('a'))] });
    await startSession(h, project.id);
  }
  await h.page.getByRole('heading', { level: 1, name: 'Layouts' }).waitFor();
  await until('the conversation to be on screen in the embedded view', async () => (await chatgptView(h.app))?.url === conversationUrl(uuidOf('a')));
  // After a restart the terminal is gone with the old process (the session is resumable); the layout is what is looked at.
  if (!restartOf) await waitForScreen(h.page, 'for shortcuts');
  return h;
}

const layoutSettings = async (h: AppHandle) => (await h.api.call('settings.get')).layout;

scenario('[A13] Landscape layout works', async () => {
  const h = await workspace(LANDSCAPE);
  const info = await windowInfo(h.app);
  expect(info.contentSize).toEqual([LANDSCAPE.width, LANDSCAPE.height]);

  const a = await arrangement(h.page);
  expect(a.layout).toBe('side-by-side');
  expect(a.dividerOrientation).toBe('vertical'); // a vertical line between panes that sit side by side
  expect(a.chatgpt.x).toBeLessThan(a.claude.x);   // ChatGPT on the left, Claude on the right
  expect(a.percent).toBe(50);
  expect(Math.abs(a.measuredRatio - 0.5)).toBeLessThan(0.01);
  expect(a.chatgpt.width).toBeGreaterThan(250);
  expect(a.claude.width).toBeGreaterThan(250);

  // The native view lies exactly over the pane's slot in the window, inside the ChatGPT pane, and never over Claude.
  const { slot, native } = await viewMatchesSlot(h);
  expect(inside(native, a.chatgpt)).toBe(true);
  expect(overlaps(native, a.claude)).toBe(false);
  expect(inside(native, { x: 0, y: 0, width: LANDSCAPE.width, height: LANDSCAPE.height })).toBe(true);

  // The terminal fits its pane.
  const term = await box(h.page.locator('.ms-term__slot .xterm-screen'));
  expect(inside(term, a.claude)).toBe(true);
  const size = await screenSize(h.page);
  evidence('A13', `window ${LANDSCAPE.width}x${LANDSCAPE.height}: ChatGPT pane left (${Math.round(a.chatgpt.width)}px wide), Claude pane right (${Math.round(a.claude.width)}px), vertical divider at ${a.percent}%; the native ChatGPT view at ${native.x},${native.y} ${native.width}x${native.height} equals its slot (${Math.round(slot.width)}x${Math.round(slot.height)}) and stays out of the Claude pane; terminal ${size ? `${size.cols}x${size.rows}` : 'fitted'} inside its pane`);
});

scenario('[A12] Portrait layout works', async () => {
  const h = await workspace(PORTRAIT);
  const info = await windowInfo(h.app);
  expect(info.contentSize).toEqual([PORTRAIT.width, PORTRAIT.height]);

  const a = await arrangement(h.page);
  expect(a.layout).toBe('stacked');
  expect(a.dividerOrientation).toBe('horizontal'); // a horizontal line between panes that sit one above the other
  expect(a.chatgpt.y).toBeLessThan(a.claude.y);     // ChatGPT on top, Claude below
  expect(a.percent).toBe(50);
  expect(Math.abs(a.measuredRatio - 0.5)).toBeLessThan(0.01);
  expect(a.chatgpt.height).toBeGreaterThan(250);
  expect(a.claude.height).toBeGreaterThan(250);

  const { slot, native } = await viewMatchesSlot(h);
  expect(inside(native, a.chatgpt)).toBe(true);
  expect(overlaps(native, a.claude)).toBe(false);
  expect(inside(native, { x: 0, y: 0, width: PORTRAIT.width, height: PORTRAIT.height })).toBe(true);
  expect(native.width).toBeGreaterThan(slot.width - 2);

  // The arrangement follows the window both ways: tall -> wide -> tall again, and the view follows each time.
  await setWindowSize(h.app, LANDSCAPE.width, LANDSCAPE.height);
  await untilEqual('the panes to sit side by side in a wide window', async () => (await arrangement(h.page)).layout, 'side-by-side');
  const wide = await viewMatchesSlot(h);
  await setWindowSize(h.app, PORTRAIT.width, PORTRAIT.height);
  await untilEqual('the panes to stack again in a tall window', async () => (await arrangement(h.page)).layout, 'stacked');
  await viewMatchesSlot(h);

  // A person's choice beats the shape of the window: "Side by side" in a tall window, then back to Automatic.
  await h.page.getByRole('button', { name: /^Layout: / }).click();
  await h.page.getByRole('menuitemradio', { name: 'Side by side' }).click();
  await untilEqual('the panes to sit side by side by choice', async () => (await arrangement(h.page)).layout, 'side-by-side');
  await viewMatchesSlot(h);
  await untilEqual('the choice to be saved by the core', async () => (await layoutSettings(h)).orientation, 'landscape');
  await h.page.getByRole('button', { name: /^Layout: / }).click();
  await h.page.getByRole('menuitemradio', { name: 'Automatic' }).click();
  await untilEqual('the panes to stack again on Automatic', async () => (await arrangement(h.page)).layout, 'stacked');
  await untilEqual('Automatic to be saved by the core', async () => (await layoutSettings(h)).orientation, 'auto');
  evidence('A12', `window ${PORTRAIT.width}x${PORTRAIT.height}: ChatGPT pane on top (${Math.round(a.chatgpt.height)}px tall), Claude below (${Math.round(a.claude.height)}px), horizontal divider at ${a.percent}%; the native view (${native.width}x${native.height}) equals its slot and stays out of the Claude pane; resizing to ${LANDSCAPE.width}x${LANDSCAPE.height} (view ${wide.native.width}x${wide.native.height}) and back re-arranged the panes and the view each time; "Side by side" chosen by hand beat the window shape and was saved`);
});

scenario('[A14] Pane resizing works (draggable divider; proportions persist)', async () => {
  const first = await workspace(LANDSCAPE);

  // --- side by side: drag the vertical divider to about 30 %
  const before = await arrangement(first.page);
  const area = areaOf(before);
  const y = before.divider.y + before.divider.height / 2;
  const target = area.x + area.width * 0.3;
  await dragDivider(first, { x: target, y });
  const wanted = expectedRatio(target, area.x, area.width);
  const afterDrag = await until('the divider to show the dragged proportion', async () => {
    const a = await arrangement(first.page);
    return Math.abs(a.percent - Math.round(wanted * 100)) <= 1 ? a : null;
  });
  expect(afterDrag.layout).toBe('side-by-side');
  expect(Math.abs(afterDrag.measuredRatio - wanted)).toBeLessThan(0.01); // the panes really are that wide
  expect(afterDrag.chatgpt.width).toBeLessThan(before.chatgpt.width);
  await viewMatchesSlot(first);                                         // and the native view followed the divider
  const viewAfterDrag = await chatgptView(first.app);
  expect(viewAfterDrag?.visible).toBe(true);                             // hidden while dragging, back when released

  // The proportion is saved by the core for this orientation only.
  await until('the core to hold the landscape proportion', async () => Math.abs((await layoutSettings(first)).landscapeRatio - wanted) < 0.006);
  const savedLandscape = (await layoutSettings(first)).landscapeRatio;
  expect((await layoutSettings(first)).portraitRatio).toBe(0.5);

  // Dragging past the edge stops at the limit, not beyond it.
  await dragDivider(first, { x: area.x + area.width - 2, y });
  await untilEqual('the divider to stop at 85 percent', async () => (await arrangement(first.page)).percent, 85);
  await dragDivider(first, { x: area.x + area.width * 0.3, y });
  await until('the divider to come back to the proportion', async () => Math.abs((await arrangement(first.page)).percent - Math.round(wanted * 100)) <= 1);
  await until('the core to hold the landscape proportion again', async () => Math.abs((await layoutSettings(first)).landscapeRatio - wanted) < 0.006);

  // --- stacked: drag the horizontal divider to about 65 %
  await setWindowSize(first.app, PORTRAIT.width, PORTRAIT.height);
  await untilEqual('the panes to stack', async () => (await arrangement(first.page)).layout, 'stacked');
  const tall = await arrangement(first.page);
  const tallArea = areaOf(tall);
  const x = tall.divider.x + tall.divider.width / 2;
  const tallTarget = tallArea.y + tallArea.height * 0.65;
  await dragDivider(first, { x, y: tallTarget });
  const wantedTall = expectedRatio(tallTarget, tallArea.y, tallArea.height);
  await until('the stacked divider to show the dragged proportion', async () => Math.abs((await arrangement(first.page)).percent - Math.round(wantedTall * 100)) <= 1);
  const stackedAfter = await arrangement(first.page);
  expect(Math.abs(stackedAfter.measuredRatio - wantedTall)).toBeLessThan(0.01);
  await viewMatchesSlot(first);
  await until('the core to hold the portrait proportion', async () => Math.abs((await layoutSettings(first)).portraitRatio - wantedTall) < 0.006);
  expect(Math.abs((await layoutSettings(first)).landscapeRatio - wanted)).toBeLessThan(0.006); // the other orientation is untouched
  const saved = await layoutSettings(first);

  // --- restart: the same data directory, the same proportions, in both orientations
  const window1 = await windowInfo(first.app);
  const quit = await first.quit();
  expect(quit.code).toBe(0);
  const second = await workspace({ width: PORTRAIT.width, height: PORTRAIT.height }, first);
  expect((await layoutSettings(second)).landscapeRatio).toBe(saved.landscapeRatio);
  expect((await layoutSettings(second)).portraitRatio).toBe(saved.portraitRatio);
  const restoredTall = await arrangement(second.page);
  expect(restoredTall.layout).toBe('stacked');
  expect(Math.abs(restoredTall.measuredRatio - saved.portraitRatio)).toBeLessThan(0.01);
  await setWindowSize(second.app, LANDSCAPE.width, LANDSCAPE.height);
  await untilEqual('the panes to sit side by side after the restart', async () => (await arrangement(second.page)).layout, 'side-by-side');
  const restoredWide = await arrangement(second.page);
  expect(Math.abs(restoredWide.measuredRatio - saved.landscapeRatio)).toBeLessThan(0.01);
  expect(restoredWide.percent).toBe(Math.round(saved.landscapeRatio * 100));
  await viewMatchesSlot(second);
  expect(await divider(second.page).getAttribute('aria-valuenow')).toBe(String(Math.round(saved.landscapeRatio * 100)));
  void window1;
  void chatgptSlot;
  evidence('A14', `dragging the vertical divider to 30% of the area gave ${afterDrag.percent}% (panes ${Math.round(afterDrag.chatgpt.width)}px / ${Math.round(afterDrag.claude.width)}px), the native view followed and was visible again after release; past the edge it stopped at 85%; the horizontal divider dragged to 65% gave ${stackedAfter.percent}%; the core stored landscape ${saved.landscapeRatio} and portrait ${saved.portraitRatio} independently, and after quitting and relaunching on the same data directory both were restored (${restoredTall.percent}% stacked, ${restoredWide.percent}% side by side)`);
});
