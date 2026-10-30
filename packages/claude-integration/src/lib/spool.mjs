import fs from 'node:fs';
import path from 'node:path';

// Spool ingestion, extracted from Store.ingestSpool so a different durable store can reuse the exact algorithm.
//
// Spool layout under <spoolDir>: *.json pending (written atomically by the hook), done/ ingested, quarantine/ unparsable.
// Files whose name starts with "." are the hook's temp files and are never touched.
//
// The functions here own the FILES (listing, parsing, ordering, moving). They own no durable state: the caller supplies
// `appendRaw`, which does the durable append and is idempotent per transport_id (the Store appends to raw.jsonl, the
// Mini-Summa core appends to SQLite).

const SPOOL_SCHEMA = 'mini-summa.spool/1';

// File names currently waiting in a spool directory (names only), sorted by name. Used to build a barrier.
export function pendingSpoolFiles(spoolDir) {
  if (!fs.existsSync(spoolDir)) return [];
  return fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
}

// Ingest the pending spool files of one directory.
//   only       optional Set of file names (the barrier set); files outside it are neither read nor moved.
//   appendRaw  (entry) => stored | null. Called synchronously, once per valid file, with
//              { kind: 'hook', transport, payload }. It must return a truthy value for a newly stored receipt and null for
//              a receipt that was already ingested (same transport_id), which is not an error.
// Order: by monotonic clock inside one clock domain, otherwise by file name (no causal meaning).
// Each file is moved to done/ only after appendRaw returned, so a crash between the append and the move leaves the file in
// place and the next run skips it through the idempotent appendRaw. If appendRaw throws, the file stays pending and the
// error propagates; files handled before it have already been moved.
// Returns { ingested, already_ingested, quarantined }.
export function ingestSpoolFiles(spoolDir, { only } = {}, appendRaw) {
  if (typeof appendRaw !== 'function') throw new TypeError('ingestSpoolFiles: appendRaw callback required');
  const res = { ingested: 0, already_ingested: 0, quarantined: 0 };
  const files = pendingSpoolFiles(spoolDir).filter((f) => !only || only.has(f));
  const parsed = [];
  for (const f of files) {
    const full = path.join(spoolDir, f);
    try {
      const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (rec.schema !== SPOOL_SCHEMA || !rec.payload || !rec.transport) throw new Error('not a spool record');
      parsed.push({ f, full, rec });
    } catch {
      fs.mkdirSync(path.join(spoolDir, 'quarantine'), { recursive: true });
      fs.renameSync(full, path.join(spoolDir, 'quarantine', f));
      res.quarantined++;
    }
  }
  parsed.sort((a, b) => {
    // Monotonic values order receipts only inside one clock domain. Otherwise fall back to the file name, which is
    // deterministic but implies no causal order; the reducer never derives certainty from this ingestion order.
    const da = a.rec.transport.clock_domain ?? ''; const db = b.rec.transport.clock_domain ?? '';
    if (da !== db) return da < db ? -1 : 1;
    if (da) {
      const x = BigInt(a.rec.transport.monotonic_ns ?? 0); const y = BigInt(b.rec.transport.monotonic_ns ?? 0);
      if (x !== y) return x < y ? -1 : 1;
    }
    return a.f < b.f ? -1 : a.f > b.f ? 1 : 0;
  });
  for (const { f, full, rec } of parsed) {
    const stored = appendRaw({ kind: 'hook', transport: rec.transport, payload: rec.payload });
    if (stored) res.ingested++; else res.already_ingested++;
    // A crash between append and rename leaves the file in place; the next run skips it by transport_id.
    fs.mkdirSync(path.join(spoolDir, 'done'), { recursive: true });
    fs.renameSync(full, path.join(spoolDir, 'done', f));
  }
  return res;
}
