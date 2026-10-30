import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarker } from '../src/lib/marker.mjs';
import { replay } from '../src/lib/reducer.mjs';
import { registry, S1 } from './helpers.mjs';

// All synthetic. The marker is a declaration by the model; none of these tests can say a task really succeeded.
const M = (status, task = 'Task') => `<!-- mini-summa:report status=${status} task="${task}" -->`;
let n = 0;
const stop = (msg, { prompt = 'p1', bg = [] } = {}) => { n++; return { kind: 'hook', transport: { transport_id: `r${n}`, monotonic_ns: String(n * 10), handler_id: 'h1' },
  payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: prompt, hook_event_name: 'Stop', last_assistant_message: msg, background_tasks: bg, session_crons: [] } }; };
const ups = (prompt) => { n++; return { kind: 'hook', transport: { transport_id: `u${n}`, monotonic_ns: String(n * 10), handler_id: 'h1' },
  payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: prompt, hook_event_name: 'UserPromptSubmit', prompt: 'x' } }; };
const run = (es) => replay(es.map((e, i) => ({ seq: i + 1, ...e })), registry);

test('long report (400 kB, unicode, CRLF, tabs, fenced code) is kept byte for byte', () => {
  const body = `Start ünïcödé ✓\r\n${'line with\ttabs and \`code\`\n'.repeat(20000)}\`\`\`js\nconsole.log(1)\n\`\`\`\n\n## Implementation Report\n${M('complete', 'Long')}\n`;
  assert.ok(body.length > 400000);
  const r = run([ups('p1'), stop(body)]);
  assert.equal([...r.reports.values()][0].body, body);
});

test('partial and blocked reports are reports with the declared status, never "success"', () => {
  for (const status of ['partial', 'blocked']) {
    const r = run([ups('p1'), stop(`text\n${M(status)}`)]);
    const rep = [...r.reports.values()][0];
    assert.equal(rep.declared_status, status); assert.equal(rep.verified, false); assert.match(rep.note, /declaration/);
    assert.ok(r.derived.some((d) => d.label?.includes(`declared ${status}`)));
  }
});

test('malformed or misplaced markers are never reports; the full message is kept as a candidate with the reason', () => {
  const bad = {
    'unknown status': `x\n<!-- mini-summa:report status=done task="T" -->`,
    'missing task': `x\n<!-- mini-summa:report status=complete -->`,
    'unquoted task': `x\n<!-- mini-summa:report status=complete task=T -->`,
    'quote inside title': `x\n<!-- mini-summa:report status=complete task="a"b" -->`,
    'empty title': `x\n<!-- mini-summa:report status=complete task="" -->`,
    'wrong case': `x\n<!-- Mini-Summa:report status=Complete task="T" -->`,
    'text after marker': `x\n${M('complete')}\nthanks!`,
    'marker mid-message': `${M('complete')}\nmore work follows`,
    'indented in a fence': `\`\`\`\n${M('complete')}\n\`\`\``,
    'trailing text on the line': `x\n${M('complete')} done`,
    'no marker': 'plain answer',
  };
  for (const [name, msg] of Object.entries(bad)) {
    const r = run([ups('p1'), stop(msg)]);
    assert.equal(r.reports.size, 0, name);
    assert.equal(r.candidates.size, 1, name);
    assert.equal([...r.candidates.values()][0].body, msg, `${name}: message preserved intact`);
  }
});

test('two markers: only the final line counts, and a quoted marker earlier in the text does not matter', () => {
  const msg = `The instructions say to end with ${M('blocked', 'quoted')}\nbut here is the real one\n${M('complete', 'Real')}`;
  const r = run([ups('p1'), stop(msg)]);
  assert.equal([...r.reports.values()][0].task_title, 'Real');
});

test('identical content from different tasks stays two reports; the same task and text is one', () => {
  const msg = `same text\n${M('complete', 'T')}`;
  assert.equal(run([ups('p1'), stop(msg, { prompt: 'p1' }), ups('p2'), stop(msg, { prompt: 'p2' })]).reports.size, 2);
  assert.equal(run([ups('p1'), stop(msg, { prompt: 'p1' }), stop(msg, { prompt: 'p1' })]).reports.size, 1);
});

test('same task, two genuinely different reports (for example after a hook-forced continuation) are both kept', () => {
  assert.equal(run([ups('p1'), stop(`a\n${M('partial')}`), stop(`b\n${M('complete')}`)]).reports.size, 2);
});

test('a marker with background work still running is not a finished report; kept as a candidate', () => {
  const r = run([ups('p1'), stop(`x\n${M('complete')}`, { bg: [{ id: 'b', type: 'shell', status: 'running' }] })]);
  assert.equal(r.reports.size, 0);
  assert.equal([...r.candidates.values()][0].reason, 'marker_present_but_background_work_pending');
});

test('interrupted session: prompt submitted, then nothing, then the session ends: no report, abnormal end, nothing invented', () => {
  const end = { kind: 'hook', transport: { transport_id: 'e1', monotonic_ns: '9999', handler_id: 'h1' }, payload: { session_id: S1, cwd: '/w/GitManager', hook_event_name: 'SessionEnd', reason: 'other' } };
  const r = run([ups('p1'), end]);
  assert.equal(r.reports.size, 0); assert.equal(r.candidates.size, 0);
  assert.ok(r.derived.some((d) => d.abnormal));
});

test('a Stop with a missing or non-string message is preserved as an empty candidate, not a crash', () => {
  for (const msg of [undefined, null, 42, '']) {
    const r = run([ups('p1'), stop(msg)]);
    assert.equal(r.reports.size, 0); assert.equal(r.candidates.size, 1);
  }
});

test('marker parser: the protocol is exact and tolerant only of surrounding whitespace', () => {
  assert.equal(parseMarker(`x\n  ${M('complete')}  \n\n`).valid, true);
  assert.equal(parseMarker(`x\r\n${M('complete')}\r\n`).valid, true);
  assert.equal(parseMarker(`x\n${M('complete', 'a'.repeat(200))}`).valid, true);
  assert.equal(parseMarker(`x\n${M('complete', 'a'.repeat(201))}`).valid, false);
});
