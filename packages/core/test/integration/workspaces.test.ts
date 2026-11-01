// A temporary workspace through the real core: real SQLite, real HTTP, real PTY with the fake Claude, real git against a local bare
// repository that stands in for GitHub. Nothing here touches a real project folder.
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '@minisumma/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir } from '../infra/part1-fixtures.ts';
import { makeRemote, realClone, sh } from '../workspaces/fixture.ts';
import { cleanup, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const open: Harness[] = [];
afterEach(async () => { while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); } cleanupTempDirs(); });

async function boot() {
  const remote = makeRemote();
  const wsRoot = tempDir('ms-int-ws-');
  const trashed: string[] = [];
  const core = {
    overrides: {
      workspaces: {
        root: wsRoot, git: remote.git, clone: realClone(remote), repoSize: async () => 500, freeBytes: async () => 1e11,
        trash: async (target: string) => { trashed.push(target); fs.rmSync(target, { recursive: true, force: true }); },
      },
    },
  };
  const h = await startHarness({ core: core as never });
  open.push(h);
  return { h, remote, wsRoot, trashed, core };
}

const ready = async (h: Harness, id: string) => h.waitFor('the workspace to be ready', async () => {
  const w = await h.client.call('workspaces.get', { params: { id } });
  return w.status !== 'cloning' ? w : undefined;
});

describe('temporary workspaces through the real core', () => {
  it('downloads, starts Claude in the checkout next to a permanent folder, protects it while running, and cleans up only when safe', async () => {
    const { h, trashed } = await boot();
    // The permanent checkout of the same repository: it must stay out of everything below.
    const { project, dir: permanent } = await h.project('Widgets', { github: 'acme/widgets' });
    fs.writeFileSync(path.join(permanent, 'precious.txt'), 'mine');

    const check = await h.client.call('workspaces.check', { params: { id: project.id } });
    expect(check).toMatchObject({ access: 'ok', defaultBranch: 'main', blockers: [] });
    const made = await h.client.call('workspaces.create', { params: { id: project.id }, body: { confirmed: true, featureBranch: 'feature/billing' } });
    const w = await ready(h, made.id);
    expect(w).toMatchObject({ status: 'ready', featureBranch: 'feature/billing' });
    expect(w.path).not.toContain('Widgets');

    // A session in the workspace and one in the permanent folder, side by side.
    const temp = await h.client.call('sessions.start', { params: { id: project.id }, body: { mode: 'new', workspaceId: w.id } });
    const perm = await h.start(project.id);
    expect(temp.cwd).toBe(w.path);
    expect(temp.projectId).toBe(project.id);
    expect(perm.cwd).toBe(permanent);
    expect(temp.key).not.toBe(perm.key);
    // One project, two sessions: no second project appeared.
    expect((await h.client.call('projects.list', {})).map((p) => p.name)).toEqual(['Widgets']);

    // While Claude runs in the workspace it cannot be cleaned up.
    const busy = await h.client.call('workspaces.inspect', { params: { id: w.id } });
    expect(busy.running.length).toBe(1);
    expect(busy.safeToClean).toBe(false);
    const refused = await h.client.call('workspaces.cleanup', { params: { id: w.id }, body: { confirmRepo: 'acme/widgets' } }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe('cleanup_blocked');
    expect(fs.existsSync(w.path)).toBe(true);

    // Stopped, clean and published: cleanup works, with the Recycle Bin, and the permanent folder is untouched.
    await h.client.call('sessions.stop', { params: { key: temp.key }, body: { force: true } });
    await h.waitFor('the session to end', async () => (await h.client.call('sessions.get', { params: { key: temp.key } })).availability !== 'live' || undefined);
    const idle = await h.client.call('workspaces.inspect', { params: { id: w.id } });
    expect(idle).toMatchObject({ running: [], trackedChanges: 0, untracked: 0, safeToClean: true });
    const done = await h.client.call('workspaces.cleanup', { params: { id: w.id }, body: { confirmRepo: 'acme/widgets' } });
    expect(done.status).toBe('removed');
    expect(trashed).toHaveLength(1);
    expect(fs.readFileSync(path.join(permanent, 'precious.txt'), 'utf8')).toBe('mine');
    expect((await h.client.call('projects.get', { params: { id: project.id } })).roots).toHaveLength(1);
  }, 90_000);

  it('keeps a workspace with work in it after a restart, and refuses to clean it up until the work is pushed', async () => {
    const { h, remote, core } = await boot();
    const { project } = await h.project('Widgets', { github: 'acme/widgets' });
    const made = await h.client.call('workspaces.create', { params: { id: project.id }, body: { confirmed: true } });
    const w = await ready(h, made.id);
    fs.writeFileSync(path.join(w.path, 'work.txt'), 'unsaved work');
    sh(w.path, 'add', '.'); sh(w.path, 'commit', '-q', '-m', 'work');

    const again = await h.restart();
    open.push(again);
    const [listed] = await again.client.call('workspaces.list', { params: { id: project.id } });
    expect(listed).toMatchObject({ id: w.id, status: 'ready', path: w.path });
    // Resumable in the same checkout after the restart.
    const s = await again.client.call('sessions.start', { params: { id: project.id }, body: { mode: 'new', workspaceId: w.id } });
    expect(s.cwd).toBe(w.path);
    await again.client.call('sessions.stop', { params: { key: s.key }, body: { force: true } });
    await again.waitFor('the session to end', async () => (await again.client.call('sessions.get', { params: { key: s.key } })).availability !== 'live' || undefined);

    // A commit is not publication.
    const unsafe = await again.client.call('workspaces.inspect', { params: { id: w.id } });
    expect(unsafe).toMatchObject({ unpushedCommits: 1, publication: 'unpublished', safeToClean: false });
    const err = await again.client.call('workspaces.cleanup', { params: { id: w.id }, body: { confirmRepo: 'acme/widgets' } }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('cleanup_blocked');
    expect(fs.existsSync(path.join(w.path, 'work.txt'))).toBe(true);
    // A failed push changes nothing.
    remote.down.value = true;
    expect((await again.client.call('workspaces.inspect', { params: { id: w.id } })).safeToClean).toBe(false);
    remote.down.value = false;
    await remote.git(w.path, ['push', 'origin', 'main']);
    expect((await again.client.call('workspaces.inspect', { params: { id: w.id } }))).toMatchObject({ publication: 'published', safeToClean: true });
    void core;
  }, 90_000);

  it('starts nothing in a workspace of another project or one that is not ready', async () => {
    const { h } = await boot();
    const a = await h.project('Widgets', { github: 'acme/widgets' });
    const b = await h.project('Other', { github: 'acme/other' });
    const made = await h.client.call('workspaces.create', { params: { id: a.project.id }, body: { confirmed: true } });
    await ready(h, made.id);
    const err = await h.client.call('sessions.start', { params: { id: b.project.id }, body: { mode: 'new', workspaceId: made.id } }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('workspace_other_project');
    const missing = await h.client.call('sessions.start', { params: { id: a.project.id }, body: { mode: 'new', workspaceId: 'nope' } }).catch((e: unknown) => e);
    expect((missing as ApiError).status).toBe(404);
  }, 60_000);
});
