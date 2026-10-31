// Normalization of project root paths typed by a person. Pure string logic, no file system access.
//
// A root belongs to one environment. The same folder has several spellings (C:\Dev\App, /mnt/c/Dev/App inside WSL,
// \\wsl$\Ubuntu\home\me\app from Windows); the verified registry in @minisumma/claude-integration canonicalizes them
// for matching. This module only cleans up user input and decides which environment a spelling implies.
import type { EnvId } from './env.ts';

export type RootInputResult =
  | { ok: true; env: EnvId; path: string; note: string | null }
  | { ok: false; needsEnv?: boolean; message: string };

export interface RootInputOptions {
  /** Platform of the machine running Mini-Summa. */
  hostPlatform: 'win32' | 'linux' | 'darwin';
  /** Environment the user picked explicitly, if any. */
  env?: EnvId;
}

// A drive, then a separator and the rest (or nothing: `C:` is taken as the drive's root). `C:dev` is a path relative to the current
// folder of drive C, which has no meaning here, so it does not match.
const WIN_DRIVE = /^([A-Za-z]):(?:[\\/]+(.*))?$/;
const UNC_WSL = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]+([^\\/]+)((?:[\\/].*)?)$/i;
// \\?\C:\x and \\?\UNC\server\share\x (also written //?/...) are the long-path spellings of C:\x and \\server\share\x; the device
// form \\.\ is read the same way. Anything else behind the prefix (\\?\Volume{...}, \\?\GLOBALROOT) is left as it is.
const LONG_PATH = /^[\\/]{2}[?.][\\/](?:UNC[\\/](.*)|([A-Za-z]:(?:[\\/].*)?))$/is;
const UNC_SHARE = /^[\\/]{2}[^\\/]/;

function withoutLongPathPrefix(p: string): string {
  const m = LONG_PATH.exec(p);
  if (!m) return p;
  return m[1] !== undefined ? `\\\\${m[1]}` : m[2];
}

function cleanPosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

function cleanWindows(drive: string, rest: string): string {
  const parts: string[] = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return `${drive.toUpperCase()}:\\${parts.join('\\')}`.replace(/\\$/, parts.length ? '' : '\\');
}

export function normalizeRootInput(raw: string, opts: RootInputOptions): RootInputResult {
  const typed = (raw ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (typed === '') return { ok: false, message: 'Enter the folder that holds the repository.' };
  if (/[\0\r\n]/.test(typed)) return { ok: false, message: 'The path contains characters that are not allowed.' };
  const input = withoutLongPathPrefix(typed);

  const unc = UNC_WSL.exec(input);
  if (unc) {
    const env = `wsl:${unc[1]}` as EnvId;
    return { ok: true, env, path: cleanPosix(unc[2].replace(/\\/g, '/') || '/'), note: `Read as a path inside WSL (${unc[1]}).` };
  }
  const drive = WIN_DRIVE.exec(input);
  if (drive) {
    if (opts.env && opts.env !== 'win') {
      return { ok: false, message: `A Windows drive path cannot belong to ${opts.env}. Choose Windows, or enter the path as /mnt/${drive[1].toLowerCase()}/... inside WSL.` };
    }
    return { ok: true, env: 'win', path: cleanWindows(drive[1], drive[2] ?? ''), note: null };
  }
  // A share is a full path, so the generic "enter an absolute path" would be wrong. cmd.exe, which starts the npm launcher of
  // Claude Code, cannot use a UNC folder as its working directory and falls back to the Windows folder, so none is accepted.
  if (UNC_SHARE.test(input) && (input.startsWith('\\\\') || opts.hostPlatform === 'win32')) {
    return { ok: false, message: 'A folder on a network share (\\\\server\\share) is not supported as a project folder. Map the share to a drive letter such as Z:, or use a folder on a local drive.' };
  }
  if (input.startsWith('/')) {
    const posix = cleanPosix(input);
    const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posix);
    if (opts.env) {
      if (opts.env === 'win') return { ok: false, message: 'That is a POSIX path. Enter it as a Windows path like C:\\Dev\\App, or choose a WSL distribution.' };
      return { ok: true, env: opts.env, path: posix, note: mnt && opts.env.startsWith('wsl:') ? `This folder is on the Windows drive ${mnt[1].toUpperCase()}:, reached through WSL.` : null };
    }
    if (opts.hostPlatform === 'win32') {
      return { ok: false, needsEnv: true, message: 'This looks like a Linux path. Choose which WSL distribution it belongs to.' };
    }
    return { ok: true, env: 'posix', path: posix, note: null };
  }
  return { ok: false, message: 'Enter an absolute path (for example C:\\Dev\\App or /home/me/app).' };
}

/** Same folder, different spelling? Compares within the namespace the roots declare, never across unrelated ones. */
export function rootKey(env: EnvId, path: string): string {
  if (env === 'win') return `win:${path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()}`;
  const posix = cleanPosix(path);
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posix);
  if (m && env.startsWith('wsl:')) return `win:${m[1].toLowerCase()}:${(m[2] ?? '').replace(/\//g, '\\').toLowerCase()}`;
  return `${env}:${posix}`;
}
