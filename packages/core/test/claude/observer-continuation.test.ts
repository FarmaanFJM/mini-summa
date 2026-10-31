// The sessions service follows the process, not the id: a managed terminal whose Claude session is replaced (/clear, /resume)
// stays the managed terminal under the new key (the managed manager is a fake that records the rekey calls; the real one is
// tested in managed-rekey.test.ts and, end to end with PTYs, in integration/session-continuity.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import type { RunAgentsJsonOptions } from '@minisumma/claude-integration';
import type { EnvId, SessionKey } from '@minisumma/shared';
import { STARTING_PROBLEM } from '../../src/claude/sessionView.ts';
import { keyOf, makeHarness } from './helpers/observer-harness.ts';
import type { Harness } from './helpers/observer-harness.ts';
import { S1, S2, S3, hookEntry, hookPayload, waitFor } from './helpers/observer-hook.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const MANAGED = 'ms-managed';
// Listed pids must belong to processes that are alive on this host (a dead one is an observed exit): this process, its parent, init.
const PID = process.pid;
const B_PID = 1;
const STRANGER_PID = process.ppid;
const OLD = S1;
const NEW = S2;
const K_OLD = keyOf('posix', OLD);
const K_NEW = keyOf('posix', NEW);

type Listing = Record<string, unknown>[];
/** A stand-in for `claude agents --json` whose answer the test changes between calls. */
function listings() {
  let current: Listing = [];
  let failing = false;
  const calls: RunAgentsJsonOptions[] = [];
  return {
    calls,
    set: (rows: Listing) => { current = rows; failing = false; },
    fail: () => { failing = true; },
    run: async (opts: RunAgentsJsonOptions): Promise<{ raw: unknown }> => {
      calls.push(opts);
      if (failing) throw new Error('claude agents failed');
      return { raw: current };
    },
  };
}
const agent = (sessionId: string, pid = PID, o: Record<string, unknown> = {}) => ({ kind: 'interactive', cwd: '/w/proj', startedAt: 1700000000000, pid, status: 'idle', sessionId, ...o });

let n = 0;
const ev = (event: string, sid: string, extra: Record<string, unknown> = {}, o: { handler?: string; env?: EnvId; cwd?: string } = {}) =>
  hookEntry({ n: ++n, env: o.env, handler: o.handler ?? MANAGED, payload: hookPayload(event, sid, { cwd: o.cwd ?? '/w/proj', ...extra }) });

type Seams = NonNullable<NonNullable<Parameters<typeof makeHarness>[0]>['continuation']>;

/** `discovery: false` = `claude agents` fails every time: there is no listing, so the process id cannot be compared. */
async function setup(opts: { discovery?: boolean; continuation?: Seams } = {}) {
  n = 0;
  const l = listings();
  if (opts.discovery === false) l.fail();
  const h = await makeHarness({ run: l.run, continuation: { retryDelaysMs: [60_000], parentPid: (pid) => (pid === STRANGER_PID ? 1 : undefined), ...opts.continuation } });
  cleanups.push(() => h.cleanup());
  h.projects.add({ id: 'p1', name: 'Proj', roots: [{ path: '/w/proj' }] });
  await h.sessions.flush();
  return { h, l };
}

/** A managed terminal that has spoken: SessionStart, a prompt and its answer. Default session of the project, named, remote control on. */
async function running(h: Harness, key: SessionKey = K_OLD, sid = OLD, pid = PID): Promise<void> {
  h.managed.seed({ key, projectId: 'p1', pid, name: 'work', remoteControl: true, cwd: '/w/proj' }, true);
  h.projects.setDefaultSession('p1', key);
  await h.feed([ev('SessionStart', sid, { source: 'startup' }), ev('UserPromptSubmit', sid, { prompt_id: 'p' }), ev('Stop', sid, { prompt_id: 'p', last_assistant_message: 'done' })]);
}
/** Claude lists the terminal's process under its first id: a healthy listing exists before anything is replaced. */
async function listed(h: Harness, l: ReturnType<typeof listings>, sid = OLD, pid = PID): Promise<void> {
  l.set([agent(sid, pid)]);
  await h.sessions.refreshDiscovery();
}
const clear = (sid = OLD, next = NEW, reason = 'clear', extra: { handler?: string } = {}) => [
  ev('SessionEnd', sid, { reason }, extra), ev('SessionStart', next, { source: reason }, extra),
];

describe('adoption by the process id', () => {
  it('re-keys the terminal to the session Claude lists for its process: everything that makes it a managed session moves', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    expect(h.view(K_OLD)).toMatchObject({ origin: 'managed', availability: 'live', state: 'turn_ended', isProjectDefault: true });

    l.set([agent(NEW)]);
    await h.feed(clear());
    // the hooks alone did not move it: the listing has not been asked yet (the process id decides), and it says so
    expect(h.managed.rekeyCalls).toEqual([]);
    expect(h.view(K_OLD)).toMatchObject({ origin: 'managed', availability: 'live', state: 'ended', stateLabel: 'Conversation replaced, learning the new session' });
    expect(h.view(K_NEW)).toMatchObject({ origin: 'external' });

    await h.sessions.refreshDiscovery();
    expect(h.managed.rekeyCalls).toEqual([{ from: K_OLD, toSessionId: NEW, leftBehindReason: `replaced:clear:${NEW}`, prompted: false }]);
    expect(h.view(K_NEW)).toMatchObject({
      origin: 'managed', availability: 'live', projectId: 'p1', projectResolution: 'managed', name: 'work', isProjectDefault: true, state: 'idle', pid: PID,
      remoteControl: { state: 'enabled' }, terminal: { exited: false },
    });
    expect(h.view(K_OLD)).toMatchObject({
      origin: 'managed', availability: 'resumable', resumable: true, isProjectDefault: false, attention: null, pid: null,
      termination: { kind: 'observed', reason: expect.stringContaining('/clear') },
    });
    expect(h.view(K_OLD).termination?.reason).toContain(NEW.slice(0, 8));
    expect(h.projects.get('p1')?.defaultSessionKey).toBe(K_NEW);
    // no phantom: one live session, both keys told to every client
    expect(h.sessions.list({ includeEnded: true }).filter((s) => s.availability === 'live').map((s) => s.key)).toEqual([K_NEW]);
    expect(h.collected.busUpserts.some((v) => v.key === K_NEW && v.origin === 'managed')).toBe(true);
    expect(h.collected.busUpserts.some((v) => v.key === K_OLD && v.availability === 'resumable')).toBe(true);
    // and the end of the old conversation is an ordinary end: no alarm, nothing to notify
    const ended = h.collected.derived.find((d) => d.sessionKey === K_OLD && d.to === 'ended')!;
    expect(ended.abnormal).toBeFalsy();
    expect(ended.notify).toBe(false);
  });

  it('adopts without waiting when the listing already shows the new id (discovery before the hooks), and no "found a session" event is raised for it', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    l.set([agent(NEW)]);
    await h.sessions.refreshDiscovery();                                    // the listing comes first: no hook of NEW exists yet
    expect(h.managed.rekeyCalls).toHaveLength(1);
    expect(h.view(K_NEW)).toMatchObject({ origin: 'managed', availability: 'live' });
    // the terminal has been up all along: it is not "Starting" again because its new session has not spoken yet... except that
    // nothing has been heard of the new session, which the view says honestly until its first hook
    expect(['Starting', 'Idle']).toContain(h.view(K_NEW).stateLabel);
    await h.feed(clear());
    expect(h.view(K_NEW)).toMatchObject({ origin: 'managed', state: 'idle', stateLabel: 'Idle' });
    const discovered = h.collected.derived.filter((d) => d.kind === 'session_discovered' && d.sessionKey === K_NEW);
    for (const d of discovered) expect(h.collected.sessionChanges.find((c) => c.view.key === d.sessionKey)?.view.origin).toBe('managed');
    // the old session left the listing before its SessionEnd arrived: not "lost", and not announced as lost
    expect(h.collected.derived.filter((d) => d.sessionKey === K_OLD && d.to === 'presence_lost' && !d.replay)).toEqual([]);
  });

  it('shows no "Starting" for the new session once it has spoken, and a later prompt still goes through the target checks', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    l.set([agent(NEW)]);
    await h.feed(clear());
    await h.sessions.refreshDiscovery();
    expect(h.view(K_NEW).stateLabel).toBe('Idle');
    const r = await h.sessions.typeInto(K_NEW, { text: 'continue', submit: true, expectGeneration: null, allowedStates: ['idle', 'turn_ended'] });
    expect(r).toEqual({ ok: true, submitted: true });
    expect(h.managed.typed).toEqual([{ key: K_NEW, text: 'continue', submit: true }]);
    // the old key takes nothing, and says why
    const refused = await h.sessions.typeInto(K_OLD, { text: 'old', submit: true, expectGeneration: null, allowedStates: ['idle', 'turn_ended'] });
    expect(refused).toMatchObject({ ok: false, code: 'not_live', problem: expect.stringContaining('replaced') });
    expect(h.sessions.targetCheck(K_OLD, null).problem).toContain(NEW.slice(0, 8));
  });

  it('keeps "Starting" for a terminal that has not spoken yet, even though its (cleared) successor is listed', async () => {
    const { h, l } = await setup();
    h.managed.seed({ key: K_OLD, projectId: 'p1', pid: PID }, true);        // started, no hook yet
    expect(h.view(K_OLD)).toMatchObject({ state: 'unknown', stateLabel: 'Starting' });
    await listed(h, l);
    l.set([agent(NEW)]);
    await h.sessions.refreshDiscovery();
    // the process lists another id: the terminal follows it, but nothing has been heard of the new session, so it is still starting
    expect(h.view(K_NEW)).toMatchObject({ origin: 'managed', state: 'unknown', stateLabel: 'Starting' });
    const r = await h.sessions.typeInto(K_NEW, { text: 'x', submit: true, expectGeneration: null, allowedStates: ['idle', 'unknown' as never] });
    expect(r).toMatchObject({ ok: false, problem: STARTING_PROBLEM });
  });

  it('carries the approvals across: a dialog in the new session is the open request, and an answer for the old one sends nothing (SEC-01)', async () => {
    const { h, l } = await setup();
    await running(h);
    // a dialog of the OLD conversation that nobody answered
    await h.feed([ev('UserPromptSubmit', OLD, { prompt_id: 'p2' }), ev('PermissionRequest', OLD, { prompt_id: 'p2', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })]);
    const oldRequest = h.sessions.currentPermission(K_OLD)!;
    expect(oldRequest).toBeTruthy();

    await listed(h, l);
    l.set([agent(NEW)]);
    await h.feed(clear());
    await h.sessions.refreshDiscovery();
    expect(h.sessions.currentPermission(K_OLD)).toBeNull();                 // the old key has no open dialog any more

    await h.feed([ev('UserPromptSubmit', NEW, { prompt_id: 'q' }), ev('PermissionRequest', NEW, { prompt_id: 'q', tool_name: 'Bash', tool_input: { command: 'npm test' } })]);
    const open = h.sessions.currentPermission(K_NEW)!;
    expect(open.summary).toBe('Bash: npm test');
    expect(h.collected.permissions.at(-1)).toMatchObject({ info: { sessionKey: K_NEW }, view: { origin: 'managed' } });   // offered for approval as a managed session
    // the old request's key cannot answer the new dialog
    const stale = await h.sessions.answerPermission(K_NEW, 'approve', null, oldRequest.correlationKey);
    expect(stale).toMatchObject({ ok: false, code: 'state_not_allowed', problem: expect.stringContaining('no longer the one that is open') });
    expect(h.managed.keys).toEqual([]);
    const ok = await h.sessions.answerPermission(K_NEW, 'approve', null, open.correlationKey);
    expect(ok).toEqual({ ok: true, submitted: true });
    expect(h.managed.keys).toEqual([{ key: K_NEW, keys: 'approve' }]);
    // and the old key refuses
    expect(await h.sessions.answerPermission(K_OLD, 'approve', null)).toMatchObject({ ok: false, code: 'not_live' });
  });

  it('text a person left on the input line is still guarded after the terminal moved to the new session (SEC-03)', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    h.managed.unsent.add(K_OLD);                                            // typed at the desktop terminal, not submitted
    l.set([agent(NEW)]);
    await h.feed(clear());
    await h.sessions.refreshDiscovery();
    expect(h.managed.unsent.has(K_NEW)).toBe(true);
    const refused = await h.sessions.typeInto(K_NEW, { text: 'would be appended to that line', submit: true, expectGeneration: null, allowedStates: ['idle', 'turn_ended'] });
    expect(refused).toMatchObject({ ok: false, code: 'state_not_allowed', problem: expect.stringContaining('has not pressed Enter') });
    expect(h.sessions.targetCheck(K_NEW, null).problem).toContain('has not pressed Enter');
    expect(h.managed.typed).toEqual([]);
  });

  it('a /resume back to the older id re-keys again, and the id that was left is history', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    l.set([agent(NEW)]);
    await h.feed(clear());
    await h.sessions.refreshDiscovery();
    await h.feed([ev('UserPromptSubmit', NEW, { prompt_id: 'q' }), ev('Stop', NEW, { prompt_id: 'q', last_assistant_message: 'ok' })]);

    l.set([agent(OLD)]);
    await h.feed([ev('SessionEnd', NEW, { reason: 'resume' }), ev('SessionStart', OLD, { source: 'resume' })]);
    await h.sessions.refreshDiscovery();
    expect(h.managed.rekeyCalls.at(-1)).toMatchObject({ from: K_NEW, toSessionId: OLD, prompted: true, leftBehindReason: `replaced:resume:${OLD}` });
    expect(h.view(K_OLD)).toMatchObject({ origin: 'managed', availability: 'live' });
    expect(h.view(K_NEW)).toMatchObject({ origin: 'managed', availability: 'resumable', termination: { reason: expect.stringContaining('/resume') } });
    expect(h.sessions.list().filter((s) => s.availability === 'live').map((s) => s.key)).toEqual([K_OLD]);
  });

  it('a rebuild of the whole log changes nothing: no second re-key, the same views', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    l.set([agent(NEW)]);
    await h.feed(clear());
    await h.sessions.refreshDiscovery();
    const before = JSON.stringify(h.sessions.list({ includeEnded: true }));
    await h.sessions.rebuild();
    expect(h.managed.rekeyCalls).toHaveLength(1);
    expect(JSON.stringify(h.sessions.list({ includeEnded: true }))).toBe(before);
  });

  it('survives the manager refusing: the terminal stays as it was (today\'s behaviour), nothing is invented', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    h.managed.refuseRekey = true;
    l.set([agent(NEW)]);
    await h.feed(clear());
    await h.sessions.refreshDiscovery();
    expect(h.managed.rekeyCalls.length).toBeGreaterThan(0);
    expect(h.view(K_OLD)).toMatchObject({ origin: 'managed', availability: 'live' });
    expect(h.view(K_NEW)).toMatchObject({ origin: 'external' });
    expect(h.log.count('warn')).toBeGreaterThan(0);
  });

  it('a session listed under another process is a stranger: the hooks cannot turn it into this terminal\'s successor', async () => {
    const { h, l } = await setup();
    await running(h);
    await listed(h, l);
    l.set([agent(NEW, STRANGER_PID)]);                                              // the parent link of that process is init: unrelated (see setup)
    await h.feed(clear());                                                  // a perfect-looking clear announcement
    await h.sessions.refreshDiscovery();
    expect(h.managed.rekeyCalls).toEqual([]);
    expect(h.view(K_NEW)).toMatchObject({ origin: 'external', availability: 'live' });
    expect(h.view(K_OLD)).toMatchObject({ origin: 'managed', availability: 'live' });
    // the same, with the terminal's own process listed under the stranger's id: that one is adopted, the stranger is not
    l.set([agent(NEW, STRANGER_PID), agent(S3, PID)]);
    await h.sessions.refreshDiscovery();
    expect(h.managed.rekeyCalls.map((c) => c.toSessionId)).toEqual([S3]);
  });
});

describe('adoption by the hooks, only where the process id cannot be compared', () => {
  it('adopts the one session that announced itself after the old one ended with /clear, when no listing is available', async () => {
    const { h } = await setup({ discovery: false });
    await running(h);
    await h.feed(clear());
    expect(h.managed.rekeyCalls).toEqual([{ from: K_OLD, toSessionId: NEW, leftBehindReason: `replaced:clear:${NEW}`, prompted: false }]);
    expect(h.view(K_NEW)).toMatchObject({ origin: 'managed', availability: 'live', state: 'idle', isProjectDefault: true });
    expect(h.view(K_OLD)).toMatchObject({ origin: 'managed', availability: 'resumable' });
  });

  it('adopts after a failed discovery call as well (a failed call observed nothing, so it is neither proof nor veto)', async () => {
    const { h, l } = await setup();
    await running(h);
    l.fail();
    await h.sessions.refreshDiscovery();
    await h.feed(clear());
    expect(h.managed.rekeyCalls).toHaveLength(1);
  });

  it('after the retries the listing never showed the process, the hooks decide (strictly)', async () => {
    const { h, l } = await setup({ continuation: { retryDelaysMs: [0], parentPid: () => undefined } });
    await running(h);
    l.set([]);                                                              // healthy, but it does not show the process
    await h.sessions.refreshDiscovery();
    await h.feed(clear());
    expect(h.managed.rekeyCalls).toEqual([]);                               // waiting for a fresh listing
    expect(h.view(K_OLD).stateLabel).toBe('Conversation replaced, learning the new session');
    // the one retry runs, the listing still does not show the process, the wait is over and the hooks (strictly) decide
    await waitFor(() => h.managed.rekeyCalls.length === 1, { what: 'the hooks to decide after the wait' });
    expect(l.calls).toHaveLength(2);                                        // the first listing and the one retry
  });

  it('a forged record does not adopt: no SessionEnd for the terminal, another registration, an old id claiming to be new', async () => {
    const { h } = await setup({ discovery: false });
    await running(h);
    // a start announcement from a stranger's hooks (not the managed registration)
    await h.feed([ev('SessionStart', NEW, { source: 'clear' }, { handler: 'h1' })]);
    // a start announcement with no end of the terminal's own session
    await h.feed([ev('SessionStart', S3, { source: 'clear' })]);
    expect(h.managed.rekeyCalls).toEqual([]);
    expect(h.view(K_OLD)).toMatchObject({ origin: 'managed', availability: 'live', state: 'turn_ended' });
    expect(h.view(keyOf('posix', S3))).toMatchObject({ origin: 'external' });
    // an end that came from another registration does not count either
    await h.feed([ev('SessionEnd', OLD, { reason: 'clear' }, { handler: 'h1' })]);
    expect(h.managed.rekeyCalls).toEqual([]);
  });

  it('a session of another environment is never adopted (win and WSL are never merged)', async () => {
    const { h } = await setup({ discovery: false });
    await running(h);
    await h.feed([ev('SessionEnd', OLD, { reason: 'clear' }), ev('SessionStart', NEW, { source: 'clear' }, { env: 'wsl:Ubuntu' })]);
    expect(h.managed.rekeyCalls).toEqual([]);
    expect(h.view(keyOf('wsl:Ubuntu', NEW))).toMatchObject({ origin: 'external' });
    expect(h.view(K_OLD).availability).toBe('live');
  });

  it('is honest when it cannot tell: two terminals in one folder both cleared, no process ids to settle it', async () => {
    const { h, l } = await setup({ discovery: false });
    const K_B = keyOf('posix', S3);
    await running(h);
    h.managed.seed({ key: K_B, projectId: 'p1', pid: B_PID, cwd: '/w/proj' }, true);
    await h.feed([ev('SessionStart', S3, { source: 'startup' })]);
    const NEW_B = '55555555-5555-4555-8555-555555555555';
    await h.feed([...clear(), ...clear(S3, NEW_B)]);
    expect(h.managed.rekeyCalls).toEqual([]);
    for (const k of [K_OLD, K_B]) {
      const v = h.view(k);
      expect(v).toMatchObject({ origin: 'managed', availability: 'live', state: 'ended', stateLabel: 'Conversation replaced, new session not identified' });
      expect(v.termination?.reason).toContain('cannot tell which new session');
      expect(h.sessions.targetCheck(k, null).problem).toContain('cannot tell which new session');
      expect(await h.sessions.typeInto(k, { text: 'x', submit: true, expectGeneration: null, allowedStates: ['idle', 'ended'] })).toMatchObject({ ok: false, code: 'state_not_allowed', problem: expect.stringContaining('cannot tell which new session') });
    }
    expect(h.view(K_NEW)).toMatchObject({ origin: 'external' });
    // a later answer from the process list settles it, without anyone guessing
    l.set([agent(NEW, PID), agent(NEW_B, B_PID)]);
    await h.sessions.refreshDiscovery();
    expect(h.managed.rekeyCalls.map((c) => [c.from, c.toSessionId])).toEqual([[K_OLD, NEW], [K_B, NEW_B]]);
    expect(h.view(K_OLD)).toMatchObject({ availability: 'resumable' });
    expect(h.view(K_NEW)).toMatchObject({ origin: 'managed', availability: 'live' });
    expect(h.view(keyOf('posix', NEW_B))).toMatchObject({ origin: 'managed', availability: 'live' });
  });
});

describe('ends that are not alarms', () => {
  it('a conversation replaced while Claude was working is not an abnormal end; any other end while working still is', async () => {
    const { h } = await setup({ discovery: false });
    h.managed.seed({ key: K_OLD, projectId: 'p1', pid: PID }, true);
    await h.feed([ev('SessionStart', OLD, { source: 'startup' }), ev('UserPromptSubmit', OLD, { prompt_id: 'p' }), ev('SessionEnd', OLD, { reason: 'clear' })]);
    const ended = h.collected.derived.find((d) => d.sessionKey === K_OLD && d.to === 'ended')!;
    expect(ended.abnormal).toBeFalsy();
    expect(ended.notify).toBe(false);
    expect(h.view(K_OLD).attention).toBeNull();

    await h.feed([ev('SessionStart', S3, { source: 'startup' }, { handler: 'h1' }), ev('UserPromptSubmit', S3, { prompt_id: 'x' }), ev('SessionEnd', S3, { reason: 'other' }, { handler: 'h1' })]);
    expect(h.collected.derived.find((d) => d.sessionKey === keyOf('posix', S3) && d.to === 'ended')).toMatchObject({ abnormal: true, notify: true });
    expect(h.view(keyOf('posix', S3)).attention).toMatchObject({ kind: 'abnormal_end' });
  });
});
