// Builders for the things the observer reads: raw log entries as the capture script and takeSnapshot would store them,
// and a runner for the REAL capture script (the hook command Claude Code would run).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveryRawEntryInput, HookPayload, HookRawEntryInput, HookTransport } from '@minisumma/claude-integration';
import type { EnvId } from '@minisumma/shared';

export const PACKAGE_ROOT = fileURLToPath(new URL('../../../../claude-integration/', import.meta.url));
export const CAPTURE_SRC = path.join(PACKAGE_ROOT, 'src', 'hook', 'capture.mjs');
export const CAPTURE_DIST = path.join(PACKAGE_ROOT, 'dist', 'capture.mjs');
export const FIXTURES_DIR = path.join(PACKAGE_ROOT, 'fixtures');

export const S1 = '11111111-1111-4111-8111-111111111111';
export const S2 = '22222222-2222-4222-8222-222222222222';
export const S3 = '33333333-3333-4333-8333-333333333333';

/** A deterministic wall time: second `n` of a fixed day. */
export const isoAt = (n: number): string => new Date(Date.UTC(2026, 0, 1, 10, 0, 0) + n * 1000).toISOString();

export function hookPayload(event: string, sessionId: string, extra: Record<string, unknown> = {}): HookPayload {
  return {
    session_id: sessionId, transcript_path: `/home/u/.claude/projects/x/${sessionId}.jsonl`, cwd: '/w/proj', permission_mode: 'default',
    hook_event_name: event, ...extra,
  };
}

export function hookEntry(opts: { n: number; env?: EnvId; payload: HookPayload; handler?: string; domain?: string | null; tid?: string }): HookRawEntryInput {
  const env = opts.env ?? 'posix';
  const transport: HookTransport = {
    transport_id: opts.tid ?? `t-${env}-${opts.n}`, received_at: isoAt(opts.n), wall_ms: Date.parse(isoAt(opts.n)), monotonic_ns: String(1000 + opts.n * 10),
    capture_version: 1, hook_arg: String(opts.payload.hook_event_name ?? ''), handler_id: opts.handler ?? 'h1', env_id: env,
    clock_domain: opts.domain === undefined ? `${env}|fx` : opts.domain, pid: 1, ppid: 1, platform: 'linux', claude_project_dir: null,
    claude_config_dir: null, claude_code_remote: null, redactions: 0, truncations: 0, parse_error: null,
  };
  return { kind: 'hook', transport, payload: opts.payload };
}

export function discoveryEntry(opts: { n: number; env?: EnvId; sessions: Record<string, unknown>[]; scopeCwd?: string | null }): DiscoveryRawEntryInput {
  const env = opts.env ?? 'posix';
  return {
    kind: 'discovery',
    transport: { received_at: isoAt(opts.n), wall_ms: Date.parse(isoAt(opts.n)), env_id: env },
    payload: {
      scope: { cwd: opts.scopeCwd ?? null }, interval: { complete: true, before_files: 0, drained: 0, uncertain: [] },
      sessions: opts.sessions.map((s) => ({ pid_alive: null, ...s })) as DiscoveryRawEntryInput['payload']['sessions'],
    },
  };
}

/** A fixture file as raw log entries for one environment, numbered from `start`. */
export function fixtureEntries(name: string, env: EnvId = 'posix', start = 1): (HookRawEntryInput | DiscoveryRawEntryInput)[] {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8')) as {
    events: { kind?: string; payload: Record<string, unknown>; handler?: string }[];
  };
  return fx.events.map((e, i) => {
    const n = start + i;
    if (e.kind === 'discovery') {
      return {
        kind: 'discovery' as const,
        transport: { received_at: isoAt(n), wall_ms: Date.parse(isoAt(n)), env_id: env },
        payload: e.payload as unknown as DiscoveryRawEntryInput['payload'],
      };
    }
    return hookEntry({ n, env, payload: e.payload as HookPayload, handler: e.handler ?? 'h1', tid: `fx-${name}-${env}-${i}` });
  });
}

export interface HookRun { status: number | null; stdout: string; stderr: string }

/** Runs the capture script exactly as Claude Code would: arguments on the command line, the payload on stdin. */
export function runHook(opts: {
  script?: string; spool: string; registry: string; env: string; handler?: string; event: string; payload: Record<string, unknown>;
}): HookRun {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(
    process.execPath,
    [opts.script ?? CAPTURE_SRC, '--spool', opts.spool, '--registry', opts.registry, '--env', opts.env, '--handler', opts.handler ?? 'ms-test', opts.event],
    { input: JSON.stringify(opts.payload), env, encoding: 'utf8', timeout: 15_000 },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${opts.what ?? 'a condition'}`);
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 10));
  }
}

/** Drops a hook receipt into a spool directory the way the capture script does (temp file, then atomic rename). */
export function writeSpoolRecord(spoolDir: string, entry: HookRawEntryInput): string {
  fs.mkdirSync(spoolDir, { recursive: true });
  const name = `${entry.transport.monotonic_ns.padStart(20, '0')}-${entry.transport.transport_id}.json`;
  const tmp = path.join(spoolDir, `.tmp-${entry.transport.transport_id}`);
  fs.writeFileSync(tmp, JSON.stringify({ schema: 'mini-summa.spool/1', transport: entry.transport, payload: entry.payload }));
  fs.renameSync(tmp, path.join(spoolDir, name));
  return name;
}

/** The same, without blocking the test: many hook processes can run at the same time, as Claude Code does. */
export function runHookAsync(opts: Parameters<typeof runHook>[0]): Promise<HookRun> {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CONFIG_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [opts.script ?? CAPTURE_SRC, '--spool', opts.spool, '--registry', opts.registry, '--env', opts.env, '--handler', opts.handler ?? 'ms-test', opts.event],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(opts.payload));
  });
}
