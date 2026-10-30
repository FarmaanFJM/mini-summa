// The observer half against the managed half: the real SessionsService, the real ManagedManager (real PTYs), the fake
// Claude CLI that runs the real hook command from --settings, the real capture script and the real spool. Only the
// "model" (the fake CLI) and the project store (an in-memory fake) are stand-ins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import { createEventBus } from '../../src/bus.ts';
import type { CoreBase, EnvLayout } from '../../src/contracts.ts';
import { systemClock } from '../../src/contracts.ts';
import { createManagedManager } from '../../src/claude/managed.ts';
import type { ManagedOverrides } from '../../src/claude/managed.ts';
import { createSessionsService } from '../../src/claude/sessions.ts';
import type { ObserverSessionsService } from '../../src/claude/sessions.ts';
import { directive, fakeClaudeCommand, readContext, readReceived, waitFor, writeExternals } from '../../src/testing/fake-claude/index.ts';
import { collectingLogger } from './helpers/observer-harness.ts';
import { createFakeProjects, createFakeSettings, createStubEnvironments } from './helpers/observer-fakes.ts';
import type { FakeProjects } from './helpers/observer-fakes.ts';
import { CAPTURE_SRC } from './helpers/observer-hook.ts';
import type { Collected } from './helpers/observer-harness.ts';
import type { SessionView } from '@minisumma/shared';
import { parseSessionKey } from '@minisumma/shared';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const FAST: ManagedOverrides = { stopGraceMs: 4000, ctrlCGapMs: 100, ctrlCRepeatMs: 1200, termWaitMs: 800, killWaitMs: 1500, shutdownGraceMs: 800, outputThrottleMs: 40 };
const desktop = { kind: 'desktop' } as const;
const ACCEPTS_INPUT = ['idle', 'turn_ended', 'waiting_for_you', 'report_ready'] as const;

interface Stack {
  root: string; stateDir: string; work: string; db: Db; projects: FakeProjects; layout: EnvLayout; environments: ReturnType<typeof createStubEnvironments>;
  sessions: ObserverSessionsService; collected: Collected; log: ReturnType<typeof collectingLogger>;
  waitState(key: string, state: string, ms?: number): Promise<SessionView>;
  /** A second app run on the same database, data directory and fake Claude state. */
  next(): Promise<Stack>;
}

async function stack(prev?: Stack): Promise<Stack> {
  const root = prev?.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-integration-')));
  const dataDir = path.join(root, 'data');
  const stateDir = path.join(root, 'fake-state');
  const work = path.join(root, 'work', 'proj');
  for (const d of [dataDir, stateDir, work]) fs.mkdirSync(d, { recursive: true });
  const db = prev?.db ?? openDatabase(':memory:').db;
  const bus = createEventBus();
  const log = collectingLogger();
  const base: CoreBase = { db, bus, clock: systemClock, log, version: 'test', mode: 'headless', dataDir };
  const projects = prev?.projects ?? createFakeProjects({ bus, db });
  if (!prev) projects.add({ id: 'p1', name: 'Proj', roots: [{ path: work }] });
  const layout: EnvLayout = {
    env: 'posix', spoolDirHost: path.join(dataDir, 'spool', 'posix'), registryFileHost: path.join(dataDir, 'registry.json'),
    spoolDirInEnv: path.join(dataDir, 'spool', 'posix'), registryFileInEnv: path.join(dataDir, 'registry.json'), captureScriptInEnv: CAPTURE_SRC,
    runtime: { command: process.execPath, runAsNode: false, version: process.version }, configDirHost: null, configDirInEnv: null,
  };
  const environments = createStubEnvironments('posix', [layout]);
  environments.commands.set('posix', fakeClaudeCommand(stateDir));
  const managed = createManagedManager({
    base, environments,
    overrides: { ...FAST, baseEnv: { ...process.env, FAKE_CLAUDE_THINK_MS: '30', FAKE_CLAUDE_NOTIFY_MS: '400' }, hostEnv: 'posix' },
  });
  const sessions = createSessionsService({ base, settings: createFakeSettings(), projects, environments, managed, overrides: { hostEnv: 'posix', spoolPollMs: 25, discoveryIntervalMs: 0 } });
  const collected: Collected = { derived: [], reports: [], candidates: [], sessionChanges: [], busUpserts: [] };
  sessions.subscribe({
    onDerived: (e) => { collected.derived.push(e); }, onReport: (r) => { collected.reports.push(r); },
    onCandidate: (c) => { collected.candidates.push(c); }, onSession: (view, previous) => { collected.sessionChanges.push({ view, previous }); },
  });
  bus.subscribe((_s, e) => { if (e.type === 'session.upserted') collected.busUpserts.push(e.session); });
  await sessions.init();
  cleanups.push(async () => {
    await sessions.shutdown();
    if (prev) return;
    db.close();
    // A hook process of a session that has just exited can still be writing into the spool: remove, wait, remove again.
    fs.rmSync(root, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s: Stack = {
    root, stateDir, work, db, projects, layout, environments, sessions, collected, log,
    waitState: (key, state, ms = 15_000) => waitFor(() => { const v = sessions.get(key as never); return v?.state === state ? v : undefined; }, `${key} to be ${state}`, ms),
    next: () => stack(s),
  };
  return s;
}

describe('a managed session, from start to report to stop, through real terminals, hooks and files', () => {
  it('runs a whole task and reports what happened at every step', async () => {
    const s = await stack();
    const started = await s.sessions.start('p1', { mode: 'new', name: 'Fix login' }, desktop);
    const key = started.key;
    const { sessionId } = parseSessionKey(key)!;
    expect(started).toMatchObject({ origin: 'managed', availability: 'live', name: 'Fix login', projectId: 'p1', projectResolution: 'managed', terminal: { exited: false } });

    // the terminal exists at once; the hooks (from --settings, run by the fake CLI through the real capture script) tell the rest
    const idle = await s.waitState(key, 'idle');
    expect(idle).toMatchObject({ origin: 'managed', availability: 'live', generation: 1, stateEvidence: 'hook:SessionStart', cwd: s.work });
    expect(readContext(s.stateDir, sessionId)).toContain('mini-summa:report'); // the registry file I wrote is what made the hook inject the protocol

    // type a prompt that makes the fake ask for a permission
    const prompt = `Run it ${directive.permission('bash', 'echo hello-from-fake')}`;
    expect(await s.sessions.typeInto(key, { text: prompt, submit: true, expectGeneration: 1, allowedStates: [...ACCEPTS_INPUT] })).toEqual({ ok: true, submitted: true });
    await waitFor(() => readReceived(s.stateDir, sessionId).length === 1, 'the fake CLI to receive the prompt');
    expect(readReceived(s.stateDir, sessionId).map((r) => r.text)).toEqual([prompt]);
    const waiting = await s.waitState(key, 'needs_permission');
    expect(waiting.attention).toMatchObject({ kind: 'permission' });
    const permission = s.collected.derived.find((d) => d.to === 'needs_permission' && d.sessionKey === key)!;
    expect(permission).toMatchObject({ notify: true, requiresUser: true, replay: false });
    expect(permission.permission?.toolName?.toLowerCase()).toBe('bash');
    expect(permission.permission?.inputExcerpt).toContain('echo hello-from-fake');
    expect(s.sessions.targetCheck(key, 1)).toMatchObject({ managed: true, live: true, state: 'needs_permission', problem: null });

    // text is refused while a permission is pending; the answer is accepted and moves the session on
    expect(await s.sessions.typeInto(key, { text: 'no', submit: true, expectGeneration: 1, allowedStates: [...ACCEPTS_INPUT] })).toMatchObject({ ok: false, code: 'state_not_allowed' });
    expect(await s.sessions.answerPermission(key, 'approve', 1)).toEqual({ ok: true, submitted: true });
    await waitFor(() => ['working', 'turn_ended'].includes(s.sessions.get(key)!.state), 'the session to move on after the approval');
    await s.waitState(key, 'turn_ended');
    expect(s.sessions.get(key)?.attention).toBeNull();

    // a final message with the report marker becomes a report, attributed to the project the session was started for
    expect(await s.sessions.typeInto(key, { text: directive.report({ status: 'complete', task: 'Fix login' }), submit: true, expectGeneration: 1, allowedStates: [...ACCEPTS_INPUT] })).toMatchObject({ ok: true });
    const done = await s.waitState(key, 'report_ready');
    expect(done.attention).toMatchObject({ kind: 'report' });
    expect(s.collected.reports).toHaveLength(1);
    expect(s.collected.reports[0]).toMatchObject({ sessionKey: key, projectId: 'p1', projectName: 'Proj', taskTitle: 'Fix login', declaredStatus: 'complete', generation: 1 });

    // the first prompt was seen, so the manager knows --resume will work
    expect(s.sessions.get(key)?.resumable).toBe(false); // still running
    await waitFor(() => s.db.get<{ prompted: number }>('SELECT prompted FROM managed_sessions WHERE session_key = ?', [key])?.prompted === 1, 'the prompted flag');

    // stop it: the exit is observed (by the terminal and by the SessionEnd hook), and it can be resumed
    const stopped = await s.sessions.stop(key, {});
    expect(stopped.availability).not.toBe('live');
    const ended = await waitFor(() => { const v = s.sessions.get(key); return v && v.availability !== 'live' && v.state === 'ended' ? v : undefined; }, 'the ended view');
    expect(ended).toMatchObject({ availability: 'resumable', resumable: true, termination: { kind: 'observed' }, terminal: { exited: true } });

    // and the transitions are exactly the ones a person would expect
    const states = s.collected.derived.filter((d) => d.kind === 'transition' && d.sessionKey === key).map((d) => d.to);
    expect(states).toEqual(expect.arrayContaining(['idle', 'working', 'needs_permission', 'turn_ended', 'ended']));
    expect(states.indexOf('needs_permission')).toBeLessThan(states.indexOf('turn_ended'));
    expect(s.log.count('error')).toBe(0);
  }, 60_000);

  it('resumes the session under the same key as its second generation', async () => {
    const s = await stack();
    const key = (await s.sessions.start('p1', { mode: 'new' }, desktop)).key;
    await s.waitState(key, 'idle');
    expect(await s.sessions.typeInto(key, { text: 'first prompt', submit: true, expectGeneration: 1, allowedStates: [...ACCEPTS_INPUT] })).toMatchObject({ ok: true });
    await s.waitState(key, 'turn_ended');
    await s.sessions.stop(key, {});
    await waitFor(() => s.sessions.get(key)?.availability === 'resumable', 'the session to become resumable');

    const resumed = await s.sessions.start('p1', { mode: 'resume', resumeKey: key }, desktop);
    expect(resumed.key).toBe(key);
    const again = await waitFor(() => { const v = s.sessions.get(key); return v && v.availability === 'live' && v.generation === 2 && v.state === 'idle' ? v : undefined; }, 'the second generation to start');
    expect(again).toMatchObject({ origin: 'managed', resumable: false, termination: null, generation: 2 });
    expect(s.collected.derived.some((d) => d.kind === 'generation' && d.sessionKey === key && d.generation === 2)).toBe(true);
    await s.sessions.stop(key, {});
  }, 60_000);

  it('refuses text for a session that is busy, using what the spool says right now', async () => {
    const s = await stack();
    const key = (await s.sessions.start('p1', { mode: 'new' }, desktop)).key;
    await s.waitState(key, 'idle');
    const send = (text: string) => s.sessions.typeInto(key, { text, submit: true, expectGeneration: 1, allowedStates: [...ACCEPTS_INPUT] });
    expect(await send(`long job ${directive.sleep(1500)}`)).toMatchObject({ ok: true });
    // the very next call (a double click) is refused: Claude has either not picked the first one up yet, or is already working
    // (which of the two depends on how fast the hook process was; both are a refusal, and nothing is typed)
    expect(await send('and another')).toMatchObject({ ok: false, code: 'state_not_allowed', problem: expect.stringMatching(/has not picked it up yet|"Working"/) });
    // once the hooks show it working, the refusal is about the state, from what the spool says right now
    await s.waitState(key, 'working');
    expect(await send('and a third')).toMatchObject({ ok: false, code: 'state_not_allowed', problem: expect.stringContaining('"Working"') });
    await s.waitState(key, 'turn_ended');
    expect(readReceived(s.stateDir, parseSessionKey(key)!.sessionId)).toHaveLength(1); // only the first one ever reached Claude
    expect(await send('after it finished')).toMatchObject({ ok: true });
    await s.sessions.stop(key, { force: true });
  }, 60_000);
});

describe('discovery against the fake CLI\'s `agents --json`', () => {
  it('lists managed and observed sessions, and a vanished one is only suspected to be gone', async () => {
    const s = await stack();
    const key = (await s.sessions.start('p1', { mode: 'new' }, desktop)).key;
    await s.waitState(key, 'idle');
    const external = '99999999-9999-4999-8999-999999999999';
    writeExternals(s.stateDir, [{ kind: 'interactive', cwd: s.work, startedAt: 1700000000000, pid: process.pid, status: 'busy', sessionId: external, name: 'Started elsewhere' }]);

    expect(await s.sessions.refreshDiscovery()).toEqual({ ran: ['posix'], errors: [] });
    const extKey = `posix|${external}` as const;
    expect(s.sessions.get(extKey)).toMatchObject({ origin: 'external', availability: 'live', state: 'working', name: 'Started elsewhere', projectId: 'p1', projectResolution: 'matched', terminal: null });
    expect(s.sessions.get(key)).toMatchObject({ origin: 'managed', availability: 'live', state: 'idle', pid: expect.any(Number) });
    // an observed session can be looked at, never typed into
    expect(await s.sessions.typeInto(extKey, { text: 'hi', submit: true, expectGeneration: null, allowedStates: ['idle', 'working'] })).toMatchObject({ ok: false, code: 'not_managed' });
    await expect(s.sessions.stop(extKey, {})).rejects.toMatchObject({ code: 'not_managed' });

    writeExternals(s.stateDir, []);
    await s.sessions.refreshDiscovery();
    expect(s.sessions.get(extKey)).toMatchObject({ availability: 'disconnected', state: 'presence_lost', termination: { kind: 'suspected' } });
    expect(s.sessions.get(key)).toMatchObject({ availability: 'live', termination: null }); // the managed one is still listed, and still a live terminal
    await s.sessions.stop(key, { force: true });
  }, 60_000);

  it('reports a Claude that cannot list sessions as a failed discovery, not as sessions that are gone', async () => {
    const s = await stack();
    const key = (await s.sessions.start('p1', { mode: 'new' }, desktop)).key;
    await s.waitState(key, 'idle');
    await s.sessions.refreshDiscovery();
    // the Claude executable stops working (moved, broken): `agents --json` fails to run
    s.environments.commands.set('posix', { file: path.join(s.root, 'no-such-claude'), prefixArgs: [], wslDistro: null });
    const result = await s.sessions.refreshDiscovery();
    expect(result.ran).toEqual([]);
    expect(result.errors).toEqual([{ env: 'posix', message: expect.stringMatching(/^Claude Code could not list its sessions:/) }]);
    expect(s.sessions.discoveryStatus()).toEqual([expect.objectContaining({ env: 'posix', ok: false, error: expect.stringContaining('could not list') })]);
    expect(s.sessions.get(key)).toMatchObject({ availability: 'live', state: 'idle' });
    expect(s.collected.derived.some((d) => d.to === 'presence_lost')).toBe(false);
    expect(s.db.all<{ kind: string }>('SELECT kind FROM raw_events ORDER BY seq').map((r) => r.kind)).toContain('discovery_error');
    await s.sessions.stop(key, { force: true });
  }, 60_000);
});

describe('the next run of the app', () => {
  it('shows a terminal from the previous run as disconnected, never as live, and offers to resume it', async () => {
    const first = await stack();
    const key = (await first.sessions.start('p1', { mode: 'new' }, desktop)).key;
    await first.waitState(key, 'idle');
    expect(await first.sessions.typeInto(key, { text: 'a prompt', submit: true, expectGeneration: 1, allowedStates: [...ACCEPTS_INPUT] })).toMatchObject({ ok: true });
    await first.waitState(key, 'turn_ended');

    // a second run starts while the first one's process is still around (as a crashed app's would be): its manager marks
    // the earlier run's records disconnected
    const second = await first.next();
    const view = second.sessions.get(key)!;
    expect(view).toMatchObject({ origin: 'managed', availability: 'disconnected', resumable: true, pid: null, termination: null });
    expect(view.stateLabel).toBe('Turn ended (last known)');
    expect(second.collected.derived.every((d) => d.replay)).toBe(true);
    expect(second.collected.derived.length).toBeGreaterThan(0);
    expect(second.sessions.targetCheck(key, null)).toMatchObject({ managed: true, live: false, problem: expect.stringContaining('lost the connection') });
    await first.sessions.stop(key, { force: true }).catch(() => undefined);
  }, 60_000);
});
