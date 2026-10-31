// Is this process a hook call and not the application?
//
// Claude Code runs a hook as `Mini-Summa.exe <resources>\hook\capture.mjs --spool ... --handler h1 <event>` with
// ELECTRON_RUN_AS_NODE=1 set for that one command. While the RunAsNode fuse is on (it is: the build tests pin it), Electron then
// behaves as plain Node, never loads this application, and so never reaches the single-instance lock, a window or the tray.
//
// That protection comes from outside this code. If it ever stops (the fuse turned off, which "secure Electron" checklists
// recommend, or a change in Electron), the same command line would start the whole application: it would take the lock, hand its
// arguments to the running copy as a "second instance" and bring that window to the front on every tool call Claude makes. The
// check below makes such a process do nothing instead, and it runs before the first line of the application that has an effect.
//
// Pure string logic so it can be tested without Electron.

const CAPTURE_SCRIPT = 'capture.mjs';

const baseName = (arg: string): string => arg.split(/[\\/]/).pop()?.toLowerCase() ?? '';

/** `argv` is process.argv: the executable first, then its arguments. */
export function isHookInvocation(argv: readonly string[]): boolean {
  const args = argv.slice(1).filter((a): a is string => typeof a === 'string');
  if (args.some((a) => baseName(a) === CAPTURE_SCRIPT)) return true;
  // The script could be renamed in a later version; its options are what mark a hook call.
  return args.includes('--spool') && args.includes('--handler');
}
