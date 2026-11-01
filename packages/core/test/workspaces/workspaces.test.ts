import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.ts';
import { cleanupTempDirs } from '../infra/part1-fixtures.ts';
import { classifyGitFailure, LARGE_REPO_KB } from '../../src/workspaces/service.ts';
import { makeWorkspaces, ready, sh } from './fixture.ts';

afterEach(cleanupTempDirs);

const code = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return (e as CoreError).code; } return 'no error'; };

async function workspace(over = {}) {
  const env = makeWorkspaces(over);
  const made = await env.service.create({ projectId: env.project.id, confirmed: true });
  const w = await ready(env.service, made.id);
  return { ...env, w };
}

describe('checking before a download', () => {
  it('reads access, the default branch and the branches with the person\'s own git', async () => {
    const { service, project } = makeWorkspaces();
    const c = await service.check(project.id);
    expect(c).toMatchObject({ access: 'ok', defaultBranch: 'main', reportedSizeKb: 1024, needsConfirmation: false, blockers: [] });
    expect(c.branches.sort()).toEqual(['dev', 'main']);
    expect(c.warnings.join(' ')).toMatch(/approximate/);
    expect(c.warnings.join(' ')).toMatch(/LFS/);
  });
  it('asks for confirmation when the size is unknown, and does not treat the size as a guarantee', async () => {
    const { service, project } = makeWorkspaces({ repoSize: async () => null });
    const c = await service.check(project.id);
    expect(c.needsConfirmation).toBe(true);
    expect(c.warnings.join(' ')).toMatch(/did not report a size/);
    expect(await code(service.create({ projectId: project.id, confirmed: false }))).toBe('confirmation_required');
  });
  it('asks for confirmation for a large repository', async () => {
    const { service, project } = makeWorkspaces({ repoSize: async () => LARGE_REPO_KB + 1 });
    expect((await service.check(project.id)).needsConfirmation).toBe(true);
  });
  it('blocks when the disk is too small, for a known and for an unknown size', async () => {
    const small = makeWorkspaces({ repoSize: async () => 400 * 1024, freeBytes: async () => 600 * 1024 * 1024 });
    const c = await small.service.check(small.project.id);
    expect(c.blockers[0]).toMatch(/is needed and only/);
    expect(await code(small.service.create({ projectId: small.project.id, confirmed: true }))).toBe('workspace_blocked');
    const unknown = makeWorkspaces({ repoSize: async () => null, freeBytes: async () => 1024 ** 3 });
    expect((await unknown.service.check(unknown.project.id)).blockers[0]).toMatch(/size is unknown/);
  });
  it('explains authentication failures, a missing repository and no network', async () => {
    for (const [stderr, access] of [
      ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'denied'],
      ['remote: Repository not found.\nfatal: repository \'x\' not found', 'not_found'],
      ['fatal: unable to access: Could not resolve host: github.com', 'unreachable'],
    ] as const) {
      const env = makeWorkspaces();
      env.remote.failWith.value = stderr;
      const c = await env.service.check(env.project.id);
      expect(c.access, stderr).toBe(access);
      expect(c.blockers).toHaveLength(1);
      expect(classifyGitFailure(stderr).access).toBe(access);
    }
  });
  it('refuses a project without a repository', async () => {
    const env = makeWorkspaces();
    const bare = env.projects.create({ name: 'Local only' });
    expect((await env.service.check(bare.id)).blockers[0]).toMatch(/no GitHub repository/);
  });
});

describe('creating and reusing a workspace', () => {
  it('clones into <root>/<uuid>/repo, verifies the remote and starts on the default branch', async () => {
    const { w, root } = await workspace();
    expect(w.status).toBe('ready');
    expect(w.path).toBe(path.join(root, w.id, 'repo'));
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.path).not.toMatch(/widgets/);
    expect(w.branch).toBe('main');
    expect(fs.existsSync(path.join(w.path, 'README.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, w.id, 'workspace.json'), 'utf8'))).toMatchObject({ id: w.id, repo: 'acme/widgets' });
  });
  it('creates a feature branch when asked and a given starting branch', async () => {
    const env = makeWorkspaces();
    const made = await env.service.create({ projectId: env.project.id, confirmed: true, branch: 'dev', featureBranch: 'feat/billing' });
    const w = await ready(env.service, made.id);
    expect(w.status).toBe('ready');
    expect(sh(w.path, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feat/billing');
  });
  it('rejects unsafe or taken branch names and unknown starting branches', async () => {
    const env = makeWorkspaces();
    const id = env.project.id;
    expect(await code(env.service.create({ projectId: id, confirmed: true, branch: '--upload-pack=evil' }))).toBe('bad_branch');
    expect(await code(env.service.create({ projectId: id, confirmed: true, featureBranch: 'a b' }))).toBe('bad_branch');
    expect(await code(env.service.create({ projectId: id, confirmed: true, featureBranch: 'dev' }))).toBe('branch_exists');
    expect(await code(env.service.create({ projectId: id, confirmed: true, branch: 'nope' }))).toBe('branch_missing');
  });
  it('keeps several workspaces of one repository apart and runs them concurrently', async () => {
    const env = makeWorkspaces();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => env.service.create({ projectId: env.project.id, confirmed: true })));
    const all = await Promise.all([a, b, c].map((w) => ready(env.service, w.id)));
    expect(new Set(all.map((w) => w.path)).size).toBe(3);
    expect(all.every((w) => w.status === 'ready')).toBe(true);
    expect(env.service.list(env.project.id)).toHaveLength(3);
  });
  it('reports a failed clone, wipes the partial folder and can retry', async () => {
    let attempts = 0;
    const env = makeWorkspaces({
      clone: async ({ dir }) => { attempts += 1; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'partial'), 'x'); return attempts === 1 ? { ok: false, message: 'fatal: early EOF' } : { ok: true, message: '' }; },
    });
    const made = await env.service.create({ projectId: env.project.id, confirmed: true });
    const failed = await ready(env.service, made.id);
    expect(failed.status).toBe('clone_failed');
    expect(fs.existsSync(path.join(failed.path))).toBe(false);
  });
  it('can be cancelled, and a cancelled download leaves nothing behind', async () => {
    const env = makeWorkspaces({
      clone: ({ dir, signal }) => new Promise((resolve) => { fs.mkdirSync(dir, { recursive: true }); const end = (): void => resolve({ ok: false, message: 'cancelled' }); if (signal.aborted) end(); else signal.addEventListener('abort', end); }),
    });
    const made = await env.service.create({ projectId: env.project.id, confirmed: true });
    env.service.cancel(made.id);
    const done = await ready(env.service, made.id);
    expect(done.status).toBe('cancelled');
    expect(fs.existsSync(done.path)).toBe(false);
  });
  it('turns a download that was running at a crash into a retryable failure', async () => {
    const env = makeWorkspaces({ clone: () => new Promise(() => {}) });
    const made = await env.service.create({ projectId: env.project.id, confirmed: true });
    expect(env.service.require(made.id).status).toBe('cloning');
    env.service.init();
    expect(env.service.require(made.id)).toMatchObject({ status: 'clone_failed', error: expect.stringMatching(/closed while/) });
  });
  it('refuses a checkout whose remote is another repository', async () => {
    const env = makeWorkspaces({ clone: async ({ dir }) => { const { sh: s } = await import('./fixture.ts'); fs.mkdirSync(dir, { recursive: true }); s(dir, 'init', '-q'); s(dir, 'remote', 'add', 'origin', 'https://github.com/evil/other.git'); return { ok: true, message: '' }; } });
    const made = await env.service.create({ projectId: env.project.id, confirmed: true });
    const w = await ready(env.service, made.id);
    expect(w.status).toBe('clone_failed');
    expect(w.error).toMatch(/evil\/other/);
  });
  it('resolves a workspace for a session only when it is the checkout it claims to be, after a restart too', async () => {
    const env = await workspace();
    expect(await env.service.resolveForSession(env.w.id, env.project.id)).toBe(env.w.path);
    const other = env.projects.create({ name: 'Other', githubRepo: 'acme/other' });
    expect(await code(env.service.resolveForSession(env.w.id, other.id))).toBe('workspace_other_project');
    env.service.init();
    expect(await env.service.resolveForSession(env.w.id, env.project.id)).toBe(env.w.path);
    fs.rmSync(path.join(env.root, env.w.id, 'workspace.json'));
    expect(await code(env.service.resolveForSession(env.w.id, env.project.id))).toBe('workspace_missing');
  });
  it('does not use a directory whose remote was changed', async () => {
    const env = await workspace();
    sh(env.w.path, 'remote', 'set-url', 'origin', 'https://github.com/evil/other.git');
    expect(await code(env.service.resolveForSession(env.w.id, env.project.id))).toBe('workspace_remote_changed');
  });
});

describe('what cleanup checks', () => {
  it('finds a fresh checkout safe and published', async () => {
    const { service, w } = await workspace();
    const v = await service.inspect(w.id);
    expect(v).toMatchObject({ exists: true, remoteMatches: true, trackedChanges: 0, untracked: 0, unpushedCommits: 0, publication: 'published', safeToClean: true, recoverableDelete: true });
  });
  it('blocks on an uncommitted tracked change and on an untracked file', async () => {
    const { service, w } = await workspace();
    fs.appendFileSync(path.join(w.path, 'README.md'), 'edit\n');
    fs.writeFileSync(path.join(w.path, 'new.txt'), 'x');
    const v = await service.inspect(w.id);
    expect(v.safeToClean).toBe(false);
    expect(v.trackedChanges).toBe(1);
    expect(v.untracked).toBe(1);
    expect(v.blockers.join(' ')).toMatch(/not committed/);
    expect(v.blockers.join(' ')).toMatch(/not tracked/);
  });
  it('a commit alone is not publication: an unpushed commit blocks until it is on GitHub', async () => {
    const { service, w, remote } = await workspace();
    fs.writeFileSync(path.join(w.path, 'a.txt'), 'a');
    sh(w.path, 'add', '.'); sh(w.path, 'commit', '-q', '-m', 'work');
    const v = await service.inspect(w.id);
    expect(v.unpushedCommits).toBe(1);
    expect(v.publication).toBe('unpublished');
    expect(v.safeToClean).toBe(false);
    expect(v.blockers.join(' ')).toMatch(/exist only here/);
    // The push fails (no network): still not safe.
    remote.down.value = true;
    const v2 = await service.inspect(w.id);
    expect(v2.safeToClean).toBe(false);
    expect(v2.warnings.join(' ')).toMatch(/could not be reached/);
    remote.down.value = false;
    await remote.git(w.path, ['push', 'origin', 'main']);
    const v3 = await service.inspect(w.id);
    expect(v3).toMatchObject({ unpushedCommits: 0, publication: 'published', safeToClean: true });
  });
  it('finds commits on a branch that is not checked out, and on a detached HEAD', async () => {
    const { service, w } = await workspace();
    sh(w.path, 'switch', '-q', '-c', 'side');
    fs.writeFileSync(path.join(w.path, 'b.txt'), 'b'); sh(w.path, 'add', '.'); sh(w.path, 'commit', '-q', '-m', 'side work');
    sh(w.path, 'switch', '-q', 'main');
    const v = await service.inspect(w.id);
    expect(v.unpublishedBranches).toEqual(['side']);
    expect(v.safeToClean).toBe(false);
    sh(w.path, 'branch', '-q', '-D', 'side');
    sh(w.path, 'switch', '-q', '--detach');
    fs.writeFileSync(path.join(w.path, 'c.txt'), 'c'); sh(w.path, 'add', '.'); sh(w.path, 'commit', '-q', '-m', 'detached work');
    expect((await service.inspect(w.id)).unpushedCommits).toBe(1);
  });
  it('blocks on a stash and warns about ignored files', async () => {
    const { service, w } = await workspace();
    fs.writeFileSync(path.join(w.path, '.gitignore'), 'out/\n'); sh(w.path, 'add', '.'); sh(w.path, 'commit', '-q', '-m', 'ignore'); 
    fs.mkdirSync(path.join(w.path, 'out')); fs.writeFileSync(path.join(w.path, 'out', 'build.bin'), 'x');
    fs.appendFileSync(path.join(w.path, 'README.md'), 'wip\n'); sh(w.path, 'stash', '-q');
    const v = await service.inspect(w.id);
    expect(v.blockers.join(' ')).toMatch(/stashed/);
    expect(v.warnings.join(' ')).toMatch(/ignored item/);
  });
  it('blocks while something depends on the folder', async () => {
    const { service, w } = await workspace();
    service.registerBusy((dir) => (dir === w.path ? ['a Claude session'] : []));
    const v = await service.inspect(w.id);
    expect(v.running).toEqual(['a Claude session']);
    expect(v.safeToClean).toBe(false);
    expect(await code(service.cleanup(w.id, { confirmRepo: 'acme/widgets' }))).toBe('cleanup_blocked');
  });
  it('never treats a permanent project folder as disposable, even for the same repository', async () => {
    const env = await workspace();
    const permanent = path.join(env.root, 'CaissaTrainer');
    fs.mkdirSync(permanent, { recursive: true });
    env.projects.addRoot(env.project.id, { path: permanent });
    expect((await env.service.inspect(env.w.id)).safeToClean).toBe(true);
    // A project folder that overlaps the workspace (the reverse mistake) is refused too.
    env.projects.addRoot(env.project.id, { path: env.w.path });
    const v = await env.service.inspect(env.w.id);
    expect(v.safeToClean).toBe(false);
    expect(v.blockers.join(' ')).toMatch(/never removed/);
    expect(await code(env.service.cleanup(env.w.id, { confirmRepo: 'acme/widgets' }))).toBe('cleanup_blocked');
    expect(fs.existsSync(permanent)).toBe(true);
  });
});

describe('cleaning up', () => {
  it('needs the repository name typed and uses the Recycle Bin or Trash', async () => {
    const env = await workspace();
    expect(await code(env.service.cleanup(env.w.id, { confirmRepo: 'nope' }))).toBe('confirmation_mismatch');
    expect(fs.existsSync(env.w.path)).toBe(true);
    const done = await env.service.cleanup(env.w.id, { confirmRepo: 'ACME/Widgets' });
    expect(done.status).toBe('removed');
    expect(env.trashed).toEqual([path.join(env.root, env.w.id)]);
    expect(env.service.list(env.project.id)).toHaveLength(0);
  });
  it('without a Recycle Bin it refuses until permanent deletion is chosen explicitly', async () => {
    const env = await workspace({ trash: undefined });
    expect((await env.service.inspect(env.w.id)).recoverableDelete).toBe(false);
    expect(await code(env.service.cleanup(env.w.id, { confirmRepo: 'acme/widgets' }))).toBe('permanent_required');
    expect(fs.existsSync(env.w.path)).toBe(true);
    await env.service.cleanup(env.w.id, { confirmRepo: 'acme/widgets', permanent: true });
    expect(fs.existsSync(path.join(env.root, env.w.id))).toBe(false);
  });
  it('reports a locked file as a recoverable failure and removes nothing', async () => {
    const env = await workspace({ trash: async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); } });
    expect(await code(env.service.cleanup(env.w.id, { confirmRepo: 'acme/widgets' }))).toBe('cleanup_failed');
    expect(env.service.require(env.w.id).status).toBe('ready');
    expect(fs.existsSync(env.w.path)).toBe(true);
  });
  it('never removes a folder that is not the one it made', async () => {
    const env = await workspace();
    fs.rmSync(path.join(env.root, env.w.id, 'workspace.json'));
    expect(await code(env.service.cleanup(env.w.id, { confirmRepo: 'acme/widgets' }))).toBe('cleanup_blocked');
    expect(env.trashed).toEqual([]);
  });
});
