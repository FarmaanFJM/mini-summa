// @vitest-environment node
//
// What the Windows package promises, checked from the files that make it. Nothing here runs on Windows: these are text and
// byte-level checks of the configuration, the NSIS include script, the icons and (when a build exists) the unpacked Windows
// build. Each one guards a fact that the Windows audit (docs/audit/windows-desktop.md) found to matter and that a casual edit
// could break without any other test noticing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveLocations } from '../../src/main/locations.ts';
import { PROTOCOL_SCHEME } from '../../src/main/protocol.ts';
// @ts-expect-error plain .mjs without types; it only runs its CLI part when executed directly
import { drawMark, encodeIcoDib, TRAY_ICO_SIZES } from '../../scripts/make-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const yml = read('electron-builder.yml');
const nsh = read('build/installer.nsh');
const indexTs = read('src/main/index.ts');

/** The yml without comment lines, so a sentence about a setting is not mistaken for the setting. */
const ymlCode = yml.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
const setting = (name: string): string | undefined => new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm').exec(ymlCode)?.[1];

describe('identity', () => {
  it('uses one id for the installer (shortcut identity) and for the running app (toasts)', () => {
    // Windows shows a toast for the AppUserModelID that the Start menu shortcut carries. electron-builder puts `appId` on the
    // shortcut; the app must announce the same string before it creates a window or a notification.
    const appId = setting('appId');
    const announced = /app\.setAppUserModelId\('([^']+)'\)/.exec(indexTs)?.[1];
    expect(appId).toBe('com.minisumma.app');
    expect(announced).toBe(appId);
  });

  it('announces the id before anything that can show a window or a notification is created', () => {
    const at = indexTs.indexOf('app.setAppUserModelId(');
    for (const later of ['new Notification(', 'new ChatGptViews(', 'createMainWindow(', 'new Tray(']) {
      expect(indexTs.indexOf(later), later).toBeGreaterThan(at);
    }
  });
});

describe('install and uninstall policy', () => {
  it('never asks for administrator rights', () => {
    expect(setting('requestedExecutionLevel')).toBe('asInvoker');
    expect(setting('perMachine')).toBe('false');
    expect(setting('oneClick')).toBe('false');
    // "only for me" is the default; without this the install-mode page offers all users and a UAC prompt behind it.
    expect(setting('allowElevation')).toBe('false');
  });

  it('keeps the person\'s data on uninstall, and no script quietly deletes it', () => {
    expect(setting('deleteAppDataOnUninstall')).toBe('false');
    // commands only: comments and the text of the message box may name the folder
    const commands = nsh.split('\n').filter((line) => !line.trim().startsWith(';') && !/MessageBox/.test(line)).join('\n');
    expect(commands).not.toMatch(/^\s*(RMDir|Delete|Rename|CopyFiles)\b[^\n]*(APPDATA|USERPROFILE|LOCALAPPDATA|PROFILE)/im);
  });

  it('tells the person what stays, but only in a visible uninstall (not silent, not the old half of an update)', () => {
    const message = /MessageBox[^\n]*NOT deleted[^\n]*/.exec(nsh)?.[0] ?? '';
    expect(message).toContain('%APPDATA%\\Mini-Summa');
    expect(message).toContain('.claude\\settings.json');
    const guard = nsh.slice(0, nsh.indexOf(message));
    expect(guard.slice(guard.lastIndexOf('!macro customUnInstall'))).toMatch(/\$\{IfNot\} \$\{Silent\}\s*\n\s*\$\{AndIfNot\} \$\{isUpdated\}/);
  });

  it('does not publish, sign or auto-update', () => {
    expect(setting('publish')).toBe('null');
    expect(ymlCode).not.toMatch(/^\s*(certificateFile|certificatePassword|certificateSubjectName|azureSignOptions|sign):/m);
  });
});

describe('the NSIS include script', () => {
  it('is the file electron-builder.yml names, and defines exactly the macros electron-builder calls', () => {
    expect(setting('include')).toBe('build/installer.nsh');
    for (const macro of ['customInit', 'customInstall', 'customUnInstall']) expect(nsh).toMatch(new RegExp(`^!macro ${macro}\\s*$`, 'm'));
    expect([...nsh.matchAll(/^!macro (\w+)/gm)].map((m) => m[1]).sort()).toEqual(['customInit', 'customInstall', 'customUnInstall']);
  });

  it('refuses Windows before 10 version 1809 without ever hanging a silent install', () => {
    const init = /!macro customInit([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? '';
    expect(init).toContain('${AtLeastWin10}');
    expect(init).toMatch(/\$\{AtLeastBuild\} 17763/);
    for (const box of init.match(/MessageBox[^\n]*/g) ?? []) expect(box).toContain('/SD IDOK');
    expect((init.match(/SetErrorLevel [1-9]/g) ?? []).length).toBe(2);
  });

  it('registers the link scheme the app handles, with the command Electron itself writes', () => {
    const install = /!macro customInstall([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? '';
    expect(install).toContain(`"Software\\Classes\\${PROTOCOL_SCHEME}"`);
    expect(install).toContain('"URL Protocol" ""');
    expect(install).toContain(`'"$appExe" "%1"'`);
    // the uninstaller removes the same key, and only while it still points at this installation
    const uninstall = /!macro customUnInstall([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? '';
    expect(uninstall).toContain(`DeleteRegKey HKCU "Software\\Classes\\${PROTOCOL_SCHEME}"`);
    expect(uninstall).toMatch(/StrCmp \$R8 '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" "%1"' 0 \+2\s*\n\s*DeleteRegKey HKCU/);
  });

  it('is ASCII, so no console code page or input charset can change what it says', () => {
    expect([...nsh].filter((c) => c.charCodeAt(0) > 126).join('')).toBe('');
  });
});

describe('the hook runs as this executable in Node mode', () => {
  it('keeps the RunAsNode fuse on (every hook on every platform depends on it)', () => {
    // With the fuse off, `Mini-Summa.exe capture.mjs` would start the whole GUI app instead of the script: each hook call would
    // look like a second launch of the app. A "secure Electron" checklist says to turn this off; this is the reason not to.
    expect(ymlCode).not.toMatch(/runAsNode:\s*false/i);
    if (/^electronFuses:/m.test(ymlCode)) expect(ymlCode).toMatch(/runAsNode:\s*true/i);
  });

  it('ships the hook script as a real file beside the executable, and the icons the app asks for', () => {
    expect(ymlCode).toMatch(/from: \.\.\/\.\.\/packages\/claude-integration\/dist\/capture\.mjs\s*\n\s*to: hook\/capture\.mjs/);
    const filter = /from: resources\s*\n\s*to: icons\s*\n\s*filter:\s*\n((?:\s+- .+\n)+)/.exec(ymlCode)?.[1] ?? '';
    const shipped = [...filter.matchAll(/- (\S+)/g)].map((m) => m[1]);
    const l = resolveLocations({ moduleDir: '/a/resources/app.asar/out/main', isPackaged: true, resourcesPath: '/a/resources', platform: 'win32' });
    for (const file of [l.iconPath, ...l.trayIcons]) expect(shipped, path.basename(file)).toContain(path.basename(file));
    expect(shipped).toContain('tray@2x.png');
  });
});

describe('native terminal files', () => {
  it('unpacks the whole pty package, where the loader and the Worker find real files', () => {
    expect(yml).toContain('node_modules/@lydell/node-pty*/**');
    expect(yml).toContain('build/native/node_modules/@lydell/node-pty*/**');
    // beforePack stages the Windows package into build/native; the file set puts it at node_modules/ in the app
    expect(ymlCode).toMatch(/from: build\/native\/node_modules\/@lydell\/node-pty-win32-x64\s*\n\s*to: node_modules\/@lydell\/node-pty-win32-x64/);
  });

  const unpacked = path.join(root, 'release/win-unpacked/resources/app.asar.unpacked/node_modules/@lydell/node-pty-win32-x64');
  const built = fs.existsSync(unpacked);
  // Skipped (not passed) when no Windows build exists; `npm run dist:win` or `dist:dir` creates one.
  it.skipIf(!built)('has every native and helper file outside app.asar in the built Windows app', () => {
    const files = [
      'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node',
      'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe',
      'lib/windowsTerminal.js', 'lib/windowsConoutConnection.js', 'lib/worker/conoutSocketWorker.js', 'lib/conpty_console_list_agent.js',
    ];
    for (const f of files) expect(fs.existsSync(path.join(unpacked, f)), f).toBe(true);
    // debug symbols are build-time only
    expect(fs.readdirSync(path.join(unpacked, 'prebuilds/win32-x64')).filter((n) => n.endsWith('.pdb'))).toEqual([]);
  });

  const exe = path.join(root, 'release/win-unpacked/Mini-Summa.exe');
  it.skipIf(!fs.existsSync(exe))('leaves the RunAsNode fuse enabled in the built Windows executable', () => {
    // electron-fuses wire: a 32-character sentinel, then a version byte, a length byte, then one character per fuse
    // ('1' on, '0' off, 'r' removed), RunAsNode first. Found by scanning the file in chunks (it is ~250 MB).
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
    const fd = fs.openSync(exe, 'r');
    try {
      const chunk = Buffer.alloc(8 * 1024 * 1024 + sentinel.length + 4);
      let offset = 0;
      let wire: string | null = null;
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
        if (n <= sentinel.length) break;
        const at = chunk.subarray(0, n).indexOf(sentinel);
        if (at >= 0 && at + sentinel.length + 2 < n) {
          const length = chunk[at + sentinel.length + 1];
          wire = chunk.subarray(at + sentinel.length + 2, at + sentinel.length + 2 + length).toString('latin1');
          break;
        }
        offset += n - sentinel.length;
      }
      expect(wire, 'the fuse wire was not found in the executable').not.toBeNull();
      expect(wire![0]).toBe('1');
    } finally { fs.closeSync(fd); }
  });
});

describe('icons', () => {
  /** Frame sizes of an .ico, read from its directory. */
  const frames = (file: string): { size: number; bpp: number; png: boolean }[] => {
    const b = fs.readFileSync(path.join(root, file));
    expect(b.readUInt16LE(2)).toBe(1);
    return Array.from({ length: b.readUInt16LE(4) }, (_, i) => {
      const o = 6 + i * 16;
      const at = b.readUInt32LE(o + 12);
      return { size: b[o] || 256, bpp: b.readUInt16LE(o + 6), png: b.subarray(at, at + 4).toString('latin1') === '\x89PNG' };
    });
  };

  it('gives the application icon the sizes Windows asks for (16, 32, 48, 256)', () => {
    const sizes = frames('build/icon.ico').map((f) => f.size);
    for (const wanted of [16, 32, 48, 256]) expect(sizes).toContain(wanted);
  });

  it('gives the tray an icon with a frame for every display scale (100% to 200%) as plain bitmaps', () => {
    const f = frames('resources/tray.ico');
    expect(f.map((x) => x.size)).toEqual([16, 20, 24, 32, 48]);
    expect(f.every((x) => x.bpp === 32 && !x.png)).toBe(true);
  });

  it('keeps the committed tray.ico identical to what make-icons.mjs draws', () => {
    const expected = encodeIcoDib((TRAY_ICO_SIZES as number[]).map((size) => ({ size, rgba: drawMark(size) })));
    expect(fs.readFileSync(path.join(root, 'resources/tray.ico')).equals(expected)).toBe(true);
  });
});
