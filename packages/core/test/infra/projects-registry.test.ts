import { createRegistry } from '@minisumma/claude-integration';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_A, makeProjectsEnv } from './part1-fixtures.ts';
import type { ProjectsEnv } from './part1-fixtures.ts';

let env: ProjectsEnv;
afterEach(() => env?.base.close());
const setup = (opts?: Parameters<typeof makeProjectsEnv>[0]) => { env = makeProjectsEnv(opts); return env.projects; };

describe('matching a working directory to a project', () => {
  it('matches a Windows project from a WSL session through /mnt/c, and the other way round', () => {
    const projects = setup();
    const win = projects.create({ name: 'Windows app', roots: [{ path: 'C:\\Dev\\App' }] });
    const wsl = projects.create({ name: 'WSL lib', roots: [{ path: '/mnt/d/Work/Lib', env: 'wsl:Ubuntu' }] });
    const reg = projects.registry();

    const fromWsl = reg.resolve('/mnt/c/Dev/App/src/index.ts', 'wsl:Ubuntu');
    expect(fromWsl).toMatchObject({ reason: 'matched', project: { id: win.id, name: 'Windows app' }, canonical: { fs: 'win', path: 'c:\\dev\\app\\src\\index.ts' } });
    // any distribution mounts the same drive
    expect(reg.resolve('/mnt/c/dev/app', 'wsl:Debian')).toMatchObject({ reason: 'matched', project: { id: win.id } });
    expect(reg.resolve('C:\\DEV\\App\\sub', 'win')).toMatchObject({ reason: 'matched', project: { id: win.id } });

    expect(reg.resolve('D:\\Work\\Lib\\pkg', 'win')).toMatchObject({ reason: 'matched', project: { id: wsl.id } });
    expect(reg.resolve('/mnt/d/work/lib', 'wsl:Ubuntu')).toMatchObject({ reason: 'matched', project: { id: wsl.id } });
  });

  it('keeps the same path in two WSL distributions apart', () => {
    const projects = setup();
    const ubuntu = projects.create({ name: 'Ubuntu app', roots: [{ path: '/home/me/app', env: 'wsl:Ubuntu' }] });
    const debian = projects.create({ name: 'Debian app', roots: [{ path: '/home/me/app', env: 'wsl:Debian' }] });
    const reg = projects.registry();

    expect(reg.resolve('/home/me/app/src', 'wsl:Ubuntu').project?.id).toBe(ubuntu.id);
    expect(reg.resolve('/home/me/app/src', 'wsl:Debian').project?.id).toBe(debian.id);
    // a third distribution, or plain Linux, has never been registered
    expect(reg.resolve('/home/me/app/src', 'wsl:Fedora')).toMatchObject({ project: null, reason: 'unregistered_directory' });
    expect(reg.resolve('/home/me/app/src', 'posix')).toMatchObject({ project: null, reason: 'unregistered_directory' });
    // Windows reaches a distribution through its UNC share
    expect(reg.resolve('\\\\wsl$\\Ubuntu\\home\\me\\app\\src', 'win').project?.id).toBe(ubuntu.id);
    expect(reg.resolve('\\\\wsl.localhost\\Debian\\home\\me\\app', 'win').project?.id).toBe(debian.id);
  });

  it('picks the longest matching root, by path segment and not by text prefix', () => {
    const projects = setup({ hostPlatform: 'linux', hostEnv: 'posix' });
    const outer = projects.create({ name: 'Outer', roots: [{ path: '/work' }] });
    const inner = projects.create({ name: 'Inner', roots: [{ path: '/work/sub' }] });
    const reg = projects.registry();
    expect(reg.resolve('/work/sub/deep/file', 'posix').project?.id).toBe(inner.id);
    expect(reg.resolve('/work/sub', 'posix').project?.id).toBe(inner.id);
    expect(reg.resolve('/work/subway/x', 'posix').project?.id).toBe(outer.id);
    expect(reg.resolve('/work/other', 'posix').project?.id).toBe(outer.id);
    expect(reg.resolve('/workshop', 'posix')).toMatchObject({ project: null, reason: 'unregistered_directory' });
  });

  it('reports ambiguity instead of guessing when two projects claim the same folder', () => {
    const projects = setup();
    const a = projects.create({ name: 'A', roots: [{ path: 'C:\\Dev\\App' }] });
    const b = projects.create({ name: 'B' });
    // The service refuses this (root_in_use); a database from before that rule may still contain it.
    env.base.db.run(
      "INSERT INTO project_roots (id, project_id, env, path, label, position, root_key) VALUES ('rot_legacy', ?, 'wsl:Ubuntu', '/mnt/c/Dev/App', NULL, 0, 'legacy-spelling')",
      [b.id],
    );
    const result = projects.registry().resolve('C:\\Dev\\App\\x', 'win');
    expect(result.project).toBeNull();
    expect(result.reason).toBe('ambiguous');
    expect([...(result.candidates ?? [])].sort()).toEqual([a.id, b.id].sort());
  });

  it('says why nothing matched', () => {
    const projects = setup();
    projects.create({ name: 'A', roots: [{ path: 'C:\\Dev\\App' }] });
    const reg = projects.registry();
    expect(reg.resolve('C:\\Elsewhere', 'win')).toMatchObject({ project: null, reason: 'unregistered_directory' });
    expect(reg.resolve('', 'win')).toMatchObject({ project: null, reason: 'no_cwd' });
    expect(reg.defaultEnv).toBe('win');
  });

  it('does not match archived projects, and matches them again once restored', () => {
    const projects = setup();
    const p = projects.create({ name: 'A', roots: [{ path: 'C:\\Dev\\App' }] });
    expect(projects.registry().resolve('C:\\Dev\\App', 'win').project?.id).toBe(p.id);
    projects.update(p.id, { archived: true });
    expect(projects.registry().resolve('C:\\Dev\\App', 'win')).toMatchObject({ project: null, reason: 'unregistered_directory' });
    projects.update(p.id, { archived: false });
    expect(projects.registry().resolve('C:\\Dev\\App', 'win').project?.id).toBe(p.id);
  });
});

describe('keeping the registry current', () => {
  const resolveName = (projects: ReturnType<typeof setup>, cwd = 'C:\\Dev\\App') => projects.registry().resolve(cwd, 'win').project?.name ?? null;

  it('hands out the same matcher until something it depends on changes', () => {
    const projects = setup();
    const p = projects.create({ name: 'A', roots: [{ path: 'C:\\Dev\\App' }] });
    const first = projects.registry();
    expect(projects.registry()).toBe(first);

    // changes that cannot alter an answer leave the matcher alone
    projects.update(p.id, { description: 'text', notificationPrefs: { report: false } });
    projects.reorder([p.id]);
    projects.conversations.add(p.id, { url: CHAT_A });
    projects.setDefaultSession(p.id, 'win|aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(projects.registry()).toBe(first);
  });

  it('rebuilds after every change of roots, names, archiving and deleting', () => {
    const projects = setup();
    const seen = new Set<unknown>();
    const fresh = (label: string): void => {
      const reg = projects.registry();
      expect(seen.has(reg), `${label}: still the old matcher`).toBe(false);
      seen.add(reg);
    };
    seen.add(projects.registry());

    const p = projects.create({ name: 'A', roots: [{ path: 'C:\\Dev\\App' }] }); fresh('create');
    expect(resolveName(projects)).toBe('A');
    const q = projects.addRoot(p.id, { path: 'C:\\Dev\\Lib' }); fresh('addRoot');
    expect(resolveName(projects, 'C:\\Dev\\Lib\\x')).toBe('A');
    projects.removeRoot(p.id, q.roots[1].id); fresh('removeRoot');
    expect(resolveName(projects, 'C:\\Dev\\Lib\\x')).toBeNull();
    projects.update(p.id, { name: 'Renamed' }); fresh('rename');
    expect(resolveName(projects)).toBe('Renamed');
    projects.update(p.id, { archived: true }); fresh('archive');
    expect(resolveName(projects)).toBeNull();
    projects.update(p.id, { archived: false }); fresh('restore');
    expect(resolveName(projects)).toBe('Renamed');
    projects.remove(p.id, 'delete'); fresh('delete');
    expect(resolveName(projects)).toBeNull();
  });

  it('writes the file the hook reads: default environment and, per live project, its roots with their environments', () => {
    const projects = setup({ hostPlatform: 'win32', hostEnv: 'win' });
    const a = projects.create({ name: 'A', roots: [{ path: 'C:\\Dev\\App', label: 'ignored here' }, { path: '/home/me/lib', env: 'wsl:Ubuntu' }] });
    const b = projects.create({ name: 'B', roots: [{ path: 'C:\\Dev\\B' }] });
    const gone = projects.create({ name: 'Gone', roots: [{ path: 'C:\\Dev\\Gone' }] });
    projects.update(gone.id, { archived: true });
    const empty = projects.create({ name: 'No folders yet' });

    const file = projects.registryFileContents();
    expect(file).toEqual({
      defaultEnv: 'win',
      projects: [
        { id: a.id, name: 'A', roots: [{ path: 'C:\\Dev\\App', env: 'win' }, { path: '/home/me/lib', env: 'wsl:Ubuntu' }] },
        { id: b.id, name: 'B', roots: [{ path: 'C:\\Dev\\B', env: 'win' }] },
        { id: empty.id, name: 'No folders yet', roots: [] },
      ],
    });
    // it is plain JSON, and the verified matcher answers the same from the file as from the service
    const fromFile = createRegistry(JSON.parse(JSON.stringify(file)), { real: false });
    for (const [cwd, e] of [['C:\\Dev\\App\\x', 'win'], ['/mnt/c/dev/b', 'wsl:Debian'], ['/home/me/lib/y', 'wsl:Ubuntu'], ['C:\\Dev\\Gone', 'win'], ['D:\\none', 'win']] as const) {
      expect(fromFile.resolve(cwd, e)).toEqual(projects.registry().resolve(cwd, e));
    }
  });

  it('reports the host environment as the default, as configured', () => {
    const projects = setup({ hostPlatform: 'linux', hostEnv: 'wsl:Ubuntu' });
    expect(projects.registryFileContents().defaultEnv).toBe('wsl:Ubuntu');
    expect(projects.registry().defaultEnv).toBe('wsl:Ubuntu');
  });
});

describe('onRootsChanged', () => {
  it('fires once after each change that alters what the registry would answer', () => {
    const projects = setup();
    const count = (): number => env.rootsChanged.count;
    const steps: [string, () => unknown][] = [];
    let id = '';
    let rootId = '';
    steps.push(['create with roots', () => { const p = projects.create({ name: 'A', roots: [{ path: 'C:\\a' }, { path: 'C:\\b' }] }); id = p.id; rootId = p.roots[0].id; }]);
    steps.push(['addRoot', () => projects.addRoot(id, { path: 'C:\\c' })]);
    steps.push(['removeRoot', () => projects.removeRoot(id, rootId)]);
    steps.push(['rename', () => projects.update(id, { name: 'B' })]);
    steps.push(['archive', () => projects.update(id, { archived: true })]);
    steps.push(['restore', () => projects.update(id, { archived: false })]);
    steps.push(['delete', () => projects.remove(id, 'delete')]);
    for (const [name, run] of steps) {
      const before = count();
      run();
      expect(count() - before, name).toBe(1);
    }
  });

  it('stays quiet for changes that cannot alter an answer', () => {
    const projects = setup();
    const p = projects.create({ name: 'A', roots: [{ path: 'C:\\a' }] });
    const before = env.rootsChanged.count;
    projects.update(p.id, { description: 'd', githubRepo: 'a/b', defaultEnv: 'wsl:Ubuntu', notificationPrefs: { push: false } });
    projects.update(p.id, { name: 'A' });
    projects.update(p.id, { archived: false });
    projects.reorder([p.id]);
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    projects.conversations.setPreferred(p.id, c.id);
    projects.setDefaultSession(p.id, null);
    expect(() => projects.addRoot(p.id, { path: 'C:\\a' })).toThrow(); // refused, so nothing changed
    expect(env.rootsChanged.count).toBe(before);
  });

  it('lets a listener see the new state through registry(), and lets listeners unsubscribe', () => {
    const projects = setup();
    const seen: (string | null)[] = [];
    const off = projects.onRootsChanged(() => { seen.push(projects.registry().resolve('C:\\Dev\\New', 'win').project?.name ?? null); });
    const p = projects.create({ name: 'Fresh', roots: [{ path: 'C:\\Dev\\New' }] });
    expect(seen).toEqual(['Fresh']);
    off();
    projects.update(p.id, { name: 'Other' });
    expect(seen).toEqual(['Fresh']);
  });

  it('does not let a failing listener undo the change or silence the others', () => {
    const projects = setup();
    let second = 0;
    projects.onRootsChanged(() => { throw new Error('listener bug'); });
    projects.onRootsChanged(() => { second += 1; });
    const p = projects.create({ name: 'A', roots: [{ path: 'C:\\a' }] });
    expect(projects.get(p.id)).not.toBeNull();
    expect(second).toBe(1);
    expect(env.base.log.lines.some((l) => l.level === 'warn' && /roots-changed listener failed/.test(l.msg))).toBe(true);
  });

  it('fires after the event for the project went out, so a client never sees roots the registry lacks', () => {
    const projects = setup();
    let eventsWhenFired = -1;
    projects.onRootsChanged(() => { eventsWhenFired = env.base.eventsOf('project.upserted').length; });
    projects.create({ name: 'A', roots: [{ path: 'C:\\a' }] });
    expect(eventsWhenFired).toBe(1);
  });
});
