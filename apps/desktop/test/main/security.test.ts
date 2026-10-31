// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { allowMainPermission, decideMainNavigation, guardMainWindowNavigation, hardenMainSession, hardenWebContentsCreation } from '../../src/main/security.ts';

const CORE = 'http://127.0.0.1:40555';
const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('decideMainNavigation', () => {
  it.each([
    ['the UI itself', `${CORE}/ui/`, 'allow'],
    ['a UI route', `${CORE}/ui/projects/prj_1?tab=x#y`, 'allow'],
    ['the API on the same origin', `${CORE}/api/v1/health`, 'allow'],
    ['a website', 'https://example.org/docs', 'external'],
    ['ChatGPT (opened by the browser, not here)', 'https://chatgpt.com/c/abc', 'external'],
    ['plain http elsewhere', 'http://example.org/', 'block'],
    ['localhost under another name', 'http://localhost:40555/ui/', 'block'],
    ['another port on loopback', 'http://127.0.0.1:1/ui/', 'block'],
    ['a file', 'file:///C:/Users/me/x.html', 'block'],
    ['javascript', 'javascript:alert(1)', 'block'],
    ['a data page', 'data:text/html,hi', 'block'],
    ['our own protocol', 'minisumma://settings', 'block'],
    ['an https link with credentials', 'https://u:p@example.org/', 'block'],
    ['junk', 'not a url', 'block'],
  ])('%s -> %s', (_name, url, decision) => {
    expect(decideMainNavigation(url, CORE)).toBe(decision);
  });
});

describe('main window permissions', () => {
  it('allow only clipboard-sanitized-write, and only for the core', () => {
    expect(allowMainPermission('clipboard-sanitized-write', `${CORE}/ui/`, CORE)).toBe(true);
    expect(allowMainPermission('clipboard-sanitized-write', 'https://evil.example/', CORE)).toBe(false);
    expect(allowMainPermission('clipboard-sanitized-write', undefined, CORE)).toBe(false);
    for (const p of ['clipboard-read', 'media', 'geolocation', 'notifications', 'fullscreen', 'openExternal', 'midi', 'hid', 'serial']) {
      expect(allowMainPermission(p, `${CORE}/ui/`, CORE)).toBe(false);
    }
  });

  it('are installed on the session as request, check and device handlers', () => {
    const ses = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn() };
    hardenMainSession(ses as never, CORE);
    const request = ses.setPermissionRequestHandler.mock.calls[0][0] as (c: unknown, p: string, cb: (ok: boolean) => void, d: { requestingUrl: string }) => void;
    const answer = (permission: string, requestingUrl: string) => { const cb = vi.fn(); request({}, permission, cb, { requestingUrl }); return cb.mock.calls[0][0]; };
    expect(answer('clipboard-sanitized-write', `${CORE}/ui/`)).toBe(true);
    expect(answer('clipboard-read', `${CORE}/ui/`)).toBe(false);
    expect(answer('media', `${CORE}/ui/`)).toBe(false);
    const check = ses.setPermissionCheckHandler.mock.calls[0][0] as (c: unknown, p: string, origin: string) => boolean;
    expect(check({}, 'clipboard-sanitized-write', CORE)).toBe(true);
    expect(check({}, 'clipboard-read', CORE)).toBe(false);
    const device = ses.setDevicePermissionHandler.mock.calls[0][0] as () => boolean;
    expect(device()).toBe(false);
  });
});

describe('every web contents the app creates', () => {
  it('cannot attach a webview and denies new windows until something sets its own rule', () => {
    const app = new EventEmitter();
    hardenWebContentsCreation(app as never);
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    app.emit('web-contents-created', {}, contents);
    const attach = { preventDefault: vi.fn() };
    contents.emit('will-attach-webview', attach);
    expect(attach.preventDefault).toHaveBeenCalled();
    const handler = contents.setWindowOpenHandler.mock.calls[0][0] as () => { action: string };
    expect(handler()).toEqual({ action: 'deny' });
  });
});

describe('guardMainWindowNavigation', () => {
  function setup() {
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    const openExternal = vi.fn();
    const l = log();
    guardMainWindowNavigation(contents as never, CORE, openExternal, l);
    const navigate = (event: string, url: string) => { const e = { preventDefault: vi.fn() }; contents.emit(event, e, url); return e; };
    return { contents, openExternal, navigate, log: l, windowOpen: contents.setWindowOpenHandler.mock.calls[0][0] as (d: { url: string }) => { action: string } };
  }

  it('lets the window stay on the core origin', () => {
    const { navigate, openExternal } = setup();
    for (const event of ['will-navigate', 'will-redirect']) expect(navigate(event, `${CORE}/ui/x`).preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('cancels navigation away from the core and sends https links to the system browser', () => {
    const { navigate, openExternal } = setup();
    expect(navigate('will-navigate', 'https://example.org/x').preventDefault).toHaveBeenCalled();
    expect(navigate('will-redirect', 'https://example.org/y').preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledWith('https://example.org/x');
  });

  it('cancels everything else without opening it anywhere', () => {
    const { navigate, openExternal, log: l } = setup();
    for (const url of ['http://example.org/', 'file:///x', 'javascript:1', 'data:text/html,x']) {
      expect(navigate('will-navigate', url).preventDefault).toHaveBeenCalled();
    }
    expect(openExternal).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledTimes(4);
  });

  it('denies window.open always; https links open in the browser', () => {
    const { windowOpen, openExternal } = setup();
    expect(windowOpen({ url: 'https://example.org/' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://example.org/');
    openExternal.mockClear();
    for (const url of [`${CORE}/ui/popup`, 'http://example.org/', 'about:blank', 'file:///x']) {
      expect(windowOpen({ url })).toEqual({ action: 'deny' });
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});
