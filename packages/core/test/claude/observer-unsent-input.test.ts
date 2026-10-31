// Unsent input (SEC-03). Text a person typed at the desktop terminal but did not submit sits on Claude's input line. Anything
// sent from elsewhere (the phone) would be appended to it and submitted as ONE prompt. So: the manager tracks what the desktop
// typed (a heuristic, documented in inputTracking.ts), and typeInto / targetCheck refuse while a line may be pending.
import { afterEach, describe, expect, it } from 'vitest';
import { parseSessionKey } from '@minisumma/shared';
import { createEventBus } from '../../src/bus.ts';
import { systemClock } from '../../src/contracts.ts';
import type { ManagedManager } from '../../src/contracts.ts';
import { emptyInputLine, scanDesktopInput } from '../../src/claude/inputTracking.ts';
import type { InputLine } from '../../src/claude/inputTracking.ts';
import type { ManagedManagerExtras } from '../../src/claude/managed.ts';
import { createRawStore } from '../../src/claude/rawStore.ts';
import { createSessionsService } from '../../src/claude/sessions.ts';
import { createFakeProjects, createFakeSettings } from './helpers/observer-fakes.ts';
import { keyOf, makeHarness } from './helpers/observer-harness.ts';
import type { Harness as ObserverHarness } from './helpers/observer-harness.ts';
import { S1, hookEntry, hookPayload, isoAt, waitFor } from './helpers/observer-hook.ts';
import { FakeSpawner, createHarness } from './managed-harness.ts';
import type { Harness as ManagedHarness } from './managed-harness.ts';

const UNSENT = 'Someone typed in that terminal and has not pressed Enter yet. Finish or clear that line first.';
const STARTING = 'Claude has not finished starting. If it is asking whether you trust this folder, answer in the terminal.';
const ACCEPTS = ['idle', 'turn_ended', 'waiting_for_you', 'report_ready'] as never;
const desktop = { kind: 'desktop' } as const;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

// ---------------------------------------------------------------------------------------------------------------
// What counts as typed text: the scanner

const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_U = '\x15';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Feeds the writes in order, as a terminal delivers them, and returns whether a line may be pending after each one. */
function run(writes: string[], from: InputLine = emptyInputLine()): boolean[] {
  let line = from;
  return writes.map((w) => { line = scanDesktopInput(line, w).line; return line.unsent; });
}
const after = (...writes: string[]): boolean => run(writes).at(-1)!;

describe('scanDesktopInput: which desktop input leaves text on the line', () => {
  it.each([
    ['a letter', ['a'], true],
    ['a word and a space', ['hello ', 'wor'], true],
    ['a single space', [' '], true],
    ['accented and non-Latin text', ['é', '日本語'], true],
    ['an emoji (a surrogate pair)', ['😀'], true],
    ['a line feed (Ctrl-J adds a line break, it does not submit)', ['\n'], true],
    ['typing after an Enter starts a new line', ['abc', '\r', 'd'], true],
  ])('sets: %s', (_name, writes, expected) => {
    expect(after(...(writes as string[]))).toBe(expected);
  });

  it.each([
    ['Enter', '\r'],
    ['Ctrl-C', CTRL_C],
    ['Ctrl-U', CTRL_U],
    ['Escape on its own', ESC],
  ])('clears: %s', (_name, key) => {
    expect(after('half a thought', key)).toBe(false);
    expect(after('half a thought', 'and more', key)).toBe(false);
  });

  it('clears when the text and the Enter come in one write, and sets when the Enter comes first', () => {
    expect(after('abc\r')).toBe(false);
    expect(after('abc\rdef')).toBe(true);
    expect(after('\rdef')).toBe(true);
    expect(after(`abc${CTRL_U}`)).toBe(false);
  });

  it('counts the first Escape of a double Escape (Claude clears the line on it) but not an Escape that starts a key sequence', () => {
    expect(after('abc', `${ESC}${ESC}`)).toBe(false);
    expect(after('abc', `${ESC}[A`)).toBe(true); // arrow up
    expect(after('abc', `${ESC}OA`)).toBe(true); // application-mode arrow up
    expect(after('abc', `${ESC}b`)).toBe(true); // Alt+b
  });

  it.each([
    ['arrow keys', `${ESC}[A${ESC}[B${ESC}[C${ESC}[D`],
    ['Home, End, Delete, Page Up', `${ESC}[H${ESC}[F${ESC}[3~${ESC}[5~`],
    ['modified keys', `${ESC}[1;5C${ESC}[1;2A`],
    ['function keys', `${ESC}OP${ESC}[15~`],
    ['Shift-Tab', `${ESC}[Z`],
    ['focus in and out reports', `${ESC}[I${ESC}[O`],
    ['a mouse report', `${ESC}[<0;12;5M${ESC}[<0;12;5m`],
    ['the terminal answering a cursor position query', `${ESC}[24;80R`],
    ['the terminal answering a colour query (BEL end)', `${ESC}]11;rgb:0000/0000/0000\x07`],
    ['the terminal answering a colour query (ESC \\ end)', `${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\`],
    ['Alt+letter', `${ESC}f${ESC}b`],
    ['Tab', '\t'],
    ['Ctrl+A / Ctrl+E / Ctrl+K / Ctrl+W (line editing)', '\x01\x05\x0b\x17'],
  ])('ignores %s: an empty line stays empty', (_name, keys) => {
    expect(after(keys)).toBe(false);
  });

  it('keeps a pending line pending through those same keys', () => {
    expect(after('abc', `${ESC}[A${ESC}[<0;12;5M${ESC}[I${ESC}]11;rgb:0000/0000/0000\x07\t`)).toBe(true);
  });

  it('treats a bracketed paste as text, including its line breaks, and does not let an Enter inside it submit', () => {
    expect(after(`${PASTE_START}pasted text${PASTE_END}`)).toBe(true);
    expect(after(`${PASTE_START}line one\rline two\n${PASTE_END}`)).toBe(true);
    expect(after(`${PASTE_START}${PASTE_END}`)).toBe(false); // nothing was pasted
    expect(after(`${PASTE_START}x${PASTE_END}`, '\r')).toBe(false);
  });

  it('follows a bracketed paste that arrives in several writes', () => {
    expect(run([PASTE_START, 'first half ', 'second half', PASTE_END])).toEqual([false, true, true, true]);
    expect(run([`${PASTE_START}abc`, `def\r${PASTE_END}`, '\r'])).toEqual([true, true, false]);
    // once the paste has ended, keys are keys again
    expect(run([`${PASTE_START}abc${PASTE_END}`, CTRL_U])).toEqual([true, false]);
  });

  it('reports whether a write held text at all, whatever the line looks like afterwards', () => {
    expect(scanDesktopInput(emptyInputLine(), 'a\r')).toEqual({ line: { unsent: false, pasting: false }, typed: true });
    expect(scanDesktopInput(emptyInputLine(), '\r')).toEqual({ line: { unsent: false, pasting: false }, typed: false });
    expect(scanDesktopInput(emptyInputLine(), `${ESC}[A`).typed).toBe(false);
    expect(scanDesktopInput(emptyInputLine(), `${PASTE_START}x${PASTE_END}`).typed).toBe(true);
  });

  // Documented heuristic: any printable character since the last reset counts. Deleting characters cannot be told apart from
  // editing a longer line, because the line itself is never read back.
  describe('backspace-heavy input', () => {
    const BS = '\x7f';
    it.each([
      ['type, delete everything', ['abc', BS + BS + BS], true],
      ['type one character and delete it', ['a', BS], true],
      ['delete on an empty line', [BS, BS], false],
      ['Ctrl-H as backspace', ['abc', '\b\b\b'], true],
      ['delete forward key after typing', ['abc', `${ESC}[3~`], true],
      ['type, delete, type again, Enter', ['abc', BS, BS, BS, 'x', '\r'], false],
      ['fix a typo with backspaces, then Enter', ['helo', BS, 'lo', '\r'], false],
      ['many backspaces then a single new character', [BS.repeat(50), 'z'], true],
    ])('%s', (_name, writes, expected) => {
      expect(after(...(writes as string[]))).toBe(expected);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real manager (a scripted PTY): write() tracks, typeText / sendKeys do not

describe('ManagedManager.hasUnsentInput with the real manager', () => {
  async function managerWithTerminal() {
    const h: ManagedHarness = createHarness();
    cleanups.push(() => h.cleanup());
    const spawner = new FakeSpawner();
    const clock = { ms: Date.parse('2026-05-01T10:00:00.000Z') };
    const manager = h.makeManager({ spawner, base: { ...h.base, clock: { now: () => new Date(clock.ms) } } }) as ManagedManager & ManagedManagerExtras;
    const record = await manager.start(h.startInput());
    return { h, manager, spawner, clock, key: record.key, record, pty: spawner.ptys[0] };
  }

  it('is false for a fresh terminal, an unknown session and a terminal that is gone', async () => {
    const { manager, key, pty } = await managerWithTerminal();
    expect(manager.hasUnsentInput(key)).toBe(false);
    expect(manager.hasUnsentInput(keyOf('posix', S1))).toBe(false);
    manager.write(key, 'abc');
    expect(manager.hasUnsentInput(key)).toBe(true);
    pty.emitExit({ exitCode: 0, signal: null });
    expect(manager.hasUnsentInput(key)).toBe(false);
  });

  it('is set by a printable character typed at the terminal and cleared by Enter, Ctrl-C, Ctrl-U or Escape', async () => {
    const { manager, key, pty } = await managerWithTerminal();
    for (const clearing of ['\r', CTRL_C, CTRL_U, ESC]) {
      expect(manager.write(key, 'half a thought')).toBe(true);
      expect(manager.hasUnsentInput(key)).toBe(true);
      expect(manager.write(key, clearing)).toBe(true);
      expect(manager.hasUnsentInput(key)).toBe(false);
    }
    expect(pty.written).toEqual(['half a thought', '\r', 'half a thought', CTRL_C, 'half a thought', CTRL_U, 'half a thought', ESC]);
  });

  it('ignores keys that are not text, and follows a paste that arrives in pieces', async () => {
    const { manager, key } = await managerWithTerminal();
    for (const keys of [`${ESC}[A`, `${ESC}[I`, `${ESC}[<0;3;4M`, `${ESC}]11;rgb:0000/0000/0000\x07`, '\t', `${ESC}b`]) manager.write(key, keys);
    expect(manager.hasUnsentInput(key)).toBe(false);
    manager.write(key, PASTE_START);
    expect(manager.hasUnsentInput(key)).toBe(false);
    manager.write(key, 'pasted');
    expect(manager.hasUnsentInput(key)).toBe(true);
    manager.write(key, PASTE_END);
    manager.write(key, '\r');
    expect(manager.hasUnsentInput(key)).toBe(false);
  });

  it('is not set by text or keys Mini-Summa sends itself (typeText, sendKeys), and not cleared by them either', async () => {
    const { manager, key, pty } = await managerWithTerminal();
    expect(await manager.typeText(key, 'from the phone', { submit: false })).toBe(true);
    expect(await manager.typeText(key, 'line one\nline two', { submit: true })).toBe(true);
    expect(await manager.sendKeys(key, 'approve')).toBe(true);
    expect(await manager.sendKeys(key, 'reject')).toBe(true);
    expect(pty.written.length).toBeGreaterThanOrEqual(5);
    expect(manager.hasUnsentInput(key)).toBe(false);

    manager.write(key, 'typed at the desktop');
    expect(await manager.typeText(key, 'more', { submit: true })).toBe(true);
    expect(await manager.sendKeys(key, 'approve')).toBe(true);
    expect(manager.hasUnsentInput(key)).toBe(true); // its Enter did not tell us what became of the line
  });

  it('does not count a write that did not reach the terminal', async () => {
    const { manager, key, pty } = await managerWithTerminal();
    pty.write = () => { throw new Error('the pipe is closed'); };
    expect(manager.write(key, 'abc')).toBe(false);
    expect(manager.hasUnsentInput(key)).toBe(false);
  });

  it('starts clean with every new terminal, also when the same session is resumed', async () => {
    const { h, manager, spawner, key, record, pty } = await managerWithTerminal();
    manager.write(key, 'left on the line');
    expect(manager.hasUnsentInput(key)).toBe(true);
    pty.emitExit({ exitCode: 0, signal: null });
    const resumed = await manager.start(h.startInput({ mode: 'resume', resumeSessionId: record.sessionId }));
    expect(resumed.key).toBe(key);
    expect(spawner.ptys).toHaveLength(2);
    expect(manager.hasUnsentInput(key)).toBe(false);
    manager.write(key, 'x');
    expect(manager.hasUnsentInput(key)).toBe(true);
  });

  describe('promptSubmitted: a prompt of the session reached Claude another way', () => {
    it('clears the flag when no time is given, or the time cannot be read', async () => {
      const { manager, key } = await managerWithTerminal();
      manager.write(key, 'abc');
      manager.promptSubmitted(key);
      expect(manager.hasUnsentInput(key)).toBe(false);
      manager.write(key, 'abc');
      manager.promptSubmitted(key, 'not a time');
      expect(manager.hasUnsentInput(key)).toBe(false);
    });

    it('keeps text that was typed AFTER the prompt was submitted, and clears text typed before', async () => {
      const { manager, key, clock } = await managerWithTerminal();
      const at = (offsetMs: number): string => new Date(Date.parse('2026-05-01T10:00:00.000Z') + offsetMs).toISOString();
      clock.ms = Date.parse(at(5_000));
      manager.write(key, 'typed at +5 s');
      manager.promptSubmitted(key, at(2_000)); // that prompt ran before the typing: a newer line
      expect(manager.hasUnsentInput(key)).toBe(true);
      manager.promptSubmitted(key, at(5_000)); // the same instant: the typing belonged to it
      expect(manager.hasUnsentInput(key)).toBe(false);
      manager.write(key, 'typed at +5 s');
      manager.promptSubmitted(key, at(9_000));
      expect(manager.hasUnsentInput(key)).toBe(false);
    });

    it('does nothing for an unknown session or a line that is empty', async () => {
      const { manager, key } = await managerWithTerminal();
      expect(() => manager.promptSubmitted(keyOf('posix', S1), isoAt(1))).not.toThrow();
      manager.promptSubmitted(key, isoAt(1));
      expect(manager.hasUnsentInput(key)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The sessions layer: typeInto and targetCheck refuse; answerPermission does not

describe('typeInto and targetCheck while someone has typed on the line', () => {
  const K1 = keyOf('posix', S1);
  const ev = (n: number, event: string, extra: Record<string, unknown> = {}, env: 'posix' | 'wsl:Ubuntu' = 'posix') =>
    hookEntry({ n, env, payload: hookPayload(event, S1, { cwd: '/w/proj', ...extra }) });
  const req = (over: Record<string, unknown> = {}) => ({ text: 'Please continue', submit: true, expectGeneration: 1, allowedStates: ACCEPTS, ...over });

  async function harness(opts: Parameters<typeof makeHarness>[0] = {}): Promise<ObserverHarness> {
    const h = await makeHarness(opts);
    cleanups.push(() => h.cleanup());
    h.projects.add({ id: 'p1', name: 'Proj', roots: [{ path: '/w/proj' }] });
    await h.sessions.flush();
    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    return h;
  }

  it('refuse in words, for every kind of request, and type nothing', async () => {
    const h = await harness();
    h.managed.unsent.add(K1);
    const refused = { ok: false, code: 'state_not_allowed', problem: UNSENT };
    expect(await h.sessions.typeInto(K1, req())).toEqual(refused);
    expect(await h.sessions.typeInto(K1, req({ submit: false }))).toEqual(refused);
    expect(await h.sessions.typeInto(K1, req({ text: 'line one\nline two' }))).toEqual(refused);
    expect(await h.sessions.typeInto(K1, req({ expectGeneration: null, allowedStates: ['idle', 'working', 'unknown', 'needs_permission'] }))).toEqual(refused);
    expect(h.managed.typed).toEqual([]);
    expect(h.sessions.targetCheck(K1, 1)).toEqual({ managed: true, live: true, generation: 1, generationMatches: true, state: 'idle', problem: UNSENT });
    expect(h.sessions.targetCheck(K1, null)).toMatchObject({ problem: UNSENT });
  });

  it('allow typing again once the line is dealt with', async () => {
    const h = await harness();
    h.managed.unsent.add(K1);
    expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: false });
    h.managed.unsent.delete(K1);
    expect(h.sessions.targetCheck(K1, 1).problem).toBeNull();
    expect(await h.sessions.typeInto(K1, req())).toEqual({ ok: true, submitted: true });
    expect(h.managed.typed).toEqual([{ key: K1, text: 'Please continue', submit: true }]);
  });

  it('do not mask the other reasons a target does not qualify', async () => {
    const h = await harness();
    h.managed.unsent.add(K1);
    expect(h.sessions.targetCheck(K1, 7).problem).toMatch(/restarted after the request was made/);
    expect(await h.sessions.typeInto(K1, req({ expectGeneration: 7 }))).toMatchObject({ code: 'generation_changed' });
    h.managed.change(K1, { status: 'exited', pid: null, exitedAt: isoAt(9), exitCode: 0, prompted: true });
    expect(h.sessions.targetCheck(K1, null).problem).toBe('This session is not running. Resume it first, then try again.');
    expect(await h.sessions.typeInto(K1, req())).toMatchObject({ code: 'not_live' });
    // text with control characters is still refused first, as an error
    await expect(h.sessions.typeInto(K1, req({ text: 'bell\x07' }))).rejects.toMatchObject({ code: 'unsafe_text' });
  });

  it('say the terminal has not finished starting, before they mention the line', async () => {
    const h = await harness();
    h.managed.change(K1, { startedAt: '2026-12-01T00:00:00.000Z' }); // the terminal started again: nothing heard from it yet
    h.managed.unsent.add(K1);
    expect(h.sessions.targetCheck(K1, null).problem).toBe(STARTING);
    expect(await h.sessions.typeInto(K1, req())).toEqual({ ok: false, code: 'state_not_allowed', problem: STARTING });
  });

  it('do not apply to a session that is only observed', async () => {
    const h = await harness();
    await h.feed([hookEntry({ n: 2, payload: hookPayload('SessionStart', '22222222-2222-4222-8222-222222222222', { cwd: '/w/proj', source: 'startup' }) })]);
    const other = keyOf('posix', '22222222-2222-4222-8222-222222222222');
    h.managed.unsent.add(other);
    expect(await h.sessions.typeInto(other, req({ expectGeneration: null }))).toMatchObject({ ok: false, code: 'not_managed' });
  });

  it('do not hold back an answer to a permission dialog: the dialog takes the keys, and the person may have to answer there', async () => {
    const h = await harness();
    await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p' }), ev(3, 'PermissionRequest', { prompt_id: 'p', tool_name: 'Bash', tool_input: { command: 'ls' } })]);
    h.managed.unsent.add(K1);
    expect(h.view(K1).state).toBe('needs_permission');
    expect(await h.sessions.answerPermission(K1, 'approve', 1)).toEqual({ ok: true, submitted: true });
    expect(h.managed.keys).toEqual([{ key: K1, keys: 'approve' }]);
  });

  it('leave the desktop terminal alone: a person typing there is never held back', async () => {
    const h = await harness();
    h.managed.unsent.add(K1);
    expect(h.sessions.terminal.input(K1, 'more text')).toBe(true);
    expect(h.managed.written).toEqual([{ key: K1, data: 'more text' }]);
  });

  describe('tell the manager when a prompt reached Claude', () => {
    it('with the time the hook ran, once per UserPromptSubmit hook of a session on this computer', async () => {
      const h = await harness();
      h.managed.unsent.add(K1);
      await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p' })]);
      expect(h.managed.promptSubmittedCalls).toEqual([{ key: K1, receivedAt: isoAt(2) }]);
      expect(h.managed.unsent.has(K1)).toBe(false);
      await h.feed([ev(3, 'PreToolUse', { prompt_id: 'p', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'u' }), ev(4, 'Stop', { prompt_id: 'p', last_assistant_message: 'ok' })]);
      expect(h.managed.promptSubmittedCalls).toHaveLength(1);
      await h.feed([ev(5, 'UserPromptSubmit', { prompt_id: 'q' })]);
      expect(h.managed.promptSubmittedCalls.map((c) => c.receivedAt)).toEqual([isoAt(2), isoAt(5)]);
    });

    it('without a time for a session in another environment (its clock may differ), and never for replayed history', async () => {
      const h = await harness();
      await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'w1' }, 'wsl:Ubuntu')]);
      expect(h.managed.promptSubmittedCalls).toEqual([{ key: keyOf('wsl:Ubuntu', S1), receivedAt: undefined }]);
      const before = h.managed.promptSubmittedCalls.length;
      await h.sessions.rebuild(); // a replay of everything: none of it is news
      expect(h.managed.promptSubmittedCalls).toHaveLength(before);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Sessions and the real manager together (scripted PTY)

describe('typing at the desktop terminal blocks the phone until the line is dealt with (sessions + real manager)', () => {
  async function stack() {
    const m: ManagedHarness = createHarness();
    cleanups.push(() => m.cleanup());
    const spawner = new FakeSpawner();
    const manager = m.makeManager({ spawner });
    const projects = createFakeProjects({ bus: createEventBus(), db: m.db });
    projects.add({ id: 'p1', name: 'Proj', roots: [{ path: m.cwd }] });
    const environments = {
      ...m.environments,
      list: async () => [{ id: 'posix' as const, label: 'Linux', available: true, claude: { path: '/usr/bin/claude', version: '2.1.0', error: null }, node: { path: 'node', version: '22.0.0' }, configDir: null, hooks: null, notes: [] }],
    };
    const sessions = createSessionsService({
      base: m.base, settings: createFakeSettings(), projects, environments, managed: manager,
      overrides: { hostEnv: 'posix', spoolPollMs: 0, discoveryIntervalMs: 0 },
    });
    await sessions.init();
    cleanups.push(() => sessions.shutdown());
    const view = await sessions.start('p1', { mode: 'new' }, desktop);
    const sessionId = parseSessionKey(view.key)!.sessionId;
    const rawStore = createRawStore(m.db, systemClock);
    const hook = (n: number, event: string, extra: Record<string, unknown> = {}, receivedAt?: string) => {
      const entry = hookEntry({ n, payload: hookPayload(event, sessionId, { cwd: m.cwd, ...extra }) });
      if (receivedAt) entry.transport.received_at = receivedAt;
      rawStore.appendRaw(entry);
      return sessions.flush();
    };
    await hook(1, 'SessionStart', { source: 'startup' });
    expect(sessions.get(view.key)).toMatchObject({ state: 'idle', generation: 1 });
    const send = () => sessions.typeInto(view.key, { text: 'from the phone', submit: false, expectGeneration: 1, allowedStates: ACCEPTS });
    return { m, sessions, key: view.key, pty: spawner.ptys[0], hook, send };
  }

  it('is refused after the first character and allowed again after each of Enter, Ctrl-C, Ctrl-U and Escape', async () => {
    const { sessions, key, pty, send } = await stack();
    expect(await send()).toEqual({ ok: true, submitted: false });
    for (const clearing of ['\r', CTRL_C, CTRL_U, ESC]) {
      expect(sessions.terminal.input(key, 'half a thought')).toBe(true);
      expect(sessions.targetCheck(key, 1).problem).toBe(UNSENT);
      expect(await send()).toEqual({ ok: false, code: 'state_not_allowed', problem: UNSENT });
      expect(sessions.terminal.input(key, clearing)).toBe(true);
      expect(sessions.targetCheck(key, 1).problem).toBeNull();
      expect(await send()).toEqual({ ok: true, submitted: false });
    }
    // exactly the desktop's keystrokes and the phone's accepted texts reached the terminal; the refused ones did not
    expect(pty.written.filter((w) => w === 'from the phone')).toHaveLength(5);
  });

  it('is cleared by the UserPromptSubmit hook of a prompt that was sent another way, unless the line is newer than that prompt', async () => {
    const { sessions, key, hook, send } = await stack();
    sessions.terminal.input(key, 'abc');
    expect(await send()).toMatchObject({ ok: false, problem: UNSENT });

    // a prompt that ran BEFORE the typing (an old hook ingested late) says nothing about this line
    await hook(2, 'UserPromptSubmit', { prompt_id: 'old' }, new Date(Date.now() - 60_000).toISOString());
    expect(sessions.targetCheck(key, 1).problem).toBe(UNSENT);

    // a prompt that ran after it was typed was submitted with it
    await hook(3, 'UserPromptSubmit', { prompt_id: 'new' }, new Date(Date.now() + 60_000).toISOString());
    expect(sessions.targetCheck(key, 1).problem).toBeNull();
    await hook(4, 'Stop', { prompt_id: 'new', last_assistant_message: 'done' });
    expect(await send()).toEqual({ ok: true, submitted: false });
  });

  it('does not apply once the terminal is gone', async () => {
    const { sessions, key, pty } = await stack();
    sessions.terminal.input(key, 'abc');
    pty.emitExit({ exitCode: 0, signal: null });
    await waitFor(() => sessions.get(key)?.availability !== 'live', { what: 'the terminal to be seen as gone' });
    expect(sessions.targetCheck(key, null).problem).not.toBe(UNSENT);
  });
});
