import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ingestSpoolFiles, pendingSpoolFiles } from '../src/lib/spool.mjs';
import { Store } from '../src/lib/store.mjs';
import { S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// ingestSpoolFiles is the spool-ingest algorithm of Store.ingestSpool as a function of (directory, barrier, callback), so a
// different durable store (the SQLite-backed Mini-Summa core) can run exactly the same ordering, quarantine and move rules.

// A spool record the way capture.mjs writes it, reduced to the fields the ingest reads.
const record = (tid, { mono = '1', domain = 'D' } = {}) => ({
  schema: 'mini-summa.spool/1',
  transport: { transport_id: tid, monotonic_ns: String(mono), clock_domain: domain, env_id: 'posix', handler_id: 'h1' },
  payload: { session_id: S1, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: tid },
});
const put = (spool, name, value) => fs.writeFileSync(path.join(spool, name), typeof value === 'string' ? value : JSON.stringify(value));
const fresh = (t, name) => { const d = tmpDir(t, name); const spool = path.join(d, 'spool'); fs.mkdirSync(spool); return { d, spool }; };
const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// A callback with the contract of an idempotent durable append: a transport id seen before is "already ingested" (null).
function memory() {
  const seen = new Set(); const log = [];
  return {
    log,
    appendRaw(entry) {
      const tid = entry.transport?.transport_id;
      if (tid && seen.has(tid)) return null;
      if (tid) seen.add(tid);
      const stored = { seq: log.length + 1, ...entry };
      log.push(stored);
      return stored;
    },
    tids: () => log.map((e) => e.transport.transport_id),
  };
}

test('pendingSpoolFiles: sorted *.json only; dotfiles, other extensions and the done/quarantine folders are ignored; a missing folder is empty', (t) => {
  const { d, spool } = fresh(t, 'pending');
  assert.deepEqual(pendingSpoolFiles(path.join(d, 'nope')), []);
  assert.equal(fs.existsSync(path.join(d, 'nope')), false, 'listing never creates the directory');
  for (const n of ['0003-c.json', '0001-a.json', '0002-b.json']) put(spool, n, record(n));
  put(spool, '.tmp-0004', '{"half":'); put(spool, '.hidden.json', record('hidden')); put(spool, 'notes.txt', 'x');
  fs.mkdirSync(path.join(spool, 'done')); fs.mkdirSync(path.join(spool, 'quarantine'));
  assert.deepEqual(pendingSpoolFiles(spool), ['0001-a.json', '0002-b.json', '0003-c.json']);
  assert.deepEqual(new Store(path.join(d, 'store')).pendingSpool(spool), pendingSpoolFiles(spool), 'Store.pendingSpool is the same function');
});

test('ingest: every valid file reaches appendRaw as exactly { kind: "hook", transport, payload }, then moves to done/', (t) => {
  const { spool } = fresh(t, 'moved');
  const a = record('tid-a', { mono: 1 }); const b = record('tid-b', { mono: 2 });
  put(spool, '00000000000000000001-tid-a.json', a); put(spool, '00000000000000000002-tid-b.json', b);
  put(spool, '.tmp-in-flight', '{"half":'); // a hook that is still being written must not be touched
  const m = memory();
  const res = ingestSpoolFiles(spool, undefined, m.appendRaw);
  assert.deepEqual(res, { ingested: 2, already_ingested: 0, quarantined: 0 });
  assert.deepEqual(m.log.map(({ seq, ...entry }) => entry), [
    { kind: 'hook', transport: a.transport, payload: a.payload },
    { kind: 'hook', transport: b.transport, payload: b.payload },
  ]);
  for (const e of m.log) assert.deepEqual(Object.keys(e).filter((k) => k !== 'seq').sort(), ['kind', 'payload', 'transport']);
  assert.deepEqual(names(spool), ['.tmp-in-flight', 'done']);
  assert.deepEqual(names(path.join(spool, 'done')), ['00000000000000000001-tid-a.json', '00000000000000000002-tid-b.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spool, 'done', '00000000000000000001-tid-a.json'), 'utf8')), a, 'moved, not rewritten');
  assert.deepEqual(pendingSpoolFiles(spool), []);
});

test('ingest is idempotent: a file that reappears after a crash between append and rename is counted as already ingested and moved again', (t) => {
  const { spool } = fresh(t, 'idem');
  put(spool, '0001-a.json', record('tid-a')); put(spool, '0002-b.json', record('tid-b', { mono: 2 }));
  const m = memory();
  assert.deepEqual(ingestSpoolFiles(spool, {}, m.appendRaw), { ingested: 2, already_ingested: 0, quarantined: 0 });
  for (let i = 0; i < 3; i++) { // the files come back (crash before rename, restored backup...) any number of times
    for (const n of ['0001-a.json', '0002-b.json']) fs.copyFileSync(path.join(spool, 'done', n), path.join(spool, n));
    assert.deepEqual(ingestSpoolFiles(spool, {}, m.appendRaw), { ingested: 0, already_ingested: 2, quarantined: 0 });
    assert.deepEqual(pendingSpoolFiles(spool), [], 'they are moved back to done/');
  }
  assert.deepEqual(m.tids(), ['tid-a', 'tid-b'], 'the durable log never saw a second copy');
  // a second ingestor instance with the same durable state behaves identically
  fs.copyFileSync(path.join(spool, 'done', '0001-a.json'), path.join(spool, '0001-a.json'));
  assert.deepEqual(ingestSpoolFiles(spool, {}, m.appendRaw), { ingested: 0, already_ingested: 1, quarantined: 0 });
});

test('ingest: only a truthy appendRaw result counts as newly ingested; null (and any falsy value) means already ingested', (t) => {
  const { spool } = fresh(t, 'falsy');
  put(spool, '0001-a.json', record('a')); put(spool, '0002-b.json', record('b', { mono: 2 })); put(spool, '0003-c.json', record('c', { mono: 3 }));
  const answers = [{ rowid: 1 }, null, 7]; let i = 0;
  const res = ingestSpoolFiles(spool, {}, () => answers[i++]);
  assert.deepEqual(res, { ingested: 2, already_ingested: 1, quarantined: 0 });
  assert.deepEqual(names(path.join(spool, 'done')).length, 3, 'a file is moved either way');
});

test('quarantine: garbage is moved aside untouched, counted, never ingested, and valid neighbours are still ingested', (t) => {
  const { spool } = fresh(t, 'quar');
  const bad = {
    '0000-truncated.json': '{"schema":"mini-summa.spool/1","transport":{"transport_id":"half',
    '0001-notjson.json': 'oops, not json at all',
    '0002-empty.json': '',
    '0003-null.json': 'null',
    '0004-number.json': '42',
    '0005-array.json': '[]',
    '0006-wrong-schema.json': JSON.stringify({ ...record('x'), schema: 'mini-summa.spool/2' }),
    '0007-no-schema.json': JSON.stringify({ hello: 1 }),
    '0008-no-payload.json': JSON.stringify({ schema: 'mini-summa.spool/1', transport: { transport_id: 'y' } }),
    '0009-no-transport.json': JSON.stringify({ schema: 'mini-summa.spool/1', payload: { session_id: S1 } }),
    '0010-null-payload.json': JSON.stringify({ schema: 'mini-summa.spool/1', transport: { transport_id: 'z' }, payload: null }),
  };
  for (const [n, body] of Object.entries(bad)) put(spool, n, body);
  put(spool, '0011-good.json', record('good', { mono: 11 }));
  const m = memory();
  const res = ingestSpoolFiles(spool, {}, m.appendRaw);
  assert.deepEqual(res, { ingested: 1, already_ingested: 0, quarantined: Object.keys(bad).length });
  assert.deepEqual(m.tids(), ['good']);
  assert.deepEqual(names(path.join(spool, 'quarantine')), Object.keys(bad).sort());
  for (const [n, body] of Object.entries(bad)) assert.equal(fs.readFileSync(path.join(spool, 'quarantine', n), 'utf8'), body, `${n} kept byte for byte`);
  assert.deepEqual(names(path.join(spool, 'done')), ['0011-good.json']);
  assert.deepEqual(pendingSpoolFiles(spool), []);
  // quarantined files are not pending any more, so a second run has nothing left to complain about
  assert.deepEqual(ingestSpoolFiles(spool, {}, m.appendRaw), { ingested: 0, already_ingested: 0, quarantined: 0 });
});

test('ordering inside one clock domain follows the monotonic clock numerically, not the file name and not as text', (t) => {
  const { spool } = fresh(t, 'order');
  // the names deliberately contradict the monotonic order
  put(spool, 'a.json', record('mono-30', { mono: 30 })); put(spool, 'b.json', record('mono-9', { mono: 9 }));
  put(spool, 'c.json', record('mono-100', { mono: 100 })); put(spool, 'd.json', record('mono-10', { mono: 10 }));
  const m = memory();
  ingestSpoolFiles(spool, {}, m.appendRaw);
  assert.deepEqual(m.tids(), ['mono-9', 'mono-10', 'mono-30', 'mono-100'], 'numeric: 9 < 10 < 30 < 100 (text order would put 10 and 100 first)');
});

test('ordering inside one clock domain: equal monotonic values fall back to the file name; a missing value counts as 0', (t) => {
  const { spool } = fresh(t, 'ties');
  put(spool, 'z-last.json', record('same-z', { mono: 5 })); put(spool, 'a-first.json', record('same-a', { mono: 5 }));
  const noMono = record('no-mono'); delete noMono.transport.monotonic_ns; put(spool, 'm-nomono.json', noMono);
  const m = memory();
  ingestSpoolFiles(spool, {}, m.appendRaw);
  assert.deepEqual(m.tids(), ['no-mono', 'same-a', 'same-z']);
});

test('ordering across clock domains: grouped by domain, never sorted across domains by monotonic value; no domain sorts first, then by file name', (t) => {
  const { spool } = fresh(t, 'domains');
  put(spool, '1-b-late-boot.json', record('boot-B', { domain: 'x|boot:B', mono: 5 }));
  put(spool, '2-a-early-boot.json', record('boot-A', { domain: 'x|boot:A', mono: 900 }));
  put(spool, '3-nodomain-2.json', record('nodomain-2', { domain: null, mono: 1 }));
  put(spool, '4-nodomain-1.json', record('nodomain-1', { domain: null, mono: 99 }));
  const m = memory();
  ingestSpoolFiles(spool, {}, m.appendRaw);
  assert.deepEqual(m.tids(), ['nodomain-2', 'nodomain-1', 'boot-A', 'boot-B'],
    'null domain first (file name order, its monotonic value means nothing), then domain A, then domain B');
});

test('the barrier set: only the named files are read or moved; everything else, garbage included, stays exactly where it was', (t) => {
  const { spool } = fresh(t, 'barrier');
  put(spool, '0001-a.json', record('a', { mono: 1 })); put(spool, '0002-b.json', record('b', { mono: 2 }));
  put(spool, '0003-c.json', record('c', { mono: 3 })); put(spool, '0004-garbage.json', 'not json');
  const m = memory();
  const barrier = new Set(['0001-a.json', '0004-garbage.json', 'long-gone.json']); // a name that is not there is simply ignored
  assert.deepEqual(ingestSpoolFiles(spool, { only: barrier }, m.appendRaw), { ingested: 1, already_ingested: 0, quarantined: 1 });
  assert.deepEqual(m.tids(), ['a']);
  assert.deepEqual(pendingSpoolFiles(spool), ['0002-b.json', '0003-c.json'], 'later arrivals wait for the next pass');
  assert.deepEqual(names(path.join(spool, 'quarantine')), ['0004-garbage.json']);

  assert.deepEqual(ingestSpoolFiles(spool, { only: new Set() }, m.appendRaw), { ingested: 0, already_ingested: 0, quarantined: 0 }, 'an empty barrier admits nothing');
  assert.deepEqual(pendingSpoolFiles(spool), ['0002-b.json', '0003-c.json']);

  assert.deepEqual(ingestSpoolFiles(spool, { only: new Set(['0003-c.json']) }, m.appendRaw), { ingested: 1, already_ingested: 0, quarantined: 0 });
  assert.deepEqual(ingestSpoolFiles(spool, {}, m.appendRaw), { ingested: 1, already_ingested: 0, quarantined: 0 }, 'no barrier = everything pending');
  assert.deepEqual(m.tids(), ['a', 'c', 'b']);
  assert.deepEqual(pendingSpoolFiles(spool), []);
});

test('if appendRaw throws the error propagates, the failing file stays pending, earlier files were already moved, and a retry finishes the job', (t) => {
  const { spool } = fresh(t, 'throws');
  put(spool, '0001-a.json', record('a', { mono: 1 })); put(spool, '0002-b.json', record('b', { mono: 2 })); put(spool, '0003-c.json', record('c', { mono: 3 }));
  const m = memory();
  const flaky = (entry) => { if (entry.transport.transport_id === 'b') throw new Error('database is locked'); return m.appendRaw(entry); };
  assert.throws(() => ingestSpoolFiles(spool, {}, flaky), /database is locked/);
  assert.deepEqual(names(path.join(spool, 'done')), ['0001-a.json']);
  assert.deepEqual(pendingSpoolFiles(spool), ['0002-b.json', '0003-c.json']);
  assert.deepEqual(ingestSpoolFiles(spool, {}, m.appendRaw), { ingested: 2, already_ingested: 0, quarantined: 0 });
  assert.deepEqual(m.tids(), ['a', 'b', 'c']);
});

test('a missing appendRaw callback is a TypeError raised before any file is touched; a missing spool folder is simply empty', (t) => {
  const { d, spool } = fresh(t, 'args');
  put(spool, '0001-a.json', record('a')); put(spool, '0002-garbage.json', 'nope');
  assert.throws(() => ingestSpoolFiles(spool, {}, undefined), TypeError);
  assert.throws(() => ingestSpoolFiles(spool, undefined, 'not a function'), TypeError);
  assert.deepEqual(pendingSpoolFiles(spool), ['0001-a.json', '0002-garbage.json'], 'nothing quarantined or moved by the failed calls');
  assert.deepEqual(ingestSpoolFiles(path.join(d, 'never-created'), {}, () => ({})), { ingested: 0, already_ingested: 0, quarantined: 0 });
  assert.equal(fs.existsSync(path.join(d, 'never-created')), false);
});

test('Store.ingestSpool delegates unchanged: same counts, same order, same folders as ingestSpoolFiles over an identical spool', (t) => {
  const d = tmpDir(t, 'delegate');
  const build = (spool) => {
    fs.mkdirSync(spool);
    put(spool, '3-c.json', record('c', { mono: 3 })); put(spool, '1-a.json', record('a', { mono: 20 }));
    put(spool, '2-b.json', record('b', { mono: 10 })); put(spool, '4-other-boot.json', record('o', { domain: 'E', mono: 1 }));
    put(spool, '5-garbage.json', '{'); put(spool, '6-dup.json', record('a', { mono: 21 })); // same transport id as 1-a: already ingested
    put(spool, '.tmp-x', 'ignored');
  };
  const viaStore = path.join(d, 'via-store'); const viaFn = path.join(d, 'via-fn'); build(viaStore); build(viaFn);
  const store = new Store(path.join(d, 'store'));
  const resStore = store.ingestSpool(viaStore);
  const m = memory();
  const resFn = ingestSpoolFiles(viaFn, {}, m.appendRaw);
  assert.deepEqual(resStore, resFn);
  assert.deepEqual(resStore, { ingested: 4, already_ingested: 1, quarantined: 1 });
  assert.deepEqual(store.raw.map((e) => e.transport.transport_id), m.tids());
  assert.deepEqual(store.raw.map((e) => [e.kind, e.payload.message]), m.log.map((e) => [e.kind, e.payload.message]));
  for (const sub of ['', 'done', 'quarantine']) assert.deepEqual(names(path.join(viaStore, sub)), names(path.join(viaFn, sub)), `folder "${sub}" matches`);
  // and with a barrier
  const again = path.join(d, 'again'); build(again);
  const barrier = new Set(['1-a.json', '2-b.json']);
  const s2 = new Store(path.join(d, 'store2'));
  assert.deepEqual(s2.ingestSpool(again, { only: barrier }), { ingested: 2, already_ingested: 0, quarantined: 0 });
  assert.deepEqual(s2.raw.map((e) => e.transport.transport_id), ['b', 'a'], 'monotonic order inside the domain: b (10) before a (20)');
  assert.deepEqual(pendingSpoolFiles(again), ['3-c.json', '4-other-boot.json', '5-garbage.json', '6-dup.json']);
});
