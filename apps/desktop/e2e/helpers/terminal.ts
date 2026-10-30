// Terminals, from three independent points of view:
//
//   * the person's: keystrokes into the xterm in the Claude pane (Playwright keyboard events on the real terminal input);
//   * the screen's: the text the xterm shows (its DOM renderer; the WebGL renderer is blocklisted under Xvfb, and a helper
//     below says so if that ever changes);
//   * the core's: a second client of the core's terminal stream, which sees exactly what the PTY printed.
//
// The stream client attaches at the terminal's CURRENT size, because attaching resizes the PTY to the size it names.
import type { Locator, Page } from 'playwright';
import type { SessionKey, SessionView } from '@minisumma/shared';
import type { AppHandle } from './app.ts';
import { sleep, until } from './wait.ts';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?<=>]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\u001b[=>78]/g;

/** What a terminal would show, roughly: escape sequences removed, carriage returns folded. Good enough to look for text in. */
export const plain = (raw: string): string => raw.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export interface StreamObserver {
  readonly key: SessionKey;
  /** The size the terminal had when this observer attached. */
  readonly size: { cols: number; rows: number };
  raw(): string;
  text(): string;
  /** Resolves with the plain text once it matches. */
  waitFor(pattern: RegExp | string, options?: { timeout?: number }): Promise<string>;
  /** Types into the session through the core's stream, as a second keyboard. Used for set-up, not for the behaviour under test. */
  type(text: string, options?: { submit?: boolean; paste?: boolean }): Promise<void>;
  exited(): { code: number | null; signal: number | null } | null;
  detach(): void;
}

const observers = new WeakMap<AppHandle, Map<SessionKey, StreamObserver>>();

export async function observe(handle: AppHandle, key: SessionKey): Promise<StreamObserver> {
  const cache = observers.get(handle) ?? new Map<SessionKey, StreamObserver>();
  observers.set(handle, cache);
  const known = cache.get(key);
  if (known) return known;

  const view: SessionView = await handle.api.call('sessions.get', { params: { key } });
  if (!view.terminal) throw new Error(`Session ${key} has no terminal to observe.`);
  const size = { cols: view.terminal.cols, rows: view.terminal.rows };
  let raw = '';
  let attached = false;
  let exit: { code: number | null; signal: number | null } | null = null;
  const stream = handle.api.terminal.attach(key, size, {
    onAttached: ({ replay }) => { raw = replay; attached = true; },
    onData: (data) => { raw += data; },
    onExit: (info) => { exit = { code: info.code, signal: info.signal }; },
    onError: (code, message) => { raw += `\n[terminal error ${code}: ${message}]\n`; },
  });
  await until(`the terminal stream of ${key} to attach`, () => attached, { timeout: 15_000 });

  const observer: StreamObserver = {
    key, size,
    raw: () => raw,
    text: () => plain(raw),
    async waitFor(pattern, options = {}) {
      const test = (text: string): boolean => (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text));
      await until(`terminal output matching ${String(pattern)} (stream of ${key}); last 400 characters: ${JSON.stringify(plain(raw).slice(-400))}`, () => test(plain(raw)), { timeout: options.timeout ?? 20_000 });
      return plain(raw);
    },
    async type(text, options = {}) {
      const body = options.paste ? `\u001b[200~${text}\u001b[201~` : text;
      if (!stream.input(body)) throw new Error('The terminal stream did not accept input.');
      if (options.submit !== false) { await sleep(80); stream.input('\r'); }
    },
    exited: () => exit,
    detach: () => { try { stream.detach(); } catch { /* closed */ } cache.delete(key); },
  };
  cache.set(key, observer);
  return observer;
}

// ---------------------------------------------------------------------------------------------------------------
// The person's keyboard and the screen

/** The Claude pane of the window. */
export const claudePane = (page: Page): Locator => page.getByRole('region', { name: 'Claude' });

/** The terminal's keyboard input (xterm's hidden textarea, which has the accessible name "Terminal input"). */
export const terminalInput = (page: Page): Locator => claudePane(page).getByRole('textbox', { name: 'Terminal input' });

/** Focuses the visible terminal and types like a person: key events, not text injection. */
export async function typeLikeAPerson(page: Page, text: string, options: { enter?: boolean } = {}): Promise<void> {
  const input = terminalInput(page);
  await input.focus();
  await page.keyboard.type(text);
  if (options.enter !== false) await page.keyboard.press('Enter');
}

/** The rows of the terminal on screen, top to bottom, with trailing blanks removed. */
export async function screenRows(page: Page): Promise<string[]> {
  const rows = await page.$$eval('.ms-term__slot .xterm-rows > div', (nodes) => nodes.map((n) => n.textContent ?? ''));
  return rows.map((r) => r.replace(/\s+$/, ''));
}

/** Everything the screen shows of the terminal, one row per line. */
export async function screenText(page: Page): Promise<string> {
  return (await screenRows(page)).join('\n');
}

/** Waits until the terminal on screen shows the text. Soft-wrapped rows are also tried joined, so long text can be looked for whole. */
export async function waitForScreen(page: Page, pattern: RegExp | string, options: { timeout?: number } = {}): Promise<string> {
  let last = '';
  const matches = (text: string): boolean => (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text));
  try {
    await until(`the terminal on screen to show ${String(pattern)}`, async () => {
      last = await screenText(page);
      return matches(last) || matches(last.replace(/\n/g, ''));
    }, { timeout: options.timeout ?? 20_000 });
  } catch (error) {
    throw new Error(`${(error as Error).message}\nScreen:\n${last}`);
  }
  return last;
}

/** Whether the visible terminal is drawn with the DOM renderer, whose text can be read. (With WebGL it is a canvas.) */
export async function screenIsReadable(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelectorAll('.ms-term__slot .xterm-rows').length > 0 && document.querySelectorAll('.ms-term__slot .xterm canvas').length === 0);
}

/** How many columns and rows the terminal on screen has, from the DOM: rows are elements, columns are measured from one row. */
export async function screenSize(page: Page): Promise<{ rows: number; cols: number } | null> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('.ms-term__slot .xterm-rows > div');
    const probe = document.querySelector('.ms-term__slot .xterm-char-measure-element') as HTMLElement | null;
    const screen = document.querySelector('.ms-term__slot .xterm-screen') as HTMLElement | null;
    if (rows.length === 0 || !probe || !screen) return null;
    const cell = probe.getBoundingClientRect().width / Math.max(1, probe.textContent?.length ?? 1);
    return { rows: rows.length, cols: Math.round(screen.getBoundingClientRect().width / cell) };
  });
}
