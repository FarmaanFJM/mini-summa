// Where the `tailscale` program is, decided without ever involving the current directory.
//
// Why this exists: on Windows, starting a bare `tailscale` lets libuv look in the current directory first, so a file
// named tailscale.exe next to whatever folder the app happened to be started from would run instead of the real one. So
// every candidate returned here is an absolute path that was checked to exist, built either from the install location
// or from PATH entries that are absolute directories. Empty entries, ".", relative entries and drive-relative entries
// (`C:tools`) in PATH all mean "the current directory" to Windows, so they are skipped.
//
// Pure on purpose: platform, environment and the file check are passed in, so every rule is testable as plain strings.
import path from 'node:path';

export const WINDOWS_INSTALL = 'C:\\Program Files\\Tailscale\\tailscale.exe';

export interface BinSearch {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** True when a regular file exists at this absolute path (on POSIX: an executable one). Never asked about a relative path. */
  exists(file: string): boolean;
  /** CoreOptions.overrides.tailscaleBin. When set it is the only candidate. */
  override?: string | undefined;
}

/** `C:\\...` or `C:/...`. Not `C:tools` (relative to the current directory of drive C), not `\\tools`, not UNC. */
const isWindowsAbsolute = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p);

function pathValue(env: Record<string, string | undefined>): string {
  // The variable is "Path" on most Windows machines and the process environment there is case-insensitive.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key !== undefined ? env[key] : undefined) ?? '';
}

function searchWindows(name: string, env: BinSearch['env'], exists: BinSearch['exists']): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of pathValue(env).split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!isWindowsAbsolute(dir)) continue;
    const candidate = path.win32.join(dir, name);
    const key = candidate.toLowerCase();
    if (seen.has(key) || !exists(candidate)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function searchPosix(name: string, env: BinSearch['env'], exists: BinSearch['exists']): string[] {
  const out: string[] = [];
  for (const dir of pathValue(env).split(':')) {
    if (!path.posix.isAbsolute(dir)) continue; // an empty entry or a relative one would mean the current directory
    const candidate = path.posix.join(dir, name);
    if (!out.includes(candidate) && exists(candidate)) out.push(candidate);
  }
  return out;
}

/** Absolute paths to try, best first. Empty means Tailscale is not installed (or not where Mini-Summa may look). */
export function tailscaleCandidates(s: BinSearch): string[] {
  if (s.platform === 'win32') {
    if (s.override) {
      if (isWindowsAbsolute(s.override)) return [s.override];
      // A bare name or a relative path would be resolved against the current directory: look it up in PATH instead.
      const bare = /[\\/]/.test(s.override) ? null : /\.[A-Za-z0-9]+$/.test(s.override) ? s.override : `${s.override}.exe`;
      return bare === null ? [] : searchWindows(bare, s.env, s.exists);
    }
    const out: string[] = [];
    if (s.exists(WINDOWS_INSTALL)) out.push(WINDOWS_INSTALL);
    for (const found of searchWindows('tailscale.exe', s.env, s.exists)) {
      if (!out.some((o) => o.toLowerCase() === found.toLowerCase())) out.push(found);
    }
    return out;
  }
  if (s.override) return [s.override];
  return searchPosix('tailscale', s.env, s.exists);
}
