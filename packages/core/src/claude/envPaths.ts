// Path rules between a Windows host and the WSL distributions on it. Pure string logic, no file system access.
//
//   C:\Users\me\Mini Summa    -> /mnt/c/Users/me/Mini Summa     (default automount root /mnt/; only the drive letter is
//                                                                lower-cased, the rest of a WSL path is case-sensitive)
//   \\wsl.localhost\Ubuntu\home\me\x  -> /home/me/x              (only for that same distribution)
//   /home/me/.claude (in Ubuntu)      -> \\wsl.localhost\Ubuntu\home\me\.claude
//
// `wslpath -u` inside the distribution is the better authority (it honours a custom automount root from wsl.conf);
// these functions are the fallback when it cannot be asked.
import path from 'node:path';
import type { EnvId } from '@minisumma/shared';

const UNC_WSL = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]+([^\\/]+)((?:[\\/].*)?)$/i;
const DRIVE = /^([A-Za-z]):(?:[\\/]+(.*))?$/;

/** Directory name for an environment under `<dataDir>/spool/`: `win`, `posix`, `wsl-Ubuntu`. */
export function envTag(env: EnvId): string {
  if (env === 'win' || env === 'posix') return env;
  return `wsl-${env.slice(4)}`.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export const isWindowsAbsolutePath = (p: string): boolean => DRIVE.test(p) || /^[\\/]{2}[^\\/]/.test(p);

export interface WindowsToWslOptions {
  /** WSL automount root, default `/mnt/`. */
  automount?: string;
  /** The distribution the result is meant for: a `\\wsl.localhost\<this one>\...` path maps back to a Linux path. */
  distro?: string;
}

/** A Windows path as seen from inside WSL, or null when this distribution cannot reach it. */
export function windowsPathToWsl(input: string, opts: WindowsToWslOptions = {}): string | null {
  let p = input.trim();
  if (p === '') return null;
  p = p.replace(/^\\\\\?\\(?!UNC\\)/i, ''); // \\?\C:\x -> C:\x
  const unc = UNC_WSL.exec(p);
  if (unc) {
    if (!opts.distro || unc[1].toLowerCase() !== opts.distro.toLowerCase()) return null;
    const rest = path.posix.normalize(`/${unc[2].replace(/\\/g, '/')}`);
    return rest.length > 1 ? rest.replace(/\/+$/, '') : rest;
  }
  const drive = DRIVE.exec(p);
  if (!drive) return null; // relative path, or a network share this distribution has no mount for
  const root = (opts.automount ?? '/mnt/').replace(/\/?$/, '/');
  const rest = path.posix.normalize(`/${(drive[2] ?? '').replace(/[\\/]+/g, '/')}`);
  const tail = rest === '/' ? '' : rest.replace(/\/+$/, '');
  return `${root}${drive[1].toLowerCase()}${tail}`;
}

/** A path inside a WSL distribution as the Windows side addresses it. */
export function wslPathToWindows(distro: string, posixPath: string): string {
  const rest = path.posix.normalize(posixPath.startsWith('/') ? posixPath : `/${posixPath}`);
  return `\\\\wsl.localhost\\${distro}${rest === '/' ? '' : rest.replace(/\//g, '\\')}`;
}
