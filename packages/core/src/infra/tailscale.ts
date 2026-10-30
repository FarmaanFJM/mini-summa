// TailscaleService: remote access through `tailscale serve`, driven only by the Tailscale command line.
//
// * Binary: tailscale-bin.ts. overrides.tailscaleBin when given (and then only that), else the Windows install folder,
//   else absolute PATH directories. Never the current directory, never a bare name that the OS could resolve from it.
//   A missing binary is "not installed", never an exception.
// * Funnel is never enabled and `tailscale funnel` is never run. If Funnel is on, status() says so with the command
//   that turns it off, publicUrl() is null, and setServe(true) refuses until it is off.
// * Ownership. Serve is machine-wide state that outlives this app, and a stale entry would forward phone traffic (bearer
//   tokens) to whatever program listens on the old port. So when Mini-Summa creates its entry it records the port in kv
//   ('tailscale.serve'). Only an entry that forwards to that recorded port counts as Mini-Summa's: shutdown() switches it
//   off, init() re-points or removes it, and an entry anyone else made is never replaced or removed.
// * publicUrl() is the Serve URL only while Serve forwards to the port this core really listens on, and never while
//   Funnel is on.
// * Every failure becomes a `problem` in the returned status (what is wrong and what to do). setServe does not throw
//   for Tailscale-side trouble; the caller shows `problem` and the unchanged `serve` state.
// * While settings.mobile.remoteAccess is 'tailscale' the status is re-read every 30 s, and `tailscale.changed` is
//   emitted only when something other than the check time differs.
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { TailscaleStatus } from '@minisumma/shared';
import { fromJson } from '@minisumma/storage';
import type { CoreBase, CoreOptions, SettingsService, TailscaleService } from '../contracts.ts';
import { tailscaleCandidates } from './tailscale-bin.ts';
import {
  HTTPS_PORT, describeServeFailure, emptyStatus, findOwnedEntry, isOurProxy, looksNotRunning, matchServe, parseBackend, parseServe,
  problemForBackend, problems, statusKey, tryParseJson,
} from './tailscale-parse.ts';

export interface TailscaleDeps {
  base: Pick<CoreBase, 'db' | 'bus' | 'clock' | 'log'>;
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
  /** Longest shutdown() may spend switching its Serve entry off. Default 5 000. */
  shutdownTimeoutMs?: number;
}

/** The service plus what neighbours may want that the contract does not carry. */
export interface TailscaleServiceImpl extends TailscaleService {
  /** The last computed status, without running anything. null before the first check. */
  cachedStatus(): TailscaleStatus | null;
  shutdown(): Promise<void>;
}

/** kv key under which the port of the Serve entry this app created is kept. */
export const SERVE_RECORD_KEY = 'tailscale.serve';

interface ServeRecord { port: number; createdAt: string }

interface CliResult {
  /** false = no candidate binary exists. */
  found: boolean;
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Error code such as EACCES when the program could not be started for another reason. */
  errno: string | null;
}

const CANCELED: CliResult = { found: true, ok: false, stdout: '', stderr: '', timedOut: false, errno: 'ECANCELED' };
/** Not worth starting a command with less time than this left. */
const MIN_STEP_MS = 200;

const flat = (text: string, max = 220): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
};

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A regular file that can be started: on POSIX an executable one. */
function isRunnableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

export function createTailscaleService(deps: TailscaleDeps): TailscaleServiceImpl {
  const { db, bus, clock, log } = deps.base;
  const pollMs = deps.pollIntervalMs ?? 30_000;
  const timeoutMs = deps.commandTimeoutMs ?? 15_000;
  const ttlMs = deps.statusTtlMs ?? 5_000;
  const shutdownMs = deps.shutdownTimeoutMs ?? 5_000;
  const nowIso = (): string => clock.now().toISOString();
  const nowMs = (): number => clock.now().getTime();

  let last: TailscaleStatus | null = null;
  let lastAtMs = 0;
  let lastKey = '';
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let workingBin: string | null = null;
  let shutdownDone: Promise<void> | null = null;
  /** What the last probe saw at `/` of the HTTPS port besides Mini-Summa's current port. At most one of the two is set. */
  let foreignServe: string | null = null;
  let staleServe: { port: number } | null = null;
  /** The last probe could read the Serve configuration, so "no entry" really means no entry. */
  let serveRead = false;
  let inflight: Promise<TailscaleStatus> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const children = new Set<ChildProcess>();

  // -------------------------------------------------------------------------------------------------------------
  // Which entry is ours

  function readRecord(): ServeRecord | null {
    try {
      const row = db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', [SERVE_RECORD_KEY]);
      const v = fromJson<Partial<ServeRecord> | null>(row?.value_json, null);
      if (v && Number.isInteger(v.port) && (v.port as number) > 0 && (v.port as number) < 65536) {
        return { port: v.port as number, createdAt: typeof v.createdAt === 'string' ? v.createdAt : '' };
      }
    } catch { /* the database is closed */ }
    return null;
  }

  function writeRecord(record: ServeRecord | null): void {
    try {
      if (record === null) db.run('DELETE FROM kv WHERE key = ?', [SERVE_RECORD_KEY]);
      else {
        db.run(
          `INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          [SERVE_RECORD_KEY, JSON.stringify(record), nowIso()],
        );
      }
    } catch (err) {
      log.warn('Mini-Summa could not save which Tailscale Serve entry is its own.', { error: reasonOf(err) });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Running the CLI

  const candidates = (): string[] => tailscaleCandidates({
    platform: process.platform, env: process.env, exists: isRunnableFile, override: deps.overrides?.tailscaleBin,
  });

  function execOnce(bin: string, args: string[], limitMs: number): Promise<Omit<CliResult, 'found'> & { missing: boolean }> {
    return new Promise((resolve) => {
      const child = execFile(
        bin, args,
        { timeout: limitMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
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

  /** `afterShutdown` is only for the one cleanup command shutdown() itself runs. */
  async function runCli(args: string[], opts: { limitMs?: number; afterShutdown?: boolean } = {}): Promise<CliResult> {
    // A check that was running when the service shut down must not start another program.
    if (closed && !opts.afterShutdown) return CANCELED;
    const order = [...new Set([...(workingBin ? [workingBin] : []), ...candidates()])];
    for (const bin of order) {
      const r = await execOnce(bin, args, opts.limitMs ?? timeoutMs);
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
    staleServe = null;
    serveRead = false;
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
        const port = deps.getPort();
        const match = matchServe(parseServe(json), port, backend.dnsName);
        serveRead = true;
        if (!match.configured && match.occupant !== null) {
          // Something else sits where Mini-Summa's entry goes: an old entry of ours (a port this app recorded and no
          // longer listens on), or somebody else's.
          const recorded = readRecord();
          if (recorded !== null && isOurProxy(match.occupant.proxy, recorded.port)) staleServe = { port: recorded.port };
          else foreignServe = match.foreignTarget;
        }
        out.serve = { configured: match.configured, url: match.url, target: match.target, funnelDetected: match.funnel.length > 0 };
        if (match.funnel.length > 0) out.problem = problems.funnel(match.funnel);
        else if (staleServe !== null) out.problem = problems.staleServe(staleServe.port, port);
        else if (backend.dnsName === null) out.problem = problems.noDnsName();
        else if (backend.httpsCertificates === 'not_enabled') out.problem = problems.httpsNotEnabled();
        else if (foreignServe !== null) out.problem = problems.foreignServe(foreignServe);
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
      log.warn('Checking Tailscale failed unexpectedly.', { error: reasonOf(err) });
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

  /**
   * Publishes the port this core really listens on. Also what init() runs to reconcile: no entry -> create it, an old
   * entry of ours on another port -> re-point it, Mini-Summa's entry already right -> nothing, somebody else's entry
   * or Funnel or a Tailscale that is not running -> nothing, the status says why.
   */
  async function enable(): Promise<TailscaleStatus> {
    const before = await compute();
    // Nothing to attempt, or a reason not to. `problem` already says which.
    if (!before.installed || !before.running || !before.loggedIn) return before;
    if (before.serve.funnelDetected) return before;
    if (before.serve.configured) return before;
    // Never replace somebody else's Serve entry. The status already says what is there and how to remove it.
    if (foreignServe !== null) return before;
    const port = deps.getPort();
    if (!(port > 0)) return commit({ ...before, problem: problems.portNotReady() });

    // Record the intent first: if the app dies between the command and the bookkeeping, the next start still knows the
    // entry is its own and cleans it up. A failed command puts the previous record back.
    const previous = readRecord();
    writeRecord({ port, createdAt: nowIso() });
    const run = await runCli(['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`]);
    if (!run.ok) {
      writeRecord(previous);
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

  /** The user asked for remote access to be off: remove the entry if it is Mini-Summa's (current port or a recorded old one). */
  async function disable(): Promise<TailscaleStatus> {
    const before = await compute();
    if (!before.installed || !before.running) return before;
    // Only switch off what is Mini-Summa's own. Anything else on the HTTPS port belongs to somebody else.
    if (!before.serve.configured && staleServe === null) {
      if (serveRead && foreignServe === null) writeRecord(null); // no entry at all: nothing left to remember
      return before;
    }

    const run = await runCli(['serve', `--https=${HTTPS_PORT}`, 'off']);
    if (!run.ok) {
      const problem = run.timedOut ? problems.timedOut(`tailscale serve --https=${HTTPS_PORT} off`) : describeServeFailure(`${run.stderr}\n${run.stdout}`, 'disable');
      const after = await compute();
      return commit({ ...after, problem });
    }
    const after = await compute();
    if (after.serve.configured || staleServe !== null) return commit({ ...after, problem: 'Tailscale accepted the command but Mini-Summa is still published. Run "tailscale serve status" in a terminal to see what is configured, then try again.' });
    writeRecord(null);
    return after;
  }

  /**
   * Remote access is off at start, but an entry this app recorded is still there (the last run did not get to shut
   * down). Take it away. Entries without a matching record are left alone.
   */
  async function releaseOwned(): Promise<void> {
    const record = readRecord();
    if (record === null) return;
    const before = await compute();
    if (!before.installed || !before.running || !serveRead) return; // cannot tell: keep the record for the next start
    const livePort = before.serve.configured ? deps.getPort() : staleServe?.port ?? null;
    if (livePort !== record.port) { writeRecord(null); return; } // gone, or somebody else's now
    const run = await runCli(['serve', `--https=${HTTPS_PORT}`, 'off']);
    if (run.ok) { writeRecord(null); log.info('Mini-Summa switched off a Tailscale Serve entry left over from an earlier run.', { port: record.port }); await compute(); return; }
    log.warn('Mini-Summa could not switch off a Tailscale Serve entry left over from an earlier run.', { port: record.port, reason: flat(run.stderr || run.stdout || run.errno || 'no answer', 120) });
  }

  /** Best effort and bounded: the entry must not outlive the app, but closing the app must not hang on Tailscale. */
  async function releaseAtShutdown(): Promise<void> {
    const record = readRecord();
    if (record === null) return;
    const deadline = Date.now() + shutdownMs;
    const step = (args: string[]): Promise<CliResult | null> => {
      const left = deadline - Date.now();
      return left < MIN_STEP_MS ? Promise.resolve(null) : runCli(args, { limitMs: left, afterShutdown: true });
    };

    const read = await step(['serve', 'status', '--json']);
    if (read === null || !read.found || !read.ok) {
      log.warn('Mini-Summa could not check its Tailscale Serve entry while shutting down. It will be cleaned up at the next start.', { port: record.port });
      return;
    }
    const text = read.stdout.trim();
    const json = text === '' || /no serve config/i.test(text) ? {} : tryParseJson(text);
    if (json === null) {
      log.warn('Mini-Summa could not read the Tailscale Serve configuration while shutting down.', { port: record.port });
      return;
    }
    // Only an entry that still forwards to the port this app recorded. Anything else is somebody else's now.
    if (findOwnedEntry(parseServe(json), record.port, last?.dnsName ?? null) === null) { writeRecord(null); return; }

    const off = await step(['serve', `--https=${HTTPS_PORT}`, 'off']);
    if (off !== null && off.ok) {
      writeRecord(null);
      log.info('Mini-Summa switched off its Tailscale Serve entry.', { port: record.port });
    } else {
      log.warn('Mini-Summa could not switch off its Tailscale Serve entry while shutting down. It will be cleaned up at the next start.', {
        port: record.port, reason: off === null ? 'out of time' : flat(off.stderr || off.stdout || off.errno || 'no answer', 120),
      });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Polling

  function syncPolling(immediate: boolean): void {
    const want = !closed && deps.settings.get().mobile.remoteAccess === 'tailscale';
    if (want && timer === null) {
      timer = setInterval(() => { void status({ refresh: true }).catch(() => undefined); }, pollMs);
      timer.unref();
      if (immediate) void status({ refresh: true }).catch(() => undefined);
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
      if (closed || last === null) return null;
      const s = last.serve;
      if (last.backendState !== 'Running' || !s.configured || s.url === null || s.funnelDetected) return null;
      // Only while Serve forwards to the port this core really listens on now (the entry could be left over from a run
      // on another port, and whatever listens there would receive the phones' bearer tokens).
      return isOurProxy(s.target, deps.getPort()) ? s.url : null;
    },

    cachedStatus: () => (last === null ? null : structuredClone(last)),

    init() {
      if (closed || unsubscribe !== null) return;
      unsubscribe = deps.settings.onChange(() => syncPolling(true));
      const wanted = deps.settings.get().mobile.remoteAccess === 'tailscale';
      // The reconcile below starts with a check of its own, so the polling does not need an immediate one.
      syncPolling(false);
      void exclusive(async () => { if (wanted) await enable(); else await releaseOwned(); }).catch((err) => {
        log.warn('Mini-Summa could not set up its Tailscale Serve entry at start.', { error: reasonOf(err) });
      });
    },

    shutdown() {
      if (shutdownDone !== null) return shutdownDone;
      closed = true;
      if (timer !== null) { clearInterval(timer); timer = null; }
      unsubscribe?.();
      unsubscribe = null;
      for (const c of children) c.kill();
      children.clear();
      shutdownDone = releaseAtShutdown().catch((err) => {
        log.warn('Mini-Summa could not switch off its Tailscale Serve entry while shutting down.', { error: reasonOf(err) });
      });
      return shutdownDone;
    },
  };
}
