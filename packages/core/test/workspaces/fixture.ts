// A real git, a local bare repository standing in for github.com/acme/widgets. Only the network is faked: every git command runs for real.
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitFn } from '../../src/git/git.ts';
import { makeBase, tempDir } from '../infra/part1-fixtures.ts';
import { createProjectsService, createSettingsService } from '../../src/infra/index.ts';
import { createWorkspacesService } from '../../src/workspaces/service.ts';
import type { WorkspacesDeps } from '../../src/workspaces/service.ts';

export const REPO = 'acme/widgets';
export const GITHUB = 'https://github.com/acme/widgets.git';
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

export const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' });

export interface Remote { bare: string; git: GitFn; calls: string[][]; down: { value: boolean }; failWith: { value: string | null } }

/** A bare repository with `main` and a `dev` branch, and a GitFn that maps the github address to it. */
export function makeRemote(): Remote {
  const dir = tempDir('ms-remote-');
  const bare = path.join(dir, 'widgets.git');
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), '# widgets\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'first');
  sh(seed, 'branch', 'dev');
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: ENV });
  const calls: string[][] = [];
  const down = { value: false };
  const failWith = { value: null as string | null };
  const git: GitFn = (cwd, args, opts) => new Promise((resolve) => {
    calls.push([...args]);
    const network = args.some((a) => ['ls-remote', 'fetch', 'push'].includes(a));
    if (network && failWith.value) { resolve({ ok: false, stdout: '', stderr: failWith.value, code: 128 }); return; }
    if (network && down.value) { resolve({ ok: false, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com', code: 128 }); return; }
    const full = ['-c', `url.${bare}.insteadOf=${GITHUB}`, '-c', 'protocol.file.allow=always', ...(cwd ? ['-C', cwd] : []), ...args];
    execFile('git', full, { env: { ...ENV, LC_ALL: 'C' }, encoding: 'utf8', timeout: opts?.timeoutMs ?? 30_000 }, (err, stdout, stderr) => {
      // `remote get-url` shows the expanded address; map it back so the code sees what GitHub's address would be.
      resolve({ ok: !err, stdout: stdout.split(bare).join(GITHUB), stderr: String(stderr), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
  return { bare, git, calls, down, failWith };
}

export function realClone(remote: Remote): NonNullable<WorkspacesDeps['clone']> {
  return async ({ dir, branch, signal }) => {
    if (signal.aborted) return { ok: false, message: 'cancelled' };
    const r = await remote.git(null, ['clone', '-q', '--no-tags', ...(branch ? ['--branch', branch] : []), '--', GITHUB, dir]);
    if (r.ok) await remote.git(dir, ['remote', 'set-url', 'origin', GITHUB]);
    return { ok: r.ok, message: r.stderr };
  };
}

export function makeWorkspaces(over: Partial<WorkspacesDeps> = {}) {
  const base = makeBase({ dataDir: tempDir('ms-data-') });
  const settings = createSettingsService({ base });
  const projects = createProjectsService({ base, settings, hostPlatform: 'linux', hostEnv: 'posix' });
  const project = projects.create({ name: 'Widgets', githubRepo: REPO });
  const remote = makeRemote();
  const root = tempDir('ms-ws-');
  const trashed: string[] = [];
  const service = createWorkspacesService({
    base, projects, git: remote.git, root,
    repoSize: async () => 1024, freeBytes: async () => 50 * 1024 ** 3, clone: realClone(remote),
    trash: async (target) => { trashed.push(target); fs.rmSync(target, { recursive: true, force: true }); },
    ...over,
  });
  return { base, projects, project, remote, root, trashed, service };
}

export async function ready(service: ReturnType<typeof makeWorkspaces>['service'], id: string) {
  for (let i = 0; i < 200; i++) {
    const w = service.require(id);
    if (w.status !== 'cloning') return w;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('clone did not finish');
}
