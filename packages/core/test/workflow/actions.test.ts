import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorRef, PendingActionStatus, SessionKey, SettingsPatch } from '@minisumma/shared';
import { createActionsService } from '../../src/workflow/actions.ts';
import type { DeliveryDetail } from '@minisumma/shared';
import { FakeDevices, FakeProjects, FakeSessions, KEY_A, KEY_B, KEY_C, KEY_EXT, deliveryDetail, fakeSettings, flush, hasEmDash, makeEnv, pendingActionIds, recordingActivity, reportSummary } from './helpers.ts';

const D: ActorRef = { kind: 'desktop' };
const PHONE: ActorRef = { kind: 'device', deviceId: 'dev_phone', name: 'Pixel' };
const TABLET: ActorRef = { kind: 'device', deviceId: 'dev_tablet', name: 'Tablet' };
const TRUSTED: ActorRef = { kind: 'device', deviceId: 'dev_trusted', name: 'Trusted phone' };
const SYSTEM: ActorRef = { kind: 'system' };
const ACCEPTS_INPUT = ['idle', 'waiting_for_you', 'turn_ended', 'report_ready'];
const NOW = '2026-10-30T10:00:00.000Z';
const LABEL = 'GitManager / a1b2c3d4';

function setup(over: { settings?: SettingsPatch; devices?: boolean; deliveries?: boolean; reports?: boolean; permissionActivity?: boolean } = {}) {
  const env = makeEnv(NOW);
  const settings = fakeSettings(over.settings);
  const sessions = new FakeSessions();
  const projects = new FakeProjects(env.db, env.clock);
  const gm = projects.addProject({ id: 'prj_gm', name: 'GitManager' });
  sessions.add({ key: KEY_A, projectId: gm.id, projectName: gm.name, generation: 1, state: 'idle' });
  sessions.add({ key: KEY_EXT, origin: 'external', projectId: gm.id, projectName: gm.name });
  const devices = new FakeDevices();
  devices.addDevice({ id: 'dev_phone', name: 'Pixel' });
  devices.addDevice({ id: 'dev_tablet', name: 'Tablet' });
  devices.addDevice({ id: 'dev_trusted', name: 'Trusted phone', trusted: true });
  const activity = recordingActivity(env);
  const followUps: { deliveryId: string; actionId: string }[] = [];
  let followUpError: Error | null = null;
  // a delivery of this project and session whose follow-up has not been drafted yet, and a report that exists
  const deliveryData = new Map<string, DeliveryDetail>([['dlv_1', deliveryDetail({ id: 'dlv_1', projectId: gm.id, sessionKey: KEY_A })]]);
  const knownReports = new Set(['rep_1']);
  const deliveries = {
    get: (id: string) => deliveryData.get(id) ?? null,
    markFollowUpSent: (deliveryId: string, actionId: string) => { followUps.push({ deliveryId, actionId }); if (followUpError) throw followUpError; return null; },
  };
  const reports = { summary: (id: string) => (knownReports.has(id) ? reportSummary({ id }) : null) };
  const svc = createActionsService({
    base: env.base, settings, sessions, activity: activity.service,
    devices: over.devices === false ? undefined : devices, deliveries: over.deliveries === false ? undefined : deliveries,
    reports: over.reports === false ? undefined : reports,
    recordPermissionActivity: over.permissionActivity,
  });
  const prompt = (actor: ActorRef, extra: Partial<Parameters<typeof svc.createPrompt>[0]> = {}) =>
    svc.createPrompt({ sessionKey: KEY_A, text: 'Run the tests again', actor, ...extra });
  /** What the glue does for each PermissionRequest hook: the session shows that request as the open one, then an item is raised. */
  const permission = (extra: Partial<Parameters<typeof svc.raisePermission>[0]> = {}) => {
    const input = { sessionKey: KEY_A, generation: 1, summary: 'Bash: rm -rf build', correlationKey: 'derived_1', projectId: gm.id, ...extra };
    sessions.patch(input.sessionKey, { state: 'needs_permission', stateLabel: 'Needs permission' });
    sessions.permissions.set(input.sessionKey, { correlationKey: input.correlationKey, summary: input.summary });
    return svc.raisePermission(input);
  };
  const statuses = (id: string): PendingActionStatus[] => pendingActionIds(env.events).filter((e) => e.id === id).map((e) => e.status);
  const row = (id: string) => env.db.get<Record<string, unknown>>('SELECT * FROM pending_actions WHERE id = ?', [id])!;
  const rows = () => env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pending_actions')!.n;
  const failure = async (fn: () => unknown) => {
    try { await Promise.resolve().then(fn); } catch (err) { return err as { status: number; code: string; message: string }; }
    throw new Error('expected the call to be refused');
  };
  return {
    env, settings, sessions, devices, svc, activity, followUps, prompt, permission, statuses, row, rows, failure, projects, deliveryData, knownReports,
    setFollowUpError: (e: Error | null) => { followUpError = e; },
    expectNoLoggedErrors: () => expect(env.log.errors()).toEqual([]),
  };
}


afterEach(() => { vi.useRealTimers(); });

describe('actions: a click on the desktop is the approval', () => {
  it('creates the prompt as approved, types it at once and records what happened', async () => {
    const t = setup();
    const action = await t.prompt(D);
    expect(action).toMatchObject({
      kind: 'claude_prompt', status: 'executed', projectId: 'prj_gm', projectName: 'GitManager', sessionKey: KEY_A, generation: 1, text: 'Run the tests again',
      summary: 'Run the tests again', reportId: null, deliveryId: null, createdAt: NOW, createdBy: D, approvableBy: 'desktop', decidedAt: NOW, decidedBy: D,
      executedAt: NOW, failure: null, expiresAt: '2026-10-30T11:00:00.000Z', target: { managed: true, live: true, generation: 1, generationMatches: true, problem: null },
    });
    expect(t.sessions.typeCalls).toEqual([{ key: KEY_A, req: { text: 'Run the tests again', submit: true, expectGeneration: 1, allowedStates: ACCEPTS_INPUT } }]);
    expect(t.sessions.typed).toEqual([{ key: KEY_A, text: 'Run the tests again', submit: true }]);
    expect(t.statuses(action.id)).toEqual(['approved', 'executed']);
    expect(t.svc.get(action.id)).toEqual(action);
    expect(t.activity.recorded).toEqual([expect.objectContaining({
      id: `actres_${action.id}`, type: 'action_result', severity: 'info', title: `Prompt sent to ${LABEL}`, source: 'action', sessionKey: KEY_A, projectId: 'prj_gm',
      projectName: 'GitManager',
    })]);
    expect(t.activity.recorded[0].requiresAction).toBeFalsy();
    expect(t.activity.recorded[0].links).toEqual([{ kind: 'project', id: 'prj_gm' }, { kind: 'session', key: KEY_A }]);
    t.expectNoLoggedErrors();
  });

  it('can type without pressing Enter, and carries the report and delivery it was made from', async () => {
    const t = setup();
    t.deliveryData.set('dlv_1', deliveryDetail({ id: 'dlv_1', projectId: 'prj_gm', sessionKey: KEY_A, followUpDraft: 'Draft for the terminal' }));
    const action = await t.prompt(D, { submit: false, reportId: 'rep_1', deliveryId: 'dlv_1', text: 'Draft for the terminal' });
    expect(t.sessions.typed).toEqual([{ key: KEY_A, text: 'Draft for the terminal', submit: false }]);
    expect(action).toMatchObject({ status: 'executed', reportId: 'rep_1', deliveryId: 'dlv_1' });
    expect(t.activity.recorded[0].links).toEqual([{ kind: 'project', id: 'prj_gm' }, { kind: 'session', key: KEY_A }, { kind: 'report', id: 'rep_1' }, { kind: 'delivery', id: 'dlv_1' }]);
    expect(t.followUps).toEqual([{ deliveryId: 'dlv_1', actionId: action.id }]);
  });

  it('uses the session\'s current generation when none is given, and the given one otherwise', async () => {
    const t = setup();
    t.sessions.patch(KEY_A, { generation: 3 });
    const a = await t.prompt(D);
    expect(a.generation).toBe(3);
    expect(t.sessions.typeCalls[0].req.expectGeneration).toBe(3);
    const b = await t.prompt(D, { expectGeneration: 3 });
    expect(b.status).toBe('executed');
    const err = await t.failure(() => t.prompt(D, { expectGeneration: 2 }));
    expect(err).toMatchObject({ status: 422, code: 'target_generation_changed' });
    expect(t.rows()).toBe(2);
  });

  it('summarises by the first line, shortened', async () => {
    const t = setup();
    expect((await t.prompt(D, { text: '\n  Fix the bug  \nsecond line' })).summary).toBe('Fix the bug');
    const long = (await t.prompt(D, { text: 'x'.repeat(400) })).summary;
    expect(long).toHaveLength(160);
    expect(long.endsWith('...')).toBe(true);
  });

  it('keeps the exact text it was given', async () => {
    const t = setup();
    const text = '  line one\r\n\r\n  line two with  spaces\t\n';
    const action = await t.prompt(D, { text });
    expect(action.text).toBe(text);
    expect(t.sessions.typed[0].text).toBe(text);
  });

  it('is refused for text with nothing in it, and for a system actor', async () => {
    const t = setup();
    for (const text of ['', '   ', '\n\t']) expect(await t.failure(() => t.prompt(D, { text }))).toMatchObject({ status: 400, code: 'empty_prompt' });
    expect(await t.failure(() => t.prompt(SYSTEM))).toMatchObject({ status: 403, code: 'actor_not_allowed' });
    expect(t.rows()).toBe(0);
    expect(t.sessions.typeCalls).toEqual([]);
  });
});

describe('actions: the target must be a managed, live session of the expected generation', () => {
  it('refuses a session Mini-Summa did not start, says it is only observed, and mentions Remote Control', async () => {
    const t = setup();
    const err = await t.failure(() => t.prompt(D, { sessionKey: KEY_EXT }));
    expect(err).toMatchObject({ status: 422, code: 'target_not_managed' });
    expect(err.message).toMatch(/not started by Mini-Summa/);
    expect(err.message).toMatch(/only observes/);
    expect(err.message).toMatch(/Remote Control/);
    expect(err.message).toMatch(/Claude app/);
    expect(hasEmDash(err.message)).toBe(false);
    expect(t.rows()).toBe(0);
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it('does not repeat the Remote Control hint when the session layer already said it', async () => {
    const t = setup();
    const said = 'This session is observed only. Remote Control can control it from the Claude app.';
    const real = t.sessions.targetCheck;
    t.sessions.targetCheck = (key, g) => ({ ...real(key, g), problem: said });
    const err = await t.failure(() => t.prompt(D, { sessionKey: KEY_EXT }));
    expect(err.message).toBe(said);
  });

  it('refuses a session it has never heard of, a session that is not running, and a stale generation', async () => {
    const t = setup();
    expect(await t.failure(() => t.prompt(D, { sessionKey: KEY_B }))).toMatchObject({ status: 422, code: 'target_not_managed', message: expect.stringContaining('does not know this session') });
    t.sessions.patch(KEY_A, { availability: 'resumable' });
    const notLive = await t.failure(() => t.prompt(D));
    expect(notLive).toMatchObject({ status: 422, code: 'target_not_live', message: 'This session is not running right now.' });
    t.sessions.patch(KEY_A, { availability: 'live', generation: 2 });
    const stale = await t.failure(() => t.prompt(D, { expectGeneration: 1 }));
    expect(stale).toMatchObject({ status: 422, code: 'target_generation_changed' });
    expect(stale.message).toMatch(/restarted/);
    expect(t.rows()).toBe(0);
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it('returns the check in the error details so a client can show it', async () => {
    const t = setup();
    t.sessions.patch(KEY_A, { availability: 'resumable' });
    const err = await t.failure(() => t.prompt(D)) as unknown as { details: { target: { live: boolean } } };
    expect(err.details.target.live).toBe(false);
  });
});

describe('actions: a prompt from another device waits for approval', () => {
  it('is pending, approvable by the desktop or another device, expires after the configured time, and types nothing', async () => {
    const t = setup({ settings: { mobile: { promptActionTtlMinutes: 15 } } });
    const action = await t.prompt(PHONE);
    expect(action).toMatchObject({
      status: 'pending', createdBy: PHONE, approvableBy: 'desktop_or_other_device', decidedAt: null, decidedBy: null, executedAt: null, failure: null,
      expiresAt: '2026-10-30T10:15:00.000Z', text: 'Run the tests again',
    });
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.statuses(action.id)).toEqual(['pending']);
    expect(t.activity.recorded).toEqual([]); // the glue records the "waiting for approval" entry for these
    expect(t.svc.list({ status: 'pending' }).map((a) => a.id)).toEqual([action.id]);
  });

  it('the desktop approves it, and only then is it typed', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.clock.advance(60_000);
    const done = await t.svc.approve(pending.id, D);
    expect(done).toMatchObject({ status: 'executed', decidedBy: D, decidedAt: '2026-10-30T10:01:00.000Z', executedAt: '2026-10-30T10:01:00.000Z', createdBy: PHONE });
    expect(t.sessions.typeCalls).toEqual([{ key: KEY_A, req: { text: 'Run the tests again', submit: true, expectGeneration: 1, allowedStates: ACCEPTS_INPUT } }]);
    expect(t.statuses(pending.id)).toEqual(['pending', 'approved', 'executed']);
    expect(t.followUps).toEqual([]);
    expect(t.activity.recorded.map((r) => r.title)).toEqual([`Prompt sent to ${LABEL}`]);
    expect(t.activity.resolved).toEqual([[{ ids: [`act_${pending.id}`] }]]);
  });

  it('another device may approve it, but not the one that made it', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    const err = await t.failure(() => t.svc.approve(pending.id, PHONE));
    expect(err).toMatchObject({ status: 403, code: 'self_approval' });
    expect(err.message).toMatch(/cannot approve its own prompt/);
    expect(t.svc.get(pending.id)!.status).toBe('pending');
    expect(t.sessions.typeCalls).toEqual([]);
    expect((await t.svc.approve(pending.id, TABLET)).status).toBe('executed');
  });

  it('a device that was trusted after it asked may approve its own prompt', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.devices.devices.set('dev_phone', { ...t.devices.devices.get('dev_phone')!, trusted: true });
    expect((await t.svc.approve(pending.id, PHONE)).status).toBe('executed');
  });

  it('a trusted device is executed at once, and the record says who decided', async () => {
    const t = setup();
    const action = await t.prompt(TRUSTED);
    expect(action).toMatchObject({ status: 'executed', createdBy: TRUSTED, decidedBy: TRUSTED, approvableBy: 'desktop_or_other_device' });
    expect(t.sessions.typed).toHaveLength(1);
    expect(t.statuses(action.id)).toEqual(['approved', 'executed']);
  });

  it('is never trusted when the device was revoked, is unknown, or the service has no device list', async () => {
    const revoked = setup();
    revoked.devices.devices.set('dev_trusted', { ...revoked.devices.devices.get('dev_trusted')!, revokedAt: NOW });
    expect((await revoked.prompt(TRUSTED)).status).toBe('pending');
    const unknown = setup();
    expect((await unknown.prompt({ kind: 'device', deviceId: 'dev_ghost', name: 'Ghost' })).status).toBe('pending');
    const blind = setup({ devices: false });
    expect((await blind.prompt(TRUSTED)).status).toBe('pending');
    for (const t of [revoked, unknown, blind]) expect(t.sessions.typeCalls).toEqual([]);
  });

  it('is always submitted: typing without Enter is a desktop option', async () => {
    const t = setup();
    expect(await t.failure(() => t.prompt(PHONE, { submit: false }))).toMatchObject({ status: 400, code: 'submit_not_allowed' });
    expect(await t.failure(() => t.prompt(TRUSTED, { submit: false }))).toMatchObject({ status: 400, code: 'submit_not_allowed' });
    expect(t.rows()).toBe(0);
  });

  it('may be cancelled by the device that made it', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    expect(t.svc.reject(pending.id, PHONE, 'changed my mind')).toMatchObject({ status: 'rejected', decidedBy: PHONE });
    expect(t.sessions.typeCalls).toEqual([]);
  });
});

describe('actions: the target is checked again at the moment of execution', () => {
  it('a session resumed in between (new generation) fails the action and types nothing', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.sessions.patch(KEY_A, { generation: 2 });
    const done = await t.svc.approve(pending.id, D);
    expect(done.status).toBe('failed');
    expect(done.failure).toMatch(/restarted/);
    expect(done.executedAt).toBeNull();
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.statuses(pending.id)).toEqual(['pending', 'approved', 'failed']);
    expect(t.activity.recorded).toEqual([expect.objectContaining({
      id: `actres_${pending.id}`, severity: 'error', requiresAction: true, title: `Could not send the prompt to ${LABEL}`,
    })]);
    expect(t.activity.recorded[0].description).toMatch(/restarted/);
    expect(t.activity.recorded[0].description).toMatch(/does not retry on its own/);
    expect(t.followUps).toEqual([]);
  });

  it('a session that is no longer running, or no longer managed, fails it with the reason', async () => {
    const gone = setup();
    const a = await gone.prompt(PHONE);
    gone.sessions.patch(KEY_A, { availability: 'resumable' });
    expect(await gone.svc.approve(a.id, D)).toMatchObject({ status: 'failed', failure: 'This session is not running right now.' });
    const external = setup();
    const b = await external.prompt(PHONE);
    external.sessions.patch(KEY_A, { origin: 'external' });
    const result = await external.svc.approve(b.id, D);
    expect(result.status).toBe('failed');
    expect(result.failure).toMatch(/Remote Control/);
    expect(gone.sessions.typeCalls).toEqual([]);
    expect(external.sessions.typeCalls).toEqual([]);
  });

  it('a session busy working is not typed into: the action fails with the host\'s reason', async () => {
    const t = setup();
    t.sessions.patch(KEY_A, { state: 'working', stateLabel: 'Working' });
    const action = await t.prompt(D);
    expect(action).toMatchObject({ status: 'failed', failure: 'Claude is busy (Working), so nothing was typed.', executedAt: null });
    expect(t.sessions.typed).toEqual([]);
    expect(t.statuses(action.id)).toEqual(['approved', 'failed']);
  });

  it('a refusal inside typeInto (it re-verifies too) fails the action with its words', async () => {
    const t = setup();
    t.sessions.typeHook = () => ({ ok: false, code: 'generation_changed', problem: 'The session was resumed a moment ago.' });
    expect(await t.prompt(D)).toMatchObject({ status: 'failed', failure: 'The session was resumed a moment ago.' });
  });

  it('a typeInto that throws fails the action and never types twice', async () => {
    const t = setup();
    t.sessions.typeHook = () => { throw new Error('pty closed'); };
    const action = await t.prompt(D);
    expect(action.status).toBe('failed');
    expect(action.failure).toMatch(/pty closed/);
    expect(action.failure).toMatch(/Look at the terminal/);
    expect(t.sessions.typeCalls).toHaveLength(1);
  });

  it('is never retried: a failed action stays failed whatever happens next', async () => {
    const t = setup();
    t.sessions.typeHook = () => ({ ok: false, code: 'no_terminal', problem: 'The terminal is gone.' });
    const failed = await t.prompt(D);
    t.sessions.typeHook = null;
    t.svc.init();
    await t.svc.approve(failed.id, D).catch(() => undefined);
    t.svc.expireDue();
    t.env.clock.advance(3 * 3600_000);
    t.svc.expireDue();
    t.svc.shutdown();
    expect(t.sessions.typeCalls).toHaveLength(1);
    expect(t.svc.get(failed.id)!.status).toBe('failed');
  });

  it('does not let a broken follow-up bookkeeping hide that the prompt was typed', async () => {
    const t = setup();
    t.setFollowUpError(new Error('delivery store is down'));
    t.deliveryData.set('dlv_1', deliveryDetail({ id: 'dlv_1', projectId: 'prj_gm', sessionKey: KEY_A, followUpDraft: 'Run the tests again' }));
    const action = await t.prompt(D, { deliveryId: 'dlv_1' });
    expect(action.status).toBe('executed');
    expect(t.env.log.errors()).toHaveLength(1);
  });

  it('does not let a broken feed hide that the prompt was typed either', async () => {
    const t = setup();
    const env = t.env;
    const svc = createActionsService({
      base: env.base, settings: fakeSettings(), sessions: t.sessions,
      activity: { record: () => { throw new Error('feed is down'); }, resolve: () => { throw new Error('feed is down'); } },
    });
    const action = await svc.createPrompt({ sessionKey: KEY_A, text: 'hello', actor: D });
    expect(action.status).toBe('executed');
    expect(t.sessions.typed).toHaveLength(1);
    expect(env.log.errors().length).toBeGreaterThan(0);
  });
});

describe('actions: deciding', () => {
  it('only a pending action can be approved or rejected', async () => {
    const t = setup();
    const done = await t.prompt(D);
    for (const call of [() => t.svc.approve(done.id, D), () => t.svc.reject(done.id, D)]) {
      expect(await t.failure(call)).toMatchObject({ status: 409, code: 'action_not_pending', message: expect.stringContaining('already executed') });
    }
    const pending = await t.prompt(PHONE);
    t.svc.reject(pending.id, D);
    expect(await t.failure(() => t.svc.approve(pending.id, D))).toMatchObject({ status: 409, code: 'action_not_pending', message: expect.stringContaining('already rejected') });
    expect(await t.failure(() => t.svc.approve('act_nope', D))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await t.failure(() => t.svc.reject('act_nope', D))).toMatchObject({ status: 404 });
    expect(t.sessions.typeCalls).toHaveLength(1);
  });

  it('a system actor can neither approve nor reject', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    expect(await t.failure(() => t.svc.approve(pending.id, SYSTEM))).toMatchObject({ status: 403, code: 'actor_not_allowed' });
    expect(await t.failure(() => t.svc.reject(pending.id, SYSTEM))).toMatchObject({ status: 403, code: 'actor_not_allowed' });
    expect(t.svc.get(pending.id)!.status).toBe('pending');
  });

  it('an action only the desktop may decide is refused to devices', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.db.run(`UPDATE pending_actions SET approvable_by = 'desktop' WHERE id = ?`, [pending.id]);
    expect(await t.failure(() => t.svc.approve(pending.id, TABLET))).toMatchObject({ status: 403, code: 'desktop_only' });
    expect(await t.failure(() => t.svc.reject(pending.id, TABLET))).toMatchObject({ status: 403, code: 'desktop_only' });
    expect((await t.svc.approve(pending.id, D)).status).toBe('executed');
  });

  it('two approvals at the same moment type once: the second is told it was decided', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.sessions.typeHook = async (call) => { await gate; t.sessions.typed.push({ key: call.key, text: call.req.text, submit: call.req.submit }); return { ok: true, submitted: true }; };
    const first = t.svc.approve(pending.id, D);
    const second = t.svc.approve(pending.id, TABLET);
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'action_not_pending' });
    expect(t.sessions.typeCalls).toHaveLength(1);
    expect(t.sessions.typed).toHaveLength(1);
  });

  it('rejecting types nothing, records who and why, and tells the feed', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.clock.advance(1000);
    const rejected = t.svc.reject(pending.id, D, '  not now  ');
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: D, decidedAt: '2026-10-30T10:00:01.000Z', executedAt: null, failure: null });
    await flush();
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.sessions.answerCalls).toEqual([]);
    expect(t.statuses(pending.id)).toEqual(['pending', 'rejected']);
    expect(t.activity.recorded).toEqual([expect.objectContaining({
      title: `Prompt to ${LABEL} was rejected`, severity: 'info', description: 'not now. Nothing was typed.',
    })]);
    expect(t.activity.resolved).toEqual([[{ ids: [`act_${pending.id}`] }]]);
  });

  it('an approval that comes too late finds the request expired and types nothing', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.clock.advance(61 * 60_000);
    const err = await t.failure(() => t.svc.approve(pending.id, D));
    expect(err).toMatchObject({ status: 409, code: 'action_expired' });
    expect(t.svc.get(pending.id)!.status).toBe('expired');
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.statuses(pending.id)).toEqual(['pending', 'expired']);
  });
});

describe('actions: permission requests', () => {
  it('raises a pending request for a managed live session, open to any approver, and puts it in the feed', () => {
    const t = setup();
    const action = t.permission()!;
    expect(action).toMatchObject({
      kind: 'permission', status: 'pending', projectId: 'prj_gm', projectName: 'GitManager', sessionKey: KEY_A, generation: 1, text: null, summary: 'Bash: rm -rf build',
      reportId: null, deliveryId: null, createdBy: SYSTEM, approvableBy: 'any_approver', decidedAt: null, expiresAt: '2026-10-30T11:00:00.000Z',
    });
    expect(t.statuses(action.id)).toEqual(['pending']);
    expect(t.activity.recorded).toEqual([expect.objectContaining({
      id: `act_${action.id}`, type: 'action_pending', severity: 'attention', requiresAction: true, title: `Permission needed in ${LABEL}`, description: 'Bash: rm -rf build',
      links: [{ kind: 'project', id: 'prj_gm' }, { kind: 'session', key: KEY_A }, { kind: 'action', id: action.id }],
    })]);
    expect(t.env.of('activity.added')).toHaveLength(1);
    t.expectNoLoggedErrors();
  });

  it('can leave the feed entry to the glue', () => {
    const t = setup({ permissionActivity: false });
    expect(t.permission()).not.toBeNull();
    expect(t.activity.recorded).toEqual([]);
  });

  it('is idempotent by correlation key, even after it was decided', async () => {
    const t = setup();
    const first = t.permission()!;
    t.env.clearEvents();
    expect(t.permission()).toEqual(first);
    expect(t.rows()).toBe(1);
    expect(t.env.events).toEqual([]);
    expect(t.activity.recorded).toHaveLength(1);
    await t.svc.approve(first.id, D);
    const again = t.permission();
    expect(again!.id).toBe(first.id);
    expect(again!.status).toBe('executed');
    expect(t.rows()).toBe(1);
    expect(t.permission({ correlationKey: 'derived_2' })!.id).not.toBe(first.id);
  });

  it('is raised only for managed, live sessions of the generation named', () => {
    const t = setup();
    expect(t.svc.raisePermission({ sessionKey: KEY_EXT, generation: 1, summary: 'x', correlationKey: 'e', projectId: null })).toBeNull();
    expect(t.svc.raisePermission({ sessionKey: KEY_B, generation: 1, summary: 'x', correlationKey: 'u', projectId: null })).toBeNull();
    t.sessions.patch(KEY_A, { availability: 'disconnected' });
    expect(t.permission({ correlationKey: 'n' })).toBeNull();
    t.sessions.patch(KEY_A, { availability: 'live', generation: 2 });
    expect(t.permission({ correlationKey: 'g', generation: 1 })).toBeNull();
    expect(t.rows()).toBe(0);
    expect(t.activity.recorded).toEqual([]);
  });

  it('gives a blank summary a plain one', () => {
    const t = setup();
    expect(t.permission({ summary: '  ' })!.summary).toBe('Permission requested');
  });

  it('approving types the approve keys, runs the check first, and resolves the feed entry', async () => {
    const t = setup();
    const action = t.permission()!;
    const done = await t.svc.approve(action.id, D);
    expect(done).toMatchObject({ status: 'executed', decidedBy: D });
    expect(t.sessions.answerCalls).toEqual([{ key: KEY_A, decision: 'approve', expectGeneration: 1, expectRequestKey: 'derived_1' }]);
    expect(t.sessions.answers).toEqual([{ key: KEY_A, decision: 'approve' }]);
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.statuses(action.id)).toEqual(['pending', 'approved', 'executed']);
    expect(t.activity.resolved).toEqual([[{ ids: [`act_${action.id}`] }]]);
    expect(t.activity.recorded.map((r) => r.title)).toEqual([`Permission needed in ${LABEL}`, `Permission approved in ${LABEL}`]);
    expect(t.env.of('activity.updated')).toHaveLength(1); // the "needs permission" entry is closed
  });

  it('any approver may approve it, a phone included', async () => {
    const t = setup();
    expect((await t.svc.approve(t.permission()!.id, PHONE)).status).toBe('executed');
  });

  it('fails with the reason when answering is refused, and records an error that needs action', async () => {
    const t = setup();
    const action = t.permission()!;
    t.sessions.answerHook = () => ({ ok: false, code: 'state_not_allowed', problem: 'Claude is not asking for permission right now.' });
    const done = await t.svc.approve(action.id, D);
    expect(done).toMatchObject({ status: 'failed', failure: 'Claude is not asking for permission right now.' });
    const result = t.activity.recorded.at(-1)!;
    expect(result).toMatchObject({ type: 'action_result', severity: 'error', requiresAction: true, title: `Could not answer the permission prompt in ${LABEL}` });
    expect(result.description).toMatch(/Answer it in the terminal/);
    expect(result.links).not.toContainEqual({ kind: 'action', id: action.id }); // the glue resolves action-linked entries; a failure must stay open
  });

  it('fails when answering throws, or the session is gone', async () => {
    const thrown = setup();
    const a = thrown.permission()!;
    thrown.sessions.answerHook = () => { throw new Error('pty closed'); };
    expect((await thrown.svc.approve(a.id, D)).failure).toMatch(/pty closed/);
    const gone = setup();
    const b = gone.permission()!;
    gone.sessions.patch(KEY_A, { availability: 'resumable' });
    expect(await gone.svc.approve(b.id, D)).toMatchObject({ status: 'failed', failure: 'This session is not running right now.' });
    expect(gone.sessions.answerCalls).toEqual([]);
  });

  it('is refused and superseded, not answered, when Claude has already moved on by the time it is approved', async () => {
    const t = setup();
    const action = t.permission()!;
    t.sessions.permissions.delete(KEY_A); // the session no longer shows any open request
    t.sessions.patch(KEY_A, { state: 'working', stateLabel: 'Working' });
    const err = await t.failure(() => t.svc.approve(action.id, D));
    expect(err).toMatchObject({ status: 409, code: 'permission_changed', message: 'That request is no longer the one that is open. Look at the terminal.' });
    expect(t.svc.get(action.id)).toMatchObject({ status: 'superseded', decidedBy: SYSTEM, executedAt: null });
    expect(t.sessions.answerCalls).toEqual([]);
    expect(t.statuses(action.id)).toEqual(['pending', 'superseded']);
    expect(t.activity.resolved.flatMap((r) => r[0].ids ?? [])).toContain(`act_${action.id}`);
  });

  it('still does not answer when the session reports the request as open but is no longer asking (second line of defence)', async () => {
    const t = setup();
    const action = t.permission()!;
    t.sessions.patch(KEY_A, { state: 'working', stateLabel: 'Working' }); // the request key is still there, the state says otherwise
    const done = await t.svc.approve(action.id, D);
    expect(done.status).toBe('superseded');
    expect(t.sessions.answerCalls).toEqual([]);
    expect(t.statuses(action.id)).toEqual(['pending', 'approved', 'superseded']);
  });

  it('is superseded when the session leaves needs_permission or ends, which closes the feed entry too', () => {
    const t = setup();
    t.sessions.add({ key: KEY_B, projectId: 'prj_gm', projectName: 'GitManager', origin: 'managed', state: 'needs_permission' });
    const a = t.permission()!;
    const b = t.svc.raisePermission({ sessionKey: KEY_B, generation: 1, summary: 'y', correlationKey: 'derived_b', projectId: 'prj_gm' })!;
    t.env.clearEvents();
    t.svc.supersedeOpenFor(KEY_A, 'The session moved on.');
    expect(t.svc.get(a.id)).toMatchObject({ status: 'superseded', decidedBy: SYSTEM, executedAt: null });
    expect(t.svc.get(b.id)!.status).toBe('pending'); // another session's request is not touched
    expect(pendingActionIds(t.env.events)).toEqual([{ id: a.id, status: 'superseded' }]);
    expect(t.activity.resolved.flatMap((r) => r[0].ids ?? [])).toEqual([`act_${a.id}`]);
    expect(t.env.of('activity.updated')).toHaveLength(1);
    t.env.clearEvents();
    t.svc.supersedeOpenFor(KEY_A, 'again');
    expect(t.env.events).toEqual([]);
    // and a replay of the same event does not bring it back
    expect(t.permission()!.status).toBe('superseded');
    expect(t.rows()).toBe(2);
  });

  it('leaves everything else alone when superseding: other sessions, prompts and requests already decided', async () => {
    const t = setup();
    t.sessions.add({ key: KEY_B, projectId: 'prj_gm', projectName: 'GitManager', origin: 'managed', state: 'needs_permission' });
    const other = t.svc.raisePermission({ sessionKey: KEY_B, generation: 1, summary: 'x', correlationKey: 'other', projectId: 'prj_gm' })!;
    const prompt = await t.prompt(PHONE);
    const decided = t.permission()!;
    await t.svc.approve(decided.id, D);
    const open = t.permission({ correlationKey: 'derived_9' })!;
    t.svc.supersedeOpenFor(KEY_A, 'moved on');
    expect(t.svc.get(open.id)!.status).toBe('superseded');
    expect(t.svc.get(other.id)!.status).toBe('pending');
    expect(t.svc.get(prompt.id)!.status).toBe('pending');
    expect(t.svc.get(decided.id)!.status).toBe('executed');
  });

  it('rejecting says no in the terminal too, in the background, only while Claude is still asking', async () => {
    const t = setup();
    const action = t.permission()!;
    const rejected = t.svc.reject(action.id, PHONE, 'too risky');
    expect(rejected.status).toBe('rejected');
    await flush();
    expect(t.sessions.answerCalls).toEqual([{ key: KEY_A, decision: 'reject', expectGeneration: 1, expectRequestKey: 'derived_1' }]);
    expect(t.sessions.answers).toEqual([{ key: KEY_A, decision: 'reject' }]);
    expect(t.statuses(action.id)).toEqual(['pending', 'rejected']);
    expect(t.activity.recorded.at(-1)).toMatchObject({ title: `Permission rejected in ${LABEL}` });
    expect(t.activity.recorded.at(-1)!.description).toMatch(/answering no in the terminal/);

    const moved = setup();
    const b = moved.permission()!;
    moved.sessions.patch(KEY_A, { state: 'working', stateLabel: 'Working' });
    moved.svc.reject(b.id, D);
    await flush();
    expect(moved.sessions.answerCalls).toEqual([]);
  });

  it('says so when it could not answer no, and does not pretend it did', async () => {
    const t = setup();
    const action = t.permission()!;
    t.sessions.answerHook = () => ({ ok: false, code: 'no_terminal', problem: 'The terminal is gone.' });
    t.svc.reject(action.id, D);
    await flush();
    const err = t.activity.recorded.at(-1)!;
    expect(err).toMatchObject({ id: `actdeny_${action.id}`, severity: 'error', requiresAction: true, title: `Could not answer no in ${LABEL}` });
    expect(err.description).toMatch(/The terminal is gone\. Answer the permission prompt in the terminal yourself/);
    const thrown = setup();
    const b = thrown.permission()!;
    thrown.sessions.answerHook = () => { throw new Error('boom'); };
    thrown.svc.reject(b.id, D);
    await flush();
    expect(thrown.activity.recorded.at(-1)).toMatchObject({ id: `actdeny_${b.id}`, severity: 'error' });
  });
});

describe('actions: expiry', () => {
  it('expires pending actions that are overdue and nothing else, once', async () => {
    const t = setup({ settings: { mobile: { promptActionTtlMinutes: 10 } } });
    const early = await t.prompt(PHONE);
    t.env.clock.advance(5 * 60_000);
    const later = await t.prompt(TABLET);
    const done = await t.prompt(D); // typed at once (raising a permission request below puts the session in needs_permission)
    const permission = t.permission()!;
    t.env.clock.advance(5 * 60_000); // 10 minutes after the first
    expect(t.svc.expireDue()).toBe(1);
    expect(t.svc.get(early.id)).toMatchObject({ status: 'expired', decidedAt: null, decidedBy: null, executedAt: null });
    expect([later.id, permission.id].map((id) => t.svc.get(id)!.status)).toEqual(['pending', 'pending']);
    expect(t.svc.get(done.id)!.status).toBe('executed');
    expect(t.svc.expireDue()).toBe(0);
    t.env.clock.advance(60 * 60_000);
    expect(t.svc.expireDue()).toBe(2);
    expect(t.svc.expireDue()).toBe(0);
    expect(t.sessions.typeCalls).toHaveLength(1); // only the desktop prompt
  });

  it('closes the waiting entry and says in the feed that nothing was typed', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.clock.advance(61 * 60_000);
    t.svc.expireDue();
    expect(t.activity.resolved).toEqual([[{ ids: [`act_${pending.id}`] }]]);
    expect(t.activity.recorded).toEqual([expect.objectContaining({
      id: `actres_${pending.id}`, severity: 'attention', title: `Prompt to ${LABEL} expired without approval`, description: 'Nobody approved it in time, so nothing was typed.',
    })]);
    expect(t.activity.recorded[0].requiresAction).toBeFalsy();
    expect(t.statuses(pending.id)).toEqual(['pending', 'expired']);
    const p = setup();
    const permission = p.permission()!;
    p.env.clock.advance(61 * 60_000);
    p.svc.expireDue();
    expect(p.activity.recorded.at(-1)!.title).toBe(`Permission request in ${LABEL} expired`);
    expect(p.activity.recorded.at(-1)!.description).toMatch(/may still be waiting in the terminal/);
    expect(p.svc.get(permission.id)!.status).toBe('expired');
  });

  it('runs on a 30 second timer between init and shutdown, and init twice starts one timer', async () => {
    vi.useFakeTimers();
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.svc.init();
    t.svc.init();
    expect(vi.getTimerCount()).toBe(1);
    t.env.clock.advance(61 * 60_000);
    expect(t.svc.get(pending.id)!.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.svc.get(pending.id)!.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(t.svc.get(pending.id)!.status).toBe('expired');
    t.svc.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    const later = await t.prompt(PHONE);
    t.env.clock.advance(61 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.svc.get(later.id)!.status).toBe('pending');
    t.svc.shutdown(); // harmless twice
    t.svc.init(); // and can start again
    expect(vi.getTimerCount()).toBe(1);
    t.svc.shutdown();
  });

  it('expires what is already overdue the moment it starts', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.clock.advance(2 * 3600_000);
    t.svc.init();
    expect(t.svc.get(pending.id)!.status).toBe('expired');
    t.svc.shutdown();
  });

  it('settles an action a previous run left half way, as failed and never retried', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.db.run(`UPDATE pending_actions SET status = 'approved', decided_at = ?, decided_by_json = ? WHERE id = ?`, [NOW, JSON.stringify(D), pending.id]);
    t.env.clearEvents();
    t.svc.init();
    const settled = t.svc.get(pending.id)!;
    expect(settled.status).toBe('failed');
    expect(settled.failure).toMatch(/Mini-Summa stopped before this finished/);
    expect(settled.failure).toMatch(/Look at the terminal/);
    expect(t.statuses(pending.id)).toEqual(['failed']);
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.activity.recorded.at(-1)).toMatchObject({ severity: 'error', requiresAction: true });
    t.svc.shutdown();
  });
});

describe('actions: list and get', () => {
  it('lists newest first, by status and project, and gets one by id', async () => {
    const t = setup();
    const a = await t.prompt(PHONE);
    t.env.clock.advance(1000);
    const b = await t.prompt(TABLET);
    t.env.clock.advance(1000);
    const c = await t.prompt(D);
    t.env.clock.advance(1000);
    const d = t.permission()!;
    t.env.clock.advance(1000);
    t.svc.reject(b.id, D);
    expect(t.svc.list({}).map((x) => x.id)).toEqual([d.id, a.id]); // default: open
    expect(t.svc.list({ status: 'open' }).map((x) => x.id)).toEqual([d.id, a.id]);
    expect(t.svc.list({ status: 'pending' }).map((x) => x.id)).toEqual([d.id, a.id]);
    expect(t.svc.list({ status: 'all' }).map((x) => x.id)).toEqual([d.id, c.id, b.id, a.id]);
    expect(t.svc.list({ status: 'all', projectId: 'prj_gm' })).toHaveLength(4);
    expect(t.svc.list({ status: 'all', projectId: 'prj_other' })).toEqual([]);
    expect(t.svc.get(a.id)).toMatchObject({ id: a.id, status: 'pending' });
    expect(t.svc.get('act_nope')).toBeNull();
  });

  it('counts an action being executed as open, not pending', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    let release!: () => void;
    t.sessions.typeHook = () => new Promise((resolve) => { release = () => resolve({ ok: true, submitted: true }); });
    const approving = t.svc.approve(pending.id, D);
    await flush();
    expect(t.svc.get(pending.id)!.status).toBe('approved');
    expect(t.svc.list({ status: 'pending' })).toEqual([]);
    expect(t.svc.list({ status: 'open' }).map((x) => x.id)).toEqual([pending.id]);
    release();
    await approving;
    expect(t.svc.list({ status: 'open' })).toEqual([]);
  });

  it('shows the current check of the target with each action', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    expect(t.svc.get(pending.id)!.target).toMatchObject({ managed: true, live: true, generationMatches: true, state: 'idle', problem: null });
    t.sessions.patch(KEY_A, { generation: 2 });
    expect(t.svc.get(pending.id)!.target).toMatchObject({ generationMatches: false, generation: 2 });
    expect(t.svc.get(pending.id)!.target.problem).toMatch(/restarted/);
  });
});

describe('actions: every state change is announced', () => {
  const scenarios: [string, (t: ReturnType<typeof setup>) => Promise<string>, PendingActionStatus[]][] = [
    ['desktop prompt that is typed', async (t) => (await t.prompt(D)).id, ['approved', 'executed']],
    ['desktop prompt the session refuses', async (t) => { t.sessions.patch(KEY_A, { state: 'working' }); return (await t.prompt(D)).id; }, ['approved', 'failed']],
    ['phone prompt approved', async (t) => { const a = await t.prompt(PHONE); await t.svc.approve(a.id, D); return a.id; }, ['pending', 'approved', 'executed']],
    ['phone prompt approved but the target moved', async (t) => { const a = await t.prompt(PHONE); t.sessions.patch(KEY_A, { generation: 4 }); await t.svc.approve(a.id, D); return a.id; }, ['pending', 'approved', 'failed']],
    ['phone prompt rejected', async (t) => { const a = await t.prompt(PHONE); t.svc.reject(a.id, D); return a.id; }, ['pending', 'rejected']],
    ['phone prompt expired', async (t) => { const a = await t.prompt(PHONE); t.env.clock.advance(2 * 3600_000); t.svc.expireDue(); return a.id; }, ['pending', 'expired']],
    ['permission approved', async (t) => { const a = t.permission()!; await t.svc.approve(a.id, D); return a.id; }, ['pending', 'approved', 'executed']],
    ['permission approved but Claude moved on', async (t) => { const a = t.permission()!; t.sessions.permissions.delete(KEY_A); await t.svc.approve(a.id, D).catch(() => undefined); return a.id; }, ['pending', 'superseded']],
    ['permission replaced by a newer request', async (t) => { const a = t.permission()!; t.permission({ correlationKey: 'derived_2' }); return a.id; }, ['pending', 'superseded']],
    ['phone prompt dropped when its device was removed', async (t) => { const a = await t.prompt(PHONE); t.env.bus.emit({ type: 'device.upserted', device: { ...t.devices.devices.get('dev_phone')!, revokedAt: NOW } }); return a.id; }, ['pending', 'rejected']],
    ['permission rejected', async (t) => { const a = t.permission()!; t.svc.reject(a.id, D); await flush(); return a.id; }, ['pending', 'rejected']],
    ['permission superseded', async (t) => { const a = t.permission()!; t.svc.supersedeOpenFor(KEY_A, 'moved on'); return a.id; }, ['pending', 'superseded']],
    ['permission expired', async (t) => { const a = t.permission()!; t.env.clock.advance(2 * 3600_000); t.svc.expireDue(); return a.id; }, ['pending', 'expired']],
  ];

  it.each(scenarios)('%s', async (_name, run, expected) => {
    const t = setup();
    const id = await run(t);
    expect(t.statuses(id)).toEqual(expected);
    expect(t.svc.get(id)!.status).toBe(expected.at(-1));
    // the last event carries the same action the store holds now (target aside, which is a live check)
    const last = t.env.of('action.upserted').filter((e) => e.action.id === id).at(-1)!.action;
    expect({ ...last, target: null }).toEqual({ ...t.svc.get(id)!, target: null });
    t.expectNoLoggedErrors();
  });
});

describe('actions: words a person reads', () => {
  it('contain no em dash in any feed entry, failure text or error message', async () => {
    const t = setup();
    const texts: unknown[] = [];
    const a = await t.prompt(PHONE);
    await t.svc.approve(a.id, D);
    t.sessions.patch(KEY_A, { state: 'working' });
    texts.push((await t.prompt(D)).failure);
    t.sessions.patch(KEY_A, { state: 'idle' });
    const rej = await t.prompt(PHONE);
    t.svc.reject(rej.id, D, 'no thanks');
    const exp = await t.prompt(TABLET);
    t.env.clock.advance(2 * 3600_000);
    t.svc.expireDue();
    const p = t.permission()!;
    t.svc.supersedeOpenFor(KEY_A, 'x');
    const q = t.permission({ correlationKey: 'again' })!;
    t.sessions.answerHook = () => ({ ok: false, code: 'no_terminal', problem: 'The terminal is gone.' });
    await t.svc.approve(q.id, D);
    for (const call of [() => t.prompt(D, { sessionKey: KEY_EXT }), () => t.prompt(SYSTEM), () => t.prompt(D, { text: ' ' }), () => t.svc.approve(a.id, D), () => t.svc.approve(exp.id, D),
      () => t.svc.approve(p.id, SYSTEM), () => t.prompt(PHONE, { submit: false })]) {
      texts.push((await t.failure(call)).message);
    }
    texts.push(t.activity.recorded, t.svc.list({ status: 'all' }).map((x) => x.failure));
    expect(hasEmDash(texts)).toBe(false);
    t.expectNoLoggedErrors();
    expect(t.activity.recorded.length).toBeGreaterThan(5);
  });
});

describe('actions: nothing is typed unless a person said so', () => {
  it('only the desktop, a trusted device, or an approver ever causes typing', async () => {
    const t = setup();
    const untrusted = await t.prompt(PHONE);
    const permission = t.permission()!;
    await t.failure(() => t.svc.approve(untrusted.id, PHONE));
    await t.failure(() => t.svc.approve(untrusted.id, SYSTEM));
    await t.failure(() => t.prompt(SYSTEM));
    t.svc.init();
    t.env.clock.advance(10 * 60_000);
    t.svc.expireDue();
    t.svc.shutdown();
    t.svc.supersedeOpenFor('win|zzzzzzzz-0000-4000-8000-000000000000' as SessionKey, 'noise');
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.sessions.answerCalls).toEqual([]);
    expect([untrusted.id, permission.id].map((id) => t.svc.get(id)!.status)).toEqual(['pending', 'pending']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SEC-01: approve what you see

describe('actions: only the request that is open can be answered', () => {
  const raise = (t: ReturnType<typeof setup>, key: string, summary = `Bash: ${key}`) => t.permission({ correlationKey: key, summary })!;

  it('raising a newer request supersedes the older open one of that session, and nothing else', () => {
    const t = setup();
    t.sessions.add({ key: KEY_B, projectId: 'prj_gm', projectName: 'GitManager', origin: 'managed', state: 'needs_permission' });
    const elsewhere = t.svc.raisePermission({ sessionKey: KEY_B, generation: 1, summary: 'elsewhere', correlationKey: 'req_other', projectId: 'prj_gm' })!;
    const first = raise(t, 'req_1');
    t.env.clearEvents();
    const second = raise(t, 'req_2');
    expect(t.svc.get(first.id)).toMatchObject({ status: 'superseded', decidedBy: SYSTEM, decidedAt: NOW, executedAt: null });
    expect(t.svc.get(second.id)!.status).toBe('pending');
    expect(t.svc.get(elsewhere.id)!.status).toBe('pending'); // another session is not touched
    expect(pendingActionIds(t.env.events)).toEqual([{ id: first.id, status: 'superseded' }, { id: second.id, status: 'pending' }]);
    expect(t.activity.resolved.flatMap((r) => r[0].ids ?? [])).toEqual([`act_${first.id}`]);
    expect(t.svc.list({ status: 'pending' }).map((a) => a.id).sort()).toEqual([second.id, elsewhere.id].sort());
  });

  it('leaves only the last of several requests open', () => {
    const t = setup();
    const made = ['req_1', 'req_2', 'req_3'].map((k) => raise(t, k));
    expect(made.map((a) => t.svc.get(a.id)!.status)).toEqual(['superseded', 'superseded', 'pending']);
    expect(t.rows()).toBe(3);
  });

  it('does not touch a request that was already decided', async () => {
    const t = setup();
    const first = raise(t, 'req_1');
    await t.svc.approve(first.id, D);
    raise(t, 'req_2');
    expect(t.svc.get(first.id)!.status).toBe('executed');
  });

  it('a replay of an older request neither revives it nor supersedes the newer one', () => {
    const t = setup();
    const first = raise(t, 'req_1');
    const second = raise(t, 'req_2');
    t.env.clearEvents();
    const again = t.svc.raisePermission({ sessionKey: KEY_A, generation: 1, summary: 'Bash: req_1', correlationKey: 'req_1', projectId: 'prj_gm' });
    expect(again).toMatchObject({ id: first.id, status: 'superseded' });
    expect(t.svc.get(second.id)!.status).toBe('pending');
    expect(t.env.events).toEqual([]);
    expect(t.rows()).toBe(2);
  });

  it('a request that is refused (the session is not live) supersedes nothing', () => {
    const t = setup();
    const first = raise(t, 'req_1');
    t.sessions.patch(KEY_A, { availability: 'disconnected' });
    expect(raise(t, 'req_2')).toBeNull();
    expect(t.svc.get(first.id)!.status).toBe('pending');
  });

  it('an item that was superseded can no longer be approved or rejected', async () => {
    const t = setup();
    const first = raise(t, 'req_1');
    raise(t, 'req_2');
    expect(await t.failure(() => t.svc.approve(first.id, D))).toMatchObject({ status: 409, code: 'action_not_pending', message: expect.stringContaining('already superseded') });
    expect(await t.failure(() => t.svc.reject(first.id, D))).toMatchObject({ status: 409, code: 'action_not_pending' });
    expect(t.sessions.answerCalls).toEqual([]);
  });

  it('approving an item whose request is not the one the session shows is refused and superseded, nothing is answered', async () => {
    const t = setup();
    const item = raise(t, 'req_1');
    t.sessions.permissions.set(KEY_A, { correlationKey: 'req_2', summary: 'a different command' }); // a newer dialog the glue has not raised yet
    t.env.clearEvents();
    const err = await t.failure(() => t.svc.approve(item.id, D));
    expect(err).toMatchObject({ status: 409, code: 'permission_changed', message: 'That request is no longer the one that is open. Look at the terminal.' });
    expect(hasEmDash(err.message)).toBe(false);
    expect(t.svc.get(item.id)).toMatchObject({ status: 'superseded', decidedBy: SYSTEM, executedAt: null });
    expect(pendingActionIds(t.env.events)).toEqual([{ id: item.id, status: 'superseded' }]);
    expect(t.activity.resolved.flatMap((r) => r[0].ids ?? [])).toContain(`act_${item.id}`);
    expect(t.sessions.answerCalls).toEqual([]);
    expect(t.sessions.answers).toEqual([]);
  });

  it('rejecting such an item is refused the same way, and no answer is sent to the terminal', async () => {
    const t = setup();
    const item = raise(t, 'req_1');
    t.sessions.permissions.set(KEY_A, { correlationKey: 'req_2', summary: 'a different command' });
    const err = await t.failure(() => t.svc.reject(item.id, PHONE));
    expect(err).toMatchObject({ status: 409, code: 'permission_changed' });
    await flush();
    expect(t.svc.get(item.id)!.status).toBe('superseded');
    expect(t.sessions.answerCalls).toEqual([]);
  });

  it('refuses when the session shows no open request at all, or cannot say', async () => {
    const none = setup();
    const a = raise(none, 'req_1');
    none.sessions.permissions.delete(KEY_A);
    expect(await none.failure(() => none.svc.approve(a.id, D))).toMatchObject({ status: 409, code: 'permission_changed' });
    const broken = setup();
    const b = raise(broken, 'req_1');
    broken.sessions.currentPermission = () => { throw new Error('session store is down'); };
    expect(await broken.failure(() => broken.svc.reject(b.id, D))).toMatchObject({ status: 409, code: 'permission_changed' }); // fail closed
    expect(broken.svc.get(b.id)!.status).toBe('superseded');
    expect(broken.sessions.answerCalls).toEqual([]);
    expect(broken.env.log.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('hands the request key to the session layer, which refuses a dialog that changed after the check', async () => {
    const t = setup();
    const item = raise(t, 'req_1');
    const real = t.sessions.currentPermission;
    // the check sees req_1, and a different dialog opens before the keys are sent
    t.sessions.currentPermission = (key) => { const seen = real(key); t.sessions.permissions.set(key, { correlationKey: 'req_9', summary: 'something else' }); return seen; };
    const done = await t.svc.approve(item.id, D);
    expect(t.sessions.answerCalls).toEqual([{ key: KEY_A, decision: 'approve', expectGeneration: 1, expectRequestKey: 'req_1' }]);
    expect(done).toMatchObject({ status: 'failed', failure: 'That is not the permission request that is open.' });
    expect(t.sessions.answers).toEqual([]); // nothing was answered
  });

  it('every permission request is checked this way, not only the first', async () => {
    const t = setup();
    const keys = ['req_a', 'req_b', 'req_c'];
    for (const k of keys) {
      const item = raise(t, k);
      expect((await t.svc.approve(item.id, D)).status).toBe('executed');
    }
    expect(t.sessions.answerCalls.map((c) => c.expectRequestKey)).toEqual(keys);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SEC-04: links to reports and deliveries

describe('actions: a prompt links a report or delivery only when the desktop sends it and it checks out', () => {
  const DRAFT = 'Please add a test for the logout redirect.';
  const drafted = (t: ReturnType<typeof setup>, over: Partial<DeliveryDetail> = {}) =>
    t.deliveryData.set('dlv_1', deliveryDetail({ id: 'dlv_1', projectId: 'prj_gm', sessionKey: KEY_A, followUpDraft: DRAFT, ...over }));

  it('keeps ids that exist, and marks the follow-up as sent only for the exact draft typed into the delivery\'s own session', async () => {
    const t = setup();
    drafted(t);
    const action = await t.prompt(D, { text: DRAFT, reportId: 'rep_1', deliveryId: 'dlv_1' });
    expect(action).toMatchObject({ status: 'executed', reportId: 'rep_1', deliveryId: 'dlv_1' });
    expect(t.followUps).toEqual([{ deliveryId: 'dlv_1', actionId: action.id }]);
  });

  it.each([
    ['one character short', DRAFT.slice(0, -1)],
    ['a leading space', ` ${DRAFT}`],
    ['a trailing newline', `${DRAFT}\n`],
    ['another case', DRAFT.toUpperCase()],
    ['something else entirely', 'Delete the whole repository.'],
  ])('does not touch the review when the text is not the draft (%s)', async (_name, text) => {
    const t = setup();
    drafted(t);
    const action = await t.prompt(D, { text, deliveryId: 'dlv_1' });
    expect(action).toMatchObject({ status: 'executed', deliveryId: 'dlv_1' }); // the link is valid, it just is not "the follow-up"
    expect(t.followUps).toEqual([]);
  });

  it('does not mark anything when no follow-up was drafted, or the draft was typed into another session', async () => {
    const t = setup();
    drafted(t, { followUpDraft: null });
    await t.prompt(D, { text: DRAFT, deliveryId: 'dlv_1' });
    t.sessions.add({ key: KEY_B, projectId: 'prj_gm', projectName: 'GitManager', generation: 1, state: 'idle' });
    drafted(t, { sessionKey: KEY_B }); // the report came from session B, the prompt goes to A
    await t.prompt(D, { text: DRAFT, deliveryId: 'dlv_1' });
    expect(t.followUps).toEqual([]);
    drafted(t, { sessionKey: KEY_B });
    await t.prompt(D, { sessionKey: KEY_B, text: DRAFT, deliveryId: 'dlv_1' });
    expect(t.followUps).toHaveLength(1); // typed into its own session it counts
  });

  it('a failed prompt marks nothing', async () => {
    const t = setup();
    drafted(t);
    t.sessions.patch(KEY_A, { state: 'working' });
    expect((await t.prompt(D, { text: DRAFT, deliveryId: 'dlv_1' })).status).toBe('failed');
    expect(t.followUps).toEqual([]);
  });

  it('refuses ids that do not exist for the desktop, and creates and types nothing', async () => {
    const t = setup();
    expect(await t.failure(() => t.prompt(D, { deliveryId: 'dlv_nope' }))).toMatchObject({ status: 404, code: 'not_found', message: 'Delivery was not found.' });
    expect(await t.failure(() => t.prompt(D, { reportId: 'rep_nope' }))).toMatchObject({ status: 404, code: 'not_found', message: 'Report was not found.' });
    expect(await t.failure(() => t.prompt(D, { reportId: 'rep_1', deliveryId: 'dlv_nope' }))).toMatchObject({ status: 404 });
    expect(t.rows()).toBe(0);
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it('refuses a delivery of another project', async () => {
    const t = setup();
    drafted(t, { projectId: 'prj_other' });
    const err = await t.failure(() => t.prompt(D, { text: DRAFT, deliveryId: 'dlv_1' }));
    expect(err).toMatchObject({ status: 422, code: 'delivery_project_mismatch' });
    expect(hasEmDash(err.message)).toBe(false);
    expect(t.rows()).toBe(0);
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it('links a delivery of a report that had no project only to the very session it came from', async () => {
    const t = setup();
    t.sessions.add({ key: KEY_B, projectId: null, projectName: null, generation: 1, state: 'idle' });
    t.sessions.add({ key: KEY_C, env: 'wsl:Ubuntu', projectId: null, projectName: null, generation: 1, state: 'idle' });
    drafted(t, { projectId: null, sessionKey: KEY_B });
    expect((await t.prompt(D, { sessionKey: KEY_B, text: 'ok', deliveryId: 'dlv_1' })).deliveryId).toBe('dlv_1');
    // another session without a project, and a session of a project, are both refused
    expect(await t.failure(() => t.prompt(D, { sessionKey: KEY_C, text: 'ok', deliveryId: 'dlv_1' }))).toMatchObject({ status: 422, code: 'delivery_project_mismatch' });
    expect(await t.failure(() => t.prompt(D, { sessionKey: KEY_A, text: 'ok', deliveryId: 'dlv_1' }))).toMatchObject({ status: 422, code: 'delivery_project_mismatch' });
    expect(t.rows()).toBe(1);
  });

  it('drops both ids for a trusted device: naming someone\'s delivery changes no review, even with the draft as the text', async () => {
    const t = setup();
    drafted(t);
    const same = await t.prompt(TRUSTED, { text: DRAFT, deliveryId: 'dlv_1', reportId: 'rep_1' });
    const other = await t.prompt(TRUSTED, { text: 'Please delete the production database.', deliveryId: 'dlv_1' });
    for (const a of [same, other]) {
      expect(a).toMatchObject({ status: 'executed', reportId: null, deliveryId: null });
      expect(t.row(a.id)).toMatchObject({ report_id: null, delivery_id: null });
    }
    expect(t.followUps).toEqual([]);
    expect(t.activity.recorded.flatMap((r) => r.links ?? []).some((l) => l.kind === 'delivery' || l.kind === 'report')).toBe(false);
  });

  it('drops them for a device that waits for approval too, so approving later marks nothing', async () => {
    const t = setup();
    drafted(t);
    const pending = await t.prompt(PHONE, { text: DRAFT, deliveryId: 'dlv_1', reportId: 'rep_1' });
    expect(pending).toMatchObject({ status: 'pending', reportId: null, deliveryId: null });
    expect((await t.svc.approve(pending.id, D)).status).toBe('executed');
    expect(t.followUps).toEqual([]);
  });

  it('does not make a fuss when a device names ids that do not exist: they are just ignored', async () => {
    const t = setup();
    const action = await t.prompt(PHONE, { deliveryId: 'dlv_nope', reportId: 'rep_nope' });
    expect(action).toMatchObject({ status: 'pending', reportId: null, deliveryId: null });
  });

  it('cannot check ids without the delivery and report lists, so it drops them with a warning instead of trusting them', async () => {
    const t = setup({ deliveries: false, reports: false });
    const action = await t.prompt(D, { deliveryId: 'dlv_1', reportId: 'rep_1' });
    expect(action).toMatchObject({ status: 'executed', reportId: null, deliveryId: null });
    expect(t.env.log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
    expect(t.followUps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SEC-05: a device that is revoked or removed

describe('actions: a device that was removed', () => {
  type T = ReturnType<typeof setup>;
  const revoke = (t: T, id: string) => {
    t.devices.devices.set(id, { ...t.devices.devices.get(id)!, revokedAt: t.env.clock.iso() });
    t.env.bus.emit({ type: 'device.upserted', device: t.devices.devices.get(id)! });
  };
  const remove = (t: T, id: string) => {
    t.devices.devices.delete(id);
    t.env.bus.emit({ type: 'device.removed', id });
  };

  it('loses what it was still waiting to get approved, and nothing else', async () => {
    const t = setup();
    const first = await t.prompt(PHONE);
    const second = await t.prompt(PHONE, { text: 'A second prompt' });
    const theirs = await t.prompt(TABLET);
    const typed = await t.prompt(TRUSTED); // executed already, so not "waiting"
    const request = t.permission()!; // raised by the system, not by a device
    t.env.clearEvents();
    revoke(t, 'dev_phone');
    for (const a of [first, second]) {
      expect(t.svc.get(a.id)).toMatchObject({ status: 'rejected', decidedBy: SYSTEM, failure: 'The device that asked was removed.', executedAt: null });
    }
    expect([theirs, typed, request].map((a) => t.svc.get(a.id)!.status)).toEqual(['pending', 'executed', 'pending']);
    expect(pendingActionIds(t.env.events)).toEqual([{ id: first.id, status: 'rejected' }, { id: second.id, status: 'rejected' }]);
    expect(t.activity.resolved.flatMap((r) => r[0].ids ?? [])).toEqual([`act_${first.id}`, `act_${second.id}`]);
    const results = t.activity.recorded.filter((r) => r.id === `actres_${first.id}`);
    expect(results).toEqual([expect.objectContaining({ severity: 'info', title: `Prompt to ${LABEL} was rejected`, description: 'The device that asked was removed. Nothing was typed.' })]);
    expect(t.sessions.typeCalls).toHaveLength(1); // only the trusted device's prompt, typed before
    t.expectNoLoggedErrors();
  });

  it('is handled when the device is taken out of the list as well', async () => {
    const t = setup();
    const pending = await t.prompt(TABLET);
    remove(t, 'dev_tablet');
    expect(t.svc.get(pending.id)).toMatchObject({ status: 'rejected', failure: 'The device that asked was removed.' });
    expect(t.statuses(pending.id)).toEqual(['pending', 'rejected']);
  });

  it('ignores a change to a device that is not a revocation', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.env.bus.emit({ type: 'device.upserted', device: { ...t.devices.devices.get('dev_phone')!, name: 'Renamed phone', trusted: false } });
    t.env.bus.emit({ type: 'device.removed', id: 'dev_somebody_else' });
    expect(t.svc.get(pending.id)!.status).toBe('pending');
  });

  it('refuses to approve a prompt whose device was revoked, even when no event was seen', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    t.devices.devices.set('dev_phone', { ...t.devices.devices.get('dev_phone')!, revokedAt: NOW }); // the event was missed
    const err = await t.failure(() => t.svc.approve(pending.id, D));
    expect(err).toMatchObject({ status: 409, code: 'device_revoked', message: 'The device that asked was removed, so nothing was typed.' });
    expect(t.svc.get(pending.id)).toMatchObject({ status: 'rejected', failure: 'The device that asked was removed.' });
    expect(t.sessions.typeCalls).toEqual([]);
    expect(t.statuses(pending.id)).toEqual(['pending', 'rejected']);
  });

  it('refuses the same when the device is no longer known at all', async () => {
    const t = setup();
    const pending = await t.prompt(TABLET);
    t.devices.devices.delete('dev_tablet');
    expect(await t.failure(() => t.svc.approve(pending.id, D))).toMatchObject({ status: 409, code: 'device_revoked' });
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it('after the event the prompt is simply no longer pending, for the desktop and for other devices', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    revoke(t, 'dev_phone');
    expect(await t.failure(() => t.svc.approve(pending.id, D))).toMatchObject({ status: 409, code: 'action_not_pending' });
    expect(await t.failure(() => t.svc.approve(pending.id, TABLET))).toMatchObject({ status: 409, code: 'action_not_pending' });
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it('a prompt from a device that is still there is unaffected by the check', async () => {
    const t = setup();
    const pending = await t.prompt(PHONE);
    revoke(t, 'dev_tablet');
    expect((await t.svc.approve(pending.id, D)).status).toBe('executed');
  });

  it('listens only between creation/init and shutdown', async () => {
    const t = setup();
    const a = await t.prompt(PHONE);
    t.svc.shutdown();
    revoke(t, 'dev_phone');
    expect(t.svc.get(a.id)!.status).toBe('pending'); // no longer listening
    t.svc.init();
    const b = await t.prompt(TABLET);
    revoke(t, 'dev_tablet');
    expect(t.svc.get(b.id)!.status).toBe('rejected');
    t.svc.shutdown();
  });

  it('still drops the prompts when the service has no device list, and approving then cannot tell', async () => {
    const t = setup({ devices: false });
    const a = await t.prompt(PHONE);
    const b = await t.prompt(TABLET);
    revoke(t, 'dev_phone');
    expect(t.svc.get(a.id)!.status).toBe('rejected');
    expect((await t.svc.approve(b.id, D)).status).toBe('executed');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SEC-14: a phone cannot send a command

describe('actions: commands cannot be sent from a phone', () => {
  const MESSAGE = 'Text that starts with ! or / is a Claude Code command, not a prompt, and cannot be sent from a phone.';
  const COMMANDS: string[] = [
    '!ls', '/clear', '/', '!', '  /help', '\n\t!rm -rf build', '\r\n/compact', '﻿/help', '​!ls', '​﻿  /x', '­/compact', '⁠!x',
    '‎/cost', '‮/model', ' 　/model', ' !x', '\u{E0041}/x', '\u0007/bell', '﻿​‌‍ \t\n!ls -la', '/etc/hosts is odd',
  ];
  const PLAIN: string[] = [
    'Run ls /tmp', 'Please run /clear later', 'Fix the !important flag', 'What does a/b mean?', 'Use ! for negation', '?help', 'a\n/clear', '﻿hello /world',
    '​hello !', '\\/not a command', '(/help)', '  ...  /x',
  ];
  const show = (s: string) => JSON.stringify(s);

  it.each(COMMANDS.map((c) => [show(c), c]))('refuses %s from an untrusted device', async (_name, text) => {
    const t = setup();
    const err = await t.failure(() => t.prompt(PHONE, { text }));
    expect(err).toMatchObject({ status: 422, code: 'command_not_allowed', message: MESSAGE });
    expect(hasEmDash(err.message)).toBe(false);
    expect(t.rows()).toBe(0);
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it.each(COMMANDS.map((c) => [show(c), c]))('refuses %s from a trusted device too', async (_name, text) => {
    const t = setup();
    expect(await t.failure(() => t.prompt(TRUSTED, { text }))).toMatchObject({ status: 422, code: 'command_not_allowed' });
    expect(t.rows()).toBe(0);
    expect(t.sessions.typeCalls).toEqual([]);
  });

  it.each(PLAIN.map((c) => [show(c), c]))('lets %s through from a device', async (_name, text) => {
    const t = setup();
    expect((await t.prompt(PHONE, { text })).status).toBe('pending');
    expect((await t.prompt(TRUSTED, { text })).status).toBe('executed');
  });

  it('does not change anything for the desktop, which may type commands', async () => {
    const t = setup();
    for (const text of ['/clear', '!ls', '  /help', '﻿/compact']) {
      expect((await t.prompt(D, { text })).status).toBe('executed');
    }
    expect(t.sessions.typed.map((x) => x.text)).toEqual(['/clear', '!ls', '  /help', '﻿/compact']);
  });

  it('is checked before anything else is looked at, so a command is never stored', async () => {
    const t = setup();
    t.sessions.patch(KEY_A, { availability: 'resumable' });
    expect(await t.failure(() => t.prompt(PHONE, { text: '/clear', deliveryId: 'dlv_nope' }))).toMatchObject({ code: 'command_not_allowed' });
    expect(t.rows()).toBe(0);
  });
});
