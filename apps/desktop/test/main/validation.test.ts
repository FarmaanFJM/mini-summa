// @vitest-environment node
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isExternalUrl, isTrustedSender, originOf, validateAbsolutePath, validateBadgeCount, validateBounds, validateBoolean,
  validateChatGptUrl, validateClipboardText, validateDirectoryOptions, validateExternalUrl, ValidationError,
} from '../../src/main/validation.ts';

const CORE = 'http://127.0.0.1:41234';
const trusted = { frameUrl: `${CORE}/ui/`, isTopFrame: true, contentsId: 7 };

describe('isTrustedSender', () => {
  it('accepts the main window top frame on the core origin', () => {
    expect(isTrustedSender(trusted, CORE, 7)).toBe(true);
    expect(isTrustedSender({ ...trusted, frameUrl: `${CORE}/ui/projects?x=1#y` }, CORE, 7)).toBe(true);
  });

  it('rejects any other web contents (the ChatGPT view, a devtools window)', () => {
    expect(isTrustedSender({ ...trusted, contentsId: 8 }, CORE, 7)).toBe(false);
  });

  it('rejects everything when there is no main window', () => {
    expect(isTrustedSender(trusted, CORE, null)).toBe(false);
  });

  it('rejects subframes, even of the right origin', () => {
    expect(isTrustedSender({ ...trusted, isTopFrame: false }, CORE, 7)).toBe(false);
  });

  it('rejects a frame that is gone', () => {
    expect(isTrustedSender({ ...trusted, frameUrl: null }, CORE, 7)).toBe(false);
    expect(isTrustedSender({ ...trusted, frameUrl: undefined }, CORE, 7)).toBe(false);
  });

  it.each([
    ['another port', 'http://127.0.0.1:41235/ui/'],
    ['another host', 'http://localhost:41234/ui/'],
    ['https on the same port', 'https://127.0.0.1:41234/ui/'],
    ['a website', 'https://chatgpt.com/'],
    ['a lookalike host', 'http://127.0.0.1.evil.example:41234/'],
    ['credentials trick', 'http://127.0.0.1:41234@evil.example/'],
    ['a file', 'file:///C:/x.html'],
    ['about:blank', 'about:blank'],
    ['a data url', 'data:text/html,hi'],
    ['junk', 'not a url'],
  ])('rejects %s', (_name, frameUrl) => {
    expect(isTrustedSender({ ...trusted, frameUrl }, CORE, 7)).toBe(false);
  });
});

describe('originOf', () => {
  it('returns the origin or null', () => {
    expect(originOf('http://127.0.0.1:5/ui/')).toBe('http://127.0.0.1:5');
    expect(originOf('about:blank')).toBeNull();
    expect(originOf('')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe('argument validators', () => {
  it('bounds: a rectangle or null, nothing else', () => {
    expect(validateBounds(null)).toBeNull();
    expect(validateBounds({ x: 1, y: 2, width: 3, height: 4, extra: 'dropped' })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    for (const bad of [undefined, 5, 'x', [], {}, { x: 1, y: 2, width: 3 }, { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: -1, height: 1 }]) {
      expect(() => validateBounds(bad)).toThrow(ValidationError);
    }
  });

  it('boolean', () => {
    expect(validateBoolean(true, 'flag')).toBe(true);
    expect(() => validateBoolean('true', 'flag')).toThrow(ValidationError);
    expect(() => validateBoolean(1, 'flag')).toThrow(/flag/);
  });

  it('ChatGPT address: chatgpt.com over https only, normalized', () => {
    const id = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    expect(validateChatGptUrl(`https://chatgpt.com/c/${id}?model=x#y`)).toBe(`https://chatgpt.com/c/${id}`);
    expect(validateChatGptUrl(`chatgpt.com/c/${id}`)).toBe(`https://chatgpt.com/c/${id}`);
    for (const bad of ['http://chatgpt.com/', 'https://evil.example/', 'https://chatgpt.com.evil.example/', 'javascript:alert(1)', 'file:///etc/passwd', '', 5, null, undefined, `https://chatgpt.com/${'a'.repeat(3000)}`]) {
      expect(() => validateChatGptUrl(bad)).toThrow(ValidationError);
    }
  });

  it('external link: plain https only', () => {
    expect(validateExternalUrl('https://example.org/a?b=c')).toBe('https://example.org/a?b=c');
    for (const bad of ['http://example.org/', 'file:///x', 'javascript:alert(1)', 'mailto:a@b.c', 'ms-settings:privacy', 'https://u:p@example.org/', 'https://exa mple.org/', 'https://example.org/\n', '', 'https://', 5, null]) {
      expect(() => validateExternalUrl(bad)).toThrow(ValidationError);
      expect(isExternalUrl(bad)).toBe(false);
    }
    expect(isExternalUrl('https://example.org/')).toBe(true);
  });

  it('clipboard text: a string of reasonable size', () => {
    expect(validateClipboardText('')).toBe('');
    expect(validateClipboardText('line\nline')).toBe('line\nline');
    expect(() => validateClipboardText(5)).toThrow(ValidationError);
    expect(() => validateClipboardText('x'.repeat(5_000_001))).toThrow(ValidationError);
  });

  it('directory dialog options: only title and defaultPath, both short strings', () => {
    expect(validateDirectoryOptions(undefined)).toEqual({});
    expect(validateDirectoryOptions(null)).toEqual({});
    expect(validateDirectoryOptions({ title: 'Pick', defaultPath: '/home/me', properties: ['openFile'] })).toEqual({ title: 'Pick', defaultPath: '/home/me' });
    for (const bad of ['x', 5, [], { title: 5 }, { defaultPath: {} }, { title: 'a\0b' }, { defaultPath: 'a'.repeat(2000) }, { title: 'a'.repeat(300) }]) {
      expect(() => validateDirectoryOptions(bad)).toThrow(ValidationError);
    }
  });

  it('absolute path', () => {
    expect(validateAbsolutePath('/home/me/x')).toBe('/home/me/x');
    expect(validateAbsolutePath('C:\\Users\\me\\x', path.win32.isAbsolute)).toBe('C:\\Users\\me\\x');
    for (const bad of ['relative/path', '', 'a\0b', 5, null, `/${'a'.repeat(5000)}`]) {
      expect(() => validateAbsolutePath(bad)).toThrow(ValidationError);
    }
    expect(() => validateAbsolutePath('..\\x', path.win32.isAbsolute)).toThrow(ValidationError);
  });

  it('badge count', () => {
    expect(validateBadgeCount(0)).toBe(0);
    expect(validateBadgeCount(42)).toBe(42);
    for (const bad of [-1, 1.5, NaN, Infinity, '3', null, 100_000]) expect(() => validateBadgeCount(bad)).toThrow(ValidationError);
  });
});
