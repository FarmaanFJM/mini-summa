import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/lib/reducer.mjs';
import { registry, loadFixture, labels, kinds, S1, S2, S3 } from './helpers.mjs';

const run = (name) => replay(loadFixture(name), registry);
const stateOf = (r, sid) => r.sessions.get(sid).state;

test('happy path: Working -> Needs permission -> Working -> Report ready (declared), in order', () => {
  const r = run('happy-path');
  assert.deepEqual(labels(r), [
    'GitManager / Session 11111111 / Idle (startup)',
    'GitManager / Session 11111111 / Working',
    'GitManager / Session 11111111 / Needs permission',
    'GitManager / Session 11111111 / Working',
    'GitManager / Session 11111111 / Report ready, declared complete: Storage System',
    'GitManager / Session 11111111 / Session ended (prompt_input_exit)',
  ]);
  assert.equal(r.reports.size, 1);
  const rep = [...r.reports.values()][0];
  assert.equal(rep.verified, false, 'a declared status is never treated as verified');
  assert.match(rep.note, /declaration/);
});

test('two identical Bash inputs in one prompt are two legitimate events (distinct tool_use_id)', () => {
  const r = run('happy-path');
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.logical.size, 9, 'nine real events, nine logical identities');
});

test('Stop without a marker is "Turn ended", never a report; message preserved as candidate', () => {
  const r = run('no-marker');
  assert.equal(r.reports.size, 0);
  assert.equal(r.candidates.size, 1);
  const c = [...r.candidates.values()][0];
  assert.equal(c.reason, 'no_marker');
  assert.match(c.body, /option A or B/);
  assert.deepEqual(labels(r).slice(-2), ['GitManager / Session 11111111 / Turn ended', 'GitManager / Session 11111111 / Waiting for you (inferred)']);
  assert.ok(!kinds(r).includes('report_ready'));
});

test('duplicate hook delivery (hook registered twice): no extra transitions, notifications or reports; raw duplicates flagged, not dropped', () => {
  const once = run('happy-path');
  const twice = run('duplicate-delivery');
  assert.deepEqual(labels(twice), labels(once));
  assert.equal(twice.reports.size, 1);
  assert.equal(twice.derived.filter((d) => d.notify).length, once.derived.filter((d) => d.notify).length);
  // nine h2 copies are duplicates. The extra Stop from h1 is NOT: one handler delivering the same content twice
  // cannot be told apart from two real events, so it stays a logical event (and changes nothing derived).
  assert.equal(twice.duplicates.length, 9);
  assert.ok(twice.duplicates.every((d) => d.duplicate_of_seq < d.seq && d.handler === 'h2'));
  assert.ok(twice.duplicates.some((d) => d.basis === 'native') && twice.duplicates.some((d) => d.basis === 'occurrence'));
  assert.equal(twice.logical.size, 10);
  assert.ok(twice.derived.some((d) => d.kind === 'report_duplicate'), 'same prompt and text: one report, repeat is audited');
});

test('identical payloads that are legitimately separate events survive', () => {
  const r = run('identical-legitimate');
  const starts = r.derived.filter((d) => d.kind === 'transition' && d.to === 'idle');
  assert.equal(r.duplicates.length, 0, 'resume/end/resume and repeated idle_prompt are not duplicates');
  assert.equal(starts.length, 2, 'ended -> idle again after the second resume (idle -> ended -> idle)');
  const waiting = r.derived.filter((d) => d.to === 'waiting_for_you');
  assert.equal(waiting.length, 2, 'idle_prompt for prompt 1 and for prompt 2 both announced');
});

test('concurrent sessions in one repository are tracked independently; same tool_use_id string in two sessions is not a duplicate', () => {
  const r = run('concurrent-sessions');
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.sessions.get(S1).project.name, 'GitManager');
  assert.equal(r.sessions.get(S2).project.name, 'GitManager', 'subdirectory of the repo maps to the same project');
  assert.equal(stateOf(r, S1), 'report_ready'); assert.equal(stateOf(r, S2), 'report_ready');
  const reports = [...r.reports.values()];
  assert.equal(reports.length, 3);
  assert.deepEqual(reports.map((x) => x.session_id).sort(), [S1, S2, S3].sort());
  assert.equal(reports.find((x) => x.session_id === S2).declared_status, 'partial');
});

test('unknown project directory: tracked but explicitly unregistered, report not routable', () => {
  const r = run('concurrent-sessions');
  const s3 = r.sessions.get(S3);
  assert.equal(s3.project, null); assert.equal(s3.project_reason, 'unregistered_directory');
  const rep = [...r.reports.values()].find((x) => x.session_id === S3);
  assert.equal(rep.project_id, null);
  assert.ok(r.derived.filter((d) => d.session_id === S3).every((d) => d.registered === false));
});

test('late Stop for an older prompt: report captured, session state not regressed', () => {
  const r = run('late-stop');
  assert.equal(r.reports.size, 1);
  assert.equal([...r.reports.values()][0].late, true);
  assert.equal(stateOf(r, S1), 'working');
  assert.ok(kinds(r).includes('late_event'));
});

test('events without prompt_id still work', () => {
  const r = run('no-prompt-id');
  assert.equal(r.reports.size, 1);
  assert.equal([...r.reports.values()][0].declared_status, 'blocked');
  assert.equal(stateOf(r, S1), 'report_ready');
});

test('marker with background work still running is NOT report-ready; preserved as candidate', () => {
  const r = run('background-pending');
  assert.equal(r.reports.size, 0);
  assert.equal([...r.candidates.values()][0].reason, 'marker_present_but_background_work_pending');
  assert.equal(stateOf(r, S1), 'background_wait');
});

test('StopFailure is an error, not a finished response', () => {
  const r = run('stop-failure');
  assert.equal(stateOf(r, S1), 'error');
  assert.equal(r.reports.size, 0);
});

test('events missing session_id or event name are counted, never crash, never attributed', () => {
  const r = replay([{ seq: 1, kind: 'hook', transport: {}, payload: { hook_event_name: 'Stop' } },
    { seq: 2, kind: 'hook', transport: {}, payload: {} }, { seq: 3, kind: 'hook', transport: {}, payload: { session_id: 'x' } }], registry);
  assert.equal(r.unattributed, 3); assert.equal(r.sessions.size, 0);
});

test('unknown hook events are surfaced as unhandled, not silently dropped', () => {
  const r = replay([{ seq: 1, kind: 'hook', transport: {}, payload: { session_id: S1, cwd: '/w/GitManager', hook_event_name: 'SubagentStop' } }], registry);
  assert.deepEqual(kinds(r), ['unhandled_event']);
});

test('a second DIFFERENT report in the same prompt is a new report; the same report text twice is one', () => {
  const mk = (seq, msg, active) => ({ seq, kind: 'hook', transport: { transport_id: `t${seq}`, monotonic_ns: String(seq) },
    payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: 'p', hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: msg, background_tasks: [], session_crons: [] } });
  const m = (t) => `r\n<!-- mini-summa:report status=complete task="${t}" -->`;
  const r = replay([mk(1, m('A'), false), mk(2, m('B'), true), mk(3, m('B'), true)], registry);
  assert.equal(r.reports.size, 2);
});

test('replay is deterministic: same raw log, same derived ids', () => {
  const a = run('duplicate-delivery'); const b = run('duplicate-delivery');
  assert.deepEqual(a.derived.map((d) => d.derived_id), b.derived.map((d) => d.derived_id));
});

test('discovery: external sessions are found; sessionId may be absent; absence without SessionEnd is only "suspected"', () => {
  const r = run('discovery');
  const ls = labels(r);
  assert.ok(ls.some((l) => l.includes('Session 11111111 / Discovered (interactive, idle)')));
  assert.ok(ls.some((l) => /Discovered \(interactive, busy\)/.test(l)), 'session without sessionId is still listed');
  const weak = [...r.sessions.values()].find((s) => s.weak_identity);
  assert.ok(weak, 'weak identity (no sessionId) is flagged');
  assert.ok(ls.some((l) => l.includes('Session 22222222 / Needs permission (observed only)')));
  assert.ok(ls.some((l) => l.includes('Session 11111111 / Presence lost (suspected)')));
  assert.equal(stateOf(r, S1), 'presence_lost');
});

test('discovery: a --cwd filtered snapshot never causes "presence lost"', () => {
  const entries = loadFixture('discovery');
  entries[1].payload.scope = { cwd: '/w/Herc' };
  const r = replay(entries, registry);
  assert.ok(!labels(r).some((l) => l.includes('Presence lost')));
});

test('discovery vs hooks: once hooks are seen, a snapshot never rewrites hook-derived state except the inferred idle case', () => {
  const entries = [...loadFixture('happy-path').slice(0, 2)];
  entries.push({ seq: 3, kind: 'discovery', transport: {}, payload: { scope: { cwd: null }, sessions: [
    { kind: 'interactive', cwd: '/w/GitManager', startedAt: 1, pid: 1, status: 'busy', sessionId: S1 }] } });
  const r = replay(entries, registry);
  assert.equal(stateOf(r, S1), 'working', 'a snapshot must not rewrite hook-derived state');
});

test('regression (found in live data): a second prompt in the same session is not a "late" event', () => {
  const mk = (seq, ev, pid, extra = {}) => ({ seq, kind: 'hook', transport: { transport_id: `t${seq}`, monotonic_ns: String(seq * 10) },
    payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: pid, hook_event_name: ev, ...extra } });
  const r = replay([mk(1, 'UserPromptSubmit', 'p1'), mk(2, 'Stop', 'p1', { last_assistant_message: 'ok', background_tasks: [], session_crons: [] }),
    mk(3, 'UserPromptSubmit', 'p2'), mk(4, 'Stop', 'p2', { last_assistant_message: 'ok2', background_tasks: [], session_crons: [] })], registry);
  assert.ok(!kinds(r).includes('late_event'));
  assert.deepEqual(labels(r), ['GitManager / Session 11111111 / Working', 'GitManager / Session 11111111 / Turn ended',
    'GitManager / Session 11111111 / Working', 'GitManager / Session 11111111 / Turn ended']);
});

test('regression (found in live data): a session that ends mid-turn with no Stop is flagged abnormal, not shown as a clean end', () => {
  const mk = (seq, ev, extra = {}) => ({ seq, kind: 'hook', transport: { transport_id: `t${seq}`, monotonic_ns: String(seq * 10) },
    payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: 'p1', hook_event_name: ev, ...extra } });
  const r = replay([mk(1, 'UserPromptSubmit'), mk(2, 'SessionEnd', { reason: 'other' })], registry);
  const end = r.derived.find((d) => d.to === 'ended');
  assert.match(end.label, /ended while working, no Stop seen/);
  assert.equal(end.abnormal, true); assert.equal(end.notify, true);
  assert.equal(r.reports.size, 0);
});

test('discovery: a listed session whose pid is dead on this host is an OBSERVED process exit; unknown liveness claims nothing', () => {
  const live = { kind: 'interactive', cwd: '/w/GitManager', startedAt: 1, pid: 10, status: 'idle', sessionId: S1 };
  const snap = (seq, o) => ({ seq, kind: 'discovery', transport: {}, payload: { scope: { cwd: null }, sessions: [o] } });
  const r = replay([snap(1, live), snap(2, { ...live, pid_alive: false })], registry);
  assert.ok(labels(r).some((l) => l.includes('Process exited (observed, pid 10)')));
  assert.ok(!labels(r).some((l) => l.includes('Presence lost')), 'observed exit is a stronger claim than suspected loss');
  assert.equal(r.sessions.get(S1).gen.phase, 'ended_observed');
  const r2 = replay([snap(1, live), snap(2, { ...live, pid_alive: null })], registry);
  assert.ok(!labels(r2).some((l) => /Presence lost|Process exited/.test(l)), 'unknown liveness must not claim loss');
});

test('found live: a hook file that predates the "gone" snapshot but is ingested after it does not resurrect the session', () => {
  const live = { kind: 'interactive', cwd: '/w/GitManager', startedAt: 1, pid: 10, status: 'idle', sessionId: S1 };
  const snap = (seq, ms, sessions) => ({ seq, kind: 'discovery', transport: { wall_ms: ms }, payload: { scope: { cwd: null }, sessions } });
  const hook = (seq, ms, ev, extra = {}) => ({ seq, kind: 'hook', transport: { transport_id: `h${seq}`, wall_ms: ms },
    payload: { session_id: S1, cwd: '/w/GitManager', hook_event_name: ev, ...extra } });
  const late = replay([snap(1, 100, [live]), snap(2, 200, []), hook(3, 50, 'SessionStart', { source: 'startup' })], registry);
  assert.equal(stateOf(late, S1), 'presence_lost');
  const resumed = replay([snap(1, 100, [live]), snap(2, 200, []), hook(3, 300, 'SessionStart', { source: 'resume' })], registry);
  assert.equal(stateOf(resumed, S1), 'idle', 'a hook AFTER the loss observation is a genuine resume');
});

test('found live: user interrupt fires no Stop; an idle observation corrects stale hook state, labelled as inferred', () => {
  const hook = (seq, ev, extra = {}) => ({ seq, kind: 'hook', transport: { transport_id: `h${seq}`, wall_ms: seq * 10 },
    payload: { session_id: S1, cwd: '/w/GitManager', prompt_id: 'p1', hook_event_name: ev, ...extra } });
  const snap = (seq, status) => ({ seq, kind: 'discovery', transport: { wall_ms: seq * 10 }, payload: { scope: { cwd: null },
    sessions: [{ kind: 'interactive', cwd: '/w/GitManager', startedAt: 1, pid: 10, pid_alive: true, status, sessionId: S1 }] } });
  const r = replay([hook(1, 'UserPromptSubmit'), hook(2, 'PermissionRequest', { tool_name: 'Bash' }), snap(3, 'waiting'), snap(4, 'idle')], registry);
  assert.equal(stateOf(r, S1), 'idle');
  assert.ok(labels(r).some((l) => l.includes('Idle, no Stop seen (observed; likely interrupted)')));
  assert.ok(!labels(r).some((l) => /Report ready/.test(l)), 'never invents a report');
  // a Stop that was merely delayed still lands afterwards and is kept
  const r2 = replay([hook(1, 'UserPromptSubmit'), snap(2, 'idle'), hook(3, 'Stop', { last_assistant_message: 'done\n<!-- mini-summa:report status=complete task="T" -->', background_tasks: [], session_crons: [] })], registry);
  assert.equal(r2.reports.size, 1); assert.equal(stateOf(r2, S1), 'report_ready');
});
