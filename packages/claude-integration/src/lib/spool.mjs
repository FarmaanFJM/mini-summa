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
//
// Two deliberate differences from the proof of concept (docs/CHANGES-FROM-POC.md, changes 1 and 5):
//   * a record that names a clock domain but whose monotonic_ns is not a decimal integer is quarantined, instead of
//     making the ordering step throw on every pass and wedging the whole spool;
//   * a file that another ingestor already moved away is skipped, instead of aborting the pass with ENOENT.

const SPOOL_SCHEMA = 'mini-summa.spool/1';

// File names currently waiting in a spool directory (names only), sorted by name. Used to build a barrier.
export function pendingSpoolFiles(spoolDir) {
  if (!fs.existsSync(spoolDir)) return [];
  return fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
}

// The hook writes `process.hrtime.bigint().toString()`: decimal digits. A missing value counts as 0 when ordering, as it
// always did. A JSON number is accepted when it is a non-negative safe integer. Anything else (hex, text, a fraction, a
// sign, padding, a boolean, an object) is not a clock reading, and BigInt() of it would throw inside the sort.
const DECIMAL = /^[0-9]+$/;
function isClockReading(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return DECIMAL.test(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return false;
}

// Move <spoolDir>/<name> into <spoolDir>/<sub>/. Returns false when the file is already gone, which means another
// ingestor moved it first (to done/ or quarantine/): there is nothing left to do for it. An ENOENT while the source still
// exists means the destination folder vanished; that is retried once and then reported. Every other error propagates.
function moveInto(spoolDir, sub, name) {
  const from = path.join(spoolDir, name); const dir = path.join(spoolDir, sub);
  for (let attempt = 0; ; attempt++) {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.renameSync(from, path.join(dir, name)); return true; } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      if (!fs.existsSync(from)) return false;
      if (attempt >= 1) throw err;
    }
  }
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
      // The monotonic value only matters (and is only ever parsed) when a clock domain is named, exactly as in the sort below.
      if ((rec.transport.clock_domain ?? '') && !isClockReading(rec.transport.monotonic_ns)) throw new Error('monotonic_ns is not a decimal integer');
      parsed.push({ f, rec });
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // vanished between the listing and the read: another ingestor took it
      if (moveInto(spoolDir, 'quarantine', f)) res.quarantined++;
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
  for (const { f, rec } of parsed) {
    const stored = appendRaw({ kind: 'hook', transport: rec.transport, payload: rec.payload });
    if (stored) res.ingested++; else res.already_ingested++;
    // A crash between append and rename leaves the file in place; the next run skips it by transport_id.
    moveInto(spoolDir, 'done', f);
  }
  return res;
}
