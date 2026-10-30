// Restart: a second service instance on the same database replays the raw log and reproduces what the first one showed,
// without announcing anything old as new.
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@minisumma/storage';
import { createEventBus } from '../../src/bus.ts';
import { createFakeManaged, createFakeProjects, createFakeSettings } from './helpers/observer-fakes.ts';
import { keyOf, makeHarness } from './helpers/observer-harness.ts';
import type { Harness } from './helpers/observer-harness.ts';
import { S1, S2, S3, discoveryEntry, fixtureEntries, hookEntry, hookPayload } from './helpers/observer-hook.ts';
import { systemClock } from '../../src/contracts.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const ev = (n: number, event: string, extra: Record<string, unknown> = {}, sid = S1, cwd = '/w/proj') =>
  hookEntry({ n, payload: hookPayload(event, sid, { cwd, ...extra }) });
const report = (task = 'T') => `Done.\n\n<!-- mini-summa:report status=complete task="${task}" -->\n`;

/** Two instances of the service share a database, a data directory, and the stores a real restart would keep. */
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-restart-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(':memory:').db;
  const projects = createFakeProjects({ bus: createEventBus(), db });
  const managed = createFakeManaged({ db, clock: systemClock });
  const settings = createFakeSettings();
  const start = async (opts: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> => {
    const h = await makeHarness({ dir, db, projects, managed, settings, ...opts });
    cleanups.push(() => h.cleanup());
    return h;
  };
  return { dir, db, projects, managed, settings, start };
}

/** A varied history: an ended session with a report, one waiting for permission, a listed external one, a managed one. */
async function history(a: Harness): Promise<void> {
  a.projects.add({ id: 'p1', name: 'Proj', roots: [{ path: '/w/proj' }] });
  await a.sessions.flush();
  a.managed.seed({ key: keyOf('posix', S3), projectId: 'p1', cwd: '/w/proj' }, true);
  await a.feed([
    ev(1, 'SessionStart', { source: 'startup' }, S1),
    ev(2, 'UserPromptSubmit', { prompt_id: 'a1' }, S1),
    ev(3, 'Stop', { prompt_id: 'a1', last_assistant_message: report('First') }, S1),
    ev(4, 'SessionEnd', { reason: 'prompt_input_exit' }, S1),
    ev(5, 'UserPromptSubmit', { prompt_id: 'b1' }, S2),
    ev(6, 'PermissionRequest', { prompt_id: 'b1', tool_name: 'Bash', tool_input: { command: 'make' } }, S2),
    ev(7, 'UserPromptSubmit', { prompt_id: 'c1' }, S3),
    ev(8, 'Stop', { prompt_id: 'c1', last_assistant_message: 'progress, no marker' }, S3),
    discoveryEntry({ n: 9, sessions: [{ kind: 'interactive', cwd: '/w/ext', sessionId: '55555555-5555-4555-8555-555555555555', pid: process.pid, startedAt: 1700000000000, status: 'busy', name: 'External' }] }),
  ]);
}

describe('a second instance on the same database', () => {
  it('reproduces identical views, and announces nothing old as new', async () => {
    const w = world();
    const a = await w.start();
    await history(a);
    const viewsA = a.sessions.list({ includeEnded: true });
    expect(viewsA.length).toBe(4);
    const rowsA = w.db.all<{ session_key: string; view_json: string }>('SELECT session_key, view_json FROM sessions_projection ORDER BY session_key');
    await a.cleanup();

    const b = await w.start();
    expect(b.sessions.list({ includeEnded: true })).toEqual(viewsA);

    // nothing about the views is news: nothing persisted differently, nothing emitted, no subscriber told
    expect(w.db.all('SELECT session_key, view_json FROM sessions_projection ORDER BY session_key')).toEqual(rowsA);
    expect(b.collected.busUpserts).toEqual([]);
    expect(b.collected.sessionChanges).toEqual([]);

    // every derived event is delivered again, with the same ids, and none of them as live news
    expect(b.collected.derived.length).toBeGreaterThan(0);
    expect(b.collected.derived.filter((d) => d.replay === false)).toEqual([]);
    expect(b.collected.derived.map((d) => d.derivedId)).toEqual(a.collected.derived.map((d) => d.derivedId));
    expect(b.collected.derived.map((d) => d.at)).toEqual(a.collected.derived.map((d) => d.at));

    // reports and candidates are handed over again unchanged: capturing is idempotent, and it repairs a crash between steps
    expect(b.collected.reports).toEqual(a.collected.reports);
    expect(b.collected.candidates).toEqual(a.collected.candidates);
    expect(b.collected.reports).toHaveLength(1);
    expect(b.collected.candidates).toHaveLength(1);
  });

  it('carries on from where the first one stopped: new hooks are live news, old state is the base', async () => {
    const w = world();
    const a = await w.start();
    await history(a);
    await a.cleanup();
    const b = await w.start();
    expect(b.view(keyOf('posix', S2)).state).toBe('needs_permission');
    const before = b.collected.derived.length;
    await b.feed([ev(10, 'PostToolUse', { prompt_id: 'b1', tool_use_id: 'x' }, S2)]);
    const fresh = b.collected.derived.slice(before);
    expect(fresh.map((d) => [d.to, d.replay])).toEqual([['working', false]]);
    expect(b.view(keyOf('posix', S2))).toMatchObject({ state: 'working', attention: null });
    expect(b.collected.sessionChanges).toHaveLength(1);
  });

  it('does not depend on how many times it has been restarted', async () => {
    const w = world();
    const first = await w.start();
    await history(first);
    const reference = first.sessions.list({ includeEnded: true });
    await first.cleanup();
    for (let i = 0; i < 3; i++) {
      const next = await w.start();
      expect(next.sessions.list({ includeEnded: true })).toEqual(reference);
      await next.cleanup();
    }
  });

  it('applies hooks that were logged but never applied (a crash between the append and the apply), as history', async () => {
    const w = world();
    const a = await w.start();
    await history(a);
    await a.cleanup();
    // appended to the log by a process that died before it applied or published anything
    const log = a.rawStore;
    log.appendRaw(ev(20, 'PostToolUse', { prompt_id: 'b1', tool_use_id: 'z' }, S2));
    log.appendRaw(ev(21, 'Stop', { prompt_id: 'b1', last_assistant_message: report('Recovered') }, S2));
    const b = await w.start();
    expect(b.collected.reports.map((r) => r.taskTitle).sort()).toEqual(['First', 'Recovered']);
    expect(b.collected.derived.every((d) => d.replay)).toBe(true);
    expect(b.view(keyOf('posix', S2))).toMatchObject({ state: 'report_ready', attention: { kind: 'report' } }); // the log is the truth
  });

  it('shows a managed session that was running as disconnected, and resumable once it got a prompt', async () => {
    const w = world();
    const a = await w.start();
    await history(a);
    const k3 = keyOf('posix', S3);
    expect(a.view(k3)).toMatchObject({ origin: 'managed', availability: 'live' });
    await a.cleanup();
    // what the real manager's init() does to records from an earlier run
    w.managed.change(k3, { status: 'disconnected', pid: null, exitReason: 'app_restart' });
    const b = await w.start();
    expect(b.view(k3)).toMatchObject({ origin: 'managed', availability: 'disconnected', resumable: true, pid: null, termination: null });
    expect(b.view(k3).stateLabel).toMatch(/\(last known\)$/);
  });

  it('tells the managed manager about a prompt it missed (the flag is repaired from the log)', async () => {
    const w = world();
    const a = await w.start();
    await history(a);
    const k3 = keyOf('posix', S3);
    expect(w.managed.get(k3)?.prompted).toBe(true);
    await a.cleanup();
    w.managed.change(k3, { prompted: false }); // the write that was lost
    w.managed.prompted.length = 0;
    await w.start();
    expect(w.managed.prompted).toContain(k3);
    expect(w.managed.get(k3)?.prompted).toBe(true);
  });
});

describe('history after the raw log was pruned', () => {
  it('keeps the persisted views, never as live, and has no events to announce', async () => {
    const w = world();
    const a = await w.start();
    await history(a);
    const external = keyOf('posix', '55555555-5555-4555-8555-555555555555');
    expect(a.view(external)).toMatchObject({ availability: 'live', state: 'working' });
    expect(a.view(keyOf('posix', S1))).toMatchObject({ availability: 'ended' });
    await a.cleanup();
    a.rawStore.prune('2999-01-01T00:00:00.000Z');
    expect(a.rawStore.count()).toBe(0);

    const b = await w.start();
    expect(b.collected.derived).toEqual([]);
    expect(b.collected.reports).toEqual([]);
    expect(b.view(external)).toMatchObject({ availability: 'disconnected', pid: null, state: 'working', stateLabel: 'Working (last known)' });
    expect(b.view(keyOf('posix', S1))).toMatchObject({ availability: 'ended', resumable: true, state: 'ended', termination: { kind: 'observed' } });
    expect(b.view(keyOf('posix', S2))).toMatchObject({ state: 'needs_permission', attention: null }); // nobody can answer a gone process
    expect(b.sessions.list({ includeEnded: true })).toHaveLength(4);
  });

  it('resumes counting seq from the pruned log, so ids never collide with history', async () => {
    const w = world();
    const a = await w.start();
    await history(a);
    const last = a.rawStore.maxSeq();
    await a.cleanup();
    a.rawStore.prune('2999-01-01T00:00:00.000Z');
    const b = await w.start();
    await b.feed([ev(30, 'SessionStart', { source: 'startup' }, S1)]);
    expect(b.rawStore.maxSeq()).toBeGreaterThan(last);
  });
});

describe('fixtures survive a restart too', () => {
  it.each(['happy-path', 'concurrent-sessions', 'identical-legitimate', 'duplicate-delivery', 'stop-failure', 'discovery'])('%s', async (name) => {
    const w = world();
    const a = await w.start();
    a.projects.add({ id: 'p-git', name: 'GitManager', roots: [{ path: '/w/GitManager' }] });
    a.projects.add({ id: 'p-herc', name: "Herc's Adventure", roots: [{ path: '/w/Herc' }, { path: '/w/Herc-wt' }] });
    await a.sessions.flush();
    await a.feed(fixtureEntries(name));
    const viewsA = a.sessions.list({ includeEnded: true });
    expect(viewsA.length).toBeGreaterThan(0);
    await a.cleanup();
    const b = await w.start();
    expect(b.sessions.list({ includeEnded: true })).toEqual(viewsA);
    expect(b.collected.busUpserts).toEqual([]);
    expect(b.collected.derived.every((d) => d.replay)).toBe(true);
  });
});
