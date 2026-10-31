import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ingestSpoolFiles, pendingSpoolFiles } from '../src/lib/spool.mjs';
import { Store } from '../src/lib/store.mjs';
import { S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// Deliberate differences from the proof of concept, see docs/CHANGES-FROM-POC.md:
//   change 1  a clock domain with a monotonic_ns that is not a decimal integer no longer wedges the spool
//   change 5  a file that another ingestor already moved away no longer aborts the pass

const record = (tid, { mono = '1', domain = 'D' } = {}) => ({
  schema: 'mini-summa.spool/1',
  transport: { transport_id: tid, monotonic_ns: mono, clock_domain: domain, env_id: 'posix', handler_id: 'h1' },
  payload: { session_id: S1, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: tid },
});
const put = (spool, name, value) => fs.writeFileSync(path.join(spool, name), typeof value === 'string' ? value : JSON.stringify(value));
const fresh = (t, name) => { const d = tmpDir(t, name); const spool = path.join(d, 'spool'); fs.mkdirSync(spool); return { d, spool }; };
const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
function memory() {
  const seen = new Set(); const log = [];
  return {
    tids: () => log.map((e) => e.transport.transport_id),
    appendRaw(entry) { const id = entry.transport.transport_id; if (seen.has(id)) return null; seen.add(id); log.push(entry); return entry; },
  };
}
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });

// ---- change 1 --------------------------------------------------------------------------------------------------------

const NOT_DECIMAL = [
  'not-a-number', 'abc', '1.5', '0x10', '0b11', '1e3', ' 12', '12 ', '-5', '+5', '', 'NaN', 'Infinity', '12abc', '١٢٣', // text
  true, false, 1.5, -1, 9007199254740992, [], [5], {}, // JSON values that are not clock readings
];

test('CHANGE 1: a record with a clock domain and a monotonic_ns that is not a decimal integer is quarantined, and the same pass ingests everything else', (t) => {
  for (const bad of NOT_DECIMAL) {
    const { spool } = fresh(t, 'poison');
    put(spool, '1-good.json', record('good', { mono: '5' }));
    put(spool, '2-poison.json', record('poison', { mono: bad }));
    put(spool, '3-good2.json', record('good2', { mono: '9' }));
    const m = memory();
    const label = JSON.stringify(bad);
    let res;
    assert.doesNotThrow(() => { res = ingestSpoolFiles(spool, undefined, m.appendRaw); }, `monotonic_ns ${label} must not throw`);
    assert.deepEqual(res, { ingested: 2, already_ingested: 0, quarantined: 1 }, label);
    assert.deepEqual(m.tids(), ['good', 'good2'], label);
    assert.deepEqual(names(path.join(spool, 'quarantine')), ['2-poison.json'], label);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spool, 'quarantine', '2-poison.json'), 'utf8')), record('poison', { mono: bad }), `${label}: kept untouched`);
    assert.deepEqual(pendingSpoolFiles(spool), [], `${label}: nothing is left to wedge the next pass`);
    assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 0, already_ingested: 0, quarantined: 0 }, `${label}: second pass has nothing to do`);
  }
});

test('CHANGE 1: the same through Store.ingestSpool, with the exact files that wedged the proof of concept ("not-a-number" and 1.5)', (t) => {
  for (const bad of ['not-a-number', 1.5]) {
    const { d, spool } = fresh(t, 'poison-store');
    put(spool, '1-good.json', record('good', { mono: '5' }));
    put(spool, '2-poison.json', record('poison', { mono: bad }));
    put(spool, '3-good2.json', record('good2', { mono: '9' }));
    const store = new Store(path.join(d, 'store'));
    assert.deepEqual(store.ingestSpool(spool), { ingested: 2, already_ingested: 0, quarantined: 1 });
    assert.deepEqual(store.raw.map((e) => e.transport.transport_id), ['good', 'good2']);
    assert.deepEqual(store.pendingSpool(spool), []);
  }
});

test('CHANGE 1: what the hook writes, and what never mattered, is still ingested: decimal strings, safe integers, no value, no clock domain', (t) => {
  const { spool } = fresh(t, 'valid');
  put(spool, '01.json', record('digits', { mono: '00007' }));
  put(spool, '02.json', record('twenty', { mono: '18446744073709551615' }));
  put(spool, '03.json', record('number', { mono: 5 }));
  const none = record('absent'); delete none.transport.monotonic_ns; put(spool, '04.json', none);
  put(spool, '05.json', record('null-value', { mono: null }));
  put(spool, '06.json', record('no-domain-text', { mono: 'not-a-number', domain: null })); // the value is never parsed without a domain
  put(spool, '07.json', record('no-domain-object', { mono: {}, domain: null }));
  put(spool, '08.json', record('empty-domain', { mono: 'abc', domain: '' }));
  const m = memory();
  assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 8, already_ingested: 0, quarantined: 0 });
  assert.equal(new Set(m.tids()).size, 8);
  assert.equal(names(path.join(spool, 'done')).length, 8);
  assert.equal(fs.existsSync(path.join(spool, 'quarantine')), false);
});

test('CHANGE 1: the order of valid records is unchanged: numeric inside a domain (including numbers and padded strings), names between domains', (t) => {
  const { spool } = fresh(t, 'order');
  put(spool, 'a.json', record('n100', { mono: 100 })); put(spool, 'b.json', record('s9', { mono: '9' }));
  put(spool, 'c.json', record('s0010', { mono: '0010' })); put(spool, 'd.json', record('other-domain', { mono: '1', domain: 'E' }));
  const m = memory();
  ingestSpoolFiles(spool, undefined, m.appendRaw);
  assert.deepEqual(m.tids(), ['s9', 's0010', 'n100', 'other-domain']);
});

// ---- change 5 --------------------------------------------------------------------------------------------------------

test('CHANGE 5: a file that another ingestor moves to done/ while this pass runs is skipped, and the pass carries on', (t) => {
  const { spool } = fresh(t, 'raced');
  for (const [n, tid, mono] of [['1-a.json', 'a', '1'], ['2-b.json', 'b', '2'], ['3-c.json', 'c', '3']]) put(spool, n, record(tid, { mono }));
  const m = memory();
  let res;
  assert.doesNotThrow(() => {
    res = ingestSpoolFiles(spool, undefined, (entry) => {
      if (entry.transport.transport_id === 'a') { // "the other ingestor" gets to b first
        fs.mkdirSync(path.join(spool, 'done'), { recursive: true });
        fs.renameSync(path.join(spool, '2-b.json'), path.join(spool, 'done', '2-b.json'));
      }
      return m.appendRaw(entry);
    });
  });
  assert.deepEqual(res, { ingested: 3, already_ingested: 0, quarantined: 0 }, 'b was still appended by this pass: the durable append is idempotent anyway');
  assert.deepEqual(m.tids(), ['a', 'b', 'c'], 'c, after the raced file, was still processed');
  assert.deepEqual(names(path.join(spool, 'done')), ['1-a.json', '2-b.json', '3-c.json']);
  assert.deepEqual(pendingSpoolFiles(spool), []);
});

test('CHANGE 5: a file that vanishes between the listing and the read is skipped: not quarantined, not counted, no error', (t) => {
  const { spool } = fresh(t, 'vanished');
  put(spool, '1-a.json', record('a', { mono: '1' })); put(spool, '2-b.json', record('b', { mono: '2' }));
  const target = path.join(spool, '1-a.json'); const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p) === target) {
      fs.mkdirSync(path.join(spool, 'done'), { recursive: true });
      fs.renameSync(target, path.join(spool, 'done', '1-a.json')); // the other ingestor ingested it and moved it
      throw enoent(p);
    }
    return readFile(p, ...rest);
  });
  const m = memory();
  assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 1, already_ingested: 0, quarantined: 0 });
  assert.deepEqual(m.tids(), ['b']);
  assert.equal(fs.existsSync(path.join(spool, 'quarantine')), false, 'a vanished file is not garbage');
});

test('CHANGE 5: a garbage file that another ingestor already quarantined is skipped, not an error; the garbage that is still there is quarantined as before', (t) => {
  const { spool } = fresh(t, 'quarantine-raced');
  put(spool, '1-garbage.json', 'oops'); put(spool, '2-garbage.json', 'oops too'); put(spool, '3-good.json', record('good', { mono: '3' }));
  const first = path.join(spool, '1-garbage.json'); const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p) === first) { // read succeeds, then the other ingestor quarantines it before this pass can
      const text = readFile(p, ...rest);
      fs.mkdirSync(path.join(spool, 'quarantine'), { recursive: true });
      fs.renameSync(first, path.join(spool, 'quarantine', '1-garbage.json'));
      return text;
    }
    return readFile(p, ...rest);
  });
  const m = memory();
  assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 1, already_ingested: 0, quarantined: 1 }, 'only the garbage this pass moved is counted');
  assert.deepEqual(names(path.join(spool, 'quarantine')), ['1-garbage.json', '2-garbage.json']);
  assert.deepEqual(m.tids(), ['good']);
});

test('CHANGE 5: an ENOENT caused by a vanished destination folder is retried once; the same error twice, and every other error, still propagates', (t) => {
  const { spool } = fresh(t, 'dest-gone');
  put(spool, '1-a.json', record('a', { mono: '1' }));
  const rename = fs.renameSync; let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls++;
    if (calls === 1) fs.rmSync(path.dirname(to), { recursive: true, force: true }); // done/ disappears under us
    return rename(from, to);
  });
  const m = memory();
  assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 1, already_ingested: 0, quarantined: 0 });
  assert.equal(calls, 2, 'one failed move, one retry');
  assert.deepEqual(names(path.join(spool, 'done')), ['1-a.json']);

  const again = fresh(t, 'dest-gone-forever');
  put(again.spool, '1-a.json', record('a', { mono: '1' }));
  fs.renameSync.mock.restore();
  t.mock.method(fs, 'renameSync', (from) => { throw enoent(from); }); // the source exists, so this is not "already moved"
  assert.throws(() => ingestSpoolFiles(again.spool, undefined, memory().appendRaw), { code: 'ENOENT' });
  assert.deepEqual(pendingSpoolFiles(again.spool), ['1-a.json'], 'the file is still pending');

  fs.renameSync.mock.restore();
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
  const denied = fresh(t, 'denied');
  put(denied.spool, '1-a.json', record('a', { mono: '1' }));
  assert.throws(() => ingestSpoolFiles(denied.spool, undefined, memory().appendRaw), { code: 'EACCES' });
});

test('CHANGE 5: Store.ingestSpool has the same tolerance (it is the same function)', (t) => {
  const { d, spool } = fresh(t, 'store-raced');
  put(spool, '1-a.json', record('a', { mono: '1' })); put(spool, '2-b.json', record('b', { mono: '2' }));
  const store = new Store(path.join(d, 'store'));
  const append = store.appendRaw.bind(store);
  store.appendRaw = (entry) => {
    if (entry.transport.transport_id === 'a') { fs.mkdirSync(path.join(spool, 'done'), { recursive: true }); fs.renameSync(path.join(spool, '2-b.json'), path.join(spool, 'done', '2-b.json')); }
    return append(entry);
  };
  assert.deepEqual(store.ingestSpool(spool), { ingested: 2, already_ingested: 0, quarantined: 0 });
  assert.deepEqual(store.raw.map((e) => e.transport.transport_id), ['a', 'b']);
});
