// Where the tailscale program may come from (SEC-15 iii). The Windows rules are tested as plain strings, with the platform,
// the environment and the "does this file exist" answer passed in; only the POSIX service-level test starts a program.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsService } from '../../src/infra/settings.ts';
import { WINDOWS_INSTALL, tailscaleCandidates } from '../../src/infra/tailscale-bin.ts';
import { createTailscaleService } from '../../src/infra/tailscale.ts';
import { cleanupTempDirs, makeBase, tempDir } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';
import { FakeTailscale } from './tailscale-fake.ts';

/** A file check that knows a fixed set of files (case-insensitively, like Windows) and remembers every path it was asked about. */
function filesystem(files: string[]) {
  const asked: string[] = [];
  const known = new Set(files.map((f) => f.toLowerCase()));
  const exists = (file: string): boolean => { asked.push(file); return known.has(file.toLowerCase()); };
  return { exists, asked };
}

const win = (env: Record<string, string>, files: string[], override?: string) => {
  const fs_ = filesystem(files);
  return { result: tailscaleCandidates({ platform: 'win32', env, exists: fs_.exists, override }), asked: fs_.asked };
};

describe('on Windows', () => {
  it('prefers the install folder and lists PATH directories after it', () => {
    const { result } = win({ PATH: 'C:\\Windows;D:\\Tools;E:\\More' }, [WINDOWS_INSTALL, 'D:\\Tools\\tailscale.exe', 'E:\\More\\tailscale.exe']);
    expect(result).toEqual([WINDOWS_INSTALL, 'D:\\Tools\\tailscale.exe', 'E:\\More\\tailscale.exe']);
    expect(WINDOWS_INSTALL).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
  });

  it('searches PATH directories one by one when the install folder has no tailscale.exe', () => {
    const { result } = win({ PATH: 'C:\\Windows;D:\\Tools' }, ['D:\\Tools\\tailscale.exe']);
    expect(result).toEqual(['D:\\Tools\\tailscale.exe']);
  });

  it('never returns a bare name, so the operating system cannot pick a file from the current directory', () => {
    const none = win({ PATH: 'C:\\Windows;D:\\Tools' }, []);
    expect(none.result).toEqual([]);
    // even when a tailscale.exe sits in the current directory: nothing is ever asked about it
    const { result, asked } = win({ PATH: '' }, ['tailscale.exe', '.\\tailscale.exe', 'tailscale']);
    expect(result).toEqual([]);
    expect(asked).toEqual([WINDOWS_INSTALL]);
  });

  it('skips every PATH entry that Windows would read as the current directory, and asks only about absolute paths', () => {
    const entries = ['', ' ', '.', '..', '.\\bin', 'tools', 'bin\\sub', 'C:tools', 'C:', '\\tools', '\\\\server\\share\\bin', '"."', '"relative dir"', '%USERPROFILE%\\bin'];
    const exists = vi.fn(() => true); // would claim to find anything it is asked about
    const result = tailscaleCandidates({ platform: 'win32', env: { PATH: [...entries, 'C:\\Real', 'D:/Slashes/'].join(';') }, exists });
    const asked = exists.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(asked.every((p) => /^[A-Za-z]:\\/.test(p))).toBe(true);
    expect(result).toEqual([WINDOWS_INSTALL, 'C:\\Real\\tailscale.exe', 'D:\\Slashes\\tailscale.exe']);
  });

  it('understands quoted entries, trailing separators, mixed slashes and a case-different duplicate', () => {
    const { result } = win({ PATH: ' "D:\\Tools" ; d:\\tools\\ ;D:/Tools;"E:\\With Space\\bin"' }, ['D:\\Tools\\tailscale.exe', 'E:\\With Space\\bin\\tailscale.exe']);
    expect(result).toEqual(['D:\\Tools\\tailscale.exe', 'E:\\With Space\\bin\\tailscale.exe']);
  });

  it('does not list the install folder twice when it is also on PATH', () => {
    const { result } = win({ PATH: 'c:\\program files\\tailscale\\;C:\\Windows' }, [WINDOWS_INSTALL]);
    expect(result).toEqual([WINDOWS_INSTALL]);
  });

  it('finds the PATH variable under any capitalisation, as the Windows environment is case-insensitive', () => {
    for (const key of ['Path', 'PATH', 'path']) {
      expect(win({ [key]: 'D:\\Tools' }, ['D:\\Tools\\tailscale.exe']).result, key).toEqual(['D:\\Tools\\tailscale.exe']);
    }
    expect(win({}, ['D:\\Tools\\tailscale.exe']).result).toEqual([]);
  });

  it('looks only for tailscale.exe: a .cmd or .bat shim next to it is not started', () => {
    expect(win({ PATH: 'D:\\Tools' }, ['D:\\Tools\\tailscale.cmd', 'D:\\Tools\\tailscale.bat', 'D:\\Tools\\tailscale']).result).toEqual([]);
  });

  describe('with a program configured for tests or packaging', () => {
    it('uses an absolute path as given, and nothing else', () => {
      expect(win({ PATH: 'D:\\Tools' }, ['D:\\Tools\\tailscale.exe'], 'C:\\apps\\ts\\tailscale.exe').result).toEqual(['C:\\apps\\ts\\tailscale.exe']);
      expect(win({}, [], 'D:/apps/tailscale.exe').result).toEqual(['D:/apps/tailscale.exe']);
    });

    it('looks a bare name up in PATH only, adding .exe', () => {
      const files = ['D:\\Tools\\tailscale.exe', 'D:\\Tools\\other.exe'];
      expect(win({ PATH: 'D:\\Tools' }, files, 'tailscale').result).toEqual(['D:\\Tools\\tailscale.exe']);
      expect(win({ PATH: 'D:\\Tools' }, files, 'tailscale.exe').result).toEqual(['D:\\Tools\\tailscale.exe']);
      expect(win({ PATH: 'D:\\Tools' }, files, 'other').result).toEqual(['D:\\Tools\\other.exe']);
      expect(win({ PATH: '.;bin' }, ['tailscale.exe'], 'tailscale').result).toEqual([]);
    });

    it('refuses a relative path, because it would be resolved against the current directory', () => {
      for (const rel of ['.\\tailscale.exe', 'bin\\tailscale.exe', '..\\ts\\tailscale.exe', 'C:tailscale.exe', '\\ts\\tailscale.exe', 'bin/tailscale.exe']) {
        expect(win({ PATH: 'D:\\Tools' }, ['D:\\Tools\\tailscale.exe'], rel).result, rel).toEqual([]);
      }
    });
  });
});

describe('on Linux and macOS', () => {
  const posix = (env: Record<string, string>, files: string[], override?: string, platform: NodeJS.Platform = 'linux') => {
    const known = new Set(files);
    const asked: string[] = [];
    const result = tailscaleCandidates({ platform, env, override, exists: (f) => { asked.push(f); return known.has(f); } });
    return { result, asked };
  };

  it('searches absolute PATH directories in order and never the current directory', () => {
    const { result, asked } = posix({ PATH: '/usr/local/bin::.:relative/bin:/opt/ts/bin:/usr/local/bin' }, ['/usr/local/bin/tailscale', '/opt/ts/bin/tailscale', 'tailscale', './tailscale']);
    expect(result).toEqual(['/usr/local/bin/tailscale', '/opt/ts/bin/tailscale']);
    expect(asked.every((p) => p.startsWith('/'))).toBe(true);
  });

  it('finds nothing without a hit, and never falls back to a bare name', () => {
    expect(posix({ PATH: '/usr/bin' }, []).result).toEqual([]);
    expect(posix({}, ['/usr/bin/tailscale']).result).toEqual([]);
    expect(posix({ PATH: '/usr/bin' }, [], undefined, 'darwin').result).toEqual([]);
  });

  it('uses a configured program as given', () => {
    expect(posix({ PATH: '/usr/bin' }, ['/usr/bin/tailscale'], '/opt/fake/tailscale').result).toEqual(['/opt/fake/tailscale']);
  });
});

describe.skipIf(process.platform === 'win32')('the service starting a program (POSIX; Windows is covered by the string tests above)', () => {
  let base: TestBase | undefined;
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    base?.close();
    base = undefined;
    cleanupTempDirs();
  });

  function service() {
    base = makeBase();
    return createTailscaleService({ base, settings: createSettingsService({ base }), getPort: () => 4317, commandTimeoutMs: 5000 });
  }

  /** A program that would announce itself if it ever ran. */
  function decoyIn(dir: string): string {
    const marker = path.join(dir, 'decoy-ran.txt');
    fs.writeFileSync(path.join(dir, 'tailscale'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'the decoy ran');\nprocess.stdout.write('{}');\n`, { mode: 0o755 });
    return marker;
  }

  it('does not start a tailscale from the current directory, from "." or from empty or relative PATH entries', async () => {
    const decoyDir = tempDir('ms-decoy-');
    const marker = decoyIn(decoyDir);
    const emptyAbsolute = tempDir('ms-empty-');
    process.chdir(decoyDir);
    // an empty entry and "." both mean the current directory to the shell and to execvp; "relative-dir" is relative to it too
    vi.stubEnv('PATH', ['', '.', 'relative-dir', emptyAbsolute].join(':'));
    const s = await service().status({ refresh: true });
    expect(s.installed).toBe(false);
    expect(s.problem).toMatch(/not installed/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('starts the real program from an absolute PATH directory even when a decoy sits in the current directory', async () => {
    const decoyDir = tempDir('ms-decoy-');
    const marker = decoyIn(decoyDir);
    const fake = new FakeTailscale();
    const bin = tempDir('ms-realbin-');
    fs.copyFileSync(fake.bin, path.join(bin, 'tailscale'));
    fs.chmodSync(path.join(bin, 'tailscale'), 0o755);
    process.chdir(decoyDir);
    vi.stubEnv('PATH', ['.', '', bin].join(':'));
    const s = await service().status({ refresh: true });
    expect(s.installed).toBe(true);
    expect(s.dnsName).toBe('farmaan-pc.tail1234.ts.net');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fake.calls().length).toBeGreaterThan(0);
  });

  it('skips a tailscale on PATH that is not executable, like a shell does', async () => {
    const dir = tempDir('ms-noexec-');
    fs.writeFileSync(path.join(dir, 'tailscale'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    vi.stubEnv('PATH', dir);
    expect((await service().status({ refresh: true })).installed).toBe(false);
  });
});
