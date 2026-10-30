// Idempotency-Key support for the routes marked `idempotent`.
//
// A response is stored per (key, principal, route) in the `idempotency` table for 24 hours and replayed with
// `Idempotent-Replay: true`. 2xx and 4xx answers are stored; 5xx, 408 and 429 are not (they say nothing lasting).
// Two additions to the plain rule, both local decisions:
//  * The stored row remembers a fingerprint of the request. The same key with a different request is refused with 422
//    `idempotency_key_reused` instead of silently returning the answer to another request.
//  * Requests with the same key that overlap in time run one after the other, so the second one replays the first.
import { createHash } from 'node:crypto';
import type { Db } from '@minisumma/storage';
import type { Clock, Logger } from '../contracts.ts';
import { CoreError } from '../errors.ts';

export interface StoredResponse { status: number; body: unknown }

export interface IdempotencyParts { key: string; principal: string; route: string; fingerprint: string }

interface Row { response_status: number; response_json: string; created_at: string }

export const isStorableStatus = (status: number): boolean =>
  (status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 408 && status !== 429);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${path}\n${stableStringify(body)}`).digest('hex');
}

/** Keys are opaque client strings: visible ASCII only, bounded. */
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,200}$/;

function decode(json: string): { fp: string | null; body: unknown } {
  try {
    const v = JSON.parse(json) as unknown;
    if (v !== null && typeof v === 'object' && (v as { v?: unknown }).v === 1 && 'body' in (v as object)) {
      const e = v as { fp?: unknown; body: unknown };
      return { fp: typeof e.fp === 'string' ? e.fp : null, body: e.body };
    }
    return { fp: null, body: v };
  } catch {
    return { fp: null, body: null };
  }
}

export interface IdempotencyStore {
  run(parts: IdempotencyParts, exec: () => Promise<StoredResponse>): Promise<{ response: StoredResponse; replayed: boolean }>;
  /** Removes expired rows; returns how many. */
  prune(): number;
}

export function createIdempotencyStore(deps: { db: Db; clock: Clock; log: Logger; ttlMs: number }): IdempotencyStore {
  const locks = new Map<string, Promise<void>>();
  const cutoffIso = () => new Date(deps.clock.now().getTime() - deps.ttlMs).toISOString();

  async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    locks.set(id, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(id) === tail) locks.delete(id);
    }
  }

  return {
    run(parts, exec) {
      const id = `${parts.key}\u0000${parts.principal}\u0000${parts.route}`;
      return withLock(id, async () => {
        const row = deps.db.get<Row>(
          'SELECT response_status, response_json, created_at FROM idempotency WHERE key = ? AND principal = ? AND route = ?',
          [parts.key, parts.principal, parts.route]);
        if (row && row.created_at >= cutoffIso()) {
          const stored = decode(row.response_json);
          if (stored.fp !== null && stored.fp !== parts.fingerprint) {
            throw new CoreError(422, 'idempotency_key_reused',
              'This Idempotency-Key was already used for a different request. Use a new key for a new request, or repeat the original request unchanged.');
          }
          return { response: { status: row.response_status, body: stored.body }, replayed: true };
        }
        const response = await exec();
        if (isStorableStatus(response.status)) {
          try {
            deps.db.run(
              'INSERT OR REPLACE INTO idempotency (key, principal, route, response_status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
              [parts.key, parts.principal, parts.route, response.status, JSON.stringify({ v: 1, fp: parts.fingerprint, body: response.body ?? null }), deps.clock.now().toISOString()]);
          } catch (err) {
            // The operation already happened; losing the replay record must not turn a success into an error.
            deps.log.warn('http.idempotency_store_failed', { route: parts.route, message: (err as Error).message });
          }
        }
        return { response, replayed: false };
      });
    },
    prune() {
      return deps.db.run('DELETE FROM idempotency WHERE created_at < ?', [cutoffIso()]).changes;
    },
  };
}
