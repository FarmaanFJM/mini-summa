import { defaultNotificationPrefs } from '@minisumma/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.ts';
import { expectPlainText, failure, makeProjectsEnv } from './part1-fixtures.ts';
import type { ProjectsEnv } from './part1-fixtures.ts';

let env: ProjectsEnv;
afterEach(() => env?.base.close());
const setup = (opts?: Parameters<typeof makeProjectsEnv>[0]) => { env = makeProjectsEnv(opts); return env.projects; };

describe('creating and reading projects', () => {
  it('creates a project with defaults and emits project.upserted once', () => {
    const projects = setup();
    const p = projects.create({ name: '  Billing API  ', description: 'Invoices', githubRepo: 'acme/billing' });
    expect(p).toMatchObject({
      name: 'Billing API', description: 'Invoices', githubRepo: 'acme/billing', roots: [], defaultEnv: 'win',
      preferredConversationId: null, defaultSessionKey: null, sortOrder: 0, archivedAt: null,
      createdAt: '2026-03-01T12:00:00.000Z', updatedAt: '2026-03-01T12:00:00.000Z',
    });
    expect(p.id).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(projects.get(p.id)).toEqual(p);
    expect(projects.require(p.id)).toEqual(p);
    const events = env.base.eventsOf('project.upserted');
    expect(events).toHaveLength(1);
    expect(events[0].project).toEqual(p);
  });

  it('numbers new projects after the last one and lists them in that order', () => {
    const projects = setup();
    const a = projects.create({ name: 'A' });
    const b = projects.create({ name: 'B' });
    const c = projects.create({ name: 'C' });
    expect([a.sortOrder, b.sortOrder, c.sortOrder]).toEqual([0, 1, 2]);
    expect(projects.list().map((p) => p.name)).toEqual(['A', 'B', 'C']);
  });

  it('puts the roots in the project JSON, in the order given, with the environment of each', () => {
    const projects = setup({ hostPlatform: 'win32' });
    const p = projects.create({ name: 'Mixed', roots: [{ path: 'C:\\Dev\\App', label: 'app' }, { path: '/home/me/lib', env: 'wsl:Ubuntu' }] });
    expect(p.roots.map((r) => [r.env, r.path, r.label, r.position])).toEqual([['win', 'C:\\Dev\\App', 'app', 0], ['wsl:Ubuntu', '/home/me/lib', null, 1]]);
    expect(p.roots.every((r) => r.projectId === p.id && /^rot_/.test(r.id))).toBe(true);
    expect(p.defaultEnv).toBe('win');
  });

  it('defaults the environment to the first root, then to the host, and honours an explicit one', () => {
    const projects = setup({ hostPlatform: 'win32', hostEnv: 'win' });
    expect(projects.create({ name: 'a', roots: [{ path: '/srv/x', env: 'wsl:Debian' }] }).defaultEnv).toBe('wsl:Debian');
    expect(projects.create({ name: 'b' }).defaultEnv).toBe('win');
    expect(projects.create({ name: 'c', defaultEnv: 'wsl:Ubuntu', roots: [{ path: 'C:\\Dev\\c' }] }).defaultEnv).toBe('wsl:Ubuntu');
  });

  it('starts notification preferences from the current defaults in settings, and keeps them after the defaults change', () => {
    const projects = setup();
    env.settings.update({ notifications: { defaults: { sessionEnded: true, report: false, push: false } } });
    const first = projects.create({ name: 'first' });
    expect(first.notificationPrefs).toEqual({ ...defaultNotificationPrefs(), sessionEnded: true, report: false, push: false });
    env.settings.update({ notifications: { defaults: { report: true, enabled: false } } });
    expect(projects.get(first.id)?.notificationPrefs.report).toBe(false);
    expect(projects.create({ name: 'second' }).notificationPrefs).toMatchObject({ report: true, enabled: false });
  });

  it('returns null from get and a 404 from require for a project that does not exist', () => {
    const projects = setup();
    expect(projects.get('prj_missing')).toBeNull();
    const err = failure(() => projects.require('prj_missing'));
    expect(err).toBeInstanceOf(CoreError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expectPlainText(err.message);
    expect(failure(() => projects.update('prj_missing', { name: 'x' })).status).toBe(404);
    expect(failure(() => projects.addRoot('prj_missing', { path: 'C:\\x' })).status).toBe(404);
    expect(failure(() => projects.remove('prj_missing', 'delete')).status).toBe(404);
  });

  it('rejects input that cannot be a project, saying what to fix', () => {
    const projects = setup();
    for (const [input, code] of [
      [{ name: '   ' }, 'invalid_name'],
      [{ name: 'x'.repeat(121) }, 'invalid_name'],
      [{ name: 'ok', githubRepo: 'not a repo' }, 'invalid_repo'],
      [{ name: 'ok', description: 'x'.repeat(2001) }, 'invalid_text'],
      [{ name: 'ok', defaultEnv: 'mac' as never }, 'invalid_env'],
    ] as const) {
      const err = failure(() => projects.create(input));
      expect(err.status).toBe(400);
      expect(err.code).toBe(code);
      expectPlainText(err.message);
    }
    expect(projects.list({ includeArchived: true })).toEqual([]);
    expect(env.base.events).toHaveLength(0);
  });
});

describe('updating a project', () => {
  it('changes the fields it is given, trims text, and turns empty text into null', () => {
    const projects = setup();
    const p = projects.create({ name: 'Old', description: 'text', githubRepo: 'a/b' });
    env.base.clock.advance(5000);
    const u = projects.update(p.id, { name: ' New ', description: '   ', githubRepo: null, defaultEnv: 'wsl:Ubuntu' });
    expect(u).toMatchObject({ name: 'New', description: null, githubRepo: null, defaultEnv: 'wsl:Ubuntu', updatedAt: '2026-03-01T12:00:05.000Z' });
    expect(projects.get(p.id)).toEqual(u);
    expect(env.base.eventsOf('project.upserted').at(-1)?.project).toEqual(u);
  });

  it('does nothing, and says nothing, when the values are the same', () => {
    const projects = setup();
    const p = projects.create({ name: 'Same', description: 'd' });
    const before = env.base.events.length;
    env.base.clock.advance(5000);
    expect(projects.update(p.id, { name: 'Same', description: 'd', notificationPrefs: { enabled: true } })).toEqual(p);
    expect(projects.update(p.id, {})).toEqual(p);
    expect(env.base.events).toHaveLength(before);
  });

  it('merges notification preferences over the stored ones, one key at a time', () => {
    const projects = setup();
    const p = projects.create({ name: 'N' });
    const a = projects.update(p.id, { notificationPrefs: { report: false } });
    const b = projects.update(p.id, { notificationPrefs: { sessionEnded: true, push: false } });
    expect(a.notificationPrefs).toEqual({ ...defaultNotificationPrefs(), report: false });
    expect(b.notificationPrefs).toEqual({ ...defaultNotificationPrefs(), report: false, sessionEnded: true, push: false });
    expect(projects.update(p.id, { notificationPrefs: { bogus: true } as never }).notificationPrefs).toEqual(b.notificationPrefs);
    const err = failure(() => projects.update(p.id, { notificationPrefs: { report: 'no' as never } }));
    expect(err).toMatchObject({ status: 400, code: 'invalid_prefs' });
    expect(projects.get(p.id)?.notificationPrefs).toEqual(b.notificationPrefs);
  });

  it('tolerates a stored preference blob from an older build (missing keys, junk values)', () => {
    const projects = setup();
    const p = projects.create({ name: 'Old build' });
    env.base.db.run('UPDATE projects SET notification_prefs_json = ? WHERE id = ?', [JSON.stringify({ report: false, push: 'maybe', gone: 1 }), p.id]);
    expect(projects.require(p.id).notificationPrefs).toEqual({ ...defaultNotificationPrefs(), report: false });
  });
});

describe('archive and restore', () => {
  it('hides an archived project from the list but keeps it readable, and restoring brings it back', () => {
    const projects = setup();
    const a = projects.create({ name: 'A' });
    const b = projects.create({ name: 'B' });
    env.base.clock.advance(1000);
    const archived = projects.update(a.id, { archived: true });
    expect(archived.archivedAt).toBe('2026-03-01T12:00:01.000Z');
    expect(projects.list().map((p) => p.name)).toEqual(['B']);
    expect(projects.list({ includeArchived: true }).map((p) => p.name)).toEqual(['A', 'B']);
    expect(projects.get(a.id)?.archivedAt).not.toBeNull();
    env.base.clock.advance(1000);
    expect(projects.update(a.id, { archived: true }).archivedAt).toBe('2026-03-01T12:00:01.000Z');
    const restored = projects.update(a.id, { archived: false });
    expect(restored.archivedAt).toBeNull();
    expect(projects.list().map((p) => p.name)).toEqual(['A', 'B']);
    expect(b.archivedAt).toBeNull();
  });

  it('treats remove(id, "archive") exactly like update({archived:true})', () => {
    const projects = setup();
    const p = projects.create({ name: 'Archive me', roots: [{ path: 'C:\\Dev\\x' }] });
    const before = env.base.eventsOf('project.upserted').length;
    projects.remove(p.id, 'archive');
    expect(projects.get(p.id)?.archivedAt).not.toBeNull();
    expect(projects.get(p.id)?.roots).toHaveLength(1);
    expect(env.base.eventsOf('project.upserted')).toHaveLength(before + 1);
    expect(env.base.eventsOf('project.removed')).toHaveLength(0);
  });

  it('refuses an unknown removal mode', () => {
    const projects = setup();
    const p = projects.create({ name: 'x' });
    expect(failure(() => projects.remove(p.id, 'vanish' as never))).toMatchObject({ status: 400, code: 'invalid_mode' });
    expect(projects.get(p.id)).not.toBeNull();
  });

  it('rejects an "archived" value that is not true or false', () => {
    const projects = setup();
    const p = projects.create({ name: 'x' });
    expect(failure(() => projects.update(p.id, { archived: 'yes' as never })).status).toBe(400);
  });
});

describe('ordering and the default session', () => {
  it('reorders by the given list and tells clients only about the projects that moved', () => {
    const projects = setup();
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name) => projects.create({ name }));
    const before = env.base.eventsOf('project.upserted').length;
    projects.reorder([c.id, a.id, b.id, d.id]);
    expect(projects.list().map((p) => p.name)).toEqual(['C', 'A', 'B', 'D']);
    const moved = env.base.eventsOf('project.upserted').slice(before).map((e) => e.project.name).sort();
    expect(moved).toEqual(['A', 'B', 'C']);
  });

  it('leaves projects that are not in the list where they were (an archived one keeps its place)', () => {
    const projects = setup();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => projects.create({ name }));
    projects.update(b.id, { archived: true });
    projects.reorder([c.id, a.id]); // what the UI sees: B is hidden
    expect(projects.list().map((p) => p.name)).toEqual(['C', 'A']);
    projects.update(b.id, { archived: false });
    expect(projects.list().map((p) => p.name)).toEqual(['C', 'B', 'A']);
  });

  it('ignores unknown and repeated ids, and a list too short to change anything', () => {
    const projects = setup();
    const [a, b] = ['A', 'B'].map((name) => projects.create({ name }));
    const before = env.base.events.length;
    projects.reorder(['prj_nope', b.id, b.id, a.id]);
    expect(projects.list().map((p) => p.name)).toEqual(['B', 'A']);
    expect(env.base.events).toHaveLength(before + 2);
    projects.reorder([]);
    projects.reorder([a.id]);
    expect(projects.list().map((p) => p.name)).toEqual(['B', 'A']);
    expect(env.base.events).toHaveLength(before + 2);
  });

  it('records and clears the default session, validating the key', () => {
    const projects = setup();
    const p = projects.create({ name: 'S' });
    const key = 'wsl:Ubuntu|aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const set = projects.setDefaultSession(p.id, key);
    expect(set.defaultSessionKey).toBe(key);
    expect(env.base.eventsOf('project.upserted').at(-1)?.project.defaultSessionKey).toBe(key);
    const events = env.base.events.length;
    expect(projects.setDefaultSession(p.id, key)).toEqual(set);
    expect(env.base.events).toHaveLength(events);
    expect(projects.setDefaultSession(p.id, null).defaultSessionKey).toBeNull();
    expect(failure(() => projects.setDefaultSession(p.id, 'just-an-id' as never))).toMatchObject({ status: 400, code: 'invalid_session_key' });
  });
});

describe('roots', () => {
  it('cleans a typed Windows path and stores its environment', () => {
    const projects = setup({ hostPlatform: 'win32' });
    const p = projects.create({ name: 'W' });
    const withRoot = projects.addRoot(p.id, { path: ' "c:/Dev//App/" ', label: ' main ' });
    expect(withRoot.roots).toHaveLength(1);
    expect(withRoot.roots[0]).toMatchObject({ env: 'win', path: 'C:\\Dev\\App', label: 'main', position: 0 });
    expect(env.base.eventsOf('project.upserted').at(-1)?.project).toEqual(withRoot);
    // canonical key stored for the uniqueness rule
    expect(env.base.db.get<{ root_key: string }>('SELECT root_key FROM project_roots')?.root_key).toBe('win:c:\\dev\\app');
  });

  it('turns a UNC path of a WSL distribution into a path inside that distribution', () => {
    const projects = setup({ hostPlatform: 'win32' });
    const p = projects.create({ name: 'W' });
    expect(projects.addRoot(p.id, { path: '\\\\wsl$\\Ubuntu\\home\\me\\app' }).roots[0]).toMatchObject({ env: 'wsl:Ubuntu', path: '/home/me/app' });
    expect(projects.addRoot(p.id, { path: '\\\\wsl.localhost\\Debian\\srv\\x\\' }).roots[1]).toMatchObject({ env: 'wsl:Debian', path: '/srv/x' });
  });

  it('asks for an environment when a Linux path is typed on Windows (400 with needsEnv)', () => {
    const projects = setup({ hostPlatform: 'win32' });
    const p = projects.create({ name: 'W' });
    const err = failure(() => projects.addRoot(p.id, { path: '/home/me/app' }));
    expect(err).toMatchObject({ status: 400, code: 'needs_env', details: { needsEnv: true } });
    expect(err.message).toMatch(/WSL distribution/);
    expectPlainText(err.message);
    expect(projects.addRoot(p.id, { path: '/home/me/app', env: 'wsl:Ubuntu' }).roots[0]).toMatchObject({ env: 'wsl:Ubuntu', path: '/home/me/app' });
  });

  it('reads a Linux path as a Linux path on a Linux host, and as the distribution when the host is WSL', () => {
    const linux = setup({ hostPlatform: 'linux', hostEnv: 'posix' });
    expect(linux.create({ name: 'L', roots: [{ path: '/home/me/app/' }] }).roots[0]).toMatchObject({ env: 'posix', path: '/home/me/app' });
    env.base.close();
    const wsl = setup({ hostPlatform: 'linux', hostEnv: 'wsl:Ubuntu' });
    expect(wsl.create({ name: 'W', roots: [{ path: '/home/me/app' }] }).roots[0]).toMatchObject({ env: 'wsl:Ubuntu', path: '/home/me/app' });
    expect(wsl.create({ name: 'W2', roots: [{ path: '/home/me/other', env: 'posix' }] }).roots[0].env).toBe('posix');
  });

  it('rejects paths that are not absolute, or an environment that cannot hold the path', () => {
    const projects = setup({ hostPlatform: 'win32' });
    const p = projects.create({ name: 'W' });
    for (const bad of [{ path: 'relative\\dir' }, { path: '' }, { path: 'C:\\x', env: 'wsl:Ubuntu' as const }, { path: '/x', env: 'win' as const }, { path: 'C:\\x', env: 'weird' as never }]) {
      const err = failure(() => projects.addRoot(p.id, bad));
      expect(err.status).toBe(400);
      expectPlainText(err.message);
    }
    expect(projects.require(p.id).roots).toEqual([]);
  });

  it('refuses a folder that belongs to another project and names that project', () => {
    const projects = setup();
    const a = projects.create({ name: 'Alpha', roots: [{ path: 'C:\\Dev\\App' }] });
    const b = projects.create({ name: 'Beta' });
    // The same folder spelled differently is still the same folder.
    for (const spelling of ['c:\\dev\\app', 'C:/Dev/App/', '"C:\\Dev\\App\\"']) {
      const err = failure(() => projects.addRoot(b.id, { path: spelling }));
      expect(err).toMatchObject({ status: 409, code: 'root_in_use', details: { projectId: a.id, projectName: 'Alpha' } });
      expect(err.message).toContain('"Alpha"');
      expectPlainText(err.message);
    }
    expect(projects.require(b.id).roots).toEqual([]);
    expect(failure(() => projects.create({ name: 'Gamma', roots: [{ path: 'C:\\Dev\\App' }] })).code).toBe('root_in_use');
    expect(projects.list().map((p) => p.name)).toEqual(['Alpha', 'Beta']);
  });

  it('recognises a Windows folder reached through WSL as the same folder', () => {
    const projects = setup();
    projects.create({ name: 'Alpha', roots: [{ path: 'C:\\Dev\\App' }] });
    const b = projects.create({ name: 'Beta' });
    expect(failure(() => projects.addRoot(b.id, { path: '/mnt/c/Dev/App', env: 'wsl:Ubuntu' })).code).toBe('root_in_use');
    expect(failure(() => projects.addRoot(b.id, { path: '/mnt/C/dev/app/', env: 'wsl:Debian' })).code).toBe('root_in_use');
  });

  it('keeps a project that is archived as the owner of its folders, and says so', () => {
    const projects = setup();
    const a = projects.create({ name: 'Old', roots: [{ path: 'C:\\Dev\\App' }] });
    projects.remove(a.id, 'archive');
    const b = projects.create({ name: 'New' });
    const err = failure(() => projects.addRoot(b.id, { path: 'C:\\Dev\\App' }));
    expect(err.code).toBe('root_in_use');
    expect(err.message).toContain('(archived)');
  });

  it('refuses the same folder twice in one project', () => {
    const projects = setup();
    const p = projects.create({ name: 'P', roots: [{ path: 'C:\\Dev\\App' }] });
    const err = failure(() => projects.addRoot(p.id, { path: 'c:\\dev\\app\\' }));
    expect(err).toMatchObject({ status: 409, code: 'root_exists' });
    expect(failure(() => projects.addRoot(p.id, { path: '/mnt/c/dev/app', env: 'wsl:Ubuntu' })).code).toBe('root_exists');
    expect(failure(() => projects.create({ name: 'Twice', roots: [{ path: 'C:\\Dev\\Z' }, { path: 'c:/dev/z' }] })).code).toBe('root_exists');
    expect(projects.list().map((x) => x.name)).toEqual(['P']);
  });

  it('allows nested folders in different projects, and the same POSIX path in two distributions', () => {
    const projects = setup();
    projects.create({ name: 'Mono', roots: [{ path: 'C:\\Dev' }] });
    expect(projects.create({ name: 'App', roots: [{ path: 'C:\\Dev\\App' }] }).roots).toHaveLength(1);
    projects.create({ name: 'U', roots: [{ path: '/home/me/app', env: 'wsl:Ubuntu' }] });
    expect(projects.create({ name: 'D', roots: [{ path: '/home/me/app', env: 'wsl:Debian' }] }).roots[0].env).toBe('wsl:Debian');
  });

  it('removes a root, only from its own project, and re-emits the project', () => {
    const projects = setup();
    const a = projects.create({ name: 'A', roots: [{ path: 'C:\\Dev\\a1' }, { path: 'C:\\Dev\\a2' }] });
    const b = projects.create({ name: 'B', roots: [{ path: 'C:\\Dev\\b1' }] });
    expect(failure(() => projects.removeRoot(a.id, b.roots[0].id))).toMatchObject({ status: 404, code: 'not_found' });
    expect(failure(() => projects.removeRoot(a.id, 'rot_nope')).status).toBe(404);
    expect(projects.require(b.id).roots).toHaveLength(1);
    env.base.clock.advance(2000);
    const after = projects.removeRoot(a.id, a.roots[0].id);
    expect(after.roots.map((r) => r.path)).toEqual(['C:\\Dev\\a2']);
    expect(after.updatedAt).toBe('2026-03-01T12:00:02.000Z');
    expect(env.base.eventsOf('project.upserted').at(-1)?.project).toEqual(after);
    // the freed folder can be used again, by anyone
    expect(projects.addRoot(b.id, { path: 'C:\\Dev\\a1' }).roots.map((r) => r.path)).toEqual(['C:\\Dev\\b1', 'C:\\Dev\\a1']);
  });

  it('gives each new root the next position', () => {
    const projects = setup();
    const p = projects.create({ name: 'P', roots: [{ path: 'C:\\a' }, { path: 'C:\\b' }] });
    const q = projects.removeRoot(p.id, p.roots[0].id);
    expect(projects.addRoot(q.id, { path: 'C:\\c' }).roots.map((r) => [r.path, r.position])).toEqual([['C:\\b', 1], ['C:\\c', 2]]);
  });
});
