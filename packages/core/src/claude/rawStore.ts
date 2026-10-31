// The raw log in SQLite: what Store (raw.jsonl) is in the verified library, for the core.
//
// raw_events is append-only and is the single source of truth for session state: the reducer's state is a pure function
// of it. `seq` is the AUTOINCREMENT column; the stored JSON is {kind, transport, payload} only, so seq and ingested_at
// always come from their columns. A hook receipt is idempotent by transport_id (UNIQUE), discovery entries have none.
// The spool algorithm itself (listing, parsing, quarantine, ordering by clock domain then monotonic_ns then file name,
// move to done/) is the library's ingestSpoolFiles; this store only supplies the durable, idempotent append.
import { ingestSpoolFiles, pendingSpoolFiles } from '@minisumma/claude-integration';
import type { IngestSpoolOptions, RawEntry, RawEntryInput, RawStoreLike, SpoolIngestResult } from '@minisumma/claude-integration';
import type { Db } from '@minisumma/storage';
import { nowIso } from '../contracts.ts';
import type { Clock, Logger } from '../contracts.ts';

export interface RawStore extends RawStoreLike {
  /** Stores the entry and returns it with seq and ingested_at; null when that hook receipt (transport_id) is already stored. */
  appendRaw(entry: RawEntryInput): RawEntry | null;
  pendingSpool(spoolDir: string): string[];
  ingestSpool(spoolDir: string, opts?: IngestSpoolOptions): SpoolIngestResult;
  get(seq: number): RawEntry | null;
  /** Entries with a seq greater than `seq`, ascending. `limit` caps the batch (replay reads in chunks). */
  since(seq: number, limit?: number): RawEntry[];
  loadAll(): RawEntry[];
  count(): number;
  /** Highest seq in the log, 0 when empty. */
  maxSeq(): number;
  /** Deletes entries ingested before the cutoff (retention). Returns how many. Replay history for them is gone for good. */
  prune(olderThanIso: string): number;
}

interface Row { seq: number; ingested_at: string; entry_json: string }

export function createRawStore(db: Db, clock: Clock, log?: Pick<Logger, 'warn'>): RawStore {
  const parse = (row: Row): RawEntry | null => {
    try {
      const entry = JSON.parse(row.entry_json) as RawEntryInput;
      return { seq: row.seq, ingested_at: row.ingested_at, ...entry } as RawEntry;
    } catch (err) {
      log?.warn('Skipped an unreadable raw event.', { seq: row.seq, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const parseAll = (rows: Row[]): RawEntry[] => rows.map(parse).filter((e): e is RawEntry => e !== null);

  const store: RawStore = {
    appendRaw(entry) {
      const { seq: _seq, ingested_at: _ingested, ...clean } = entry as RawEntryInput & { seq?: number; ingested_at?: string };
      const transportId = (clean.transport as { transport_id?: string } | undefined)?.transport_id ?? null;
      // Look first: an insert that hits the UNIQUE constraint still consumes an AUTOINCREMENT value, which would leave
      // holes in seq. (ON CONFLICT below stays as the safety net.)
      if (transportId !== null && db.get('SELECT 1 AS one FROM raw_events WHERE transport_id = ?', [transportId])) return null;
      const ingestedAt = nowIso(clock);
      const result = db.run(
        `INSERT INTO raw_events (transport_id, kind, env_id, ingested_at, entry_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(transport_id) DO NOTHING`,
        [transportId, clean.kind, (clean.transport as { env_id?: string } | undefined)?.env_id ?? null, ingestedAt, JSON.stringify(clean)],
      );
      if (result.changes === 0) return null;
      return { seq: result.lastInsertRowid, ingested_at: ingestedAt, ...clean } as RawEntry;
    },

    pendingSpool: (spoolDir) => pendingSpoolFiles(spoolDir),

    ingestSpool: (spoolDir, opts) => ingestSpoolFiles(spoolDir, opts, (entry) => store.appendRaw(entry)),

    get(seq) {
      const row = db.get<Row>('SELECT seq, ingested_at, entry_json FROM raw_events WHERE seq = ?', [seq]);
      return row ? parse(row) : null;
    },

    since(seq, limit) {
      return parseAll(db.all<Row>(
        'SELECT seq, ingested_at, entry_json FROM raw_events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
        [seq, limit === undefined ? -1 : limit],
      ));
    },

    loadAll: () => store.since(0),

    count: () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM raw_events')?.n ?? 0,

    maxSeq: () => db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM raw_events')?.m ?? 0,

    prune: (olderThanIso) => db.run('DELETE FROM raw_events WHERE ingested_at < ?', [olderThanIso]).changes,
  };
  return store;
}
