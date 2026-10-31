import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/lib/reducer.mjs';
import { createRegistry } from '../src/lib/registry.mjs';

// CHANGE 4 (docs/CHANGES-FROM-POC.md): opening a generation forgets what discovery saw of the previous one
// (`in_prev_snapshot`, `observed`). In the proof of concept both survived into the new generation, so a session that
// was resumed by a hook and that no snapshot had listed yet was reported "Presence lost (suspected)" by the next full
// snapshot, with a notification, on the strength of the OLD process.

const registry = createRegistry({ projects: [{ id: 'p', name: 'P', roots: ['/w/p'] }] }, { platform: 'linux', real: false });
const S = '11111111-1111-4111-8111-111111111111';
const hk = (seq, ev, extra = {}) => ({ seq, kind: 'hook',
  transport: { transport_id: `t${seq}`, monotonic_ns: String(seq * 10), env_id: 'posix', clock_domain: 'D', handler_id: 'h1' },
  payload: { session_id: S, cwd: '/w/p', hook_event_name: ev, ...extra } });
const IV = { complete: true, before_files: 0, drained: 0, uncertain: [] };
const snap = (seq, sessions) => ({ seq, kind: 'discovery', transport: { env_id: 'posix' }, payload: { scope: { cwd: null }, interval: IV, sessions } });
const live = { kind: 'interactive', cwd: '/w/p', startedAt: 1, pid: 10, status: 'idle', sessionId: S, pid_alive: true };
const labels = (r) => r.derived.filter((d) => d.label).map((d) => d.label);
const session = (r) => r.sessions.get(`posix|${S}`);
const lostNotifications = (r) => r.derived.filter((d) => d.kind === 'transition' && d.to === 'presence_lost' && d.notify);

test('CHANGE 4: the traced scenario: resumed by a hook, never listed since, the next full snapshot does not report it lost', () => {
  const r = replay([
    hk(1, 'SessionStart', { source: 'startup' }), snap(2, [live]), snap(3, []), // generation 1 was listed once, then vanished: suspected loss
    hk(4, 'SessionStart', { source: 'resume' }),                                  // resumed: generation 2, from a hook
    snap(5, []),                                                                 // a full snapshot that has not seen generation 2
  ], registry);
  assert.deepEqual(labels(r), [
    'P / Session 11111111 / Idle (startup)',
    'P / Session 11111111 / Presence lost (suspected)',
    'P / Session 11111111 / Idle (resume)',
  ], 'no second "Presence lost"');
  const s = session(r);
  assert.equal(s.gen.n, 2); assert.equal(s.gen.phase, 'live'); assert.equal(s.state, 'idle');
  assert.equal(s.in_prev_snapshot, false, 'no snapshot has listed generation 2');
  assert.equal(s.observed, null, 'generation 1\'s listing (status, pid) is not generation 2\'s');
  assert.equal(lostNotifications(r).length, 1, 'only generation 1 was ever lost, and it was notified once');
  assert.equal(lostNotifications(r)[0].generation, 1);
  // more snapshots that still do not list it change nothing either
  const more = replay([
    hk(1, 'SessionStart', { source: 'startup' }), snap(2, [live]), snap(3, []), hk(4, 'SessionStart', { source: 'resume' }), snap(5, []), snap(6, []), snap(7, []),
  ], registry);
  assert.equal(session(more).state, 'idle'); assert.equal(lostNotifications(more).length, 1);
  // the archived generation keeps its own story
  assert.equal(s.generations.length, 1); assert.equal(s.generations[0].n, 1); assert.equal(s.generations[0].phase, 'lost_suspected');
});

test('CHANGE 4: once a snapshot lists the new process, losing it is reported: the flag comes from listing, not from history', () => {
  const r = replay([
    hk(1, 'SessionStart', { source: 'startup' }), snap(2, [live]), snap(3, []), hk(4, 'SessionStart', { source: 'resume' }),
    snap(5, [{ ...live, pid: 11, startedAt: 2 }]), // generation 2's process is listed
  ], registry);
  assert.equal(session(r).in_prev_snapshot, true); assert.equal(session(r).observed.pid, 11); assert.equal(session(r).gen.proc.pid, 11);
  const lost = replay([
    hk(1, 'SessionStart', { source: 'startup' }), snap(2, [live]), snap(3, []), hk(4, 'SessionStart', { source: 'resume' }),
    snap(5, [{ ...live, pid: 11, startedAt: 2 }]), snap(6, []),
  ], registry);
  assert.equal(session(lost).gen.phase, 'lost_suspected'); assert.equal(session(lost).state, 'presence_lost');
  assert.equal(labels(lost).at(-1), 'P / Session 11111111 / Presence lost (suspected)');
  assert.equal(lostNotifications(lost).length, 2); assert.deepEqual(lostNotifications(lost).map((d) => d.generation), [1, 2]);
});

test('CHANGE 4: a generation opened by discovery records its own listing, so it can be lost like any listed process', () => {
  const r = replay([snap(1, [live]), snap(2, [{ ...live, pid_alive: false }]), snap(3, [{ ...live, pid: 77, startedAt: 5000 }])], registry);
  const s = session(r);
  assert.equal(s.gen.n, 2); assert.equal(s.gen.proc.pid, 77);
  assert.equal(s.in_prev_snapshot, true); assert.deepEqual(s.observed, { status: 'idle', waitingFor: null, kind: 'interactive', pid: 77 });
  const lost = replay([snap(1, [live]), snap(2, [{ ...live, pid_alive: false }]), snap(3, [{ ...live, pid: 77, startedAt: 5000 }]), snap(4, [])], registry);
  assert.equal(session(lost).gen.phase, 'lost_suspected'); assert.equal(session(lost).gen.n, 2);
});

test('CHANGE 4: a hook-opened generation after an observed SessionEnd also starts with no listing history', () => {
  const r = replay([
    hk(1, 'SessionStart', { source: 'startup' }), snap(2, [live]), hk(3, 'SessionEnd', { reason: 'other' }), hk(4, 'SessionStart', { source: 'resume' }), snap(5, []),
  ], registry);
  const s = session(r);
  assert.equal(s.gen.n, 2); assert.equal(s.gen.phase, 'live'); assert.equal(s.state, 'idle');
  assert.equal(s.in_prev_snapshot, false); assert.equal(s.observed, null);
  assert.ok(!labels(r).some((l) => /Presence lost/.test(l)), 'a snapshot that has not listed the new process says nothing about it');
});

test('CHANGE 4: nothing else moves: a session never resumed keeps its flags, and a first generation starts clean', () => {
  const never = replay([hk(1, 'SessionStart', { source: 'startup' }), snap(2, [live]), snap(3, [])], registry);
  assert.equal(session(never).state, 'presence_lost'); assert.equal(session(never).gen.n, 1);
  assert.equal(session(never).in_prev_snapshot, true); assert.equal(session(never).observed.pid, 10);
  const hookOnly = replay([hk(1, 'SessionStart', { source: 'startup' })], registry);
  assert.equal(session(hookOnly).in_prev_snapshot, false); assert.equal(session(hookOnly).observed, null);
  // a same-process revival is not a new generation: the listing that revives it sets the flags as before
  const revived = replay([hk(1, 'SessionStart', { source: 'startup' }), snap(2, [live]), snap(3, []), snap(4, [live]), snap(5, [])], registry);
  assert.equal(session(revived).gen.n, 1);
  assert.equal(session(revived).gen.phase, 'lost_suspected');
});
