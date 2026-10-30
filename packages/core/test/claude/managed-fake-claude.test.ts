import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodePtySpawner } from '../../src/claude/ptyHost.ts';
import type { PtyExitInfo, PtyProcess } from '../../src/claude/ptyHost.ts';
import {
  FAKE_CLAUDE_VERSION, directive, fakeClaudeCommand, fakeClaudeEnv, readContext, readEnvReport, readHookRuns, readLiveFiles, readReceived, writeExternals,
} from '../../src/testing/fake-claude/index.ts';
import { stripAnsi, waitFor } from './managed-harness.ts';

// The fake Claude CLI is the stand-in every later integration test relies on, so its own behaviour is tested here,
// through a real PTY, without any Mini-Summa code in between.

const run = promisify(execFile);
const SESSION = '9d3f6a52-6d0e-4b8c-a1d6-3c7e2f1b0a01';
const roots: string[] = [];
const ptys: PtyProcess[] = [];
afterEach(() => {
  for (const p of ptys.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  // a hook process of the killed fake may still be writing into the spool: retry when the folder is not empty yet
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Fake {
  state: string;
  cwd: string;
  events: () => { event: string; tool?: string; prompt?: string; source?: string; reason?: string; mode?: string }[];
  names: () => string[];
  pty: PtyProcess;
  out: () => string;
  plain: () => string;
  exit: () => PtyExitInfo | null;
  write: (s: string) => void;
  text: (needle: string | RegExp, ms?: number) => Promise<string>;
}

function setup(): { root: string; state: string; cwd: string; settings: string; eventsFile: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-fake-')));
  roots.push(root);
  const state = path.join(root, 'state');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(state); fs.mkdirSync(cwd);
  const logger = path.join(root, 'log-hook.mjs');
  const eventsFile = path.join(root, 'events.jsonl');
  fs.writeFileSync(logger, `import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.argv[2], JSON.stringify({ event: p.hook_event_name, tool: p.tool_name, prompt: p.prompt, source: p.source, reason: p.reason, mode: p.permission_mode }) + '\\n');`);
  const command = `"${process.execPath}" "${logger}" "${eventsFile}"`;
  const hooks: Record<string, unknown> = {};
  for (const e of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']) {
    hooks[e] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks }));
  return { root, state, cwd, settings, eventsFile };
}

function launch(args: string[], opts: { env?: Record<string, string>; cwd?: string; useSettings?: boolean; session?: string | null; name?: string } = {}, s = setup()): Fake {
  const cmd = fakeClaudeCommand(s.state);
  const full = [...cmd.prefixArgs, ...(opts.session === null ? [] : ['--session-id', opts.session ?? SESSION]), ...(opts.useSettings === false ? [] : ['--settings', s.settings]), ...(opts.name ? ['--name', opts.name] : []), ...args];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const pty = createNodePtySpawner().spawn({
    file: cmd.file, args: full, cwd: opts.cwd ?? s.cwd, cols: 100, rows: 30,
    env: { ...env, FAKE_CLAUDE_THINK_MS: '20', FAKE_CLAUDE_NOTIFY_MS: '300', ...opts.env },
  });
  ptys.push(pty);
  let out = '';
  let exit: PtyExitInfo | null = null;
  pty.onData((d) => { out += d; });
  pty.onExit((e) => { exit = e; });
  const plain = (): string => stripAnsi(out);
  const events = () => {
    try { return fs.readFileSync(s.eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return {
    state: s.state, cwd: s.cwd, events, names: () => events().map((e: { event: string }) => e.event), pty, out: () => out, plain, exit: () => exit,
    write: (x) => pty.write(x),
    text: (needle, ms = 10_000) => waitFor(() => ((typeof needle === 'string' ? plain().includes(needle) : needle.test(plain())) ? plain() : undefined), `terminal text ${String(needle)}`, ms),
  };
}

const agents = async (state: string, extra: string[] = []): Promise<Record<string, unknown>[]> => {
  const cmd = fakeClaudeCommand(state);
  const { stdout } = await run(cmd.file, [...cmd.prefixArgs, 'agents', '--json', ...extra]);
  return JSON.parse(stdout) as Record<string, unknown>[];
};

describe('the fake CLI: non-interactive commands', () => {
  it('--version prints what the real CLI prints', async () => {
    const cmd = fakeClaudeCommand('/unused');
    const { stdout } = await run(cmd.file, [...cmd.prefixArgs, '--version']);
    expect(stdout).toBe('2.1.314 (Claude Code)\n');
    expect(FAKE_CLAUDE_VERSION).toBe('2.1.314');
  });

  it('agents --json is an empty array when nothing runs, and the state dir can also come from the environment', async () => {
    const s = setup();
    expect(await agents(s.state)).toEqual([]);
    const cmd = fakeClaudeCommand(s.state);
    const viaEnv = await run(cmd.file, [cmd.prefixArgs[0], 'agents', '--json'], { env: { ...process.env, ...fakeClaudeEnv(s.state) } });
    expect(JSON.parse(viaEnv.stdout)).toEqual([]);
  });

  it('refuses to run without a state directory, and rejects options it does not know (like commander does)', async () => {
    const cmd = fakeClaudeCommand('/unused');
    await expect(run(cmd.file, [cmd.prefixArgs[0], 'agents', '--json'], { env: { ...process.env, FAKE_CLAUDE_STATE_DIR: '' } })).rejects.toMatchObject({ code: 2 });
    await expect(run(cmd.file, [...cmd.prefixArgs, '--no-such-option'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("unknown option '--no-such-option'") });
  });

  it('lists live sessions with the fields the real CLI prints, only while the process is alive', async () => {
    const s = setup();
    const fake = launch(['--remote-control'], { name: 'listed' }, s);
    await fake.text('? for shortcuts');
    const [entry] = await agents(s.state);
    expect(entry).toMatchObject({ pid: fake.pty.pid, cwd: s.cwd, kind: 'interactive', sessionId: SESSION, name: 'listed', status: 'idle', remoteControl: true });
    expect(typeof entry.startedAt).toBe('number');
    // the real CLI's fields (examples/agents-json) are a subset of what is printed; nothing is spelled differently
    for (const key of ['cwd', 'kind', 'startedAt', 'pid', 'status', 'sessionId', 'name']) expect(entry).toHaveProperty(key);
    expect(await agents(s.state, ['--cwd', path.join(s.root, 'elsewhere')])).toEqual([]);
    expect(await agents(s.state, ['--cwd', path.dirname(s.cwd)])).toHaveLength(1);

    fake.write('/exit\r');
    await waitFor(() => fake.exit(), 'exit');
    expect(await agents(s.state)).toEqual([]);
  });

  it('a killed process leaves its registration behind, but is not listed because its pid is dead', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    fake.pty.kill('SIGKILL');
    await waitFor(() => fake.exit(), 'exit');
    expect(readLiveFiles(s.state)).toHaveLength(1);
    expect(await agents(s.state)).toEqual([]);
    expect(readLiveFiles(s.state)).toHaveLength(0); // swept by the listing
  });

  it('shows simulated external sessions exactly as written, even with a dead pid, next to live ones', async () => {
    const s = setup();
    const external = { pid: 999_999_999, cwd: '/somewhere/else', kind: 'interactive', startedAt: 1_793_354_819_144, sessionId: '00000000-0000-4000-8000-0000000000aa', name: 'elsewhere', status: 'waiting', waitingFor: 'permission prompt' };
    writeExternals(s.state, [external]);
    expect(await agents(s.state)).toEqual([external]);
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    expect((await agents(s.state)).map((e) => e.sessionId).sort()).toEqual([SESSION, external.sessionId].sort());
    writeExternals(s.state, []);
    expect(await agents(s.state)).toHaveLength(1);
  });
});

describe('the fake CLI: starting a session', () => {
  it('needs a TTY and a valid session id; resume needs a saved conversation', async () => {
    const s = setup();
    const cmd = fakeClaudeCommand(s.state);
    await expect(run(cmd.file, [...cmd.prefixArgs, '--session-id', SESSION])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Input must be provided') });
    const bad = launch(['--session-id', 'nope'], { session: null }, s);
    await waitFor(() => bad.exit(), 'exit');
    expect(bad.plain()).toContain('Invalid session ID. Must be a valid UUID.');
    expect(bad.exit()).toMatchObject({ exitCode: 1 });
    const missing = launch(['--resume', SESSION], { session: null }, s);
    await waitFor(() => missing.exit(), 'exit');
    expect(missing.plain()).toContain(`No conversation found with session ID: ${SESSION}`);
  });

  it('fires SessionStart(startup) with the session id, then offers a prompt; settings may also be inline JSON', async () => {
    const s = setup();
    const fake = launch([], { useSettings: false }, s);
    await fake.text('? for shortcuts');
    expect(fake.plain()).toContain('Welcome to Claude Code');
    expect(readHookRuns(s.state, SESSION)).toEqual([]); // no settings, no hooks
    const inline = launch(['--settings', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'inline ctx'}}))"` }] }] } })], { useSettings: false, session: '5d1a9a41-24c0-4b93-8c6a-93e2d9a9c002' }, s);
    await inline.text('? for shortcuts');
    await waitFor(() => readContext(s.state, '5d1a9a41-24c0-4b93-8c6a-93e2d9a9c002'), 'context');
    expect(readContext(s.state, '5d1a9a41-24c0-4b93-8c6a-93e2d9a9c002')).toBe('inline ctx');
  });

  it('runs the hooks in the user-level settings.json of CLAUDE_CONFIG_DIR as well, once per distinct command', async () => {
    const s = setup();
    const config = path.join(s.root, 'config');
    fs.mkdirSync(config);
    const marker = path.join(s.root, 'user-hook.log');
    const userHook = { type: 'command', command: `"${process.execPath}" -e "require('fs').appendFileSync(process.argv[1], 'user-hook ran\\n')" "${marker}"` };
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [userHook] }], Stop: [{ hooks: [userHook] }] } }));
    // the same command in --settings must not run twice
    const dup = path.join(s.root, 'dup.json');
    fs.writeFileSync(dup, JSON.stringify({ hooks: { SessionStart: [{ hooks: [userHook] }] } }));
    const fake = launch(['--settings', dup], { env: { CLAUDE_CONFIG_DIR: config }, useSettings: false }, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fs.existsSync(marker), 'the user-level hook');
    expect(fs.readFileSync(marker, 'utf8')).toBe('user-hook ran\n');
    // transcripts live under the config dir, like the real CLI's
    fake.write('hello\r');
    await waitFor(() => fs.existsSync(path.join(config, 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`)), 'the transcript');
  });

  it('honours a hook timeout and a tool matcher', async () => {
    const s = setup();
    const slow = path.join(s.root, 'slow.json');
    fs.writeFileSync(slow, JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, timeout: 1 }] }],
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `"${process.execPath}" -e "process.exit(0)"` }] }, { matcher: 'Bash|Read', hooks: [{ type: 'command', command: `"${process.execPath}" -e "process.exit(0); // bash"` }] }],
    } }));
    const started = Date.now();
    const fake = launch(['--settings', slow], { useSettings: false }, s);
    await fake.text('? for shortcuts');
    expect(Date.now() - started).toBeLessThan(8000);
    await waitFor(() => readHookRuns(s.state, SESSION).length === 1, 'the SessionStart hook run');
    expect(readHookRuns(s.state, SESSION)[0]).toMatchObject({ event: 'SessionStart', timedOut: true });
    fake.write(`${directive.tool('bash', 'echo x')}\r`);
    await fake.text('● Bash(echo x)');
    await waitFor(() => readHookRuns(s.state, SESSION).some((r) => r.event === 'PreToolUse'), 'the PreToolUse hook');
    const pre = readHookRuns(s.state, SESSION).filter((r) => r.event === 'PreToolUse');
    expect(pre).toHaveLength(1);
    expect(pre[0].command).toContain('// bash');
  });
});

describe('the fake CLI: input', () => {
  it('a bracketed paste (even split across writes) is one prompt; a raw newline is Enter and submits', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    fake.write('\x1b[200~ab');
    await new Promise((r) => setTimeout(r, 60));
    fake.write('cd\nef\x1b[20');
    await new Promise((r) => setTimeout(r, 60));
    fake.write('1~');
    await new Promise((r) => setTimeout(r, 60));
    fake.write('\r');
    await waitFor(() => readReceived(s.state, SESSION).length === 1, 'the pasted prompt');
    expect(readReceived(s.state, SESSION)[0].text).toBe('abcd\nef');
    await waitFor(() => fake.names().filter((n) => n === 'Stop').length === 1, 'Stop');

    fake.write('one\ntwo\r');   // not pasted: the newline is Enter
    await waitFor(() => readReceived(s.state, SESSION).length === 3, 'two more prompts');
    expect(readReceived(s.state, SESSION).map((r) => r.text)).toEqual(['abcd\nef', 'one', 'two']);
    // every prompt fired its own UserPromptSubmit with the text exactly as typed
    await waitFor(() => fake.events().filter((e) => e.event === 'UserPromptSubmit').length === 3, 'three UserPromptSubmit');
    expect(fake.events().filter((e) => e.event === 'UserPromptSubmit').map((e) => e.prompt)).toEqual(['abcd\nef', 'one', 'two']);
  });

  it('Backspace edits the line; an empty line is not a prompt; unknown slash commands are not prompts', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    fake.write('\r\r');
    fake.write('/help\r');
    fake.write('hxx\x7f\x7fi\r');
    await waitFor(() => readReceived(s.state, SESSION).length === 1, 'the prompt');
    expect(readReceived(s.state, SESSION).map((r) => r.text)).toEqual(['hi']);
    expect(fake.plain()).toContain('Unknown command: /help');
  });

  it('/clear replaces the conversation inside the same process: SessionEnd(clear), SessionStart(clear, no model), and agents lists the new id with the same pid', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    const [before] = await agents(s.state);
    expect(before.sessionId).toBe(SESSION);
    fake.write('/clear\r');
    await waitFor(() => fake.names().filter((n) => n === 'SessionStart').length === 2, 'the second SessionStart');
    expect(fake.events().map((e) => `${e.event}:${e.source ?? e.reason ?? ''}`)).toEqual(['SessionStart:startup', 'SessionEnd:clear', 'SessionStart:clear']);
    const [after] = await agents(s.state);
    expect(after.pid).toBe(before.pid);
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.sessionId).not.toBe(SESSION);
    expect(fs.existsSync(path.join(s.state, `hooks-${after.sessionId}.jsonl`))).toBe(true);   // later hooks belong to the new id
    expect(readEnvReport(s.state, String(after.sessionId))).not.toBeNull();
    fake.write('typed after the clear\r');
    await waitFor(() => readReceived(s.state, String(after.sessionId)).length === 1, 'the prompt in the new session');
    expect(readReceived(s.state, SESSION)).toEqual([]);
    await fake.text('Conversation cleared');
  });

  it('/resume <id> returns to an older session that has a transcript (with model, like the real CLI) and refuses one that has none', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    fake.write('first conversation\r');
    await waitFor(() => readReceived(s.state, SESSION).length === 1, 'the first prompt');
    await fake.text('Echo: first conversation');
    fake.write('/clear\r');
    await waitFor(() => fake.names().includes('SessionEnd'), 'SessionEnd');
    const [cleared] = await agents(s.state);
    fake.write('/resume 99999999-9999-4999-8999-999999999999\r');
    await fake.text('No conversation found with session ID: 99999999-9999-4999-8999-999999999999');
    expect(fake.names().filter((n) => n === 'SessionStart')).toHaveLength(2);
    fake.write(`/resume ${SESSION}\r`);
    await waitFor(() => fake.names().filter((n) => n === 'SessionStart').length === 3, 'the SessionStart of the resume');
    expect(fake.events().map((e) => `${e.event}:${e.source ?? e.reason ?? ''}`).slice(-2)).toEqual(['SessionEnd:resume', 'SessionStart:resume']);
    const [back] = await agents(s.state);
    expect(back.sessionId).toBe(SESSION);
    expect(back.pid).toBe(cleared.pid);
  });

  it('a [[fake:clear]] directive does the same in the middle of a turn, and that turn ends with no Stop', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    fake.write('please clear the context [[fake:clear]]\r');
    await waitFor(() => fake.names().filter((n) => n === 'SessionStart').length === 2, 'the SessionStart after the directive');
    await new Promise((r) => setTimeout(r, 400));
    expect(fake.names()).toEqual(['SessionStart', 'UserPromptSubmit', 'SessionEnd', 'SessionStart']);   // no Stop for the turn of the old session
  });

  it('FAKE_CLAUDE_REGISTRY_LAG_MS keeps the old id in agents --json for a while after the hooks announced the new one', async () => {
    const s = setup();
    const fake = launch([], { env: { FAKE_CLAUDE_REGISTRY_LAG_MS: '1200' } }, s);
    await fake.text('? for shortcuts');
    fake.write('/clear\r');
    await waitFor(() => fake.names().filter((n) => n === 'SessionStart').length === 2, 'the new SessionStart');
    expect((await agents(s.state))[0].sessionId).toBe(SESSION);          // the hooks are out, the registry is not
    await waitFor(async () => (await agents(s.state))[0].sessionId !== SESSION, 'the registry to catch up', 5000);
  });

  it('Ctrl-C once only warns; twice (or /exit) ends the session with SessionEnd(prompt_input_exit) and exit 0', async () => {
    const s = setup();
    const a = launch([], {}, s);
    await a.text('? for shortcuts');
    await waitFor(() => a.names().includes('SessionStart'), 'SessionStart');
    a.write('\x03');
    await a.text('Press Ctrl-C again to exit');
    expect(a.exit()).toBeNull();
    await new Promise((r) => setTimeout(r, 1000)); // longer than the double-press window
    a.write('\x03');
    await new Promise((r) => setTimeout(r, 200));
    expect(a.exit()).toBeNull();
    a.write('\x03');
    await waitFor(() => a.exit(), 'exit after two quick Ctrl-C');
    expect(a.exit()).toEqual({ exitCode: 0, signal: null });
    expect(a.events().at(-1)).toMatchObject({ event: 'SessionEnd', reason: 'prompt_input_exit' });

    const s2 = setup();
    const b = launch([], {}, s2);
    await b.text('? for shortcuts');
    b.write('/exit\r');
    await waitFor(() => b.exit(), 'exit');
    expect(b.events().at(-1)).toMatchObject({ event: 'SessionEnd', reason: 'prompt_input_exit' });
  });

  it('SIGTERM ends the process with NO SessionEnd, like the real CLI; so does a crash', async () => {
    const s = setup();
    const a = launch([], {}, s);
    await a.text('? for shortcuts');
    await waitFor(() => a.names().includes('SessionStart'), 'SessionStart');
    a.pty.kill('SIGTERM');
    await waitFor(() => a.exit(), 'exit');
    expect(a.exit()).toEqual({ exitCode: 143, signal: null });
    expect(a.names()).toEqual(['SessionStart']);

    const s2 = setup();
    const b = launch([], {}, s2);
    await b.text('? for shortcuts');
    await waitFor(() => b.names().includes('SessionStart'), 'SessionStart');
    b.write(`${directive.crash(7)}\r`);
    await waitFor(() => b.exit(), 'exit');
    expect(b.exit()).toEqual({ exitCode: 7, signal: null });
    expect(b.names()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(await agents(s2.state)).toEqual([]);
  });
});

describe('the fake CLI: a turn', () => {
  it('Esc while busy interrupts the turn: no Stop, status goes busy -> idle, and the session carries on', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    fake.write(`${directive.sleep(30_000)}\r`);
    await waitFor(() => readLiveFiles(s.state)[0]?.status === 'busy', 'busy');
    expect((await agents(s.state))[0]).toMatchObject({ status: 'busy' });
    fake.write('\x1b');
    await fake.text('Interrupted');
    await waitFor(() => readLiveFiles(s.state)[0]?.status === 'idle', 'idle');
    expect(fake.names()).toEqual(['SessionStart', 'UserPromptSubmit']);
    fake.write(`${directive.say('after the interrupt')}\r`);
    await fake.text('● after the interrupt');
    await waitFor(() => fake.names().at(-1) === 'Stop', 'Stop');
  });

  it('Ctrl-C while busy also interrupts instead of exiting', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    fake.write(`${directive.sleep(30_000)}\r`);
    await waitFor(() => readLiveFiles(s.state)[0]?.status === 'busy', 'busy');
    fake.write('\x03');
    await fake.text('Interrupted');
    expect(fake.exit()).toBeNull();
  });

  it('the permission dialog waits: status "waiting", Enter / 1 / 3 approve, Esc / 4 reject; Notification follows after a while', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    for (const [key, approved] of [['\r', true], ['1', true], ['3', true], ['\x1b', false], ['4', false]] as const) {
      const marker = path.join(s.cwd, `marker-${approved ? 'yes' : 'no'}-${key.charCodeAt(0)}.txt`);
      fake.write(`${directive.permission('bash', `touch ${path.basename(marker)}`)}\r`);
      await waitFor(() => readLiveFiles(s.state)[0]?.status === 'waiting', 'the dialog');
      expect(readLiveFiles(s.state)[0]).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt' });
      if (key === '\r') {
        await waitFor(() => fake.events().some((e) => e.event === 'Notification'), 'the delayed Notification');
        // the dialog has the layout and numbering seen on the real CLI
        for (const line of ['Bash command', 'Do you want to proceed?', '1. Yes', '2. Yes, and always allow access to', '3. Yes, and switch to auto mode', '4. No', 'Esc to cancel']) expect(fake.plain()).toContain(line);
      }
      await waitFor(() => fake.names().filter((n) => n === 'PermissionRequest').length >= 1, 'PermissionRequest');
      fake.write(key);
      await waitFor(() => readLiveFiles(s.state)[0]?.status === 'idle', 'idle again');
      expect(fs.existsSync(marker), `${JSON.stringify(key)} -> ${approved}`).toBe(approved);
    }
    const names = fake.names();
    expect(names.filter((n) => n === 'PostToolUse')).toHaveLength(3);
    expect(names.filter((n) => n === 'Stop')).toHaveLength(3);
  });

  it('a question dialog (elicitation) waits for an answer; the answer is what was typed', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    fake.write(`${directive.input('Which file?')}\r`);
    await waitFor(() => readLiveFiles(s.state)[0]?.status === 'waiting', 'waiting');
    expect(readLiveFiles(s.state)[0]).toMatchObject({ waitingFor: 'input needed' });
    await waitFor(() => fake.events().some((e) => e.event === 'Notification'), 'Notification');
    fake.write('rea');
    fake.write('x\x7fdme.md\r');
    await fake.text('(answered: readme.md)');
    await waitFor(() => fake.names().at(-1) === 'Stop', 'Stop');
  });

  it('every directive does what it says', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    fake.write(`${directive.tool('write', 'made.txt', 'hello')} ${directive.tool('read', 'made.txt')} ${directive.tool('bash', 'echo from-bash')}\r`);
    await waitFor(() => fake.names().at(-1) === 'Stop', 'Stop');
    expect(fs.readFileSync(path.join(s.cwd, 'made.txt'), 'utf8')).toBe('hello');
    expect(fake.events().filter((e) => e.event === 'PreToolUse').map((e) => e.tool)).toEqual(['Write', 'Read', 'Bash']);
    expect(fake.plain()).toContain('from-bash');

    fake.write(`${directive.error('overloaded')} ${directive.report({ task: 'ignored because the turn failed' })}\r`);
    await waitFor(() => fake.names().at(-1) === 'StopFailure', 'StopFailure');
    expect(fake.plain()).toContain('API Error: overloaded');
  });

  it('a bash directive with = in its command is a command, not an option', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    fake.write(`${directive.tool('bash', 'FOO=bar sh -c "echo $FOO-value"'.replace(/"/g, "'"))}\r`);
    await fake.text('bar-value');
  });

  it('FAKE_CLAUDE_PASTE_WRAP=0 reports every paste verbatim', async () => {
    const s = setup();
    const fake = launch([], { env: { FAKE_CLAUDE_PASTE_WRAP: '0' } }, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.names().includes('SessionStart'), 'SessionStart');
    fake.write('\x1b[200~one\ntwo\nthree\nfour\x1b[201~\r');
    await waitFor(() => fake.events().some((e) => e.event === 'UserPromptSubmit'), 'UserPromptSubmit');
    expect(fake.events().find((e) => e.event === 'UserPromptSubmit')!.prompt).toBe('one\ntwo\nthree\nfour');
    expect(fake.plain()).not.toContain('[Pasted text');
  });

  it('--permission-mode manual is reported as "default" (as the real CLI does); bypassPermissions skips the dialog', async () => {
    const s = setup();
    const manual = launch(['--permission-mode', 'manual'], {}, s);
    await manual.text('? for shortcuts');
    await waitFor(() => manual.names().includes('SessionStart'), 'SessionStart');
    manual.write(`${directive.say('hi')}\r`);
    await waitFor(() => manual.names().includes('Stop'), 'Stop');
    expect(manual.events().find((e) => e.event === 'UserPromptSubmit')!.mode).toBe('default');
    manual.write('/exit\r');
    await waitFor(() => manual.exit(), 'exit');

    const s2 = setup();
    const bypass = launch(['--permission-mode', 'bypassPermissions'], {}, s2);
    await bypass.text('? for shortcuts');
    await waitFor(() => bypass.names().includes('SessionStart'), 'SessionStart');
    bypass.write(`${directive.permission('bash', 'touch no-dialog.txt')}\r`);
    await waitFor(() => bypass.names().includes('Stop'), 'Stop');
    expect(fs.existsSync(path.join(s2.cwd, 'no-dialog.txt'))).toBe(true);
    expect(bypass.names()).not.toContain('PermissionRequest');
  });

  it('can send the idle_prompt Notification when asked to', async () => {
    const s = setup();
    const fake = launch([], { env: { FAKE_CLAUDE_IDLE_NOTIFY_MS: '300' } }, s);
    await fake.text('? for shortcuts');
    await waitFor(() => fake.events().some((e) => e.event === 'Notification'), 'idle_prompt Notification');
  });

  it('answers a terminal resize by recording the new size', async () => {
    const s = setup();
    const fake = launch([], {}, s);
    await fake.text('? for shortcuts');
    fake.pty.resize(111, 33);
    await fake.text('[terminal resized to 111x33]');
    expect(JSON.parse(fs.readFileSync(path.join(s.state, `size-${SESSION}.json`), 'utf8'))).toEqual({ cols: 111, rows: 33 });
  });
});
