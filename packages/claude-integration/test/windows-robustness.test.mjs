import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ingestSpoolFiles, pendingSpoolFiles } from '../src/lib/spool.mjs';
import { execWithDeadline, runAgentsJson } from '../src/lib/discovery.mjs';
import { S1, root } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// Differences from the proof of concept that matter on Windows (docs/CHANGES-FROM-POC.md, changes 12 to 14):
//   change 12  a spool file that another program has open for a moment (EBUSY, EPERM) is not quarantined, and a move that meets
//              the same is retried briefly
//   change 13  the hook retries the rename of its record, so a scanner holding the new file does not lose the event
//   change 14  a deadline of `claude agents --json` on Windows also ends the children of a .cmd launcher; the command's input is closed
//
// EVERYTHING HERE IS SIMULATED: the errors are injected on Linux with the codes libuv gives the Windows errors (ERROR_SHARING_VIOLATION
// is EBUSY, ERROR_ACCESS_DENIED is EPERM). Nothing ran on Windows.

const record = (tid, mono = '1') => ({
  schema: 'mini-summa.spool/1',
  transport: { transport_id: tid, monotonic_ns: mono, clock_domain: 'D', env_id: 'posix', handler_id: 'h1' },
  payload: { session_id: S1, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: tid },
});
const put = (spool, name, value) => fs.writeFileSync(path.join(spool, name), JSON.stringify(value));
const fresh = (t, name) => { const d = tmpDir(t, name); const spool = path.join(d, 'spool'); fs.mkdirSync(spool); return { d, spool }; };
const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
function memory() {
  const seen = new Set(); const log = [];
  return { tids: () => log.map((e) => e.transport.transport_id), appendRaw(entry) { const id = entry.transport.transport_id; if (seen.has(id)) return null; seen.add(id); log.push(entry); return entry; } };
}
const fsError = (code, syscall, p) => Object.assign(new Error(`${code}: ${syscall} '${p}'`), { code, syscall });

// ---- change 12 -------------------------------------------------------------------------------------------------------

for (const code of ['EBUSY', 'EPERM']) {
  test(`CHANGE 12 (simulated Windows): a pending file that is ${code} when it is read is skipped, not quarantined, and read on the next pass`, (t) => {
    const { spool } = fresh(t, 'busy-read');
    put(spool, '1-a.json', record('a', '1')); put(spool, '2-b.json', record('b', '2')); put(spool, '3-c.json', record('c', '3'));
    const read = fs.readFileSync;
    let busy = true;
    t.mock.method(fs, 'readFileSync', (file, ...rest) => {
      if (busy && String(file).endsWith('2-b.json')) throw fsError(code, 'open', file);
      return read(file, ...rest);
    });
    const m = memory();
    assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 2, already_ingested: 0, quarantined: 0 }, 'the other files of the pass are ingested');
    assert.deepEqual(m.tids(), ['a', 'c']);
    assert.deepEqual(pendingSpoolFiles(spool), ['2-b.json'], 'the busy file waits where it is');
    assert.deepEqual(names(path.join(spool, 'quarantine')), [], 'and it was not mistaken for a damaged one');
    busy = false;
    assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 1, already_ingested: 0, quarantined: 0 });
    assert.deepEqual(m.tids(), ['a', 'c', 'b']);
    assert.deepEqual(pendingSpoolFiles(spool), []);
  });
}

test('CHANGE 12 (simulated Windows): a file that really is damaged is still quarantined, busy files around it or not', (t) => {
  const { spool } = fresh(t, 'busy-and-damaged');
  put(spool, '1-a.json', record('a'));
  fs.writeFileSync(path.join(spool, '2-bad.json'), '{ not json');
  assert.deepEqual(ingestSpoolFiles(spool, undefined, memory().appendRaw), { ingested: 1, already_ingested: 0, quarantined: 1 });
  assert.deepEqual(names(path.join(spool, 'quarantine')), ['2-bad.json']);
});

test('CHANGE 12 (simulated Windows): a move into done/ that is EPERM or EBUSY a few times is retried and then succeeds', (t) => {
  const { spool } = fresh(t, 'busy-move');
  put(spool, '1-a.json', record('a'));
  const rename = fs.renameSync; let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls++;
    if (calls <= 3) throw fsError(calls === 2 ? 'EBUSY' : 'EPERM', 'rename', from);
    return rename(from, to);
  });
  const started = Date.now();
  assert.deepEqual(ingestSpoolFiles(spool, undefined, memory().appendRaw), { ingested: 1, already_ingested: 0, quarantined: 0 });
  assert.equal(calls, 4, 'three refusals, then the move');
  assert.ok(Date.now() - started >= 40, 'there was a pause between the attempts');
  assert.deepEqual(names(path.join(spool, 'done')), ['1-a.json']);
  assert.deepEqual(pendingSpoolFiles(spool), []);
});

test('CHANGE 12 (simulated Windows): a file that stays busy is reported after the retries, stays pending, and is not ingested twice later', (t) => {
  const { spool } = fresh(t, 'busy-forever');
  put(spool, '1-a.json', record('a'));
  const rename = fs.renameSync; let busy = true; let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => { calls++; if (busy) throw fsError('EBUSY', 'rename', from); return rename(from, to); });
  const m = memory();
  assert.throws(() => ingestSpoolFiles(spool, undefined, m.appendRaw), { code: 'EBUSY' });
  assert.equal(calls, 7, 'one attempt and six retries');
  assert.deepEqual(pendingSpoolFiles(spool), ['1-a.json']);
  busy = false;
  assert.deepEqual(ingestSpoolFiles(spool, undefined, m.appendRaw), { ingested: 0, already_ingested: 1, quarantined: 0 }, 'idempotent by transport_id');
  assert.deepEqual(m.tids(), ['a']);
  assert.deepEqual(pendingSpoolFiles(spool), []);
});

test('CHANGE 12: any other error still propagates at once, without a pause', (t) => {
  const { spool } = fresh(t, 'other-error');
  put(spool, '1-a.json', record('a'));
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from) => { calls++; throw fsError('EACCES', 'rename', from); });
  assert.throws(() => ingestSpoolFiles(spool, undefined, memory().appendRaw), { code: 'EACCES' });
  assert.equal(calls, 1);
});

// ---- change 13 -------------------------------------------------------------------------------------------------------

const CAPTURE = path.join(root, 'src', 'hook', 'capture.mjs');
const INPUT = JSON.stringify({ session_id: S1, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'hi', cwd: '/tmp' });

// A preload that makes the first N renames of the hook's temp record fail with `code`, as a scanner holding the new file would.
function runHook(t, { failRenames, code = 'EPERM' }) {
  const d = tmpDir(t, 'hook-retry');
  const spool = path.join(d, 'spool');
  const preload = path.join(d, 'preload.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
const real = fs.renameSync; let failures = 0;
fs.renameSync = (from, to) => {
  if (String(from).includes('.tmp-') && failures < Number(process.env.MS_TEST_FAIL_RENAMES)) {
    failures++; throw Object.assign(new Error(process.env.MS_TEST_FAIL_CODE + ': rename'), { code: process.env.MS_TEST_FAIL_CODE, syscall: 'rename' });
  }
  return real(from, to);
};
`);
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--import', preload, CAPTURE, '--spool', spool, '--env', 'posix', '--handler', 'h1', 'Notification'], {
    input: INPUT, encoding: 'utf8', env: { ...process.env, MS_TEST_FAIL_RENAMES: String(failRenames), MS_TEST_FAIL_CODE: code }, timeout: 20_000,
  });
  return { r, spool, d, ms: Date.now() - started, pending: pendingSpoolFiles(spool), all: names(spool) };
}

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`CHANGE 13 (simulated Windows): the hook retries a rename that fails with ${code}, so the record still reaches the spool`, (t) => {
    const { r, pending, all, d } = runHook(t, { failRenames: 3, code });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pending.length, 1, `the record is in the spool: ${all.join(', ')}`);
    assert.deepEqual(all.filter((n) => n.startsWith('.tmp-')), [], 'no temp file is left behind');
    assert.equal(fs.existsSync(path.join(d, 'capture-errors.log')), false, 'nothing was logged as an error');
    const rec = JSON.parse(fs.readFileSync(path.join(d, 'spool', pending[0]), 'utf8'));
    assert.equal(rec.payload.message, 'hi');
  });
}

test('CHANGE 13 (simulated Windows): a lock that never lets go still exits 0, logs the error, and takes about a second and a quarter at most', (t) => {
  const { r, pending, ms, d } = runHook(t, { failRenames: 1000, code: 'EPERM' });
  assert.equal(r.status, 0, 'the hook never blocks Claude');
  assert.deepEqual(pending, []);
  assert.match(fs.readFileSync(path.join(d, 'capture-errors.log'), 'utf8'), /EPERM/);
  assert.ok(ms < 8000, `took ${ms} ms`);
});

test('CHANGE 13: a rename that works at once costs nothing extra, and another error is not retried', (t) => {
  const quick = runHook(t, { failRenames: 0 });
  assert.equal(quick.r.status, 0);
  assert.equal(quick.pending.length, 1);
  const other = runHook(t, { failRenames: 5, code: 'ENOSPC' });
  assert.equal(other.r.status, 0);
  assert.deepEqual(other.pending, []);
  assert.match(fs.readFileSync(path.join(other.d, 'capture-errors.log'), 'utf8'), /ENOSPC/);
  assert.ok(other.ms < 3000, `not retried (${other.ms} ms)`);
});

// ---- change 14 -------------------------------------------------------------------------------------------------------

const SLEEPER = ['-e', 'setInterval(() => {}, 1000)'];

test('CHANGE 14 (simulated Windows): the deadline ends the process tree first and then the process, and says it timed out', async () => {
  const order = [];
  const result = await execWithDeadline(process.execPath, SLEEPER, {}, {
    timeoutMs: 250, platform: 'win32',
    killTree: async (pid) => { order.push(`tree:${pid > 0}`); await new Promise((r) => setTimeout(r, 20)); order.push('tree done'); },
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(order, ['tree:true', 'tree done']);
  assert.ok(result.err, 'the child was killed after the tree');
});

test('CHANGE 14 (simulated Windows): a tree killer that fails or throws still ends the process', async () => {
  for (const killTree of [async () => { throw new Error('taskkill missing'); }, () => { throw new Error('sync failure'); }, () => Promise.reject(new Error('no'))]) {
    const result = await execWithDeadline(process.execPath, SLEEPER, {}, { timeoutMs: 200, platform: 'win32', killTree });
    assert.equal(result.timedOut, true);
  }
});

test('CHANGE 14 (simulated Windows): a command that finishes in time is untouched, and the deadline timer does not keep the process alive', async () => {
  let treeKilled = false;
  const result = await execWithDeadline(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }, { timeoutMs: 20_000, platform: 'win32', killTree: () => { treeKilled = true; } });
  assert.equal(result.err, null);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.timedOut, false);
  assert.equal(treeKilled, false);
});

test('CHANGE 14: elsewhere execFile\'s own deadline is used, and no tree killer runs', async () => {
  let treeKilled = false;
  const result = await execWithDeadline(process.execPath, SLEEPER, {}, { timeoutMs: 250, platform: 'linux', killTree: () => { treeKilled = true; } });
  assert.equal(result.timedOut, false);
  assert.ok(result.err?.killed, 'execFile killed it');
  assert.equal(treeKilled, false);
});

test('CHANGE 14: the command\'s input is closed at once, so a program waiting for input ends with end-of-file', async () => {
  for (const platform of ['win32', 'linux']) {
    const result = await execWithDeadline(process.execPath, ['-e', 'process.stdin.on("end", () => process.stdout.write("eof")).resume()'], { encoding: 'utf8' }, { timeoutMs: 20_000, platform, killTree: () => {} });
    assert.equal(result.stdout, 'eof', platform);
    assert.equal(result.err, null, platform);
  }
});

test('CHANGE 14: runAgentsJson on a hung command rejects with the failure as before (the message names the command)', async (t) => {
  const dir = tmpDir(t, 'hung');
  const script = path.join(dir, 'claude-hangs');
  fs.writeFileSync(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  await assert.rejects(runAgentsJson({ bin: script, timeoutMs: 300 }), (err) => err instanceof Error && err.message.includes('agents --json failed:'));
});
