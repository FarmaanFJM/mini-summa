// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findProtocolUrl, formatProtocolUrl, parseProtocolUrl } from '../../src/main/protocol.ts';

const SESSION = 'win|6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('parseProtocolUrl', () => {
  it('accepts every view with no parameters, with or without a trailing slash', () => {
    for (const view of ['workspace', 'activity', 'reports', 'settings']) {
      expect(parseProtocolUrl(`minisumma://${view}`)).toEqual({ ok: true, target: { view } });
      expect(parseProtocolUrl(`minisumma://${view}/`)).toEqual({ ok: true, target: { view } });
    }
  });

  it('is case-insensitive about the scheme and the view', () => {
    expect(parseProtocolUrl('MiniSumma://Workspace')).toEqual({ ok: true, target: { view: 'workspace' } });
  });

  it('maps every parameter onto the NavigationTarget field', () => {
    const r = parseProtocolUrl(`minisumma://reports?project=prj_1a2b&session=${encodeURIComponent(SESSION)}&report=rep_9&delivery=dlv_3&activity=act_7&section=hooks`);
    expect(r).toEqual({
      ok: true,
      target: { view: 'reports', projectId: 'prj_1a2b', sessionKey: SESSION, reportId: 'rep_9', deliveryId: 'dlv_3', activityId: 'act_7', section: 'hooks' },
    });
  });

  it('accepts WSL and posix session keys', () => {
    for (const key of ['wsl:Ubuntu-22.04|abc', 'posix|abc']) {
      const r = parseProtocolUrl(`minisumma://workspace?session=${encodeURIComponent(key)}`);
      expect(r.ok && r.target.sessionKey).toBe(key);
    }
  });

  it('trims surrounding whitespace (how a pasted link arrives)', () => {
    expect(parseProtocolUrl('  minisumma://settings?section=chatgpt \n')).toEqual({ ok: true, target: { view: 'settings', section: 'chatgpt' } });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['wrong scheme', 'https://workspace'],
    ['no authority', 'minisumma:workspace'],
    ['single slash', 'minisumma:/workspace'],
    ['unknown view', 'minisumma://admin'],
    ['view that is a path', 'minisumma://workspace/projects/1'],
    ['credentials', 'minisumma://user:pw@workspace'],
    ['port', 'minisumma://workspace:80'],
    ['fragment', 'minisumma://workspace#x'],
    ['unknown parameter', 'minisumma://workspace?foo=bar'],
    ['duplicate parameter', 'minisumma://workspace?project=a&project=b'],
    ['bad project id', 'minisumma://workspace?project=a%20b'],
    ['id with slash', 'minisumma://workspace?project=a/b'],
    ['empty id', 'minisumma://workspace?project='],
    ['session without environment', 'minisumma://workspace?session=abc'],
    ['session with unknown environment', 'minisumma://workspace?session=mac%7Cabc'],
    ['section with spaces', 'minisumma://settings?section=a%20b'],
    ['section in upper case', 'minisumma://settings?section=Hooks'],
    ['control character', 'minisumma://workspace\u0000'],
    ['embedded space', 'minisumma://work space'],
    ['percent-encoded view', 'minisumma://work%73pace'],
  ])('rejects %s', (_name, input) => {
    expect(parseProtocolUrl(input).ok).toBe(false);
  });

  it('rejects things that are not strings and over-long links', () => {
    expect(parseProtocolUrl(undefined).ok).toBe(false);
    expect(parseProtocolUrl(null).ok).toBe(false);
    expect(parseProtocolUrl(42).ok).toBe(false);
    expect(parseProtocolUrl(`minisumma://workspace?project=${'a'.repeat(3000)}`).ok).toBe(false);
  });

  it('gives a reason for a rejection', () => {
    const r = parseProtocolUrl('minisumma://admin');
    expect(!r.ok && r.reason).toMatch(/Unknown view/);
  });
});

describe('formatProtocolUrl', () => {
  it('round-trips every field', () => {
    const target = { view: 'reports', projectId: 'prj_1', sessionKey: SESSION, reportId: 'rep_2', deliveryId: 'dlv_3', activityId: 'act_4', section: 'a-b_c' } as const;
    const link = formatProtocolUrl(target);
    expect(link.startsWith('minisumma://reports?')).toBe(true);
    expect(link).not.toContain('|');
    expect(parseProtocolUrl(link)).toEqual({ ok: true, target });
  });

  it('writes a bare view when there is nothing else to say', () => {
    expect(formatProtocolUrl({ view: 'activity' })).toBe('minisumma://activity');
  });
});

describe('findProtocolUrl', () => {
  it('finds the link in a Windows second-instance argv', () => {
    expect(findProtocolUrl(['C:\\Program Files\\Mini-Summa\\Mini-Summa.exe', '--flag', 'minisumma://activity'])).toBe('minisumma://activity');
  });
  it('returns null when there is none', () => {
    expect(findProtocolUrl(['app', '--inspect', 'https://example.org'])).toBeNull();
    expect(findProtocolUrl([])).toBeNull();
  });
});
