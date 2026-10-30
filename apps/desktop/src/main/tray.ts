// Tray icon: a tooltip with the numbers that matter, and three menu items. Electron's Tray and Menu are injected.
import type { Counts } from '@minisumma/shared';
import type { Logger } from './log.ts';

export interface TrayLike {
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click' | 'double-click', listener: () => void): unknown;
  destroy(): void;
}

export interface TrayMenuItem {
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox';
  checked?: boolean;
  click?: () => void;
}

/** What the tray needs from the running core. */
export interface TraySource {
  counts(): Pick<Counts, 'unreadActivity' | 'actionsNeeded' | 'liveSessions'>;
  quietMode(): boolean;
  setQuietMode(enabled: boolean): void;
  /** Called whenever counts or settings may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface TrayDeps {
  createTray(): TrayLike;
  buildMenu(template: TrayMenuItem[]): unknown;
  source: TraySource;
  onOpen(): void;
  onQuit(): void;
  log: Logger;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The first icon file that loads to a non-empty image. A tray without an icon is invisible, so a file that is missing or that
 * the platform cannot decode must fall through to the next candidate instead of leaving the user with no tray at all.
 */
export function firstUsableImage<T extends { isEmpty(): boolean }>(files: readonly string[], load: (file: string) => T, exists: (file: string) => boolean): { image: T; file: string } | null {
  for (const file of files) {
    if (!exists(file)) continue;
    try {
      const image = load(file);
      if (!image.isEmpty()) return { image, file };
    } catch { /* try the next one */ }
  }
  return null;
}

/** Windows truncates tooltips at 127 characters; this stays well inside. */
export function trayTooltip(c: Pick<Counts, 'unreadActivity' | 'actionsNeeded' | 'liveSessions'>, quiet = false): string {
  const parts = [`${c.unreadActivity} unread`];
  if (c.actionsNeeded > 0) parts.push(`${c.actionsNeeded} ${c.actionsNeeded === 1 ? 'needs' : 'need'} action`);
  parts.push(plural(c.liveSessions, 'live session', 'live sessions'));
  return `Mini-Summa${quiet ? ' (quiet mode)' : ''}\n${parts.join(', ')}`;
}

export function trayMenuTemplate(opts: { quiet: boolean; onOpen(): void; onToggleQuiet(next: boolean): void; onQuit(): void }): TrayMenuItem[] {
  return [
    { label: 'Open Mini-Summa', click: opts.onOpen },
    { label: 'Quiet mode', type: 'checkbox', checked: opts.quiet, click: () => opts.onToggleQuiet(!opts.quiet) },
    { type: 'separator' },
    { label: 'Quit', click: opts.onQuit },
  ];
}

export function createAppTray(deps: TrayDeps): { refresh(): void; destroy(): void } {
  const tray = deps.createTray();
  let lastTooltip = '';
  let lastQuiet: boolean | null = null;

  const refresh = (): void => {
    try {
      const quiet = deps.source.quietMode();
      const tooltip = trayTooltip(deps.source.counts(), quiet);
      if (tooltip !== lastTooltip) { tray.setToolTip(tooltip); lastTooltip = tooltip; }
      if (quiet !== lastQuiet) {
        lastQuiet = quiet;
        tray.setContextMenu(deps.buildMenu(trayMenuTemplate({
          quiet,
          onOpen: deps.onOpen,
          onToggleQuiet: (next) => { try { deps.source.setQuietMode(next); } catch (err) { deps.log.warn('quiet mode could not be changed', { error: err }); } refresh(); },
          onQuit: deps.onQuit,
        })));
      }
    } catch (err) {
      deps.log.warn('tray refresh failed', { error: err });
    }
  };

  tray.on('click', deps.onOpen);
  tray.on('double-click', deps.onOpen);
  const unsubscribe = deps.source.subscribe(refresh);
  refresh();
  return { refresh, destroy: () => { unsubscribe(); tray.destroy(); } };
}
