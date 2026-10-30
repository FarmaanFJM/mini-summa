import { describe, expect, it } from 'vitest';
import type { ActivityType, Counts, LinkTarget } from '@minisumma/shared';
import type { ActivityInput } from '../../src/contracts.ts';
import { createActivityService } from '../../src/workflow/activity.ts';
import { KEY_A, KEY_B, hasEmDash, makeEnv } from './helpers.ts';

function setup() {
  const env = makeEnv();
  let others: Pick<Counts, 'pendingActions' | 'reportsAwaitingHandoff' | 'liveSessions'> = { pendingActions: 3, reportsAwaitingHandoff: 2, liveSessions: 4 };
  const svc = createActivityService({ base: env.base, fullCounts: () => ({ unreadActivity: -1, actionsNeeded: -1, ...others }) });
  let n = 0;
  const add = (over: Partial<ActivityInput> = {}) => {
    n++;
    return svc.record({ id: `drv_${n}`, projectId: null, source: 'claude', type: 'turn_ended', severity: 'info', title: `Entry ${n}`, ...over });
  };
  return { env, svc, add, setOthers: (o: typeof others) => { others = o; } };
}

describe('activity.record', () => {
  it('stores the entry, returns it and emits activity.added once', () => {
    const { env, svc, add } = setup();
    const links: LinkTarget[] = [{ kind: 'project', id: 'prj_1' }, { kind: 'session', key: KEY_A }];
    const { activity, created } = add({ id: 'drv_x', projectId: null, projectName: 'GitManager', sessionKey: KEY_A, type: 'needs_permission', severity: 'attention',
      title: 'Needs permission: GitManager / a1b2c3d4', description: 'Bash: ls', requiresAction: true, links, at: '2026-10-30T09:00:00.000Z' });
    expect(created).toBe(true);
    expect(activity).toEqual({
      id: 'drv_x', at: '2026-10-30T09:00:00.000Z', projectId: null, projectName: 'GitManager', source: 'claude', sessionKey: KEY_A, type: 'needs_permission',
      severity: 'attention', title: 'Needs permission: GitManager / a1b2c3d4', description: 'Bash: ls', requiresAction: true, resolvedAt: null, links, read: false,
    });
    expect(svc.get('drv_x')).toEqual(activity);
    expect(env.of('activity.added')).toEqual([{ type: 'activity.added', activity }]);
  });

  it('uses the clock when no time is given and defaults the optional fields', () => {
    const { env, add } = setup();
    env.clock.set('2026-11-02T08:30:00.000Z');
    const { activity } = add({ id: 'drv_d' });
    expect(activity).toMatchObject({ at: '2026-11-02T08:30:00.000Z', projectName: null, sessionKey: null, description: null, requiresAction: false, links: [] });
  });

  it('is idempotent on id: the second call returns the first entry, creates nothing and emits nothing', () => {
    const { env, svc, add } = setup();
    const first = add({ id: 'drv_same', title: 'First wording' });
    env.clearEvents();
    const again = add({ id: 'drv_same', title: 'Second wording', requiresAction: true, severity: 'error' });
    expect(again.created).toBe(false);
    expect(again.activity).toEqual(first.activity);
    expect(again.activity.title).toBe('First wording');
    expect(env.events).toEqual([]);
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n).toBe(1);
    expect(svc.counts().actionsNeeded).toBe(0);
  });

  it('survives a replay of many causes without growing the feed or re-announcing', () => {
    const { env, add } = setup();
    for (let i = 0; i < 5; i++) add({ id: `drv_${i}`, title: `Event ${i}` });
    env.clearEvents();
    for (let round = 0; round < 3; round++) for (let i = 0; i < 5; i++) expect(add({ id: `drv_${i}`, title: `Event ${i}` }).created).toBe(false);
    expect(env.events).toEqual([]);
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n).toBe(5);
  });

  it('refuses an empty title or id with 400 invalid_activity and writes nothing', () => {
    const { env, add } = setup();
    for (const title of ['', '   ', '\n\t']) {
      expect(() => add({ title })).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_activity' }));
    }
    expect(() => add({ id: '  ' })).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_activity' }));
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')!.n).toBe(0);
    expect(env.events).toEqual([]);
  });

  it('never stores an em dash: title and description are rewritten, the entry is kept to one line', () => {
    const { env, add } = setup();
    const { activity } = add({ title: 'Report ready: Fix login — add tests\nsecond line', description: 'Claude finished—probably.' });
    expect(activity.title).toBe('Report ready: Fix login - add tests second line');
    expect(activity.description).toBe('Claude finished - probably.');
    const stored = env.db.get<{ title: string; description: string }>('SELECT title, description FROM activity')!;
    expect(hasEmDash(stored)).toBe(false);
    expect(hasEmDash(env.of('activity.added'))).toBe(false);
  });

  it('keeps a multi-line description and turns a blank one into null', () => {
    const { add } = setup();
    expect(add({ description: 'line one\nline two' }).activity.description).toBe('line one\nline two');
    expect(add({ description: '   ' }).activity.description).toBeNull();
  });
});

describe('activity.list', () => {
  it('returns newest first by sequence, whatever the timestamps say', () => {
    const { svc, add } = setup();
    add({ id: 'drv_a', at: '2026-10-30T12:00:00.000Z' });
    add({ id: 'drv_b', at: '2026-10-30T09:00:00.000Z' });
    add({ id: 'drv_c', at: '2026-10-30T11:00:00.000Z' });
    expect(svc.list({}).items.map((a) => a.id)).toEqual(['drv_c', 'drv_b', 'drv_a']);
    expect(svc.list({}).nextBefore).toBeNull();
  });

  it('pages with the sequence cursor without losing or repeating anything', () => {
    const { svc, add } = setup();
    for (let i = 1; i <= 7; i++) add({ id: `drv_${i}` });
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = svc.list({ limit: 3, before });
      seen.push(...page.items.map((a) => a.id));
      before = page.nextBefore ?? undefined;
      pages++;
    } while (before);
    expect(pages).toBe(3);
    expect(seen).toEqual(['drv_7', 'drv_6', 'drv_5', 'drv_4', 'drv_3', 'drv_2', 'drv_1']);
  });

  it('has no next page when the last page is exactly full', () => {
    const { svc, add } = setup();
    for (let i = 1; i <= 4; i++) add();
    expect(svc.list({ limit: 4 }).nextBefore).toBeNull();
    expect(svc.list({ limit: 3 }).nextBefore).not.toBeNull();
  });

  it('defaults the limit to 50 and clamps it to 1..200', () => {
    const { svc, add } = setup();
    for (let i = 0; i < 230; i++) add();
    expect(svc.list({}).items).toHaveLength(50);
    expect(svc.list({ limit: 1000 }).items).toHaveLength(200);
    expect(svc.list({ limit: 0 }).items).toHaveLength(1);
    expect(svc.list({ limit: -5 }).items).toHaveLength(1);
    expect(svc.list({ limit: 200 }).nextBefore).not.toBeNull();
  });

  it('filters by project, type, unread and still-open actions, alone and together', () => {
    const { svc, add } = setup();
    add({ id: 'p1_perm', projectId: null, type: 'needs_permission', requiresAction: true });
    add({ id: 'none_turn', type: 'turn_ended' });
    add({ id: 'none_perm', type: 'needs_permission', requiresAction: true });
    svc.resolve({ ids: ['none_perm'] });
    svc.markRead({ ids: ['none_turn'] });
    const ids = (q: Parameters<typeof svc.list>[0]) => svc.list(q).items.map((a) => a.id).sort();
    expect(ids({ type: 'needs_permission' })).toEqual(['none_perm', 'p1_perm']);
    expect(ids({ unread: true })).toEqual(['none_perm', 'p1_perm']);
    expect(ids({ unread: false })).toEqual(['none_perm', 'none_turn', 'p1_perm']); // false means "no filter"
    expect(ids({ requiresAction: true })).toEqual(['p1_perm']); // resolved entries no longer need action
    expect(ids({ requiresAction: true, type: 'turn_ended' })).toEqual([]);
    expect(ids({ type: 'needs_permission', unread: true, requiresAction: true })).toEqual(['p1_perm']);
  });

  it('filters by project id', () => {
    const { env, svc, add } = setup();
    env.db.run(`INSERT INTO projects (id, name, default_env, notification_prefs_json, created_at, updated_at) VALUES ('prj_1','One','win','{}','t','t'),('prj_2','Two','win','{}','t','t')`);
    add({ id: 'a', projectId: 'prj_1' });
    add({ id: 'b', projectId: 'prj_2' });
    add({ id: 'c', projectId: 'prj_1' });
    expect(svc.list({ projectId: 'prj_1' }).items.map((a) => a.id)).toEqual(['c', 'a']);
    expect(svc.list({ projectId: 'prj_2' }).items.map((a) => a.id)).toEqual(['b']);
    expect(svc.list({ projectId: 'prj_9' }).items).toEqual([]);
  });

  it('rejects a cursor that is not a sequence number', () => {
    const { svc } = setup();
    for (const before of ['abc', '1.5', '-3', '1; DROP TABLE activity']) {
      expect(() => svc.list({ before })).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_cursor' }));
    }
  });
});

describe('activity.resolve', () => {
  it('resolves by id with the given time, emits activity.updated for each and is idempotent', () => {
    const { env, svc, add } = setup();
    add({ id: 'a', requiresAction: true });
    add({ id: 'b', requiresAction: true });
    add({ id: 'c', requiresAction: true });
    env.clearEvents();
    expect(svc.resolve({ ids: ['a', 'c', 'missing'] }, '2026-10-30T12:00:00.000Z')).toBe(2);
    expect(svc.get('a')).toMatchObject({ resolvedAt: '2026-10-30T12:00:00.000Z', requiresAction: true, read: false });
    expect(svc.get('b')!.resolvedAt).toBeNull();
    expect(env.of('activity.updated').map((e) => e.activity.id)).toEqual(['a', 'c']);
    expect(env.of('activity.updated')[0].activity.resolvedAt).toBe('2026-10-30T12:00:00.000Z');
    env.clearEvents();
    expect(svc.resolve({ ids: ['a', 'c'] }, '2026-10-30T13:00:00.000Z')).toBe(0);
    expect(env.events).toEqual([]);
    expect(svc.get('a')!.resolvedAt).toBe('2026-10-30T12:00:00.000Z'); // the first resolution stands
  });

  it('defaults the time to now', () => {
    const { env, svc, add } = setup();
    add({ id: 'a', requiresAction: true });
    env.clock.set('2026-12-01T00:00:00.000Z');
    svc.resolve({ ids: ['a'] });
    expect(svc.get('a')!.resolvedAt).toBe('2026-12-01T00:00:00.000Z');
  });

  it('resolves by session and types, leaving other sessions and other types alone', () => {
    const { svc, add } = setup();
    add({ id: 'perm_a', sessionKey: KEY_A, type: 'needs_permission', requiresAction: true });
    add({ id: 'input_a', sessionKey: KEY_A, type: 'needs_input', requiresAction: true });
    add({ id: 'err_a', sessionKey: KEY_A, type: 'error', requiresAction: true });
    add({ id: 'perm_b', sessionKey: KEY_B, type: 'needs_permission', requiresAction: true });
    const types: ActivityType[] = ['needs_permission', 'needs_input', 'waiting_for_you'];
    expect(svc.resolve({ sessionKey: KEY_A, types })).toBe(2);
    expect(['perm_a', 'input_a', 'err_a', 'perm_b'].map((id) => svc.get(id)!.resolvedAt !== null)).toEqual([true, true, false, false]);
  });

  it('resolves everything open for a session when no types are given', () => {
    const { svc, add } = setup();
    add({ id: 'x', sessionKey: KEY_A, type: 'error', requiresAction: true });
    add({ id: 'y', sessionKey: KEY_A, type: 'needs_input', requiresAction: true });
    add({ id: 'z', sessionKey: KEY_B, type: 'error', requiresAction: true });
    expect(svc.resolve({ sessionKey: KEY_A })).toBe(2);
    expect(svc.get('z')!.resolvedAt).toBeNull();
  });

  it('resolves by link for every kind of link, matching the exact target only', () => {
    const { svc, add } = setup();
    add({ id: 'rep', requiresAction: true, links: [{ kind: 'project', id: 'prj_1' }, { kind: 'report', id: 'r1' }, { kind: 'delivery', id: 'd1' }] });
    add({ id: 'rep2', requiresAction: true, links: [{ kind: 'report', id: 'r2' }, { kind: 'delivery', id: 'd2' }] });
    add({ id: 'sess', requiresAction: true, links: [{ kind: 'session', key: KEY_A }] });
    add({ id: 'act', requiresAction: true, links: [{ kind: 'action', id: 'act_1' }] });
    add({ id: 'set', requiresAction: true, links: [{ kind: 'settings', section: 'hooks' }] });
    add({ id: 'conv', requiresAction: true, links: [{ kind: 'conversation', id: 'c1' }] });
    const open = () => ['rep', 'rep2', 'sess', 'act', 'set', 'conv'].filter((id) => svc.get(id)!.resolvedAt === null);
    expect(svc.resolve({ link: { kind: 'delivery', id: 'd1' } })).toBe(1);
    expect(open()).toEqual(['rep2', 'sess', 'act', 'set', 'conv']);
    expect(svc.resolve({ link: { kind: 'report', id: 'd2' } })).toBe(0); // right id, wrong kind
    expect(svc.resolve({ link: { kind: 'session', key: KEY_A } })).toBe(1);
    expect(svc.resolve({ link: { kind: 'action', id: 'act_1' } })).toBe(1);
    expect(svc.resolve({ link: { kind: 'settings', section: 'hooks' } })).toBe(1);
    expect(svc.resolve({ link: { kind: 'conversation', id: 'c1' } })).toBe(1);
    expect(open()).toEqual(['rep2']);
  });

  it('touches only entries that need action and never marks anything read', () => {
    const { env, svc, add } = setup();
    add({ id: 'info', links: [{ kind: 'delivery', id: 'd1' }] });
    add({ id: 'todo', requiresAction: true, links: [{ kind: 'delivery', id: 'd1' }] });
    env.clearEvents();
    expect(svc.resolve({ link: { kind: 'delivery', id: 'd1' } })).toBe(1);
    expect(svc.get('info')!.resolvedAt).toBeNull();
    expect(svc.get('todo')).toMatchObject({ resolvedAt: expect.any(String), read: false });
    expect(env.of('activity.updated')).toHaveLength(1);
  });

  it('several selectors narrow each other, and no selector resolves nothing at all', () => {
    const { svc, add } = setup();
    add({ id: 'a1', sessionKey: KEY_A, requiresAction: true });
    add({ id: 'a2', sessionKey: KEY_A, requiresAction: true });
    add({ id: 'b1', sessionKey: KEY_B, requiresAction: true });
    expect(svc.resolve({ ids: ['a1', 'b1'], sessionKey: KEY_A })).toBe(1);
    expect(svc.resolve({})).toBe(0);
    expect(svc.resolve({ ids: [] })).toBe(0);
    expect(svc.resolve({ types: ['turn_ended'] })).toBe(0);
    expect(svc.resolve({ sessionKey: KEY_A, types: [] })).toBe(0);
    expect(svc.counts().actionsNeeded).toBe(2);
  });
});

describe('activity.markRead', () => {
  it('marks the given ids, emits activity.read with full counts and returns the two counts it owns', () => {
    const { env, svc, add } = setup();
    add({ id: 'a' }); add({ id: 'b' }); add({ id: 'c', requiresAction: true });
    env.clearEvents();
    const counts = svc.markRead({ ids: ['a', 'c'] });
    expect(counts).toEqual({ unreadActivity: 1, actionsNeeded: 1 });
    expect(env.of('activity.read')).toEqual([{
      type: 'activity.read', ids: ['a', 'c'],
      counts: { unreadActivity: 1, actionsNeeded: 1, pendingActions: 3, reportsAwaitingHandoff: 2, liveSessions: 4 },
    }]);
    expect(svc.get('a')!.read).toBe(true);
    expect(svc.get('b')!.read).toBe(false);
  });

  it('marks everything, or everything of one project', () => {
    const { env, svc, add } = setup();
    env.db.run(`INSERT INTO projects (id, name, default_env, notification_prefs_json, created_at, updated_at) VALUES ('prj_1','One','win','{}','t','t')`);
    add({ id: 'a', projectId: 'prj_1' }); add({ id: 'b' }); add({ id: 'c', projectId: 'prj_1' });
    expect(svc.markRead({ projectId: 'prj_1' })).toEqual({ unreadActivity: 1, actionsNeeded: 0 });
    expect(env.of('activity.read')[0].ids).toEqual(['a', 'c']);
    expect(svc.markRead({ all: true })).toEqual({ unreadActivity: 0, actionsNeeded: 0 });
    expect(env.of('activity.read')[1].ids).toEqual(['b']);
  });

  it('says nothing when nothing changed, and does nothing without a selector', () => {
    const { env, svc, add } = setup();
    add({ id: 'a' });
    svc.markRead({ ids: ['a'] });
    env.clearEvents();
    expect(svc.markRead({ ids: ['a'] })).toEqual({ unreadActivity: 0, actionsNeeded: 0 });
    expect(svc.markRead({ all: true })).toEqual({ unreadActivity: 0, actionsNeeded: 0 });
    add({ id: 'fresh' });
    env.clearEvents();
    expect(svc.markRead({})).toEqual({ unreadActivity: 1, actionsNeeded: 0 });
    expect(svc.markRead({ ids: [] })).toEqual({ unreadActivity: 1, actionsNeeded: 0 });
    expect(env.events).toEqual([]);
    expect(svc.get('fresh')!.read).toBe(false);
  });

  it('does not resolve what it reads', () => {
    const { svc, add } = setup();
    add({ id: 'todo', requiresAction: true });
    svc.markRead({ all: true });
    expect(svc.get('todo')).toMatchObject({ read: true, resolvedAt: null });
    expect(svc.counts().actionsNeeded).toBe(1);
  });
});

describe('activity.counts', () => {
  it('counts unread entries and entries that still need action', () => {
    const { svc, add } = setup();
    expect(svc.counts()).toEqual({ unreadActivity: 0, actionsNeeded: 0 });
    add({ id: 'a' });
    add({ id: 'b', requiresAction: true });
    add({ id: 'c', requiresAction: true });
    expect(svc.counts()).toEqual({ unreadActivity: 3, actionsNeeded: 2 });
    svc.resolve({ ids: ['b'] });
    expect(svc.counts()).toEqual({ unreadActivity: 3, actionsNeeded: 1 });
    svc.markRead({ ids: ['a', 'c'] });
    expect(svc.counts()).toEqual({ unreadActivity: 1, actionsNeeded: 1 });
  });
});

describe('activity.prune', () => {
  const OLD = '2026-01-01T00:00:00.000Z';
  const NEW = '2026-10-01T00:00:00.000Z';
  const CUTOFF = '2026-06-01T00:00:00.000Z';

  it('deletes only read entries that no longer need action and are older than the cutoff', () => {
    const { svc, add } = setup();
    const cases: { id: string; at: string; read: boolean; requiresAction: boolean; resolved: boolean; gone: boolean }[] = [
      { id: 'old_read_info', at: OLD, read: true, requiresAction: false, resolved: false, gone: true },
      { id: 'old_read_resolved', at: OLD, read: true, requiresAction: true, resolved: true, gone: true },
      { id: 'old_unread_info', at: OLD, read: false, requiresAction: false, resolved: false, gone: false },
      { id: 'old_read_open_action', at: OLD, read: true, requiresAction: true, resolved: false, gone: false },
      { id: 'old_unread_open_action', at: OLD, read: false, requiresAction: true, resolved: false, gone: false },
      { id: 'new_read_info', at: NEW, read: true, requiresAction: false, resolved: false, gone: false },
      { id: 'new_read_resolved', at: NEW, read: true, requiresAction: true, resolved: true, gone: false },
    ];
    for (const c of cases) {
      add({ id: c.id, at: c.at, requiresAction: c.requiresAction });
      if (c.resolved) svc.resolve({ ids: [c.id] });
      if (c.read) svc.markRead({ ids: [c.id] });
    }
    expect(svc.prune(CUTOFF)).toBe(cases.filter((c) => c.gone).length);
    for (const c of cases) expect([c.id, svc.get(c.id) === null]).toEqual([c.id, c.gone]);
  });

  it('is a no-op when nothing qualifies', () => {
    const { svc, add } = setup();
    add({ at: OLD });
    expect(svc.prune(CUTOFF)).toBe(0);
  });
});
