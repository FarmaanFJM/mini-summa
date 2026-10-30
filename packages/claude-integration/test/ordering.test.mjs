import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/lib/store.mjs';
import { replay } from '../src/lib/reducer.mjs';
import { takeSnapshot, tidOfSpoolName } from '../src/lib/snapshot.mjs';
import { clockDomain, bootKey, compareMarkers, markerOf } from '../src/lib/clock.mjs';
import { spawnSync } from 'node:child_process';
import { root, registry, S1 } from './helpers.mjs';

// Process ids that are alive or dead BY CONSTRUCTION, so the real liveness check is deterministic on any machine.
const ME = process.pid; const OTHER = process.ppid;
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;  // a child that has already exited

// Causal ordering around discovery. Every test is deterministic: discovery is a fake whose completion the test
// controls with a promise, and hooks are written into a temporary spool at exactly the moment under test.
const CWD = '/w/GitManager';
const KEY = `posix|${S1}`;
const live = { kind: 'interactive', cwd: CWD, startedAt: 1000, pid: ME, status: 'idle', sessionId: S1 };
const gone = [];
const dir = (n) => { fs.mkdirSync(path.join(root, '.tmp-tests'), { recursive: true }); return fs.mkdtempSync(path.join(root, '.tmp-tests', `${n}-`)); };
let n = 0;
function hook(spool, ev, extra = {}, tr = {}) {
  n++;
  const tid = tr.transport_id ?? `ord-${n}`;
  const rec = { schema: 'mini-summa.spool/1',
    transport: { transport_id: tid, monotonic_ns: String(1e6 + n), handler_id: 'h1', env_id: 'posix', clock_domain: 'posix|boot:test', ...tr },
    payload: { session_id: S1, cwd: CWD, hook_event_name: ev, ...extra } };
  fs.writeFileSync(path.join(spool, `${String(rec.transport.monotonic_ns).padStart(20, '0')}-${tid}.json`), JSON.stringify(rec));
  return tid;
}
function rig(name) {
  const d = dir(name); const spool = path.join(d, 'spool'); fs.mkdirSync(spool);
  const store = new Store(path.join(d, 'store'));
  const snap = (sessions, run) => takeSnapshot({ store, spools: [spool], envId: 'posix', run: run ?? (async () => ({ raw: sessions })) });
  const sess = () => replay(store.raw, registry).sessions.get(KEY);
  return { d, spool, store, snap, sess, rep: () => replay(store.raw, registry) };
}
// A discovery call the test can hold open: `during` runs while it is in flight, then `result` is returned.
function inFlight(during, result) {
  let release; const gate = new Promise((r) => { release = r; });
  return { run: async () => { during(); await gate; return { raw: result }; }, release };
}
const MARK = (st = 'complete') => `done\n<!-- mini-summa:report status=${st} task="T" -->`;

test('1. a hook already in the spool before the barrier is ingested BEFORE the snapshot, and is not "uncertain"', async () => {
  const R = rig('o1');
  const tid = hook(R.spool, 'SessionStart', { source: 'startup' });
  const { entry } = await R.snap([live]);
  const order = R.store.raw.map((e) => e.kind);
  assert.deepEqual(order, ['hook', 'discovery']);
  assert.ok(!entry.payload.interval.uncertain.includes(tid));
  assert.equal(entry.payload.interval.drained, 1);
});

test('2. REGRESSION: a generic hook produced while discovery is in flight cannot reopen a generation the snapshot reports gone', async () => {
  const R = rig('o2');
  hook(R.spool, 'SessionStart', { source: 'startup' });
  await R.snap([live]);
  let tid;
  const f = inFlight(() => { tid = hook(R.spool, 'PostToolUse', { tool_use_id: 'tu-1', tool_name: 'Read', prompt_id: 'p1' }); }, gone);
  const p = R.snap(null, f.run); f.release(); const { entry } = await p;
  R.store.ingestSpool(R.spool);                                      // the delayed hook is ingested afterwards
  assert.deepEqual(entry.payload.interval.uncertain, [tid], 'the snapshot itself says this receipt is in the unresolved interval');
  const s = R.sess();
  assert.equal(s.gen.n, 1); assert.equal(s.gen.phase, 'lost_suspected'); assert.equal(s.state, 'presence_lost');
  assert.equal(s.unresolved.length, 1); assert.equal(s.unresolved[0].relation, 'uncertain');
  assert.ok(R.store.raw.some((e) => e.transport.transport_id === tid), 'receipt preserved');
  assert.ok(!R.rep().derived.some((d) => d.kind === 'generation'));
});

test('3. several hooks produced during the unresolved interval are all preserved and fabricate no generation', async () => {
  const R = rig('o3');
  hook(R.spool, 'SessionStart', { source: 'startup' });
  await R.snap([live]);
  const f = inFlight(() => {
    hook(R.spool, 'PreToolUse', { tool_use_id: 'a', prompt_id: 'p1' }); hook(R.spool, 'PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1' });
    hook(R.spool, 'PostToolUse', { tool_use_id: 'a', prompt_id: 'p1' });
    hook(R.spool, 'Stop', { prompt_id: 'p1', last_assistant_message: MARK(), background_tasks: [], session_crons: [] });
  }, gone);
  const p = R.snap(null, f.run); f.release(); await p;
  R.store.ingestSpool(R.spool);
  const r = R.rep(); const s = r.sessions.get(KEY);
  assert.equal(s.gen.n, 1); assert.equal(s.state, 'presence_lost');
  assert.equal(s.unresolved.length, 4);
  assert.equal(R.store.raw.filter((e) => e.kind === 'hook').length, 5, 'one SessionStart plus four in-flight receipts, all kept');
  assert.equal(r.reports.size, 1, 'a stale Stop still yields its report evidence');
  assert.equal([...r.reports.values()][0].late, true); assert.equal([...r.reports.values()][0].verified, false);
});

test('4. a delayed startup/resume SessionStart is NOT a genuine resume when its order is not established', async () => {
  // (a) in flight during the snapshot that says gone
  const R = rig('o4');
  hook(R.spool, 'SessionStart', { source: 'startup' });
  await R.snap([live]);
  const f = inFlight(() => hook(R.spool, 'SessionStart', { source: 'resume' }), gone);
  const p = R.snap(null, f.run); f.release(); await p; R.store.ingestSpool(R.spool);
  assert.equal(R.sess().gen.n, 1); assert.equal(R.sess().state, 'presence_lost'); assert.equal(R.sess().unresolved.length, 1);
  // (b) hook-only, clock domain unknown (native Windows): SessionEnd then resume cannot be ordered by clock
  const win = (ev, extra, k) => ({ seq: k, kind: 'hook', transport: { transport_id: `w${k}`, monotonic_ns: String(k), env_id: 'win', clock_domain: null, handler_id: 'h1' },
    payload: { session_id: S1, cwd: CWD, hook_event_name: ev, ...extra } });
  const r = replay([win('SessionStart', { source: 'startup' }, 1), win('SessionEnd', { reason: 'other' }, 2), win('SessionStart', { source: 'resume' }, 3)], registry);
  const s = [...r.sessions.values()][0];
  assert.equal(s.gen.n, 1); assert.equal(s.state, 'ended'); assert.equal(s.unresolved.length, 1);
});

test('5. a genuine resume with adequate evidence opens exactly one new generation', async () => {
  // (a) the hook lands after the completed observation
  const A = rig('o5a');
  hook(A.spool, 'SessionStart', { source: 'startup' }); await A.snap([live]); await A.snap(gone);
  hook(A.spool, 'SessionStart', { source: 'resume' }); A.store.ingestSpool(A.spool);
  assert.equal(A.sess().gen.n, 2); assert.equal(A.sess().state, 'idle');
  assert.equal(A.rep().derived.filter((d) => d.kind === 'generation').length, 1);
  // (b) hook-only, same trusted clock domain: SessionStart(resume) after SessionEnd
  const B = rig('o5b');
  hook(B.spool, 'SessionStart', { source: 'startup' }); hook(B.spool, 'SessionEnd', { reason: 'other' }); hook(B.spool, 'SessionStart', { source: 'resume' });
  B.store.ingestSpool(B.spool);
  assert.equal(B.sess().gen.n, 2); assert.equal(B.rep().derived.filter((d) => d.kind === 'generation').length, 1);
  // (c) resolved later by discovery: an in-flight (uncertain) resume stays unresolved until a DIFFERENT live process is listed
  const C = rig('o5c');
  hook(C.spool, 'SessionStart', { source: 'startup' }); await C.snap([live]);
  const f = inFlight(() => hook(C.spool, 'SessionStart', { source: 'resume' }), gone);
  const p = C.snap(null, f.run); f.release(); await p; C.store.ingestSpool(C.spool);
  assert.equal(C.sess().gen.n, 1);
  await C.snap([{ ...live, pid: OTHER, startedAt: 9000 }]);
  const s = C.sess();
  assert.equal(s.gen.n, 2); assert.equal(s.gen.proc.pid, OTHER);
  assert.equal(s.generations[0].unresolved.length, 1, 'the uncertain resume is kept with the generation it was withheld from');
  assert.equal(C.rep().derived.filter((d) => d.kind === 'generation').length, 1);
});

test('6. a late SessionEnd cannot create a generation, and cannot close a newer one it does not provably belong to', async () => {
  const R = rig('o6');
  hook(R.spool, 'SessionStart', { source: 'startup' }); await R.snap([live]); await R.snap(gone);
  hook(R.spool, 'SessionEnd', { reason: 'other' }); R.store.ingestSpool(R.spool);       // after-class SessionEnd for a closed generation
  assert.equal(R.sess().gen.n, 1);
  assert.equal(R.sess().unresolved.length, 0, 'a redundant SessionEnd is plain history, not an unresolved question');
  // even when the SessionEnd was in flight during the snapshot that closed it, it only repeats a known closure
  const R2 = rig('o6b');
  hook(R2.spool, 'SessionStart', { source: 'startup' }); await R2.snap([live]);
  const fl = inFlight(() => hook(R2.spool, 'SessionEnd', { reason: 'other' }), gone);
  const pr = R2.snap(null, fl.run); fl.release(); await pr; R2.store.ingestSpool(R2.spool);
  assert.equal(R2.sess().gen.n, 1); assert.equal(R2.sess().unresolved.length, 0);
  // generation 2 is live; a SessionEnd whose order vs its start is unknown must not kill it
  const r = replay([
    { seq: 1, kind: 'hook', transport: { transport_id: 'a', monotonic_ns: '10', env_id: 'posix', clock_domain: 'D', handler_id: 'h1' }, payload: { session_id: S1, cwd: CWD, hook_event_name: 'SessionStart', source: 'startup' } },
    { seq: 2, kind: 'hook', transport: { transport_id: 'b', monotonic_ns: '20', env_id: 'posix', clock_domain: 'D', handler_id: 'h1' }, payload: { session_id: S1, cwd: CWD, hook_event_name: 'SessionEnd', reason: 'other' } },
    { seq: 3, kind: 'hook', transport: { transport_id: 'c', monotonic_ns: '30', env_id: 'posix', clock_domain: 'D', handler_id: 'h1' }, payload: { session_id: S1, cwd: CWD, hook_event_name: 'SessionStart', source: 'resume' } },
    { seq: 4, kind: 'hook', transport: { transport_id: 'd', monotonic_ns: '15', env_id: 'posix', clock_domain: 'D', handler_id: 'h1' }, payload: { session_id: S1, cwd: CWD, hook_event_name: 'SessionEnd', reason: 'other', prompt_id: 'old' } },
    { seq: 5, kind: 'hook', transport: { transport_id: 'e', monotonic_ns: '25', env_id: 'posix', clock_domain: null, handler_id: 'h1' }, payload: { session_id: S1, cwd: CWD, hook_event_name: 'SessionEnd', reason: 'other', prompt_id: 'unknown-order' } },
  ], registry);
  const s = r.sessions.get(KEY);
  assert.equal(s.gen.n, 2); assert.equal(s.gen.phase, 'live'); assert.equal(s.state, 'idle', 'neither the older nor the unorderable SessionEnd closed generation 2');
  assert.equal(s.unresolved.length, 1, 'only the unorderable one is "uncertain"; the older one is known history');
});

test('7. a process observed dead cannot be revived by a lingering listing of the same process', async () => {
  // (a) observed by a dead pid on this host (a child process that has already exited)
  const dead = { ...live, pid: deadPid() };
  const A = rig('o7a');
  hook(A.spool, 'SessionStart', { source: 'startup' });
  await A.snap([dead]);
  assert.equal(A.sess().gen.phase, 'ended_observed');
  await A.snap([dead]); await A.snap([dead]);
  assert.equal(A.sess().gen.n, 1); assert.equal(A.sess().state, 'ended');
  assert.ok(replay(A.store.raw, registry).stale_listings >= 2);
  // (b) observed by the SessionEnd hook, while the listing of the same process lingers and still looks alive
  const B = rig('o7b');
  hook(B.spool, 'SessionStart', { source: 'startup' });
  await B.snap([live]);                                                  // learns the process identity
  hook(B.spool, 'SessionEnd', { reason: 'other' }); B.store.ingestSpool(B.spool);
  assert.equal(B.sess().gen.phase, 'ended_observed');
  await B.snap([live]); await B.snap([live]);                            // same pid and start time, still listed
  assert.equal(B.sess().gen.n, 1); assert.equal(B.sess().gen.phase, 'ended_observed'); assert.equal(B.sess().state, 'ended');
  assert.equal(replay(B.store.raw, registry).stale_listings, 2);
  // a DIFFERENT process identity is what would open a new generation
  await B.snap([{ ...live, pid: OTHER, startedAt: 99999 }]);
  assert.equal(B.sess().gen.n, 2);
});

test('8. suspected loss is revised when the SAME process reappears, is never silently confirmed, and a different process opens a generation', async () => {
  const R = rig('o8');
  hook(R.spool, 'SessionStart', { source: 'startup' }); await R.snap([live]); await R.snap(gone);
  assert.equal(R.sess().gen.phase, 'lost_suspected'); assert.notEqual(R.sess().gen.phase, 'ended_observed');
  assert.match(R.rep().derived.find((d) => d.to === 'presence_lost').label, /Presence lost \(suspected\)/);
  await R.snap([live]);                                               // the same pid and start time again
  assert.equal(R.sess().gen.n, 1); assert.equal(R.sess().gen.phase, 'live');
  await R.snap(gone); await R.snap([{ ...live, pid: OTHER, startedAt: 7000 }]);
  assert.equal(R.sess().gen.n, 2);
});

test('9. a failed or interrupted discovery call invents no termination and loses no pending hook', async () => {
  const R = rig('o9');
  hook(R.spool, 'SessionStart', { source: 'startup' }); await R.snap([live]);
  const before = R.store.raw.length;
  let tid;
  await assert.rejects(R.snap(null, async () => { tid = hook(R.spool, 'PostToolUse', { tool_use_id: 'x', prompt_id: 'p' }); throw new Error('claude exited 1'); }), /claude exited 1/);
  assert.equal(R.store.raw.length, before + 1);
  assert.equal(R.store.raw.at(-1).kind, 'discovery_error');
  assert.ok(!R.store.raw.slice(before).some((e) => e.kind === 'discovery'), 'no snapshot recorded');
  assert.ok(fs.readdirSync(R.spool).some((f) => f.includes(tid)), 'the pending hook is still in the spool');
  assert.equal(R.sess().gen.phase, 'live'); assert.equal(R.rep().discovery_errors, 1);
  R.store.ingestSpool(R.spool);                                       // normal ingestion still picks it up
  assert.ok(R.store.raw.some((e) => e.transport.transport_id === tid));
  assert.equal(R.sess().state, 'working');
  await R.snap([live]);                                               // and the next good snapshot works
  assert.equal(R.sess().gen.phase, 'live');
});

test('10. duplicate registrations and same-handler repeats keep their identity rules across the interval boundary', async () => {
  const R = rig('o10');
  hook(R.spool, 'SessionStart', { source: 'startup' }); await R.snap([live]);
  const idle = { notification_type: 'idle_prompt', message: 'w' };
  hook(R.spool, 'Notification', idle, { handler_id: 'h1' });                 // h1 delivers before the call
  const f = inFlight(() => { hook(R.spool, 'Notification', idle, { handler_id: 'h2' }); hook(R.spool, 'Notification', idle, { handler_id: 'h1' }); }, [live]);
  const p = R.snap(null, f.run); f.release(); await p; R.store.ingestSpool(R.spool);
  const r = R.rep();
  const notes = [...r.logical.values()].filter((l) => l.ev === 'Notification');
  assert.equal(notes.length, 2, 'h1 twice = two real events; the h2 copy of the first collapses');
  assert.equal(r.duplicates.length, 1); assert.equal(r.duplicates[0].handler, 'h2');
  assert.equal(R.store.raw.filter((e) => e.payload?.hook_event_name === 'Notification').length, 3, 'all three receipts kept');
});

test('11. replaying the complete log after an ingestor restart yields identical generations, derived ids, reports and notification decisions', async () => {
  const R = rig('o11');
  hook(R.spool, 'SessionStart', { source: 'startup' }); hook(R.spool, 'UserPromptSubmit', { prompt_id: 'p1' });
  await R.snap([live]);
  const f = inFlight(() => { hook(R.spool, 'Stop', { prompt_id: 'p1', last_assistant_message: MARK(), background_tasks: [], session_crons: [] }); hook(R.spool, 'PostToolUse', { tool_use_id: 'z', prompt_id: 'p1' }); }, gone);
  const p = R.snap(null, f.run); f.release(); await p; R.store.ingestSpool(R.spool);
  await R.snap([{ ...live, pid: OTHER, startedAt: 5000 }]);
  const a = replay(R.store.raw, registry);
  const firstFresh = R.store.persist(a);
  const reopened = new Store(path.join(R.d, 'store'));                // "the ingestor restarted"
  const b = replay(reopened.raw, registry); const c = replay(reopened.raw, registry);
  const shape = (x) => JSON.stringify({ gens: [...x.sessions.values()].map((s) => [s.key, s.gen.n, s.gen.phase, s.state, s.generations.map((g) => [g.n, g.phase, g.unresolved.length])]),
    derived: x.derived.map((d) => [d.derived_id, d.kind, d.notify]), reports: [...x.reports.keys()], cands: [...x.candidates.keys()], dups: x.duplicates.length });
  assert.equal(shape(a), shape(b)); assert.equal(shape(b), shape(c));
  assert.equal(reopened.persist(b).length, 0, 'nothing is announced a second time after the restart');
  assert.ok(firstFresh.length > 0);
  assert.equal(b.sessions.get(KEY).gen.n, 2);
});

test('12. clock domains: Windows and WSL2 are never compared, unknown or different boots are uncertain, same domain is ordered', () => {
  const m = (env, domain, mono) => ({ tid: 't', env, domain, mono: String(mono) });
  assert.equal(compareMarkers(m('win', null, 1), m('win', null, 2)), 'uncertain', 'native Windows has no trusted domain here');
  assert.equal(compareMarkers(m('win', 'x', 1), m('wsl:Ubuntu', 'x', 2)), 'uncertain', 'different environments, even with equal domain text');
  assert.equal(compareMarkers(m('wsl:Ubuntu', 'wsl:Ubuntu|boot:A', 1), m('wsl:Ubuntu', 'wsl:Ubuntu|boot:B', 2)), 'uncertain', 'a reboot restarts the counter');
  assert.equal(compareMarkers(m('wsl:Ubuntu', 'wsl:Ubuntu|boot:A', 1), m('wsl:Debian', 'wsl:Ubuntu|boot:A', 2)), 'uncertain');
  assert.equal(compareMarkers(m('wsl:Ubuntu', 'D', 1), m('wsl:Ubuntu', 'D', 2)), 'after');
  assert.equal(compareMarkers(m('wsl:Ubuntu', 'D', 5), m('wsl:Ubuntu', 'D', 2)), 'before');
  assert.equal(compareMarkers(m('wsl:Ubuntu', 'D', 2), m('wsl:Ubuntu', 'D', 2)), 'uncertain');
  assert.equal(compareMarkers(null, m('win', 'D', 1)), 'uncertain');
  // how a domain is derived
  assert.equal(bootKey('win32'), null); assert.equal(bootKey('darwin'), null);
  assert.equal(bootKey('linux', () => 'abc-123\n'), 'abc-123');
  assert.equal(bootKey('linux', () => { throw new Error('nope'); }), null);
  assert.equal(clockDomain('wsl:Ubuntu', 'linux', () => 'abc'), 'wsl:Ubuntu|boot:abc');
  assert.equal(clockDomain('win', 'win32'), null);
  assert.deepEqual(markerOf({ transport_id: 'q', env_id: 'win', monotonic_ns: '5' }), { tid: 'q', env: 'win', domain: null, mono: '5' });
  // the reducer: a Windows and a WSL session sharing one id are two sessions and nothing is compared between them
  const mk = (env, domain, ev, extra, k) => ({ seq: k, kind: 'hook', transport: { transport_id: `m${k}`, monotonic_ns: String(k), env_id: env, clock_domain: domain, handler_id: 'h1' },
    payload: { session_id: S1, cwd: env === 'win' ? 'C:\\Dev\\GitManager' : CWD, hook_event_name: ev, ...extra } });
  const r = replay([mk('win', null, 'SessionStart', { source: 'startup' }, 1), mk('wsl:Ubuntu', 'wsl:Ubuntu|boot:A', 'SessionStart', { source: 'startup' }, 2),
    mk('win', null, 'SessionEnd', {}, 3), mk('wsl:Ubuntu', 'wsl:Ubuntu|boot:A', 'SessionEnd', {}, 4),
    mk('win', null, 'SessionStart', { source: 'resume' }, 5), mk('wsl:Ubuntu', 'wsl:Ubuntu|boot:A', 'SessionStart', { source: 'resume' }, 6)], registry);
  assert.equal(r.sessions.size, 2);
  assert.equal(r.sessions.get(`win|${S1}`).gen.n, 1, 'Windows resume is not ordered by a clock it cannot vouch for');
  assert.equal(r.sessions.get(`wsl:Ubuntu|${S1}`).gen.n, 2, 'WSL resume is ordered inside its own trusted domain');
});

test('spool names yield the transport id used for interval classification', () => {
  assert.equal(tidOfSpoolName('00000000001000000000-abc-def.json'), 'abc-def');
  assert.equal(tidOfSpoolName('weird.json'), 'weird.json');
});

test('ingestion order never sorts receipts across clock domains by their monotonic values', () => {
  const d = dir('sortdom'); const spool = path.join(d, 'spool'); fs.mkdirSync(spool);
  const put = (tid, domain, mono) => fs.writeFileSync(path.join(spool, `${String(mono).padStart(20, '0')}-${tid}.json`), JSON.stringify({ schema: 'mini-summa.spool/1',
    transport: { transport_id: tid, monotonic_ns: String(mono), clock_domain: domain, env_id: 'x' }, payload: { session_id: S1, hook_event_name: 'Notification' } }));
  put('b-late-boot', 'x|boot:B', 5); put('a-early-boot', 'x|boot:A', 900);
  const store = new Store(path.join(d, 's')); store.ingestSpool(spool);
  assert.deepEqual(store.raw.map((e) => e.transport.transport_id), ['a-early-boot', 'b-late-boot'], 'grouped by domain, then by mono inside a domain');
});

test('4c. a live listing is NOT a new incarnation when the closed generation has no known process identity', async () => {
  const R = rig('o4c');
  hook(R.spool, 'SessionStart', { source: 'startup' }); hook(R.spool, 'SessionEnd', { reason: 'other' }); R.store.ingestSpool(R.spool);
  assert.equal(R.sess().gen.phase, 'ended_observed'); assert.equal(R.sess().gen.proc, null);
  await R.snap([{ ...live, pid: OTHER, startedAt: 424242 }]);   // alive, but it may be the dying tail of the old process
  const s = R.sess();
  assert.equal(s.gen.n, 1); assert.equal(s.state, 'ended');
  assert.equal(s.unresolved.length, 1); assert.equal(s.unresolved[0].hook_event, 'discovery_listing');
});

test('4d. a second startup/resume inside a live generation opens a generation only when its order is proven', () => {
  const mk = (k, ev, extra, tr = {}) => ({ seq: k, kind: 'hook', transport: { transport_id: `s${k}`, monotonic_ns: String(k * 10), env_id: 'posix', clock_domain: 'D', handler_id: 'h1', ...tr },
    payload: { session_id: S1, cwd: CWD, hook_event_name: ev, ...extra } });
  // proven AFTER: the process was killed with no SessionEnd and resumed
  assert.equal(replay([mk(1, 'SessionStart', { source: 'startup' }), mk(2, 'SessionStart', { source: 'resume' })], registry).sessions.get(KEY).gen.n, 2);
  // known BEFORE: an older process's SessionStart delivered late. History only.
  const before = replay([mk(2, 'SessionStart', { source: 'startup' }), mk(1, 'SessionStart', { source: 'resume' })], registry).sessions.get(KEY);
  assert.equal(before.gen.n, 1); assert.equal(before.unresolved.length, 0, 'known-older is not uncertain');
  // order NOT established (no trusted clock domain): preserved and exposed, no generation
  const unknown = replay([mk(1, 'SessionStart', { source: 'startup' }, { clock_domain: null }), mk(2, 'SessionStart', { source: 'resume' }, { clock_domain: null })], registry).sessions.get(KEY);
  assert.equal(unknown.gen.n, 1); assert.equal(unknown.unresolved.length, 1); assert.equal(unknown.state, 'idle');
  // clear and compact are never a new process
  assert.equal(replay([mk(1, 'SessionStart', { source: 'startup' }), mk(2, 'SessionStart', { source: 'clear' }), mk(3, 'SessionStart', { source: 'compact' })], registry).sessions.get(KEY).gen.n, 1);
});
