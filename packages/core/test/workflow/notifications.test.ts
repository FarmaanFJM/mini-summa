import { describe, expect, it } from 'vitest';
import type { ProjectNotificationPrefs, QuietMode } from '@minisumma/shared';
import type { NotifyHint } from '../../src/contracts.ts';
import { PUSH_BODY, createNotificationsService, quietReason } from '../../src/workflow/notifications.ts';
import { FakeDevices, FakeProjects, FakePush, KEY_A, activityEvent, fakeNative, fakeSettings, hasEmDash, makeEnv, notifyHint } from './helpers.ts';

type Kind = Exclude<NotifyHint['kind'], 'info'>;
const KINDS: Kind[] = ['permission', 'input', 'error', 'report', 'sessionEnded', 'presenceLost'];

function setup(opts: { push?: 'none' | FakePush } = {}) {
  const env = makeEnv('2026-10-30T10:00:00.000Z');
  const settings = fakeSettings();
  const projects = new FakeProjects(env.db, env.clock);
  const devices = new FakeDevices();
  const native = fakeNative();
  const push = opts.push === 'none' ? null : (opts.push ?? new FakePush());
  const svc = createNotificationsService({ base: env.base, settings, projects, devices, native, push });
  const project = projects.addProject({ id: 'prj_gm', name: 'GitManager' });
  const phone = devices.addDevice({ id: 'dev_phone' });
  devices.addPushTarget(phone.id);
  const consider = (over: { a?: Parameters<typeof activityEvent>[0]; h?: Partial<NotifyHint> } = {}) =>
    svc.consider(activityEvent({ projectId: project.id, projectName: project.name, ...over.a }), notifyHint({ projectId: project.id, ...over.h }));
  return { env, settings, projects, devices, native, push, svc, project, phone, consider };
}

const quiet = (over: Partial<QuietMode> & { schedule?: Partial<QuietMode['schedule']> } = {}): QuietMode => ({
  enabled: false, until: null, ...over, schedule: { enabled: false, from: '22:00', to: '08:00', ...over.schedule },
});

/** A date in the machine's LOCAL time zone, whatever that is. */
const local = (h: number, m = 0, s = 0): Date => new Date(2026, 9, 30, h, m, s);

describe('notifications: preferences', () => {
  it('never notifies kind "info"', async () => {
    const t = setup();
    expect(await t.consider({ h: { kind: 'info' } })).toBeNull();
    expect(t.native.notifications).toHaveLength(0);
    expect(t.env.of('notification.added')).toHaveLength(0);
    expect(t.svc.list()).toEqual([]);
  });

  it('writes nothing at all when the project switched notifications off', async () => {
    const t = setup();
    t.projects.setPrefs(t.project.id, { enabled: false });
    expect(await t.consider()).toBeNull();
    expect(t.native.notifications).toHaveLength(0);
    expect((t.push as FakePush).sent).toHaveLength(0);
    expect(t.svc.list()).toEqual([]);
  });

  it.each(KINDS)('honours the project flag for %s', async (kind) => {
    const t = setup();
    const flag = kind as keyof ProjectNotificationPrefs;
    t.projects.setPrefs(t.project.id, { permission: true, input: true, error: true, report: true, sessionEnded: true, presenceLost: true, [flag]: false });
    expect(await t.consider({ h: { kind, dedupeKey: `${kind}_off` } })).toBeNull();
    for (const other of KINDS.filter((k) => k !== kind)) {
      expect(await t.consider({ h: { kind: other, dedupeKey: `${other}_on` } })).not.toBeNull();
    }
    expect(t.native.notifications).toHaveLength(KINDS.length - 1);
  });

  it('uses the global defaults for a session that has no project, or whose project is gone', async () => {
    const t = setup();
    t.settings.set({ notifications: { defaults: { report: false } } });
    expect(await t.svc.consider(activityEvent(), notifyHint({ projectId: null }))).toBeNull();
    expect(await t.svc.consider(activityEvent(), notifyHint({ projectId: 'prj_deleted', dedupeKey: 'x' }))).toBeNull();
    expect(await t.svc.consider(activityEvent(), notifyHint({ projectId: null, kind: 'permission', dedupeKey: 'perm' }))).not.toBeNull();
    t.settings.set({ notifications: { defaults: { enabled: false } } });
    expect(await t.svc.consider(activityEvent(), notifyHint({ projectId: null, kind: 'error', dedupeKey: 'err' }))).toBeNull();
  });

  it('keeps the record but skips the desktop channel when the global native switch is off; push is unaffected', async () => {
    const t = setup();
    t.settings.set({ notifications: { native: false } });
    const record = await t.consider();
    expect(record).toMatchObject({ native: 'suppressed_disabled', push: 'sent' });
    expect(t.native.notifications).toHaveLength(0);
    expect((t.push as FakePush).sent).toHaveLength(1);
  });
});

describe('notifications: what the desktop sees', () => {
  it('shows "<project>: report ready" with the activity title, the dedupe key as tag, the target and the urgency', async () => {
    const t = setup();
    const target = { view: 'reports' as const, projectId: t.project.id, reportId: 'r1', deliveryId: 'd1' };
    const record = await t.consider({ a: { id: 'rep_r1', title: 'Report ready: Fix login' }, h: { dedupeKey: 'rep_r1', target, urgency: 'critical' } });
    expect(t.native.notifications).toEqual([{ title: 'GitManager: report ready', body: 'Report ready: Fix login', tag: 'rep_r1', target, urgency: 'critical', silent: false }]);
    expect(record).toMatchObject({ title: 'GitManager: report ready', body: 'Report ready: Fix login', activityId: 'rep_r1', projectId: t.project.id, readAt: null, native: 'sent', target });
  });

  it.each([
    ['permission', 'GitManager: needs permission'], ['input', 'GitManager: needs your input'], ['error', 'GitManager: error'],
    ['report', 'GitManager: report ready'], ['sessionEnded', 'GitManager: session ended'], ['presenceLost', 'GitManager: session no longer visible'],
  ] as const)('titles a %s notification "%s"', async (kind, title) => {
    const t = setup();
    t.projects.setPrefs(t.project.id, { sessionEnded: true }); // off by default
    expect((await t.consider({ h: { kind } }))!.title).toBe(title);
    expect(hasEmDash(title)).toBe(false);
  });

  it('falls back to the activity project name, then to Mini-Summa', async () => {
    const t = setup();
    expect((await t.svc.consider(activityEvent({ projectName: 'Orphan' }), notifyHint({ projectId: null }))))!.toMatchObject({ title: 'Orphan: report ready' });
    expect((await t.svc.consider(activityEvent(), notifyHint({ projectId: null, dedupeKey: 'other' }))))!.toMatchObject({ title: 'Mini-Summa: report ready' });
  });

  it.each([
    ['sent', { shown: true }, 'sent'],
    ['unavailable (reason)', { shown: false, reason: 'unavailable' }, 'unavailable'],
    ['unavailable (no reason)', { shown: false }, 'unavailable'],
    ['unsupported', { shown: false, reason: 'Notifications are unsupported on this system' }, 'unavailable'],
    ['refused by the system', { shown: false, reason: 'blocked by focus assist' }, 'failed'],
  ])('maps a host answer of %s to "%s"', async (_name, answer, expected) => {
    const t = setup();
    t.native.notifyImpl = () => answer;
    expect((await t.consider())!.native).toBe(expected);
  });

  it('records "failed" when the host throws, and logs it', async () => {
    const t = setup();
    t.native.notifyImpl = () => { throw new Error('toast service crashed'); };
    expect((await t.consider())!.native).toBe('failed');
    expect(t.env.log.lines.some((l) => l.level === 'warn')).toBe(true);
  });
});

describe('notifications: quiet mode', () => {
  const NOW = new Date('2026-10-30T10:00:00.000Z');

  it('manual quiet is on with no end, or with an end in the future, and off after it', () => {
    expect(quietReason(quiet({ enabled: true }), NOW)).toBe('manual');
    expect(quietReason(quiet({ enabled: true, until: '2026-10-30T10:00:01.000Z' }), NOW)).toBe('manual');
    expect(quietReason(quiet({ enabled: true, until: '2026-10-30T10:00:00.000Z' }), NOW)).toBeNull();
    expect(quietReason(quiet({ enabled: true, until: '2026-10-30T09:59:59.000Z' }), NOW)).toBeNull();
    expect(quietReason(quiet({ enabled: false, until: '2030-01-01T00:00:00.000Z' }), NOW)).toBeNull();
    expect(quietReason(quiet({ enabled: true, until: 'not a date' }), NOW)).toBe('manual'); // unreadable end means "until I turn it off"
  });

  it.each([
    // [from, to, local time, expected quiet?]  (window start inclusive, end exclusive, local clock)
    ['22:00', '08:00', [23, 30], true], ['22:00', '08:00', [3, 0], true], ['22:00', '08:00', [0, 0], true], ['22:00', '08:00', [22, 0], true],
    ['22:00', '08:00', [21, 59], false], ['22:00', '08:00', [7, 59], true], ['22:00', '08:00', [8, 0], false], ['22:00', '08:00', [12, 0], false],
    ['13:00', '14:30', [13, 0], true], ['13:00', '14:30', [14, 29], true], ['13:00', '14:30', [14, 30], false], ['13:00', '14:30', [12, 59], false],
    ['13:00', '14:30', [23, 0], false], ['00:00', '06:00', [0, 0], true], ['00:00', '06:00', [5, 59], true], ['00:00', '06:00', [6, 0], false],
    ['09:00', '09:00', [9, 0], false], ['09:00', '09:00', [15, 0], false], // equal ends: an empty window, never "all day"
    ['25:00', '08:00', [23, 0], false], ['22:00', 'soon', [23, 0], false], // unreadable times disable the schedule
  ] as [string, string, [number, number], boolean][])('schedule %s to %s at %s:%s is quiet=%s', (from, to, [h, m], expected) => {
    expect(quietReason(quiet({ schedule: { enabled: true, from, to } }), local(h, m))).toBe(expected ? 'schedule' : null);
  });

  it('ignores a disabled schedule', () => {
    expect(quietReason(quiet({ schedule: { enabled: false, from: '00:00', to: '23:59' } }), local(12, 0))).toBeNull();
  });

  it('suppresses desktop and phone but still writes the record, so unread state persists', async () => {
    const t = setup();
    t.settings.set({ notifications: { quiet: { enabled: true, until: null } } });
    const record = await t.consider();
    expect(record).toMatchObject({ native: 'suppressed_quiet', push: 'suppressed_quiet', readAt: null });
    expect(t.native.notifications).toHaveLength(0);
    expect((t.push as FakePush).sent).toHaveLength(0);
    expect(t.svc.list()).toEqual([record]);
    expect(t.env.of('notification.added')).toEqual([{ type: 'notification.added', notification: record }]);
  });

  it('does not claim quiet mode held back a push that had nowhere to go', async () => {
    const t = setup({ push: 'none' });
    t.settings.set({ notifications: { quiet: { enabled: true, until: null } } });
    expect(await t.consider()).toMatchObject({ native: 'suppressed_quiet', push: 'not_applicable' });
  });

  it('follows the daily window in local time end to end, and notifies again outside it', async () => {
    const t = setup();
    t.settings.set({ notifications: { quiet: { schedule: { enabled: true, from: '22:00', to: '08:00' } } } });
    t.env.clock.set(local(23, 30));
    expect((await t.consider({ h: { dedupeKey: 'night' } }))!.native).toBe('suppressed_quiet');
    t.env.clock.set(local(8, 0));
    expect((await t.consider({ h: { dedupeKey: 'morning' } }))!.native).toBe('sent');
    expect(t.native.notifications).toHaveLength(1);
  });
});

describe('notifications: dedupe', () => {
  it('returns null and does nothing else for a key that was already notified', async () => {
    const t = setup();
    const first = await t.consider({ h: { dedupeKey: 'drv_same' } });
    t.env.clearEvents();
    expect(await t.consider({ h: { dedupeKey: 'drv_same' } })).toBeNull();
    expect(t.native.notifications).toHaveLength(1);
    expect((t.push as FakePush).sent).toHaveLength(1);
    expect(t.env.events).toEqual([]);
    expect(t.svc.list()).toEqual([first]);
  });

  it('notifies a different key, and a second notification about the same cause type', async () => {
    const t = setup();
    await t.consider({ h: { dedupeKey: 'a' } });
    await t.consider({ h: { dedupeKey: 'b' } });
    expect(t.svc.list()).toHaveLength(2);
  });

  it('counts a notification that quiet mode held back as already notified', async () => {
    const t = setup();
    t.settings.set({ notifications: { quiet: { enabled: true, until: null } } });
    await t.consider({ h: { dedupeKey: 'held' } });
    t.settings.set({ notifications: { quiet: { enabled: false } } });
    expect(await t.consider({ h: { dedupeKey: 'held' } })).toBeNull();
    expect(t.native.notifications).toHaveLength(0);
  });

  it('shows the desktop and the phone one notification when the same cause arrives twice at once', async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.native.notifyImpl = async () => { await gate; return { shown: true }; };
    const both = Promise.all([t.consider({ h: { dedupeKey: 'race' } }), t.consider({ h: { dedupeKey: 'race' } })]);
    await Promise.resolve();
    release();
    const [a, b] = await both;
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(t.native.notifications).toHaveLength(1);
    expect((t.push as FakePush).sent).toHaveLength(1);
    expect(t.env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications')!.n).toBe(1);
  });

  it('lets the key be used again after a call that failed before recording anything', async () => {
    const t = setup();
    t.env.db.run('DROP TABLE notifications'); // an insert will fail
    await expect(t.consider({ h: { dedupeKey: 'k' } })).rejects.toThrow();
    t.env.db.exec(`CREATE TABLE notifications (id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, project_id TEXT, at TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      native TEXT NOT NULL, push TEXT NOT NULL, read_at TEXT, target_json TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE)`);
    expect(await t.consider({ h: { dedupeKey: 'k' } })).not.toBeNull();
  });
});

describe('notifications: push', () => {
  it('sends only the project name, a fixed sentence and ids', async () => {
    const t = setup();
    const record = await t.consider({
      a: { id: 'rep_9', sessionKey: KEY_A, links: [{ kind: 'report', id: 'r9' }, { kind: 'session', key: KEY_A }] },
      h: { kind: 'report', sessionKey: KEY_A, dedupeKey: 'rep_9', target: { view: 'reports', projectId: t.project.id, reportId: 'r9', deliveryId: 'd9' } },
    });
    expect(record!.push).toBe('sent');
    const sent = (t.push as FakePush).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].targets).toEqual([{ deviceId: 'dev_phone', token: 'token-of-dev_phone' }]);
    expect(sent[0].payload).toEqual({
      title: 'GitManager', body: 'A report is ready',
      data: { kind: 'report', projectId: t.project.id, activityId: 'rep_9', sessionKey: KEY_A, reportId: 'r9' },
    });
  });

  it.each([
    ['permission', 'Claude is waiting for permission'], ['input', 'Claude needs your input'], ['error', 'A Claude session hit an error'],
    ['report', 'A report is ready'], ['presenceLost', 'A Claude session is no longer visible'], ['sessionEnded', 'A Claude session ended'],
  ] as const)('says "%s" with the fixed sentence "%s"', async (kind, sentence) => {
    const t = setup();
    t.projects.setPrefs(t.project.id, { sessionEnded: true }); // off by default
    await t.consider({ h: { kind } });
    expect((t.push as FakePush).sent[0].payload.body).toBe(sentence);
    expect(PUSH_BODY[kind]).toBe(sentence);
  });

  it('never carries report text, task text, tool input or paths, whatever the activity entry contains', async () => {
    const t = setup();
    const secrets = ['TOP SECRET REPORT BODY', 'rm -rf /home/user/private', 'C:\\Users\\me\\secrets.txt', 'Fix the login bug in auth.ts', 'sk-live-123'];
    await t.consider({
      a: {
        id: 'rep_s', title: `Report ready: ${secrets[3]}`, description: `${secrets[0]} ${secrets[1]} ${secrets[2]} ${secrets[4]}`, sessionKey: KEY_A,
        links: [{ kind: 'report', id: 'r1' }, { kind: 'settings', section: secrets[2] }],
      },
      h: { dedupeKey: 'rep_s', target: { view: 'reports', projectId: t.project.id, reportId: 'r1', section: secrets[2] } },
    });
    const wire = JSON.stringify((t.push as FakePush).sent[0].payload);
    for (const secret of secrets) expect(wire).not.toContain(secret);
    expect(Object.keys((t.push as FakePush).sent[0].payload).sort()).toEqual(['body', 'data', 'title']);
    expect(Object.keys((t.push as FakePush).sent[0].payload.data).sort()).toEqual(['activityId', 'kind', 'projectId', 'reportId', 'sessionKey']);
    // the local desktop notification may show the title; the phone never does
    expect(t.native.notifications[0].body).toContain(secrets[3]);
  });

  it('leaves out ids that do not exist', async () => {
    const t = setup();
    await t.svc.consider(activityEvent({ id: 'drv_n' }), notifyHint({ projectId: null, kind: 'error', dedupeKey: 'n' }));
    expect((t.push as FakePush).sent[0].payload).toEqual({ title: 'Mini-Summa', body: 'A Claude session hit an error', data: { kind: 'error', projectId: null, activityId: 'drv_n' } });
  });

  it('is not sent when the project turned push off', async () => {
    const t = setup();
    t.projects.setPrefs(t.project.id, { push: false });
    expect(await t.consider()).toMatchObject({ native: 'sent', push: 'suppressed_project' });
    expect((t.push as FakePush).sent).toHaveLength(0);
  });

  it.each([
    ['there is no provider', () => ({ push: 'none' as const }), (_p: FakePush | null) => undefined],
    ['the provider is not configured', () => ({}), (p: FakePush | null) => { p!.isConfigured = false; }],
  ])('is "not_applicable" when %s', async (_name, opts, tweak) => {
    const t = setup(opts());
    tweak(t.push as FakePush | null);
    expect(await t.consider()).toMatchObject({ native: 'sent', push: 'not_applicable' });
  });

  it('is "not_applicable" when no phone has registered', async () => {
    const t = setup();
    t.devices.targets = [];
    expect(await t.consider()).toMatchObject({ push: 'not_applicable' });
    expect((t.push as FakePush).sent).toHaveLength(0);
  });

  it('clears tokens the provider calls invalid, and counts a partly delivered push as sent', async () => {
    const t = setup();
    t.devices.addPushTarget('dev_tablet');
    t.devices.addPushTarget('dev_old');
    (t.push as FakePush).respond = () => [
      { deviceId: 'dev_phone', result: 'sent' }, { deviceId: 'dev_tablet', result: 'failed', error: 'timeout' }, { deviceId: 'dev_old', result: 'invalid_token' },
    ];
    expect((await t.consider())!.push).toBe('sent');
    expect(t.devices.cleared).toEqual(['dev_old']);
  });

  it('is "failed" when no device took it, or the provider throws', async () => {
    const t = setup();
    (t.push as FakePush).respond = (targets) => targets.map((x) => ({ deviceId: x.deviceId, result: 'invalid_token' as const }));
    expect((await t.consider({ h: { dedupeKey: '1' } }))!.push).toBe('failed');
    expect(t.devices.cleared).toEqual(['dev_phone']);
    t.devices.addPushTarget('dev_phone');
    (t.push as FakePush).throwOnSend = new Error('FCM is down');
    expect((await t.consider({ h: { dedupeKey: '2' } }))!.push).toBe('failed');
    expect(t.native.notifications).toHaveLength(2); // the desktop is unaffected
  });
});

describe('notifications: sendTest', () => {
  it('says why nothing was sent when push is not set up or no phone registered', async () => {
    const none = setup({ push: 'none' });
    expect(await none.svc.sendTest()).toEqual({ sent: 0, failed: 0, skipped: expect.stringMatching(/not set up/i) });
    const unconfigured = setup();
    (unconfigured.push as FakePush).isConfigured = false;
    expect((await unconfigured.svc.sendTest()).skipped).toMatch(/not set up/i);
    const empty = setup();
    empty.devices.targets = [];
    expect((await empty.svc.sendTest()).skipped).toMatch(/No phone/);
    expect((empty.push as FakePush).sent).toHaveLength(0);
  });

  it('sends a clearly marked test message to every phone, even in quiet mode, and clears dead tokens', async () => {
    const t = setup();
    t.devices.addPushTarget('dev_old');
    t.settings.set({ notifications: { quiet: { enabled: true, until: null } } });
    (t.push as FakePush).respond = () => [{ deviceId: 'dev_phone', result: 'sent' }, { deviceId: 'dev_old', result: 'invalid_token' }];
    expect(await t.svc.sendTest()).toEqual({ sent: 1, failed: 1, skipped: null });
    const payload = (t.push as FakePush).sent[0].payload;
    expect(payload.title).toMatch(/test/i);
    expect(payload.body).toMatch(/test/i);
    expect(payload.data).toEqual({ kind: 'info', projectId: null, activityId: 'test' });
    expect(t.devices.cleared).toEqual(['dev_old']);
    expect(t.svc.list()).toEqual([]); // a test is not a notification about anything
    expect(hasEmDash(payload)).toBe(false);
  });

  it('counts every target as failed when the provider throws', async () => {
    const t = setup();
    (t.push as FakePush).throwOnSend = new Error('offline');
    expect(await t.svc.sendTest()).toEqual({ sent: 0, failed: 1, skipped: null });
  });
});

describe('notifications: list and prune', () => {
  it('lists newest first, limited to 1..200 and defaulting to 50', async () => {
    const t = setup();
    for (let i = 1; i <= 3; i++) { t.env.clock.advance(1000); await t.consider({ h: { dedupeKey: `k${i}` } }); }
    expect(t.svc.list().map((n) => n.activityId)).toHaveLength(3);
    expect(t.svc.list(2)).toHaveLength(2);
    expect(t.svc.list(0)).toHaveLength(1);
    expect(t.svc.list(1)[0].at).toBe('2026-10-30T10:00:03.000Z');
    expect(t.svc.list().map((n) => n.at)).toEqual(['2026-10-30T10:00:03.000Z', '2026-10-30T10:00:02.000Z', '2026-10-30T10:00:01.000Z']);
  });

  it('persists every field so a record survives a restart', async () => {
    const t = setup();
    const record = (await t.consider({ h: { dedupeKey: 'persist', target: { view: 'workspace', projectId: t.project.id, sessionKey: KEY_A } } }))!;
    const again = createNotificationsService({ base: t.env.base, settings: t.settings, projects: t.projects, devices: t.devices, native: t.native, push: null });
    expect(again.list()).toEqual([record]);
    expect(await again.consider(activityEvent(), notifyHint({ projectId: t.project.id, dedupeKey: 'persist' }))).toBeNull(); // dedupe survives too
  });

  it('prunes by age and returns how many it removed', async () => {
    const t = setup();
    await t.consider({ h: { dedupeKey: 'old' } });
    t.env.clock.set('2026-12-01T00:00:00.000Z');
    await t.consider({ h: { dedupeKey: 'new' } });
    expect(t.svc.prune('2026-11-01T00:00:00.000Z')).toBe(1);
    expect(t.svc.list().map((n) => n.at)).toEqual(['2026-12-01T00:00:00.000Z']);
    expect(t.svc.prune('2026-11-01T00:00:00.000Z')).toBe(0);
  });
});
