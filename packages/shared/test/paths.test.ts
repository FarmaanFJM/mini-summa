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

// Windows and WSL spellings of a folder. Pure string logic on Linux: SIMULATED, nothing here ran on Windows or WSL2.
describe('SIMULATED Windows: spellings of a root that people really type or paste', () => {
  const win = (input: string, env?: 'win') => normalizeRootInput(input, { hostPlatform: 'win32', env });

  it('reads the long-path prefix: \\\\?\\C:\\x, //?/C:/x and the device form \\\\.\\C:\\x are C:\\x', () => {
    const cases: [string, string][] = [
      ['\\\\?\\C:\\Dev\\App', 'C:\\Dev\\App'],
      ['//?/C:/Dev/App/', 'C:\\Dev\\App'],
      ['\\\\.\\c:\\dev\\app', 'C:\\dev\\app'],
      ['"\\\\?\\C:\\Dev\\App\\"', 'C:\\Dev\\App'],
    ];
    for (const [input, path] of cases) expect(win(input), input).toMatchObject({ ok: true, env: 'win', path });
  });

  it('reads \\\\?\\UNC\\wsl$\\<distro>\\... like \\\\wsl$\\<distro>\\..., and a share behind the prefix like a share', () => {
    expect(win('\\\\?\\UNC\\wsl$\\Ubuntu\\home\\me\\app')).toMatchObject({ ok: true, env: 'wsl:Ubuntu', path: '/home/me/app' });
    expect(win('//?/UNC/wsl.localhost/Debian/srv')).toMatchObject({ ok: true, env: 'wsl:Debian', path: '/srv' });
    expect(win('\\\\?\\UNC\\server\\share\\repo')).toMatchObject({ ok: false, message: expect.stringContaining('network share') });
  });

  it('refuses other uses of the prefix (a volume or a device is not a folder it can name)', () => {
    expect(win('\\\\?\\Volume{11111111-1111-4111-8111-111111111111}\\repo').ok).toBe(false);
    expect(win('\\\\?\\GLOBALROOT\\Device\\x').ok).toBe(false);
  });

  it('says what is wrong with a network share instead of calling it "not an absolute path"', () => {
    for (const input of ['\\\\fileserver\\share\\repo', '//fileserver/share/repo', '\\\\10.0.0.5\\code']) {
      const r = win(input);
      expect(r, input).toMatchObject({ ok: false, message: 'A folder on a network share (\\\\server\\share) is not supported as a project folder. Map the share to a drive letter such as Z:, or use a folder on a local drive.' });
    }
    // On a Linux host a double slash is just a POSIX path
    expect(normalizeRootInput('//home/me/app', { hostPlatform: 'linux' })).toMatchObject({ ok: true, env: 'posix', path: '/home/me/app' });
  });

  it('does not read C:dev (relative to the current folder of drive C) as C:\\dev, but still reads C: as the root of C', () => {
    expect(win('C:dev').ok).toBe(false);
    expect(win('C:dev\\app').ok).toBe(false);
    expect(win('C:')).toMatchObject({ ok: true, env: 'win', path: 'C:\\' });
    expect(win('c:/')).toMatchObject({ ok: true, env: 'win', path: 'C:\\' });
  });

  it('keeps spaces, non-ASCII letters, dots and parentheses of folder names, and a forward-slash path from Git Bash', () => {
    expect(win('C:\\Users\\Zoë Müller\\Mein Projekt (neu)\\app.v2')).toMatchObject({ ok: true, path: 'C:\\Users\\Zoë Müller\\Mein Projekt (neu)\\app.v2' });
    expect(win('c:/Users/日本語/リポジトリ/')).toMatchObject({ ok: true, path: 'C:\\Users\\日本語\\リポジトリ' });
    expect(win('C:\\\\Dev\\\\\\App\\.\\src\\..')).toMatchObject({ ok: true, path: 'C:\\Dev\\App' });
  });

  it('puts a distribution with dots, dashes or digits in its name into the environment id, as typed', () => {
    expect(win('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\my project')).toMatchObject({ ok: true, env: 'wsl:Ubuntu-22.04', path: '/home/me/my project' });
    expect(win('\\\\WSL$\\kali-linux\\root')).toMatchObject({ ok: true, env: 'wsl:kali-linux', path: '/root' });
    expect(win('\\\\wsl$\\Ubuntu')).toMatchObject({ ok: true, env: 'wsl:Ubuntu', path: '/' });
  });

  it('is one folder for the duplicate check whichever way it is spelled', () => {
    const key = (input: string) => {
      const r = win(input);
      if (!r.ok) throw new Error(r.message);
      return rootKey(r.env, r.path);
    };
    expect(key('\\\\?\\C:\\Dev\\App')).toBe(key('c:/dev/app/'));
    expect(key('\\\\wsl$\\Ubuntu\\home\\me\\app')).toBe(key('\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\'));
    expect(key('\\\\?\\UNC\\wsl$\\Ubuntu\\home\\me\\app')).toBe(key('\\\\wsl$\\Ubuntu\\home\\me\\app'));
    const mnt = normalizeRootInput('/mnt/c/Dev/App', { hostPlatform: 'win32', env: 'wsl:Ubuntu' });
    expect(mnt).toMatchObject({ ok: true, env: 'wsl:Ubuntu' });
    if (mnt.ok) expect(rootKey(mnt.env, mnt.path)).toBe(key('C:\\Dev\\App'));
  });
});
