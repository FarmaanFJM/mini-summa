// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Electron objects are replaced by recorders so the real adapter code runs against them.
const created: { options: any; view: any }[] = [];
const sessions = new Map<string, any>();

class FakeWebContents {
  listeners = new Map<string, (...a: any[]) => void>();
  windowOpenHandler: any = null;
  navigationHistory = { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() };
  zoomFactor = 1;
  getZoomFactor() { return this.zoomFactor; }
  setZoomFactor = vi.fn((factor: number) => { this.zoomFactor = factor; });
  getURL() { return 'https://chatgpt.com/'; }
  getTitle() { return 'ChatGPT'; }
  isLoading() { return false; }
  isFocused() { return true; }
  isDestroyed() { return false; }
  loadURL = vi.fn(async () => undefined);
  reload = vi.fn();
  stop = vi.fn();
  focus = vi.fn();
  on(event: string, l: (...a: any[]) => void) { this.listeners.set(event, l); return this; }
  removeListener(event: string) { this.listeners.delete(event); return this; }
  setWindowOpenHandler(h: any) { this.windowOpenHandler = h; }
}

class FakeWebContentsView {
  webContents = new FakeWebContents();
  setBounds = vi.fn();
  setVisible = vi.fn();
  setBackgroundColor = vi.fn();
  constructor(public options: any) { created.push({ options, view: this }); }
}

vi.mock('electron', () => ({
  WebContentsView: FakeWebContentsView,
  session: {
    fromPartition: (name: string) => {
      if (!sessions.has(name)) {
        sessions.set(name, {
          name,
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setDevicePermissionHandler: vi.fn(),
          setDisplayMediaRequestHandler: vi.fn(),
        });
      }
      return sessions.get(name);
    },
  },
}));

const { CHATGPT_ALLOWED_PERMISSIONS, CHATGPT_PARTITION, chatGptSession, createChatGptViewHandle, createEmbeddedView, hardenChatGptSession } = await import('../../src/main/electronView.ts');

beforeEach(() => { created.length = 0; sessions.clear(); });

describe('the embedded ChatGPT view', () => {
  const makeWin = () => ({ contentView: { addChildView: vi.fn() } });

  it('uses its own persistent partition and the strictest renderer settings, with no preload', () => {
    const win = makeWin();
    createChatGptViewHandle(win as never);
    expect(created).toHaveLength(1);
    const prefs = created[0].options.webPreferences;
    expect(prefs.partition).toBe('persist:chatgpt');
    expect(CHATGPT_PARTITION).toBe('persist:chatgpt');
    expect(prefs).toMatchObject({
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    });
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs).not.toHaveProperty('additionalArguments');
  });

  it('never sets a user agent, and does not inject anything into the page', () => {
    createChatGptViewHandle(makeWin() as never);
    const wc = created[0].view.webContents;
    expect(wc).not.toHaveProperty('setUserAgent');
    expect(created[0].options.webPreferences).not.toHaveProperty('userAgent');
    // the only thing ever requested of the page is a load
    expect(Object.keys(wc).filter((k) => /execute|insert|inject|script/i.test(k))).toEqual([]);
  });

  it('is added to the window hidden, and the handle drives the native view', () => {
    const win = makeWin();
    const handle = createChatGptViewHandle(win as never);
    const view = created[0].view;
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setVisible).toHaveBeenCalledWith(false);
    handle.setBounds({ x: 1, y: 2, width: 3, height: 4 });
    handle.setVisible(true);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('uses the new navigation history API', () => {
    const handle = createChatGptViewHandle(makeWin() as never);
    expect(handle.contents.canGoBack()).toBe(true);
    expect(handle.contents.canGoForward()).toBe(false);
    handle.contents.goBack();
    expect(created[0].view.webContents.navigationHistory.goBack).toHaveBeenCalled();
  });

  it('allows exactly one permission, sanitized clipboard writes (any change is a deliberate product decision and must change this test)', () => {
    expect(CHATGPT_ALLOWED_PERMISSIONS).toEqual(['clipboard-sanitized-write']);
  });

  it('refuses every permission except sanitized clipboard writes, including clipboard-read, media and notifications', () => {
    createChatGptViewHandle(makeWin() as never);
    const ses = chatGptSession() as any;
    expect(ses.name).toBe('persist:chatgpt');
    const request = ses.setPermissionRequestHandler.mock.calls[0][0] as (c: unknown, p: string, cb: (ok: boolean) => void) => void;
    for (const permission of ['clipboard-read', 'media', 'geolocation', 'notifications', 'midi', 'fullscreen', 'openExternal', 'display-capture', 'hid', 'serial', 'usb']) {
      const cb = vi.fn();
      request({}, permission, cb);
      expect(cb).toHaveBeenCalledWith(false);
    }
    const allowedCb = vi.fn();
    request({}, 'clipboard-sanitized-write', allowedCb);
    expect(allowedCb).toHaveBeenCalledWith(true);
    const check = ses.setPermissionCheckHandler.mock.calls[0][0] as (c: unknown, p: string) => boolean;
    expect(check({}, 'clipboard-sanitized-write')).toBe(true);
    expect(check({}, 'clipboard-read')).toBe(false);
    expect(check({}, 'notifications')).toBe(false);
    expect((ses.setDevicePermissionHandler.mock.calls[0][0] as () => boolean)()).toBe(false);
    const display = ses.setDisplayMediaRequestHandler.mock.calls[0][0] as (r: unknown, cb: (s: object) => void) => void;
    const dcb = vi.fn();
    display({}, dcb);
    expect(dcb).toHaveBeenCalledWith({});
  });

  it('can be hardened before any view exists', () => {
    hardenChatGptSession(chatGptSession());
    expect(created).toHaveLength(0);
    expect((chatGptSession() as any).setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });

  it('the page zoom is the view\'s own: it reads and sets the zoom of this web contents and nothing else', () => {
    const handle = createChatGptViewHandle(makeWin() as never);
    const wc = created[0].view.webContents;
    expect(handle.contents.getZoomFactor()).toBe(1);
    handle.contents.setZoomFactor(0.8);
    expect(wc.setZoomFactor).toHaveBeenCalledWith(0.8);
    expect(handle.contents.getZoomFactor()).toBe(0.8);
  });
});

describe('the view every embedded site is made of', () => {
  const makeWin = () => ({ contentView: { addChildView: vi.fn() } });

  it('gives whichever partition it is asked for the hardened session, the strictest preferences and no preload, and adds the view hidden', () => {
    const win = makeWin();
    const view = createEmbeddedView(win as never, 'persist:somewhere-else') as any;
    expect(created).toHaveLength(1);
    expect(created[0].view).toBe(view);
    const prefs = created[0].options.webPreferences;
    expect(prefs.partition).toBe('persist:somewhere-else');
    expect(prefs).toMatchObject({
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    });
    expect(Object.keys(prefs).sort()).toEqual([
      'allowRunningInsecureContent', 'contextIsolation', 'nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'partition', 'sandbox',
      'webSecurity', 'webviewTag',
    ]);
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setVisible).toHaveBeenCalledWith(false);
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#141515');
    const ses = sessions.get('persist:somewhere-else');
    expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(ses.setDevicePermissionHandler).toHaveBeenCalledTimes(1);
    expect(sessions.has('persist:chatgpt')).toBe(false);
  });
});

describe('what the adapter lets the controller do to the view and the page (the only code that can reach the real ones)', () => {
  const makeWin = () => ({ contentView: { addChildView: vi.fn() } });

  it('offers no way to destroy, close, remove or replace the view, so layout changes cannot lose the page', () => {
    const handle = createChatGptViewHandle(makeWin() as never);
    expect(Object.keys(handle).sort()).toEqual(['contents', 'setBounds', 'setVisible']);
    const names = Object.keys(handle.contents);
    expect(names.filter((name) => /destroy|close|remove(?!Listener)|dispose|crash|replace/i.test(name) && name !== 'isDestroyed')).toEqual([]);
  });

  it('offers no way to run a script, add CSS, type, click, change the user agent or watch the page\'s requests', () => {
    const handle = createChatGptViewHandle(makeWin() as never);
    expect(Object.keys(handle.contents).sort()).toEqual([
      'canGoBack', 'canGoForward', 'focus', 'getTitle', 'getURL', 'getZoomFactor', 'goBack', 'goForward', 'isDestroyed', 'isFocused', 'isLoading',
      'loadURL', 'on', 'reload', 'removeListener', 'setWindowOpenHandler', 'setZoomFactor', 'stop',
    ]);
  });

  it('no source of the main process or the preload calls anything that would do those things, or removes the view from the window', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const file = path.join(d, entry.name);
        if (entry.isDirectory()) walk(file); else if (/\.ts$/.test(entry.name)) files.push(file);
      }
    };
    for (const dir of ['../../src/main', '../../src/preload']) walk(path.resolve(import.meta.dirname, dir));
    expect(files.length).toBeGreaterThan(10);
    const page = /\.(executeJavaScript|executeJavaScriptInIsolatedWorld|insertCSS|removeInsertedCSS|insertText|sendInputEvent|setUserAgent|startDrag)\(|\bwebFrame\b|registerPreloadScript|setPreloads|webRequest\./;
    const lifetime = /removeChildView|webContents\??\.(close|destroy)\(|forcefullyCrashRenderer/;
    expect(files.filter((f) => page.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f))).toEqual([]);
    expect(files.filter((f) => lifetime.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f))).toEqual([]);
  });
});
