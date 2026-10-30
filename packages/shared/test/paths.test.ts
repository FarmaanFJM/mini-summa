import { describe, expect, it } from 'vitest';
import { normalizeRootInput, rootKey } from '../src/index.ts';

describe('normalizeRootInput', () => {
  it('reads a Windows path', () => {
    expect(normalizeRootInput('c:/Dev/App/', { hostPlatform: 'win32' })).toMatchObject({ ok: true, env: 'win', path: 'C:\\Dev\\App' });
    expect(normalizeRootInput('"D:\\Work\\x\\..\\y"', { hostPlatform: 'win32' })).toMatchObject({ ok: true, env: 'win', path: 'D:\\Work\\y' });
    expect(normalizeRootInput('C:\\', { hostPlatform: 'win32' })).toMatchObject({ ok: true, env: 'win', path: 'C:\\' });
  });

  it('reads a WSL UNC path as a path inside that distribution', () => {
    expect(normalizeRootInput('\\\\wsl$\\Ubuntu\\home\\me\\app', { hostPlatform: 'win32' })).toMatchObject({ ok: true, env: 'wsl:Ubuntu', path: '/home/me/app' });
    expect(normalizeRootInput('\\\\wsl.localhost\\Debian\\srv', { hostPlatform: 'win32' })).toMatchObject({ ok: true, env: 'wsl:Debian', path: '/srv' });
  });

  it('refuses to guess the distribution for a Linux path typed on Windows', () => {
    const r = normalizeRootInput('/home/me/app', { hostPlatform: 'win32' });
    expect(r).toMatchObject({ ok: false, needsEnv: true });
    expect(normalizeRootInput('/home/me/app', { hostPlatform: 'win32', env: 'wsl:Ubuntu' })).toMatchObject({ ok: true, env: 'wsl:Ubuntu' });
  });

  it('uses posix on Linux and macOS', () => {
    expect(normalizeRootInput('/home/me/app/', { hostPlatform: 'linux' })).toMatchObject({ ok: true, env: 'posix', path: '/home/me/app' });
  });

  it('rejects relative paths, empty input and mismatched environments', () => {
    expect(normalizeRootInput('repo/app', { hostPlatform: 'linux' }).ok).toBe(false);
    expect(normalizeRootInput('   ', { hostPlatform: 'linux' }).ok).toBe(false);
    expect(normalizeRootInput('C:\\x', { hostPlatform: 'win32', env: 'wsl:Ubuntu' }).ok).toBe(false);
    expect(normalizeRootInput('/x', { hostPlatform: 'win32', env: 'win' }).ok).toBe(false);
    expect(normalizeRootInput('C:\\x\0y', { hostPlatform: 'win32' }).ok).toBe(false);
  });
});

describe('rootKey', () => {
  it('treats the same folder spelled two ways as one', () => {
    expect(rootKey('win', 'C:\\Dev\\App')).toBe(rootKey('wsl:Ubuntu', '/mnt/c/dev/app'));
    expect(rootKey('win', 'C:\\Dev\\App\\')).toBe(rootKey('win', 'c:/dev/app'));
  });
  it('keeps identical-looking Linux paths in different environments apart', () => {
    expect(rootKey('wsl:Ubuntu', '/home/me/app')).not.toBe(rootKey('wsl:Debian', '/home/me/app'));
    expect(rootKey('wsl:Ubuntu', '/home/me/app')).not.toBe(rootKey('posix', '/home/me/app'));
  });
});
