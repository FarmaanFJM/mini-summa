// A small file logger for the main process (a packaged Windows app has no console). It also satisfies the core's Logger.
import fs from 'node:fs';
import path from 'node:path';

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

export function createFileLogger(dir: string, opts: { name?: string; maxBytes?: number; echo?: boolean } = {}): FileLogger {
  const file = path.join(dir, opts.name ?? 'main.log');
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let written = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    written = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch { /* logging must never stop the app */ }

  const write = (level: string, msg: string, data?: Record<string, unknown>): void => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${data ? ` ${JSON.stringify(redact(data))}` : ''}\n`;
    if (opts.echo) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
    try {
      if (written + line.length > maxBytes) {
        fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
        written = 0;
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
