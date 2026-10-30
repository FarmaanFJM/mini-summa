import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, REPORT_INSTRUCTION, parseMarker } from '@minisumma/claude-integration';
import { directive, readContext, readHookRuns, readReceived } from '../../src/testing/fake-claude/index.ts';
import { createHarness, eventsOf, startWithSink, waitFor, waitForText } from './managed-harness.ts';
import type { Harness } from './managed-harness.ts';

let h: Harness;
afterEach(async () => { await h?.cleanup(); });

const EXAMPLES = fileURLToPath(new URL('../../../claude-integration/examples/captured-hooks/', import.meta.url));
const realKeys = (event: string): string[] => Object.keys((JSON.parse(fs.readFileSync(`${EXAMPLES}${event}.json`, 'utf8')) as { payload: object }).payload).sort();

describe('hooks reach the spool through the managed settings file (real capture script, fake CLI)', () => {
  it('SessionStart is captured by the managed handler with the session identity, and the report protocol is injected', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { record, sink } = await startWithSink(manager, h, { name: 'hooks' });
    await waitForText(sink, '? for shortcuts');
    const start = await waitFor(() => h.spool().find((r) => r.event === 'SessionStart'), 'SessionStart in the spool');
    expect(start.payload).toMatchObject({ session_id: record.sessionId, cwd: h.cwd, source: 'startup', session_title: 'hooks', hook_event_name: 'SessionStart' });
    expect(start.transport).toMatchObject({ hook_arg: 'SessionStart', handler_id: 'ms-managed', env_id: 'posix', parse_error: null });
    // the context file is how the fake proves what the hook's stdout (additionalContext) contained
    expect(readContext(h.stateDir, record.sessionId)).toBe(REPORT_INSTRUCTION);
    expect(readContext(h.stateDir, record.sessionId)).toContain('## Implementation Report');
  });

  it('a folder that is not in the project registry gets no protocol context (the hook stays silent)', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { record, sink } = await startWithSink(manager, h, { cwd: h.otherCwd });
    await waitForText(sink, '? for shortcuts');
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    expect(readContext(h.stateDir, record.sessionId)).toBeNull();
  });

  it('a report: the Stop payload ends with the marker line, and the verified parser accepts it', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await startWithSink(manager, h);
    await waitForText(sink, '? for shortcuts');
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    const prompt = `Fix the login redirect\nand run the tests ${directive.report({ status: 'partial', task: 'Fix login' })}`;
    expect(await manager.typeText(key, prompt, { submit: true })).toBe(true);
    const stop = await waitFor(() => h.spool().find((r) => r.event === 'Stop'), 'Stop in the spool');
    const message = String(stop.payload.last_assistant_message);
    expect(message).toContain('## Implementation Report');
    expect(message.trimEnd().split('\n').at(-1)).toBe('<!-- mini-summa:report status=partial task="Fix login" -->');
    expect(parseMarker(message)).toMatchObject({ valid: true, status: 'partial', task: 'Fix login', has_heading: true });
    expect(stop.payload.stop_hook_active).toBe(false);
    // the prompt in the hook is the prompt that was typed, and one prompt id ties the turn together
    const submit = h.spool().find((r) => r.event === 'UserPromptSubmit')!;
    expect(submit.payload.prompt).toBe(prompt);
    expect(readReceived(h.stateDir, record.sessionId)[0].text).toBe(prompt);
    expect(submit.payload.prompt_id).toBeTruthy();
    expect(stop.payload.prompt_id).toBe(submit.payload.prompt_id);
  });

  it('a reply without a directive is a plain Stop with no marker', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, sink } = await startWithSink(manager, h);
    await waitForText(sink, '? for shortcuts');
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    expect(await manager.typeText(key, 'just a question', { submit: true })).toBe(true);
    const stop = await waitFor(() => h.spool().find((r) => r.event === 'Stop'), 'Stop');
    expect(String(stop.payload.last_assistant_message)).toContain('Echo: just a question');
    expect(parseMarker(String(stop.payload.last_assistant_message))).toMatchObject({ valid: false, reason: 'no_marker' });
  });

  it('one session produces all nine events, each with the field set of the real captured payload', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await startWithSink(manager, h, { name: 'nine events' });
    await waitForText(sink, '? for shortcuts');
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    const sessionEvents = () => eventsOf(h.spool(), record.sessionId);

    // prompt 1: a tool, a permission dialog (approved), a question (answered), a report
    const first = [
      directive.tool('bash', 'echo hi'),
      directive.permission('bash', 'echo approved'),
      directive.input('Which file?'),
      directive.report({ status: 'complete', task: 'Nine events' }),
    ].join(' ');
    expect(await manager.typeText(key, first, { submit: true })).toBe(true);
    await waitFor(() => h.spool().some((r) => r.event === 'Notification' && r.payload.notification_type === 'permission_prompt'), 'the permission_prompt Notification', 10_000);
    expect(await manager.sendKeys(key, 'approve')).toBe(true);
    await waitFor(() => h.spool().some((r) => r.event === 'Notification' && r.payload.notification_type === 'elicitation_dialog'), 'the elicitation Notification');
    expect(await manager.typeText(key, 'readme.md', { submit: true })).toBe(true);
    await waitFor(() => sessionEvents().includes('Stop'), 'Stop');

    // prompt 2: the turn fails
    expect(await manager.typeText(key, directive.error('rate_limit'), { submit: true })).toBe(true);
    await waitFor(() => sessionEvents().includes('StopFailure'), 'StopFailure');

    await manager.stop(key, {});
    expect(sessionEvents()).toContain('SessionEnd');

    const spool = h.spool().filter((r) => r.payload.session_id === record.sessionId);
    expect(new Set(spool.map((r) => r.event))).toEqual(new Set(EVENTS));
    expect(EVENTS).toHaveLength(9);

    // order of the first turn: submit, tool pair, tool + permission + result, question, then the report
    const names = sessionEvents();
    expect(names.slice(0, 7)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PermissionRequest', 'Notification']);
    expect(names.indexOf('PermissionRequest')).toBeLessThan(names.lastIndexOf('PostToolUse'));
    expect(names.at(-1)).toBe('SessionEnd');

    // every hook ran through the settings file and every transport carries the managed handler id
    for (const r of spool) expect(r.transport).toMatchObject({ handler_id: 'ms-managed', env_id: 'posix', parse_error: null });
    const runs = readHookRuns(h.stateDir, record.sessionId);
    expect(runs).toHaveLength(spool.length);
    expect(runs.every((run) => run.code === 0 && !run.timedOut)).toBe(true);

    // payloads have the same fields as the real captured ones
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']) {
      const sample = spool.find((r) => r.event === event)!;
      expect(Object.keys(sample.payload).sort(), event).toEqual(realKeys(event));
    }
    const failure = spool.find((r) => r.event === 'StopFailure')!;
    expect(failure.payload).toMatchObject({ error: 'rate_limit', error_details: '500', hook_event_name: 'StopFailure' });
    expect(String(failure.payload.last_assistant_message)).toContain('rate_limit');
    expect(spool.find((r) => r.event === 'SessionEnd')!.payload.reason).toBe('prompt_input_exit');
  });
});
