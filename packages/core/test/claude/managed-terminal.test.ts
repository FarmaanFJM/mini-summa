import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalSink } from '../../src/contracts.ts';
import { directive, isWrappedWhenPasted, readLiveFiles, readReceived, readTerminalSize, unwrapPastedContent } from '../../src/testing/fake-claude/index.ts';
import { RecordingSink, createHarness, eventsOf, startWithSink, stripAnsi, waitFor, waitForText } from './managed-harness.ts';
import type { Harness } from './managed-harness.ts';

let h: Harness;
afterEach(async () => { await h?.cleanup(); });

const attachOrThrow = (manager: ReturnType<Harness['makeManager']>, key: Parameters<ReturnType<Harness['makeManager']>['attach']>[0], size: { cols: number; rows: number }, sink: TerminalSink) => {
  const a = manager.attach(key, size, sink);
  if ('error' in a) throw new Error(a.error);
  return a;
};
const ready = async (manager: ReturnType<Harness['makeManager']>, h0: Harness, over = {}) => {
  const s = await startWithSink(manager, h0, over);
  await waitForText(s.sink, '? for shortcuts');
  await waitFor(() => eventsOf(h0.spool(), s.record.sessionId).includes('SessionStart'), 'SessionStart');
  return s;
};

describe('attach: replay, live data and sequence numbers', () => {
  it('replays the scrollback, then streams live chunks with seq continuing exactly where the replay stopped; two sinks see the same stream', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const record = await manager.start(h.startInput());
    const a = new RecordingSink();
    const attA = attachOrThrow(manager, record.key, { cols: 100, rows: 30 }, a);
    await waitForText(a, '? for shortcuts');

    // a second window opens later: its replay is everything sink A has seen, and its seq is A's newest seq
    const seenByA = attA.replay + a.text;
    const lastSeqOfA = a.chunks.at(-1)!.seq;
    const b = new RecordingSink();
    const attB = attachOrThrow(manager, record.key, { cols: 100, rows: 30 }, b);
    expect(attB.replay).toBe(seenByA);
    expect(attB.seq).toBe(lastSeqOfA);
    expect(attB.replay).toContain('Welcome to Claude Code');

    // new output reaches both, as the same numbered chunks
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    expect(await manager.typeText(record.key, `echo this ${directive.say('visible in both windows')}`, { submit: true })).toBe(true);
    await waitForText(a, '● visible in both windows');
    await waitForText(b, '● visible in both windows');
    expect(b.chunks.length).toBeGreaterThan(0);
    expect(b.chunks[0].seq).toBe(attB.seq + 1);
    for (let i = 1; i < b.chunks.length; i++) expect(b.chunks[i].seq).toBe(b.chunks[i - 1].seq + 1);
    const aTail = a.chunks.filter((c) => c.seq > attB.seq);
    expect(aTail).toEqual(b.chunks);

    // detaching one window leaves the other attached
    attA.detach();
    attA.detach(); // idempotent
    const aCount = a.chunks.length;
    expect(await manager.typeText(record.key, `again ${directive.say('only for the second window')}`, { submit: true })).toBe(true);
    await waitForText(b, '● only for the second window');
    expect(a.chunks.length).toBe(aCount);
  });

  it('every window can be told the size the terminal really has', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const record = await manager.start(h.startInput({ cols: 100, rows: 30 }));
    const a = attachOrThrow(manager, record.key, { cols: 100, rows: 30 }, new RecordingSink());
    expect(a).toMatchObject({ cols: 100, rows: 30 });
    const b = attachOrThrow(manager, record.key, { cols: 140, rows: 50 }, new RecordingSink());
    expect(b).toMatchObject({ cols: 140, rows: 50 });
  });

  it('attach to a session that has exited replays what it printed and reports the exit right after', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, sink } = await ready(manager, h);
    expect(manager.write(key, '/exit\r')).toBe(true);
    await waitFor(() => manager.get(key)!.status === 'exited', 'exit');
    const late = new RecordingSink();
    const attached = attachOrThrow(manager, key, { cols: 100, rows: 30 }, late);
    expect(attached.replay).toContain('Welcome to Claude Code');
    expect(attached.replay).toContain('Goodbye!');
    expect(attached.replay).toBe(sink.text);
    expect(late.exits).toHaveLength(0); // delivered after attach() returned, so the caller can send the replay first
    await Promise.resolve();
    expect(late.exits).toHaveLength(1);
    expect(late.exits[0]).toMatchObject({ code: 0, signal: null, reason: 'exited' });
    expect(typeof late.exits[0].at).toBe('string');
  });

  it('a sink that throws is dropped; the others keep receiving', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const record = await manager.start(h.startInput());
    const bad: TerminalSink = { data() { throw new Error('window closed'); }, exit() { throw new Error('window closed'); } };
    const good = new RecordingSink();
    attachOrThrow(manager, record.key, { cols: 100, rows: 30 }, bad);
    attachOrThrow(manager, record.key, { cols: 100, rows: 30 }, good);
    await waitForText(good, '? for shortcuts');
    expect(manager.get(record.key)!.status).toBe('running');
  });

  it('keeps only a bounded scrollback (whole chunks from the front) but numbers on', async () => {
    h = createHarness();
    const manager = h.makeManager({ overrides: { scrollbackChars: 4000 } });
    const { key, sink } = await ready(manager, h);
    const before = sink.chunks.at(-1)!.seq;
    expect(await manager.typeText(key, `${directive.tool('bash', 'seq 1 4000')} ${directive.say('end of the long output')}`, { submit: true })).toBe(true);
    await waitFor(() => eventsOf(h.spool()).includes('Stop'), 'Stop', 20_000);
    await waitForText(sink, '● end of the long output', 20_000); // the reply, not the echo of what was typed
    const late = new RecordingSink();
    const attached = attachOrThrow(manager, key, { cols: 100, rows: 30 }, late);
    expect(attached.replay.length).toBeLessThan(4000 + 4096); // the bound plus at most the one chunk that crossed it
    expect(stripAnsi(attached.replay)).toContain('● end of the long output');
    expect(stripAnsi(attached.replay)).not.toContain('Welcome to Claude Code');
    expect(attached.seq).toBeGreaterThan(before);
  });
});

describe('resize', () => {
  it('reaches the PTY (the process sees the new size) and is recorded', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record } = await ready(manager, h);
    await waitFor(() => readTerminalSize(h.stateDir, record.sessionId), 'initial size');
    expect(readTerminalSize(h.stateDir, record.sessionId)).toEqual({ cols: 100, rows: 30 });
    manager.resize(key, 132, 41);
    await waitFor(() => readTerminalSize(h.stateDir, record.sessionId)?.cols === 132, 'the resized terminal');
    expect(readTerminalSize(h.stateDir, record.sessionId)).toEqual({ cols: 132, rows: 41 });
    expect(manager.get(key)).toMatchObject({ cols: 132, rows: 41 });
    expect(h.db.get('SELECT cols, rows FROM managed_sessions')).toEqual({ cols: 132, rows: 41 });
  });

  it('attach() with another size resizes the PTY to it; a bad size is ignored', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record } = await ready(manager, h);
    attachOrThrow(manager, key, { cols: 90, rows: 24 }, new RecordingSink());
    await waitFor(() => readTerminalSize(h.stateDir, record.sessionId)?.cols === 90, 'attach resize');
    manager.resize(key, Number.NaN, -5);
    manager.resize(key, 90, 24);
    expect(manager.get(key)).toMatchObject({ cols: 90, rows: 24 });
  });
});

describe('typeText: what Claude receives is exactly what was meant', () => {
  const cases: [string, string][] = [
    ['a single line', 'fix the login redirect on /auth/callback'],
    ['a single line with quotes, backticks, dollars and a backslash', 'run `echo "$HOME"` and then C:\\temp\\x'],
    ['unicode', 'grüße 日本語 🚀 — déjà vu'],
    ['several lines', 'Please do three things:\n1. read the code\n2. fix the bug\n3. run the tests'],
    ['lines with blank lines and trailing spaces', 'first  \n\nthird line\n\n\nlast'],
    ['lines with indentation and a tab', 'def f():\n\treturn 1\n    # four spaces\n'],
    ['a trailing newline', 'ends with a newline\n'],
    ['a long multi-line message', Array.from({ length: 60 }, (_, i) => `line ${i + 1}: ${'word '.repeat(12)}`).join('\n')],
  ];

  it.each(cases)('%s arrives as ONE prompt, unchanged', async (_name, text) => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record } = await ready(manager, h);
    expect(await manager.typeText(key, text, { submit: true })).toBe(true);
    await waitFor(() => eventsOf(h.spool(), record.sessionId).includes('Stop'), 'Stop');
    const received = readReceived(h.stateDir, record.sessionId);
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe(text);
    // like the real CLI, the fake reports a long paste wrapped in <pasted_content> tags; unwrapped it is the typed text
    const prompt = String(h.spool().find((r) => r.event === 'UserPromptSubmit')!.payload.prompt);
    expect(unwrapPastedContent(prompt)).toBe(text);
    expect(prompt === text).toBe(!isWrappedWhenPasted(text));
    expect(h.spool().filter((r) => r.event === 'UserPromptSubmit')).toHaveLength(1);
  });

  it('reports a long paste the way the real CLI does: wrapped from 3 line breaks on, verbatim below (observed on 2.1.314)', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await ready(manager, h);
    const four = 'Task for this session:\n1. Create a file.\n2. Its content is hi.\nThen finish.';
    expect(await manager.typeText(key, four, { submit: true })).toBe(true);
    await waitFor(() => eventsOf(h.spool(), record.sessionId).includes('Stop'), 'Stop');
    expect(sink.plain).toContain('[Pasted text #1 +3 lines]');
    const wrapped = String(h.spool().find((r) => r.event === 'UserPromptSubmit')!.payload.prompt);
    expect(wrapped).toBe(`\n\n<pasted_content id="4098">\n${four}\n</pasted_content id="4098">\n`);
    expect(readReceived(h.stateDir, record.sessionId)[0].text).toBe(four);

    const two = 'Implement this small change:\nAppend a line.';
    expect(await manager.typeText(key, two, { submit: true })).toBe(true);
    await waitFor(() => h.spool().filter((r) => r.event === 'Stop').length === 2, 'second Stop');
    const verbatim = h.spool().filter((r) => r.event === 'UserPromptSubmit')[1].payload.prompt;
    expect(verbatim).toBe(two);
  });

  it('typed text before a pasted block keeps its place, and Backspace removes a collapsed paste as one piece', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await ready(manager, h);
    const block = 'a\nb\nc\nd';
    expect(await manager.typeText(key, 'oops', { submit: false })).toBe(true);
    manager.write(key, '\x1b[200~' + block + '\x1b[201~');
    await waitForText(sink, '[Pasted text #1 +3 lines]');
    manager.write(key, '\x7f');                                  // removes the whole placeholder
    manager.write(key, '\x7f\x7f');                              // then two letters
    manager.write(key, '!\r');
    await waitFor(() => readReceived(h.stateDir, record.sessionId).length === 1, 'the prompt');
    expect(readReceived(h.stateDir, record.sessionId)[0].text).toBe('oo!');
  });

  it('without submit the text waits in the input box until the user presses Enter', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await ready(manager, h);
    expect(await manager.typeText(key, 'draft line one\ndraft line two', { submit: false })).toBe(true);
    await waitForText(sink, 'draft line two');
    await new Promise((r) => setTimeout(r, 400));
    expect(readReceived(h.stateDir, record.sessionId)).toEqual([]);
    expect(eventsOf(h.spool())).not.toContain('UserPromptSubmit');
    expect(manager.write(key, '\r')).toBe(true); // the user's own Enter
    await waitFor(() => readReceived(h.stateDir, record.sessionId).length === 1, 'the prompt');
    expect(readReceived(h.stateDir, record.sessionId)[0].text).toBe('draft line one\ndraft line two');
  });

  it('control characters in the text cannot turn into key presses (no early end of the paste, no extra prompt)', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record } = await ready(manager, h);
    expect(await manager.typeText(key, 'harmless\x1b[201~\x03\x03/exit\r', { submit: false })).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(manager.get(key)!.status).toBe('running'); // the Ctrl-C and /exit did not act
    expect(readReceived(h.stateDir, record.sessionId)).toEqual([]);
    manager.write(key, '\r');
    await waitFor(() => readReceived(h.stateDir, record.sessionId).length === 1, 'the prompt');
    expect(readReceived(h.stateDir, record.sessionId)[0].text).toBe('harmless[201~/exit\n');
  });

  it('two calls at once never interleave their bytes', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record } = await ready(manager, h);
    const first = 'FIRST line one\nFIRST line two';
    const second = 'SECOND line one\nSECOND line two';
    const results = await Promise.all([
      manager.typeText(key, first, { submit: true }),
      manager.typeText(key, second, { submit: true }),
      manager.sendKeys(key, 'reject'), // would be an interrupt if it ever fell between the two
    ]);
    expect(results).toEqual([true, true, true]);
    await waitFor(() => readReceived(h.stateDir, record.sessionId).length === 2, 'both prompts');
    expect(readReceived(h.stateDir, record.sessionId).map((r) => r.text)).toEqual([first, second]);
  });

  it('refuses (false) when the PTY is not running', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, sink } = await ready(manager, h);
    manager.write(key, '/exit\r');
    await waitFor(() => manager.get(key)!.status === 'exited', 'exit');
    expect(await manager.typeText(key, 'hello', { submit: true })).toBe(false);
    expect(await manager.sendKeys(key, 'approve')).toBe(false);
    expect(manager.write(key, 'x')).toBe(false);
    expect(await manager.typeText('posix|11111111-1111-4111-8111-111111111111', 'x', { submit: false })).toBe(false);
    expect(sink.plain).not.toContain('hello');
  });

  it('write() sends raw keystrokes as the user types them at the desktop terminal', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record } = await ready(manager, h);
    for (const ch of 'typed by hand') manager.write(key, ch);
    manager.write(key, '\x7f\x7f\x7f\x7f');         // Backspace edits
    manager.write(key, 'land');
    manager.write(key, '\r');
    await waitFor(() => readReceived(h.stateDir, record.sessionId).length === 1, 'the prompt');
    expect(readReceived(h.stateDir, record.sessionId)[0].text).toBe('typed by hand'.slice(0, -4) + 'land');
  });
});

describe('sendKeys: answering the permission dialog', () => {
  it('approve (Enter) lets the tool run: PostToolUse, then the turn finishes', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await ready(manager, h);
    const file = path.join(h.cwd, 'approved.txt');
    expect(await manager.typeText(key, directive.permission('bash', 'touch approved.txt'), { submit: true })).toBe(true);
    await waitFor(() => eventsOf(h.spool(), record.sessionId).includes('PermissionRequest'), 'PermissionRequest');
    await waitForText(sink, 'Do you want to proceed?');
    expect(readLiveFiles(h.stateDir)[0]).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt' });
    expect(fs.existsSync(file)).toBe(false); // nothing ran while the dialog was open
    expect(await manager.sendKeys(key, 'approve')).toBe(true);
    await waitFor(() => eventsOf(h.spool(), record.sessionId).includes('Stop'), 'Stop');
    expect(fs.existsSync(file)).toBe(true);
    const events = eventsOf(h.spool(), record.sessionId);
    expect(events.indexOf('PermissionRequest')).toBeLessThan(events.indexOf('PostToolUse'));
    expect(events).toEqual(expect.arrayContaining(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']));
    await waitFor(() => readLiveFiles(h.stateDir)[0]?.status === 'idle', 'idle again');
  });

  it('reject (Escape) cancels: the tool does not run, there is no PostToolUse and no Stop', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await ready(manager, h);
    const file = path.join(h.cwd, 'rejected.txt');
    expect(await manager.typeText(key, directive.permission('bash', 'touch rejected.txt'), { submit: true })).toBe(true);
    await waitFor(() => eventsOf(h.spool(), record.sessionId).includes('PermissionRequest'), 'PermissionRequest');
    expect(await manager.sendKeys(key, 'reject')).toBe(true);
    await waitForText(sink, 'Interrupted');
    await waitFor(() => readLiveFiles(h.stateDir)[0]?.status === 'idle', 'idle again');
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(file)).toBe(false);
    const events = eventsOf(h.spool(), record.sessionId);
    expect(events).not.toContain('PostToolUse');
    expect(events).not.toContain('Stop');
    // the session is still usable afterwards
    expect(await manager.typeText(key, directive.say('still here'), { submit: true })).toBe(true);
    await waitForText(sink, '● still here');
  });

  it('a permission answer that arrives before the dialog is up is not lost (the dialog takes keys at once)', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, record, sink } = await ready(manager, h);
    const file = path.join(h.cwd, 'fast.txt');
    expect(await manager.typeText(key, directive.permission('bash', 'touch fast.txt'), { submit: true })).toBe(true);
    await waitForText(sink, 'Do you want to proceed?');
    expect(await manager.sendKeys(key, 'approve')).toBe(true); // immediately, possibly before the PermissionRequest hook finished
    await waitFor(() => eventsOf(h.spool(), record.sessionId).includes('Stop'), 'Stop');
    const events = eventsOf(h.spool(), record.sessionId);
    expect(events.indexOf('PermissionRequest')).toBeLessThan(events.indexOf('PostToolUse'));
    expect(fs.existsSync(file)).toBe(true);
  });
});
