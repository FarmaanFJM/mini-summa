import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

// node:sqlite prints an ExperimentalWarning on first load. That one warning is noise for a shipped app; any other
// warning is left alone.
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

/**
 * WAL keeps its index in shared memory, which a network file system cannot provide (SQLite's own documentation: "WAL does not work
 * over a network filesystem"). A UNC path (\\\\server\\share\\..., also \\\\?\\UNC\\...) is a network file system, so a database there uses
 * the older rollback journal, with the stronger sync it needs. Nothing can be said about a mapped drive letter from its name.
 */
export function journalPragmaFor(file: string, platform: NodeJS.Platform = process.platform): string {
  const onShare = platform === 'win32' && /^(?:[\\/]{2}[?.][\\/]UNC[\\/]|[\\/]{2}(?![?.][\\/]))[^\\/]/i.test(file);
  return onShare ? 'PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;' : 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';
}

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;

/** Thin wrapper over node:sqlite: statement cache, nested transactions, JSON helpers. */
export class Db {
  readonly raw: DatabaseSync;
  readonly file: string;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;
  private closed = false;

  constructor(file: string, opts: { readOnly?: boolean } = {}) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync: Database } = loadSqlite();
    this.raw = new Database(file, { readOnly: opts.readOnly ?? false });
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:' && !opts.readOnly) this.raw.exec(journalPragmaFor(file));
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  private bind<T>(sql: string, params: SqlParams | undefined, fn: (s: StatementSync, args: SqlValue[]) => T): T {
    const s = this.stmt(sql);
    if (params === undefined) return fn(s, []);
    if (Array.isArray(params)) return fn(s, params);
    // Named parameters: pass the record as the first argument.
    return fn(s, [params as unknown as SqlValue]);
  }

  exec(sql: string): void { this.raw.exec(sql); }

  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number } {
    const r = this.bind(sql, params, (s, a) => s.run(...a));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    return this.bind(sql, params, (s, a) => s.get(...a)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    return this.bind(sql, params, (s, a) => s.all(...a)) as T[];
  }

  /** Run `fn` atomically. Nested calls become savepoints, so a failing inner block rolls back only itself. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const name = `sp_${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (err) {
      this.depth--;
      try { this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* connection already unusable */ }
      throw err;
    }
  }

  get inTransaction(): boolean { return this.depth > 0; }

  /** Size of the main database file in bytes (0 for :memory:). */
  fileBytes(): number {
    if (this.file === ':memory:') return 0;
    try { return fs.statSync(this.file).size; } catch { return 0; }
  }

  checkpoint(): void {
    if (this.file !== ':memory:') this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    try { this.checkpoint(); } catch { /* best effort */ }
    this.raw.close();
  }
}

export const toJson = (v: unknown): string => JSON.stringify(v);
export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
export const bool = (v: unknown): boolean => v === 1 || v === true;
export const int = (b: boolean): number => (b ? 1 : 0);
