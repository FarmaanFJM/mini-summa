import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/lib/store.mjs';
import { replay } from '../src/lib/reducer.mjs';
import { root, registry, S1, S2, labels } from './helpers.mjs';

// Builders. handler = which registration delivered the file. mono = same-host monotonic clock.
let n = 0;
const hook = (ev, extra = {}, { handler = 'h1', sid = S1, prompt = 'p1', env, tid } = {}) => {
  n++;
  return { kind: 'hook', transport: { transport_id: tid ?? `t${n}`, monotonic_ns: String(n * 10), handler_id: handler, env_id: env },
    payload: { session_id: sid, cwd: '/w/GitManager', ...(prompt ? { prompt_id: prompt } : {}), hook_event_name: ev, ...extra } };
};
const seqd = (es) => es.map((e, i) => ({ seq: i + 1, ...e }));
const run = (es) => replay(seqd(es), registry);
const perm = (cmd = 'ls') => ({ tool_name: 'Bash', tool_input: { command: cmd } });
const pre = (id, cmd = 'ls') => ({ ...perm(cmd), tool_use_id: id });

test('FLAW OF THE OLD RULE: parallel identical permission requests are two real events and both survive', () => {
  // Pre1 Pre2 Perm1 Perm2: the two PermissionRequests share "the last different event" (Pre2) and identical content.
  const r = run([hook('UserPromptSubmit'), hook('PreToolUse', pre('t1')), hook('PreToolUse', pre('t2')),
    hook('PermissionRequest', perm()), hook('PermissionRequest', perm())]);
  const perms = [...r.logical.values()].filter((l) => l.ev === 'PermissionRequest');
  assert.equal(perms.length, 2);
  assert.deepEqual(perms.map((l) => l.occurrence), [1, 2]);
  assert.equal(r.duplicates.length, 0);
});

test('identical Notifications with nothing between them are two events when one handler delivered both', () => {
  const idle = { notification_type: 'idle_prompt', message: 'waiting' };
  const r = run([hook('Notification', idle), hook('Notification', idle)]);
  assert.equal(r.logical.size, 2); assert.equal(r.duplicates.length, 0);
});

test('two registrations delivering one event collapse, whichever delivery arrives first', () => {
  const stopMsg = { last_assistant_message: 'question?', background_tasks: [], session_crons: [] };
  const a = run([hook('Stop', stopMsg, { handler: 'h1' }), hook('Stop', stopMsg, { handler: 'h2' })]);
  const b = run([hook('Stop', stopMsg, { handler: 'h2' }), hook('Stop', stopMsg, { handler: 'h1' })]);
  for (const r of [a, b]) { assert.equal(r.logical.size, 1); assert.equal(r.duplicates.length, 1); }
});

test('two real identical events seen by two registrations: two logical events, two duplicates', () => {
  const idle = { notification_type: 'idle_prompt', message: 'waiting' };
  const r = run([hook('Notification', idle, { handler: 'h1' }), hook('Notification', idle, { handler: 'h2' }),
    hook('Notification', idle, { handler: 'h1' }), hook('Notification', idle, { handler: 'h2' })]);
  assert.equal(r.logical.size, 2); assert.equal(r.duplicates.length, 2);
});

test('AMBIGUITY (documented): a repeat from the SAME handler cannot be told from a second real event, so it is kept; nothing derived repeats', () => {
  const msg = 'done\n<!-- mini-summa:report status=complete task="T" -->';
  const stop = { last_assistant_message: msg, background_tasks: [], session_crons: [] };
  const r = run([hook('UserPromptSubmit'), hook('Stop', stop), hook('Stop', stop)]);
  assert.equal(r.logical.size, 3, 'safe direction: nothing is discarded');
  assert.equal(r.reports.size, 1, 'same prompt and same text is one report');
  assert.equal(r.derived.filter((d) => d.notify).length, 1, 'one notification');
  assert.ok(r.derived.some((d) => d.kind === 'report_duplicate'));
});

test('one handler lost a delivery: the surviving events still all count', () => {
  const idle = { notification_type: 'idle_prompt', message: 'w' };
  // h1 delivered both real events; h2 missed the first one and delivered only the second.
  const r = run([hook('Notification', idle, { handler: 'h1' }), hook('Notification', idle, { handler: 'h1' }), hook('Notification', idle, { handler: 'h2' })]);
  assert.equal(r.logical.size, 2);
});

test('delayed events: identical events keep the same logical identities in any arrival order', () => {
  const idle = (m) => ({ notification_type: 'idle_prompt', message: m });
  const set = (es) => [...run(es).logical.keys()].sort();
  const es = [hook('Notification', idle('a')), hook('Notification', idle('b')), hook('Notification', idle('a'), { handler: 'h2' }), hook('Notification', idle('a'))];
  const rev = [...es].reverse().map((e, i) => ({ ...e, transport: { ...e.transport, transport_id: `r${i}` } }));
  assert.deepEqual(set(es), set(rev));
});

test('delayed event from an older prompt does not change the current state but is kept', () => {
  const m = (t) => `r\n<!-- mini-summa:report status=complete task="${t}" -->`;
  const r = run([hook('UserPromptSubmit', {}, { prompt: 'p1' }), hook('UserPromptSubmit', {}, { prompt: 'p2' }),
    hook('Stop', { last_assistant_message: m('one'), background_tasks: [], session_crons: [] }, { prompt: 'p1' })]);
  assert.equal(r.sessions.get(S1).state, 'working');
  assert.equal(r.reports.size, 1);
});

test('identities are separate layers: task, report and notification', () => {
  const m = '## Implementation Report\nsame text\n<!-- mini-summa:report status=complete task="T" -->';
  const stop = { last_assistant_message: m, background_tasks: [], session_crons: [] };
  const r = run([hook('UserPromptSubmit', {}, { prompt: 'p1' }), hook('Stop', stop, { prompt: 'p1' }),
    hook('UserPromptSubmit', {}, { prompt: 'p2' }), hook('Stop', stop, { prompt: 'p2' })]);
  assert.equal(r.reports.size, 2, 'two tasks with identical text are two reports');
  const [a, b] = [...r.reports.values()];
  assert.notEqual(a.task_id, b.task_id); assert.notEqual(a.report_id, b.report_id); assert.equal(a.body_sha256, b.body_sha256);
  const ids = r.derived.map((d) => d.derived_id);
  assert.equal(new Set(ids).size, ids.length, 'every derived event, hence every notification, has its own id');
});

test('without a prompt_id a task cannot be identified: distinct Stops stay distinct reports, a second handler copy does not', () => {
  const m = 'x\n<!-- mini-summa:report status=partial task="T" -->';
  const stop = { last_assistant_message: m, background_tasks: [], session_crons: [] };
  const r = run([hook('Stop', stop, { prompt: null }), hook('Stop', stop, { prompt: null, handler: 'h2' }), hook('Stop', stop, { prompt: null })]);
  assert.equal(r.reports.size, 2, 'h2 copy collapsed; the later same-handler Stop is a separate report');
});

// ---- receipt identity and restart ----
const tmp = (name) => { fs.mkdirSync(path.join(root, '.tmp-tests'), { recursive: true }); return fs.mkdtempSync(path.join(root, '.tmp-tests', `${name}-`)); };
const spoolRec = (e) => JSON.stringify({ schema: 'mini-summa.spool/1', transport: e.transport, payload: e.payload });

test('RECEIPT identity: the same spool file processed again after a restart is a no-op, however many times', () => {
  const d = tmp('receipt'); const spool = path.join(d, 'spool'); fs.mkdirSync(spool);
  const e = hook('Stop', { last_assistant_message: 'x', background_tasks: [], session_crons: [] }, { tid: 'fixed-id' });
  const name = '00000000000000000010-fixed-id.json';
  fs.writeFileSync(path.join(spool, name), spoolRec(e));
  assert.equal(new Store(path.join(d, 's')).ingestSpool(spool).ingested, 1);
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(spool, name), spoolRec(e)); // file reappears (crash before rename, restored backup...)
    const res = new Store(path.join(d, 's')).ingestSpool(spool);
    assert.deepEqual([res.ingested, res.already_ingested], [0, 1]);
  }
  assert.equal(new Store(path.join(d, 's')).raw.length, 1);
});

test('RECEIPT vs LOGICAL: a different invocation with identical payload is a new receipt (kept raw), same logical event only if another handler', () => {
  const d = tmp('rl'); const spool = path.join(d, 'spool'); fs.mkdirSync(spool);
  const idle = { notification_type: 'idle_prompt', message: 'w' };
  const es = [hook('Notification', idle, { handler: 'h1' }), hook('Notification', idle, { handler: 'h2' })];
  es.forEach((e, i) => fs.writeFileSync(path.join(spool, `${String(i).padStart(20, '0')}-${e.transport.transport_id}.json`), spoolRec(e)));
  const s = new Store(path.join(d, 's')); s.ingestSpool(spool);
  assert.equal(s.raw.length, 2, 'both receipts preserved');
  const r = replay(s.raw, registry);
  assert.equal(r.logical.size, 1); assert.equal(r.duplicates.length, 1);
});

test('RESTART: ingest half, restart, ingest the rest, redeliver one file: same logical events, same derived ids, nothing announced twice', () => {
  const d = tmp('restart2'); const sd = path.join(d, 's');
  const idle = { notification_type: 'idle_prompt', message: 'w' };
  const all = [hook('UserPromptSubmit'), hook('Stop', { last_assistant_message: 'q?', background_tasks: [], session_crons: [] }),
    hook('Notification', idle, { handler: 'h1' }), hook('Notification', idle, { handler: 'h2' }), hook('Notification', idle, { handler: 'h1' })];
  const single = replay(seqd(all), registry);
  const a = new Store(sd); all.slice(0, 3).forEach((e) => a.appendRaw(e));
  const first = a.persist(replay(a.raw, registry));
  const b = new Store(sd); all.slice(0, 3).forEach((e) => b.appendRaw(e)); // redelivery of already-ingested receipts
  all.slice(3).forEach((e) => b.appendRaw(e));
  const second = b.persist(replay(b.raw, registry));
  const final = replay(b.raw, registry);
  assert.deepEqual([...final.logical.keys()], [...single.logical.keys()]);
  assert.deepEqual(final.derived.map((x) => x.derived_id), single.derived.map((x) => x.derived_id));
  assert.equal(new Set([...first, ...second].map((x) => x.derived_id)).size, first.length + second.length, 'nothing announced twice');
  assert.equal(b.raw.length, 5);
});

test('different sessions with identical payloads never interact', () => {
  const idle = { notification_type: 'idle_prompt', message: 'w' };
  const r = run([hook('Notification', idle, { sid: S1 }), hook('Notification', idle, { sid: S2 })]);
  assert.equal(r.logical.size, 2); assert.equal(r.duplicates.length, 0);
});
