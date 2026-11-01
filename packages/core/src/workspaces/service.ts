// Temporary local workspaces: a checkout of a project's GitHub repository that Mini-Summa makes, owns and can find again.
//
// Rules this file keeps (docs/TEMP_WORKSPACES.md has the longer version):
//  * Identity is a uuid. The directory is <workspaces>/<uuid>/repo and the repository name appears nowhere in the path, so two
//    workspaces of one repository never collide and an unrelated folder is never "reused" because its name matches.
//  * A marker file <workspaces>/<uuid>/workspace.json is written first. Everything Mini-Summa later does to the directory (reuse,
//    wipe a failed clone, clean up) first checks that the marker, the database row and the path agree.
//  * Git runs with argument arrays and the safe settings of git/git.ts. Nothing from the repository is executed: no hooks, no
//    setup script, no LFS download, no submodule fetch.
//  * Size from GitHub is a hint. An unknown or large size needs the person's confirmation, and disk space is checked either way.
//  * Cleanup re-inspects at the moment of cleanup, refuses while anything depends on the directory or would be lost, never touches a
//    folder that is, or contains, a project's own folder, and prefers the Recycle Bin or Trash.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CloneCheck, Project, TempWorkspace, WorkspaceCleanupInput, WorkspaceCreateInput, WorkspaceInspection, WorkspaceStatus } from '@minisumma/shared';
import type { CoreBase } from '../contracts.ts';
import { CoreError, notFound, unprocessable } from '../errors.ts';
import { SAFE_GIT_CONFIG, SAFE_GIT_ENV, githubCloneUrl, isSafeBranchName, parseGithubRemote } from '../git/git.ts';
import type { GitFn } from '../git/git.ts';
import { unpublishedCommits } from '../git/inspect.ts';

/** Above this the person is asked first, whatever the free space is. */
export const LARGE_REPO_KB = 500 * 1024;
const MARGIN_BYTES = 512 * 1024 * 1024;
const UNKNOWN_SIZE_MIN_FREE = 2 * 1024 * 1024 * 1024;

interface Row {
  id: string; project_id: string; repo: string; path: string; status: WorkspaceStatus; branch: string | null; feature_branch: string | null;
  shallow: number; purpose: 'session' | 'dispatch'; reported_size_kb: number | null; error: string | null; created_at: string; updated_at: string;
}

export interface WorkspacesDeps {
  base: CoreBase;
  projects: { require(id: string): Project };
  git: GitFn;
  /** Where workspaces live. Default: <data dir>/workspaces. */
  root?: string;
  /** GitHub's repository record: `{ size }` in KiB. null when unreadable. Replaced in tests. */
  repoSize?: (repo: string) => Promise<number | null>;
  freeBytes?: (dir: string) => Promise<number | null>;
  /** Recycle Bin or Trash. Absent: only a separate permanent decision can remove the files. */
  trash?: (target: string) => Promise<void>;
  /** Replaced in tests to avoid a network. Must honour `signal`. */
  clone?: (args: { url: string; dir: string; branch: string | null; shallow: boolean; signal: AbortSignal }) => Promise<{ ok: boolean; message: string }>;
}

export interface WorkspacesService {
  init(): void;
  check(projectId: string): Promise<CloneCheck>;
  create(input: WorkspaceCreateInput): Promise<TempWorkspace>;
  retry(id: string): Promise<TempWorkspace>;
  cancel(id: string): TempWorkspace;
  get(id: string): TempWorkspace | null;
  require(id: string): TempWorkspace;
  list(projectId: string): TempWorkspace[];
  /** Path for a session. Throws unless the workspace is ready, belongs to the project and is the checkout it claims to be. */
  resolveForSession(id: string, projectId: string): Promise<string>;
  inspect(id: string): Promise<WorkspaceInspection>;
  cleanup(id: string, input: WorkspaceCleanupInput): Promise<TempWorkspace>;
  /** Something that depends on a path, such as a running Claude session. Cleanup refuses while any returns a name. */
  registerBusy(check: (dir: string) => string[]): void;
  hasTrash(): boolean;
  rootDir(): string;
}

const nowOf = (base: CoreBase): string => base.clock.now().toISOString();

export function classifyGitFailure(stderr: string): { access: CloneCheck['access']; note: string } {
  const s = stderr.toLowerCase();
  if (/repository not found|not found|does not exist/.test(s)) {
    return { access: 'not_found', note: 'GitHub says the repository was not found. It may not exist, or your Git login may not have access to it.' };
  }
  if (/authentication failed|could not read username|could not read password|permission denied|403|invalid username|terminal prompts disabled|logon failed/.test(s)) {
    return { access: 'denied', note: 'Git could not sign in to GitHub. Sign in with your Git credential helper (for example run git ls-remote on the repository once in a terminal), then try again.' };
  }
  if (/could not resolve host|unable to access|timed out|connection|network is unreachable|ssl/.test(s)) {
    return { access: 'unreachable', note: 'GitHub could not be reached. Check your connection and try again.' };
  }
  return { access: 'unknown', note: stderr.trim().split('\n')[0]?.slice(0, 200) || 'Git could not read the repository.' };
}

export function createWorkspacesService(deps: WorkspacesDeps): WorkspacesService {
  const { base, git } = deps;
  const { db, log } = base;
  const root = path.resolve(deps.root ?? path.join(base.dataDir, 'workspaces'));
  const busyChecks: Array<(dir: string) => string[]> = [];
  const clones = new Map<string, AbortController>();

  const toWorkspace = (r: Row): TempWorkspace => ({
    id: r.id, projectId: r.project_id, repo: r.repo, path: r.path, status: r.status, branch: r.branch, featureBranch: r.feature_branch,
    shallow: r.shallow === 1, purpose: r.purpose, createdAt: r.created_at, updatedAt: r.updated_at, error: r.error, reportedSizeKb: r.reported_size_kb,
  });
  const row = (id: string): Row | null => db.get<Row>('SELECT * FROM temp_workspaces WHERE id = ?', [id]) ?? null;
  const update = (id: string, patch: Partial<Pick<Row, 'status' | 'branch' | 'feature_branch' | 'error'>>): void => {
    const sets = Object.keys(patch).map((k) => `${k} = ?`);
    db.run(`UPDATE temp_workspaces SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`, [...Object.values(patch) as (string | null)[], nowOf(base), id]);
  };

  const dirOf = (id: string): string => path.join(root, id);
  const repoDirOf = (id: string): string => path.join(root, id, 'repo');
  const markerOf = (id: string): string => path.join(root, id, 'workspace.json');

  /** The one test for "this directory is a workspace of ours": a uuid under our root, with a marker that names the same id and project. */
  function ownedDir(r: Row): boolean {
    try {
      if (path.resolve(r.path) !== path.resolve(repoDirOf(r.id))) return false;
      const marker = JSON.parse(fs.readFileSync(markerOf(r.id), 'utf8')) as { id?: string; projectId?: string; repo?: string };
      return marker.id === r.id && marker.projectId === r.project_id && marker.repo === r.repo;
    } catch { return false; }
  }

  /** A folder that is, is inside, or contains a project's own folder is never ours to remove. */
  function protectedPath(target: string): string | null {
    const t = path.resolve(target);
    const rel = (a: string, b: string): boolean => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
    const projects = db.all<{ path: string }>('SELECT path FROM project_roots');
    for (const p of projects) {
      const other = path.resolve(p.path);
      if (rel(other, t) || rel(t, other)) return p.path;
    }
    return null;
  }

  const withinRoot = (target: string): boolean => {
    const r = path.relative(root, path.resolve(target));
    return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
  };

  async function defaultRepoSize(repo: string): Promise<number | null> {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'mini-summa' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = await res.json() as { size?: unknown };
      return typeof j.size === 'number' && Number.isFinite(j.size) ? j.size : null;
    } catch { return null; }
  }

  async function defaultFree(dir: string): Promise<number | null> {
    let probe = path.resolve(dir);
    while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) return null; probe = up; }
    try { const s = await fs.promises.statfs(probe); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
  }

  const fmt = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

  function defaultClone(args: { url: string; dir: string; branch: string | null; shallow: boolean; signal: AbortSignal }): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const argv = [...SAFE_GIT_CONFIG, 'clone', '--no-tags', '--no-recurse-submodules', ...(args.shallow ? ['--depth', '1', '--filter=blob:none'] : []),
        ...(args.branch ? ['--branch', args.branch] : []), '--', args.url, args.dir];
      let child: ChildProcess;
      let err = '';
      try {
        child = spawn('git', argv, { env: { ...process.env, ...SAFE_GIT_ENV }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) { resolve({ ok: false, message: e instanceof Error ? e.message : String(e) }); return; }
      const stop = (): void => { try { child.kill(); } catch { /* gone */ } };
      if (args.signal.aborted) stop(); else args.signal.addEventListener('abort', stop, { once: true });
      child.stderr?.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-4000); });
      child.on('error', (e) => resolve({ ok: false, message: e.message }));
      child.on('close', (code) => resolve(args.signal.aborted ? { ok: false, message: 'cancelled' } : { ok: code === 0, message: err }));
    });
  }

  async function wipe(id: string): Promise<void> {
    // Only ever the repo directory of a workspace whose marker we wrote ourselves, under our own root.
    const r = row(id);
    const dir = repoDirOf(id);
    if (!r || !withinRoot(dir) || !fs.existsSync(markerOf(id))) return;
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  async function runClone(id: string): Promise<void> {
    const r = row(id)!;
    const ctl = new AbortController();
    clones.set(id, ctl);
    const dir = repoDirOf(id);
    try {
      await wipe(id);
      if (ctl.signal.aborted) { update(id, { status: 'cancelled', error: 'You cancelled the download.' }); return; }
      const result = await (deps.clone ?? defaultClone)({ url: githubCloneUrl(r.repo), dir, branch: r.branch, shallow: r.shallow === 1, signal: ctl.signal });
      if (ctl.signal.aborted) { await wipe(id); update(id, { status: 'cancelled', error: 'You cancelled the download.' }); return; }
      if (!result.ok) {
        await wipe(id);
        update(id, { status: 'clone_failed', error: classifyGitFailure(result.message).note });
        log.warn('temporary workspace clone failed', { id });
        return;
      }
      // The remote must be the repository that was asked for, not whatever the clone left behind.
      const remote = await git(dir, ['remote', 'get-url', 'origin']);
      const found = remote.ok ? parseGithubRemote(remote.stdout) : null;
      if (!found || found.toLowerCase() !== r.repo.toLowerCase()) {
        update(id, { status: 'clone_failed', error: `The checkout's remote is ${found ?? 'not a GitHub repository'}, not ${r.repo}. Nothing was started in it.` });
        return;
      }
      const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const branch = head.ok ? head.stdout.trim() : null;
      if (r.feature_branch) {
        const made = await git(dir, ['switch', '-c', r.feature_branch]);
        if (!made.ok) { update(id, { status: 'clone_failed', branch, error: `The branch ${r.feature_branch} could not be created: ${made.stderr.trim().split('\n')[0]}` }); return; }
      }
      update(id, { status: 'ready', branch, error: null });
    } catch (e) {
      update(id, { status: 'clone_failed', error: e instanceof Error ? e.message.slice(0, 300) : 'The download failed.' });
    } finally {
      clones.delete(id);
    }
  }

  const service: WorkspacesService = {
    init() {
      // A clone that was running when Mini-Summa ended did not finish. Its partial directory is wiped on retry, never trusted.
      for (const r of db.all<Row>("SELECT * FROM temp_workspaces WHERE status = 'cloning'")) {
        update(r.id, { status: 'clone_failed', error: 'Mini-Summa closed while the repository was downloading. Download it again.' });
      }
    },

    hasTrash: () => typeof deps.trash === 'function',
    rootDir: () => root,
    registerBusy(check) { busyChecks.push(check); },

    async check(projectId) {
      const project = deps.projects.require(projectId);
      const repo = project.githubRepo;
      const out: CloneCheck = { repo: repo ?? '', access: 'unknown', accessNote: null, reportedSizeKb: null, freeBytes: null, defaultBranch: null, branches: [], needsConfirmation: false, warnings: [], blockers: [] };
      if (!repo) { out.blockers.push('This project has no GitHub repository. Add one in the project settings.'); return out; }

      const ls = await git(null, ['ls-remote', '--symref', githubCloneUrl(repo), 'HEAD', 'refs/heads/*'], { timeoutMs: 45_000 });
      if (!ls.ok) {
        const c = classifyGitFailure(ls.stderr);
        out.access = c.access; out.accessNote = c.note; out.blockers.push(c.note);
      } else {
        out.access = 'ok';
        for (const line of ls.stdout.split('\n')) {
          const sym = /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
          if (sym) out.defaultBranch = sym[1];
          const head = /\srefs\/heads\/(\S+)$/.exec(line.trim());
          if (head && !line.startsWith('ref:') && isSafeBranchName(head[1]) && out.branches.length < 300) out.branches.push(head[1]);
        }
      }

      out.reportedSizeKb = await (deps.repoSize ?? defaultRepoSize)(repo);
      out.freeBytes = await (deps.freeBytes ?? defaultFree)(root);
      const free = out.freeBytes;

      if (out.reportedSizeKb === null) {
        out.needsConfirmation = true;
        out.warnings.push('GitHub did not report a size for this repository (it may be private). The download could be much larger than expected.');
        if (free !== null && free < UNKNOWN_SIZE_MIN_FREE) out.blockers.push(`Only ${fmt(free)} is free and the size is unknown. Free at least ${fmt(UNKNOWN_SIZE_MIN_FREE)} first.`);
      } else {
        const need = out.reportedSizeKb * 1024 * 2 + MARGIN_BYTES;
        if (out.reportedSizeKb >= LARGE_REPO_KB) {
          out.needsConfirmation = true;
          out.warnings.push(`GitHub reports about ${fmt(out.reportedSizeKb * 1024)}. A checkout needs roughly twice that.`);
        }
        if (free !== null && free < need) out.blockers.push(`About ${fmt(need)} is needed and only ${fmt(free)} is free.`);
        out.warnings.push('The size comes from GitHub and is approximate. Large files and Git LFS content are not included in it.');
      }
      if (free === null) { out.needsConfirmation = true; out.warnings.push('Free disk space could not be read.'); }
      out.warnings.push('Git LFS files and submodules are not downloaded. Mini-Summa runs no setup script from the repository.');
      return out;
    },

    async create(input) {
      const project = deps.projects.require(input.projectId);
      if (!project.githubRepo) throw unprocessable('This project has no GitHub repository, so there is nothing to download.', 'no_repo');
      const check = await service.check(input.projectId);
      if (check.blockers.length > 0) throw unprocessable(check.blockers[0], 'workspace_blocked', { blockers: check.blockers });
      if (check.needsConfirmation && !input.confirmed) throw unprocessable('Confirm the warnings before downloading.', 'confirmation_required', { warnings: check.warnings });

      const branch = input.branch ?? null;
      if (branch !== null && !isSafeBranchName(branch)) throw unprocessable('That is not a usable branch name.', 'bad_branch');
      if (branch !== null && check.branches.length > 0 && !check.branches.includes(branch)) throw unprocessable(`The repository has no branch named ${branch}.`, 'branch_missing');
      const feature = input.featureBranch?.trim() ? input.featureBranch.trim() : null;
      if (feature !== null) {
        if (!isSafeBranchName(feature)) throw unprocessable('That is not a usable name for a new branch.', 'bad_branch');
        if (check.branches.includes(feature)) throw unprocessable(`A branch named ${feature} already exists on GitHub. Choose another name.`, 'branch_exists');
        const ref = await git(null, ['check-ref-format', '--branch', feature]);
        if (!ref.ok) throw unprocessable('Git does not accept that branch name.', 'bad_branch');
      }

      const id = randomUUID();
      fs.mkdirSync(dirOf(id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(markerOf(id), JSON.stringify({ id, projectId: project.id, repo: project.githubRepo, createdAt: nowOf(base), note: 'Made by Mini-Summa. Do not put your own files here.' }), { mode: 0o600 });
      const at = nowOf(base);
      db.run(
        `INSERT INTO temp_workspaces (id, project_id, repo, path, status, branch, feature_branch, shallow, purpose, reported_size_kb, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'cloning', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, project.id, project.githubRepo, repoDirOf(id), branch, feature, input.shallow ? 1 : 0, input.purpose ?? 'session', check.reportedSizeKb, at, at],
      );
      void runClone(id);
      return toWorkspace(row(id)!);
    },

    async retry(id) {
      const r = row(id);
      if (!r) throw notFound('Workspace');
      if (r.status !== 'clone_failed' && r.status !== 'cancelled') throw unprocessable('Only a download that failed or was cancelled can be retried.', 'not_retryable');
      if (!ownedDir(r) && fs.existsSync(dirOf(id))) throw unprocessable('The folder of this workspace is not what Mini-Summa made, so it will not be reused.', 'workspace_foreign');
      update(id, { status: 'cloning', error: null });
      void runClone(id);
      return toWorkspace(row(id)!);
    },

    cancel(id) {
      const r = row(id);
      if (!r) throw notFound('Workspace');
      clones.get(id)?.abort();
      return toWorkspace(row(id)!);
    },

    get: (id) => { const r = row(id); return r ? toWorkspace(r) : null; },
    require(id) { const r = row(id); if (!r) throw notFound('Workspace'); return toWorkspace(r); },
    list: (projectId) => db.all<Row>("SELECT * FROM temp_workspaces WHERE project_id = ? AND status != 'removed' ORDER BY created_at DESC", [projectId]).map(toWorkspace),

    async resolveForSession(id, projectId) {
      const r = row(id);
      if (!r) throw notFound('Workspace');
      if (r.project_id !== projectId) throw unprocessable('That workspace belongs to another project.', 'workspace_other_project');
      if (r.status !== 'ready') throw unprocessable(r.status === 'cloning' ? 'The repository is still downloading.' : 'This workspace is not ready. Download it again.', 'workspace_not_ready');
      if (!ownedDir(r) || !fs.existsSync(r.path)) throw unprocessable('The folder of this workspace is missing or is not the one Mini-Summa made. Download it again.', 'workspace_missing');
      const remote = await git(r.path, ['remote', 'get-url', 'origin']);
      const found = remote.ok ? parseGithubRemote(remote.stdout) : null;
      if (!found || found.toLowerCase() !== r.repo.toLowerCase()) throw unprocessable(`The remote of this checkout is no longer ${r.repo}. It will not be used.`, 'workspace_remote_changed');
      return r.path;
    },

    async inspect(id) {
      const r = row(id);
      if (!r) throw notFound('Workspace');
      const base0: WorkspaceInspection = {
        id, exists: false, branch: null, remoteRepo: null, remoteMatches: false, trackedChanges: 0, untracked: 0, ignoredFiles: 0,
        unpushedCommits: null, unpublishedBranches: [], publication: 'unknown', running: [], blockers: [], warnings: [], safeToClean: false,
        recoverableDelete: service.hasTrash(),
      };
      const blockers = base0.blockers;
      const warnings = base0.warnings;
      if (r.status === 'cloning') blockers.push('The repository is still downloading. Cancel the download first.');
      for (const check of busyChecks) base0.running.push(...check(r.path));
      if (base0.running.length > 0) blockers.push(`In use by ${base0.running.join(', ')}. Stop it first.`);
      if (!ownedDir(r)) blockers.push('This folder is not the one Mini-Summa made for this workspace, so it will not be removed.');
      const prot = protectedPath(r.path);
      if (prot) blockers.push(`It overlaps the project folder ${prot}, which is never removed by Mini-Summa.`);
      if (!fs.existsSync(r.path)) { base0.exists = false; base0.safeToClean = blockers.length === 0; return base0; }
      base0.exists = true;

      const remote = await git(r.path, ['remote', 'get-url', 'origin']);
      base0.remoteRepo = remote.ok ? parseGithubRemote(remote.stdout) : null;
      base0.remoteMatches = base0.remoteRepo?.toLowerCase() === r.repo.toLowerCase();
      if (!base0.remoteMatches) blockers.push(`The remote is ${base0.remoteRepo ?? 'unreadable'}, not ${r.repo}, so what is published cannot be checked.`);

      const fetched = await git(r.path, ['fetch', '--prune', '--no-tags', '--no-recurse-submodules', 'origin'], { timeoutMs: 90_000 });
      if (!fetched.ok) warnings.push('GitHub could not be reached to refresh what is published. The result below uses what was last downloaded.');

      const head = await git(r.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      base0.branch = head.ok ? head.stdout.trim() : null;
      const status = await git(r.path, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (!status.ok) blockers.push('Git could not read the state of the folder.');
      const rows = status.stdout.split('\n').filter(Boolean);
      base0.untracked = rows.filter((l) => l.startsWith('??')).length;
      base0.trackedChanges = rows.length - base0.untracked;
      if (base0.trackedChanges > 0) blockers.push(`${base0.trackedChanges} changed file${base0.trackedChanges === 1 ? '' : 's'} not committed.`);
      if (base0.untracked > 0) blockers.push(`${base0.untracked} new file${base0.untracked === 1 ? '' : 's'} not tracked by Git.`);

      const ignored = await git(r.path, ['status', '--porcelain=v1', '--ignored=matching', '--untracked-files=normal']);
      base0.ignoredFiles = ignored.stdout.split('\n').filter((l) => l.startsWith('!!')).length;
      if (base0.ignoredFiles > 0) warnings.push(`${base0.ignoredFiles} ignored item${base0.ignoredFiles === 1 ? '' : 's'} (build output, dependencies, local settings) would be removed with the folder.`);

      const stash = await git(r.path, ['stash', 'list']);
      if (stash.ok && stash.stdout.trim() !== '') blockers.push('There are stashed changes, which exist only in this folder.');

      const unpublished = await unpublishedCommits(git, r.path);
      base0.unpushedCommits = unpublished.count;
      base0.unpublishedBranches = unpublished.branches;
      if (unpublished.count === null) blockers.push('Git could not tell which commits are published.');
      else if (unpublished.count > 0) blockers.push(`${unpublished.count} commit${unpublished.count === 1 ? '' : 's'} exist only here${unpublished.branches.length ? ` (${unpublished.branches.join(', ')})` : ''}. Push them first.`);

      // The remote is asked directly: a commit is published when GitHub has this exact commit on this branch, not because it was committed.
      if (base0.branch) {
        const local = await git(r.path, ['rev-parse', 'HEAD']);
        const remoteRef = await git(r.path, ['ls-remote', '--heads', 'origin', base0.branch], { timeoutMs: 45_000 });
        if (local.ok && remoteRef.ok) {
          const sha = remoteRef.stdout.split(/\s+/)[0] ?? '';
          base0.publication = sha === '' ? 'unpublished' : sha === local.stdout.trim() ? 'published' : 'unpublished';
        }
        if (base0.publication === 'unknown' && unpublished.count === 0) warnings.push('GitHub could not be asked about this branch directly.');
      }
      base0.safeToClean = blockers.length === 0;
      return base0;
    },

    async cleanup(id, input) {
      const r = row(id);
      if (!r) throw notFound('Workspace');
      // Always a fresh look: an earlier "safe" answer proves nothing about now.
      const view = await service.inspect(id);
      if (!view.safeToClean) throw unprocessable(view.blockers[0] ?? 'This workspace cannot be cleaned up.', 'cleanup_blocked', { blockers: view.blockers });
      if (input.confirmRepo.trim().toLowerCase() !== r.repo.toLowerCase()) throw unprocessable(`Type ${r.repo} to confirm.`, 'confirmation_mismatch');
      const target = dirOf(id);
      if (!withinRoot(target) || path.basename(target) !== id || !ownedDir(r)) throw unprocessable('The folder is not one Mini-Summa made. It will not be removed.', 'cleanup_not_owned');
      if (protectedPath(target)) throw unprocessable('That folder overlaps a project folder and will not be removed.', 'cleanup_protected');

      try {
        if (fs.existsSync(target)) {
          if (deps.trash) {
            await deps.trash(target);
          } else if (input.permanent === true) {
            await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
          } else {
            throw unprocessable('This computer has no Recycle Bin or Trash that Mini-Summa can use, so the files would be deleted for good. Choose permanent deletion explicitly to continue.', 'permanent_required');
          }
        }
      } catch (e) {
        if (e instanceof CoreError) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
        throw unprocessable(locked ? 'Windows says a file in the folder is in use (an editor, a terminal or a virus scanner may hold it). Close it and try again. Nothing was lost.' : `The folder could not be removed: ${e instanceof Error ? e.message : String(e)}`, 'cleanup_failed');
      }
      update(id, { status: 'removed', error: null });
      log.info('temporary workspace removed', { id, recoverable: Boolean(deps.trash) });
      return toWorkspace(row(id)!);
    },
  };
  return service;
}
