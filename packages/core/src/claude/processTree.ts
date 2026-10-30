// Parent links of processes, for one question: is the process Claude lists for a session the terminal's own process, or one the
// terminal started (a launcher script that did not exec, an npm shim)? Exact equality is the common case and needs none of this.
//
// Answers: true = `pid` is `ancestor` or below it; false = known not to be; null = cannot be told (the process is gone, the
// platform has no cheap way, the link could not be read). A caller must treat null as "no evidence", never as "no".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** The parent of a process: a number, 0/1 for "the top", or undefined when it cannot be read. */
export type ParentPid = (pid: number) => number | undefined;

const MAX_DEPTH = 16;

function linuxParent(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) S ppid ...": comm may contain spaces and parentheses, so cut after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number.parseInt(rest[1] ?? '', 10);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch { return undefined; }
}

function psParent(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const ppid = Number.parseInt(out.trim(), 10);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch { return undefined; }
}

/** Linux reads /proc, macOS asks ps; Windows has no cheap and reliable way from here, so it never claims anything. */
export function defaultParentPid(platform: NodeJS.Platform = process.platform): ParentPid {
  if (platform === 'linux') return linuxParent;
  if (platform === 'darwin') return psParent;
  return () => undefined;
}

/**
 * Is `pid` the ancestor itself or a process it started? The whole chain is followed (so a process of somebody else is a definite
 * false), but only a match within `maxMatchDepth` parent links counts as true: a deeper descendant is "cannot be told" (null), because
 * it may be a program a tool of the session started rather than what the terminal runs.
 */
export function isSameOrBelow(pid: number, ancestor: number, parentOf: ParentPid, maxMatchDepth: number = MAX_DEPTH): boolean | null {
  let current = pid;
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (current === ancestor) return depth <= maxMatchDepth ? true : null;
    const parent = parentOf(current);
    if (parent === undefined) return null;
    if (parent <= 1) return false;
    current = parent;
  }
  return null;
}
