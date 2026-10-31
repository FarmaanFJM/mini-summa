// The xterm.js implementation of TerminalAdapter. Everything visual (palette, font, metrics) comes from the --term-*
// tokens in mini-summa-tokens.css, read once when a terminal is created, so there is one place to tune readability.
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalAdapter, TerminalAdapterFactory } from './terminals';

export interface XtermOptions {
  /** GPU renderer. Falls back to the DOM renderer when WebGL is missing or the context is lost. */
  webgl: boolean;
  /** Opens a link the person clicked. Only web addresses reach it. */
  openLink: (url: string) => void;
  /** Copies the selection (Ctrl+C with a selection, Ctrl+Shift+C). */
  copyText: (text: string) => void;
  /** The PTY behind the terminals is Windows ConPTY: tells xterm how to reflow wrapped lines. */
  conpty: boolean;
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/** Palette and metrics from the --term-* tokens (with fallbacks so a missing stylesheet still gives a readable terminal). */
export function readTerminalLook(root: Element = document.documentElement): { theme: ITheme; fontFamily: string; fontSize: number; lineHeight: number } {
  const css = getComputedStyle(root);
  const t = (name: string, fallback: string) => token(css, `--term-${name}`, fallback);
  const theme: ITheme = {
    background: t('bg', '#0c0d0e'),
    foreground: t('fg', '#dde0e3'),
    cursor: t('cursor', '#eceeef'),
    cursorAccent: t('cursor-accent', '#0c0d0e'),
    selectionBackground: t('selection', 'rgba(141, 146, 152, 0.34)'),
    scrollbarSliderBackground: t('scrollbar', 'rgba(141, 146, 152, 0.28)'),
    scrollbarSliderHoverBackground: t('scrollbar-hover', 'rgba(141, 146, 152, 0.45)'),
    scrollbarSliderActiveBackground: t('scrollbar-hover', 'rgba(141, 146, 152, 0.45)'),
    black: t('black', '#22262a'),
    red: t('red', '#e2706f'),
    green: t('green', '#5fba8d'),
    yellow: t('yellow', '#d7b567'),
    blue: t('blue', '#6aa0e8'),
    magenta: t('magenta', '#b890e0'),
    cyan: t('cyan', '#55bfcb'),
    white: t('white', '#c3c8cd'),
    brightBlack: t('bright-black', '#7a828a'),
    brightRed: t('bright-red', '#f0888a'),
    brightGreen: t('bright-green', '#7dd0a6'),
    brightYellow: t('bright-yellow', '#e9c985'),
    brightBlue: t('bright-blue', '#8ab8f2'),
    brightMagenta: t('bright-magenta', '#cfaaf0'),
    brightCyan: t('bright-cyan', '#79d4de'),
    brightWhite: t('bright-white', '#f4f6f7'),
  };
  return {
    theme,
    fontFamily: token(css, '--term-font', 'Consolas, monospace'),
    fontSize: Number(token(css, '--term-font-size', '13')) || 13,
    lineHeight: Number(token(css, '--term-line-height', '1.22')) || 1.22,
  };
}

class XtermAdapter implements TerminalAdapter {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private webgl: WebglAddon | null = null;

  constructor(private readonly options: XtermOptions) {
    const look = readTerminalLook();
    this.term = new Terminal({
      allowProposedApi: true, // the unicode addon needs it
      theme: look.theme,
      fontFamily: look.fontFamily,
      fontSize: look.fontSize,
      lineHeight: look.lineHeight,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      scrollback: 10_000,
      // Programs choose colours for their own (usually black) background; this keeps any of them readable on ours.
      minimumContrastRatio: 4.5,
      macOptionIsMeta: true,
      smoothScrollDuration: 0,
      windowsPty: options.conpty ? { backend: 'conpty' } : undefined,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      if (/^https?:\/\//i.test(uri)) options.openLink(uri);
    }));
    // Ctrl+C copies only when something is selected; otherwise it must reach Claude as an interrupt.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'c') return true;
      if (!e.shiftKey && !this.term.hasSelection()) return true;
      const text = this.term.getSelection();
      if (text) { options.copyText(text); this.term.clearSelection(); }
      return false;
    });
  }

  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }

  open(host: HTMLElement): void {
    this.term.open(host);
    if (this.options.webgl) this.enableWebgl();
  }

  private enableWebgl(): void {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => { addon.dispose(); this.webgl = null; });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.webgl = null; // no WebGL here: the DOM renderer is fine
    }
  }

  write(data: string): void { this.term.write(data); }
  reset(): void { this.term.reset(); }
  resize(cols: number, rows: number): void { this.term.resize(cols, rows); }

  proposeSize(): { cols: number; rows: number } | null {
    try {
      const dims = this.fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return null;
      return { cols: dims.cols, rows: dims.rows };
    } catch {
      return null;
    }
  }

  focus(): void { this.term.focus(); }
  blur(): void { this.term.blur(); }

  refresh(): void {
    this.webgl?.clearTextureAtlas();
    if (this.term.rows > 0) this.term.refresh(0, this.term.rows - 1);
  }

  onData(listener: (data: string) => void): () => void {
    const data = this.term.onData(listener);
    return () => data.dispose();
  }

  setReadOnly(readOnly: boolean): void {
    this.term.options.disableStdin = readOnly;
    this.term.options.cursorBlink = !readOnly;
  }

  dispose(): void { this.term.dispose(); }
}

export function createXtermAdapterFactory(options: XtermOptions): TerminalAdapterFactory {
  return () => new XtermAdapter(options);
}
