// Shared set-up for the managed-session tests: temp directories, an in-memory database with one project and one
// conversation, a fake EnvironmentsService that points at the fake Claude CLI and the real capture script, a
// scripted PTY for the edge cases a real process cannot produce on demand, and small waiting/reading helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvId, SessionKey } from '@minisumma/shared';
import { openDatabase } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import { createEventBus } from '../../src/bus.ts';
import type { CoreBase, EnvLayout, EnvironmentsService, Logger, ManagedManager, ManagedSessionRecord, ManagedStartInput, TerminalSink } from '../../src/contracts.ts';
import { systemClock } from '../../src/contracts.ts';
import { createManagedManager } from '../../src/claude/managed.ts';
import type { ManagedManagerDeps, ManagedOverrides } from '../../src/claude/managed.ts';
import type { Disposable, PtyExitInfo, PtyProcess, PtySpawnRequest, PtySpawner } from '../../src/claude/ptyHost.ts';
import { fakeClaudeCommand, waitFor } from '../../src/testing/fake-claude/index.ts';

export { waitFor };

export const CAPTURE_SCRIPT = fileURLToPath(new URL('../../../claude-integration/src/hook/capture.mjs', import.meta.url));

export const PROJECT_ID = 'prj_harness';
export const CONVERSATION_ID = 'cnv_harness';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface SpoolRecord {
  event: string;
  payload: Record<string, unknown>;
  transport: Record<string, unknown>;
  file: string;
}

export interface Harness {
  root: string;
  dataDir: string;
  /** State directory of the fake Claude CLI. */
  stateDir: string;
  spoolDir: string;
  registryFile: string;
  /** A project folder that is registered, so SessionStart hooks inject the report protocol. */
  cwd: string;
  /** A folder that is not in the registry. */
  otherCwd: string;
  db: Db;
  base: CoreBase;
  environments: EnvironmentsService & { layouts: Map<EnvId, EnvLayout | null>; claude: Map<EnvId, ReturnType<typeof fakeClaudeCommand> | null> };
  managers: ManagedManager[];
  makeManager(deps?: Partial<ManagedManagerDeps>): ManagedManager;
  startInput(over?: Partial<ManagedStartInput>): ManagedStartInput;
  spool(): SpoolRecord[];
  cleanup(): Promise<void>;
}

/** Fast defaults so the suite is quick; individual tests override what they exercise. */
export const FAST: ManagedOverrides = {
  stopGraceMs: 4000,
  ctrlCGapMs: 100,
  ctrlCRepeatMs: 1200,
  termWaitMs: 800,
  killWaitMs: 1500,
  shutdownGraceMs: 800,
  outputThrottleMs: 40,
};

export function createHarness(opts: { baseEnv?: Record<string, string | undefined>; layoutEnv?: EnvId } = {}): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-managed-')));
  const dataDir = path.join(root, 'data');
  const stateDir = path.join(root, 'fake-state');
  const spoolDir = path.join(root, 'spool', 'posix');
  const registryFile = path.join(root, 'registry.json');
  const cwd = path.join(root, 'work', 'project');
  const otherCwd = path.join(root, 'work', 'unregistered');
  for (const d of [dataDir, stateDir, cwd, otherCwd]) fs.mkdirSync(d, { recursive: true });

  const { db } = openDatabase(':memory:');
  const now = new Date().toISOString();
  db.run(`INSERT INTO projects (id, name, default_env, notification_prefs_json, created_at, updated_at) VALUES (?, 'Harness project', 'posix', '{}', ?, ?)`, [PROJECT_ID, now, now]);
  db.run(
    `INSERT INTO conversations (id, project_id, title, url, original_url, kind, created_at, updated_at)
     VALUES (?, ?, 'Harness chat', 'https://chatgpt.com/c/harness', 'https://chatgpt.com/c/harness', 'chat', ?, ?)`,
    [CONVERSATION_ID, PROJECT_ID, now, now],
  );
  fs.writeFileSync(registryFile, JSON.stringify({ defaultEnv: 'posix', projects: [{ id: PROJECT_ID, name: 'Harness project', roots: [{ path: cwd, env: 'posix' }] }] }));

  const base: CoreBase = { db, bus: createEventBus(), clock: systemClock, log: silent, version: 'test', mode: 'headless', dataDir };

  const layoutFor = (env: EnvId): EnvLayout => ({
    env,
    spoolDirHost: spoolDir,
    registryFileHost: registryFile,
    spoolDirInEnv: spoolDir,
    registryFileInEnv: registryFile,
    captureScriptInEnv: CAPTURE_SCRIPT,
    runtime: { command: process.execPath, runAsNode: false, version: process.version },
    configDirHost: null,
    configDirInEnv: null,
  });
  const layouts = new Map<EnvId, EnvLayout | null>();
  const claude = new Map<EnvId, ReturnType<typeof fakeClaudeCommand> | null>();
  const environments: Harness['environments'] = {
    layouts,
    claude,
    hostEnv: () => 'posix',
    list: async () => [],
    layout: async (env) => layouts.get(env) ?? layoutFor(opts.layoutEnv ?? env),
    claudeCommand: async (env) => (claude.has(env) ? claude.get(env) ?? null : fakeClaudeCommand(stateDir)),
  };

  const baseEnv = { ...process.env, FAKE_CLAUDE_THINK_MS: '30', FAKE_CLAUDE_NOTIFY_MS: '400', ...opts.baseEnv };
  const managers: ManagedManager[] = [];
  const makeManager = (deps: Partial<ManagedManagerDeps> = {}): ManagedManager => {
    const manager = createManagedManager({
      base,
      environments,
      ...deps,
      overrides: { ...FAST, baseEnv, ...deps.overrides },
    });
    managers.push(manager);
    return manager;
  };

  return {
    root, dataDir, stateDir, spoolDir, registryFile, cwd, otherCwd, db, base, environments, managers, makeManager,
    startInput: (over = {}) => ({
      projectId: PROJECT_ID, rootId: null, env: 'posix', cwd, name: null, remoteControl: false, cols: 100, rows: 30,
      mode: 'new', conversationId: null, ...over,
    }),
    spool: () => readSpool(spoolDir),
    async cleanup() {
      await Promise.all(managers.map((m) => m.shutdown().catch(() => undefined)));
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function readSpool(dir: string): SpoolRecord[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const records: SpoolRecord[] = [];
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { transport: Record<string, unknown>; payload: Record<string, unknown> };
      records.push({ event: String(parsed.payload.hook_event_name ?? parsed.transport.hook_arg), payload: parsed.payload, transport: parsed.transport, file: name });
    } catch { /* a file still being renamed into place */ }
  }
  return records.sort((a, b) => (BigInt(String(a.transport.monotonic_ns)) < BigInt(String(b.transport.monotonic_ns)) ? -1 : 1));
}

export const eventsOf = (records: SpoolRecord[], sessionId?: string): string[] =>
  records.filter((r) => !sessionId || r.payload.session_id === sessionId).map((r) => r.event);

// ---------------------------------------------------------------------------------------------------------------
// Terminal sinks

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

export class RecordingSink implements TerminalSink {
  chunks: { seq: number; data: string }[] = [];
  exits: { code: number | null; signal: number | null; at: string; reason: string }[] = [];
  data(seq: number, data: string): void { this.chunks.push({ seq, data }); }
  exit(info: { code: number | null; signal: number | null; at: string; reason: string }): void { this.exits.push(info); }
  get text(): string { return this.chunks.map((c) => c.data).join(''); }
  get plain(): string { return stripAnsi(this.text); }
}

/** Resolves when `probe(sink)` is true; the sink keeps collecting meanwhile. */
export const waitForText = (sink: RecordingSink, needle: string | RegExp, timeoutMs = 15_000): Promise<string> =>
  waitFor(() => {
    const plain = sink.plain;
    return (typeof needle === 'string' ? plain.includes(needle) : needle.test(plain)) ? plain : undefined;
  }, `terminal text ${String(needle)}`, timeoutMs);

export async function startWithSink(manager: ManagedManager, harness: Harness, over: Partial<ManagedStartInput> = {}): Promise<{ record: ManagedSessionRecord; key: SessionKey; sink: RecordingSink }> {
  const record = await manager.start(harness.startInput(over));
  const sink = new RecordingSink();
  const attached = manager.attach(record.key, { cols: record.cols, rows: record.rows }, sink);
  if ('error' in attached) throw new Error(attached.error);
  if (attached.replay) sink.data(attached.seq, attached.replay);
  return { record, key: record.key, sink };
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted PTY and spawner

export class FakePty implements PtyProcess {
  readonly written: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly killed: (string | undefined)[] = [];
  /** Like Claude Code: two Ctrl-C leave the process. Tests that need a stubborn process turn this off. */
  politeExit = true;
  /** Called for every kill(); return an exit to simulate the process dying. Default: it dies of that signal. */
  onKill: ((signal: string | undefined) => PtyExitInfo | null) | null = null;
  private ctrlC = 0;
  private readonly dataListeners = new Set<(d: string) => void>();
  private readonly exitListeners = new Set<(i: PtyExitInfo) => void>();
  constructor(readonly pid: number) {}
  onData(listener: (data: string) => void): Disposable { this.dataListeners.add(listener); return { dispose: () => { this.dataListeners.delete(listener); } }; }
  onExit(listener: (info: PtyExitInfo) => void): Disposable { this.exitListeners.add(listener); return { dispose: () => { this.exitListeners.delete(listener); } }; }
  write(data: string): void {
    this.written.push(data);
    if (this.politeExit && data === '\x03' && ++this.ctrlC === 2) setTimeout(() => this.emitExit({ exitCode: 0, signal: null }), 5);
  }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  kill(signal?: string): void {
    this.killed.push(signal);
    const exit = this.onKill ? this.onKill(signal) : { exitCode: null, signal: signal === 'SIGKILL' ? 9 : 15 };
    if (exit) this.emitExit(exit);
  }
  emitData(data: string): void { for (const l of [...this.dataListeners]) l(data); }
  emitExit(info: PtyExitInfo): void { for (const l of [...this.exitListeners]) l(info); }
}

export class FakeSpawner implements PtySpawner {
  readonly requests: PtySpawnRequest[] = [];
  readonly ptys: FakePty[] = [];
  failWith: Error | null = null;
  /** Runs inside spawn(), before the process "exists": tests use it to look at the database at that moment. */
  beforeSpawn: ((req: PtySpawnRequest) => void) | null = null;
  private nextPid = 40_000;
  spawn(req: PtySpawnRequest): PtyProcess {
    this.beforeSpawn?.(req);
    if (this.failWith) throw this.failWith;
    this.requests.push(req);
    const pty = new FakePty(this.nextPid++);
    this.ptys.push(pty);
    return pty;
  }
}
