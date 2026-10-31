import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { evaluateSeparateDiscovery as ev } from '../src/lib/discovery.mjs';
import { root } from './helpers.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const sess = (sessionId, extra = {}) => ({ kind: 'interactive', cwd: '/x', startedAt: 1, pid: 1, status: 'idle', sessionId, ...extra });

test('Q18: two EMPTY listings are NOT TESTED, never PASS (the defect)', () => {
  const r = ev({ win: [], wsl: [] });
  assert.equal(r.status, 'NOT TESTED'); assert.match(r.notes.join(' '), /either environment/);
});

test('Q18: a valid session in only one environment is NOT TESTED and names the empty side', () => {
  assert.match(ev({ win: [sess(A)], wsl: [] }).notes.join(' '), /established in WSL/);
  assert.match(ev({ win: [], wsl: [sess(B)] }).notes.join(' '), /established in Windows/);
  assert.equal(ev({ win: [sess(A)], wsl: [] }).status, 'NOT TESTED');
});

test('Q18: sessions without a usable session id are not evidence, and missing ids never "match" each other', () => {
  const r = ev({ win: [sess(undefined), sess(null)], wsl: [sess(undefined), sess('not-a-uuid'), sess('')] });
  assert.equal(r.status, 'NOT TESTED'); assert.match(r.notes.join(' '), /5 listed session\(s\) have no valid session id/);
  assert.equal(ev({ win: [sess(A), sess(undefined)], wsl: [sess(B), sess(undefined)] }).status, 'PASS', 'unidentified entries are ignored, not collided and not counted');
});

test('Q18: PASS needs a valid, distinct session in each environment', () => {
  const r = ev({ win: [sess(A)], wsl: [sess(B)] });
  assert.equal(r.status, 'PASS'); assert.match(r.notes.join(' '), /1 with a valid session id/);
});

test('Q18: an identity collision is a FAIL, case-insensitively, even when other sessions are fine', () => {
  assert.equal(ev({ win: [sess(A)], wsl: [sess(A)] }).status, 'FAIL');
  assert.equal(ev({ win: [sess(A.toUpperCase())], wsl: [sess(A)] }).status, 'FAIL');
  const r = ev({ win: [sess(A), sess(B)], wsl: [sess('33333333-3333-4333-8333-333333333333'), sess(B)] });
  assert.equal(r.status, 'FAIL'); assert.match(r.notes.join(' '), /identity collision: 1/);
});

test('Q18: a discovery error is a FAIL attributed to its environment, not an empty list', () => {
  const r1 = ev({ win: new Error('claude.exe not found'), wsl: [sess(B)] });
  assert.equal(r1.status, 'FAIL'); assert.match(r1.notes[0], /^Windows discovery failed: claude.exe not found/);
  const r2 = ev({ win: [sess(A)], wsl: new Error('wsl.exe exited 1') });
  assert.equal(r2.status, 'FAIL'); assert.match(r2.notes[0], /^WSL discovery failed/);
  assert.equal(ev({ win: [], wsl: new Error('boom') }).status, 'FAIL', 'an error is never softened to NOT TESTED');
});

test('Q18: a non-list answer is a FAIL', () => {
  assert.equal(ev({ win: { not: 'a list' }, wsl: [sess(B)] }).status, 'FAIL');
  assert.equal(ev({ win: [sess(A)], wsl: undefined }).status, 'FAIL');
  assert.equal(ev({ win: null, wsl: null }).status, 'FAIL');
});

test('Q18: expected ids sharpen the check: each must be found at home and absent from the other side', () => {
  assert.equal(ev({ win: [sess(A)], wsl: [sess(B)], expect: { win: A, wsl: B } }).status, 'PASS');
  assert.equal(ev({ win: [sess(A)], wsl: [sess(B)], expect: { win: A.toUpperCase(), wsl: B } }).status, 'PASS');
  // the session I started in Windows is not listed yet: nothing established, not a failure
  assert.equal(ev({ win: [sess(B)], wsl: [sess(B)], expect: { win: A } }).status, 'FAIL', 'a collision is still a collision');
  assert.equal(ev({ win: [sess(B)], wsl: [sess('33333333-3333-4333-8333-333333333333')], expect: { win: A } }).status, 'NOT TESTED');
  // the Windows session leaked into WSL's listing
  assert.equal(ev({ win: [sess(A)], wsl: [sess(B), sess(A)], expect: { win: A, wsl: B } }).status, 'FAIL');
  assert.equal(ev({ win: [sess(A), sess(B)], wsl: [sess(B)], expect: { win: A, wsl: B } }).status, 'FAIL');
});

test('Q18 in the runner: off Windows, or without the WSL options, it is NOT TESTED and never calls anything', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/qualify.mjs'), 'run', '--base', path.join(root, '.tmp-tests', 'q18run'), '--only', 'Q18'], { encoding: 'utf8' });
  assert.match(r.stdout, /NOT TESTED\s+Q18/);
  assert.doesNotMatch(r.stdout, /PASS\s+Q18/);
});
