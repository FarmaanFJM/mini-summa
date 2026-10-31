// Identity: a session is (environment, session id). The same uuid in two environments is two sessions, and nothing one of
// them does can change the other. Windows and WSL are never merged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunAgentsJsonOptions } from '@minisumma/claude-integration';
import { createStubEnvironments } from './helpers/observer-fakes.ts';
import { keyOf, layoutFor, makeHarness } from './helpers/observer-harness.ts';
import type { Harness } from './helpers/observer-harness.ts';
import { S1, hookEntry, hookPayload } from './helpers/observer-hook.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
async function harness(opts: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  const h = await makeHarness(opts);
  cleanups.push(() => h.cleanup());
  return h;
}

const POSIX = keyOf('posix', S1);
const UBUNTU = keyOf('wsl:Ubuntu', S1);
const DEBIAN = keyOf('wsl:Debian', S1);
const WIN = keyOf('win', S1);
const ev = (n: number, env: 'posix' | 'win' | `wsl:${string}`, event: string, extra: Record<string, unknown> = {}, cwd = '/w/proj') =>
  hookEntry({ n, env, payload: hookPayload(event, S1, { cwd, ...extra }) });
const report = (task: string) => `Done.\n\n<!-- mini-summa:report status=complete task="${task}" -->\n`;

describe('the same session id in different environments', () => {
  it('is separate sessions with separate states, generations and reports', async () => {
    const h = await harness();
    await h.feed([
      ev(1, 'posix', 'SessionStart', { source: 'startup' }),
      ev(2, 'wsl:Ubuntu', 'SessionStart', { source: 'startup' }),
      ev(3, 'wsl:Ubuntu', 'UserPromptSubmit', { prompt_id: 'p' }),
      ev(4, 'wsl:Debian', 'UserPromptSubmit', { prompt_id: 'p' }),
      ev(5, 'wsl:Debian', 'Stop', { prompt_id: 'p', last_assistant_message: report('In Debian') }),
      ev(6, 'win', 'SessionStart', { source: 'startup' }, 'C:\\Dev\\app'),
      ev(7, 'win', 'SessionEnd', { reason: 'other' }, 'C:\\Dev\\app'),
    ]);
    expect(h.view(POSIX)).toMatchObject({ env: 'posix', sessionId: S1, state: 'idle', availability: 'live' });
    expect(h.view(UBUNTU)).toMatchObject({ env: 'wsl:Ubuntu', sessionId: S1, state: 'working', availability: 'live' });
    expect(h.view(DEBIAN)).toMatchObject({ env: 'wsl:Debian', sessionId: S1, state: 'report_ready', availability: 'live' });
    expect(h.view(WIN)).toMatchObject({ env: 'win', sessionId: S1, state: 'ended', availability: 'ended' });
    expect(h.sessions.list({ includeEnded: true }).map((v) => v.key).sort()).toEqual([DEBIAN, POSIX, UBUNTU, WIN].sort());

    expect(h.collected.reports).toHaveLength(1);
    expect(h.collected.reports[0]).toMatchObject({ sessionKey: DEBIAN, env: 'wsl:Debian', sessionId: S1, taskTitle: 'In Debian' });
    expect(h.collected.reports[0].taskId).toBe(`${DEBIAN}:p`);

    const byKey = new Map<string, string[]>();
    for (const d of h.collected.derived.filter((x) => x.kind === 'transition')) byKey.set(d.sessionKey, [...(byKey.get(d.sessionKey) ?? []), String(d.to)]);
    expect(Object.fromEntries(byKey)).toEqual({ [POSIX]: ['idle'], [UBUNTU]: ['idle', 'working'], [DEBIAN]: ['working'], [WIN]: ['idle', 'ended'] });
    const ids = h.collected.derived.map((d) => d.derivedId);
    expect(new Set(ids).size).toBe(ids.length); // no two events of different sessions share an identity
  });

  it('are attributed by the roots of their own environment: the same path in two distributions is two different folders', async () => {
    const h = await harness();
    h.projects.add({ id: 'p-linux', name: 'Linux app', roots: [{ path: '/w/proj', env: 'posix' }] });
    h.projects.add({ id: 'p-ubuntu', name: 'Ubuntu app', roots: [{ path: '/w/proj', env: 'wsl:Ubuntu' }] });
    await h.sessions.flush();
    await h.feed([ev(1, 'posix', 'SessionStart', { source: 'startup' }), ev(2, 'wsl:Ubuntu', 'SessionStart', { source: 'startup' }), ev(3, 'wsl:Debian', 'SessionStart', { source: 'startup' })]);
    expect(h.view(POSIX)).toMatchObject({ projectId: 'p-linux', projectResolution: 'matched' });
    expect(h.view(UBUNTU)).toMatchObject({ projectId: 'p-ubuntu', projectResolution: 'matched' });
    expect(h.view(DEBIAN)).toMatchObject({ projectId: null, projectResolution: 'unregistered_directory' });
  });

  it('keep their own bindings and defaults', async () => {
    const h = await harness();
    h.projects.add({ id: 'p1', name: 'P1', roots: [{ path: '/w/other' }] });
    await h.sessions.flush();
    await h.feed([ev(1, 'posix', 'SessionStart', { source: 'startup' }), ev(2, 'wsl:Ubuntu', 'SessionStart', { source: 'startup' })]);
    h.sessions.bind(UBUNTU, 'p1');
    expect(h.view(UBUNTU)).toMatchObject({ projectId: 'p1', projectResolution: 'manual' });
    expect(h.view(POSIX)).toMatchObject({ projectId: null });
    h.sessions.setDefault(UBUNTU, true);
    expect(h.view(UBUNTU).isProjectDefault).toBe(true);
    expect(h.view(POSIX).isProjectDefault).toBe(false);
    expect(h.db.all<{ session_key: string }>('SELECT session_key FROM session_bindings').map((r) => r.session_key)).toEqual([UBUNTU]);
  });

  it('are not merged with a managed terminal that has the same uuid in another environment', async () => {
    const h = await harness();
    await h.feed([ev(1, 'wsl:Ubuntu', 'SessionStart', { source: 'startup' })]);
    h.managed.seed({ key: POSIX, projectId: null }, true);
    expect(h.view(POSIX)).toMatchObject({ origin: 'managed', availability: 'live' });
    expect(h.view(UBUNTU)).toMatchObject({ origin: 'external', availability: 'live' });
    expect(h.sessions.targetCheck(POSIX, null)).toMatchObject({ managed: true });
    expect(h.sessions.targetCheck(UBUNTU, null)).toMatchObject({ managed: false });
    expect(await h.sessions.typeInto(UBUNTU, { text: 'x', submit: true, expectGeneration: null, allowedStates: ['idle'] })).toMatchObject({ ok: false, code: 'not_managed' });
    expect(h.managed.typed).toEqual([]);
  });

  it('end separately: a SessionEnd in one environment does not touch the other', async () => {
    const h = await harness();
    await h.feed([ev(1, 'posix', 'UserPromptSubmit', { prompt_id: 'p' }), ev(2, 'wsl:Ubuntu', 'UserPromptSubmit', { prompt_id: 'p' }), ev(3, 'posix', 'SessionEnd', { reason: 'other' })]);
    expect(h.view(POSIX)).toMatchObject({ state: 'ended', availability: 'ended' });
    expect(h.view(UBUNTU)).toMatchObject({ state: 'working', availability: 'live' });
  });
});

describe('discovery per environment', () => {
  async function twoEnvironments(runFor: (opts: RunAgentsJsonOptions) => unknown[]): Promise<{ h: Harness; calls: RunAgentsJsonOptions[] }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-multi-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const where = { dataDir: path.join(dir, 'data'), dir };
    const environments = createStubEnvironments('win', [layoutFor(where, 'win'), layoutFor(where, 'wsl:Ubuntu')]);
    environments.commands.set('wsl:Ubuntu', { file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' });
    const calls: RunAgentsJsonOptions[] = [];
    const h = await harness({ dir, hostEnv: 'win', environments, run: async (opts) => { calls.push(opts); return { raw: runFor(opts) }; } });
    return { h, calls };
  }
  const listed = (o: Record<string, unknown> = {}) => ({ kind: 'interactive', cwd: '/w/proj', startedAt: 1700000000000, pid: process.pid, status: 'idle', sessionId: S1, ...o });

  it('lists the same id once per environment, as two sessions', async () => {
    const { h } = await twoEnvironments(() => [listed()]);
    await h.sessions.refreshDiscovery();
    expect(h.sessions.list().map((v) => v.key).sort()).toEqual([UBUNTU, WIN].sort());
    expect(h.view(WIN)).toMatchObject({ origin: 'external', availability: 'live' });
    expect(h.view(UBUNTU)).toMatchObject({ origin: 'external', availability: 'live' });
  });

  it('a listing of one environment that lacks the id loses only that environment\'s session', async () => {
    let wslListsIt = true;
    const { h } = await twoEnvironments((opts) => (opts.wslDistro ? (wslListsIt ? [listed()] : []) : [listed()]));
    await h.sessions.refreshDiscovery();
    wslListsIt = false;
    await h.sessions.refreshDiscovery();
    expect(h.view(UBUNTU)).toMatchObject({ availability: 'disconnected', state: 'presence_lost', termination: { kind: 'suspected' } });
    expect(h.view(WIN)).toMatchObject({ availability: 'live', state: 'idle', termination: null });
  });

  it('asks one environment at a time when told to', async () => {
    const { h, calls } = await twoEnvironments(() => [listed()]);
    expect(await h.sessions.refreshDiscovery('wsl:Ubuntu')).toEqual({ ran: ['wsl:Ubuntu'], errors: [] });
    expect(calls.map((c) => c.wslDistro ?? null)).toEqual(['Ubuntu']);
    expect(h.sessions.get(WIN)).toBeNull();
  });

  it('a failure in one environment is reported for it alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-multi-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const where = { dataDir: path.join(dir, 'data'), dir };
    const environments = createStubEnvironments('win', [layoutFor(where, 'win'), layoutFor(where, 'wsl:Ubuntu')]);
    environments.commands.set('wsl:Ubuntu', { file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' });
    const h = await harness({ dir, hostEnv: 'win', environments, run: async (opts) => { if (opts.wslDistro) throw new Error('wsl.exe: distribution is not running'); return { raw: [listed()] }; } });
    const result = await h.sessions.refreshDiscovery();
    expect(result.ran).toEqual(['win']);
    expect(result.errors).toEqual([{ env: 'wsl:Ubuntu', message: 'Claude Code could not list its sessions: wsl.exe: distribution is not running' }]);
    expect(h.sessions.discoveryStatus().map((s) => [s.env, s.ok])).toEqual([['win', true], ['wsl:Ubuntu', false]]);
    expect(h.view(WIN).availability).toBe('live');
  });
});
