// Git, run as a program with an argument array: never through a shell, never with text from a person or a repository inside a command
// line that a shell reads. Every call has a deadline. Terminal prompts are off so that a missing credential fails instead of hanging
// (the person's own credential helper, such as Git Credential Manager, still works). Remote URLs from a repository are parsed and
// compared, never executed.
import type { CommandRunner } from '../claude/commandRunner.ts';

export interface GitResult { ok: boolean; stdout: string; stderr: string; code: number | null }
export type GitFn = (cwd: string | null, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<GitResult>;

/**
 * Settings that make a clone of a repository the person does not control less able to run anything:
 *  - no hooks from the repository exist before a clone finishes, and Mini-Summa never runs one itself;
 *  - Git LFS filters are skipped (GIT_LFS_SKIP_SMUDGE) so a large object store is not downloaded without the person knowing;
 *  - transports other than https/ssh are off (no ext:: or file:: remotes).
 */
export const SAFE_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never',
  LC_ALL: 'C',
};

export const SAFE_GIT_CONFIG: readonly string[] = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'core.fsmonitor=false'];

export function createGit(run: CommandRunner, gitFile = 'git'): GitFn {
  return async (cwd, args, opts) => {
    const full = [...SAFE_GIT_CONFIG, ...(cwd ? ['-C', cwd] : []), ...args];
    const r = await run(gitFile, full, { timeoutMs: opts?.timeoutMs ?? 30_000, env: SAFE_GIT_ENV });
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr || r.error || '', code: r.code };
  };
}

export interface ParsedRemote { host: string; repo: string }

/**
 * `owner/repo` of a github.com remote, from the spellings Git accepts. A remote with a password or token in it is read for the name only;
 * the secret part is never returned. Anything that is not github.com (or has no owner/repo) is null.
 */
export function parseGithubRemote(url: string): string | null {
  const raw = url.trim();
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(raw);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/(?:[^@/]*@)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(raw);
  return https ? `${https[1]}/${https[2]}` : null;
}

/** The https clone address Mini-Summa uses for `owner/repo`. Built from a validated name, so nothing else can get into it. */
export function githubCloneUrl(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Not an owner/repo name.');
  return `https://github.com/${repo}.git`;
}

/** A branch name Git accepts and that cannot be read as an option or contain path tricks. */
export function isSafeBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (/[\s~^:?*\[\\\u0000-\u001f\u007f]|\.\.|@\{|\/\/|\/\./.test(name)) return false;
  return name !== '@';
}
