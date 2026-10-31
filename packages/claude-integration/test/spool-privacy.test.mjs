import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/lib/store.mjs';
import { root, S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 10 (docs/CHANGES-FROM-POC.md): the spool holds hook payloads: prompts, file contents, command output. The proof of
// concept created its directory with the default mode (0755 under the usual umask), so every other account on the machine
// could list it, and the files in it were private only by their own mode. The hook now creates the directory (and the
// parents it has to create) with mode 0700, tightens a directory of the earlier version that is plainly its own, and keeps
// the files at 0600. The ingestor creates done/ and quarantine/ the same way. Modes mean nothing on Windows, so the mode
// assertions are skipped there; the hook is still run.

const POSIX = process.platform !== 'win32';
const SOURCE = path.join(root, 'src', 'hook', 'capture.mjs');
const mode = (p) => fs.statSync(p).mode & 0o777;
const lmode = (p) => fs.lstatSync(p).mode & 0o777;
const octal = (m) => m.toString(8).padStart(3, '0');

const cleanEnv = () => { const env = { ...process.env }; for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_REMOTE', 'MINI_SUMMA_SPOOL', 'MINI_SUMMA_REGISTRY', 'ELECTRON_RUN_AS_NODE']) delete env[k]; return env; };
// One hook invocation. On POSIX it runs under the given umask, so the test shows that the modes come from the hook and not from
// whoever started it.
function hook(spool, { umask = '022', file = SOURCE } = {}) {
  const args = [file, '--spool', spool, '--env', POSIX ? 'posix' : 'win', '--handler', 'h1', 'Stop'];
  const input = JSON.stringify({ session_id: S1, hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: 'hello' });
  const r = POSIX
    ? spawnSync('sh', ['-c', `umask ${umask}; exec "$0" "$@"`, process.execPath, ...args], { input, encoding: 'utf8', env: cleanEnv() })
    : spawnSync(process.execPath, args, { input, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  return r;
}
const records = (spool) => fs.readdirSync(spool).filter((f) => /\.json$/.test(f));

test('CHANGE 10: a new spool and the parents the hook creates are 0700 under any umask, and the files in it are 0600', (t) => {
  const d = tmpDir(t, 'priv-new');
  for (const umask of ['0', '002', '022', '077']) {
    const top = path.join(d, `u${umask}`);
    const spool = path.join(top, 'a', 'b', 'spool');
    hook(spool, { umask });
    assert.equal(records(spool).length, 1, `umask ${umask}: one record was written`);
    assert.deepEqual(fs.readdirSync(spool).filter((f) => f.startsWith('.tmp-')), [], 'no temp file is left behind');
    const rec = JSON.parse(fs.readFileSync(path.join(spool, records(spool)[0]), 'utf8'));
    assert.equal(rec.payload.last_assistant_message, 'hello');
    if (!POSIX) continue;
    for (const dir of [path.join(top, 'a'), path.join(top, 'a', 'b'), spool]) assert.equal(octal(mode(dir)), '700', `umask ${umask}: ${path.relative(d, dir)}`);
    assert.equal(octal(mode(path.join(spool, records(spool)[0]))), '600', `umask ${umask}: the record`);
    // a second hook finds a private directory and leaves it alone
    hook(spool, { umask });
    assert.equal(records(spool).length, 2); assert.equal(octal(mode(spool)), '700');
  }
});

test('CHANGE 10: a spool directory of the earlier version (0755) is tightened when it holds only the hook\'s and the ingestor\'s files', { skip: !POSIX && 'file modes are not used on Windows' }, (t) => {
  const d = tmpDir(t, 'priv-legacy');
  const first = path.join(d, 'first'); hook(first);
  const spool = path.join(d, 'legacy');
  fs.mkdirSync(spool); fs.chmodSync(spool, 0o755);
  fs.copyFileSync(path.join(first, records(first)[0]), path.join(spool, records(first)[0]));
  for (const sub of ['done', 'quarantine']) { fs.mkdirSync(path.join(spool, sub)); fs.chmodSync(path.join(spool, sub), 0o755); }
  fs.writeFileSync(path.join(spool, `.tmp-${randomUUID()}`), '');
  fs.writeFileSync(path.join(spool, 'done', records(first)[0]), '{}');
  assert.equal(octal(mode(spool)), '755');
  hook(spool);
  assert.equal(octal(mode(spool)), '700');
  assert.equal(records(spool).length, 2, 'the capture itself still worked');
  assert.equal(octal(mode(path.join(spool, 'done'))), '755', 'only the spool directory is changed: it is the one that keeps everyone out of the rest');
  // group access without world access is also removed
  const grouped = path.join(d, 'grouped'); fs.mkdirSync(grouped); fs.chmodSync(grouped, 0o750);
  hook(grouped);
  assert.equal(octal(mode(grouped)), '700');
  // a spool with many records is recognised without listing all of it, and is tightened
  const busy = path.join(d, 'busy'); fs.mkdirSync(busy); fs.chmodSync(busy, 0o755);
  for (let i = 1; i <= 300; i++) fs.writeFileSync(path.join(busy, `${String(i).padStart(20, '0')}-${randomUUID()}.json`), '{}');
  hook(busy);
  assert.equal(octal(mode(busy)), '700');
});

test('CHANGE 10: an empty directory that was there before (the application made it first) is tightened too', { skip: !POSIX && 'file modes are not used on Windows' }, (t) => {
  const d = tmpDir(t, 'priv-empty');
  const spool = path.join(d, 'spool'); fs.mkdirSync(spool); fs.chmodSync(spool, 0o755);
  hook(spool);
  assert.equal(octal(mode(spool)), '700'); assert.equal(records(spool).length, 1);
});

test('CHANGE 10: a directory that holds anything else, a link, or somebody else\'s directory keeps its mode, and the capture still works', { skip: !POSIX && 'file modes are not used on Windows' }, (t) => {
  const d = tmpDir(t, 'priv-foreign');
  // somebody pointed --spool at a folder of their own
  const foreign = path.join(d, 'documents'); fs.mkdirSync(foreign); fs.chmodSync(foreign, 0o755); fs.writeFileSync(path.join(foreign, 'notes.txt'), 'mine');
  hook(foreign);
  assert.equal(octal(mode(foreign)), '755'); assert.equal(records(foreign).length, 1); assert.equal(fs.readFileSync(path.join(foreign, 'notes.txt'), 'utf8'), 'mine');
  // our files and a stranger's in one directory
  const mixed = path.join(d, 'mixed'); fs.mkdirSync(mixed); fs.chmodSync(mixed, 0o755);
  fs.writeFileSync(path.join(mixed, `${'1'.padStart(20, '0')}-${randomUUID()}.json`), '{}'); fs.writeFileSync(path.join(mixed, 'README'), 'x');
  hook(mixed);
  assert.equal(octal(mode(mixed)), '755');
  // names that only look a little like ours
  const lookalike = path.join(d, 'lookalike'); fs.mkdirSync(lookalike); fs.chmodSync(lookalike, 0o755);
  fs.writeFileSync(path.join(lookalike, `x${'1'.padStart(20, '0')}-${randomUUID()}.json`), '{}');
  hook(lookalike);
  assert.equal(octal(mode(lookalike)), '755');
  // a link to a directory: the capture writes through it, and the target is not touched
  const target = path.join(d, 'target'); fs.mkdirSync(target); fs.chmodSync(target, 0o755);
  const link = path.join(d, 'link'); fs.symlinkSync(target, link);
  hook(link);
  assert.equal(octal(mode(target)), '755'); assert.equal(records(target).length, 1); assert.ok(fs.lstatSync(link).isSymbolicLink());
  // a directory that belongs to another user (only a superuser can set that up, so only then is it checked)
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const other = path.join(d, 'other'); fs.mkdirSync(other); fs.chmodSync(other, 0o755); fs.chownSync(other, 12345, 12345);
    hook(other);
    assert.equal(octal(mode(other)), '755');
  }
});

test('CHANGE 10: the error log the hook keeps beside the spool is created 0600', { skip: !POSIX && 'file modes are not used on Windows' }, (t) => {
  const d = tmpDir(t, 'priv-log');
  const blocked = path.join(d, 'spoolfile'); fs.writeFileSync(blocked, 'x'); // the spool path is a regular file: the capture fails and logs
  hook(blocked, { umask: '0' });
  const log = path.join(d, 'capture-errors.log');
  assert.ok(fs.existsSync(log), 'the error is logged beside the spool');
  assert.equal(octal(mode(log)), '600');
});

test('CHANGE 10: the ingestor creates done/ and quarantine/ with mode 0700 too, and what it moves keeps its 0600', { skip: !POSIX && 'file modes are not used on Windows' }, (t) => {
  const d = tmpDir(t, 'priv-ingest');
  const spool = path.join(d, 'spool');
  hook(spool, { umask: '0' });
  fs.writeFileSync(path.join(spool, `${'2'.padStart(20, '0')}-${randomUUID()}.json`), 'this is not a record', { mode: 0o600 });
  const res = new Store(path.join(d, 'store')).ingestSpool(spool);
  assert.deepEqual([res.ingested, res.quarantined], [1, 1]);
  for (const sub of ['done', 'quarantine']) assert.equal(octal(lmode(path.join(spool, sub))), '700', sub);
  assert.equal(octal(mode(path.join(spool, 'done', fs.readdirSync(path.join(spool, 'done'))[0]))), '600');
  assert.equal(octal(mode(spool)), '700');
});

test('CHANGE 10: the bundled hook, built the way build:hook builds it, creates the same private directories', async (t) => {
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { t.skip('esbuild is not installed'); return; }
  const d = tmpDir(t, 'priv-bundle');
  const bundle = path.join(d, 'dist', 'capture.mjs');
  esbuild.buildSync({ entryPoints: [SOURCE], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundle, absWorkingDir: root, logLevel: 'silent' });
  const spool = path.join(d, 'x', 'spool');
  hook(spool, { umask: '0', file: bundle });
  assert.equal(records(spool).length, 1);
  if (!POSIX) return;
  assert.equal(octal(mode(spool)), '700'); assert.equal(octal(mode(path.join(d, 'x'))), '700'); assert.equal(octal(mode(path.join(spool, records(spool)[0]))), '600');
  const legacy = path.join(d, 'legacy'); fs.mkdirSync(legacy); fs.chmodSync(legacy, 0o755);
  hook(legacy, { file: bundle });
  assert.equal(octal(mode(legacy)), '700');
});
