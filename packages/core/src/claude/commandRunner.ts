// Running small helper commands (`claude --version`, `wsl.exe -l -q`, ...) behind one injectable function, so the
// environment detection can be tested without Windows, WSL or a real Claude Code installation.
//
// Output decoding matters here: `wsl.exe` prints UTF-16LE (usually with NULs between the characters, sometimes with a
// byte order mark and CR LF line ends) unless WSL_UTF8=1 is set. Everything the default runner returns is decoded with
// decodeCommandOutput, so callers always see plain text.
import { execFile } from 'node:child_process';

export interface CommandOptions {
  timeoutMs: number;
  /** Extra environment variables for this one call, merged over the current environment. */
  env?: Record<string, string>;
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

/** The default runner: execFile with a timeout, no shell, no console window on Windows. */
export const defaultCommandRunner: CommandRunner = (file, args, opts) =>
  new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          timeout: opts.timeoutMs,
          windowsHide: true,
          encoding: 'buffer',
          maxBuffer: MAX_OUTPUT_BYTES,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
        },
        (err, stdout, stderr) => {
          const out = decodeCommandOutput(stdout);
          const errText = decodeCommandOutput(stderr);
          if (!err) {
            resolve({ stdout: out, stderr: errText, code: 0 });
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (typeof e.code === 'number') {
            resolve({ stdout: out, stderr: errText, code: e.code, error: errText.trim() || e.message });
          } else if (e.killed) {
            resolve({ stdout: out, stderr: errText, code: null, error: `Timed out after ${Math.round(opts.timeoutMs / 1000)} seconds.` });
          } else {
            resolve({ stdout: out, stderr: errText, code: null, error: e.code === 'ENOENT' ? `${file} was not found.` : e.message });
          }
        },
      );
    } catch (err) {
      resolve({ stdout: '', stderr: '', code: null, error: err instanceof Error ? err.message : String(err) });
    }
  });

/**
 * `wsl.exe -l -q`: one distribution name per line. Tolerates what a naive decode leaves behind (NULs, a byte order mark
 * or its replacement characters, CR, "(Default)" markers) and skips the helper distributions Docker Desktop installs.
 */
export function parseWslDistroList(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const name = raw.replace(/[\u0000﻿�\r]/g, '').replace(/\s+\(Default\)\s*$/i, '').trim();
    if (name === '' || /^docker-desktop/i.test(name)) continue;
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
