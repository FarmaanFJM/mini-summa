// A thin, replaceable layer over @lydell/node-pty plus the two pure pieces that go with it: how a Claude command line is
// turned into a PTY launch (native, .cmd shim, WSL) and the bounded scrollback a terminal can be replayed from.
//
// Windows note: ConPTY is what node-pty uses on Windows (its `useConpty` option is deprecated and ignored), so no
// ConPTY-specific option is passed. The Windows paths in this file (the .cmd shim command line, wsl.exe) are built by
// pure functions that are unit-tested on Linux by string comparison. They have NOT been run on Windows.
import { createRequire } from 'node:module';
import { CoreError } from '../errors.ts';
import type { EnvironmentsService } from '../contracts.ts';

// ---------------------------------------------------------------------------------------------------------------
// PTY process abstraction

export interface Disposable { dispose(): void }

/** `exitCode` is null when the process was ended by a signal, `signal` is null when it exited by itself. */
export interface PtyExitInfo { exitCode: number | null; signal: number | null }

export interface PtyProcess {
  /**
   * The process id. ConPTY connects the process asynchronously (the conout worker must be ready first), so on Windows this is 0
   * for a moment after spawn() and only becomes the real id with the first output: callers read it again later, never once.
   */
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (info: PtyExitInfo) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** `signal` is ignored on Windows, where a PTY can only be terminated. */
  kill(signal?: string): void;
}

export interface PtySpawnRequest {
  file: string;
  /** An array, or (Windows only) a pre-escaped command line that is passed to CreateProcess untouched. */
  args: string[] | string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Tests inject fakes here; production uses {@link createNodePtySpawner}. */
export interface PtySpawner { spawn(req: PtySpawnRequest): PtyProcess }

type NodePtyModule = typeof import('@lydell/node-pty');
type NodePtyHandle = ReturnType<NodePtyModule['spawn']>;

let cachedModule: NodePtyModule | null = null;

/**
 * Loaded on first use, not at import time: if the platform-specific binary is missing the failure shows up as a clear
 * "could not start the terminal" for that one session instead of taking the whole core down at startup.
 */
function loadNodePty(): NodePtyModule {
  if (!cachedModule) cachedModule = createRequire(import.meta.url)('@lydell/node-pty') as NodePtyModule;
  return cachedModule;
}

function adapt(handle: NodePtyHandle): PtyProcess {
  return {
    get pid() { return handle.pid; },
    onData: (listener) => handle.onData(listener),
    onExit: (listener) => handle.onExit((e) => listener(e.signal ? { exitCode: null, signal: e.signal } : { exitCode: e.exitCode, signal: null })),
    write: (data) => handle.write(data),
    resize: (cols, rows) => handle.resize(cols, rows),
    kill: (signal) => { if (signal === undefined || process.platform === 'win32') handle.kill(); else handle.kill(signal); },
  };
}

/** A terminal that never started: it prints why and exits with code 1, like a shell that cannot find the program. */
function failedToStart(reason: string): PtyProcess {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(info: PtyExitInfo) => void> = [];
  let ended = false;
  setTimeout(() => {
    ended = true;
    for (const l of dataListeners) l(`${reason}\r\n`);
    for (const l of exitListeners) l({ exitCode: 1, signal: null });
  }, 0);
  return {
    pid: 0,
    onData: (l) => { dataListeners.push(l); return { dispose: () => { dataListeners.splice(dataListeners.indexOf(l), 1); } }; },
    onExit: (l) => { if (ended) l({ exitCode: 1, signal: null }); else exitListeners.push(l); return { dispose: () => { exitListeners.splice(exitListeners.indexOf(l), 1); } }; },
    write: () => {}, resize: () => {}, kill: () => {},
  };
}

/**
 * `encoding: 'utf8'` is what makes node-pty hand out strings on Linux and macOS. On Windows the ConPTY agent always decodes
 * UTF-8 itself and prints "Setting encoding on Windows is not supported" to the console for every terminal it starts when the
 * option is given (windowsTerminal.js of @lydell/node-pty-win32-x64), so it is left out there. `platform` is a test seam.
 */
export function createNodePtySpawner(load: () => NodePtyModule = loadNodePty, platform: NodeJS.Platform = process.platform): PtySpawner {
  return {
    spawn(req) {
      const pty = load();
      try {
        return adapt(pty.spawn(req.file, req.args, {
          name: 'xterm-256color',
          cols: req.cols,
          rows: req.rows,
          cwd: req.cwd,
          env: req.env,
          ...(platform === 'win32' ? {} : { encoding: 'utf8' }),
        }));
      } catch (error) {
        // On POSIX node-pty forks first, so a program that cannot be executed is an immediate exit with a message. On Windows the
        // ConPTY agent throws ("File not found") before any process exists. Both are reported the same way: as an exit.
        if (platform !== 'win32') throw error;
        return failedToStart(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Launch plans: native, .cmd shim, WSL

export type ClaudeCommand = NonNullable<Awaited<ReturnType<EnvironmentsService['claudeCommand']>>>;

export interface LaunchPlan {
  file: string;
  args: string[] | string;
  /** Working directory of the PTY process as the HOST sees it. */
  cwd: string;
}

export interface LaunchOptions {
  claude: ClaudeCommand;
  /** Arguments for claude itself (after any `claude.prefixArgs`). */
  claudeArgs: readonly string[];
  /** Directory the session works in, in the namespace of its environment (a POSIX path for WSL). */
  cwd: string;
  /** A directory that exists on the host; used as the PTY's own cwd for WSL, whose real cwd is passed to wsl.exe. */
  hostCwd: string;
  platform: NodeJS.Platform;
  /** cmd.exe path used for .cmd shims (default `cmd.exe`). On Windows the caller passes the full path (windowsPrograms.ts). */
  comspec?: string;
  /** wsl.exe path used for WSL (default `wsl.exe`). On Windows the caller passes the full path (windowsPrograms.ts). */
  wslExe?: string;
}

const CMD_SHIM = /\.(cmd|bat)$/i;
// Inside a cmd.exe command line a double quote ends the quoting and % expands variables; neither can be escaped
// reliably, so an argument containing one is refused instead of being passed on in a form that could run something else.
const CMD_UNSAFE = /["%\r\n\0]/;

function quoteForCmd(arg: string): string {
  if (CMD_UNSAFE.test(arg)) {
    throw new CoreError(422, 'unsafe_argument',
      'A session name or path contains a quote or percent sign, which cannot be passed safely to Claude when it is started through a .cmd launcher. Remove that character or install the native claude.exe.');
  }
  if (arg !== '' && !/[\s&|<>^()!,;=]/.test(arg)) return arg;
  // A backslash run at the end would escape the closing quote when the program parses its own command line.
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * How to start `claude` inside a PTY.
 *  - WSL:        wsl.exe -d <distro> --cd <cwd> --exec <claude> <args...>   (the real cwd goes to wsl.exe)
 *  - Windows .cmd/.bat shim (npm installs): cmd.exe /d /s /c "<shim> <args...>"  as one verbatim command line
 *  - everything else: the executable with prefix args and args as an array
 */
export function buildLaunchPlan(opts: LaunchOptions): LaunchPlan {
  const { claude, claudeArgs, cwd, platform } = opts;
  if (claude.wslDistro) {
    return {
      file: opts.wslExe ?? 'wsl.exe',
      args: ['-d', claude.wslDistro, '--cd', cwd, '--exec', claude.file, ...claude.prefixArgs, ...claudeArgs],
      cwd: opts.hostCwd,
    };
  }
  if (platform === 'win32' && CMD_SHIM.test(claude.file)) {
    const inner = [claude.file, ...claude.prefixArgs, ...claudeArgs].map(quoteForCmd).join(' ');
    return { file: opts.comspec ?? 'cmd.exe', args: `/d /s /c "${inner}"`, cwd };
  }
  return { file: claude.file, args: [...claude.prefixArgs, ...claudeArgs], cwd };
}

// ---------------------------------------------------------------------------------------------------------------
// Scrollback

/** About 2 MB of text per terminal. */
export const DEFAULT_SCROLLBACK_CHARS = 2_000_000;

/**
 * The most recent output of a terminal, as numbered chunks. `seq` counts chunks since the terminal started (1, 2, 3...)
 * and never goes backwards, so a client that holds a snapshot with seq N ignores live chunks <= N. When the cap is
 * exceeded whole chunks are dropped from the FRONT; a chunk is never cut. (A single chunk bigger than the cap is kept
 * until the next one arrives: PTY reads are far smaller than the cap, so this does not happen in practice.)
 */
export class ScrollbackBuffer {
  private chunks: string[] = [];
  private head = 0;
  private chars = 0;
  private lastSeq = 0;

  constructor(readonly maxChars: number = DEFAULT_SCROLLBACK_CHARS) {
    if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be a positive integer');
  }

  /** Adds output and returns its sequence number. Empty output is not a chunk and returns the current seq. */
  append(data: string): number {
    if (data === '') return this.lastSeq;
    this.lastSeq += 1;
    this.chunks.push(data);
    this.chars += data.length;
    while (this.chars > this.maxChars && this.chunks.length - this.head > 1) {
      this.chars -= this.chunks[this.head].length;
      this.chunks[this.head] = '';
      this.head += 1;
    }
    if (this.head > 256 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return this.lastSeq;
  }

  /** Everything retained, plus the seq of the newest chunk (0 when nothing was ever appended). */
  snapshot(): { data: string; seq: number } {
    return { data: this.head === 0 ? this.chunks.join('') : this.chunks.slice(this.head).join(''), seq: this.lastSeq };
  }

  get seq(): number { return this.lastSeq; }
  /** Characters currently retained. */
  get size(): number { return this.chars; }
}
