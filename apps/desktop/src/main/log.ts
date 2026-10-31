// A small file logger for the main process (a packaged Windows app has no console). It also satisfies the core's Logger.
import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from './fsRetry.ts';

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface FileLogger extends Logger { readonly file: string }

const SECRET_KEY = /token|secret|authorization|password|cookie|credential/i;

/** Defense in depth: nothing that looks like a credential is ever written, whoever logs it. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}...`;
  return value;
}

/** After a rotation that failed, the next attempt waits until the file has grown by this much. */
const ROTATE_RETRY_BYTES = 256 * 1024;

/** Rotation retries only briefly: a pause inside a log call is felt wherever the log call is made. */
const ROTATE_RENAME_RETRIES = 3;

export function createFileLogger(dir: string, opts: { name?: string; maxBytes?: number; echo?: boolean; rename?: (from: string, to: string) => void; pause?: (ms: number) => void } = {}): FileLogger {
  const file = path.join(dir, opts.name ?? 'main.log');
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let written = 0;
  let rotateAt = maxBytes;
  try {
    fs.mkdirSync(dir, { recursive: true });
    written = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch { /* logging must never stop the app */ }

  const write = (level: string, msg: string, data?: Record<string, unknown>): void => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${data ? ` ${JSON.stringify(redact(data))}` : ''}\n`;
    if (opts.echo) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
    try {
      if (written + line.length > rotateAt) {
        // Rotating is a rename, and on Windows a rename fails (EBUSY, EPERM) while any other program has the file open without
        // sharing it for delete: a log viewer, `Get-Content -Wait`, a virus scanner. Dropping this line and every later one
        // until that program lets go would blind the one file a user is asked to send in. A log that grows a little past its
        // limit is better, so the line is appended anyway and the rotation is tried again after some more output.
        try {
          renameSyncWithRetry(file, file.replace(/\.log$/, '.1.log'), { retries: ROTATE_RENAME_RETRIES, ...(opts.rename ? { rename: opts.rename } : {}), ...(opts.pause ? { pause: opts.pause } : {}) });
          written = 0;
          rotateAt = maxBytes;
        } catch {
          rotateAt = written + line.length + ROTATE_RETRY_BYTES;
        }
      }
      fs.appendFileSync(file, line, 'utf8');
      written += line.length;
    } catch { /* ignore */ }
  };
  return {
    file,
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}
