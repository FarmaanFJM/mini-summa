// Discovery: `claude agents --json` for every environment where Claude Code exists, recorded as an interval snapshot.
//
// Each call is the verified takeSnapshot: hooks that are already in the spool are ingested first, hooks that land while
// the call is in flight are listed as uncertain, and a failed call records a discovery_error and NOTHING else (so a
// failure can never turn into "the sessions are gone"). The call runs on the shared queue, so it never overlaps a spool
// drain; afterwards `apply` applies everything after lastAppliedSeq (the snapshot AND the hooks it drained).
//
// Config directory: CLAUDE_CONFIG_DIR is passed to the call only when it is explicitly set in the core's environment.
// Setting it to the default (~/.claude) is NOT the same as leaving it unset: Claude Code then looks for its global
// state in <dir>/.claude.json instead of ~/.claude.json.
//
// A WSL distribution is asked through wsl.exe started by its FULL path on a Windows host (windowsPrograms.ts): the library's own
// runAgentsJson starts the bare name `wsl.exe`, which the process-start code would look for in the current directory first.
import { execFile } from 'node:child_process';
import { takeSnapshot } from '@minisumma/claude-integration';
import type { RawStoreLike, RunAgentsJsonOptions } from '@minisumma/claude-integration';
import { isWslEnv } from '@minisumma/shared';
import type { DiscoveryRefreshResult, EnvId } from '@minisumma/shared';
import type { Clock, EnvironmentsService, Logger } from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { CoreError } from '../errors.ts';
import type { SerialQueue } from './serialQueue.ts';
import { systemProgramPath } from './windowsPrograms.ts';

export type AgentsRunner = (opts: RunAgentsJsonOptions) => Promise<{ raw: unknown }>;

/** Starts a program and parses its output as JSON (a seam for tests). Rejects with the failure, never with a result. */
export type ExecJson = (file: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<unknown>;

export interface DiscoveryStatus {
  env: EnvId;
  ok: boolean;
  lastRunAt: string | null;
  error: string | null;
}

export interface DiscoveryDeps {
  queue: SerialQueue;
  rawStore: RawStoreLike;
  environments: Pick<EnvironmentsService, 'hostEnv' | 'list' | 'layout' | 'claudeCommand'>;
  /** Replaces `claude agents --json` (tests). */
  run?: AgentsRunner;
  /** Milliseconds between passes. 0 or less = no automatic passes (tests drive them with runNow). */
  intervalMs(): number;
  /** Applies everything after lastAppliedSeq and publishes it. */
  apply(opts: { replay: boolean }): void | Promise<void>;
  /** Runs before each scheduled pass, e.g. to learn about new environments. */
  beforePass?(): Promise<void>;
  clock: Clock;
  log: Pick<Logger, 'debug' | 'warn' | 'error'>;
  /** The core's environment variables (test seam). */
  env?: Record<string, string | undefined>;
  /** The platform the core runs on (test seam). */
  platform?: NodeJS.Platform;
  /** Starts `claude agents --json` through a launcher or wsl.exe (test seam). */
  exec?: ExecJson;
}

export interface Discovery {
  start(): void;
  stop(): void;
  /** Re-reads the interval setting and restarts the timer. */
  reschedule(): void;
  /** One environment (an unavailable one is reported as an error) or every available one. */
  runNow(env?: EnvId): Promise<DiscoveryRefreshResult>;
  status(): DiscoveryStatus[];
}

const LOCAL_TIMEOUT_MS = 20_000;
/** The first call into a stopped WSL distribution has to start it. */
const WSL_TIMEOUT_MS = 30_000;

const execJson: ExecJson = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) { reject(Object.assign(new Error(`${file} ${args.join(' ')} failed: ${err.message}`), { stderr })); return; }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`unparsable output: ${String(stdout).slice(0, 200)}`)); }
  });
});

const agentsArgs = (opts: RunAgentsJsonOptions): string[] => {
  const args = ['agents', '--json'];
  if (opts.all) args.push('--all');
  if (opts.cwd) args.push('--cwd', opts.cwd);
  return args;
};

/**
 * `claude agents --json` through a command that has leading arguments (a launcher script: `node cli.js ...`). The library's
 * runAgentsJson takes only an executable, so this does the same thing for the prefixed form: same arguments, same
 * environment handling, same error shape. A plain executable still goes through the library.
 */
async function runAgentsWithPrefix(cmd: { file: string; prefixArgs: string[] }, opts: RunAgentsJsonOptions, exec: ExecJson): Promise<{ raw: unknown }> {
  const env = { ...process.env };
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
  return { raw: await exec(cmd.file, [...cmd.prefixArgs, ...agentsArgs(opts)], { timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT_MS, env }) };
}

/** How Claude is started inside a distribution: `claude`, or a login shell that runs it (environments.ts decides which). */
export interface WslClaudeCommand { file: string; prefixArgs: string[] }

/**
 * The command line that asks a WSL distribution for its sessions: the same arguments the library builds, started by `wslExe`.
 * It starts Claude the way the terminal will (`command`), so a Claude that only a login shell can find is found here too.
 */
export function wslAgentsInvocation(
  wslExe: string, distro: string, opts: RunAgentsJsonOptions, command: WslClaudeCommand = { file: 'claude', prefixArgs: [] },
): { file: string; args: string[] } {
  return { file: wslExe, args: ['-d', distro, '--exec', command.file, ...command.prefixArgs, ...agentsArgs(opts)] };
}

async function runAgentsInWsl(wslExe: string, distro: string, command: WslClaudeCommand, opts: RunAgentsJsonOptions, exec: ExecJson): Promise<{ raw: unknown }> {
  const { file, args } = wslAgentsInvocation(wslExe, distro, opts, command);
  return { raw: await exec(file, args, { timeoutMs: opts.timeoutMs ?? WSL_TIMEOUT_MS, env: { ...process.env } }) };
}

function plainError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0].trim();
  return `Claude Code could not list its sessions: ${text.slice(0, 300)}`;
}

export function createDiscovery(deps: DiscoveryDeps): Discovery {
  const { queue, environments, clock, log } = deps;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? execJson;
  const statuses = new Map<EnvId, DiscoveryStatus>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;

  const setStatus = (id: EnvId, ok: boolean, error: string | null): void => {
    statuses.set(id, { env: id, ok, lastRunAt: nowIso(clock), error });
  };

  async function runOne(id: EnvId): Promise<{ ok: true } | { ok: false; message: string }> {
    const info = (await environments.list()).find((e) => e.id === id);
    if (!info) {
      const message = 'That environment is not available on this computer.';
      setStatus(id, false, message);
      return { ok: false, message };
    }
    const command = info.available ? await environments.claudeCommand(id) : null;
    if (!info.available || !command) {
      const message = info.notes[0] ?? `Claude Code is not available in ${info.label}.`;
      setStatus(id, false, message);
      return { ok: false, message };
    }
    try {
      const layout = await environments.layout(id);
      const runOpts: RunAgentsJsonOptions = { timeoutMs: command.wslDistro ? WSL_TIMEOUT_MS : LOCAL_TIMEOUT_MS };
      if (command.wslDistro) runOpts.wslDistro = command.wslDistro;
      else {
        runOpts.bin = command.file;
        if (env.CLAUDE_CONFIG_DIR) runOpts.configDir = env.CLAUDE_CONFIG_DIR;
      }
      const prefixed = command.prefixArgs.length > 0 && !command.wslDistro;
      const distro = command.wslDistro;
      // On a Windows host wsl.exe is started by its full path, not by the bare name the library would use.
      const throughWslExe = distro !== null && platform === 'win32';
      let runner: AgentsRunner | undefined = deps.run;
      if (!runner && prefixed) runner = (o) => runAgentsWithPrefix(command, o, exec);
      else if (!runner && throughWslExe) runner = (o) => runAgentsInWsl(systemProgramPath('wsl.exe', env), distro, command, o, exec);
      await takeSnapshot({
        store: deps.rawStore,
        spools: [layout.spoolDirHost],
        envId: id,
        run: runner,
        runOpts,
        // pid liveness can be checked only for processes on this host: not for a WSL distribution seen from Windows
        remote: isWslEnv(id) && environments.hostEnv() === 'win',
      });
      setStatus(id, true, null);
      return { ok: true };
    } catch (err) {
      const message = plainError(err);
      log.warn('Session discovery failed; nothing was inferred from it.', { env: id, error: message });
      setStatus(id, false, message);
      return { ok: false, message };
    } finally {
      // Applies the snapshot (or the discovery_error) and every hook the call drained. Never skipped.
      try { await deps.apply({ replay: false }); } catch (err) { log.error('Applying a discovery result failed.', { env: id, error: err instanceof Error ? err.message : String(err) }); }
    }
  }

  async function runAvailable(): Promise<void> {
    for (const info of await environments.list()) {
      if (!info.available) continue;
      await queue.run(() => runOne(info.id));
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    const interval = deps.intervalMs();
    if (!(interval > 0)) return;
    timer = setTimeout(() => { void tick(); }, delayMs);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    timer = null;
    if (stopped) return;
    try {
      await deps.beforePass?.();
      await runAvailable();
    } catch (err) {
      log.error('A discovery pass failed.', { error: err instanceof Error ? err.message : String(err) });
    }
    schedule(deps.intervalMs());
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    reschedule() {
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = null; }
      schedule(deps.intervalMs());
    },
    async runNow(only) {
      const result: DiscoveryRefreshResult = { ran: [], errors: [] };
      const infos = await environments.list();
      let targets: EnvId[];
      if (only) {
        if (!infos.some((i) => i.id === only)) throw new CoreError(422, 'unknown_environment', `${only} is not an environment on this computer.`);
        targets = [only];
      } else {
        targets = infos.filter((i) => i.available).map((i) => i.id);
      }
      for (const id of targets) {
        const r = await queue.run(() => runOne(id));
        if (r.ok) result.ran.push(id);
        else result.errors.push({ env: id, message: r.message });
      }
      return result;
    },
    status: () => [...statuses.values()].sort((a, b) => a.env.localeCompare(b.env)),
  };
}
