// TailscaleService: remote access through `tailscale serve`, driven only by the Tailscale command line.
//
// * Binary: overrides.tailscaleBin when given (and then only that), else `tailscale` on PATH, else the Windows
//   install location. A missing binary is "not installed", never an exception.
// * Funnel is never enabled and `tailscale funnel` is never run. If Funnel is on, status() says so with the command
//   that turns it off, and setServe(true) refuses until it is off.
// * Mini-Summa only changes what it published itself: it will not replace a Serve entry that points somewhere else, and
//   it will not switch off an entry that is not its own port.
// * Every failure becomes a `problem` in the returned status (what is wrong and what to do). setServe does not throw
//   for Tailscale-side trouble; the caller shows `problem` and the unchanged `serve` state.
// * While settings.mobile.remoteAccess is 'tailscale' the status is re-read every 30 s, and `tailscale.changed` is
//   emitted only when something other than the check time differs.
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TailscaleStatus } from '@minisumma/shared';
import type { CoreBase, CoreOptions, SettingsService, TailscaleService } from '../contracts.ts';
import {
  HTTPS_PORT, describeServeFailure, emptyStatus, looksNotRunning, matchServe, parseBackend, parseServe, problemForBackend,
  problems, statusKey, tryParseJson,
} from './tailscale-parse.ts';

export interface TailscaleDeps {
  base: Pick<CoreBase, 'bus' | 'clock' | 'log'>;
  settings: Pick<SettingsService, 'get' | 'onChange'>;
  /** Port of the local HTTP server. Read at each use because the server may pick it when it starts. */
  getPort(): number;
  overrides?: Pick<NonNullable<CoreOptions['overrides']>, 'tailscaleBin'>;
  /** Default 30 000. */
  pollIntervalMs?: number;
  /** Longest a single tailscale command may run. Default 15 000. */
  commandTimeoutMs?: number;
  /** status() without refresh answers from the last check when it is younger than this. Default 5 000. */
  statusTtlMs?: number;
}

/** The service plus what neighbours may want that the contract does not carry. */
export interface TailscaleServiceImpl extends TailscaleService {
  /** The last computed status, without running anything. null before the first check. */
  cachedStatus(): TailscaleStatus | null;
}

const WINDOWS_INSTALL = 'C:\\Program Files\\Tailscale\\tailscale.exe';

interface CliResult {
  /** false = no candidate binary exists (ENOENT everywhere). */
  found: boolean;
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Error code such as EACCES when the program could not be started for another reason. */
  errno: string | null;
}

const flat = (text: string, max = 220): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
};

export function createTailscaleService(deps: TailscaleDeps): TailscaleServiceImpl {
  const { bus, clock, log } = deps.base;
  const pollMs = deps.pollIntervalMs ?? 30_000;
  const timeoutMs = deps.commandTimeoutMs ?? 15_000;
  const ttlMs = deps.statusTtlMs ?? 5_000;
  const nowIso = (): string => clock.now().toISOString();
  const nowMs = (): number => clock.now().getTime();

  let last: TailscaleStatus | null = null;
  let lastAtMs = 0;
  let lastKey = '';
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let workingBin: string | null = null;
  /** What occupies the HTTPS port when it is not Mini-Summa; set by each probe. */
  let foreignServe: string | null = null;
  let inflight: Promise<TailscaleStatus> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const children = new Set<ChildProcess>();

  // -------------------------------------------------------------------------------------------------------------
  // Running the CLI

  const candidates = (): string[] => {
    const override = deps.overrides?.tailscaleBin;
    return override ? [override] : ['tailscale', WINDOWS_INSTALL];
  };

  function execOnce(bin: string, args: string[]): Promise<Omit<CliResult, 'found'> & { missing: boolean }> {
    return new Promise((resolve) => {
      const child = execFile(
        bin, args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          children.delete(child);
          if (!error) { resolve({ ok: true, stdout, stderr, timedOut: false, errno: null, missing: false }); return; }
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          resolve({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            timedOut: e.killed === true && e.signal === 'SIGTERM',
            errno: typeof e.code === 'string' ? e.code : null,
            missing: e.code === 'ENOENT',
          });
        },
      );
      children.add(child);
      child.stdin?.end();
    });
  }

  async function runCli(args: string[]): Promise<CliResult> {
    // A check that was running when the service shut down must not start another program.
    if (closed) return { found: true, ok: false, stdout: '', stderr: '', timedOut: false, errno: 'ECANCELED' };
    const order = [...new Set([...(workingBin ? [workingBin] : []), ...candidates()])];
    for (const bin of order) {
      const r = await execOnce(bin, args);
      if (r.missing) { if (bin === workingBin) workingBin = null; continue; }
      workingBin = bin;
      return { found: true, ok: r.ok, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, errno: r.errno };
    }
    return { found: false, ok: false, stdout: '', stderr: '', timedOut: false, errno: 'ENOENT' };
  }

  /** One CLI operation at a time: a poll must not interleave with a serve change. */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reading the state

  async function probe(): Promise<TailscaleStatus> {
    const out = emptyStatus(nowIso());
    foreignServe = null;
    const res = await runCli(['status', '--json']);
    if (!res.found) return { ...out, problem: problems.notInstalled() };
    out.installed = true;

    const backend = parseBackend(tryParseJson(res.stdout));
    if (!backend) {
      const said = `${res.stderr}\n${res.stdout}`;
      if (res.timedOut) out.problem = problems.timedOut('tailscale status');
      else if (looksNotRunning(said)) out.problem = problems.notRunning();
      else if (res.errno) out.problem = `Mini-Summa could not start Tailscale (${res.errno}). Reinstall Tailscale or check that its program file can be run, then refresh.`;
      else if (!res.ok) out.problem = `Tailscale reported an error: ${flat(said)}. Run "tailscale status" in a terminal to see what is wrong, then refresh.`;
      else out.problem = problems.unreadable();
      return out;
    }

    out.backendState = backend.backendState;
    out.hostName = backend.hostName;
    out.dnsName = backend.dnsName;
    out.tailnet = backend.tailnet;
    out.tailscaleIps = backend.tailscaleIps;
    out.running = backend.backendState === 'Running';
    out.loggedIn = backend.backendState !== 'NeedsLogin' && backend.backendState !== 'NoState';
    if (!out.running) { out.problem = problemForBackend(backend.backendState); return out; }

    const serveRes = await runCli(['serve', 'status', '--json']);
    let serveProblem: string | null = null;
    if (serveRes.timedOut) serveProblem = problems.timedOut('tailscale serve status');
    else if (!serveRes.ok) serveProblem = looksNotRunning(`${serveRes.stderr}\n${serveRes.stdout}`) ? problems.notRunning() : problems.serveUnreadable(flat(serveRes.stderr || serveRes.stdout, 120));
    else {
      const text = serveRes.stdout.trim();
      const noConfig = text === '' || /no serve config/i.test(text);
      const json = noConfig ? {} : tryParseJson(text);
      if (json === null) serveProblem = problems.serveUnreadable('unexpected output');
      else {
        const match = matchServe(parseServe(json), deps.getPort(), backend.dnsName);
        foreignServe = match.foreignTarget;
        out.serve = { configured: match.configured, url: match.url, target: match.target, funnelDetected: match.funnel.length > 0 };
        if (match.funnel.length > 0) out.problem = problems.funnel(match.funnel);
        else if (backend.dnsName === null) out.problem = problems.noDnsName();
        else if (backend.httpsCertificates === 'not_enabled') out.problem = problems.httpsNotEnabled();
        else if (match.foreignTarget !== null) out.problem = problems.foreignServe(match.foreignTarget);
        return out;
      }
    }
    // Serve could not be read: keep the connection facts, report why the rest is unknown.
    out.problem = serveProblem;
    return out;
  }

  /** Records `s` as the latest status and announces it if anything but the check time changed. */
  function commit(s: TailscaleStatus): TailscaleStatus {
    last = s;
    lastAtMs = nowMs();
    const key = statusKey(s);
    if (key !== lastKey) {
      lastKey = key;
      if (!closed) bus.emit({ type: 'tailscale.changed', status: structuredClone(s) });
    }
    return structuredClone(s);
  }

  async function compute(): Promise<TailscaleStatus> {
    try {
      return commit(await probe());
    } catch (err) {
      log.warn('Checking Tailscale failed unexpectedly.', { error: err instanceof Error ? err.message : String(err) });
      return commit({
        ...emptyStatus(nowIso()),
        installed: true,
        problem: `Mini-Summa could not check Tailscale (${err instanceof Error ? flat(err.message, 120) : 'unknown error'}). Refresh to try again.`,
      });
    }
  }

  /** What a stopped service answers: the last known state if there is one, with the reason it is not being checked. */
  function stoppedStatus(): TailscaleStatus {
    const base = last !== null ? structuredClone(last) : { ...emptyStatus(nowIso()), installed: true };
    return { ...base, problem: 'Mini-Summa is shutting down, so Tailscale was not checked.' };
  }

  function status(opts?: { refresh?: boolean }): Promise<TailscaleStatus> {
    if (closed) return Promise.resolve(stoppedStatus());
    if (!opts?.refresh && last !== null && nowMs() - lastAtMs < ttlMs) return Promise.resolve(structuredClone(last));
    inflight ??= exclusive(compute).finally(() => { inflight = null; });
    return inflight.then((s) => structuredClone(s));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Changing Serve

  async function enable(): Promise<TailscaleStatus> {
    const before = await compute();
    // Nothing to attempt, or a reason not to. `problem` already says which.
    if (!before.installed || !before.running || !before.loggedIn) return before;
    if (before.serve.funnelDetected) return before;
    if (before.serve.configured) return before;
    // Never replace somebody else's Serve entry. The status already says what is there and how to remove it.
    if (foreignServe !== null) return before;

    const port = deps.getPort();
    const run = await runCli(['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`]);
    if (!run.ok) {
      const output = `${run.stderr}\n${run.stdout}`;
      // A timeout usually means Tailscale is waiting for a tailnet admin to enable Serve and printed where before it
      // blocked, so the partial output is read first.
      const problem = run.errno
        ? `Mini-Summa could not start Tailscale (${run.errno}). Reinstall Tailscale or check that its program file can be run, then try again.`
        : run.timedOut && output.trim() === '' ? problems.timedOut(`tailscale serve --bg --https=${HTTPS_PORT}`) : describeServeFailure(output, 'enable');
      const after = await compute();
      return commit({ ...after, problem });
    }
    const after = await compute();
    if (!after.serve.configured && after.problem === null) return commit({ ...after, problem: problems.serveNotShown() });
    return after;
  }

  async function disable(): Promise<TailscaleStatus> {
    const before = await compute();
    if (!before.installed || !before.running) return before;
    // Only switch off what is Mini-Summa's own. Anything else on the HTTPS port belongs to somebody else.
    if (!before.serve.configured) return before;

    const run = await runCli(['serve', `--https=${HTTPS_PORT}`, 'off']);
    if (!run.ok) {
      const problem = run.timedOut ? problems.timedOut(`tailscale serve --https=${HTTPS_PORT} off`) : describeServeFailure(`${run.stderr}\n${run.stdout}`, 'disable');
      const after = await compute();
      return commit({ ...after, problem });
    }
    const after = await compute();
    if (after.serve.configured) return commit({ ...after, problem: 'Tailscale accepted the command but Mini-Summa is still published. Run "tailscale serve status" in a terminal to see what is configured, then try again.' });
    return after;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Polling

  function syncPolling(): void {
    const want = !closed && deps.settings.get().mobile.remoteAccess === 'tailscale';
    if (want && timer === null) {
      timer = setInterval(() => { void status({ refresh: true }).catch(() => undefined); }, pollMs);
      timer.unref();
      void status({ refresh: true }).catch(() => undefined);
    } else if (!want && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    status,

    setServe(enabled) {
      return closed ? Promise.resolve(stoppedStatus()) : exclusive(enabled ? enable : disable);
    },

    publicUrl() {
      return last !== null && last.serve.configured && last.backendState === 'Running' ? last.serve.url : null;
    },

    cachedStatus: () => (last === null ? null : structuredClone(last)),

    init() {
      if (closed || unsubscribe !== null) return;
      unsubscribe = deps.settings.onChange(() => syncPolling());
      syncPolling();
    },

    shutdown() {
      closed = true;
      if (timer !== null) { clearInterval(timer); timer = null; }
      unsubscribe?.();
      unsubscribe = null;
      for (const c of children) c.kill();
      children.clear();
    },
  };
}
