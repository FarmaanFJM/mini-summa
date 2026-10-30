// Reading the arrangement of the workspace: where the two panes, the divider and the native ChatGPT view are, from the
// renderer (the DOM) and from the main process (the native view's bounds), and how they compare.
import type { Locator, Page } from 'playwright';
import type { Rect } from '@minisumma/shared';
import type { AppHandle } from './app.ts';
import { chatgptView, moveWindowTo, parkWindowAwayFromPointer } from './main-process.ts';
import { claudePane } from './terminal.ts';
import { until } from './wait.ts';

export const chatgptPane = (page: Page): Locator => page.getByRole('region', { name: 'ChatGPT', exact: true });
export const divider = (page: Page): Locator => page.getByRole('separator', { name: 'Resize the ChatGPT and Claude panes' });
/** The empty, measured body of the ChatGPT pane over which the native view is laid. */
export const chatgptSlot = (page: Page): Locator => page.getByLabel('Embedded ChatGPT view');

export async function box(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('The element has no box on screen.');
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

export interface Arrangement {
  chatgpt: Rect;
  claude: Rect;
  divider: Rect;
  dividerOrientation: string | null;
  /** The divider's own statement, percent of the space the ChatGPT pane has (aria-valuenow). */
  percent: number;
  /** The same thing measured from the panes. */
  measuredRatio: number;
  layout: 'side-by-side' | 'stacked' | 'overlapping';
}

const near = (a: number, b: number, tolerance = 1.5): boolean => Math.abs(a - b) <= tolerance;

/** Which way the panes sit, decided from where they are on screen and nothing else. */
export async function arrangement(page: Page): Promise<Arrangement> {
  const [chatgpt, claude, div] = [await box(chatgptPane(page)), await box(claudePane(page)), await box(divider(page))];
  const dividerOrientation = await divider(page).getAttribute('aria-orientation');
  const percent = Number(await divider(page).getAttribute('aria-valuenow'));
  const sideBySide = chatgpt.x + chatgpt.width <= claude.x + 1 && near(chatgpt.y, claude.y) && near(chatgpt.height, claude.height);
  const stacked = chatgpt.y + chatgpt.height <= claude.y + 1 && near(chatgpt.x, claude.x) && near(chatgpt.width, claude.width);
  const measuredRatio = sideBySide ? chatgpt.width / (chatgpt.width + claude.width) : chatgpt.height / (chatgpt.height + claude.height);
  return { chatgpt, claude, divider: div, dividerOrientation, percent, measuredRatio, layout: sideBySide ? 'side-by-side' : stacked ? 'stacked' : 'overlapping' };
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export const sameRect = (a: Rect, b: Rect, tolerance = 1.5): boolean => near(a.x, b.x, tolerance) && near(a.y, b.y, tolerance) && near(a.width, b.width, tolerance) && near(a.height, b.height, tolerance);
export const inside = (inner: Rect, outer: Rect, tolerance = 1.5): boolean =>
  inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance && inner.x + inner.width <= outer.x + outer.width + tolerance && inner.y + inner.height <= outer.y + outer.height + tolerance;

/**
 * Waits until the native ChatGPT view sits exactly where the renderer's empty slot is (the renderer measures, the main
 * process places the view), and returns both rectangles.
 */
export async function viewMatchesSlot(h: AppHandle): Promise<{ slot: Rect; native: Rect }> {
  let last = '';
  try {
    return await until('the native ChatGPT view to sit over its slot in the pane', async () => {
      const [slot, view] = [await box(chatgptSlot(h.page)), await chatgptView(h.app)];
      last = JSON.stringify({ slot, native: view?.bounds, visible: view?.visible });
      if (!view?.bounds || view.visible !== true || !sameRect(slot, view.bounds)) return null;
      return { slot, native: view.bounds };
    }, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`${(error as Error).message}; last seen ${last}`);
  }
}

/**
 * Presses the divider and drags it to a point, with mouse events moving in steps so that every move is seen. The window is
 * parked out of reach of the real pointer for the drag (see parkWindowAwayFromPointer) and put back afterwards.
 */
export async function dragDivider(h: AppHandle, to: { x: number; y: number }): Promise<void> {
  const { page } = h;
  const d = await box(divider(page));
  const from = { x: d.x + d.width / 2, y: d.y + d.height / 2 };
  const home = await parkWindowAwayFromPointer(h.app);
  try {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
  } finally {
    await moveWindowTo(h.app, home);
  }
}

/** The ratio the divider should end at for a pointer position: the same arithmetic the divider's own handler does. */
export function expectedRatio(pointer: number, containerStart: number, containerSize: number, dividerSize = 9): number {
  const usable = containerSize - dividerSize;
  const r = (pointer - containerStart - dividerSize / 2) / usable;
  return Math.min(0.85, Math.max(0.15, Math.round(r * 1000) / 1000));
}

/** The box that holds both panes and the divider (the pane area), from the outer edges of the two panes. */
export function areaOf(a: Arrangement): Rect {
  const x = Math.min(a.chatgpt.x, a.claude.x);
  const y = Math.min(a.chatgpt.y, a.claude.y);
  return { x, y, width: Math.max(a.chatgpt.x + a.chatgpt.width, a.claude.x + a.claude.width) - x, height: Math.max(a.chatgpt.y + a.chatgpt.height, a.claude.y + a.claude.height) - y };
}
