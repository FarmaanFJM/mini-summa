// How large the embedded ChatGPT page is drawn inside its pane: the browser zoom factor of the view, decided from the person's
// choice (Settings, ChatGPT) and the width of the pane. A pure function, no Electron; chatgptView.ts applies the result.
//
// WHY THIS EXISTS. This is a HYPOTHESIS, not a finding: nobody has reproduced the overlap against the real site.
// The report was that ChatGPT's floating controls (navigation and overflow buttons) sit on top of the conversation, over the
// writing blocks, when ChatGPT is shown inside Mini-Summa. ChatGPT lays itself out by the width it is given in CSS pixels,
// and OpenAI documents nothing about where its layout changes. The embedded view is exactly as wide as its pane, in device
// independent pixels (DIP), and at zoom 1 one DIP is one CSS pixel. In a split workspace on a 1280 to 1440 pixel wide window, or on a
// laptop at 125 to 150 percent display scaling (1920 physical pixels at 150 percent are 1280 DIP), the pane is only about 500 to 650 DIP
// wide. A responsive site is likely to switch to its compact layout at about that width, and a compact layout is where floating
// buttons can end up on top of the content. That is the most likely cause, not a confirmed one.
//
// WHAT IT DOES ABOUT IT, and what it does not. It gives the page more CSS pixels of width by zooming the view out, which is what
// Ctrl and minus does in any browser. It adds no CSS and no script, reads no DOM and relies on no selector of the site, so nothing
// here breaks when ChatGPT changes its markup, and no control is hidden. If the hypothesis is wrong the setting is harmless: choose 100 percent.
import type { Settings } from '@minisumma/shared';

export type PageScale = Settings['chatgpt']['pageScale'];

export const PAGE_SCALES: readonly PageScale[] = ['auto', '100', '90', '80', '70'];

export const isPageScale = (value: unknown): value is PageScale => typeof value === 'string' && (PAGE_SCALES as readonly string[]).includes(value);

/**
 * The page width, in CSS pixels, that Automatic tries to give ChatGPT when the pane is narrower than this.
 *
 * A JUDGEMENT, not a measurement of ChatGPT. It is a round number clearly above the 500 to 650 pixel panes described above and
 * below a full-width window; nobody has measured where ChatGPT's own layout changes. If the manual check in docs/CHATGPT_PANE.md finds a
 * better figure, this is the one number to change (and the test that pins it).
 */
export const AUTO_TARGET_CSS_WIDTH = 900;

/**
 * The smallest zoom Automatic will use. Also a JUDGEMENT: much below 70 percent text gets hard to read at ordinary display sizes,
 * and a pane that narrow is better helped by giving it more room (showing ChatGPT alone, say) than by shrinking the page further.
 */
export const AUTO_MIN_ZOOM = 0.7;

const FIXED_ZOOM: Readonly<Record<string, number>> = { '100': 1, '90': 0.9, '80': 0.8, '70': 0.7 };

/**
 * The zoom factor for the view.
 *
 * `paneWidthDip` is the width the native view really has, in DIP (what bounds.ts produced), or null when it is not known. It is
 * deliberately NOT the width in the renderer's CSS pixels: the renderer's own zoom factor already went into that conversion, and the
 * page inside the view is laid out in its own CSS pixels, which are DIP divided by the factor returned here.
 *
 *  * 100, 90, 80, 70: exactly 1, 0.9, 0.8, 0.7, whatever the pane.
 *  * auto: 1 for a pane of AUTO_TARGET_CSS_WIDTH DIP or more, and also when the width is not known. A narrower pane is zoomed out
 *    just enough for the page to get that width (pane / target), never below AUTO_MIN_ZOOM. The factor is rounded DOWN to a whole
 *    percent, so the page gets at least the target when the floor does not bind, and a drag of the divider changes the zoom in
 *    steps of one percent, not on every pixel.
 */
export function chooseZoomFactor(scale: PageScale, paneWidthDip: number | null): number {
  const fixed = FIXED_ZOOM[scale];
  if (fixed !== undefined) return fixed;
  if (paneWidthDip === null || !Number.isFinite(paneWidthDip) || paneWidthDip <= 0) return 1;
  if (paneWidthDip >= AUTO_TARGET_CSS_WIDTH) return 1;
  // Whole percent from integers, so that 630 / 900 is exactly 70 and not 69.99999999999999.
  const percent = Math.floor((paneWidthDip * 100) / AUTO_TARGET_CSS_WIDTH);
  return Math.min(1, Math.max(AUTO_MIN_ZOOM, percent / 100));
}

/** Two zoom factors are the same for the purpose of "do I need to set it again". */
export const sameZoom = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;
