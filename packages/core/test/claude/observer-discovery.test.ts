// Discovery: `claude agents --json` through the verified takeSnapshot, on the shared queue, with a fake agents runner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunAgentsJsonOptions } from '@minisumma/claude-integration';
import type { EnvId } from '@minisumma/shared';
import { createStubEnvironments } from './helpers/observer-fakes.ts';
import { keyOf, layoutFor, makeHarness } from './helpers/observer-harness.ts';
import type { Harness } from './helpers/observer-harness.ts';
import { S1, S2, S3, hookEntry, hookPayload, waitFor, writeSpoolRecord } from './helpers/observer-hook.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

type Step = unknown[] | Error | ((opts: RunAgentsJsonOptions) => Promise<unknown[]> | unknown[]);
/** A stand-in for `claude agents --json`: each call plays the next step (the last one repeats). */
function scripted(steps: Step[]) {
  const calls: RunAgentsJsonOptions[] = [];
  const run = async (opts: RunAgentsJsonOptions): Promise<{ raw: unknown }> => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(opts);
    if (step instanceof Error) throw step;
    return { raw: typeof step === 'function' ? await step(opts) : step };
  };
  return { run, calls };
}
const agent = (o: Record<string, unknown> = {}) => ({ kind: 'interactive', cwd: '/w/proj', startedAt: 1700000000000, pid: process.pid, status: 'idle', sessionId: S1, ...o });
const K1 = keyOf('posix', S1);

async function harness(steps: Step[], opts: Parameters<typeof makeHarness>[0] = {}) {
  const s = scripted(steps);
  const h = await makeHarness({ run: s.run, ...opts });
  cleanups.push(() => h.cleanup());
  return { h, ...s };
}

describe('refreshDiscovery', () => {
  it('lists what Claude Code reports as sessions that are observed only, with the project from the registry', async () => {
    const { h, calls } = await harness([[agent({ name: 'Fix login', status: 'busy' })]]);
    h.projects.add({ id: 'p1', name: 'Proj', roots: [{ path: '/w/proj' }] });
    await h.sessions.flush();
    const before = h.sessions.discoveryStatus();
    expect(before).toEqual([]);

    expect(await h.sessions.refreshDiscovery()).toEqual({ ran: ['posix'], errors: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ bin: '/usr/bin/claude', timeoutMs: 20_000 });
    expect(calls[0].wslDistro).toBeUndefined();
    expect(calls[0].configDir).toBeUndefined();
    expect(calls[0].cwd).toBeUndefined();

    expect(h.view(K1)).toMatchObject({
      origin: 'external', availability: 'live', state: 'working', stateLabel: 'Working', stateEvidence: 'discovery', name: 'Fix login', pid: process.pid,
      startedAt: '2023-11-14T22:13:20.000Z', cwd: '/w/proj', projectId: 'p1', projectResolution: 'matched', generation: 1, terminal: null, resumable: false,
    });
    expect(h.sessions.discoveryStatus()).toEqual([{ env: 'posix', ok: true, lastRunAt: expect.stringMatching(/^\d{4}-/), error: null }]);
    expect(h.collected.derived.find((d) => d.kind === 'session_discovered')).toMatchObject({ sessionKey: K1, text: 'Discovered (interactive, busy)', replay: false });
  });

  it.each([
    [{ status: 'idle' }, 'idle', null],
    [{ status: 'busy' }, 'working', null],
    [{ status: 'waiting', waitingFor: 'permission prompt' }, 'needs_permission', 'permission'],
    [{ status: 'waiting', waitingFor: 'input' }, 'needs_input', 'input'],
  ])('reads %j as %s', async (listing, state, attention) => {
    const { h } = await harness([[agent(listing)]]);
    await h.sessions.refreshDiscovery();
    expect(h.view(K1).state).toBe(state);
    expect(h.view(K1).attention?.kind ?? null).toBe(attention);
  });

  it('a permission prompt that only discovery saw has no tool information', async () => {
    const { h } = await harness([[agent({ status: 'waiting', waitingFor: 'permission prompt' })]]);
    await h.sessions.refreshDiscovery();
    expect(h.collected.derived.find((d) => d.to === 'needs_permission')?.permission).toEqual({ toolName: null, inputExcerpt: null });
  });

  it('knows background sessions as such', async () => {
    const { h } = await harness([[agent({ kind: 'background', id: '7c5dcf5d', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' })]]);
    await h.sessions.refreshDiscovery();
    expect(h.view(K1)).toMatchObject({ origin: 'background', availability: 'live', state: 'needs_permission' });
  });

  it('keeps a listing without a session id as its own session', async () => {
    const { h } = await harness([[agent({ sessionId: undefined, startedAt: 1700000005000 })]]);
    await h.sessions.refreshDiscovery();
    const [view] = h.sessions.list();
    expect(view.key).toBe(`posix|nosid:${process.pid}:1700000005000`);
    expect(view.origin).toBe('external');
  });

  it('lets an idle process correct a busy state that only hooks reported (an interrupt fires no Stop), and says it is inferred', async () => {
    const { h } = await harness([[agent({ status: 'idle' })]]);
    await h.feed([hookEntry({ n: 1, payload: hookPayload('PermissionRequest', S1, { prompt_id: 'p', tool_name: 'Bash', tool_input: { command: 'ls' } }) })]);
    expect(h.view(K1)).toMatchObject({ state: 'needs_permission', stateEvidence: 'hook:PermissionRequest' });
    await h.sessions.refreshDiscovery();
    expect(h.view(K1)).toMatchObject({ origin: 'external', availability: 'live', state: 'idle', stateEvidence: 'discovery', attention: null });
    expect(h.collected.derived.find((d) => d.evidence === 'discovery' && d.to === 'idle')?.text).toBe('Idle, no Stop seen (observed; likely interrupted)');
  });

  it('does not let a listing overwrite what hooks say when the process looks busy too', async () => {
    const { h } = await harness([[agent({ status: 'busy' })]]);
    await h.feed([hookEntry({ n: 1, payload: hookPayload('PermissionRequest', S1, { prompt_id: 'p', tool_name: 'Bash', tool_input: { command: 'ls' } }) })]);
    await h.sessions.refreshDiscovery();
    expect(h.view(K1)).toMatchObject({ state: 'needs_permission', stateEvidence: 'hook:PermissionRequest' });
  });
});

describe('a terminal Mini-Summa started', () => {
  it('is still "Starting" when discovery already lists it: only a hook proves Claude is past its startup dialogs', async () => {
    const h0 = await harness([[agent()]]);
    const { h } = h0;
    h.managed.seed({ key: K1, projectId: null }, true);
    await h.sessions.refreshDiscovery(); // `claude agents --json` shows it idle
    expect(h.view(K1)).toMatchObject({ origin: 'managed', availability: 'live', state: 'unknown', stateLabel: 'Starting', attention: null });
    expect(await h.sessions.typeInto(K1, { text: 'go', submit: true, expectGeneration: 1, allowedStates: ['idle', 'unknown'] })).toMatchObject({
      ok: false, code: 'state_not_allowed', problem: expect.stringContaining('has not finished starting'),
    });
    await h.feed([hookEntry({ n: 1, payload: hookPayload('SessionStart', S1, { source: 'startup' }) })]);
    expect(h.view(K1)).toMatchObject({ state: 'idle', stateLabel: 'Idle' });
    expect(await h.sessions.typeInto(K1, { text: 'go', submit: true, expectGeneration: 1, allowedStates: ['idle'] })).toMatchObject({ ok: true });
  });
});

describe('absence', () => {
  const lost = [agent()];

  it('is a suspected end, never an observed one; the same process listed again revives the session', async () => {
    const { h } = await harness([lost, [], lost]);
    await h.sessions.refreshDiscovery();
    expect(h.view(K1)).toMatchObject({ availability: 'live', state: 'idle' });

    await h.sessions.refreshDiscovery();
    expect(h.view(K1)).toMatchObject({
      availability: 'disconnected', state: 'presence_lost', stateLabel: 'Presence lost (suspected)', stateEvidence: 'discovery:absent',
      termination: { kind: 'suspected', reason: expect.stringContaining('may have ended') }, attention: { kind: 'presence_lost' }, pid: null,
    });
    const event = h.collected.derived.find((d) => d.to === 'presence_lost')!;
    expect(event).toMatchObject({ notify: true, requiresUser: false, replay: false, evidence: 'discovery:absent' });

    await h.sessions.refreshDiscovery(); // the same process (pid and start time) is listed again
    expect(h.view(K1)).toMatchObject({ availability: 'live', termination: null, attention: null });
  });

  it('is not a new generation when the same session comes back', async () => {
    const { h } = await harness([lost, [], lost]);
    for (let i = 0; i < 3; i++) await h.sessions.refreshDiscovery();
    expect(h.view(K1).generation).toBe(1);
  });

  it('only the environment that was listed can lose a session', async () => {
    const { h } = await harness([lost, []]);
    await h.feed([hookEntry({ n: 1, env: 'wsl:Ubuntu', payload: hookPayload('SessionStart', S1, { source: 'startup' }) })]);
    await h.sessions.refreshDiscovery();
    await h.sessions.refreshDiscovery();
    expect(h.view(K1).state).toBe('presence_lost');
    expect(h.view(keyOf('wsl:Ubuntu', S1))).toMatchObject({ state: 'idle', availability: 'live' });
  });
});

describe('a failed call', () => {
  it('is reported, records a discovery_error, and does not turn live sessions into lost ones', async () => {
    const { h } = await harness([[agent()], new Error('claude agents --json failed: spawn ENOENT'), [agent()]]);
    await h.sessions.refreshDiscovery();
    const result = await h.sessions.refreshDiscovery();
    expect(result.ran).toEqual([]);
    expect(result.errors).toEqual([{ env: 'posix', message: 'Claude Code could not list its sessions: claude agents --json failed: spawn ENOENT' }]);
    expect(h.sessions.discoveryStatus()).toEqual([{ env: 'posix', ok: false, lastRunAt: expect.any(String), error: 'Claude Code could not list its sessions: claude agents --json failed: spawn ENOENT' }]);
    expect(h.view(K1)).toMatchObject({ availability: 'live', state: 'idle', termination: null, attention: null });
    expect(h.collected.derived.some((d) => d.to === 'presence_lost')).toBe(false);
    expect(h.rawStore.loadAll().map((e) => e.kind)).toEqual(['discovery', 'discovery_error']);

    await h.sessions.refreshDiscovery(); // and it recovers
    expect(h.sessions.discoveryStatus()[0]).toMatchObject({ ok: true, error: null });
    expect(h.view(K1).availability).toBe('live');
  });

  it('survives a failure from the very first call without inventing anything', async () => {
    const { h } = await harness([new Error('timed out')]);
    expect((await h.sessions.refreshDiscovery()).errors).toHaveLength(1);
    expect(h.sessions.list({ includeEnded: true })).toEqual([]);
    expect(h.rawStore.loadAll().map((e) => e.kind)).toEqual(['discovery_error']);
  });

  it('treats output that is not a list as a failure: no snapshot, nothing inferred', async () => {
    const { h } = await harness([[agent()], { error: 'not a list' } as never]);
    await h.sessions.refreshDiscovery();
    const result = await h.sessions.refreshDiscovery();
    expect(result.errors).toHaveLength(1);
    expect(h.rawStore.loadAll().filter((e) => e.kind === 'discovery')).toHaveLength(1);
    expect(h.view(K1)).toMatchObject({ availability: 'live', state: 'idle' });
  });

  it('still applies the hooks it drained before the call failed', async () => {
    const { h } = await harness([new Error('boom')]);
    writeSpoolRecord(h.layout.spoolDirHost, hookEntry({ n: 1, payload: hookPayload('SessionStart', S1, { source: 'startup' }) }));
    await h.sessions.refreshDiscovery();
    // takeSnapshot leaves pending hooks to the normal path on failure; the pass after it picks them up
    await h.sessions.flush();
    expect(h.view(K1).state).toBe('idle');
  });
});

describe('hooks around a call', () => {
  it('drains the hooks that were already waiting before the call, and records them as ordered before the snapshot', async () => {
    const { h } = await harness([[agent({ status: 'idle' })]]);
    writeSpoolRecord(h.layout.spoolDirHost, hookEntry({ n: 1, payload: hookPayload('UserPromptSubmit', S1, { prompt_id: 'p' }) }));
    await h.sessions.refreshDiscovery();
    const log = h.rawStore.loadAll();
    expect(log.map((e) => e.kind)).toEqual(['hook', 'discovery']);
    expect((log[1].payload as { interval: { before_files: number; drained: number; uncertain: string[] } }).interval).toMatchObject({ complete: true, before_files: 1, drained: 1, uncertain: [] });
    expect(h.view(K1).origin).toBe('external');
  });

  it('lists a hook that lands during the call as uncertain, and ingests it after the snapshot', async () => {
    const landing = hookEntry({ n: 2, payload: hookPayload('UserPromptSubmit', S1, { prompt_id: 'p' }) });
    let layoutDir = '';
    const { h } = await harness([async () => { writeSpoolRecord(layoutDir, landing); return [agent()]; }]);
    layoutDir = h.layout.spoolDirHost;
    await h.sessions.refreshDiscovery();
    expect(h.rawStore.loadAll().map((e) => e.kind)).toEqual(['discovery']); // the hook is still in the spool: it landed during the call
    await h.sessions.flush();
    const log = h.rawStore.loadAll();
    expect(log.map((e) => e.kind)).toEqual(['discovery', 'hook']); // ingested after the snapshot, which lists it as uncertain
    expect((log[0].payload as { interval: { uncertain: string[] } }).interval.uncertain).toEqual([landing.transport.transport_id]);
    expect(h.view(K1).state).toBe('working');
  });
});

describe('a process that is verifiably gone', () => {
  it('is an observed exit when the listed pid is dead on this host', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    cleanups.push(() => { child.kill('SIGKILL'); });
    const { h } = await harness([[agent({ pid })], [agent({ pid })]]);
    await h.sessions.refreshDiscovery();
    expect(h.view(K1)).toMatchObject({ availability: 'live', pid });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await h.sessions.refreshDiscovery(); // still listed, but the pid is dead
    expect(h.view(K1)).toMatchObject({ availability: 'ended', state: 'ended', termination: { kind: 'observed', reason: 'The Claude process is no longer running.' } });
    expect(h.view(K1).termination?.kind).not.toBe('suspected');
  });
});

describe('which environments are asked', () => {
  it('reports an unknown environment as a client error, and an environment without Claude as an error with the reason', async () => {
    const { h } = await harness([[agent()]]);
    await expect(h.sessions.refreshDiscovery('win')).rejects.toMatchObject({ status: 422, code: 'unknown_environment' });

    const down = await makeHarness({ environments: (layout) => createStubEnvironments('posix', [layout], false), run: scripted([[agent()]]).run });
    cleanups.push(() => down.cleanup());
    expect(await down.sessions.refreshDiscovery('posix')).toEqual({ ran: [], errors: [{ env: 'posix', message: 'Claude Code was not found.' }] });
    expect(await down.sessions.refreshDiscovery()).toEqual({ ran: [], errors: [] }); // the "refresh all" button skips what has no Claude
  });

  it('asks each environment that has Claude, a WSL one through its distribution and with its pids marked unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-disc-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const where = { dataDir: path.join(dir, 'data'), dir };
    const environments = createStubEnvironments('win', [layoutFor(where, 'win'), layoutFor(where, 'wsl:Ubuntu')]);
    environments.commands.set('win', { file: 'C:\\Users\\me\\.local\\bin\\claude.exe', prefixArgs: [], wslDistro: null });
    environments.commands.set('wsl:Ubuntu', { file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' });
    const s = scripted([(opts) => (opts.wslDistro ? [agent({ pid: process.pid })] : [agent({ sessionId: S2, pid: process.pid })])]);
    const h = await makeHarness({ dir, hostEnv: 'win', environments, run: s.run, sessionsEnv: { CLAUDE_CONFIG_DIR: 'D:\\claude-config' } });
    cleanups.push(() => h.cleanup());

    expect(await h.sessions.refreshDiscovery()).toEqual({ ran: ['win', 'wsl:Ubuntu'], errors: [] });
    const win = s.calls.find((c) => !c.wslDistro)!;
    const wsl = s.calls.find((c) => c.wslDistro)!;
    expect(win).toMatchObject({ bin: 'C:\\Users\\me\\.local\\bin\\claude.exe', configDir: 'D:\\claude-config' });
    expect(wsl).toMatchObject({ wslDistro: 'Ubuntu', timeoutMs: 30_000 });
    expect(wsl.bin).toBeUndefined();
    expect(wsl.configDir).toBeUndefined(); // the Windows config directory means nothing inside the distribution

    const snapshots = h.rawStore.loadAll().filter((e) => e.kind === 'discovery') as unknown as { transport: { env_id: EnvId }; payload: { sessions: { pid_alive: boolean | null }[] } }[];
    const alive = Object.fromEntries(snapshots.map((e) => [e.transport.env_id, e.payload.sessions[0].pid_alive]));
    expect(alive).toEqual({ win: true, 'wsl:Ubuntu': null }); // a WSL pid cannot be checked from Windows
    expect(h.sessions.discoveryStatus().map((x) => [x.env, x.ok])).toEqual([['win', true], ['wsl:Ubuntu', true]]);
  });

  it('checks pids of a WSL environment when the core itself runs inside that distribution', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-disc-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const where = { dataDir: path.join(dir, 'data'), dir };
    const environments = createStubEnvironments('wsl:Ubuntu', [layoutFor(where, 'wsl:Ubuntu')]);
    environments.commands.set('wsl:Ubuntu', { file: '/home/me/.local/bin/claude', prefixArgs: [], wslDistro: null });
    const s = scripted([[agent()]]);
    const h = await makeHarness({ dir, hostEnv: 'wsl:Ubuntu', environments, run: s.run });
    cleanups.push(() => h.cleanup());
    await h.sessions.refreshDiscovery();
    const snapshot = h.rawStore.loadAll().find((e) => e.kind === 'discovery') as unknown as { payload: { sessions: { pid_alive: boolean | null }[] } };
    expect(snapshot.payload.sessions[0].pid_alive).toBe(true);
    expect(s.calls[0].wslDistro).toBeUndefined();
  });
});

describe('scheduling', () => {
  it('asks again every interval, and stops when the service shuts down', async () => {
    const { h, calls } = await harness([[agent()]], { discoveryIntervalMs: 25 });
    await waitFor(() => calls.length >= 3, { what: 'three automatic discovery calls' });
    expect(h.sessions.get(K1)?.availability).toBe('live');
    await h.sessions.shutdown();
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.length).toBe(n);
  });

  it('follows the interval setting when no override is given', async () => {
    const s = scripted([[agent()]]);
    const h = await makeHarness({ run: s.run, discoveryIntervalMs: undefined, init: false });
    cleanups.push(() => h.cleanup());
    // overrides.discoveryIntervalMs defaults to 0 in the harness; the setting is what a production core uses
    expect(h.settings.get().sessions.discoveryIntervalSec).toBe(15);
  });

  it('never runs a discovery call at the same time as a spool pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const { h } = await harness([async () => { started = true; await gate; return [agent()]; }]);
    const refresh = h.sessions.refreshDiscovery();
    await waitFor(() => started, { what: 'the discovery call to start' });
    let flushed = false;
    const flush = h.sessions.flush().then(() => { flushed = true; });
    await new Promise((r) => setTimeout(r, 80));
    expect(flushed).toBe(false); // the pass waits for the call
    release();
    await refresh;
    await flush;
    expect(flushed).toBe(true);
    expect(h.view(K1).availability).toBe('live');
  });

  it('a user action does not wait forever behind a slow discovery call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const { h } = await harness([async () => { started = true; await gate; return []; }]);
    h.managed.seed({ key: K1, projectId: null }, true);
    await h.feed([hookEntry({ n: 1, payload: hookPayload('SessionStart', S1, { source: 'startup' }) })]);
    const refresh = h.sessions.refreshDiscovery();
    await waitFor(() => started, { what: 'the discovery call to start' });
    const t0 = Date.now();
    const result = await h.sessions.typeInto(K1, { text: 'go on', submit: true, expectGeneration: 1, allowedStates: ['idle'] });
    expect(result).toEqual({ ok: true, submitted: true });
    expect(Date.now() - t0).toBeLessThan(5000); // it waited a bounded time for a fresh look, then used what it knew
    release();
    await refresh;
  });
});

describe('environments that appear later', () => {
  it('ingests a late environment\'s backlog as history and its later hooks as news', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-late-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const where = { dataDir: path.join(dir, 'data'), dir };
    const winLayout = layoutFor(where, 'win');
    const wslLayout = layoutFor(where, 'wsl:Ubuntu');
    const environments = createStubEnvironments('win', [winLayout, wslLayout]);
    writeSpoolRecord(wslLayout.spoolDirHost, hookEntry({ n: 1, env: 'wsl:Ubuntu', payload: hookPayload('PermissionRequest', S3, { prompt_id: 'p', tool_name: 'Bash', tool_input: { command: 'ls' } }) }));
    const h = await makeHarness({ dir, hostEnv: 'win', environments });
    cleanups.push(() => h.cleanup());
    const key = keyOf('wsl:Ubuntu', S3);
    await waitFor(() => h.sessions.get(key)?.state === 'needs_permission', { what: 'the WSL backlog to be ingested' });
    expect(h.collected.derived.filter((d) => d.sessionKey === key).every((d) => d.replay)).toBe(true);

    writeSpoolRecord(wslLayout.spoolDirHost, hookEntry({ n: 2, env: 'wsl:Ubuntu', payload: hookPayload('PostToolUse', S3, { prompt_id: 'p', tool_use_id: 't' }) }));
    await h.sessions.flush();
    expect(h.view(key).state).toBe('working');
    expect(h.collected.derived.filter((d) => d.sessionKey === key && d.to === 'working').map((d) => d.replay)).toEqual([false]);
  });
});

export type _Harness = Harness;
