import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { replay } from '../src/lib/reducer.mjs';
import { Store } from '../src/lib/store.mjs';
import { root, registry, S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 8 (docs/CHANGES-FROM-POC.md): reports and candidates say how many credential-like values the hook hid and how many
// strings it cut when it captured the Stop. The proof of concept recorded the counts in the transport and then lost them,
// so a stored report looked byte-for-byte untouched even when `[REDACTED]` had been written into it.

const CAPTURE = path.join(root, 'src', 'hook', 'capture.mjs');
const MARK = (st = 'complete', task = 'T') => `<!-- mini-summa:report status=${st} task="${task}" -->`;
let n = 0;
const stop = (msg, transport = {}, extra = {}) => { n++; return { seq: n, kind: 'hook',
  transport: { transport_id: `c8-${n}`, monotonic_ns: String(n * 10), handler_id: 'h1', ...transport },
  payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: 'p1', hook_event_name: 'Stop', last_assistant_message: msg, background_tasks: [], session_crons: [], ...extra } }; };
const prompt = () => { n++; return { seq: n, kind: 'hook', transport: { transport_id: `c8u-${n}`, monotonic_ns: String(n * 10), handler_id: 'h1' },
  payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: 'p1', hook_event_name: 'UserPromptSubmit', prompt: 'go' } }; };
const run = (entries) => replay(entries.map((e, i) => ({ ...e, seq: i + 1 })), registry);
const only = (map) => [...map.values()][0];

test('CHANGE 8: a report carries the redactions and truncations the hook recorded for that Stop', () => {
  const r = run([prompt(), stop(`done\n${MARK()}`, { redactions: 3, truncations: 1 })]);
  const rep = only(r.reports);
  assert.equal(rep.redactions, 3); assert.equal(rep.truncations, 1);
  assert.equal(typeof rep.redactions, 'number'); assert.equal(typeof rep.truncations, 'number');
  assert.equal(rep.verified, false);
});

test('CHANGE 8: so does a candidate, whatever kept it from being a report', () => {
  const noMarker = only(run([prompt(), stop('Shall I proceed?', { redactions: 2, truncations: 0 })]).candidates);
  assert.equal(noMarker.reason, 'no_marker'); assert.equal(noMarker.redactions, 2); assert.equal(noMarker.truncations, 0);
  const pending = only(run([prompt(), stop(`x\n${MARK()}`, { redactions: 5, truncations: 4 }, { background_tasks: [{ id: 'b', type: 'shell', status: 'running' }] })]).candidates);
  assert.equal(pending.reason, 'marker_present_but_background_work_pending'); assert.equal(pending.redactions, 5); assert.equal(pending.truncations, 4);
  const empty = only(run([prompt(), stop(undefined, { redactions: 1 })]).candidates);
  assert.equal(empty.redactions, 1); assert.equal(empty.truncations, 0);
});

test('CHANGE 8: an entry without counts, or with something that is not a count, gets 0 for both', () => {
  for (const transport of [{}, { redactions: undefined }, { redactions: null, truncations: null }, { redactions: '3', truncations: '1' },
    { redactions: -1, truncations: -5 }, { redactions: 1.5, truncations: 0.5 }, { redactions: NaN, truncations: Infinity }, { redactions: true, truncations: {} }, { redactions: [2], truncations: [] }]) {
    const rep = only(run([prompt(), stop(`ok\n${MARK()}`, transport)]).reports);
    assert.deepEqual([rep.redactions, rep.truncations], [0, 0], JSON.stringify(transport));
  }
  const noTransport = replay([{ seq: 1, kind: 'hook', payload: { session_id: S1, cwd: '/w/GitManager', hook_event_name: 'Stop', last_assistant_message: `ok\n${MARK()}`, background_tasks: [], session_crons: [] } }], registry);
  assert.deepEqual([only(noTransport.reports).redactions, only(noTransport.reports).truncations], [0, 0]);
  const mixed = only(run([prompt(), stop(`ok\n${MARK()}`, { redactions: 7, truncations: 'x' })]).reports);
  assert.deepEqual([mixed.redactions, mixed.truncations], [7, 0], 'each count is judged on its own');
});

test('CHANGE 8: the counts are additive: report ids, task ids, hashes and every derived id are what they were without them', () => {
  const entries = (t) => [prompt(), stop(`done\n${MARK()}`, t), stop('Shall I?', t, { prompt_id: 'p2' })];
  const plain = run(entries({})); const counted = run(entries({ redactions: 9, truncations: 2 }));
  assert.deepEqual([...counted.reports.keys()], [...plain.reports.keys()]);
  assert.deepEqual([...counted.candidates.keys()], [...plain.candidates.keys()]);
  assert.deepEqual(counted.derived.map((d) => d.derived_id), plain.derived.map((d) => d.derived_id));
  const strip = ({ redactions, truncations, ...rest }) => rest;
  assert.deepEqual(strip(only(counted.reports)), strip(only(plain.reports)));
  assert.deepEqual(strip(only(counted.candidates)), strip(only(plain.candidates)));
});

test('CHANGE 8: end to end through the real hook: the hidden values are counted, the body shows [REDACTED], and a clean report says 0', (t) => {
  const d = tmpDir(t, 'redact-e2e');
  const spool = path.join(d, 'spool');
  const env = { ...process.env }; for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_REMOTE', 'MINI_SUMMA_SPOOL', 'MINI_SUMMA_REGISTRY']) delete env[k];
  const hook = (payload) => spawnSync(process.execPath, [CAPTURE, '--spool', spool, '--env', 'posix', '--handler', 'h1', payload.hook_event_name],
    { input: JSON.stringify(payload), encoding: 'utf8', env });
  const base = { session_id: S1, cwd: '/w/GitManager', background_tasks: [], session_crons: [] };
  hook({ ...base, prompt_id: 'p1', hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  hook({ ...base, prompt_id: 'p1', hook_event_name: 'Stop', stop_hook_active: false,
    last_assistant_message: `Called the API with Authorization: Bearer abcdefghijklmnopqrstuv and key sk-ant-api03-SECRETSECRET.\n\n## Implementation Report\n- ok\n\n${MARK('complete', 'Leaky')}`,
    tool_response: { content: 'y'.repeat(9000) } });
  hook({ ...base, prompt_id: 'p2', hook_event_name: 'UserPromptSubmit', prompt: 'again' });
  hook({ ...base, prompt_id: 'p2', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `Nothing sensitive here.\n\n${MARK('complete', 'Clean')}` });
  const store = new Store(path.join(d, 'store'));
  assert.equal(store.ingestSpool(spool).ingested, 4);
  const r = replay(store.raw, registry);
  const reports = [...r.reports.values()];
  const leaky = reports.find((x) => x.task_title === 'Leaky'); const clean = reports.find((x) => x.task_title === 'Clean');
  assert.ok(leaky.redactions >= 2, `expected at least the bearer token and the key to be counted, got ${leaky.redactions}`);
  assert.equal(leaky.truncations, 1);
  assert.ok(leaky.body.includes('[REDACTED]')); assert.ok(!/SECRETSECRET|abcdefghijklmnopqrstuv/.test(leaky.body));
  assert.deepEqual([clean.redactions, clean.truncations], [0, 0]);
  assert.ok(!clean.body.includes('[REDACTED]'));
  // the counts are in the files the store writes, and survive a manual promotion
  store.persist(r);
  const written = JSON.parse(fs.readFileSync(path.join(d, 'store', 'reports', `${leaky.report_id}.json`), 'utf8'));
  assert.deepEqual([written.redactions, written.truncations], [leaky.redactions, 1]);
});

test('CHANGE 8: a promoted candidate keeps the counts of the Stop it came from', (t) => {
  const d = tmpDir(t, 'redact-promote');
  const store = new Store(path.join(d, 'store'));
  for (const e of [prompt(), stop('Question with a [REDACTED] in it', { redactions: 4, truncations: 2 })]) store.appendRaw({ kind: e.kind, transport: e.transport, payload: e.payload });
  const r = replay(store.raw, registry); store.persist(r);
  const [id] = [...r.candidates.keys()];
  const promoted = store.promote(id);
  assert.equal(promoted.source, 'user_promoted'); assert.deepEqual([promoted.redactions, promoted.truncations], [4, 2]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'store', 'reports', `${id}.json`), 'utf8')).redactions, 4);
});
