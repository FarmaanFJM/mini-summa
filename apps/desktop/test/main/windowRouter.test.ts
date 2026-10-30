// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CH } from '../../src/main/channels.ts';
import { EventEmitter } from 'node:events';
import { createWindowRouter, trackRendererReadiness } from '../../src/main/windowRouter.ts';
import type { RoutableWindow } from '../../src/main/windowRouter.ts';

function fakeWindow(state: { minimized?: boolean; visible?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  const s = { minimized: false, visible: true, destroyed: false, ...state };
  const win: RoutableWindow = {
    isDestroyed: () => s.destroyed,
    isMinimized: () => s.minimized,
    restore: () => { calls.push('restore'); s.minimized = false; },
    isVisible: () => s.visible,
    show: () => { calls.push('show'); s.visible = true; },
    focus: () => { calls.push('focus'); },
    webContents: { isDestroyed: () => s.destroyed, send: (channel, ...args) => { calls.push(`send:${channel}:${JSON.stringify(args[0])}`); } },
  };
  return { win, calls, s };
}
const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const target = { view: 'reports', reportId: 'rep_1' } as const;

describe('createWindowRouter', () => {
  it('delivers to a ready window after bringing it forward', () => {
    const { win, calls } = fakeWindow();
    const router = createWindowRouter(() => win, log());
    router.setRendererReady(true);
    router.navigate(target);
    expect(calls).toEqual(['focus', `send:${CH.navigate}:${JSON.stringify(target)}`]);
  });

  it('restores a minimized window before focusing it, then navigates', () => {
    const { win, calls } = fakeWindow({ minimized: true });
    const router = createWindowRouter(() => win, log());
    router.setRendererReady(true);
    router.navigate(target);
    expect(calls).toEqual(['restore', 'focus', `send:${CH.navigate}:${JSON.stringify(target)}`]);
  });

  it('shows a hidden window before focusing it, then navigates', () => {
    const { win, calls } = fakeWindow({ visible: false });
    const router = createWindowRouter(() => win, log());
    router.setRendererReady(true);
    router.navigate(target);
    expect(calls).toEqual(['show', 'focus', `send:${CH.navigate}:${JSON.stringify(target)}`]);
  });

  it('restores, then shows, then focuses a window that is both minimized and hidden', () => {
    const { win, calls } = fakeWindow({ minimized: true, visible: false });
    const router = createWindowRouter(() => win, log());
    router.setRendererReady(true);
    router.navigate(target);
    expect(calls.slice(0, 3)).toEqual(['restore', 'show', 'focus']);
    expect(calls[3]).toMatch(/^send:/);
  });

  it('holds the target until the renderer has loaded, and still brings the window forward at once', () => {
    const { win, calls } = fakeWindow({ minimized: true });
    const router = createWindowRouter(() => win, log());
    router.navigate(target);
    expect(calls).toEqual(['restore', 'focus']);
    expect(router.pending()).toEqual(target);
    router.setRendererReady(true);
    expect(calls[2]).toBe(`send:${CH.navigate}:${JSON.stringify(target)}`);
    expect(router.pending()).toBeNull();
  });

  it('holds the target again while the page reloads', () => {
    const { win, calls } = fakeWindow();
    const router = createWindowRouter(() => win, log());
    router.setRendererReady(true);
    router.setRendererReady(false);
    router.navigate(target);
    expect(calls.filter((c) => c.startsWith('send:'))).toHaveLength(0);
    router.setRendererReady(true);
    expect(calls.filter((c) => c.startsWith('send:'))).toHaveLength(1);
  });

  it('keeps only the latest target (two clicks before the page loads should not replay both)', () => {
    const { win, calls } = fakeWindow();
    const router = createWindowRouter(() => win, log());
    router.navigate({ view: 'activity' });
    router.navigate({ view: 'settings' });
    router.setRendererReady(true);
    const sends = calls.filter((c) => c.startsWith('send:'));
    expect(sends).toEqual([`send:${CH.navigate}:${JSON.stringify({ view: 'settings' })}`]);
  });

  it('holds the target when there is no window yet, and delivers when one is ready', () => {
    let current: RoutableWindow | null = null;
    const l = log();
    const router = createWindowRouter(() => current, l);
    router.navigate(target);
    expect(l.info).toHaveBeenCalled();
    expect(router.reveal()).toBe(false);
    const { win, calls } = fakeWindow();
    current = win;
    router.setRendererReady(true);
    expect(calls).toContain(`send:${CH.navigate}:${JSON.stringify(target)}`);
  });

  it('never touches a destroyed window', () => {
    const { win, calls, s } = fakeWindow();
    s.destroyed = true;
    const router = createWindowRouter(() => win, log());
    router.setRendererReady(true);
    router.navigate(target);
    expect(calls).toEqual([]);
    expect(router.reveal()).toBe(false);
  });
});

describe('trackRendererReadiness', () => {
  it('is ready after the page loads, not ready while a new document replaces it, ready again after', () => {
    const { win, calls } = fakeWindow();
    const router = createWindowRouter(() => win, log());
    const contents = new EventEmitter();
    trackRendererReadiness(contents as never, router);

    router.navigate(target);
    expect(calls.some((c) => c.startsWith('send:'))).toBe(false);
    contents.emit('did-finish-load');
    expect(calls.filter((c) => c.startsWith('send:'))).toHaveLength(1);

    contents.emit('did-navigate');
    router.navigate({ view: 'activity' });
    expect(calls.filter((c) => c.startsWith('send:'))).toHaveLength(1);
    contents.emit('did-finish-load');
    expect(calls.filter((c) => c.startsWith('send:'))).toHaveLength(2);
  });

  it('a navigation that the window guard cancelled never un-readies the renderer', () => {
    // Observed in Electron 45: a cancelled navigation emits did-start-loading and did-stop-loading, and nothing else.
    const { win, calls } = fakeWindow();
    const router = createWindowRouter(() => win, log());
    const contents = new EventEmitter();
    trackRendererReadiness(contents as never, router);
    contents.emit('did-finish-load');
    contents.emit('did-start-loading');
    contents.emit('did-stop-loading');
    router.navigate(target);
    expect(calls.filter((c) => c.startsWith('send:'))).toHaveLength(1);
  });
});
