// Small helpers shared by the workflow services. Nothing here knows about a particular table.
import { createHash } from 'node:crypto';
import type { Db } from '@minisumma/storage';

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// node:sqlite cuts a TEXT value at an embedded NUL character, so a report body that contains one would silently lose
// everything after it. Text with a NUL is therefore stored as a BLOB of its UTF-8 bytes and decoded on the way out.
// Everything else stays an ordinary TEXT value, readable and searchable with plain SQL. (A lone UTF-16 surrogate has no
// UTF-8 form and becomes U+FFFD, which is also what sha256 sees, so hashes still agree.)
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function packText(text: string): string | Uint8Array {
  return text.includes('\u0000') ? encoder.encode(text) : text;
}

export function unpackText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return decoder.decode(value);
  return '';
}

/** One line of text: runs of whitespace (newlines included) become a single space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Product rule: nothing a person reads contains an em dash. A dash that joins two clauses becomes " - ". */
export const noEmDashes = (text: string): string => text.replace(/\s*\u2014\s*/g, ' - ');

export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Cut at `max` characters without splitting a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const prev = text.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The first non-empty line, shortened for a summary. */
export function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > max ? `${cutText(line, max - 3)}...` : line;
}

/**
 * A project id that is safe to store in a foreign-key column. If the project disappeared between attribution and the
 * write (a race with "delete project"), the row is kept without it rather than lost.
 */
export function existingProjectId(db: Db, id: string | null | undefined): string | null {
  if (!id) return null;
  return db.get('SELECT 1 AS ok FROM projects WHERE id = ?', [id]) ? id : null;
}

export const isUniqueViolation = (err: unknown): boolean => err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

export const addMinutes = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/** `n` question marks for an IN (...) list. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');
