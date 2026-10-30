import fs from 'node:fs';
import path from 'node:path';

// Durable store. Layout under <dir>:
//   raw.jsonl        append-only raw log (hook + discovery entries), fsynced per append
//   derived.jsonl    derived events already announced (so a restart does not re-announce)
//   reports/<id>.json   complete, unaltered final messages that satisfied the protocol
//   candidates/<id>.json   every other final message (never discarded, promotable by hand)
// Spool layout under <spool>: *.json pending, done/ ingested, quarantine/ unparsable.

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.rawPath = path.join(dir, 'raw.jsonl');
    this.derivedPath = path.join(dir, 'derived.jsonl');
    this.torn = 0;
    this.#repairTail(this.rawPath);
    this.#repairTail(this.derivedPath);
    this.raw = this.loadRaw();
    this.transportIds = new Set(this.raw.filter((e) => e.transport?.transport_id).map((e) => e.transport.transport_id));
    this.announced = new Set(this.#readLines(this.derivedPath).map((d) => d.derived_id));
  }

  // A crash mid-append can leave a final line without a newline. Terminate it so the
  // next append starts on a fresh line; the torn line is skipped on read, not deleted.
  #repairTail(file) {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size === 0) return;
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd);
    if (b[0] !== 0x0a) fs.appendFileSync(file, '\n');
  }

  #readLines(file) {
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { this.torn++; }
    }
    return out;
  }

  loadRaw() { return this.#readLines(this.rawPath); }

  #append(file, obj) {
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  // Idempotent per transport_id: re-ingesting the same hook invocation is a no-op.
  appendRaw(entry) {
    const tid = entry.transport?.transport_id;
    if (tid && this.transportIds.has(tid)) return null;
    const stored = { seq: this.raw.length + 1, ingested_at: new Date().toISOString(), ...entry };
    this.#append(this.rawPath, stored);
    this.raw.push(stored);
    if (tid) this.transportIds.add(tid);
    return stored;
  }

  // Files currently waiting in a spool directory (names only). Used to build a barrier.
  pendingSpool(spoolDir) {
    if (!fs.existsSync(spoolDir)) return [];
    return fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  }

  // Ingest spool files. `only` restricts to a set of file names (the barrier set).
  // Order: by monotonic clock inside one clock domain, otherwise by file name (no causal meaning).
  ingestSpool(spoolDir, { only } = {}) {
    const res = { ingested: 0, already_ingested: 0, quarantined: 0 };
    const files = this.pendingSpool(spoolDir).filter((f) => !only || only.has(f));
    const parsed = [];
    for (const f of files) {
      const full = path.join(spoolDir, f);
      try {
        const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (rec.schema !== 'mini-summa.spool/1' || !rec.payload || !rec.transport) throw new Error('not a spool record');
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
      const stored = this.appendRaw({ kind: 'hook', transport: rec.transport, payload: rec.payload });
      if (stored) res.ingested++; else res.already_ingested++;
      // A crash between append and rename leaves the file in place; the next run skips it by transport_id.
      fs.mkdirSync(path.join(spoolDir, 'done'), { recursive: true });
      fs.renameSync(full, path.join(spoolDir, 'done', f));
    }
    return res;
  }

  // Persist reducer output. Returns derived events not announced before (restart-safe).
  persist(reducer) {
    for (const [id, r] of reducer.reports) {
      const file = path.join(this.dir, 'reports', `${id}.json`);
      if (!fs.existsSync(file)) writeAtomic(file, JSON.stringify(r, null, 2));
    }
    for (const [id, c] of reducer.candidates) {
      const file = path.join(this.dir, 'candidates', `${id}.json`);
      if (!fs.existsSync(file)) writeAtomic(file, JSON.stringify(c, null, 2));
    }
    const fresh = [];
    for (const d of reducer.derived) {
      if (this.announced.has(d.derived_id)) continue;
      this.#append(this.derivedPath, d);
      this.announced.add(d.derived_id);
      fresh.push(d);
    }
    return fresh;
  }

  // Manual promotion of a preserved non-marker message to a report (user decision).
  promote(candidateId) {
    const cfile = path.join(this.dir, 'candidates', `${candidateId}.json`);
    const c = JSON.parse(fs.readFileSync(cfile, 'utf8'));
    const r = { ...c, report_id: candidateId, source: 'user_promoted', verified: false,
      note: 'Promoted manually from a final message that did not satisfy the report protocol.' };
    delete r.candidate_id; delete r.reason;
    writeAtomic(path.join(this.dir, 'reports', `${candidateId}.json`), JSON.stringify(r, null, 2));
    writeAtomic(cfile, JSON.stringify({ ...c, promoted: true }, null, 2));
    return r;
  }
}
