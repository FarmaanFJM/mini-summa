// Running small helper commands (`claude --version`, `wsl.exe -l -q`, ...) behind one injectable function, so the
// environment detection can be tested without Windows, WSL or a real Claude Code installation.
//
// Output decoding matters here: `wsl.exe` prints UTF-16LE (usually with NULs between the characters, sometimes with a
// byte order mark and CR LF line ends) unless WSL_UTF8=1 is set. Everything the default runner returns is decoded with
// decodeCommandOutput, so callers always see plain text.
import { execFile } from 'node:child_process';
import { systemProgramPath } from './windowsPrograms.ts';

export interface CommandOptions {
  timeoutMs: number;
  /** Extra environment variables for this one call, merged over the current environment. */
  env?: Record<string, string>;
  /**
   * Windows only: pass the arguments to CreateProcess exactly as given, joined by spaces, without quoting them. Needed for
   * `cmd.exe /d /s /c "<line>"`, whose quoting rules are cmd's own. Ignored on other platforms.
   */
  windowsVerbatimArguments?: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Exit code. null = the process could not be started, or was killed (timeout): see `error`. */
  code: number | null;
  error?: string;
}

/** Never rejects for a failing command: a failure is a result. (Injected fakes may reject; callers guard anyway.) */
export type CommandRunner = (file: string, args: string[], opts: CommandOptions) => Promise<CommandResult>;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Odd-position NUL bytes are what ASCII text looks like in UTF-16LE. */
function looksLikeUtf16le(b: Buffer): boolean {
  if (b.length < 4 || b.length % 2 !== 0) return false;
  let oddZeros = 0;
  let evenZeros = 0;
  const pairs = b.length / 2;
  for (let i = 0; i < b.length; i += 2) {
    if (b[i] === 0) evenZeros++;
    if (b[i + 1] === 0) oddZeros++;
  }
  return oddZeros >= pairs * 0.4 && evenZeros === 0;
}

/**
 * Turns the raw bytes of a command's output into text. UTF-16LE (with or without a byte order mark, as wsl.exe prints
 * it) and UTF-8 (with or without a BOM) are recognised; anything else is read as UTF-8.
 */
export function decodeCommandOutput(input: Uint8Array | string | null | undefined): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (looksLikeUtf16le(b)) return b.toString('utf16le');
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('utf8');
}

export interface CommandRunnerDeps {
  /** The platform whose process rules apply (a test seam). */
  platform?: NodeJS.Platform;
  /**
   * Ends a process together with everything it started, before the process itself is killed. Used only on Windows, where a
   * deadline must reach the children too (a test seam; the default is `taskkill /T /F`).
   */
  killTree?: (pid: number) => Promise<unknown>;
}

/**
 * A runner: execFile with a deadline, no shell, no console window on Windows, and an input that is closed at once, so a program
 * that stops to read from it (a prompt) ends instead of waiting for ever.
 *
 * The deadline on Windows is kept here instead of in execFile because of the npm launcher: `claude.cmd` is a batch file, started
 * as `cmd.exe /d /s /c ...`, and killing cmd.exe at the deadline leaves the node.exe behind it running. That process still holds
 * the pipes execFile waits on, so the callback would never come and whatever awaits the result (the environment probe, the
 * discovery pass, and with them the spool ingestion that shares its queue) would wait for ever. The whole tree is ended first.
 */
export function createCommandRunner(deps: CommandRunnerDeps = {}): CommandRunner {
  const platform = deps.platform ?? process.platform;
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree(pid));
  return (file, args, opts) =>
    new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      try {
        const child = execFile(
          file,
          args,
          {
            ...(platform === 'win32' ? {} : { timeout: opts.timeoutMs }),
            windowsHide: true,
            windowsVerbatimArguments: opts.windowsVerbatimArguments === true,
            encoding: 'buffer',
            maxBuffer: MAX_OUTPUT_BYTES,
            env: opts.env ? { ...process.env, ...opts.env } : process.env,
          },
          (err, stdout, stderr) => {
            if (timer) clearTimeout(timer);
            const out = decodeCommandOutput(stdout);
            const errText = decodeCommandOutput(stderr);
            const timeoutText = `Timed out after ${Math.round(opts.timeoutMs / 1000)} seconds.`;
            if (timedOut) {
              resolve({ stdout: out, stderr: errText, code: null, error: timeoutText });
              return;
            }
            if (!err) {
              resolve({ stdout: out, stderr: errText, code: 0 });
              return;
            }
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
            if (typeof e.code === 'number') {
              resolve({ stdout: out, stderr: errText, code: e.code, error: errText.trim() || e.message });
            } else if (e.killed) {
              resolve({ stdout: out, stderr: errText, code: null, error: timeoutText });
            } else {
              resolve({ stdout: out, stderr: errText, code: null, error: e.code === 'ENOENT' ? `${file} was not found.` : e.message });
            }
          },
        );
        child.stdin?.on('error', () => undefined); // the program may be gone before the input closes
        child.stdin?.end();
        if (platform === 'win32') {
          timer = setTimeout(() => {
            timedOut = true;
            const finish = (): void => { try { child.kill(); } catch { /* already gone */ } };
            if (typeof child.pid === 'number' && child.pid > 0) Promise.resolve().then(() => killTree(child.pid as number)).then(finish, finish); else finish();
          }, opts.timeoutMs);
        }
      } catch (err) {
        if (timer) clearTimeout(timer);
        resolve({ stdout: '', stderr: '', code: null, error: err instanceof Error ? err.message : String(err) });
      }
    });
}

/** The default runner (see {@link createCommandRunner}). */
export const defaultCommandRunner: CommandRunner = createCommandRunner();

/**
 * Ends a Windows process and every process it started: `taskkill.exe /pid N /T /F`, started by its full path. The tree is found
 * through the parent links, which are gone once the parent has died, so this must run BEFORE the parent is killed. A process
 * that is already gone is a result (taskkill answers 128), not an error. Never rejects.
 */
export async function killProcessTree(
  pid: number,
  opts: { run?: CommandRunner; env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  if (!Number.isInteger(pid) || pid <= 0) return { stdout: '', stderr: '', code: null, error: 'There is no process id to end.' };
  const run = opts.run ?? defaultCommandRunner;
  return run(systemProgramPath('taskkill.exe', opts.env ?? process.env), ['/pid', String(pid), '/T', '/F'], { timeoutMs: opts.timeoutMs ?? 5000 });
}

// The helper distributions that container tools install next to the user's own: Docker Desktop (docker-desktop, docker-desktop-data)
// and Rancher Desktop (rancher-desktop, rancher-desktop-data). Nobody runs Claude Code in them.
const HELPER_DISTRO = /^docker-desktop|^rancher-desktop(?:-data)?$/i;
// What wsl.exe prints instead of a listing when it has none to give ("has no installed distributions", "not enabled"): the text
// is localized, but it ends with an error code in a fixed form such as `Wsl/Service/WSL_E_DEFAULT_DISTRO_NOT_FOUND`.
const WSL_ERROR_CODE = /\bWsl\/|\bWSL_E_|\bHCS_E_/;

/**
 * `wsl.exe -l -q`: one distribution name per line. Tolerates what a naive decode leaves behind (NULs, a byte order mark
 * or its replacement characters, CR), the English "(Default)" marker (only `-l` without `-q` prints one, and wsl.exe localizes it;
 * nothing else in parentheses is touched, because a distribution may be called "Ubuntu (Work)"), and skips the helper
 * distributions of Docker Desktop and Rancher Desktop. When the text is an error message and not a listing (no distribution
 * installed, WSL not enabled) there are no names.
 */
export function parseWslDistroList(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  if (WSL_ERROR_CODE.test(text.replace(/\u0000/g, ''))) return [];
  const names: string[] = [];
  for (const raw of text.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const name = raw.replace(/[\u0000\uFEFF\uFFFD\r]/g, '').replace(/\s+\(Default\)\s*$/i, '').trim();
    if (name === '' || HELPER_DISTRO.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** `2.1.314 (Claude Code)` -> `2.1.314`; `v22.12.0` -> `22.12.0`. Falls back to the first line. */
export function parseVersion(text: string): string | null {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  if (!first) return null;
  const m = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(first);
  return m ? m[1] : first.slice(0, 80);
}
