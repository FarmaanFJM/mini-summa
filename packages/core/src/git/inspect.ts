// What git says about a folder, as facts. Used before a cloud dispatch (unpushed commits, which repository) and before a temporary
// workspace may be cleaned up (everything that would be lost).
import type { LocalRepoState } from '@minisumma/shared';
import type { GitFn } from './git.ts';
import { parseGithubRemote } from './git.ts';

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);
const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export async function inspectLocalRepo(git: GitFn, dir: string, projectRepo: string | null): Promise<LocalRepoState> {
  const empty: LocalRepoState = {
    path: dir, isRepo: false, branch: null, detached: false, remoteRepo: null, remoteMatchesProject: false, upstream: null,
    unpushed: null, dirty: false, untracked: 0,
  };
  const top = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!top.ok || top.stdout.trim() !== 'true') return empty;

  const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.ok ? head.stdout.trim() : null;
  const remote = await git(dir, ['remote', 'get-url', 'origin']);
  const remoteRepo = remote.ok ? parseGithubRemote(remote.stdout) : null;

  let upstream: string | null = null;
  let unpushed: number | null = null;
  if (branch) {
    const up = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
    if (up.ok) {
      upstream = up.stdout.trim();
      const n = await git(dir, ['rev-list', '--count', `${upstream}..HEAD`]);
      if (n.ok && /^\d+$/.test(n.stdout.trim())) unpushed = Number(n.stdout.trim());
    }
  }
  const status = await git(dir, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const rows = status.ok ? lines(status.stdout) : [];
  const untracked = rows.filter((r) => r.startsWith('??')).length;
  return {
    path: dir, isRepo: true, branch, detached: !branch, remoteRepo, remoteMatchesProject: same(remoteRepo, projectRepo),
    upstream, unpushed, dirty: rows.length - untracked > 0, untracked,
  };
}

/**
 * Commits that exist only here, across ALL local branches: `git log --branches --not --remotes`. This is what a cleanup must check,
 * because a commit on a branch that is not checked out is just as lost. A remote-tracking ref is only as fresh as the last fetch, so
 * the caller runs `fetch` first when it can and says so when it could not.
 */
export async function unpublishedCommits(git: GitFn, dir: string): Promise<{ count: number | null; branches: string[] }> {
  const all = await git(dir, ['log', 'HEAD', '--branches', '--not', '--remotes', '--format=%H'], { timeoutMs: 60_000 });
  if (!all.ok) return { count: null, branches: [] };
  const count = lines(all.stdout).length;
  const branches: string[] = [];
  if (count > 0) {
    const names = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    for (const name of lines(names.stdout)) {
      const own = await git(dir, ['rev-list', '--count', name, '--not', '--remotes']);
      if (own.ok && Number(own.stdout.trim()) > 0) branches.push(name);
    }
  }
  return { count, branches };
}
