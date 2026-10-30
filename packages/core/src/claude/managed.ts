// Managed sessions: Claude Code processes that Mini-Summa starts in its own terminals (PTYs).
//
// This module owns the PTYs, the per-session settings file that gives a session its hooks, the managed_sessions rows and
// the 'managed' rows of session_bindings. It never decides what a session MEANS: whether Claude is working, waiting for a
// permission or finished comes from hooks and discovery through the reducer, never from reading terminal output.
//
// Rules this file keeps (docs/ARCHITECTURE.md):
//  - a session is (environment, session id); resuming keeps the same id and the same key;
//  - rows are written BEFORE the process exists, so no hook can arrive for a session nobody knows is managed;
//  - managed PTYs do not survive the app: on the next run init() marks them 'disconnected'. A PTY is never claimed alive;
//  - text reaches Claude only through typeText/sendKeys/write, which the sessions layer calls after re-verifying the target.
//
// Contract notes (decisions where contracts.ts was silent):
//  - `deps.overrides` is the CoreOptions overrides plus the test seams in ManagedOverrides below.
//  - For a WSL environment `claudeCommand(env).file` is read as the command to run INSIDE the distribution (default
//    `claude`) and `prefixArgs` as arguments that go before mine; the wsl.exe wrapper is built here.
//  - init() marks records 'disconnected' with exitReason 'app_restart' and leaves exitedAt null: when the process died is unknown.
//  - A failed spawn leaves the record (exited, reason 'spawn_failed') and start() throws CoreError 500 'spawn_failed'.
//  - hasUnsentInput(key) is a heuristic over what a person typed at the desktop terminal through write() (inputTracking.ts):
//    a printable character sets it, Enter / Ctrl-C / Ctrl-U / Escape clear it, a new PTY starts clean. Text and keys sent
//    through typeText / sendKeys never touch it. promptSubmitted() is an extra, not in the ManagedManager contract: the
//    sessions layer calls it when a UserPromptSubmit hook of the session is ingested (a prompt reached Claude another way).
//  - On Windows, wsl.exe and cmd.exe are started by full path (windowsPrograms.ts), and a session name cannot carry the
//    characters that split a Windows command line (normalizeSessionName).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UUID_RE, envLabel, isWslEnv, makeSessionKey } from '@minisumma/shared';
import type { EnvId, SessionKey } from '@minisumma/shared';
import { newId } from '@minisumma/storage';
import type { SqlValue } from '@minisumma/storage';
import { nowIso } from '../contracts.ts';
import type {
  CoreBase, CoreOptions, EnvironmentsService, ManagedManager, ManagedSessionRecord, ManagedStartInput, TerminalAttachment, TerminalSink,
} from '../contracts.ts';
import { CoreError } from '../errors.ts';
import { emptyInputLine, scanDesktopInput } from './inputTracking.ts';
import type { InputLine } from './inputTracking.ts';
import { CTRL_C, PERMISSION_KEYS, SUBMIT_DELAY_MS, encodeUserText } from './keys.ts';
import { ScrollbackBuffer, buildLaunchPlan, createNodePtySpawner } from './ptyHost.ts';
import type { ClaudeCommand, PtyProcess, PtySpawner } from './ptyHost.ts';
import { writeManagedSettings } from './settingsFile.ts';
import { systemProgramPath } from './windowsPrograms.ts';

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers: arguments and environment

export interface ClaudeArgsInput {
  mode: 'new' | 'resume';
  sessionId: string;
  /** The settings file as Claude inside the environment sees it. */
  settingsPath: string;
  name: string | null;
  remoteControl: boolean;
}

/**
 *   new:    --session-id <id> --settings <file> [--name <name>] [--remote-control [name]]
 *   resume: --resume <id>     --settings <file> [--name <name>] [--remote-control]
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = input.mode === 'resume' ? ['--resume', input.sessionId] : ['--session-id', input.sessionId];
  args.push('--settings', input.settingsPath);
  if (input.name) args.push('--name', input.name);
  if (input.remoteControl) {
    args.push('--remote-control');
    if (input.mode === 'new' && input.name) args.push(input.name);
  }
  return args;
}

// Variables that identify the Claude Code session Mini-Summa may itself be running inside. Left in place, a managed
// session would think it is a child of that session (or report to its IDE bridge). CLAUDE_CODE_CHILD_SESSION was found
// with the real CLI (2.1.314): a session that inherits it prints "Transcript saving is off - inherited
// CLAUDE_CODE_CHILD_SESSION marker", so nothing it does could be resumed.
const HARNESS_EXACT = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_CHILD_SESSION']);
const HARNESS_PREFIXES = ['CLAUDE_CODE_SESSION_'];
// ANTHROPIC_* variables are removed EXCEPT the ones that are credentials or connection settings the user relies on.
// Model-choice variables (ANTHROPIC_MODEL, ...) are removed: they are not credentials, and a leftover from a parent
// harness would silently pick the model of every managed session. CLAUDE_CONFIG_DIR is never touched.
const ANTHROPIC_KEEP = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
]);

/** The environment of a managed Claude process: the app's own, minus harness identity, plus terminal capabilities. */
export function scrubEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (HARNESS_EXACT.has(upper) || HARNESS_PREFIXES.some((p) => upper.startsWith(p))) continue;
    if (upper.startsWith('ANTHROPIC_') && !ANTHROPIC_KEEP.has(upper)) continue;
    env[name] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

const SECRET_NAME = /key|token|secret|password|credential/i;
/** argv as it is stored in the database: values of secret-looking options are masked (Mini-Summa passes none today). */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const arg of argv) {
    if (maskNext) { out.push('[REDACTED]'); maskNext = false; continue; }
    const assigned = /^(--?[\w-]+)=/.exec(arg);
    if (assigned && SECRET_NAME.test(assigned[1])) { out.push(`${assigned[1]}=[REDACTED]`); continue; }
    if (/^--?[\w-]+$/.test(arg) && SECRET_NAME.test(arg)) maskNext = true;
    out.push(arg);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Dependencies

/** Test seams. Production leaves them all undefined. */
export interface ManagedOverrides {
  /** Graceful stop: how long Ctrl-C is tried before the process is killed. Default 4000. */
  stopGraceMs?: number;
  /** Pause between the two Ctrl-C of one exit gesture (Claude Code wants them within about a second). Default 150. */
  ctrlCGapMs?: number;
  /** The gesture is repeated this often until the grace period ends (a busy Claude needs one press to interrupt). Default 1500. */
  ctrlCRepeatMs?: number;
  /** After SIGTERM, wait this long before SIGKILL. Default 1000. */
  termWaitMs?: number;
  /** After the last signal, wait this long for the exit to be reported. Default 2000. */
  killWaitMs?: number;
  /** At app exit, how long sessions get to leave on their own before they are killed. Default 1500. */
  shutdownGraceMs?: number;
  /** lastOutputAt is written to the database at most this often per session. Default 1000. */
  outputThrottleMs?: number;
  /** Delay before the Enter that submits typed text. Default SUBMIT_DELAY_MS. */
  submitDelayMs?: number;
  /** Scrollback size in characters. Default 2,000,000. */
  scrollbackChars?: number;
  /** How many exited terminals keep their scrollback in memory. Default 8. */
  maxRetainedExited?: number;
  platform?: NodeJS.Platform;
  /** The environment copied into sessions (default process.env). */
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ManagedManagerDeps {
  base: CoreBase;
  environments: EnvironmentsService;
  spawner?: PtySpawner;
  appRunId?: string;
  overrides?: ManagedOverrides & NonNullable<CoreOptions['overrides']>;
  newSessionId?: () => string;
}

/** What the real manager offers on top of the ManagedManager contract. The sessions layer calls it when it exists. */
export interface ManagedManagerExtras {
  /**
   * A prompt of this session reached Claude (its UserPromptSubmit hook was ingested), so whatever was on the input line has
   * been submitted. `receivedAt` is when the hook ran: text typed AFTER that moment belongs to a newer line and is kept.
   */
  promptSubmitted(key: SessionKey, receivedAt?: string): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

interface Row {
  session_key: string; env: string; session_id: string; project_id: string | null; root_id: string | null; cwd: string;
  name: string | null; mode: 'new' | 'resume'; resumed_from: string | null; remote_control: number;
  status: ManagedSessionRecord['status']; pid: number | null; started_at: string; exited_at: string | null;
  exit_code: number | null; exit_signal: number | null; exit_reason: string | null; cols: number; rows: number;
  prompted: number; last_output_at: string | null; app_run_id: string; conversation_id: string | null;
}

const SELECT = `SELECT m.*, b.conversation_id AS conversation_id
  FROM managed_sessions m LEFT JOIN session_bindings b ON b.session_key = m.session_key`;

function toRecord(r: Row): ManagedSessionRecord {
  return {
    key: r.session_key as SessionKey,
    env: r.env as EnvId,
    sessionId: r.session_id,
    projectId: r.project_id,
    rootId: r.root_id,
    cwd: r.cwd,
    name: r.name,
    mode: r.mode,
    resumedFrom: r.resumed_from as SessionKey | null,
    remoteControl: r.remote_control === 1,
    status: r.status,
    pid: r.pid,
    startedAt: r.started_at,
    exitedAt: r.exited_at,
    exitCode: r.exit_code,
    exitSignal: r.exit_signal,
    exitReason: r.exit_reason,
    cols: r.cols,
    rows: r.rows,
    prompted: r.prompted === 1,
    lastOutputAt: r.last_output_at,
    appRunId: r.app_run_id,
    conversationId: r.conversation_id,
  };
}

const sameRecord = (a: ManagedSessionRecord, b: ManagedSessionRecord): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------------------------------------------
// Live state

type EndReason = 'killed_by_user' | 'app_exit';
interface SinkEntry { sink: TerminalSink }
interface ExitInfo { code: number | null; signal: number | null; at: string; reason: string }

interface Live {
  record: ManagedSessionRecord;
  pty: PtyProcess | null;
  scrollback: ScrollbackBuffer;
  sinks: Set<SinkEntry>;
  /** Why Mini-Summa ended the process, if it did. Anything else that ends it is plain 'exited'. */
  endReason: EndReason | null;
  exit: ExitInfo | null;
  exitWaiters: (() => void)[];
  /** Newest output time, not yet written to the database. */
  pendingOutputAt: string | null;
  outputTimer: NodeJS.Timeout | null;
  /** typeText / sendKeys run one at a time so two of them can never interleave their bytes. */
  input: Promise<unknown>;
  stopping: { force: boolean; done: Promise<void> } | null;
  /** What the desktop terminal's input line may hold (see inputTracking.ts). A new PTY always starts empty. */
  line: InputLine;
  /** When (core clock, ms) the latest text was typed at the desktop terminal; 0 = never. */
  typedAtMs: number;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

// Characters that can split or re-quote an argument once a command line is assembled on Windows (node-pty joins the arguments
// into one string, and the program then parses it again): the double quote and the backslash, the typographic quotes
// U+2018..U+201F (some Windows code pages convert them to a plain quote when a program reads its command line as ANSI text),
// and the full-width quote, apostrophe and backslash U+FF02 / U+FF07 / U+FF3C that convert the same way.
const NAME_QUOTE_CHARS = /["\\‘-‟＂＇＼]/g;

/**
 * Session names become command-line arguments (`--name <name>`, `--remote-control <name>`). Control characters are replaced by
 * spaces. Double quotes, backslashes and typographic quotes are removed (not escaped: no escaping is reliable across the
 * programs a command line passes through), so "Bob’s \"fix\"" becomes "Bobs fix". A name that starts with a dash is refused:
 * as the optional value of `--remote-control` it would be read as the next option (for example
 * `--dangerously-skip-permissions`).
 */
export function normalizeSessionName(raw: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const name = (raw ?? '').replace(NAME_QUOTE_CHARS, '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
  if (name === '') return null;
  if (name.startsWith('-')) throw new CoreError(400, 'bad_request', 'A session name cannot start with a dash. Choose another name.');
  return name;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function installHelp(env: EnvId): string {
  if (isWslEnv(env)) return 'Inside that distribution run: curl -fsSL https://claude.ai/install.sh | bash';
  if (env === 'win') return 'On Windows run: winget install Anthropic.ClaudeCode (or irm https://claude.ai/install.ps1 | iex).';
  return 'Install it with: curl -fsSL https://claude.ai/install.sh | bash';
}

// ---------------------------------------------------------------------------------------------------------------

export function createManagedManager(deps: ManagedManagerDeps): ManagedManager & ManagedManagerExtras {
  const { base, environments } = deps;
  const { db, log, clock } = base;
  const spawner = deps.spawner ?? createNodePtySpawner();
  const appRunId = deps.appRunId ?? newId('run');
  const newSessionId = deps.newSessionId ?? randomUUID;
  const o = deps.overrides ?? {};
  const stopGraceMs = o.stopGraceMs ?? 4000;
  const ctrlCGapMs = o.ctrlCGapMs ?? 150;
  const ctrlCRepeatMs = o.ctrlCRepeatMs ?? 1500;
  const termWaitMs = o.termWaitMs ?? 1000;
  const killWaitMs = o.killWaitMs ?? 2000;
  const shutdownGraceMs = o.shutdownGraceMs ?? 1500;
  const outputThrottleMs = o.outputThrottleMs ?? 1000;
  const submitDelayMs = o.submitDelayMs ?? SUBMIT_DELAY_MS;
  const maxRetainedExited = o.maxRetainedExited ?? 8;
  const platform = o.platform ?? process.platform;

  const lives = new Map<SessionKey, Live>();
  const exitedOrder: SessionKey[] = [];
  const listeners = new Set<(record: ManagedSessionRecord, previous: ManagedSessionRecord | null) => void>();
  let shutDown = false;

  // --- reading and writing records

  const selectOne = (key: SessionKey): ManagedSessionRecord | null => {
    const row = db.get<Row>(`${SELECT} WHERE m.session_key = ?`, [key]);
    return row ? toRecord(row) : null;
  };

  const view = (live: Live): ManagedSessionRecord =>
    live.pendingOutputAt ? { ...live.record, lastOutputAt: live.pendingOutputAt } : { ...live.record };

  const emit = (record: ManagedSessionRecord, previous: ManagedSessionRecord | null): void => {
    for (const fn of [...listeners]) {
      try { fn({ ...record }, previous ? { ...previous } : null); } catch (err) { log.error('managed onChange listener failed', { error: String(err) }); }
    }
  };

  const writeMutable = (r: ManagedSessionRecord): void => {
    db.run(
      `UPDATE managed_sessions SET name = ?, status = ?, pid = ?, exited_at = ?, exit_code = ?, exit_signal = ?, exit_reason = ?,
         cols = ?, rows = ?, prompted = ?, last_output_at = ? WHERE session_key = ?`,
      [r.name, r.status, r.pid, r.exitedAt, r.exitCode, r.exitSignal, r.exitReason, r.cols, r.rows, r.prompted ? 1 : 0, r.lastOutputAt, r.key],
    );
  };

  /** Applies a change to a live record, writes it and tells the listeners. Never throws: a full disk must not kill a PTY pump. */
  const commit = (live: Live, patch: Partial<ManagedSessionRecord>): void => {
    const previous = live.record;
    const merged: Partial<ManagedSessionRecord> = live.pendingOutputAt ? { lastOutputAt: live.pendingOutputAt, ...patch } : patch;
    live.pendingOutputAt = null;
    const next = { ...previous, ...merged };
    if (sameRecord(previous, next)) return;
    live.record = next;
    try { writeMutable(next); } catch (err) { log.error('managed session could not be saved', { key: next.key, error: String(err) }); }
    emit(next, previous);
  };

  /** Same for a record that has no live PTY in this run (an earlier run's session). */
  const commitStored = (key: SessionKey, patch: Partial<ManagedSessionRecord>): ManagedSessionRecord | null => {
    const previous = selectOne(key);
    if (!previous) return null;
    const next = { ...previous, ...patch };
    if (sameRecord(previous, next)) return previous;
    writeMutable(next);
    emit(next, previous);
    return next;
  };

  const forget = (key: SessionKey): void => {
    const at = exitedOrder.indexOf(key);
    if (at >= 0) exitedOrder.splice(at, 1);
  };

  // --- terminal plumbing

  /** Exited terminals keep their scrollback for a while; the oldest are released so memory stays bounded. */
  const retire = (live: Live): void => {
    exitedOrder.push(live.record.key);
    while (exitedOrder.length > maxRetainedExited) {
      const oldest = exitedOrder.shift();
      if (oldest && lives.get(oldest)?.pty === null) lives.delete(oldest);
    }
  };

  const safeSink = (live: Live, entry: SinkEntry, fn: (sink: TerminalSink) => void): void => {
    try { fn(entry.sink); } catch (err) {
      live.sinks.delete(entry);
      log.warn('terminal sink failed and was detached', { key: live.record.key, error: String(err) });
    }
  };

  const handleData = (live: Live, data: string): void => {
    const seq = live.scrollback.append(data);
    live.pendingOutputAt = nowIso(clock);
    if (!live.outputTimer) {
      live.outputTimer = setTimeout(() => { live.outputTimer = null; commit(live, {}); }, outputThrottleMs);
      live.outputTimer.unref?.();
    }
    for (const entry of [...live.sinks]) safeSink(live, entry, (sink) => sink.data(seq, data));
  };

  const handleExit = (live: Live, info: { exitCode: number | null; signal: number | null }): void => {
    if (live.pty === null && live.exit !== null) return;
    if (live.outputTimer) { clearTimeout(live.outputTimer); live.outputTimer = null; }
    const at = nowIso(clock);
    const reason = live.endReason ?? 'exited';
    const exit: ExitInfo = { code: info.exitCode, signal: info.signal, at, reason };
    // Set before the listeners hear about it: one that attaches a terminal from inside onChange must still be told.
    live.pty = null;
    live.exit = exit;
    commit(live, { status: 'exited', pid: null, exitedAt: at, exitCode: info.exitCode, exitSignal: info.signal, exitReason: reason });
    for (const entry of [...live.sinks]) safeSink(live, entry, (sink) => sink.exit(exit));
    live.sinks.clear();
    for (const wake of live.exitWaiters.splice(0)) wake();
    log.info('managed session ended', { key: live.record.key, reason, code: info.exitCode, signal: info.signal });
    retire(live);
  };

  const safeWrite = (live: Live, data: string): boolean => {
    if (!live.pty) return false;
    try { live.pty.write(data); return true; } catch (err) {
      log.warn('write to managed terminal failed', { key: live.record.key, error: String(err) });
      return false;
    }
  };

  const safeKill = (live: Live, signal: string): void => {
    try { live.pty?.kill(signal); } catch (err) { log.warn('kill of managed terminal failed', { key: live.record.key, signal, error: String(err) }); }
  };

  const waitForExit = (live: Live): Promise<void> =>
    new Promise((resolve) => { if (!live.pty) resolve(); else live.exitWaiters.push(resolve); });

  /** true when the process ended within `ms`. */
  const exitedWithin = async (live: Live, ms: number): Promise<boolean> => {
    if (!live.pty) return true;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      waitForExit(live).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
    clearTimeout(timer);
    return result;
  };

  const enqueueInput = <T>(live: Live, job: () => Promise<T>): Promise<T> => {
    const run = live.input.catch(() => undefined).then(job);
    live.input = run;
    return run;
  };

  /** Claude Code's own exit gesture: Ctrl-C twice, quickly. */
  const exitGesture = async (live: Live): Promise<void> => {
    if (!safeWrite(live, CTRL_C)) return;
    await sleep(ctrlCGapMs);
    safeWrite(live, CTRL_C);
  };

  /** Graceful for `grace` ms (repeating the gesture), then SIGTERM, then SIGKILL. */
  const endProcess = async (live: Live, graceMs: number, reasonIfKilled: EndReason): Promise<void> => {
    if (!live.pty) return;
    if (graceMs > 0) {
      void exitGesture(live);
      const repeat = setInterval(() => { if (live.pty) void exitGesture(live); }, ctrlCRepeatMs);
      const left = await exitedWithin(live, graceMs);
      clearInterval(repeat);
      if (left) return;
    }
    if (!live.pty) return;
    live.endReason ??= reasonIfKilled;
    safeKill(live, 'SIGTERM');
    if (await exitedWithin(live, termWaitMs)) return;
    safeKill(live, 'SIGKILL');
    await exitedWithin(live, killWaitMs);
  };

  // --- ManagedManager

  const init = (): void => {
    const stale = db.all<Row>(`${SELECT} WHERE m.status = 'running' AND m.app_run_id != ?`, [appRunId]).map(toRecord);
    for (const previous of stale) {
      db.run(
        `UPDATE managed_sessions SET status = 'disconnected', pid = NULL, exit_reason = 'app_restart'
           WHERE session_key = ? AND status = 'running' AND app_run_id != ?`,
        [previous.key, appRunId],
      );
      emit({ ...previous, status: 'disconnected', pid: null, exitReason: 'app_restart' }, previous);
    }
    if (stale.length) log.info('managed sessions from an earlier run marked disconnected', { count: stale.length });
  };

  const list = (): ManagedSessionRecord[] =>
    db.all<Row>(`${SELECT} ORDER BY m.started_at DESC, m.session_key`).map((row) => {
      const record = toRecord(row);
      const live = lives.get(record.key);
      return live ? view(live) : record;
    });

  const get = (key: SessionKey): ManagedSessionRecord | null => {
    const live = lives.get(key);
    return live ? view(live) : selectOne(key);
  };

  const validateCwd = (env: EnvId, cwd: string): void => {
    if (typeof cwd !== 'string' || cwd.trim() === '') throw new CoreError(422, 'cwd_invalid', 'Choose the folder the session should work in.');
    if (env === environments.hostEnv()) {
      if (!path.isAbsolute(cwd)) throw new CoreError(422, 'cwd_invalid', `"${cwd}" is not a full folder path.`);
      let isDir = false;
      try { isDir = fs.statSync(cwd).isDirectory(); } catch { /* reported below */ }
      if (!isDir) throw new CoreError(422, 'cwd_not_found', `The folder ${cwd} does not exist (or is not a folder). Choose another project folder or recreate it.`);
    } else if (isWslEnv(env) && !cwd.startsWith('/')) {
      throw new CoreError(422, 'cwd_invalid', `A folder inside ${envLabel(env)} must be a Linux path such as /home/me/app, not "${cwd}".`);
    }
  };

  const start = async (input: ManagedStartInput): Promise<ManagedSessionRecord> => {
    if (shutDown) throw new CoreError(503, 'shutting_down', 'Mini-Summa is closing; no new sessions can be started.');
    const { env } = input;
    const resumeId = input.mode === 'resume' ? input.resumeSessionId : undefined;
    if (input.mode === 'resume' && !(resumeId && UUID_RE.test(resumeId))) {
      throw new CoreError(400, 'bad_request', 'Resuming needs the id of the session to resume.');
    }
    validateCwd(env, input.cwd);

    const claude: ClaudeCommand | null = await environments.claudeCommand(env);
    if (!claude) {
      throw new CoreError(422, 'claude_not_found',
        `Claude Code was not found in ${envLabel(env)}. ${installHelp(env)} Then start the session again, or set the Claude command in Settings.`);
    }
    // node-pty forks first on Linux/macOS, so a missing program does not make spawn() throw: it shows up as an immediate
    // exit with an exec error in the terminal. A resolved path that no longer exists is caught here, before any record exists.
    if (!claude.wslDistro && path.isAbsolute(claude.file) && !fs.existsSync(claude.file)) {
      throw new CoreError(422, 'claude_not_found',
        `Claude Code was expected at ${claude.file} but is not there any more. ${installHelp(env)} Then start the session again.`);
    }
    const layout = await environments.layout(env);
    if (shutDown) throw new CoreError(503, 'shutting_down', 'Mini-Summa is closing; no new sessions can be started.');

    const sessionId = (resumeId ?? newSessionId()).toLowerCase();
    if (!UUID_RE.test(sessionId)) throw new CoreError(500, 'bad_session_id', 'Could not create a session id.');
    const key = makeSessionKey(env, sessionId);
    const resumedFrom = input.mode === 'resume' ? key : null;
    const name = normalizeSessionName(input.name);
    const cols = clampInt(input.cols, 120, 20, 500);
    const rows = clampInt(input.rows, 32, 5, 200);

    // Everything from here to the spawn is synchronous: two starts of one session cannot both pass the check below.
    if (lives.get(key)?.pty) throw new CoreError(409, 'session_running', 'That session is already running in a Mini-Summa terminal.');
    const before = input.mode === 'resume' ? selectOne(key) : null;   // what listeners saw until now, for the change event

    const settings = writeManagedSettings({ layout, sessionId, dataDir: base.dataDir });
    const claudeArgs = buildClaudeArgs({ mode: input.mode, sessionId, settingsPath: settings.envPath, name, remoteControl: input.remoteControl });
    const hostVariables = o.baseEnv ?? process.env;
    const plan = buildLaunchPlan({
      claude, claudeArgs, cwd: input.cwd, hostCwd: base.dataDir, platform,
      // never a bare name: the process-start code would look for wsl.exe / cmd.exe in the current directory first
      ...(platform === 'win32' ? { comspec: systemProgramPath('cmd.exe', hostVariables), wslExe: systemProgramPath('wsl.exe', hostVariables) } : {}),
    });
    const spawnEnv = scrubEnvironment(hostVariables);
    const startedAt = nowIso(clock);
    const argvJson = JSON.stringify(redactArgv([plan.file, ...(typeof plan.args === 'string' ? [plan.args] : plan.args)]));

    try {
      db.tx(() => {
        const params: SqlValue[] = [
          key, env, sessionId, input.projectId, input.rootId, input.cwd, name, input.mode, resumedFrom, input.remoteControl ? 1 : 0,
          startedAt, cols, rows, input.mode === 'resume' ? 1 : 0, appRunId, argvJson,
        ];
        const columns = `session_key, env, session_id, project_id, root_id, cwd, name, mode, resumed_from, remote_control, status, pid,
          started_at, exited_at, exit_code, exit_signal, exit_reason, cols, rows, prompted, last_output_at, app_run_id, argv_json`;
        const values = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?`;
        if (input.mode === 'resume') {
          // Same id, same key: the earlier record is the history of this session and is reused.
          db.run(
            `INSERT INTO managed_sessions (${columns}) VALUES (${values})
             ON CONFLICT(session_key) DO UPDATE SET project_id = excluded.project_id, root_id = excluded.root_id, cwd = excluded.cwd,
               name = COALESCE(excluded.name, managed_sessions.name), mode = 'resume', resumed_from = excluded.resumed_from,
               remote_control = excluded.remote_control, status = 'running', pid = NULL, started_at = excluded.started_at,
               exited_at = NULL, exit_code = NULL, exit_signal = NULL, exit_reason = NULL, cols = excluded.cols, rows = excluded.rows,
               prompted = 1, last_output_at = NULL, app_run_id = excluded.app_run_id, argv_json = excluded.argv_json`,
            params,
          );
        } else {
          db.run(`INSERT INTO managed_sessions (${columns}) VALUES (${values})`, params);
        }
        db.run(
          `INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at)
             VALUES (?, ?, ?, 'managed', ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET project_id = excluded.project_id,
             conversation_id = COALESCE(excluded.conversation_id, session_bindings.conversation_id), source = 'managed',
             updated_at = excluded.updated_at`,
          [key, input.projectId, input.conversationId, startedAt, startedAt],
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed: managed_sessions/i.test(message)) throw new CoreError(409, 'session_exists', 'A session with that id already exists.');
      if (/FOREIGN KEY/i.test(message)) throw new CoreError(422, 'invalid_binding', 'The project or conversation for this session no longer exists.');
      throw err;
    }

    const stored = selectOne(key)!;
    forget(key);
    const live: Live = {
      record: stored,
      pty: null,
      scrollback: new ScrollbackBuffer(o.scrollbackChars),
      sinks: new Set(),
      endReason: null,
      exit: null,
      exitWaiters: [],
      pendingOutputAt: null,
      outputTimer: null,
      input: Promise.resolve(),
      stopping: null,
      line: emptyInputLine(),
      typedAtMs: 0,
    };
    lives.set(key, live);
    emit(stored, before);

    let pty: PtyProcess;
    try {
      pty = spawner.spawn({ file: plan.file, args: plan.args, cwd: plan.cwd, env: spawnEnv, cols, rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      live.exit = { code: null, signal: null, at: nowIso(clock), reason: 'spawn_failed' };
      commit(live, { status: 'exited', exitedAt: live.exit.at, exitReason: 'spawn_failed' });
      retire(live);
      log.error('managed session could not be spawned', { key, error: message });
      throw new CoreError(500, 'spawn_failed', `Claude could not be started in a terminal: ${message}`, { key });
    }
    live.pty = pty;
    pty.onData((data) => handleData(live, data));
    pty.onExit((info) => handleExit(live, info));
    commit(live, { pid: pty.pid });
    log.info('managed session started', { key, env, pid: pty.pid, mode: input.mode });
    return view(live);
  };

  const stop = async (key: SessionKey, opts: { force?: boolean }): Promise<ManagedSessionRecord> => {
    const live = lives.get(key);
    if (!live || !live.pty) {
      const record = get(key);
      if (!record) throw new CoreError(404, 'not_found', 'That session was not found.');
      return record;
    }
    const force = opts.force === true;
    if (!live.stopping) {
      live.stopping = { force, done: endProcess(live, force ? 0 : stopGraceMs, 'killed_by_user').finally(() => { live.stopping = null; }) };
    } else if (force && !live.stopping.force) {
      // A graceful stop is already waiting; the user now wants it dead.
      live.stopping.force = true;
      live.endReason ??= 'killed_by_user';
      void endProcess(live, 0, 'killed_by_user');
    }
    await live.stopping?.done;
    return view(live);
  };

  const write = (key: SessionKey, data: string): boolean => {
    const live = lives.get(key);
    if (!live?.pty) return false;
    const written = safeWrite(live, data);
    if (written) {
      // Only what reached the terminal can be on its input line.
      const scanned = scanDesktopInput(live.line, data);
      live.line = scanned.line;
      if (scanned.typed) live.typedAtMs = clock.now().getTime();
    }
    return written;
  };

  const hasUnsentInput = (key: SessionKey): boolean => {
    const live = lives.get(key);
    return Boolean(live?.pty && live.line.unsent);
  };

  const promptSubmitted = (key: SessionKey, receivedAt?: string): void => {
    const live = lives.get(key);
    if (!live?.pty || !live.line.unsent) return;
    const submittedAt = receivedAt === undefined ? Number.NaN : Date.parse(receivedAt);
    // Text typed after that prompt was submitted is a newer line, still waiting for its Enter.
    if (Number.isFinite(submittedAt) && live.typedAtMs > submittedAt) return;
    live.line = emptyInputLine();
  };

  const typeText = async (key: SessionKey, text: string, opts: { submit: boolean }): Promise<boolean> => {
    const live = lives.get(key);
    if (!live?.pty) return false;
    return enqueueInput(live, async () => {
      for (const step of encodeUserText(text, { submit: opts.submit, submitDelayMs })) {
        if (step.delayMs > 0) await sleep(step.delayMs);
        if (!safeWrite(live, step.data)) return false;
      }
      return true;
    });
  };

  const sendKeys = async (key: SessionKey, keys: 'approve' | 'reject'): Promise<boolean> => {
    const live = lives.get(key);
    if (!live?.pty) return false;
    return enqueueInput(live, async () => safeWrite(live, PERMISSION_KEYS[keys]));
  };

  const resize = (key: SessionKey, cols: number, rows: number): void => {
    const live = lives.get(key);
    if (!live?.pty) return;
    const c = clampInt(cols, live.record.cols, 20, 500);
    const r = clampInt(rows, live.record.rows, 5, 200);
    if (c === live.record.cols && r === live.record.rows) return;
    try { live.pty.resize(c, r); } catch (err) {
      log.warn('resize of managed terminal failed', { key, error: String(err) });
      return;
    }
    commit(live, { cols: c, rows: r });
  };

  const attach = (key: SessionKey, size: { cols: number; rows: number }, sink: TerminalSink): TerminalAttachment | { error: string } => {
    const live = lives.get(key);
    if (!live) {
      // Not started in this run (or released): there is no scrollback to replay, and the PTY is gone.
      const record = selectOne(key);
      if (!record) return { error: 'That terminal does not exist.' };
      const exit: ExitInfo = {
        code: record.exitCode, signal: record.exitSignal, at: record.exitedAt ?? record.lastOutputAt ?? record.startedAt,
        reason: record.exitReason ?? 'app_restart',
      };
      queueMicrotask(() => { try { sink.exit(exit); } catch { /* the sink is gone */ } });
      return { replay: '', seq: 0, cols: record.cols, rows: record.rows, detach: () => undefined };
    }
    if (live.pty) resize(key, size.cols, size.rows);
    const snapshot = live.scrollback.snapshot();
    const entry: SinkEntry = { sink };
    if (live.pty) live.sinks.add(entry);
    else if (live.exit) {
      const exit = live.exit;
      queueMicrotask(() => { try { sink.exit(exit); } catch { /* the sink is gone */ } });
    }
    return {
      replay: snapshot.data,
      seq: snapshot.seq,
      cols: live.record.cols,
      rows: live.record.rows,
      detach: () => { live.sinks.delete(entry); },
    };
  };

  const markPrompted = (key: SessionKey): void => {
    const live = lives.get(key);
    if (live) commit(live, { prompted: true });
    else commitStored(key, { prompted: true });
  };

  const onChange = (fn: (record: ManagedSessionRecord, previous: ManagedSessionRecord | null) => void): (() => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  };

  const shutdown = async (): Promise<void> => {
    shutDown = true;
    const running = [...lives.values()].filter((l) => l.pty);
    for (const live of running) live.endReason ??= 'app_exit';
    await Promise.all(running.map((live) => endProcess(live, shutdownGraceMs, 'app_exit')));
    for (const live of running) {
      // A process that would not confirm its exit is still recorded: the app is leaving, and its terminal goes with it.
      if (live.pty) handleExit(live, { exitCode: null, signal: null });
    }
    for (const live of lives.values()) {
      if (live.outputTimer) { clearTimeout(live.outputTimer); live.outputTimer = null; }
      commit(live, {});
    }
  };

  return { init, list, get, start, stop, write, hasUnsentInput, promptSubmitted, typeText, sendKeys, resize, attach, markPrompted, onChange, shutdown };
}
