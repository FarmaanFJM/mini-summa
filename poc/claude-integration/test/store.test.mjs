import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/lib/store.mjs';
import { replay } from '../src/lib/reducer.mjs';
import { createRegistry, loadRegistry } from '../src/lib/registry.mjs';
import { REPORT_INSTRUCTION } from '../src/lib/protocol.mjs';
import { root, registry, loadFixture, labels, S1 } from './helpers.mjs';

const CAPTURE = path.join(root, 'src/hook/capture.mjs');
fs.mkdirSync(path.join(root, '.tmp-tests'), { recursive: true });
const tmp = (n) => fs.mkdtempSync(path.join(root, '.tmp-tests', `${n}-`));

function hook(spool, payload, { registryFile, event = 'x', raw, env = {} } = {}) {
  const args = [CAPTURE, '--spool', spool];
  if (registryFile) args.push('--registry', registryFile);
  args.push(event);
  const t0 = Date.now();
  const r = spawnSync('node', args, { input: raw ?? JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
  return { ...r, ms: Date.now() - t0 };
}
const spoolFiles = (d) => fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : [];

const REPORT = 'Done.\n\n## Implementation Report\n- 3 tests passed\n\n<!-- mini-summa:report status=complete task="Storage System" -->\n';
const stop = (cwd, msg = REPORT) => ({ session_id: S1, cwd, prompt_id: 'pp-1', hook_event_name: 'Stop', stop_hook_active: false,
  last_assistant_message: msg, background_tasks: [], session_crons: [] });

test('hook: exits 0 with empty stdout, writes one complete spool file atomically, payload preserved, transport appended', () => {
  const d = tmp('hook'); const spool = path.join(d, 'spool');
  const p = stop('/w/GitManager');
  const r = hook(spool, p, { event: 'Stop' });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  const files = fs.readdirSync(spool);
  assert.equal(files.length, 1); assert.ok(!files[0].startsWith('.tmp-'), 'no temp residue');
  const rec = JSON.parse(fs.readFileSync(path.join(spool, files[0]), 'utf8'));
  assert.deepEqual(rec.payload, p);
  assert.equal(rec.schema, 'mini-summa.spool/1');
  for (const k of ['transport_id', 'received_at', 'monotonic_ns', 'pid', 'capture_version', 'redactions']) assert.ok(k in rec.transport, k);
  assert.equal(rec.transport.hook_arg, 'Stop');
  assert.ok(r.ms < 1500, `hook took ${r.ms}ms`);
});

test('hook safety: PermissionRequest produces no output at all (cannot decide or block)', () => {
  const d = tmp('perm'); const r = hook(path.join(d, 'spool'), { session_id: S1, cwd: '/x', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
});

test('hook safety: malformed stdin, empty stdin, unwritable spool and missing spool arg all exit 0 silently', () => {
  const d = tmp('bad');
  const a = hook(path.join(d, 'spool'), null, { raw: '{not json' });
  assert.equal(a.status, 0); assert.equal(a.stdout, '');
  const rec = JSON.parse(fs.readFileSync(path.join(d, 'spool', spoolFiles(path.join(d, 'spool'))[0]), 'utf8'));
  assert.ok(rec.transport.parse_error);
  assert.equal(hook(path.join(d, 'spool2'), null, { raw: '' }).status, 0);
  fs.writeFileSync(path.join(d, 'spoolfile'), 'x'); // the spool path is a regular file
  const blocked = hook(path.join(d, 'spoolfile'), { session_id: 's', hook_event_name: 'Stop' });
  assert.equal(blocked.status, 0); assert.equal(blocked.stdout, '');
  assert.ok(fs.existsSync(path.join(d, 'capture-errors.log')), 'error logged beside the spool');
  const none = spawnSync('node', [CAPTURE], { input: '{}', encoding: 'utf8', env: { ...process.env, MINI_SUMMA_SPOOL: '' } });
  assert.equal(none.status, 0);
});

test('hook: credentials never reach disk, and the count is recorded without the values', () => {
  const d = tmp('sec'); const spool = path.join(d, 'spool');
  hook(spool, { session_id: S1, cwd: '/x', hook_event_name: 'PreToolUse', tool_use_id: 't1', tool_name: 'Bash',
    tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" https://x', env: { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETSECRET' } } });
  const text = fs.readFileSync(path.join(spool, spoolFiles(spool)[0]), 'utf8');
  assert.ok(!/SECRETSECRET|abcdefghijklmnopqrstuv/.test(text));
  assert.ok(JSON.parse(text).transport.redactions >= 2);
});

test('hook: SessionStart injects the report protocol ONLY for registered projects', () => {
  const d = tmp('ss'); const repo = path.join(d, 'repo'); const other = path.join(d, 'other');
  fs.mkdirSync(repo); fs.mkdirSync(other);
  const regFile = path.join(d, 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ projects: [{ id: 'p', name: 'P', roots: [repo] }] }));
  const ss = (cwd) => ({ session_id: S1, cwd, hook_event_name: 'SessionStart', source: 'startup' });
  const yes = hook(path.join(d, 's1'), ss(path.join(repo, 'src')), { registryFile: regFile, event: 'SessionStart' });
  const out = JSON.parse(yes.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(out.hookSpecificOutput.additionalContext, REPORT_INSTRUCTION);
  assert.equal(Object.keys(out).length, 1, 'no continue/decision fields');
  const no = hook(path.join(d, 's2'), ss(other), { registryFile: regFile });
  assert.equal(no.stdout, ''); assert.equal(no.status, 0);
  const missing = hook(path.join(d, 's3'), ss(repo), { registryFile: path.join(d, 'nope.json') });
  assert.equal(missing.stdout, ''); assert.equal(missing.status, 0);
  assert.equal(spoolFiles(path.join(d, 's2')).length, 1, 'event still captured when no context is injected');
});

test('end to end: report text survives hook -> spool -> ingest -> report file byte for byte', () => {
  const d = tmp('e2e'); const spool = path.join(d, 'spool'); const repo = path.join(d, 'GitManager'); fs.mkdirSync(repo);
  const reg = createRegistry({ projects: [{ id: 'g', name: 'GitManager', roots: [repo] }] });
  hook(spool, { session_id: S1, cwd: repo, prompt_id: 'pp-1', hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  const long = REPORT.replace('Done.', 'Done. ' + 'x'.repeat(50000) + ' ünïcödé ✓ \r\n tabs\t.');
  hook(spool, stop(repo, long));
  const store = new Store(path.join(d, 'store'));
  const res = store.ingestSpool(spool);
  assert.equal(res.ingested, 2);
  store.persist(replay(store.raw, reg));
  const files = fs.readdirSync(path.join(d, 'store', 'reports'));
  assert.equal(files.length, 1);
  const rep = JSON.parse(fs.readFileSync(path.join(d, 'store', 'reports', files[0]), 'utf8'));
  assert.equal(rep.body, long);
  assert.equal(rep.project_name, 'GitManager'); assert.equal(rep.declared_status, 'complete'); assert.equal(rep.verified, false);
  assert.deepEqual(fs.readdirSync(spool).sort(), ['done']);
});

test('ingest is idempotent: a spool file re-appearing after a crash between append and rename is not double-counted', () => {
  const d = tmp('idem'); const spool = path.join(d, 'spool');
  hook(spool, stop('/w/GitManager'));
  const f = spoolFiles(spool)[0];
  const copy = fs.readFileSync(path.join(spool, f));
  const store = new Store(path.join(d, 'store'));
  assert.equal(store.ingestSpool(spool).ingested, 1);
  fs.writeFileSync(path.join(spool, f), copy); // simulate: rename never happened
  const again = new Store(path.join(d, 'store')); // fresh process
  const res = again.ingestSpool(spool);
  assert.deepEqual([res.ingested, res.already_ingested], [0, 1]);
  assert.equal(again.raw.length, 1);
});

test('ingest: unparsable spool files are quarantined, never deleted or ingested', () => {
  const d = tmp('q'); const spool = path.join(d, 'spool'); fs.mkdirSync(spool);
  fs.writeFileSync(path.join(spool, '000-bad.json'), '{oops');
  fs.writeFileSync(path.join(spool, '001-wrongschema.json'), '{"hello":1}');
  const res = new Store(path.join(d, 'store')).ingestSpool(spool);
  assert.equal(res.quarantined, 2); assert.equal(res.ingested, 0);
  assert.equal(fs.readdirSync(path.join(spool, 'quarantine')).length, 2);
});

test('crash recovery: a torn final line in the raw log is skipped, the log stays appendable, nothing earlier is lost', () => {
  const d = tmp('torn'); const sd = path.join(d, 'store');
  const s1 = new Store(sd);
  for (const e of loadFixture('happy-path').slice(0, 3)) s1.appendRaw({ kind: e.kind, transport: e.transport, payload: e.payload });
  fs.appendFileSync(path.join(sd, 'raw.jsonl'), '{"seq":4,"kind":"hook","transport":{"transport_id":"half'); // power cut mid-write
  const s2 = new Store(sd);
  assert.equal(s2.raw.length, 3); assert.ok(s2.torn >= 1);
  const e = loadFixture('happy-path')[3];
  s2.appendRaw({ kind: e.kind, transport: e.transport, payload: e.payload });
  assert.equal(new Store(sd).raw.length, 4, 'new append is not glued onto the torn line');
});

test('restart: stored events replay to the same state, and nothing is announced twice', () => {
  const d = tmp('restart'); const sd = path.join(d, 'store');
  const all = loadFixture('happy-path').map((e) => ({ kind: e.kind, transport: e.transport, payload: e.payload }));
  const once = replay(all.map((e, i) => ({ ...e, seq: i + 1 })), registry);

  const a = new Store(sd);
  all.slice(0, 5).forEach((e) => a.appendRaw(e));
  const firstFresh = a.persist(replay(a.raw, registry)).map((x) => x.label).filter(Boolean);

  const b = new Store(sd); // "process restarted"
  assert.equal(b.raw.length, 5);
  const replayedFresh = b.persist(replay(b.raw, registry));
  assert.equal(replayedFresh.length, 0, 'restart must not re-announce');
  all.slice(5).forEach((e) => b.appendRaw(e));
  const secondFresh = b.persist(replay(b.raw, registry)).map((x) => x.label).filter(Boolean);

  assert.deepEqual([...firstFresh, ...secondFresh], labels(once));
  assert.equal(fs.readdirSync(path.join(sd, 'reports')).length, 1);
});

test('restart with a half-processed spool: pending files are picked up on the next run', () => {
  const d = tmp('spoolrestart'); const spool = path.join(d, 'spool'); const sd = path.join(d, 'store');
  hook(spool, { session_id: S1, cwd: '/w/GitManager', prompt_id: 'p1', hook_event_name: 'UserPromptSubmit' });
  new Store(sd).ingestSpool(spool);
  hook(spool, stop('/w/GitManager')); // arrives while "the app is down"
  const s = new Store(sd);
  assert.equal(s.ingestSpool(spool).ingested, 1);
  const r = replay(s.raw, registry);
  assert.equal(r.reports.size, 1);
});

test('non-marker final messages are preserved as candidates and can be promoted manually', () => {
  const d = tmp('promo'); const sd = path.join(d, 'store');
  const s = new Store(sd);
  const e = loadFixture('no-marker');
  e.forEach((x) => s.appendRaw({ kind: x.kind, transport: x.transport, payload: x.payload }));
  s.persist(replay(s.raw, registry));
  const [cf] = fs.readdirSync(path.join(sd, 'candidates'));
  const id = cf.replace('.json', '');
  assert.equal(fs.existsSync(path.join(sd, 'reports')), false);
  const r = s.promote(id);
  assert.equal(r.source, 'user_promoted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sd, 'reports', `${id}.json`), 'utf8')).body, e[1].payload.last_assistant_message);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sd, 'candidates', `${id}.json`), 'utf8')).promoted, true);
});

test('hook run 20x concurrently: 20 distinct complete spool files, no partials, all ingest', async () => {
  const d = tmp('conc'); const spool = path.join(d, 'spool');
  const { spawn } = await import('node:child_process');
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((res) => {
    const c = spawn('node', [CAPTURE, '--spool', spool, 'PostToolUse']);
    c.on('close', res);
    c.stdin.end(JSON.stringify({ session_id: S1, cwd: '/w/GitManager', prompt_id: 'p', hook_event_name: 'PostToolUse', tool_use_id: `t${i}`, tool_name: 'Read' }));
  })));
  assert.equal(spoolFiles(spool).length, 20);
  assert.equal(fs.readdirSync(spool).filter((f) => f.startsWith('.tmp-')).length, 0);
  const s = new Store(path.join(d, 'store'));
  assert.equal(s.ingestSpool(spool).ingested, 20);
  assert.equal(replay(s.raw, registry).duplicates.length, 0);
});
