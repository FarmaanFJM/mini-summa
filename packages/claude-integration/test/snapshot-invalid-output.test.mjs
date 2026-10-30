import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/lib/store.mjs';
import { replay } from '../src/lib/reducer.mjs';
import { takeSnapshot } from '../src/lib/snapshot.mjs';
import { registry, S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 2 (docs/CHANGES-FROM-POC.md): `claude agents --json` printing something that is not a listing is handled exactly
// like a call that failed: one discovery_error entry, no snapshot, nothing drained, nothing inferred, the error rethrown.
// In the proof of concept it threw after the spool had been drained and recorded nothing.

const CWD = '/w/GitManager';
const KEY = `posix|${S1}`;
const live = { kind: 'interactive', cwd: CWD, startedAt: 1000, pid: process.pid, status: 'idle', sessionId: S1 };
let n = 0;
function hook(spool, ev, extra = {}) {
  n++;
  const tid = `inv-${n}`;
  const rec = { schema: 'mini-summa.spool/1',
    transport: { transport_id: tid, monotonic_ns: String(1e6 + n), handler_id: 'h1', env_id: 'posix', clock_domain: 'posix|boot:test' },
    payload: { session_id: S1, cwd: CWD, hook_event_name: ev, ...extra } };
  fs.writeFileSync(path.join(spool, `${String(rec.transport.monotonic_ns).padStart(20, '0')}-${tid}.json`), JSON.stringify(rec));
  return tid;
}
function rig(t, name) {
  const d = tmpDir(t, name); const spool = path.join(d, 'spool'); fs.mkdirSync(spool);
  const store = new Store(path.join(d, 'store'));
  const snap = (run) => takeSnapshot({ store, spools: [spool], envId: 'posix', run });
  const sess = () => replay(store.raw, registry).sessions.get(KEY);
  return { spool, store, snap, sess };
}
const NOT_AN_ARRAY = [{ error: 'not logged in' }, {}, null, undefined, 'Not logged in', 42, true, { sessions: [] }];

test('CHANGE 2: output that is not an array is recorded as a discovery_error, like a failed call, and the error is rethrown', async (t) => {
  for (const bad of NOT_AN_ARRAY) {
    const R = rig(t, 'notarray');
    hook(R.spool, 'SessionStart', { source: 'startup' }); await R.snap(async () => ({ raw: [live] })); // a live session is known
    const pending = hook(R.spool, 'PostToolUse', { tool_use_id: 'x', prompt_id: 'p1' });
    const before = R.store.raw.length;
    await assert.rejects(R.snap(async () => ({ raw: bad })), /claude agents --json did not return an array/, JSON.stringify(bad));
    assert.equal(R.store.raw.length, before + 1, 'exactly one entry was recorded');
    const err = R.store.raw.at(-1);
    assert.equal(err.kind, 'discovery_error');
    assert.match(err.payload.message, /did not return an array/);
    assert.equal(err.payload.pending_before, 1);
    assert.deepEqual(Object.keys(err.transport).sort(), ['env_id', 'received_at', 'wall_ms']);
    assert.equal(err.transport.env_id, 'posix');
    assert.ok(!R.store.raw.slice(before).some((e) => e.kind === 'discovery'), 'no snapshot was recorded');
    assert.ok(R.store.pendingSpool(R.spool).some((f) => f.includes(pending)), 'the pending hook is still in the spool');
    assert.equal(R.store.pendingSpool(R.spool).length, 1, 'nothing was drained');
    // nothing is inferred: the session is not "gone", and the error is counted
    const r = replay(R.store.raw, registry);
    assert.equal(r.discovery_errors, 1);
    assert.equal(r.sessions.get(KEY).gen.phase, 'live');
    assert.notEqual(r.sessions.get(KEY).state, 'presence_lost');
    // the normal path still ingests the hook, and the next good snapshot works
    R.store.ingestSpool(R.spool);
    assert.ok(R.store.raw.some((e) => e.transport?.transport_id === pending));
    await R.snap(async () => ({ raw: [live] }));
    assert.equal(R.sess().gen.phase, 'live');
  }
});

test('CHANGE 2: the record is the one a failed call leaves: same entry kind, same transport and payload fields', async (t) => {
  const failed = rig(t, 'failedcall'); const invalid = rig(t, 'invalidcall');
  for (const R of [failed, invalid]) hook(R.spool, 'SessionStart', { source: 'startup' });
  await assert.rejects(failed.snap(async () => { throw new Error('claude exited 1'); }), /claude exited 1/);
  await assert.rejects(invalid.snap(async () => ({ raw: { error: 'x' } })), /did not return an array/);
  const [a, b] = [failed.store.raw.at(-1), invalid.store.raw.at(-1)];
  assert.equal(a.kind, b.kind);
  assert.deepEqual(Object.keys(a.transport), Object.keys(b.transport));
  assert.deepEqual(Object.keys(a.payload), Object.keys(b.payload));
  assert.equal(a.payload.pending_before, b.payload.pending_before);
  assert.equal(failed.store.pendingSpool(failed.spool).length, invalid.store.pendingSpool(invalid.spool).length, 'neither drained the spool');
  // the message is cut to the same length for any error
  await assert.rejects(invalid.snap(async () => { throw new Error('x'.repeat(1000)); }));
  assert.equal(invalid.store.raw.at(-1).payload.message.length, 300);
});

test('CHANGE 2: a listing with an entry that is not an object is invalid too, and nothing from it is recorded', async (t) => {
  const cases = [[[null], 0], [[live, null], 1], [[1], 0], [['claude'], 0], [[[]], 0], [[live, live, undefined], 2], [[true], 0]];
  for (const [bad, index] of cases) {
    const R = rig(t, 'badentry');
    hook(R.spool, 'SessionStart', { source: 'startup' });
    const before = R.store.raw.length;
    await assert.rejects(R.snap(async () => ({ raw: bad })), new RegExp(`entry ${index} is not an object`));
    assert.equal(R.store.raw.length, before + 1);
    assert.equal(R.store.raw.at(-1).kind, 'discovery_error');
    assert.equal(R.store.pendingSpool(R.spool).length, 1, 'not drained');
    assert.equal(replay(R.store.raw, registry).sessions.size, 0, 'no session was invented from the garbage');
  }
});

test('CHANGE 2: real listings are unaffected: an empty array, rows with extra or missing optional fields, and the drain still happen', async (t) => {
  const R = rig(t, 'valid');
  const tid = hook(R.spool, 'SessionStart', { source: 'startup' });
  const { entry, sessions } = await R.snap(async () => ({ raw: [live, { cwd: '/a', kind: 'background', startedAt: 2, id: 'abc', state: 'blocked', surprise: 1 }] }));
  assert.equal(entry.kind, 'discovery');
  assert.equal(sessions.length, 2); assert.equal(sessions[1].sessionId, null); assert.equal('_extra_keys' in sessions[1], false);
  assert.equal(entry.payload.interval.drained, 1);
  assert.ok(R.store.raw.some((e) => e.transport?.transport_id === tid), 'the pending hook was drained ahead of the snapshot');
  const empty = await R.snap(async () => ({ raw: [] }));
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.entry.payload.interval.complete, true);
  assert.equal(R.store.raw.filter((e) => e.kind === 'discovery_error').length, 0);
});
