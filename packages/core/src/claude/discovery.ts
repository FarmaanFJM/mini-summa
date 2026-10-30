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
import { takeSnapshot } from '@minisumma/claude-integration';
import type { RawStoreLike, RunAgentsJsonOptions } from '@minisumma/claude-integration';
import { isWslEnv } from '@minisumma/shared';
import type { DiscoveryRefreshResult, EnvId } from '@minisumma/shared';
import type { Clock, EnvironmentsService, Logger } from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { CoreError } from '../errors.ts';
import type { SerialQueue } from './serialQueue.ts';

export type AgentsRunner = (opts: RunAgentsJsonOptions) => Promise<{ raw: unknown }>;

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

const binOf = (cmd: { file: string; prefixArgs: string[] }): string => (cmd.prefixArgs.length > 0 ? cmd.prefixArgs[cmd.prefixArgs.length - 1] : cmd.file);

function plainError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0].trim();
  return `Claude Code could not list its sessions: ${text.slice(0, 300)}`;
}

export function createDiscovery(deps: DiscoveryDeps): Discovery {
  const { queue, environments, clock, log } = deps;
  const env = deps.env ?? process.env;
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
        runOpts.bin = binOf(command);
        if (env.CLAUDE_CONFIG_DIR) runOpts.configDir = env.CLAUDE_CONFIG_DIR;
      }
      await takeSnapshot({
        store: deps.rawStore,
        spools: [layout.spoolDirHost],
        envId: id,
        run: deps.run,
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
