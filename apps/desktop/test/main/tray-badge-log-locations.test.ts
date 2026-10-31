// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { badgeBitmap, badgeDescription } from '../../src/main/badge.ts';
import { resolveLocations } from '../../src/main/locations.ts';
import { createFileLogger, redact } from '../../src/main/log.ts';
import { createAppTray, firstUsableImage, trayMenuTemplate, trayTooltip } from '../../src/main/tray.ts';
import type { TrayMenuItem } from '../../src/main/tray.ts';

const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('tray', () => {
  it('writes a tooltip with the numbers that matter and no em dash', () => {
    expect(trayTooltip({ unreadActivity: 3, actionsNeeded: 0, liveSessions: 2 })).toBe('Mini-Summa\n3 unread, 2 live sessions');
    expect(trayTooltip({ unreadActivity: 0, actionsNeeded: 1, liveSessions: 1 })).toBe('Mini-Summa\n0 unread, 1 needs action, 1 live session');
    expect(trayTooltip({ unreadActivity: 5, actionsNeeded: 2, liveSessions: 0 }, true)).toBe('Mini-Summa (quiet mode)\n5 unread, 2 need action, 0 live sessions');
    expect(trayTooltip({ unreadActivity: 99999, actionsNeeded: 99999, liveSessions: 99999 }).length).toBeLessThan(127);
  });

  it('has Open, Quiet mode (a checkbox) and Quit', () => {
    const calls: string[] = [];
    const menu = trayMenuTemplate({ quiet: true, onOpen: () => calls.push('open'), onToggleQuiet: (n) => calls.push(`quiet:${n}`), onQuit: () => calls.push('quit') });
    expect(menu.map((i) => i.label ?? i.type)).toEqual(['Open Mini-Summa', 'Quiet mode', 'separator', 'Quit']);
    expect(menu[1]).toMatchObject({ type: 'checkbox', checked: true });
    menu[0].click?.(); menu[1].click?.(); menu[3].click?.();
    expect(calls).toEqual(['open', 'quiet:false', 'quit']);
  });

  function makeTray() {
    const listeners = new Map<string, () => void>();
    const tray = {
      setToolTip: vi.fn(), setContextMenu: vi.fn(), destroy: vi.fn(),
      on: vi.fn((e: 'click' | 'double-click', l: () => void) => { listeners.set(e, l); }),
    };
    let counts = { unreadActivity: 1, actionsNeeded: 0, liveSessions: 0 };
    let quiet = false;
    let notify: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const source = {
      counts: () => counts,
      quietMode: () => quiet,
      setQuietMode: vi.fn((v: boolean) => { quiet = v; }),
      subscribe: (l: () => void) => { notify = l; return unsubscribe; },
    };
    const onOpen = vi.fn();
    const onQuit = vi.fn();
    const buildMenu = vi.fn((t: TrayMenuItem[]) => t);
    const handle = createAppTray({ createTray: () => tray, buildMenu, source, onOpen, onQuit, log: quietLog() });
    return { tray, listeners, source, handle, onOpen, onQuit, buildMenu, unsubscribe, setCounts: (c: typeof counts) => { counts = c; notify(); } };
  }

  it('shows the tooltip at once, updates it when counts change, and avoids redundant updates', () => {
    const t = makeTray();
    expect(t.tray.setToolTip).toHaveBeenLastCalledWith('Mini-Summa\n1 unread, 0 live sessions');
    t.setCounts({ unreadActivity: 1, actionsNeeded: 0, liveSessions: 0 });
    expect(t.tray.setToolTip).toHaveBeenCalledTimes(1);
    t.setCounts({ unreadActivity: 4, actionsNeeded: 1, liveSessions: 2 });
    expect(t.tray.setToolTip).toHaveBeenLastCalledWith('Mini-Summa\n4 unread, 1 needs action, 2 live sessions');
  });

  it('toggles quiet mode through the settings service and rebuilds the menu', () => {
    const t = makeTray();
    expect(t.tray.setContextMenu).toHaveBeenCalledTimes(1);
    const items = t.buildMenu.mock.calls[0][0];
    items[1].click?.();
    expect(t.source.setQuietMode).toHaveBeenCalledWith(true);
    expect(t.tray.setContextMenu).toHaveBeenCalledTimes(2);
    expect(t.buildMenu.mock.calls[1][0][1]).toMatchObject({ checked: true });
  });

  it('opens the window on click and double-click, and cleans up', () => {
    const t = makeTray();
    t.listeners.get('click')?.();
    t.listeners.get('double-click')?.();
    expect(t.onOpen).toHaveBeenCalledTimes(2);
    t.handle.destroy();
    expect(t.unsubscribe).toHaveBeenCalled();
    expect(t.tray.destroy).toHaveBeenCalled();
  });

  it('survives a failing source', () => {
    const l = quietLog();
    const tray = { setToolTip: vi.fn(), setContextMenu: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    createAppTray({
      createTray: () => tray, buildMenu: (t) => t, onOpen: vi.fn(), onQuit: vi.fn(), log: l,
      source: { counts: () => { throw new Error('core stopped'); }, quietMode: () => false, setQuietMode: vi.fn(), subscribe: () => () => undefined },
    });
    expect(l.warn).toHaveBeenCalled();
  });
});

describe('the tray icon file', () => {
  const image = (empty: boolean) => ({ isEmpty: () => empty });
  it('takes the first candidate that exists and loads to a non-empty image', () => {
    const load = vi.fn((f: string) => image(f.endsWith('bad.ico')));
    const found = firstUsableImage(['/r/gone.ico', '/r/bad.ico', '/r/tray.png'], load, (f) => !f.endsWith('gone.ico'));
    expect(found?.file).toBe('/r/tray.png');
    expect(load.mock.calls.map((c) => c[0])).toEqual(['/r/bad.ico', '/r/tray.png']);
  });
  it('falls through a decoder that throws, and reports nothing usable as null so no empty tray icon is created', () => {
    expect(firstUsableImage(['/r/a.ico', '/r/b.png'], (f) => { if (f.endsWith('.ico')) throw new Error('decode'); return image(false); }, () => true)?.file).toBe('/r/b.png');
    expect(firstUsableImage(['/r/a.ico'], () => image(true), () => true)).toBeNull();
    expect(firstUsableImage([], () => image(false), () => true)).toBeNull();
  });
});

describe('badge', () => {
  it('draws an opaque emerald disc with transparent corners (premultiplied BGRA)', () => {
    const { width, height, data } = badgeBitmap();
    expect([width, height, data.length]).toEqual([16, 16, 16 * 16 * 4]);
    const px = (x: number, y: number) => Array.from(data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
    expect(px(8, 8)).toEqual([0x81, 0xb9, 0x10, 0xff]);
    expect(px(0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(15, 15)).toEqual([0, 0, 0, 0]);
  });
  it('describes the count in words', () => {
    expect(badgeDescription(1)).toBe('1 item needs your attention');
    expect(badgeDescription(7)).toBe('7 items need your attention');
  });
});

describe('locations', () => {
  it('finds everything beside the bundled main script in development', () => {
    const l = resolveLocations({ moduleDir: '/repo/apps/desktop/out/main', isPackaged: false, resourcesPath: '/ignored' });
    expect(l.uiDir).toBe(path.resolve('/repo/apps/desktop', 'out', 'renderer'));
    expect(l.preloadPath).toBe(path.resolve('/repo/apps/desktop', 'out', 'preload', 'index.cjs'));
    expect(l.iconPath).toBe(path.resolve('/repo/apps/desktop', 'resources', 'icon.png'));
    expect(l.trayIconPath).toBe(path.resolve('/repo/apps/desktop', 'resources', 'tray.png'));
    expect(l.captureScript).toBeUndefined();
  });
  it('finds the unpacked hook script and icons in the resources folder when packaged', () => {
    const l = resolveLocations({ moduleDir: '/app/resources/app.asar/out/main', isPackaged: true, resourcesPath: '/app/resources' });
    expect(l.uiDir).toBe(path.resolve('/app/resources/app.asar', 'out', 'renderer'));
    expect(l.preloadPath).toBe(path.resolve('/app/resources/app.asar', 'out', 'preload', 'index.cjs'));
    expect(l.captureScript).toBe(path.resolve('/app/resources', 'hook', 'capture.mjs'));
    expect(l.iconPath).toBe(path.resolve('/app/resources', 'icons', 'icon.png'));
  });
});

describe('locations for Windows (SIMULATED: injected platform and Windows-style paths, not run on Windows)', () => {
  it('prefers a multi-size .ico for the tray on Windows and keeps the PNG as the fallback', () => {
    const l = resolveLocations({ moduleDir: 'C:\\Users\\José Müller\\AppData\\Local\\Programs\\Mini-Summa\\resources\\app.asar\\out\\main', isPackaged: true, resourcesPath: 'C:\\Users\\José Müller\\AppData\\Local\\Programs\\Mini-Summa\\resources', platform: 'win32' });
    expect(l.trayIcons.map((f) => path.basename(f))).toEqual(['tray.ico', 'tray.png']);
    expect(path.basename(l.trayIconPath)).toBe('tray.png');
  });
  it('uses the PNG alone on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const l = resolveLocations({ moduleDir: '/app/resources/app.asar/out/main', isPackaged: true, resourcesPath: '/app/resources', platform });
      expect(l.trayIcons.map((f) => path.basename(f))).toEqual(['tray.png']);
    }
  });
});

describe('log', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-log-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('redacts anything that looks like a credential, at any depth', () => {
    const out = redact({ token: 'abc', nested: { Authorization: 'Bearer x', ok: 1, list: [{ password: 'p', fine: 'f' }] }, desktopToken: 'zzz', cookie: 'c' }) as Record<string, any>;
    expect(out.token).toBe('[redacted]');
    expect(out.desktopToken).toBe('[redacted]');
    expect(out.cookie).toBe('[redacted]');
    expect(out.nested.Authorization).toBe('[redacted]');
    expect(out.nested.ok).toBe(1);
    expect(out.nested.list[0]).toEqual({ password: '[redacted]', fine: 'f' });
  });

  it('writes lines with level and message, never a token, and survives errors as data', () => {
    const dir = tmp();
    const log = createFileLogger(dir);
    log.info('core started', { origin: 'http://127.0.0.1:1', token: 'tok_secret' });
    log.error('boom', { error: new Error('bad thing') });
    const text = fs.readFileSync(log.file, 'utf8');
    expect(text).toMatch(/info\s+core started/);
    expect(text).toMatch(/error\s+boom/);
    expect(text).toContain('bad thing');
    expect(text).not.toContain('tok_secret');
  });

  it('rotates when the file grows past the limit', () => {
    const dir = tmp();
    const log = createFileLogger(dir, { maxBytes: 400 });
    for (let i = 0; i < 30; i += 1) log.info(`line ${i} ${'x'.repeat(40)}`);
    expect(fs.existsSync(path.join(dir, 'main.1.log'))).toBe(true);
    expect(fs.statSync(log.file).size).toBeLessThan(800);
  });

  // SIMULATED trigger: on Windows the rename fails while another program (a log viewer, `Get-Content -Wait`, a scanner) holds the
  // file open without sharing it for delete. Here a non-empty directory sits where the rotated file would go, which makes
  // renameSync throw on Linux too. The defect: the failed rotation threw before the append, so every line after the limit was
  // dropped for as long as the other program held the file.
  it('keeps writing when the file cannot be rotated, and rotates once it can', () => {
    const dir = tmp();
    const rotated = path.join(dir, 'main.1.log');
    fs.mkdirSync(path.join(rotated, 'in-the-way'), { recursive: true });
    const log = createFileLogger(dir, { maxBytes: 400 });
    for (let i = 0; i < 30; i += 1) log.info(`line ${i} ${'x'.repeat(40)}`);
    const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(30);
    expect(lines.at(-1)).toContain('line 29');

    fs.rmSync(rotated, { recursive: true });
    for (let i = 0; i < 6000; i += 1) log.info(`later ${i} ${'y'.repeat(40)}`);
    expect(fs.statSync(rotated).isFile()).toBe(true);
    expect(fs.readFileSync(log.file, 'utf8')).toContain('later 5999');
  });

  it('does not throw when the directory cannot be created', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'f');
    fs.writeFileSync(blocker, '');
    const log = createFileLogger(path.join(blocker, 'logs'));
    expect(() => log.warn('still fine')).not.toThrow();
  });
});
