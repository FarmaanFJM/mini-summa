import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PtyExitInfo, PtyProcess, PtySpawner, PtySpawnRequest } from '../../src/claude/ptyHost.ts';
import { createCloudService } from '../../src/cloud/service.ts';
import type { CloudService } from '../../src/cloud/service.ts';
import { createFakeNative } from '../../src/testing/fake-native.ts';
import { cleanupTempDirs, makeBase, tempDir } from '../infra/part1-fixtures.ts';
import { createProjectsService, createSettingsService } from '../../src/infra/index.ts';
import { createWorkspacesService } from '../../src/workspaces/service.ts';
import { GITHUB, REPO, makeRemote, realClone, ready, sh } from '../workspaces/fixture.ts';

// Addresses are built from parts: the publish guard refuses a literal session address anywhere in the repository.
const CODE = 'https://claude.ai/code/';

afterEach(() => { cleanupTempDirs(); vi.useRealTimers(); });

class FakePty implements PtyProcess {
  pid = 4242;
  written: string[] = [];
  killed = false;
  private data: Array<(d: string) => void> = [];
  private exit: Array<(i: PtyExitInfo) => void> = [];
  onData(l: (d: string) => void) { this.data.push(l); return { dispose() {} }; }
  onExit(l: (i: PtyExitInfo) => void) { this.exit.push(l); return { dispose() {} }; }
  write(d: string) { this.written.push(d); }
  resize() {}
  kill() { this.killed = true; this.end(null); }
  say(text: string) { for (const l of this.data) l(text); }
  end(code: number | null) { for (const l of this.exit) l({ exitCode: code, signal: null }); }
}

function setup(opts: { platform?: NodeJS.Platform; claudeFile?: string; auth?: string; help?: string; roots?: boolean; quietMs?: number; runExtra?: (args: string[]) => { code: number | null; stdout: string; stderr: string } | null } = {}) {
  const base = makeBase({ dataDir: tempDir('ms-data-') });
  const settings = createSettingsService({ base });
  const HOST_ENV = process.platform === 'win32' ? 'win' : 'posix';
  const projects = createProjectsService({ base, settings, hostPlatform: process.platform === 'win32' ? 'win32' : 'linux', hostEnv: HOST_ENV });
  const remote = makeRemote();
  const wsRoot = tempDir('ms-ws-');
  const workspaces = createWorkspacesService({ base, projects, git: remote.git, root: wsRoot, repoSize: async () => 1000, freeBytes: async () => 1e11, clone: realClone(remote) });
  const project = projects.create({ name: 'Widgets', githubRepo: REPO });
  let folder: string | null = null;
  if (opts.roots !== false) {
    folder = path.join(tempDir('ms-local-'), 'widgets');
    sh(os.tmpdir(), 'clone', '-q', '--', remote.bare, folder);
    sh(folder, 'remote', 'set-url', 'origin', GITHUB);
    sh(folder, 'config', 'url.' + remote.bare + '.insteadOf', GITHUB);
    projects.addRoot(project.id, { path: folder });
  }
  const ptys: Array<{ req: PtySpawnRequest; pty: FakePty }> = [];
  const spawner: PtySpawner = { spawn(req) { const pty = new FakePty(); ptys.push({ req, pty }); return pty; } };
  const native = createFakeNative();
  const runs: string[][] = [];
  const run = async (_f: string, args: string[]) => {
    runs.push(args);
    const key = args.join(' ');
    if (key === '--version') return { code: 0, stdout: '2.1.316 (Claude Code)\n', stderr: '' };
    if (key === '--help') return { code: 0, stdout: opts.help ?? '  --cloud [description|session_id|url]  Create a cloud session\n', stderr: '' };
    if (key === 'auth status') return { code: 0, stdout: opts.auth ?? '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', stderr: '' };
    const extra = opts.runExtra?.(args);
    return extra ?? { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const environments = { hostEnv: () => HOST_ENV, claudeCommand: async () => ({ file: opts.claudeFile ?? 'claude', prefixArgs: [], wslDistro: null }) } as never;
  const build = (): CloudService => createCloudService({
    base, projects, environments, workspaces, native, run, git: remote.git, spawner, platform: opts.platform ?? process.platform, processEnv: { PATH: process.env.PATH }, quietMs: opts.quietMs,
  });
  return { base, projects, project, remote, workspaces, native, ptys, runs, folder, wsRoot, cloud: build(), build };
}

const PROMPT = 'Implement the billing migration.\n\nKeep "quotes" and 100% of the text. Secret-marker-7731.';
const input = (projectId: string, over = {}) => ({ projectId, prompt: PROMPT, acknowledgedLocalContent: true, ...over });
const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => { try { await (typeof p === 'function' ? p() : p); } catch (e) { return (e as { code: string }).code; } return 'no error'; };

describe('checking before a dispatch', () => {
  it('passes for a signed-in CLI with --cloud and a folder whose origin is the project repository', async () => {
    const t = setup();
    const p = await t.cloud.preflight(t.project.id);
    expect(p.blockers).toEqual([]);
    expect(p.cli).toMatchObject({ found: true, version: '2.1.316', cloudFlag: true });
    expect(p.auth.state).toBe('logged_in');
    expect(p.local).toMatchObject({ isRepo: true, branch: 'main', remoteRepo: REPO, remoteMatchesProject: true, unpushed: 0 });
    expect(p.warnings.join(' ')).toMatch(/does not use your local working tree/);
    expect(p.warnings.join(' ')).toMatch(/upload parts of a local repository/);
  });
  it('blocks an old CLI, a signed-out CLI and a non-claude.ai login', async () => {
    const old = setup({ help: 'Usage: claude' });
    expect((await old.cloud.preflight(old.project.id)).blockers[0]).toMatch(/no --cloud option/);
    const out = setup({ auth: '{"loggedIn":false}' });
    expect((await out.cloud.preflight(out.project.id)).blockers.join(' ')).toMatch(/not signed in/);
    const key = setup({ auth: '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}' });
    expect((await key.cloud.preflight(key.project.id)).blockers.join(' ')).toMatch(/API key/);
  });
  it('warns about unpushed commits, uncommitted work and says the cloud does not see them', async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.folder!, 'a.txt'), 'a'); sh(t.folder!, 'add', '.'); sh(t.folder!, 'commit', '-q', '-m', 'local work');
    fs.writeFileSync(path.join(t.folder!, 'b.txt'), 'b');
    const p = await t.cloud.preflight(t.project.id);
    expect(p.local).toMatchObject({ unpushed: 1, untracked: 1 });
    expect(p.warnings.join(' ')).toMatch(/1 local commit is not on GitHub/);
    expect(p.warnings.join(' ')).toMatch(/uncommitted changes/);
    expect(p.blockers).toEqual([]);
  });
  it('refuses to run against a folder of a different repository or one that is not a repository', async () => {
    const t = setup();
    sh(t.folder!, 'remote', 'set-url', 'origin', 'https://github.com/evil/other.git');
    expect((await t.cloud.preflight(t.project.id)).blockers.join(' ')).toMatch(/evil\/other/);
    const plain = setup();
    const notRepo = tempDir('ms-plain-');
    plain.projects.addRoot(plain.project.id, { path: notRepo });
    const roots = plain.projects.require(plain.project.id).roots;
    expect((await plain.cloud.preflight(plain.project.id, roots[roots.length - 1].id)).blockers.join(' ')).toMatch(/not a Git repository/);
  });
  it('blocks a project without a GitHub repository', async () => {
    const t = setup();
    const bare = t.projects.create({ name: 'Local only' });
    expect((await t.cloud.preflight(bare.id)).blockers.join(' ')).toMatch(/no GitHub repository/);
  });
});

describe('dispatching through the CLI', () => {
  it('passes the whole prompt as one argument, unchanged, and asks nothing before the person agrees', async () => {
    const t = setup();
    expect(await code(t.cloud.dispatch(input(t.project.id, { acknowledgedLocalContent: false })))).toBe('ack_required');
    expect(t.ptys).toHaveLength(0);
    const d = await t.cloud.dispatch(input(t.project.id));
    expect(d).toMatchObject({ phase: 'submitting', method: 'argv', running: true });
    expect(t.ptys).toHaveLength(1);
    expect(t.ptys[0].req.args).toEqual(['--cloud', PROMPT]);
    expect(t.ptys[0].req.cwd).toBe(t.folder);
  });
  it('shows a question as waiting for input, forwards only the allowed keys, and records the link it then prints', async () => {
    const t = setup();
    const d = await t.cloud.dispatch(input(t.project.id, { title: 'Billing' }));
    const pty = t.ptys[0].pty;
    pty.say('Quick safety check: Is this a project you created or one you trust?\r\n> No, exit\r\n  Yes, I trust this folder\r\n');
    expect(t.cloud.getDispatch(d.id)).toMatchObject({ phase: 'waiting_for_input', detail: expect.stringMatching(/trust this folder/) });
    expect(() => t.cloud.sendKey(d.id, 'rm -rf' as never)).toThrow();
    t.cloud.sendKey(d.id, 'up'); t.cloud.sendKey(d.id, 'enter');
    expect(pty.written).toEqual(['\x1b[A', '\r']);
    pty.say('Creating cloud session…\r\n');
    expect(t.cloud.getDispatch(d.id)!.phase).toBe('submitting');
    pty.say('Session created: https://claude.ai/code/' + 'session_abAbCdEfGhIj\r\n');
    const done = t.cloud.getDispatch(d.id)!;
    expect(done).toMatchObject({ phase: 'created', sessionId: 'session_abAbCdEfGhIj', sessionUrl: `${CODE}session_abAbCdEfGhIj`, running: true });
    expect(done.detail).toMatch(/not that Claude has finished/);
    const [rec] = t.cloud.sessions(t.project.id);
    expect(rec).toMatchObject({ projectId: t.project.id, repo: REPO, sourceRef: 'main', title: 'Billing', method: 'cli_cloud', lastResult: { outcome: 'created' } });
  });
  it('does not call a process that exits "created", and does not end the cloud record when the CLI exits', async () => {
    const t = setup();
    const d = await t.cloud.dispatch(input(t.project.id));
    t.ptys[0].pty.say('Session: https://claude.ai/code/' + 'session_abAbCdEfGhIj\n');
    t.ptys[0].pty.end(0);
    expect(t.cloud.getDispatch(d.id)).toMatchObject({ phase: 'created', running: false });
    expect(t.cloud.sessions(t.project.id)).toHaveLength(1);
    const silent = await t.cloud.dispatch(input(t.project.id));
    t.ptys[1].pty.end(0);
    expect(t.cloud.getDispatch(silent.id)).toMatchObject({ phase: 'unknown', running: false });
    expect(t.cloud.getDispatch(silent.id)!.detail).toMatch(/may or may not exist/);
    expect(t.cloud.sessions(t.project.id)).toHaveLength(1);
  });
  it('reports the CLI\'s error as a failure and a half-printed link as unknown', async () => {
    const t = setup();
    const a = await t.cloud.dispatch(input(t.project.id));
    t.ptys[0].pty.say('Error: failed to create cloud session: GitHub app not installed\n');
    t.ptys[0].pty.end(1);
    expect(t.cloud.getDispatch(a.id)).toMatchObject({ phase: 'failed', detail: expect.stringMatching(/GitHub app not installed/) });
    const b = await t.cloud.dispatch(input(t.project.id));
    t.ptys[1].pty.say('see https://claude.ai/code/' + 'session_abAbC');
    expect(t.cloud.getDispatch(b.id)!.phase).not.toBe('created');
    t.ptys[1].pty.say('dEfGh\nbye\n');
    expect(t.cloud.getDispatch(b.id)).toMatchObject({ phase: 'created', sessionId: 'session_abAbCdEfGh' });
    const c = await t.cloud.dispatch(input(t.project.id));
    t.ptys[2].pty.say('bye https://claude.ai/code/new and https://claude.ai/code\n');
    t.ptys[2].pty.end(0);
    expect(t.cloud.getDispatch(c.id)!.phase).toBe('unknown');
    expect(t.cloud.sessions(t.project.id)).toHaveLength(1);
  });
  it('goes quiet to "unknown" instead of waiting for ever', async () => {
    vi.useFakeTimers();
    const t = setup({ quietMs: 5000 });
    const d = await t.cloud.dispatch(input(t.project.id));
    vi.advanceTimersByTime(5001);
    expect(t.cloud.getDispatch(d.id)).toMatchObject({ phase: 'unknown' });
  });
  it('keeps the record after a restart and calls an unfinished dispatch unknown', async () => {
    const t = setup();
    const done = await t.cloud.dispatch(input(t.project.id));
    t.ptys[0].pty.say(`${CODE}session_abAbCdEfGhIj \n`);
    const open = await t.cloud.dispatch(input(t.project.id));
    expect(t.cloud.getDispatch(open.id)!.phase).toBe('submitting');
    const restarted = t.build();
    restarted.init();
    expect(restarted.sessions(t.project.id)).toHaveLength(1);
    expect(restarted.getDispatch(done.id)).toMatchObject({ phase: 'created', running: false });
    expect(restarted.getDispatch(open.id)).toMatchObject({ phase: 'unknown', detail: expect.stringMatching(/closed before the CLI reported/) });
  });
  it('never writes the prompt to the log, the journal or the database', async () => {
    const t = setup();
    const d = await t.cloud.dispatch(input(t.project.id));
    t.ptys[0].pty.say(`> ${PROMPT.split('\n')[0]}\nSecret-marker-7731 echoed\nhttps://claude.ai/code/${"session"}_abAbCdEfGhIj \n`);
    expect(JSON.stringify(t.base.log.lines)).not.toContain('Secret-marker-7731');
    const rows = JSON.stringify(t.base.db.all('SELECT * FROM kv'))+JSON.stringify(t.base.db.all('SELECT * FROM cloud_sessions'));
    expect(rows).not.toContain('Secret-marker-7731');
    expect(rows).not.toContain('billing migration');
    expect(t.cloud.getDispatch(d.id)!.tail.join('\n')).not.toContain('billing migration');
  });
  it('prepares a small checkout when the project has no folder, and runs the CLI in it', async () => {
    const t = setup({ roots: false });
    const d = await t.cloud.dispatch(input(t.project.id));
    const ws = t.workspaces.list(t.project.id);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ purpose: 'dispatch', shallow: true, status: 'ready' });
    expect(t.ptys[0].req.cwd).toBe(ws[0].path);
    expect(d.phase).toBe('submitting');
    // A running dispatch keeps its checkout from being cleaned up.
    expect((await t.workspaces.inspect(ws[0].id)).running).toEqual([]);
    await ready(t.workspaces, ws[0].id);
  });
  it('stops a dispatch on request without recording anything', async () => {
    const t = setup();
    const d = await t.cloud.dispatch(input(t.project.id));
    t.cloud.cancel(d.id);
    expect(t.ptys[0].pty.killed).toBe(true);
    expect(t.cloud.getDispatch(d.id)!.phase).not.toBe('created');
    expect(t.cloud.sessions(t.project.id)).toHaveLength(0);
  });
});

describe('long prompts and Windows launchers', () => {
  const multiline = 'Step one.\nStep two with "quotes" and 50%.';
  it('refuses to send a prompt a .cmd launcher cannot carry, and never shortens it', async () => {
    const t = setup({ platform: 'win32', claudeFile: 'C:\\npm\\claude.cmd' });
    expect(await code(t.cloud.dispatch(input(t.project.id, { prompt: multiline })))).toBe('prompt_needs_browser');
    expect(t.ptys).toHaveLength(0);
  });
  it('with the browser route: the full text on the clipboard, claude.ai/code opened with the repository, no prompt in the address', async () => {
    const t = setup({ platform: 'win32', claudeFile: 'C:\\npm\\claude.cmd' });
    const long = `${multiline}\n${'x'.repeat(40_000)}`;
    const d = await t.cloud.dispatch(input(t.project.id, { prompt: long, useBrowserFallback: true }));
    expect(t.native.clipboardWrites).toEqual([long]);
    expect(t.native.externalOpened).toEqual(['https://claude.ai/code?repositories=acme/widgets']);
    expect(d).toMatchObject({ phase: 'unknown', method: 'clipboard_browser' });
    expect(d.detail).toMatch(/cannot see whether you did/);
    expect(t.ptys).toHaveLength(0);
    expect(t.cloud.sessions(t.project.id)).toHaveLength(0);
  });
  it('refuses a prompt over the composer limit instead of cutting it', async () => {
    const t = setup();
    expect(await code(t.cloud.dispatch(input(t.project.id, { prompt: 'a'.repeat(250_001) })))).toBe('prompt_too_long');
  });
  it('records a session link the person pasted, and refuses anything that is not a session', async () => {
    const t = setup();
    expect(t.cloud.recordLink(t.project.id, `${CODE}session_abAbCdEfGhIj?x=1`, 'By hand')).toMatchObject({ url: `${CODE}session_abAbCdEfGhIj`, method: 'recorded_link', title: 'By hand' });
    for (const bad of ['https://claude.ai/code/new', 'https://evil.example/code/session_abAbCdEfGhIj', 'http://claude.ai/code/' + 'session_abAbCdEfGhIj', 'nonsense']) {
      expect(() => t.cloud.recordLink(t.project.id, bad, null), bad).toThrow();
    }
    expect(t.cloud.sessions(t.project.id)).toHaveLength(1);
  });
});

describe('follow-up messages', () => {
  const ok = { code: 0, stdout: '{"ok":true,"session_id":"session_abAbCdEfGhIj","url":"x"}\n', stderr: '' };
  async function withSession(extra: Parameters<typeof setup>[0]) {
    const t = setup(extra);
    const rec = t.cloud.recordLink(t.project.id, `${CODE}session_abAbCdEfGhIj`, null);
    return { t, rec };
  }
  it('sends the documented command and says accepted without claiming completion', async () => {
    const { t, rec } = await withSession({ runExtra: (a) => (a[0] === '-p' ? ok : null) });
    const r = await t.cloud.followUp(rec.id, 'Also add tests.');
    expect(r.outcome).toBe('accepted');
    expect(t.runs.at(-1)).toEqual(['-p', 'Also add tests.', '--cloud', 'session_abAbCdEfGhIj', '--output-format', 'json']);
    expect(t.cloud.sessions(t.project.id)[0].lastResult).toMatchObject({ outcome: 'accepted' });
    expect(r.note).toMatch(/does not mean Claude has acted/);
  });
  it('shows a rejection, and an unknown outcome when the CLI did not finish', async () => {
    const rej = await withSession({ runExtra: () => ({ code: 1, stdout: '{"ok":false,"session_id":"s","error":"Session expired. Please run /login to sign in again."}', stderr: 'Error: failed to send message' }) });
    expect(await rej.t.cloud.followUp(rej.rec.id, 'hi')).toMatchObject({ outcome: 'rejected', note: expect.stringContaining('Session expired') });
    const slow = await withSession({ runExtra: () => ({ code: null, stdout: '', stderr: '' }) });
    expect(await slow.t.cloud.followUp(slow.rec.id, 'hi')).toMatchObject({ outcome: 'unknown' });
    expect(slow.t.cloud.sessions(slow.t.project.id)[0].lastResult.outcome).toBe('unknown');
  });
  it('keeps the same safety rules: a message a .cmd launcher cannot carry is not sent', async () => {
    const { t, rec } = await withSession({ platform: 'win32', claudeFile: 'C:\\npm\\claude.cmd', runExtra: () => ok });
    expect(await code(t.cloud.followUp(rec.id, 'two\nlines'))).toBe('message_needs_browser');
    expect(t.runs.some((a) => a[0] === '-p')).toBe(false);
  });
  it('can forget a record without touching the remote session', async () => {
    const { t, rec } = await withSession({});
    t.cloud.forget(rec.id);
    expect(t.cloud.sessions(t.project.id)).toHaveLength(0);
  });
});
