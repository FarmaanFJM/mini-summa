// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Electron objects are replaced by recorders so the real adapter code runs against them.
const created: { options: any; view: any }[] = [];
const sessions = new Map<string, any>();

class FakeWebContents {
  navigationHistory = { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() };
  windowOpenHandler: any = null;
  listeners = new Map<string, (...a: any[]) => void>();
  getURL() { return 'https://claude.ai/code'; }
  getTitle() { return 'Claude Code'; }
  isLoading() { return false; }
  isDestroyed() { return false; }
  loadURL = vi.fn(async () => undefined);
  reload = vi.fn();
  focus = vi.fn();
  on(event: string, l: (...a: any[]) => void) { this.listeners.set(event, l); return this; }
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

const { CLAUDE_PARTITION, claudeWebSession, createClaudeWebViewHandle } = await import('../../src/main/claudeElectronView.ts');
const { CHATGPT_ALLOWED_PERMISSIONS, CHATGPT_PARTITION, chatGptSession, createChatGptViewHandle } = await import('../../src/main/electronView.ts');

beforeEach(() => { created.length = 0; sessions.clear(); });

const makeWin = () => ({ contentView: { addChildView: vi.fn() } });

describe('the embedded Claude Code on the web view', () => {
  it('has a browser profile of its own, not the ChatGPT one, so the two sites never share cookies or storage', () => {
    expect(CLAUDE_PARTITION).toBe('persist:claude');
    expect(CLAUDE_PARTITION).not.toBe(CHATGPT_PARTITION);
    createClaudeWebViewHandle(makeWin() as never);
    expect(created).toHaveLength(1);
    expect(created[0].options.webPreferences.partition).toBe('persist:claude');
    expect((claudeWebSession() as any).name).toBe('persist:claude');
    expect(claudeWebSession()).not.toBe(chatGptSession());
    expect((chatGptSession() as any).name).toBe('persist:chatgpt');
    // persist: keeps the sign-in between runs, like the ChatGPT one (an in-memory partition would sign the person out at every start).
    expect(CLAUDE_PARTITION.startsWith('persist:')).toBe(true);
  });

  it('uses the strictest renderer settings, with no preload and no extra arguments', () => {
    createClaudeWebViewHandle(makeWin() as never);
    const prefs = created[0].options.webPreferences;
    expect(prefs).toMatchObject({
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    });
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs).not.toHaveProperty('additionalArguments');
    expect(prefs).not.toHaveProperty('userAgent');
    expect(Object.keys(prefs).sort()).toEqual([
      'allowRunningInsecureContent', 'contextIsolation', 'nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'partition', 'sandbox',
      'webSecurity', 'webviewTag',
    ]);
  });

  it('gets exactly the web preferences and the permission rule of the ChatGPT view, apart from the partition: they are written once', () => {
    createClaudeWebViewHandle(makeWin() as never);
    createChatGptViewHandle(makeWin() as never);
    const [claudePrefs, chatgptPrefs] = created.map((c) => c.options.webPreferences);
    expect(claudePrefs.partition).toBe('persist:claude');
    expect(chatgptPrefs.partition).toBe('persist:chatgpt');
    const { partition: _claude, ...claudeRest } = claudePrefs;
    const { partition: _chatgpt, ...chatgptRest } = chatgptPrefs;
    expect(claudeRest).toEqual(chatgptRest);
    for (const view of created) {
      expect(view.view.setVisible).toHaveBeenCalledWith(false);
      expect(view.view.setBackgroundColor).toHaveBeenCalledWith('#141515');
    }
    const [claudeSession, chatgptSession] = [claudeWebSession() as any, chatGptSession() as any];
    for (const ses of [claudeSession, chatgptSession]) {
      expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
      expect(ses.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
      expect(ses.setDevicePermissionHandler).toHaveBeenCalledTimes(1);
      expect(ses.setDisplayMediaRequestHandler).toHaveBeenCalledTimes(1);
    }
    // Same rule: the handler installed on one answers like the handler installed on the other.
    const allow = (ses: any) => (permission: string) => { const cb = vi.fn(); (ses.setPermissionRequestHandler.mock.calls[0][0] as (c: unknown, p: string, cb: (ok: boolean) => void) => void)({}, permission, cb); return cb.mock.calls[0][0]; };
    for (const permission of ['clipboard-sanitized-write', 'clipboard-read', 'media', 'notifications', 'geolocation']) expect(allow(claudeSession)(permission)).toBe(allow(chatgptSession)(permission));
  });

  it('never sets a user agent, and does not inject anything into the page', () => {
    createClaudeWebViewHandle(makeWin() as never);
    const wc = created[0].view.webContents;
    expect(wc).not.toHaveProperty('setUserAgent');
    expect(Object.keys(wc).filter((k) => /execute|insert|inject|script|cookie/i.test(k))).toEqual([]);
  });

  it('is added to the window hidden, and the handle drives the native view', () => {
    const win = makeWin();
    const handle = createClaudeWebViewHandle(win as never);
    const view = created[0].view;
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.setVisible).toHaveBeenCalledWith(false);
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#141515');
    handle.setBounds({ x: 1, y: 2, width: 3, height: 4 });
    handle.setVisible(true);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('uses the navigation history API of the web contents', () => {
    const handle = createClaudeWebViewHandle(makeWin() as never);
    expect(handle.contents.canGoBack()).toBe(true);
    expect(handle.contents.canGoForward()).toBe(false);
    handle.contents.goBack();
    expect(created[0].view.webContents.navigationHistory.goBack).toHaveBeenCalled();
  });

  it('allows exactly the one permission ChatGPT is allowed: sanitized clipboard writes', () => {
    expect(CHATGPT_ALLOWED_PERMISSIONS).toEqual(['clipboard-sanitized-write']);
  });

  it('refuses every permission except sanitized clipboard writes, including clipboard-read, media and notifications, and shows no prompt', () => {
    createClaudeWebViewHandle(makeWin() as never);
    const ses = claudeWebSession() as any;
    const request = ses.setPermissionRequestHandler.mock.calls[0][0] as (c: unknown, p: string, cb: (ok: boolean) => void) => void;
    for (const permission of ['clipboard-read', 'media', 'geolocation', 'notifications', 'midi', 'fullscreen', 'openExternal', 'display-capture', 'hid', 'serial', 'usb', 'camera', 'microphone']) {
      const cb = vi.fn();
      request({}, permission, cb);
      expect(cb).toHaveBeenCalledTimes(1);
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

  it('hardens its own session and only its own: the ChatGPT session is not touched by creating the Claude view', () => {
    createClaudeWebViewHandle(makeWin() as never);
    expect((claudeWebSession() as any).setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(sessions.has('persist:chatgpt')).toBe(false);
  });
});

describe('what the adapter lets the controller do to the Claude view and the page', () => {
  it('offers no way to destroy, close, remove or replace the view, so layout changes cannot lose the page', () => {
    const handle = createClaudeWebViewHandle(makeWin() as never);
    expect(Object.keys(handle).sort()).toEqual(['contents', 'setBounds', 'setVisible']);
    const names = Object.keys(handle.contents);
    expect(names.filter((name) => /destroy|close|remove|dispose|crash|replace/i.test(name) && name !== 'isDestroyed')).toEqual([]);
  });

  it('offers no way to run a script, add CSS, type, click, read cookies, change the user agent or watch the page\'s requests', () => {
    const handle = createClaudeWebViewHandle(makeWin() as never);
    expect(Object.keys(handle.contents).sort()).toEqual([
      'canGoBack', 'canGoForward', 'focus', 'getTitle', 'getURL', 'goBack', 'goForward', 'isDestroyed', 'isLoading', 'loadURL', 'on', 'reload', 'setWindowOpenHandler',
    ]);
  });

  it('forwards loading and events to the web contents it wraps', async () => {
    const handle = createClaudeWebViewHandle(makeWin() as never);
    const wc = created[0].view.webContents;
    await handle.contents.loadURL('https://claude.ai/code');
    expect(wc.loadURL).toHaveBeenCalledWith('https://claude.ai/code');
    handle.contents.reload();
    handle.contents.focus();
    expect(wc.reload).toHaveBeenCalled();
    expect(wc.focus).toHaveBeenCalled();
    const listener = vi.fn();
    handle.contents.on('did-navigate', listener);
    expect(wc.listeners.get('did-navigate')).toBe(listener);
    const open = vi.fn(() => ({ action: 'deny' as const }));
    handle.contents.setWindowOpenHandler(open);
    expect(wc.windowOpenHandler).toBe(open);
  });
});
