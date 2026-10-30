import { describe, expect, it } from 'vitest';
import { dataDirAdvice } from '../src/core.ts';

// SIMULATED Windows: a pure function of strings with an injected platform. Nothing here ran on Windows.
describe('dataDirAdvice (the data directory on Windows is protected by its folder permissions, not by chmod)', () => {
  const env = { USERPROFILE: 'C:\\Users\\Zoë Müller' };

  it('says nothing for the default folder, other folders inside the profile, and the profile itself', () => {
    for (const dir of [
      'C:\\Users\\Zoë Müller\\AppData\\Roaming\\Mini-Summa\\data',
      'c:\\users\\zoë müller\\AppData\\Local\\Mini-Summa\\data',
      'C:\\Users\\Zoë Müller\\Documents\\ms',
      'C:\\Users\\Zoë Müller',
    ]) expect(dataDirAdvice(dir, env, 'win32'), dir).toBeNull();
  });

  it('warns for a folder on another drive, in another profile, or on a share, and names the folder and the profile', () => {
    for (const dir of ['D:\\data\\ms', 'C:\\ProgramData\\Mini-Summa', 'C:\\Users\\Someone Else\\ms', 'C:\\Users\\Zoë MüllerX\\ms', '\\\\server\\share\\ms']) {
      const advice = dataDirAdvice(dir, env, 'win32');
      expect(advice, dir).toContain(dir);
      expect(advice, dir).toContain('outside your Windows profile (C:\\Users\\Zoë Müller)');
      expect(advice, dir).toContain('other accounts');
    }
    expect(dataDirAdvice('\\\\server\\share\\ms', env, 'win32')).toContain('network share');
    expect(dataDirAdvice('D:\\data\\ms', env, 'win32')).not.toContain('network share');
  });

  it('says nothing when the profile is unknown, and on other platforms (where the modes apply)', () => {
    expect(dataDirAdvice('D:\\data\\ms', {}, 'win32')).toBeNull();
    expect(dataDirAdvice('D:\\data\\ms', { USERPROFILE: '  ' }, 'win32')).toBeNull();
    expect(dataDirAdvice('/srv/ms', { USERPROFILE: 'C:\\Users\\me' }, 'linux')).toBeNull();
    expect(dataDirAdvice('/Users/me/ms', {}, 'darwin')).toBeNull();
  });
});
