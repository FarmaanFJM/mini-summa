import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/lib/store.mjs';
import { replay } from '../src/lib/reducer.mjs';
import { takeSnapshot } from '../src/lib/snapshot.mjs';
import { root, registry, S1, labels } from './helpers.mjs';

const CWD = '/w/GitManager';
const live = { kind: 'interactive', cwd: CWD, startedAt: 1000, pid: process.pid, status: 'idle', sessionId: S1 };
let n = 0;
const hook = (ev, extra = {}, tr = {}) => { n++; return { kind: 'hook', transport: { transport_id: `g${n}`, monotonic_ns: String(n * 10), handler_id: 'h1', clock_domain: 'T', ...tr },
  payload: { session_id: S1, cwd: CWD, hook_event_name: ev, ...extra } }; };
const snap = (sessions, tr = {}, payload = {}) => ({ kind: 'discovery', transport: { ...tr }, payload: { scope: { cwd: null }, sessions, ...payload } });
const run = (es) => replay(es.map((e, i) => ({ seq: i + 1, ...e })), registry);
const st = (r, key = S1) => r.sessions.get(key);
const INTERVAL = (uncertain = []) => ({ interval: { complete: true, before_files: 0, drained: 0, uncertain } });

test('BARRIER (found live): a SessionStart written before the snapshots cannot resurrect the session, whatever order files are read', () => {
  const d = fs.mkdtempSync(path.join((fs.mkdirSync(path.join(root, '.tmp-tests'), { recursive: true }), path.join(root, '.tmp-tests')), 'bar-'));
  const spool = path.join(d, 'spool'); fs.mkdirSync(spool);
  const store = new Store(path.join(d, 'store'));
  const e = hook('SessionStart', { source: 'startup' }, { env_id: 'posix' });
  fs.writeFileSync(path.join(spool, `${String(e.transport.monotonic_ns).padStart(20, '0')}-${e.transport.transport_id}.json`),
    JSON.stringify({ schema: 'mini-summa.spool/1', transport: e.transport, payload: e.payload }));
  let listing = [live];
  const run1 = async () => ({ raw: listing });
  return (async () => {
    await takeSnapshot({ store, spools: [spool], envId: 'posix', run: run1 });   // alive; drains the SessionStart first
    listing = [];
    await takeSnapshot({ store, spools: [spool], envId: 'posix', run: run1 });   // gone
    const kinds = store.raw.map((x) => x.kind);
    assert.deepEqual(kinds, ['hook', 'discovery', 'discovery'], 'hook is ordered before both snapshots');
    const r = replay(store.raw, registry);
    const sx = st(r, `posix|${S1}`);
    assert.equal(sx.state, 'presence_lost'); assert.equal(sx.gen.n, 1);
    assert.equal(sx.gen.term.kind, 'absent_from_snapshot');
    assert.ok(store.raw.filter((x) => x.kind === 'discovery').every((x) => x.payload.interval.complete), 'snapshots record their interval');
  })();
});

test('LEGITIMATE RESUME: a SessionStart that arrives after the barrier snapshot opens generation 2', () => {
  const es = [hook('SessionStart', { source: 'startup' }), snap([live], {}, INTERVAL()), snap([], {}, INTERVAL()),
    hook('SessionStart', { source: 'resume' })];
  const r = run(es);
  assert.equal(st(r).gen.n, 2); assert.equal(st(r).state, 'idle');
  assert.ok(labels(r).some((l) => l.endsWith('Idle (resume)')));
  assert.equal(r.derived.filter((d) => d.kind === 'generation').length, 1);
});

test('WALL CLOCKS ESTABLISH NOTHING: neither an older nor a newer wall-clock hook can open or revive a generation', () => {
  // Snapshots recorded without interval metadata, hooks carrying only wall_ms: order is not established either way.
  const base = [snap([live], { wall_ms: 100 }), snap([], { wall_ms: 200 })];
  const older = run([...base, hook('SessionStart', { source: 'startup' }, { wall_ms: 50, monotonic_ns: undefined, clock_domain: null })]);
  const newer = run([...base, hook('SessionStart', { source: 'resume' }, { wall_ms: 300, monotonic_ns: undefined, clock_domain: null })]);
  for (const r of [older, newer]) { assert.equal(st(r).state, 'presence_lost'); assert.equal(st(r).gen.n, 1); assert.equal(st(r).unresolved.length, 1); }
});

test('AMBIGUOUS ordering (no barrier, no clocks): a hook does not revive a terminated session; the ambiguity is counted', () => {
  const r = run([snap([live], { received_at: undefined }), snap([], { received_at: undefined }),
    hook('SessionStart', { source: 'startup' }, { monotonic_ns: undefined, wall_ms: undefined })]);
  assert.equal(st(r).state, 'presence_lost'); assert.equal(r.ordering_ambiguous, 1);
});

test('hook-to-hook ordering uses the monotonic clock: a delayed PostToolUse older than SessionEnd is history, not a new generation', () => {
  const t0 = hook('UserPromptSubmit', { prompt_id: 'p' }); const late = hook('PostToolUse', { prompt_id: 'p', tool_use_id: 'tu' });
  const end = hook('SessionEnd', { reason: 'other' });
  late.transport.monotonic_ns = '1'; // executed before SessionEnd, delivered after it
  const r = run([hook('SessionStart', { source: 'startup' }), t0, end, late]);
  assert.equal(st(r).gen.n, 1); assert.equal(st(r).state, 'ended');
  assert.ok(r.derived.some((d) => d.kind === 'late_event' && d.stale_generation));
});

test('a new SessionStart after SessionEnd (resume) opens generation 2', () => {
  const r = run([hook('SessionStart', { source: 'startup' }), hook('SessionEnd', { reason: 'other' }), hook('SessionStart', { source: 'resume' })]);
  assert.equal(st(r).gen.n, 2); assert.equal(st(r).state, 'idle');
});

test('killed without SessionEnd, then resumed with no snapshot in between: second startup/resume means a new process', () => {
  const r = run([hook('SessionStart', { source: 'startup' }), hook('UserPromptSubmit', { prompt_id: 'p' }), hook('SessionStart', { source: 'resume' })]);
  assert.equal(st(r).gen.n, 2);
});

test('SessionStart sources clear and compact stay in the same generation', () => {
  const r = run([hook('SessionStart', { source: 'startup' }), hook('SessionStart', { source: 'compact' }), hook('SessionStart', { source: 'clear' })]);
  assert.equal(st(r).gen.n, 1);
});

test('SUSPECTED vs OBSERVED: a suspected loss is revised when the same process is listed again; an observed exit is not', () => {
  const flap = run([snap([live], { wall_ms: 1 }, INTERVAL()), snap([], { wall_ms: 2 }, INTERVAL()), snap([live], { wall_ms: 3 }, INTERVAL())]);
  assert.equal(st(flap).gen.n, 1); assert.equal(st(flap).gen.phase, 'live');
  const dead = { ...live, pid_alive: false };
  const obs = run([snap([live], {}, INTERVAL()), snap([dead], {}, INTERVAL()), snap([live], {}, INTERVAL())]);
  assert.equal(st(obs).gen.phase, 'ended_observed'); assert.equal(obs.stale_listings, 1);
  assert.equal(st(obs).state, 'ended');
});

test('a different process (pid or start time) serving the same session id is a new generation, found by discovery alone', () => {
  const r = run([snap([live], {}, INTERVAL()), snap([{ ...live, pid_alive: false }], {}, INTERVAL()),
    snap([{ ...live, pid: 77, startedAt: 5000 }], {}, INTERVAL())]);
  assert.equal(st(r).gen.n, 2); assert.equal(st(r).gen.proc.pid, 77); assert.equal(st(r).state, 'idle');
});

test('SessionEnd arriving after the process exit was already observed is redundant history, never a new incarnation', () => {
  const r = run([snap([live], {}, INTERVAL()), snap([{ ...live, pid_alive: false }], {}, INTERVAL()), hook('SessionEnd', { reason: 'other' })]);
  assert.equal(st(r).gen.n, 1);
});

test('the same session id in different environments is two sessions', () => {
  const w = hook('SessionStart', { source: 'startup', cwd: 'C:\\Dev\\GitManager' }, { env_id: 'win' });
  const l = hook('SessionStart', { source: 'startup' }, { env_id: 'wsl:Ubuntu' });
  const r = run([w, l]);
  assert.equal(r.sessions.size, 2);
});
