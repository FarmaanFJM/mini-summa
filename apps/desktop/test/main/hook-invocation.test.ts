// @vitest-environment node
//
// A hook runs `Mini-Summa.exe capture.mjs ...` and must never start a second Mini-Summa window or instance. Electron's RunAsNode
// fuse is what normally guarantees that (the packaging test pins the fuse); this is the second line of defence if it ever fails.
// SIMULATED: the argument lists are the ones the hook command builds for Windows (packages/claude-integration setup.mjs) and for
// POSIX; nothing here ran on Windows.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isHookInvocation } from '../../src/main/hookInvocation.ts';

const EXE = 'C:\\Users\\José Müller\\AppData\\Local\\Programs\\Mini-Summa\\Mini-Summa.exe';
const SCRIPT = 'C:\\Users\\José Müller\\AppData\\Local\\Programs\\Mini-Summa\\resources\\hook\\capture.mjs';
const hookArgs = (script: string) => [EXE, script, '--spool', 'C:\\Users\\José Müller\\AppData\\Roaming\\Mini-Summa\\data\\spool\\win', '--registry', 'C:\\Users\\José Müller\\AppData\\Roaming\\Mini-Summa\\data\\registry.json', '--env', 'win', '--handler', 'h1', 'SessionStart'];

describe('isHookInvocation', () => {
  it('recognises the hook command line Windows gets, with spaces and accents in the paths', () => {
    expect(isHookInvocation(hookArgs(SCRIPT))).toBe(true);
  });

  it('recognises the POSIX and WSL forms and a relative script path', () => {
    expect(isHookInvocation(['/opt/Mini-Summa/mini-summa', '/opt/Mini-Summa/resources/hook/capture.mjs', '--spool', '/tmp/s', '--env', 'posix', '--handler', 'h1', 'Stop'])).toBe(true);
    expect(isHookInvocation([EXE, 'resources\\hook\\capture.mjs', '--spool', 'x'])).toBe(true);
    expect(isHookInvocation([EXE, 'CAPTURE.MJS'])).toBe(true);
  });

  it('recognises a hook call by its options if the script is ever renamed', () => {
    expect(isHookInvocation([EXE, 'C:\\x\\record.mjs', '--spool', 'C:\\s', '--handler', 'h1', 'Notification'])).toBe(true);
  });

  it('leaves every way of starting the application itself alone', () => {
    expect(isHookInvocation([EXE])).toBe(false);
    expect(isHookInvocation([EXE, 'minisumma://reports?project=prj_1'])).toBe(false);
    expect(isHookInvocation([EXE, '--no-sandbox', '--disable-gpu'])).toBe(false);
    expect(isHookInvocation([EXE, '--updated'])).toBe(false);
    expect(isHookInvocation([EXE, '--spool', 'C:\\only-one-of-the-two-options'])).toBe(false);
    expect(isHookInvocation([EXE, 'C:\\capture.mjs\\notes.txt'])).toBe(false); // a folder that happens to be called that
    expect(isHookInvocation([])).toBe(false);
  });

  it('does not look at the executable itself', () => {
    expect(isHookInvocation(['C:\\tools\\capture.mjs.exe'])).toBe(false);
    expect(isHookInvocation(['C:\\tools\\capture.mjs'])).toBe(false);
  });
});

describe('where the check runs in the main process', () => {
  const index = readFileSync(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)), 'utf8');
  const at = index.indexOf('if (isHookInvocation(process.argv)) process.exit(0);');

  it('exists, and exits without doing anything', () => {
    expect(at).toBeGreaterThan(0);
  });

  it('comes before everything that touches the profile, takes a lock, opens a window or registers a handler', () => {
    // These are the effects a stray second process must not have. The single-instance lock is the last of them, far below.
    for (const effect of [
      'readTestSeams(', "app.setName('Mini-Summa')", 'fs.mkdirSync(', 'app.setPath(', 'app.setAppUserModelId(', 'createFileLogger(',
      'app.requestSingleInstanceLock()', 'app.setAsDefaultProtocolClient(', 'new BrowserWindow', 'createMainWindow(', 'new Tray(', 'new Notification(',
    ]) {
      const first = index.indexOf(effect);
      if (first >= 0) expect(first, effect).toBeGreaterThan(at);
    }
  });
});
