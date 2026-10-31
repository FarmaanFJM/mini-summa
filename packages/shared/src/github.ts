// GitHub repositories as Mini-Summa names them: `owner/repo`. Pure string logic.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type RepoResult = { ok: true; value: string | null; changed: boolean } | { ok: false; message: string };

/** Accepts owner/repo and the common ways of pasting a repository (https URL, .git suffix, SSH form). Empty input means "none". */
export function normalizeGithubRepo(input: string): RepoResult {
  const raw = input.trim();
  if (raw === '') return { ok: true, value: null, changed: false };
  let value = raw;
  const pasted = /^(git@github\.com:|(https?:\/\/)?(www\.)?github\.com\/)/i.test(value);
  value = value.replace(/^git@github\.com:/i, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (pasted) value = value.split('/').slice(0, 2).join('/');
  if (!REPO.test(value)) return { ok: false, message: 'Use the form owner/repo, for example acme/git-manager.' };
  return { ok: true, value, changed: value !== raw };
}

/** The repository's page on github.com. */
export const githubRepoUrl = (repo: string): string => `https://github.com/${repo}`;
