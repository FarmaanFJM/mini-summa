import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSessionKey } from '@minisumma/shared';
import type { ManagedSessionRecord } from '../../src/contracts.ts';
import { CoreError } from '../../src/errors.ts';
import { createNodePtySpawner } from '../../src/claude/ptyHost.ts';
import { directive, readEnvReport, readReceived } from '../../src/testing/fake-claude/index.ts';
import {
  CONVERSATION_ID, FakePty, FakeSpawner, PROJECT_ID, createHarness, eventsOf, startWithSink, waitFor, waitForText,
} from './managed-harness.ts';
import type { Harness } from './managed-harness.ts';

let h: Harness;
afterEach(async () => { await h?.cleanup(); });

const row = (h0: Harness, key: string) => h0.db.get<Record<string, unknown>>('SELECT * FROM managed_sessions WHERE session_key = ?', [key]);
const binding = (h0: Harness, key: string) => h0.db.get<Record<string, unknown>>('SELECT * FROM session_bindings WHERE session_key = ?', [key]);
const count = (h0: Harness, table: string): number => h0.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
const catchError = async (p: Promise<unknown>): Promise<CoreError> => {
  try { await p; } catch (e) { return e as CoreError; }
  throw new Error('expected a rejection');
};

describe('start: a new session', () => {
  it('writes the managed_sessions and session_bindings rows before the process exists, with argv free of secrets', async () => {
    h = createHarness({ baseEnv: { ANTHROPIC_API_KEY: 'sk-test-not-a-real-key', ANTHROPIC_AUTH_TOKEN: 'tok-test-not-real' } });
    const real = createNodePtySpawner();
    const atSpawn: { run: unknown; binding: unknown }[] = [];
    const manager = h.makeManager({
      appRunId: 'run_A',
      spawner: { spawn(req) { atSpawn.push({ run: h.db.get('SELECT status, pid FROM managed_sessions'), binding: h.db.get('SELECT source, conversation_id FROM session_bindings') }); return real.spawn(req); } },
    });
    const record = await manager.start(h.startInput({ name: 'Fix login', conversationId: CONVERSATION_ID, rootId: 'rot_x' }));

    expect(atSpawn).toEqual([{ run: { status: 'running', pid: null }, binding: { source: 'managed', conversation_id: CONVERSATION_ID } }]);

    expect(record).toMatchObject({
      env: 'posix', projectId: PROJECT_ID, rootId: 'rot_x', cwd: h.cwd, name: 'Fix login', mode: 'new', resumedFrom: null,
      remoteControl: false, status: 'running', exitedAt: null, exitCode: null, exitSignal: null, exitReason: null,
      cols: 100, rows: 30, prompted: false, appRunId: 'run_A', conversationId: CONVERSATION_ID,
    });
    expect(record.key).toBe(makeSessionKey('posix', record.sessionId));
    expect(record.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(record.pid).toBeGreaterThan(0);
    expect(typeof record.startedAt).toBe('string');

    const stored = row(h, record.key)!;
    expect(stored).toMatchObject({ status: 'running', app_run_id: 'run_A', project_id: PROJECT_ID, name: 'Fix login', mode: 'new', remote_control: 0, prompted: 0, pid: record.pid });
    const argv = JSON.parse(String(stored.argv_json)) as string[];
    expect(argv).toContain('--session-id');
    expect(argv).toContain(record.sessionId);
    expect(argv).toContain('--settings');
    expect(argv).toContain('--name');
    expect(String(stored.argv_json)).not.toMatch(/sk-test-not-a-real-key|tok-test-not-real/);
    expect(binding(h, record.key)).toMatchObject({ source: 'managed', project_id: PROJECT_ID, conversation_id: CONVERSATION_ID });
    expect(manager.get(record.key)).toEqual(record);
    expect(manager.list().map((r) => r.key)).toEqual([record.key]);
  });

  it('keeps the session id in the session file the process was given, and starts the process in the project folder', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { record, sink } = await startWithSink(manager, h);
    await waitForText(sink, 'Welcome to Claude Code');
    expect(sink.plain).toContain(`session: ${record.sessionId}`);
    expect(sink.plain).toContain(`cwd: ${h.cwd}`);
    const settings = path.join(h.dataDir, 'managed-settings', 'posix', `${record.sessionId}.json`);
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.statSync(settings).mode & 0o777).toBe(0o600);
  });

  it('updates lastOutputAt and writes it to the database at most once per throttle window', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, overrides: { outputThrottleMs: 300 } });
    const changes: ManagedSessionRecord[] = [];
    manager.onChange((r) => changes.push(r));
    const record = await manager.start(h.startInput());
    expect(record.lastOutputAt).toBeNull();
    const before = changes.length;
    for (let i = 0; i < 200; i++) spawner.ptys[0].emitData(`line ${i}\r\n`);
    // fresh in memory at once, not yet in the database, and no change event yet
    expect(manager.get(record.key)!.lastOutputAt).not.toBeNull();
    expect(row(h, record.key)!.last_output_at).toBeNull();
    expect(changes.length).toBe(before);
    await waitFor(() => row(h, record.key)!.last_output_at, 'throttled write of lastOutputAt', 3000);
    expect(changes.length).toBe(before + 1);
    expect(changes.at(-1)!.lastOutputAt).toBe(row(h, record.key)!.last_output_at);
  });

  it('emits onChange for every change: created, pid, exit, with the previous record', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    const seen: { prev: string | null; next: string; pid: number | null; reason: string | null }[] = [];
    manager.onChange((r, p) => seen.push({ prev: p?.status ?? null, next: r.status, pid: r.pid, reason: r.exitReason }));
    const record = await manager.start(h.startInput());
    manager.markPrompted(record.key);
    manager.resize(record.key, 90, 25);
    spawner.ptys[0].emitExit({ exitCode: 0, signal: null });
    expect(seen).toEqual([
      { prev: null, next: 'running', pid: null, reason: null },
      { prev: 'running', next: 'running', pid: 40000, reason: null },
      { prev: 'running', next: 'running', pid: 40000, reason: null },
      { prev: 'running', next: 'running', pid: 40000, reason: null },
      { prev: 'running', next: 'exited', pid: null, reason: 'exited' },
    ]);
    const done = manager.get(record.key)!;
    expect(done).toMatchObject({ status: 'exited', pid: null, exitCode: 0, exitSignal: null, exitReason: 'exited', prompted: true, cols: 90, rows: 25 });
    expect(done.exitedAt).not.toBeNull();
    expect(row(h, record.key)).toMatchObject({ status: 'exited', exit_reason: 'exited', exit_code: 0, prompted: 1, cols: 90, rows: 25 });
  });

  it('can unsubscribe a listener', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    let n = 0;
    const off = manager.onChange(() => { n += 1; });
    await manager.start(h.startInput());
    const seen = n;
    off();
    await manager.start(h.startInput());
    expect(n).toBe(seen);
  });

  it('a throwing listener cannot break the session or the other listeners', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    let ok = 0;
    manager.onChange(() => { throw new Error('boom'); });
    manager.onChange(() => { ok += 1; });
    const record = await manager.start(h.startInput());
    expect(record.status).toBe('running');
    expect(ok).toBeGreaterThan(0);
  });
});

describe('start: the environment the process gets', () => {
  it('removes harness identity variables, keeps credentials and CLAUDE_CONFIG_DIR, sets TERM and COLORTERM', async () => {
    const configDir = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'ms-cfg-')), 'claude');
    h = createHarness({
      baseEnv: {
        CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '5555', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_SESSION_ATTENDED: '1',
        ANTHROPIC_API_KEY: 'sk-test-not-real', ANTHROPIC_AUTH_TOKEN: 'tok-test-not-real', ANTHROPIC_BASE_URL: 'https://proxy.example.invalid',
        ANTHROPIC_MODEL: 'leaked-model', CLAUDE_CONFIG_DIR: configDir, TERM: 'dumb',
      },
    });
    const manager = h.makeManager();
    const record = await manager.start(h.startInput());
    const report = await waitFor(() => readEnvReport(h.stateDir, record.sessionId), 'env report of the fake');
    for (const gone of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'ANTHROPIC_MODEL']) {
      expect(report.names, gone).not.toContain(gone);
    }
    for (const kept of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'PATH']) {
      expect(report.names, kept).toContain(kept);
    }
    expect(report.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(report.TERM).toBe('xterm-256color');
    expect(report.COLORTERM).toBe('truecolor');
  });
});

describe('how a session ends', () => {
  it('a process that ends by itself is recorded as exited with its code', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, sink } = await startWithSink(manager, h);
    await waitForText(sink, '? for shortcuts');
    expect(manager.write(key, '/exit\r')).toBe(true);
    await waitFor(() => manager.get(key)!.status === 'exited', 'the session to exit');
    const record = manager.get(key)!;
    expect(record).toMatchObject({ status: 'exited', exitCode: 0, exitSignal: null, exitReason: 'exited', pid: null });
    expect(record.exitedAt).not.toBeNull();
    expect(eventsOf(h.spool(), record.sessionId)).toEqual(['SessionStart', 'SessionEnd']);
    expect(sink.exits).toHaveLength(1);
    expect(sink.exits[0]).toMatchObject({ code: 0, signal: null, reason: 'exited' });
  });

  it('stop() is graceful by default: Ctrl-C twice makes Claude leave by itself, SessionEnd fires, reason is "exited"', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, sink } = await startWithSink(manager, h);
    await waitForText(sink, '? for shortcuts');
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    const stopped = await manager.stop(key, {});
    expect(stopped).toMatchObject({ status: 'exited', exitCode: 0, exitReason: 'exited', pid: null });
    const end = h.spool().find((r) => r.event === 'SessionEnd');
    expect(end?.payload.reason).toBe('prompt_input_exit');
  });

  it('stop({force}) kills at once, records "killed_by_user", and Claude gets no chance to fire SessionEnd', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const { key, sink } = await startWithSink(manager, h);
    await waitForText(sink, '? for shortcuts');
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    const started = Date.now();
    const stopped = await manager.stop(key, { force: true });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(stopped).toMatchObject({ status: 'exited', exitReason: 'killed_by_user', pid: null });
    expect(eventsOf(h.spool())).not.toContain('SessionEnd');
    expect(sink.exits[0].reason).toBe('killed_by_user');
  });

  it('a graceful stop that works is NOT "killed_by_user" (Mini-Summa did not terminate it)', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, overrides: { stopGraceMs: 2000 } });
    const record = await manager.start(h.startInput());
    const pty = spawner.ptys[0];
    let presses = 0;
    pty.write = (data: string) => { pty.written.push(data); if (data === '\x03' && ++presses === 2) setTimeout(() => pty.emitExit({ exitCode: 0, signal: null }), 10); };
    const stopped = await manager.stop(record.key, {});
    expect(pty.written.slice(0, 2)).toEqual(['\x03', '\x03']);
    expect(pty.killed).toEqual([]);
    expect(stopped).toMatchObject({ status: 'exited', exitReason: 'exited', exitCode: 0 });
  });

  it('a graceful stop that does not work ends in a kill after the timeout, recorded "killed_by_user"', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, overrides: { stopGraceMs: 300, ctrlCRepeatMs: 120, ctrlCGapMs: 20 } });
    const record = await manager.start(h.startInput());
    const pty = spawner.ptys[0];
    pty.politeExit = false;
    pty.onKill = (signal) => (signal === 'SIGTERM' ? { exitCode: null, signal: 15 } : null);
    const started = Date.now();
    const stopped = await manager.stop(record.key, {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(pty.written.filter((w) => w === '\x03').length).toBeGreaterThanOrEqual(4); // the gesture was repeated
    expect(pty.killed).toEqual(['SIGTERM']);
    expect(stopped).toMatchObject({ status: 'exited', exitReason: 'killed_by_user', exitCode: null, exitSignal: 15 });
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, overrides: { termWaitMs: 100 } });
    const record = await manager.start(h.startInput());
    const pty = spawner.ptys[0];
    pty.onKill = (signal) => (signal === 'SIGKILL' ? { exitCode: null, signal: 9 } : null);
    const stopped = await manager.stop(record.key, { force: true });
    expect(pty.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(stopped).toMatchObject({ exitReason: 'killed_by_user', exitSignal: 9 });
    expect(pty.written).toEqual([]); // force does not try the polite way first
  });

  it('a force stop during a pending graceful stop takes over', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, overrides: { stopGraceMs: 10_000, termWaitMs: 100 } });
    const record = await manager.start(h.startInput());
    const pty = spawner.ptys[0];
    pty.politeExit = false;
    pty.onKill = () => ({ exitCode: null, signal: 15 });
    const graceful = manager.stop(record.key, {});
    await new Promise((r) => setTimeout(r, 50));
    const forced = await manager.stop(record.key, { force: true });
    await graceful;
    expect(forced).toMatchObject({ status: 'exited', exitReason: 'killed_by_user' });
  });

  it('stop() on a session that is not running returns its record; on an unknown key it is a 404', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    const record = await manager.start(h.startInput());
    spawner.ptys[0].emitExit({ exitCode: 0, signal: null });
    const again = await manager.stop(record.key, { force: true });
    expect(again).toMatchObject({ status: 'exited', exitReason: 'exited' });
    const error = await catchError(manager.stop('posix|00000000-0000-4000-8000-000000000000', {}));
    expect(error).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('shutdown() ends every PTY, records "app_exit" and flushes; no new session can start afterwards', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const a = await startWithSink(manager, h);
    const b = await startWithSink(manager, h, { name: 'second' });
    await waitForText(a.sink, '? for shortcuts');
    await waitForText(b.sink, '? for shortcuts');
    await manager.shutdown();
    for (const key of [a.key, b.key]) {
      expect(manager.get(key)).toMatchObject({ status: 'exited', exitReason: 'app_exit', pid: null });
      expect(row(h, key)).toMatchObject({ status: 'exited', exit_reason: 'app_exit' });
    }
    expect(a.sink.exits[0].reason).toBe('app_exit');
    const error = await catchError(manager.start(h.startInput()));
    expect(error).toMatchObject({ status: 503, code: 'shutting_down' });
  });

  it('shutdown() kills a process that will not leave, and still records app_exit', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, overrides: { shutdownGraceMs: 50, termWaitMs: 50, killWaitMs: 50 } });
    const record = await manager.start(h.startInput());
    const pty = spawner.ptys[0];
    pty.politeExit = false;
    pty.onKill = () => null; // would never exit
    await manager.shutdown();
    expect(pty.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(manager.get(record.key)).toMatchObject({ status: 'exited', exitReason: 'app_exit' });
  });
});

describe('app restart: the PTY died with the old process', () => {
  it('init() marks running records of an earlier run "disconnected" (app_restart) and never claims a PTY survived', async () => {
    h = createHarness();
    const spawnerA = new FakeSpawner();
    const first = h.makeManager({ spawner: spawnerA, appRunId: 'run_A' });
    const running = await first.start(h.startInput({ name: 'was running', conversationId: CONVERSATION_ID }));
    const finished = await first.start(h.startInput({ name: 'had finished' }));
    spawnerA.ptys[1].emitExit({ exitCode: 0, signal: null });

    const second = h.makeManager({ spawner: new FakeSpawner(), appRunId: 'run_B' });
    const changes: { key: string; prev: string | null; next: string; reason: string | null }[] = [];
    second.onChange((r, p) => changes.push({ key: r.key, prev: p?.status ?? null, next: r.status, reason: r.exitReason }));
    second.init();

    expect(changes).toEqual([{ key: running.key, prev: 'running', next: 'disconnected', reason: 'app_restart' }]);
    expect(second.get(running.key)).toMatchObject({ status: 'disconnected', exitReason: 'app_restart', pid: null, exitedAt: null, appRunId: 'run_A', prompted: false });
    expect(second.get(finished.key)).toMatchObject({ status: 'exited', exitReason: 'exited' });
    expect(row(h, running.key)).toMatchObject({ status: 'disconnected', exit_reason: 'app_restart', pid: null });
    // the binding is untouched, so late hooks of the old process are still attributed
    expect(binding(h, running.key)).toMatchObject({ source: 'managed', conversation_id: CONVERSATION_ID });

    second.init();
    expect(changes).toHaveLength(1);
  });

  it('does not touch a session started by the current run', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner(), appRunId: 'run_B' });
    const record = await manager.start(h.startInput());
    manager.init();
    expect(manager.get(record.key)).toMatchObject({ status: 'running', appRunId: 'run_B' });
  });

  it('a disconnected session accepts no input and cannot be stopped; attach replays nothing and reports why', async () => {
    h = createHarness();
    const first = h.makeManager({ spawner: new FakeSpawner(), appRunId: 'run_A' });
    const gone = await first.start(h.startInput());
    const second = h.makeManager({ spawner: new FakeSpawner(), appRunId: 'run_B' });
    second.init();
    expect(second.write(gone.key, 'x')).toBe(false);
    expect(await second.typeText(gone.key, 'hello', { submit: true })).toBe(false);
    expect(await second.sendKeys(gone.key, 'approve')).toBe(false);
    second.resize(gone.key, 80, 24);
    expect(await second.stop(gone.key, { force: true })).toMatchObject({ status: 'disconnected' });

    const sink = new (await import('./managed-harness.ts')).RecordingSink();
    const attached = second.attach(gone.key, { cols: 80, rows: 24 }, sink);
    if ('error' in attached) throw new Error(attached.error);
    expect(attached.replay).toBe('');
    expect(attached.seq).toBe(0);
    await Promise.resolve();
    expect(sink.exits).toHaveLength(1);
    expect(sink.exits[0].reason).toBe('app_restart');
    expect(second.attach('posix|00000000-0000-4000-8000-000000000000', { cols: 80, rows: 24 }, sink)).toHaveProperty('error');
  });

  it('a disconnected session can be resumed: same id, same key, same row, conversation kept', async () => {
    h = createHarness();
    const first = h.makeManager({ spawner: new FakeSpawner(), appRunId: 'run_A' });
    const old = await first.start(h.startInput({ name: 'old name', conversationId: CONVERSATION_ID }));
    first.markPrompted(old.key);
    const spawnerB = new FakeSpawner();
    const second = h.makeManager({ spawner: spawnerB, appRunId: 'run_B' });
    second.init();
    const resumed = await second.start(h.startInput({ mode: 'resume', resumeSessionId: old.sessionId, conversationId: null }));
    expect(resumed.key).toBe(old.key);
    expect(resumed).toMatchObject({
      mode: 'resume', resumedFrom: old.key, status: 'running', appRunId: 'run_B', exitReason: null, exitedAt: null,
      prompted: true, name: 'old name', conversationId: CONVERSATION_ID,
    });
    expect(count(h, 'managed_sessions')).toBe(1);
    expect(count(h, 'session_bindings')).toBe(1);
    const args = spawnerB.requests[0].args as string[];
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(old.sessionId);
    expect(args).not.toContain('--session-id');
  });
});

describe('start: things that go wrong', () => {
  it('claude_not_found (422) with install guidance, and nothing is recorded', async () => {
    h = createHarness();
    h.environments.claude.set('posix', null);
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    const error = await catchError(manager.start(h.startInput()));
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toMatchObject({ status: 422, code: 'claude_not_found' });
    expect(error.message).toMatch(/Claude Code was not found in Linux/);
    expect(error.message).toMatch(/claude\.ai\/install\.sh/);
    expect(count(h, 'managed_sessions')).toBe(0);
    expect(count(h, 'session_bindings')).toBe(0);
    expect(spawner.requests).toHaveLength(0);
  });

  it('gives Windows and WSL their own installation hints', async () => {
    h = createHarness();
    h.environments.claude.set('win', null);
    h.environments.claude.set('wsl:Ubuntu', null);
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    expect((await catchError(manager.start(h.startInput({ env: 'win', cwd: 'C:\\Dev\\App' })))).message).toMatch(/Windows.*winget install Anthropic\.ClaudeCode/);
    expect((await catchError(manager.start(h.startInput({ env: 'wsl:Ubuntu', cwd: '/home/me/app' })))).message).toMatch(/WSL \(Ubuntu\).*Inside that distribution/);
  });

  it('claude_not_found when the resolved executable has disappeared', async () => {
    h = createHarness();
    h.environments.claude.set('posix', { file: path.join(h.root, 'gone', 'claude'), prefixArgs: [], wslDistro: null });
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    const error = await catchError(manager.start(h.startInput()));
    expect(error).toMatchObject({ status: 422, code: 'claude_not_found' });
    expect(error.message).toMatch(/is not there any more/);
  });

  it('no_hook_runtime (422) when the environment has no Node, before any record or process exists', async () => {
    h = createHarness();
    h.environments.layouts.set('posix', { env: 'posix', spoolDirHost: '/s', registryFileHost: '/r', spoolDirInEnv: '/s', registryFileInEnv: '/r', captureScriptInEnv: '/c', runtime: null, configDirHost: null, configDirInEnv: null });
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    const error = await catchError(manager.start(h.startInput()));
    expect(error).toMatchObject({ status: 422, code: 'no_hook_runtime' });
    expect(error.message).toMatch(/Node\.js/);
    expect(count(h, 'managed_sessions')).toBe(0);
    expect(spawner.requests).toHaveLength(0);
  });

  it('checks the folder for the host environment: it must exist and be absolute', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    expect(await catchError(manager.start(h.startInput({ cwd: path.join(h.root, 'no-such-folder') })))).toMatchObject({ status: 422, code: 'cwd_not_found' });
    expect(await catchError(manager.start(h.startInput({ cwd: path.join(h.cwd, '..', 'unregistered', 'x', '..', '..', '..', 'project', 'nothing.txt') })))).toMatchObject({ code: 'cwd_not_found' });
    expect(await catchError(manager.start(h.startInput({ cwd: 'relative/dir' })))).toMatchObject({ code: 'cwd_invalid' });
    expect(await catchError(manager.start(h.startInput({ cwd: '  ' })))).toMatchObject({ code: 'cwd_invalid' });
    expect(await catchError(manager.start(h.startInput({ env: 'wsl:Ubuntu', cwd: 'C:\\Dev' })))).toMatchObject({ code: 'cwd_invalid' });
    expect(count(h, 'managed_sessions')).toBe(0);
  });

  it('resume needs a valid session id', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    expect(await catchError(manager.start(h.startInput({ mode: 'resume' })))).toMatchObject({ status: 400 });
    expect(await catchError(manager.start(h.startInput({ mode: 'resume', resumeSessionId: 'not-a-uuid' })))).toMatchObject({ status: 400 });
  });

  it('spawn_failed: the record stays (exited, reason spawn_failed) and start() rejects with a plain message', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    spawner.failWith = new Error('posix_spawnp failed');
    const manager = h.makeManager({ spawner });
    const changes: string[] = [];
    manager.onChange((r) => changes.push(`${r.status}:${r.exitReason}`));
    const error = await catchError(manager.start(h.startInput()));
    expect(error).toMatchObject({ status: 500, code: 'spawn_failed' });
    expect(error.message).toContain('posix_spawnp failed');
    const [record] = manager.list();
    expect(record).toMatchObject({ status: 'exited', exitReason: 'spawn_failed', pid: null, exitCode: null });
    expect(record.exitedAt).not.toBeNull();
    expect(changes).toEqual(['running:null', 'exited:spawn_failed']);
    expect(row(h, record.key)).toMatchObject({ status: 'exited', exit_reason: 'spawn_failed' });
  });

  it('refuses to start a session that is already running here (409), and to reuse an id for a new session', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    const record = await manager.start(h.startInput());
    expect(await catchError(manager.start(h.startInput({ mode: 'resume', resumeSessionId: record.sessionId })))).toMatchObject({ status: 409, code: 'session_running' });
    const fixed = h.makeManager({ spawner: new FakeSpawner(), newSessionId: () => record.sessionId });
    expect(await catchError(fixed.start(h.startInput()))).toMatchObject({ status: 409, code: 'session_exists' });
    expect(count(h, 'managed_sessions')).toBe(1);
  });

  it('a project that no longer exists is refused and leaves no half-written rows', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    const error = await catchError(manager.start(h.startInput({ projectId: 'prj_deleted' })));
    expect(error).toMatchObject({ status: 422, code: 'invalid_binding' });
    expect(count(h, 'managed_sessions')).toBe(0);
    expect(count(h, 'session_bindings')).toBe(0);
    expect(spawner.requests).toHaveLength(0);
  });

  it('the same session uuid in two environments is two sessions with two keys', async () => {
    h = createHarness();
    const same = '8f14e45f-ceea-467a-9575-d1f1cb2f0a11';
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, newSessionId: () => same });
    const posix = await manager.start(h.startInput({ env: 'posix' }));
    const win = await manager.start(h.startInput({ env: 'win', cwd: 'C:\\Dev\\App' }));
    expect(posix.key).toBe(`posix|${same}`);
    expect(win.key).toBe(`win|${same}`);
    expect(posix.sessionId).toBe(win.sessionId);
    expect(count(h, 'managed_sessions')).toBe(2);
    expect(count(h, 'session_bindings')).toBe(2);
    expect(manager.list().map((r) => r.key).sort()).toEqual([`posix|${same}`, `win|${same}`]);
    // acting on one never touches the other
    expect(manager.write(win.key, 'only-win')).toBe(true);
    expect(spawner.ptys[0].written).toEqual([]);
    expect(spawner.ptys[1].written).toEqual(['only-win']);
    spawner.ptys[1].emitExit({ exitCode: 0, signal: null });
    expect(manager.get(posix.key)!.status).toBe('running');
    expect(manager.get(win.key)!.status).toBe('exited');
    // each got its own settings file
    expect(fs.existsSync(path.join(h.dataDir, 'managed-settings', 'posix', `${same}.json`))).toBe(true);
    expect(fs.existsSync(path.join(h.dataDir, 'managed-settings', 'win', `${same}.json`))).toBe(true);
  });

  it('a WSL environment whose settings cannot be reached from inside the distribution is refused cleanly', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    const error = await catchError(manager.start(h.startInput({ env: 'wsl:Ubuntu', cwd: '/home/me/app' })));
    expect(error).toMatchObject({ status: 422, code: 'settings_path_unreachable' });
    expect(count(h, 'managed_sessions')).toBe(0);
  });
});

describe('resume with the fake CLI', () => {
  it('after a prompt was saved, --resume starts the same session id again; a never-prompted session cannot be resumed', async () => {
    h = createHarness();
    const manager = h.makeManager();
    const first = await startWithSink(manager, h, { name: 'resume me' });
    await waitForText(first.sink, '? for shortcuts');
    await waitFor(() => eventsOf(h.spool()).includes('SessionStart'), 'SessionStart');
    expect(await manager.typeText(first.key, `hello ${directive.say('first answer')}`, { submit: true })).toBe(true);
    await waitFor(() => eventsOf(h.spool()).includes('Stop'), 'Stop');
    manager.markPrompted(first.key);
    await manager.stop(first.key, {});
    expect(manager.get(first.key)).toMatchObject({ status: 'exited', prompted: true });

    const second = await startWithSink(manager, h, { mode: 'resume', resumeSessionId: first.record.sessionId });
    expect(second.key).toBe(first.key);
    await waitForText(second.sink, '(resumed)');
    await waitFor(() => eventsOf(h.spool(), first.record.sessionId).filter((e) => e === 'SessionStart').length === 2, 'second SessionStart');
    const starts = h.spool().filter((r) => r.event === 'SessionStart' && r.payload.session_id === first.record.sessionId);
    expect(starts.map((s) => s.payload.source)).toEqual(['startup', 'resume']);
    // a resumed start looks different on the real CLI (2.1.314): no model, but numeric context fields
    expect(starts[0].payload).toHaveProperty('model');
    expect(starts[1].payload).not.toHaveProperty('model');
    expect(typeof starts[1].payload.context_tokens).toBe('number');
    expect(starts[1].transport.redactions).toBe(0); // a number named *_tokens is not a secret
    expect(manager.get(first.key)).toMatchObject({ status: 'running', mode: 'resume', resumedFrom: first.key, name: 'resume me', prompted: true });
    expect(readReceived(h.stateDir, first.record.sessionId)).toHaveLength(1);

    // a session that never received a prompt is not saved, so Claude refuses; the failure is an ordinary exit
    const lonely = await startWithSink(manager, h, { name: 'never prompted' });
    await waitForText(lonely.sink, '? for shortcuts');
    await manager.stop(lonely.key, {});
    const refused = await startWithSink(manager, h, { mode: 'resume', resumeSessionId: lonely.record.sessionId });
    await waitFor(() => manager.get(refused.key)!.status === 'exited', 'the failed resume to exit');
    expect(manager.get(refused.key)).toMatchObject({ exitCode: 1, exitReason: 'exited' });
    expect(refused.sink.plain).toContain('No conversation found with session ID');
  });
});

describe('markPrompted', () => {
  it('records that a prompt was submitted, persists it and tells listeners; once', async () => {
    h = createHarness();
    const manager = h.makeManager({ spawner: new FakeSpawner() });
    const record = await manager.start(h.startInput());
    let events = 0;
    manager.onChange(() => { events += 1; });
    manager.markPrompted(record.key);
    manager.markPrompted(record.key);
    expect(events).toBe(1);
    expect(manager.get(record.key)!.prompted).toBe(true);
    expect(row(h, record.key)!.prompted).toBe(1);
  });

  it('works on a record from an earlier run too', async () => {
    h = createHarness();
    const first = h.makeManager({ spawner: new FakeSpawner(), appRunId: 'run_A' });
    const record = await first.start(h.startInput());
    const second = h.makeManager({ spawner: new FakeSpawner(), appRunId: 'run_B' });
    second.init();
    second.markPrompted(record.key);
    expect(second.get(record.key)).toMatchObject({ status: 'disconnected', prompted: true });
    expect(row(h, record.key)!.prompted).toBe(1);
  });
});

describe('FakePty sanity', () => {
  it('the scripted PTY behaves like the interface says (guards the other tests)', () => {
    const pty = new FakePty(1);
    const data: string[] = [];
    pty.onData((d) => data.push(d));
    pty.emitData('a');
    pty.kill('SIGHUP');
    expect(data).toEqual(['a']);
    expect(pty.killed).toEqual(['SIGHUP']);
  });
});
