#!/usr/bin/env node
// Generates SYNTHETIC fixtures (documented hook fields only). Not captured from Claude.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
fs.mkdirSync(out, { recursive: true });

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const GIT = '/w/GitManager';
const REPORT = (status, task) => `Implemented the storage layer.\n\n## Implementation Report\n- Added store.ts\n- Ran 42 tests: 41 passed, 1 failed (flaky clock test)\n- Risk: migration untested on Windows\n\n<!-- mini-summa:report status=${status} task="${task}" -->\n`;

const base = (sid, cwd, prompt) => (ev, extra = {}) => ({
  payload: { session_id: sid, transcript_path: `/home/u/.claude/projects/x/${sid}.jsonl`, cwd,
    permission_mode: 'default', hook_event_name: ev, ...(prompt ? { prompt_id: prompt } : {}), ...extra },
});
const write = (name, description, events) =>
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ synthetic: true, description, events }, null, 2));

{ // 1 happy path
  const e = base(S1, GIT, 'pp-0001');
  write('happy-path', 'One task: three tool calls (two identical Bash inputs, distinct tool_use_ids), one permission prompt, final report.', [
    base(S1, GIT)('SessionStart', { source: 'startup', model: 'claude-x' }),
    e('UserPromptSubmit', { prompt: 'Implement the storage system' }),
    e('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' }),
    e('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' }, tool_use_id: 'toolu_1' }),
    e('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_2' }),
    e('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
    e('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' }, tool_use_id: 'toolu_2' }),
    e('Stop', { stop_hook_active: false, last_assistant_message: REPORT('complete', 'Storage System'), background_tasks: [], session_crons: [] }),
    base(S1, GIT)('SessionEnd', { reason: 'prompt_input_exit' }),
  ]);
}
{ // 2 no marker
  const e = base(S1, GIT, 'pp-0001');
  write('no-marker', 'Stop with a progress update and no marker, then idle_prompt.', [
    e('UserPromptSubmit', { prompt: 'Start the refactor' }),
    e('Stop', { stop_hook_active: false, last_assistant_message: 'I have read the code. Shall I proceed with option A or B?', background_tasks: [], session_crons: [] }),
    e('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }),
  ]);
}
{ // 3 duplicates: the capture hook is registered twice (handlers h1 and h2); Stop is also re-delivered by h1
  const happy = JSON.parse(fs.readFileSync(path.join(out, 'happy-path.json'), 'utf8')).events;
  const events = [];
  for (const ev of happy) { events.push({ ...ev, handler: 'h1' }, { ...structuredClone(ev), handler: 'h2' }); }
  const stop = happy.find((x) => x.payload.hook_event_name === 'Stop');
  events.splice(events.findIndex((x) => x.payload.hook_event_name === 'Stop' && x.handler === 'h2') + 1, 0, { ...structuredClone(stop), handler: 'h1' });
  write('duplicate-delivery', 'happy-path registered twice (h1, h2) so every event arrives twice, plus one extra Stop from h1 (a same-handler repeat is indistinguishable from a second real event).', events);
}
{ // 4 identical but legitimate
  const a = base(S1, GIT);
  const p2 = base(S1, GIT, 'pp-0002');
  write('identical-legitimate', 'Resume, end, resume with identical payloads; idle_prompt repeated across different prompts.', [
    a('SessionStart', { source: 'resume' }),
    a('SessionEnd', { reason: 'other' }),
    a('SessionStart', { source: 'resume' }),
    base(S1, GIT, 'pp-0001')('UserPromptSubmit', { prompt: 'one' }),
    base(S1, GIT, 'pp-0001')('Stop', { last_assistant_message: 'question?', background_tasks: [], session_crons: [] }),
    base(S1, GIT, 'pp-0001')('Notification', { notification_type: 'idle_prompt', message: 'waiting' }),
    p2('UserPromptSubmit', { prompt: 'two' }),
    p2('Stop', { last_assistant_message: 'question?', background_tasks: [], session_crons: [] }),
    p2('Notification', { notification_type: 'idle_prompt', message: 'waiting' }),
  ]);
}
{ // 5 concurrent sessions
  const a = base(S1, GIT, 'pa-1'); const b = base(S2, '/w/GitManager/packages/core', 'pb-1'); const c = base(S3, '/w/Elsewhere', 'pc-1');
  write('concurrent-sessions', 'Two sessions in one repository (one in a subdirectory), plus one in an unregistered directory, interleaved; S1 and S2 finish together.', [
    a('UserPromptSubmit', { prompt: 'x' }), b('UserPromptSubmit', { prompt: 'x' }), c('UserPromptSubmit', { prompt: 'x' }),
    a('PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_a1' }),
    b('PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_a1' }), // same id string, different session
    b('Stop', { last_assistant_message: REPORT('partial', 'Core refactor'), background_tasks: [], session_crons: [] }),
    a('Stop', { last_assistant_message: REPORT('complete', 'Storage System'), background_tasks: [], session_crons: [] }),
    c('Stop', { last_assistant_message: REPORT('complete', 'Mystery'), background_tasks: [], session_crons: [] }),
  ]);
}
{ // 6 late stop
  write('late-stop', 'Stop for prompt 1 arrives after prompt 2 started. Report must be captured; state must stay Working.', [
    base(S1, GIT, 'pp-0001')('UserPromptSubmit', { prompt: 'one' }),
    base(S1, GIT, 'pp-0002')('UserPromptSubmit', { prompt: 'two' }),
    base(S1, GIT, 'pp-0001')('Stop', { last_assistant_message: REPORT('complete', 'Task one'), background_tasks: [], session_crons: [] }),
  ]);
}
{ // 7 no prompt id
  const a = base(S1, GIT);
  write('no-prompt-id', 'Events without prompt_id (e.g. before first user input).', [
    a('SessionStart', { source: 'startup' }),
    a('Notification', { notification_type: 'permission_prompt', message: 'needs permission' }),
    a('Stop', { last_assistant_message: REPORT('blocked', 'No prompt id task'), background_tasks: [], session_crons: [] }),
  ]);
}
{ // 8 background pending
  const e = base(S1, GIT, 'pp-0001');
  write('background-pending', 'Marker present but a background task is still running: not a finished task.', [
    e('UserPromptSubmit', { prompt: 'x' }),
    e('Stop', { last_assistant_message: REPORT('complete', 'Premature'), background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'tests' }], session_crons: [] }),
  ]);
}
{ // 9 stopfailure
  const e = base(S1, GIT, 'pp-0001');
  write('stop-failure', 'API error ends the turn.', [
    e('UserPromptSubmit', { prompt: 'x' }),
    e('StopFailure', { error: 'rate_limit', error_details: '429', last_assistant_message: 'API Error: Rate limit reached' }),
  ]);
}
{ // 10 discovery
  const full = (sessions) => ({ kind: 'discovery', payload: { scope: { cwd: null }, sessions } });
  const x = { kind: 'interactive', cwd: GIT, startedAt: 1700000000000, pid: 4242, status: 'idle', sessionId: S1 };
  const y = { kind: 'interactive', cwd: '/w/Herc', startedAt: 1700000005000, pid: 4343, status: 'busy' }; // no sessionId yet
  const z = { kind: 'background', id: '7c5dcf5d', state: 'blocked', cwd: GIT, startedAt: 1700000009000, pid: 4444, status: 'waiting', waitingFor: 'permission prompt', sessionId: S2 };
  write('discovery', 'Snapshots: external interactive session, one without sessionId, a blocked background session; then X disappears with no SessionEnd.', [
    full([x, y, z]), full([y, z]),
  ]);
}
console.log('fixtures written to', out);
