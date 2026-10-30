import { afterEach, describe, expect, it } from 'vitest';
import { parseSessionKey } from '@minisumma/shared';
import type { SessionKey, SessionView } from '@minisumma/shared';
import { CoreError } from '../../src/errors.ts';
import type { ClaudeEventHandlers } from '../../src/contracts.ts';
import { createStubEnvironments } from './helpers/observer-fakes.ts';
import { keyOf, makeHarness } from './helpers/observer-harness.ts';
import type { Harness } from './helpers/observer-harness.ts';
import { S1, S2, hookEntry, hookPayload, waitFor, writeSpoolRecord } from './helpers/observer-hook.ts';

const open: Harness[] = [];
async function harness(opts: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  const h = await makeHarness(opts);
  open.push(h);
  return h;
}
afterEach(async () => { for (const h of open.splice(0)) await h.cleanup(); });

const ev = (n: number, event: string, extra: Record<string, unknown> = {}, sid = S1, cwd = '/w/proj') =>
  hookEntry({ n, payload: hookPayload(event, sid, { cwd, ...extra }) });
const report = (task = 'T') => `Done.\n\n## Implementation Report\n- did it\n\n<!-- mini-summa:report status=complete task="${task}" -->\n`;

/** Adds a project and waits for the rebuild that a roots change causes. */
async function addProject(h: Harness, id = 'p1', name = 'Proj', root = '/w/proj'): Promise<void> {
  h.projects.add({ id, name, roots: [{ path: root }] });
  await h.sessions.flush();
}
const K1 = keyOf('posix', S1);
const K2 = keyOf('posix', S2);

describe('views built from real hook flows', () => {
  it('follows an observed session from start to a report to its end', async () => {
    const h = await harness();
    await addProject(h);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    expect(h.view(K1)).toMatchObject({
      key: K1, env: 'posix', sessionId: S1, origin: 'external', availability: 'live', state: 'idle', stateLabel: 'Idle', stateEvidence: 'hook:SessionStart',
      projectId: 'p1', projectName: 'Proj', projectResolution: 'matched', cwd: '/w/proj', generation: 1, resumable: false, termination: null, attention: null,
      terminal: null, isProjectDefault: false, unresolvedOrdering: 0,
    });
    expect(h.view(K1).remoteControl).toEqual({ state: 'unknown', hint: 'Type /remote-control inside that Claude session to control it from the Claude app' });

    await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p1', prompt: 'do it' })]);
    expect(h.view(K1)).toMatchObject({ state: 'working', stateLabel: 'Working' });

    await h.feed([ev(3, 'PermissionRequest', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'npm test' } })]);
    expect(h.view(K1)).toMatchObject({ state: 'needs_permission', attention: { kind: 'permission', since: expect.any(String) } });
    const permission = h.collected.derived.find((d) => d.to === 'needs_permission')!;
    expect(permission).toMatchObject({ permission: { toolName: 'Bash', inputExcerpt: 'npm test' }, notify: true, requiresUser: true, replay: false });
    expect(h.view(K1).attention?.since).toBe(permission.at);

    await h.feed([ev(4, 'PostToolUse', { prompt_id: 'p1', tool_use_id: 't1' })]);
    expect(h.view(K1)).toMatchObject({ state: 'working', attention: null });

    await h.feed([ev(5, 'Stop', { prompt_id: 'p1', last_assistant_message: report('Ship it') })]);
    expect(h.view(K1)).toMatchObject({ state: 'report_ready', attention: { kind: 'report' } });
    expect(h.collected.reports).toHaveLength(1);
    expect(h.collected.reports[0]).toMatchObject({ taskTitle: 'Ship it', projectId: 'p1', sessionKey: K1, declaredStatus: 'complete' });

    await h.feed([ev(6, 'SessionEnd', { reason: 'prompt_input_exit' })]);
    expect(h.view(K1)).toMatchObject({
      state: 'ended', availability: 'ended', resumable: true, attention: null,
      termination: { kind: 'observed', reason: 'The session was closed from inside Claude Code.' },
    });
  });

  it('flags an end while working as abnormal', async () => {
    const h = await harness();
    await h.feed([ev(1, 'UserPromptSubmit', { prompt_id: 'p1' }), ev(2, 'SessionEnd', { reason: 'other' })]);
    expect(h.view(K1)).toMatchObject({ state: 'ended', attention: { kind: 'abnormal_end' } });
    expect(h.collected.derived.find((d) => d.to === 'ended')).toMatchObject({ abnormal: true, notify: true });
  });

  it('persists every changed view, emits session.upserted for it and tells the subscribers, and nothing when nothing changed', async () => {
    const h = await harness();
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p1' })]);
    const view = h.view(K1);
    const row = h.db.get<{ view_json: string; state: string; origin: string; availability: string; project_id: string | null; last_activity_at: string }>('SELECT * FROM sessions_projection WHERE session_key = ?', [K1])!;
    expect(JSON.parse(row.view_json)).toEqual(view);
    expect(row).toMatchObject({ state: 'working', origin: 'external', availability: 'live', project_id: null, last_activity_at: view.lastActivityAt });
    expect(h.collected.busUpserts.at(-1)).toEqual(view);
    expect(h.collected.sessionChanges.at(-1)!.view).toEqual(view);
    expect(h.collected.sessionChanges.at(-1)!.previous?.state).toBe('idle');
    expect(h.collected.sessionChanges[0].previous).toBeNull();

    const before = [h.collected.busUpserts.length, h.collected.sessionChanges.length];
    await h.sessions.flush();
    await h.sessions.flush();
    expect([h.collected.busUpserts.length, h.collected.sessionChanges.length]).toEqual(before);
    expect(h.collected.busUpserts.length).toBe(h.collected.sessionChanges.length);
  });

  it('keeps two sessions apart', async () => {
    const h = await harness();
    await h.feed([ev(1, 'UserPromptSubmit', { prompt_id: 'a' }, S1), ev(2, 'SessionStart', { source: 'startup' }, S2)]);
    expect(h.view(K1).state).toBe('working');
    expect(h.view(K2).state).toBe('idle');
  });
});

describe('list and get', () => {
  it('lists most recently active first, filters by project, hides ended sessions unless asked, and returns copies', async () => {
    const h = await harness();
    await addProject(h);
    await h.feed([
      ev(1, 'SessionStart', { source: 'startup' }, S1),
      ev(2, 'SessionStart', { source: 'startup' }, S2, '/elsewhere'),
      ev(3, 'UserPromptSubmit', { prompt_id: 'p' }, S1),
      ev(4, 'SessionEnd', { reason: 'other' }, S2, '/elsewhere'),
    ]);
    expect(h.sessions.list().map((v) => v.key)).toEqual([K1]);
    expect(h.sessions.list({ includeEnded: true }).map((v) => v.key)).toEqual([K2, K1]); // S2 ended at second 4, S1 was last active at 3
    expect(h.sessions.list({ projectId: 'p1' }).map((v) => v.key)).toEqual([K1]);
    expect(h.sessions.list({ projectId: 'nope', includeEnded: true })).toEqual([]);
    expect(h.sessions.get(keyOf('posix', '99999999-9999-4999-8999-999999999999'))).toBeNull();

    const copy = h.sessions.get(K1)!;
    copy.state = 'error';
    copy.remoteControl.hint = 'tampered';
    h.sessions.list()[0].projectName = 'tampered';
    expect(h.sessions.get(K1)).toMatchObject({ state: 'working', projectName: 'Proj' });
    expect(h.sessions.get(K1)!.remoteControl.hint).not.toBe('tampered');
  });
});

describe('managed sessions', () => {
  const seedRunning = (h: Harness, over: Parameters<Harness['managed']['seed']>[0] extends infer P ? Partial<P> : never = {}) =>
    h.managed.seed({ key: K1, projectId: null, cwd: '/w/proj', ...over }, true);

  it('appear as "Starting" the moment the terminal exists, before any hook', async () => {
    const h = await harness();
    await addProject(h);
    seedRunning(h, { name: 'Fix login', remoteControl: true, projectId: 'p1' });
    expect(h.view(K1)).toMatchObject({
      origin: 'managed', availability: 'live', state: 'unknown', stateLabel: 'Starting', stateEvidence: 'managed:pty', projectId: 'p1', projectResolution: 'managed',
      name: 'Fix login', generation: 1, pid: 4321, terminal: { cols: 120, rows: 32, exited: false }, remoteControl: { state: 'enabled' }, resumable: false,
    });
    expect(h.collected.sessionChanges.at(-1)!.previous).toBeNull();
  });

  it('take their state from hooks, and the manager is told when the first prompt is seen', async () => {
    const h = await harness();
    await addProject(h);
    seedRunning(h, { projectId: 'p1' });
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    expect(h.view(K1)).toMatchObject({ origin: 'managed', state: 'idle', stateEvidence: 'hook:SessionStart', generation: 1 });
    expect(h.managed.prompted).toEqual([]);
    await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p1' })]);
    expect(h.managed.prompted).toEqual([K1]);
    expect(h.managed.get(K1)?.prompted).toBe(true);
    await h.feed([ev(3, 'PostToolUse', { prompt_id: 'p1', tool_use_id: 't' })]);
    expect(h.managed.prompted).toEqual([K1]); // told once
  });

  it('are attributed to the project they were started for, even when the directory belongs to another one', async () => {
    const h = await harness();
    await addProject(h, 'p1', 'Proj', '/w/proj');
    await addProject(h, 'p2', 'Other', '/w/other');
    seedRunning(h, { projectId: 'p2' });
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]); // cwd /w/proj matches p1 by the registry
    expect(h.view(K1)).toMatchObject({ projectId: 'p2', projectName: 'Other', projectResolution: 'managed' });
    expect(h.collected.reports.length).toBe(0);
  });

  it('become resumable when the terminal exits after a prompt, and ended when it never got one', async () => {
    const h = await harness();
    seedRunning(h);
    seedRunning(h, { key: K2 });
    await h.feed([ev(1, 'UserPromptSubmit', { prompt_id: 'p' }, S1)]);
    h.managed.change(K1, { status: 'exited', pid: null, exitedAt: '2026-01-01T11:00:00.000Z', exitCode: 0 });
    h.managed.change(K2, { status: 'exited', pid: null, exitedAt: '2026-01-01T11:00:00.000Z', exitCode: 1 });
    expect(h.view(K1)).toMatchObject({ availability: 'resumable', resumable: true, state: 'ended', terminal: { exited: true }, termination: { kind: 'observed', at: '2026-01-01T11:00:00.000Z' } });
    expect(h.view(K2)).toMatchObject({ availability: 'ended', resumable: false, termination: { kind: 'observed', reason: 'The terminal process exited with code 1.' } });
  });

  it('look at the spool again when their terminal exits, so a SessionEnd that is already there is not missed', async () => {
    const h = await harness();
    seedRunning(h);
    await h.feed([ev(1, 'UserPromptSubmit', { prompt_id: 'p' })]);
    writeSpoolRecord(h.layout.spoolDirHost, ev(2, 'SessionEnd', { reason: 'prompt_input_exit' }));
    h.managed.change(K1, { status: 'exited', pid: null, exitedAt: 'E', exitCode: 0 });
    await waitFor(() => h.sessions.get(K1)?.stateEvidence === 'hook:SessionEnd', { what: 'the SessionEnd hook to be applied' });
    expect(h.view(K1).termination?.kind).toBe('observed');
  });

  it('are disconnected, not ended, when their link is lost; a prompted one can still be resumed', async () => {
    const h = await harness({ init: false });
    h.managed.seed({ key: K1, projectId: null, status: 'disconnected', pid: null, exitReason: 'app_restart', prompted: true });
    await h.sessions.init();
    expect(h.managed.initCalls).toBe(1);
    expect(h.view(K1)).toMatchObject({ origin: 'managed', availability: 'disconnected', resumable: true, termination: null, pid: null });
  });

  it('ignore changes that are only terminal output: no view is emitted for lastOutputAt', async () => {
    const h = await harness();
    seedRunning(h);
    const before = h.collected.busUpserts.length;
    h.managed.change(K1, { lastOutputAt: '2026-01-01T10:00:05.000Z' });
    h.managed.change(K1, { lastOutputAt: '2026-01-01T10:00:06.000Z' });
    expect(h.collected.busUpserts.length).toBe(before);
    h.managed.change(K1, { name: 'renamed' });
    expect(h.collected.busUpserts.length).toBe(before + 1);
    expect(h.view(K1).name).toBe('renamed');
  });
});

describe('start', () => {
  const actor = { kind: 'desktop' } as const;

  it('starts a new managed session in the project folder of the default environment, with the settings\' remote control choice', async () => {
    const h = await harness();
    await addProject(h);
    h.settings.update({ sessions: { remoteControlByDefault: true } });
    const view = await h.sessions.start('p1', { mode: 'new', name: '  Fix login  ' }, actor);
    expect(h.managed.started).toHaveLength(1);
    expect(h.managed.started[0]).toMatchObject({
      projectId: 'p1', env: 'posix', cwd: '/w/proj', name: 'Fix login', remoteControl: true, cols: 120, rows: 32, mode: 'new', conversationId: null,
    });
    expect(h.managed.started[0].rootId).toMatch(/^rot_/);
    expect(view).toMatchObject({ origin: 'managed', availability: 'live', projectId: 'p1', name: 'Fix login', remoteControl: { state: 'enabled' } });
    expect(h.sessions.get(view.key)).toEqual(view);
  });

  it('honours an explicit size and remote control choice, and clamps absurd sizes', async () => {
    const h = await harness();
    await addProject(h);
    await h.sessions.start('p1', { mode: 'new', cols: 90, rows: 20, remoteControl: false }, actor);
    await h.sessions.start('p1', { mode: 'new', cols: 100000, rows: 1 }, actor);
    expect(h.managed.started.map((s) => [s.cols, s.rows, s.remoteControl])).toEqual([[90, 20, false], [500, 5, false]]);
  });

  it('uses the first root in the requested environment, or the one asked for by id', async () => {
    const h = await harness();
    h.projects.add({ id: 'p2', name: 'Two', roots: [{ path: '/w/two-a' }, { path: '/w/two-b' }] });
    await h.sessions.flush();
    await h.sessions.start('p2', { mode: 'new' }, actor);
    const second = h.projects.get('p2')!.roots[1];
    await h.sessions.start('p2', { mode: 'new', rootId: second.id }, actor);
    expect(h.managed.started.map((s) => s.cwd)).toEqual(['/w/two-a', '/w/two-b']);
  });

  it.each([
    [{ mode: 'new', env: 'win' }, 'This project has no folder in Windows. Add one in the project settings, then start the session again.', 'no_root_for_env'],
    [{ mode: 'new', rootId: 'rot_nope' }, 'That folder does not belong to this project.', 'root_not_in_project'],
    [{ mode: 'new', conversationId: 'cnv_x' }, 'was not found', 'not_found'],
    [{ mode: 'resume' }, 'Say which session to resume.', 'resume_key_required'],
    [{ mode: 'new', resumeKey: `posix|${S1}` }, 'A new session cannot name a session to resume.', 'resume_key_unexpected'],
    [{ mode: 'resume', resumeKey: `posix|${S2}` }, 'Mini-Summa does not know that session, so it cannot resume it.', 'resume_unknown'],
  ])('refuses %j with a clear message', async (req, message, code) => {
    const h = await harness();
    await addProject(h);
    const err = await h.sessions.start('p1', req as never, actor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).message).toContain(message);
    expect((err as CoreError).code).toBe(code);
    expect(h.managed.started).toEqual([]);
  });

  it('refuses a project that is archived, one that does not exist, and an environment where Claude is not available', async () => {
    const h = await harness();
    h.projects.add({ id: 'old', name: 'Old', roots: [{ path: '/w/old' }], archived: true });
    await expect(h.sessions.start('old', { mode: 'new' }, actor)).rejects.toMatchObject({ code: 'project_archived' });
    await expect(h.sessions.start('missing', { mode: 'new' }, actor)).rejects.toMatchObject({ status: 404 });

    const down = await harness({ environments: (layout) => createStubEnvironments('posix', [layout], false) });
    await addProject(down);
    await expect(down.sessions.start('p1', { mode: 'new' }, actor)).rejects.toMatchObject({ code: 'environment_unavailable', message: 'Claude Code was not found.' });
  });

  it('refuses a conversation that belongs to another project', async () => {
    const h = await harness();
    await addProject(h);
    (h.projects.conversations as { require: (id: string) => unknown }).require = () => ({ id: 'cnv_x', projectId: 'p-other' });
    await expect(h.sessions.start('p1', { mode: 'new', conversationId: 'cnv_x' }, actor)).rejects.toMatchObject({ code: 'conversation_not_in_project' });
  });

  describe('resume', () => {
    const exitedPrompted = (h: Harness, over: Parameters<Harness['managed']['seed']>[0] extends infer P ? Partial<P> : never = {}) =>
      h.managed.seed({ key: K1, projectId: 'p1', cwd: '/w/orig', status: 'exited', prompted: true, pid: null, exitedAt: 'E', exitCode: 0, ...over }, true);

    it('brings back a resumable session in the folder it ran in, with the same key', async () => {
      const h = await harness();
      await addProject(h);
      exitedPrompted(h);
      expect(h.view(K1)).toMatchObject({ availability: 'resumable', resumable: true });
      const view = await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, actor);
      expect(h.managed.started[0]).toMatchObject({ mode: 'resume', resumeSessionId: S1, cwd: '/w/orig', env: 'posix', projectId: 'p1' });
      expect(view).toMatchObject({ key: K1, availability: 'live', origin: 'managed', resumable: false });
    });

    it('resumes an observed session that ended, once it has a prompt', async () => {
      const h = await harness();
      await addProject(h);
      await h.feed([ev(1, 'UserPromptSubmit', { prompt_id: 'p' }), ev(2, 'SessionEnd', { reason: 'prompt_input_exit' })]);
      expect(h.view(K1)).toMatchObject({ origin: 'external', availability: 'ended', resumable: true });
      await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, actor);
      expect(h.managed.started[0]).toMatchObject({ mode: 'resume', resumeSessionId: S1, cwd: '/w/proj' });
    });

    it('refuses a session that is still running, with the reason', async () => {
      const h = await harness();
      await addProject(h);
      await h.feed([ev(1, 'UserPromptSubmit', { prompt_id: 'p' })]);
      await expect(h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, actor)).rejects.toMatchObject({
        code: 'not_resumable', message: expect.stringContaining('still running'),
      });
    });

    it('refuses a session that never received a prompt', async () => {
      const h = await harness();
      await addProject(h);
      exitedPrompted(h, { prompted: false });
      await expect(h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, actor)).rejects.toMatchObject({
        code: 'not_resumable', message: 'That session never received a prompt, so Claude Code has nothing to resume.',
      });
    });

    it('resumes only in the environment the session ran in', async () => {
      const h = await harness();
      await addProject(h);
      const wslKey = keyOf('wsl:Ubuntu', S2);
      h.managed.seed({ key: wslKey, projectId: 'p1', status: 'exited', prompted: true, pid: null, exitedAt: 'E', exitCode: 0 }, true);
      // no folder of the project is in that environment
      await expect(h.sessions.start('p1', { mode: 'resume', resumeKey: wslKey }, actor)).rejects.toMatchObject({ code: 'no_root_for_env', message: expect.stringContaining('WSL (Ubuntu)') });
      // asking for another environment explicitly is a mismatch
      await expect(h.sessions.start('p1', { mode: 'resume', resumeKey: wslKey, env: 'posix' }, actor)).rejects.toMatchObject({
        code: 'resume_env_mismatch', message: expect.stringContaining('can only be resumed there'),
      });
      expect(h.managed.started).toEqual([]);
    });
  });
});

describe('stop', () => {
  it('stops a managed session and returns its view', async () => {
    const h = await harness();
    h.managed.seed({ key: K1, projectId: null }, true);
    const view = await h.sessions.stop(K1, { force: true });
    expect(h.managed.stopped).toEqual([{ key: K1, force: true }]);
    expect(view).toMatchObject({ key: K1, availability: 'ended', state: 'ended' });
  });

  it('explains that a session started elsewhere can only be observed', async () => {
    const h = await harness();
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    const err = await h.sessions.stop(K1, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toMatchObject({ status: 422, code: 'not_managed' });
    expect((err as Error).message).toBe('Mini-Summa can only stop sessions it started itself. This one was started elsewhere, so it is only observed. Close it in the terminal where it runs.');
    expect(h.managed.stopped).toEqual([]);
  });

  it('does not know a session it has never seen', async () => {
    const h = await harness();
    await expect(h.sessions.stop(keyOf('posix', S2), {})).rejects.toMatchObject({ status: 404 });
  });
});

describe('bind', () => {
  it('attaches an unassigned session to a project and re-attributes it at once', async () => {
    const h = await harness();
    await addProject(h, 'p1', 'Proj', '/w/proj');
    await addProject(h, 'p2', 'Other', '/w/other');
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S1, '/elsewhere')]);
    expect(h.view(K1)).toMatchObject({ projectId: null, projectResolution: 'unregistered_directory' });
    const view = h.sessions.bind(K1, 'p2');
    expect(view).toMatchObject({ projectId: 'p2', projectName: 'Other', projectResolution: 'manual' });
    expect(h.db.get('SELECT * FROM session_bindings WHERE session_key = ?', [K1])).toMatchObject({ project_id: 'p2', source: 'manual' });
    expect(h.collected.busUpserts.at(-1)).toMatchObject({ projectId: 'p2' });
    // reports captured from now on carry the binding
    await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p' }, S1, '/elsewhere'), ev(3, 'Stop', { prompt_id: 'p', last_assistant_message: report() }, S1, '/elsewhere')]);
    expect(h.collected.reports.at(-1)).toMatchObject({ projectId: 'p2', projectName: 'Other' });
  });

  it('beats the registry match, and clearing it goes back to the registry', async () => {
    const h = await harness();
    await addProject(h, 'p1', 'Proj', '/w/proj');
    await addProject(h, 'p2', 'Other', '/w/other');
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    expect(h.view(K1).projectId).toBe('p1');
    expect(h.sessions.bind(K1, 'p2')).toMatchObject({ projectId: 'p2', projectResolution: 'manual' });
    expect(h.sessions.bind(K1, null)).toMatchObject({ projectId: 'p1', projectResolution: 'matched' });
    expect(h.db.get('SELECT * FROM session_bindings WHERE session_key = ?', [K1])).toBeUndefined();
  });

  it('keeps a chosen ChatGPT conversation when the project is cleared', async () => {
    const h = await harness();
    await addProject(h);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    h.db.run("INSERT INTO conversations (id, project_id, title, url, original_url, kind, created_at, updated_at) VALUES ('cnv1','p1','t','https://chatgpt.com/c/x','https://chatgpt.com/c/x','chat','x','x')");
    h.sessions.bind(K1, 'p1');
    h.db.run("UPDATE session_bindings SET conversation_id = 'cnv1' WHERE session_key = ?", [K1]);
    expect(h.sessions.conversationBinding(K1)).toBe('cnv1');
    h.sessions.bind(K1, null);
    expect(h.sessions.conversationBinding(K1)).toBe('cnv1');
    expect(h.db.get('SELECT project_id FROM session_bindings WHERE session_key = ?', [K1])).toEqual({ project_id: null });
  });

  it('is refused for a session Mini-Summa started, for an unknown session, an unknown project and an archived one', async () => {
    const h = await harness();
    await addProject(h);
    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    expect(() => h.sessions.bind(K1, null)).toThrow(/started this session for a project/);
    expect(() => h.sessions.bind(K2, 'p1')).toThrow(expect.objectContaining({ status: 404 }));
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S2)]);
    expect(() => h.sessions.bind(K2, 'ghost')).toThrow(expect.objectContaining({ status: 404 }));
    h.projects.add({ id: 'arch', name: 'Arch', roots: [], archived: true });
    expect(() => h.sessions.bind(K2, 'arch')).toThrow(expect.objectContaining({ code: 'project_archived' }));
    expect(h.db.get('SELECT * FROM session_bindings WHERE session_key = ?', [K2])).toBeUndefined();
  });

  it('never replaces a managed binding row', async () => {
    const h = await harness();
    await addProject(h);
    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    // even if the guard in bind() were bypassed, the SQL itself leaves a managed row alone
    const { setManualBinding } = await import('../../src/claude/sessionBindings.ts');
    setManualBinding(h.db, K1, 'p1', 'now');
    expect(h.db.get('SELECT source FROM session_bindings WHERE session_key = ?', [K1])).toEqual({ source: 'managed' });
  });
});

describe('setDefault', () => {
  it('makes a session the default of its project and moves the flag when another takes over', async () => {
    const h = await harness();
    await addProject(h);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S1), ev(2, 'SessionStart', { source: 'startup' }, S2)]);
    const project = h.sessions.setDefault(K1, true);
    expect(project.defaultSessionKey).toBe(K1);
    expect(h.view(K1).isProjectDefault).toBe(true);
    expect(h.view(K2).isProjectDefault).toBe(false);
    h.sessions.setDefault(K2, true);
    expect(h.view(K1).isProjectDefault).toBe(false);
    expect(h.view(K2).isProjectDefault).toBe(true);
  });

  it('clears only its own default', async () => {
    const h = await harness();
    await addProject(h);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S1), ev(2, 'SessionStart', { source: 'startup' }, S2)]);
    h.sessions.setDefault(K1, true);
    expect(h.sessions.setDefault(K2, false).defaultSessionKey).toBe(K1);
    expect(h.view(K1).isProjectDefault).toBe(true);
    expect(h.sessions.setDefault(K1, false).defaultSessionKey).toBeNull();
    expect(h.view(K1).isProjectDefault).toBe(false);
  });

  it('needs a project, and a session that exists', async () => {
    const h = await harness();
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S1, '/elsewhere')]);
    expect(() => h.sessions.setDefault(K1, true)).toThrow(expect.objectContaining({ code: 'no_project' }));
    expect(() => h.sessions.setDefault(K2, true)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('notices when a project is renamed or its default changes elsewhere', async () => {
    const h = await harness();
    await addProject(h);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    h.projects.rename('p1', 'Renamed');
    await waitFor(() => h.sessions.get(K1)?.projectName === 'Renamed', { what: 'the new project name in the view' });
    h.projects.setDefaultSession('p1', K1);
    await waitFor(() => h.sessions.get(K1)?.isProjectDefault === true, { what: 'the default flag in the view' });
  });
});

describe('terminal access', () => {
  it('goes to the managed manager for a managed session', async () => {
    const h = await harness();
    h.managed.seed({ key: K1, projectId: null }, true);
    const attachment = h.sessions.terminal.attach(K1, { cols: 80, rows: 24 }, { data() {}, exit() {} });
    expect(attachment).toMatchObject({ cols: 80, rows: 24 });
    expect(h.sessions.terminal.input(K1, 'ls\r')).toBe(true);
    h.sessions.terminal.resize(K1, 100, 30);
    expect(h.managed.written).toEqual([{ key: K1, data: 'ls\r' }]);
  });

  it('is refused in words for a session that is only observed', async () => {
    const h = await harness();
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    const attachment = h.sessions.terminal.attach(K1, { cols: 80, rows: 24 }, { data() {}, exit() {} });
    expect(attachment).toEqual({ error: 'Mini-Summa did not start this session, so there is no terminal to show. Sessions started elsewhere can only be observed.' });
    expect(h.sessions.terminal.input(K1, 'x')).toBe(false);
    h.sessions.terminal.resize(K1, 1, 1);
    expect(h.managed.written).toEqual([]);
  });
});

describe('targetCheck', () => {
  it('says why a target does not qualify, in plain language, and never throws', async () => {
    const h = await harness();
    await addProject(h);
    expect(h.sessions.targetCheck(K1, null)).toEqual({ managed: false, live: false, generation: null, generationMatches: false, state: null, problem: 'Mini-Summa does not know this session.' });

    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S2)]);
    expect(h.sessions.targetCheck(K2, null)).toMatchObject({ managed: false, live: true, state: 'idle', problem: 'Mini-Summa only types into sessions it started itself. This session is observed only.' });

    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    await h.feed([ev(2, 'SessionStart', { source: 'startup' }, S1)]);
    expect(h.sessions.targetCheck(K1, null)).toEqual({ managed: true, live: true, generation: 1, generationMatches: true, state: 'idle', problem: null });
    expect(h.sessions.targetCheck(K1, 1)).toMatchObject({ generationMatches: true, problem: null });
    expect(h.sessions.targetCheck(K1, 2)).toMatchObject({ generationMatches: false, problem: expect.stringContaining('restarted after the request was made') });

    h.managed.change(K1, { status: 'exited', prompted: true, pid: null, exitedAt: 'E', exitCode: 0 });
    expect(h.sessions.targetCheck(K1, null)).toMatchObject({ managed: true, live: false, problem: 'This session is not running. Resume it first, then try again.' });
    h.managed.change(K1, { status: 'disconnected', exitedAt: null });
    expect(h.sessions.targetCheck(K1, null).problem).toMatch(/lost the connection/);
    h.managed.change(K1, { status: 'exited', prompted: false });
    h.managed.seed({ key: keyOf('posix', '33333333-3333-4333-8333-333333333333'), status: 'exited', prompted: false, pid: null, exitedAt: 'E', exitCode: 0 }, true);
    expect(h.sessions.targetCheck(keyOf('posix', '33333333-3333-4333-8333-333333333333'), null).problem).toBe('This session has ended.');
  });
});

describe('typeInto', () => {
  async function liveManaged(h: Harness) {
    await addProject(h);
    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
  }
  const req = (over: Record<string, unknown> = {}) => ({ text: 'Please continue', submit: true, expectGeneration: 1, allowedStates: ['idle', 'turn_ended'] as never, ...over });

  it('types user-authored text into a verified managed session', async () => {
    const h = await harness();
    await liveManaged(h);
    expect(await h.sessions.typeInto(K1, req())).toEqual({ ok: true, submitted: true });
    expect(h.managed.typed).toEqual([{ key: K1, text: 'Please continue', submit: true }]);
  });

  it('leaves text in the input box without submitting when asked, and that can be repeated', async () => {
    const h = await harness();
    await liveManaged(h);
    expect(await h.sessions.typeInto(K1, req({ submit: false, text: 'line 1\nline 2' }))).toEqual({ ok: true, submitted: false });
    expect(await h.sessions.typeInto(K1, req({ submit: false, text: 'line 3' }))).toEqual({ ok: true, submitted: false });
    expect(h.managed.typed.map((t) => [t.text, t.submit])).toEqual([['line 1\nline 2', false], ['line 3', false]]);
  });

  describe('a second send before Claude has reacted (a double click)', () => {
    it('is refused, and allowed again once a hook shows Claude picked the first one up', async () => {
      const h = await harness();
      await liveManaged(h);
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: true });
      const again = await h.sessions.typeInto(K1, req({ text: 'Please continue' }));
      expect(again).toEqual({ ok: false, code: 'state_not_allowed', problem: 'Text was sent to this session a moment ago and Claude has not picked it up yet. Wait until it starts working, then try again.' });
      expect(h.managed.typed).toHaveLength(1);
      await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p' }), ev(3, 'Stop', { prompt_id: 'p', last_assistant_message: 'done' })]);
      expect(h.view(K1).state).toBe('turn_ended');
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: true });
      expect(h.managed.typed).toHaveLength(2);
    });

    it('is allowed again after the settle window even when no hook arrived', async () => {
      const t = { ms: Date.parse('2026-03-01T10:00:00.000Z') };
      const h = await harness({ clock: { now: () => new Date(t.ms) } });
      await liveManaged(h);
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: true });
      t.ms += 3000;
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: false, code: 'state_not_allowed' });
      t.ms += 1500;
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: true });
      expect(h.managed.typed).toHaveLength(2);
    });

    it('lets only one of two simultaneous calls through', async () => {
      const h = await harness();
      await liveManaged(h);
      const results = await Promise.all([h.sessions.typeInto(K1, req()), h.sessions.typeInto(K1, req())]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ code: 'state_not_allowed' })]);
      expect(h.managed.typed).toHaveLength(1);
    });

    it('is forgotten when the terminal turned out to be gone, so the user can try again', async () => {
      const h = await harness();
      await liveManaged(h);
      h.managed.terminalAvailable = false;
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: false, code: 'no_terminal' });
      h.managed.terminalAvailable = true;
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: true });
    });

    it('does not apply to another session', async () => {
      const h = await harness();
      await liveManaged(h);
      h.managed.seed({ key: K2, projectId: 'p1' }, true);
      await h.feed([ev(5, 'SessionStart', { source: 'startup' }, S2)]);
      expect(await h.sessions.typeInto(K1, req())).toMatchObject({ ok: true });
      expect(await h.sessions.typeInto(K2, req())).toMatchObject({ ok: true });
    });
  });

  it.each([
    ['not managed', async (h: Harness) => { await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S2)]); return K2; }, 'not_managed'],
    ['not live', async (h: Harness) => { await liveManaged(h); h.managed.change(K1, { status: 'exited', prompted: true, pid: null, exitedAt: 'E', exitCode: 0 }); return K1; }, 'not_live'],
    ['a different generation', async (h: Harness) => { await liveManaged(h); return K1; }, 'generation_changed'],
  ])('refuses a target that is %s, and types nothing', async (_name, prepare, code) => {
    const h = await harness();
    const key = await prepare(h);
    const result = await h.sessions.typeInto(key, req({ expectGeneration: code === 'generation_changed' ? 7 : 1 }));
    expect(result).toMatchObject({ ok: false, code, problem: expect.any(String) });
    expect(h.managed.typed).toEqual([]);
  });

  it('refuses a state that does not accept input and names the states that do', async () => {
    const h = await harness();
    await liveManaged(h);
    await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p' })]);
    const result = await h.sessions.typeInto(K1, req());
    expect(result).toEqual({ ok: false, code: 'state_not_allowed', problem: 'Claude is "Working" right now. Text can only be sent when it is: Idle, Turn ended.' });
    expect(h.managed.typed).toEqual([]);
  });

  it('looks at the spool once more first: a prompt that was written a moment ago closes the door', async () => {
    const h = await harness();
    await liveManaged(h);
    expect(h.view(K1).state).toBe('idle'); // what the view still says
    writeSpoolRecord(h.layout.spoolDirHost, ev(2, 'UserPromptSubmit', { prompt_id: 'p' }));
    const result = await h.sessions.typeInto(K1, req());
    expect(result).toMatchObject({ ok: false, code: 'state_not_allowed' });
    expect(h.view(K1).state).toBe('working');
    expect(h.managed.typed).toEqual([]);
  });

  it('reports a terminal that is gone', async () => {
    const h = await harness();
    await liveManaged(h);
    h.managed.terminalAvailable = false;
    expect(await h.sessions.typeInto(K1, req())).toEqual({ ok: false, code: 'no_terminal', problem: 'The terminal for this session is not available any more, so nothing was typed.' });
  });

  it('refuses text with control characters before anything happens (an ESC could end a bracketed paste)', async () => {
    const h = await harness();
    await liveManaged(h);
    for (const text of ['hello\x1b[201~\rrm -rf /', 'bell\x07', 'nul\x00', 'del\x7f']) {
      await expect(h.sessions.typeInto(K1, req({ text }))).rejects.toMatchObject({ status: 422, code: 'unsafe_text' });
    }
    expect(await h.sessions.typeInto(K1, req({ text: 'tabs\tand\nnewlines\r\nare fine' }))).toMatchObject({ ok: true });
    expect(h.managed.typed).toHaveLength(1);
  });
});

describe('answerPermission', () => {
  async function waiting(h: Harness) {
    await addProject(h);
    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    await h.feed([ev(1, 'UserPromptSubmit', { prompt_id: 'p' }), ev(2, 'PermissionRequest', { prompt_id: 'p', tool_name: 'Bash', tool_input: { command: 'ls' } })]);
  }

  it('sends the answer when the session is waiting for one', async () => {
    const h = await harness();
    await waiting(h);
    expect(await h.sessions.answerPermission(K1, 'approve', 1)).toEqual({ ok: true, submitted: true });
    expect(h.managed.keys).toEqual([{ key: K1, keys: 'approve' }]);
  });

  it('never answers twice before Claude has reacted: a second approve could land on the next dialog', async () => {
    const h = await harness();
    await waiting(h);
    expect(await h.sessions.answerPermission(K1, 'approve', 1)).toMatchObject({ ok: true });
    expect(await h.sessions.answerPermission(K1, 'approve', 1)).toEqual({
      ok: false, code: 'state_not_allowed', problem: 'An answer was sent to this session a moment ago and Claude has not reacted yet, so a second one was not sent.',
    });
    expect(h.managed.keys).toEqual([{ key: K1, keys: 'approve' }]);
    // Claude reacts (the tool ran) and asks about the next one: that is a new question, and it can be answered
    await h.feed([ev(5, 'PostToolUse', { prompt_id: 'p', tool_use_id: 't9' }), ev(6, 'PermissionRequest', { prompt_id: 'p', tool_name: 'Write', tool_input: { file_path: '/w/proj/a.ts' } })]);
    expect(h.view(K1).state).toBe('needs_permission');
    expect(await h.sessions.answerPermission(K1, 'reject', 1)).toMatchObject({ ok: true });
    expect(h.managed.keys).toEqual([{ key: K1, keys: 'approve' }, { key: K1, keys: 'reject' }]);
  });

  it('answers once even when two clients answer at the same time', async () => {
    const h = await harness();
    await waiting(h);
    const results = await Promise.all([h.sessions.answerPermission(K1, 'approve', 1), h.sessions.answerPermission(K1, 'reject', 1)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.managed.keys).toHaveLength(1);
  });

  it('refuses when the session is not waiting, including when it moved on a moment ago', async () => {
    const h = await harness();
    await waiting(h);
    writeSpoolRecord(h.layout.spoolDirHost, ev(3, 'PostToolUse', { prompt_id: 'p', tool_use_id: 't' }));
    const result = await h.sessions.answerPermission(K1, 'approve', 1);
    expect(result).toEqual({ ok: false, code: 'state_not_allowed', problem: 'Claude is not waiting for a permission answer right now, so nothing was sent.' });
    expect(h.managed.keys).toEqual([]);
  });

  it('refuses another generation, an observed session and a gone terminal', async () => {
    const h = await harness();
    await waiting(h);
    expect(await h.sessions.answerPermission(K1, 'approve', 4)).toMatchObject({ ok: false, code: 'generation_changed' });
    h.managed.terminalAvailable = false;
    expect(await h.sessions.answerPermission(K1, 'approve', 1)).toMatchObject({ ok: false, code: 'no_terminal' });
    await h.feed([ev(5, 'PermissionRequest', { prompt_id: 'q', tool_name: 'Bash', tool_input: { command: 'ls' } }, S2)]);
    expect(await h.sessions.answerPermission(K2, 'approve', null)).toMatchObject({ ok: false, code: 'not_managed' });
    expect(h.managed.keys.length).toBe(1);
  });
});

describe('a terminal that has not shown a sign of life yet (startup screens, the trust dialog)', () => {
  const PROBLEM = 'Claude has not finished starting. If it is asking whether you trust this folder, answer in the terminal.';
  const desktop = { kind: 'desktop' } as const;
  // Even a caller that lists 'unknown' among the states it accepts cannot open this door.
  const ALLOWED = ['idle', 'turn_ended', 'waiting_for_you', 'report_ready', 'unknown'] as never;
  const send = (h: Harness, key: SessionKey, expectGeneration: number | null) =>
    h.sessions.typeInto(key, { text: 'go on', submit: true, expectGeneration, allowedStates: ALLOWED });
  const expectRefused = async (h: Harness, key: SessionKey, generation: number | null): Promise<void> => {
    expect(await send(h, key, generation)).toEqual({ ok: false, code: 'state_not_allowed', problem: PROBLEM });
    expect(await h.sessions.answerPermission(key, 'approve', generation)).toEqual({ ok: false, code: 'state_not_allowed', problem: PROBLEM });
    expect(h.sessions.targetCheck(key, generation)).toMatchObject({ managed: true, live: true, state: 'unknown', problem: PROBLEM });
    expect(h.managed.typed).toEqual([]);
    expect(h.managed.keys).toEqual([]);
  };

  /** A session that ran, did a task and ended; its terminal is gone and it can be resumed. */
  async function endedSession(h: Harness): Promise<void> {
    await addProject(h);
    h.managed.seed({ key: K1, projectId: 'p1', cwd: '/w/proj' }, true);
    await h.feed([
      ev(1, 'SessionStart', { source: 'startup' }), ev(2, 'UserPromptSubmit', { prompt_id: 'a' }),
      ev(3, 'Stop', { prompt_id: 'a', last_assistant_message: 'done' }), ev(4, 'SessionEnd', { reason: 'prompt_input_exit' }),
    ]);
    h.managed.change(K1, { status: 'exited', pid: null, exitedAt: '2026-01-01T10:00:09.000Z', exitCode: 0 });
    expect(h.view(K1)).toMatchObject({ availability: 'resumable', resumable: true, state: 'ended' });
  }

  it('a brand new terminal is "Starting" until its first hook; text, answers and the check are refused meanwhile', async () => {
    const h = await harness();
    await addProject(h);
    const started = await h.sessions.start('p1', { mode: 'new' }, desktop);
    const key = started.key;
    expect(started).toMatchObject({ origin: 'managed', availability: 'live', state: 'unknown', stateLabel: 'Starting', stateEvidence: 'managed:pty', attention: null, generation: 1, resumable: false });
    expect(h.sessions.targetCheck(key, 1)).toEqual({ managed: true, live: true, generation: 1, generationMatches: true, state: 'unknown', problem: PROBLEM });
    await expectRefused(h, key, 1);
    await expectRefused(h, key, null);

    // A person typing at the desktop terminal is never held back (that is where the trust dialog is answered).
    expect(h.sessions.terminal.input(key, '\r')).toBe(true);
    expect(h.managed.written).toEqual([{ key, data: '\r' }]);

    // Claude is up: its SessionStart hook arrives, and the same checks now pass
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, parseSessionKey(key)!.sessionId)]);
    expect(h.view(key)).toMatchObject({ state: 'idle', stateLabel: 'Idle', stateEvidence: 'hook:SessionStart', generation: 1 });
    expect(h.sessions.targetCheck(key, 1)).toEqual({ managed: true, live: true, generation: 1, generationMatches: true, state: 'idle', problem: null });
    expect(await send(h, key, 1)).toEqual({ ok: true, submitted: true });
  });

  it('a resumed terminal shows nothing of its earlier process, and is refused until the new process says hello', async () => {
    const h = await harness();
    await endedSession(h);
    const resumed = await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, desktop);
    expect(resumed).toMatchObject({
      key: K1, origin: 'managed', availability: 'live', resumable: false, termination: null, state: 'unknown', stateLabel: 'Starting', stateEvidence: 'managed:pty',
      attention: null, pid: 4321, generation: 1,
    });
    await expectRefused(h, K1, 1);
    expect(h.sessions.terminal.input(K1, '\r')).toBe(true);

    // the first hook of the new process: the reducer opens the new generation and the terminal may be used
    await h.feed([ev(10, 'SessionStart', { source: 'resume' })]);
    expect(h.view(K1)).toMatchObject({ state: 'idle', stateLabel: 'Idle', generation: 2, availability: 'live', stateEvidence: 'hook:SessionStart' });
    expect(h.collected.derived.some((d) => d.kind === 'generation' && d.generation === 2 && d.sessionKey === K1)).toBe(true);
    expect(await send(h, K1, 1)).toMatchObject({ ok: false, code: 'generation_changed' }); // a request made for the earlier process
    expect(await send(h, K1, 2)).toEqual({ ok: true, submitted: true });
    expect(h.managed.typed).toHaveLength(1);
  });

  it('does not show a permission prompt of the earlier process as this one\'s: the trust dialog is not a permission dialog', async () => {
    const h = await harness();
    await addProject(h);
    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }), ev(2, 'UserPromptSubmit', { prompt_id: 'a' }), ev(3, 'PermissionRequest', { prompt_id: 'a', tool_name: 'Bash', tool_input: { command: 'ls' } })]);
    expect(h.view(K1)).toMatchObject({ state: 'needs_permission', attention: { kind: 'permission' } });
    // the app died with a prompt on screen: no SessionEnd, the terminal is gone
    h.managed.change(K1, { status: 'disconnected', pid: null, prompted: true, exitReason: 'app_restart' });
    expect(h.view(K1)).toMatchObject({ availability: 'disconnected', resumable: true, attention: null });

    await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, desktop);
    expect(h.view(K1)).toMatchObject({ availability: 'live', state: 'unknown', stateLabel: 'Starting', attention: null });
    // before the fix this answered a dialog that was not there: an Enter on "do you trust this folder?" (default: No, exit)
    expect(await h.sessions.answerPermission(K1, 'approve', null)).toEqual({ ok: false, code: 'state_not_allowed', problem: PROBLEM });
    expect(await h.sessions.answerPermission(K1, 'reject', 1)).toEqual({ ok: false, code: 'state_not_allowed', problem: PROBLEM });
    expect(h.managed.keys).toEqual([]);
  });

  it('is decided by the order of the log, not by clocks: a hook stamped before the start (a lagging WSL clock) counts when it arrives after', async () => {
    const h = await harness();
    h.managed.seed({ key: K1, projectId: null }, true);
    expect(h.view(K1).stateLabel).toBe('Starting');
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]); // received_at 2026-01-01, long before the record's startedAt
    expect(h.view(K1).startedAt! > h.collected.derived.find((d) => d.sessionKey === K1)!.at).toBe(true);
    expect(h.view(K1)).toMatchObject({ state: 'idle', stateLabel: 'Idle' });
    expect(await send(h, K1, 1)).toEqual({ ok: true, submitted: true });
  });

  it('is not fooled by hooks of the earlier process that were already in the log when the new run began', async () => {
    const h = await harness();
    await endedSession(h);
    // the earlier process\'s last hooks, applied just before the resume
    await h.feed([ev(5, 'Notification', { notification_type: 'idle_prompt', message: 'idle' })]);
    await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, desktop);
    expect(h.view(K1).stateLabel).toBe('Starting');
    await h.sessions.flush();
    await h.sessions.flush();
    expect(h.view(K1).stateLabel).toBe('Starting'); // polling again changes nothing: only a NEW hook does
  });

  it('is not fooled by the earlier process\'s last hook, still waiting in the spool when the new run begins', async () => {
    // A discovery call holds the queue, so the spool pass that the exit asks for cannot run before the resume begins.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const h = await harness({ run: async () => { started = true; await gate; return { raw: [] }; } });
    await addProject(h);
    h.managed.seed({ key: K1, projectId: 'p1' }, true);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }), ev(2, 'UserPromptSubmit', { prompt_id: 'a' })]);
    const discovery = h.sessions.refreshDiscovery();
    await waitFor(() => started, { what: 'the discovery call to start' });

    // the earlier process ends: its SessionEnd hook is on disk, nothing has ingested it yet
    writeSpoolRecord(h.layout.spoolDirHost, ev(3, 'SessionEnd', { reason: 'prompt_input_exit' }));
    h.managed.change(K1, { status: 'exited', pid: null, exitedAt: '2026-01-01T10:00:09.000Z', exitCode: 0 });
    await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, desktop);

    release(); // now the old SessionEnd is ingested, after the new run began
    await discovery;
    await h.sessions.flush();
    expect(h.rawStore.loadAll().filter((e) => e.kind === 'hook').map((e) => (e.payload as { hook_event_name: string }).hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
    expect(h.view(K1)).toMatchObject({ availability: 'live', state: 'unknown', stateLabel: 'Starting', attention: null });
    await expectRefused(h, K1, null);

    await h.feed([ev(10, 'SessionStart', { source: 'resume' })]);
    expect(h.view(K1)).toMatchObject({ state: 'idle', generation: 2 });
    expect(await send(h, K1, 2)).toMatchObject({ ok: true });
  });

  it('a second resume starts over: the earlier run\'s hook does not make the next terminal look ready', async () => {
    const h = await harness();
    await endedSession(h);
    await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, desktop);
    await h.feed([ev(10, 'SessionStart', { source: 'resume' }), ev(11, 'SessionEnd', { reason: 'prompt_input_exit' })]);
    h.managed.change(K1, { status: 'exited', pid: null, exitedAt: '2026-01-01T10:00:20.000Z', exitCode: 0 });
    expect(h.view(K1)).toMatchObject({ availability: 'resumable', generation: 2 });
    await h.sessions.start('p1', { mode: 'resume', resumeKey: K1 }, desktop);
    expect(h.view(K1)).toMatchObject({ availability: 'live', state: 'unknown', stateLabel: 'Starting', generation: 2 });
    await expectRefused(h, K1, 2);
    await h.feed([ev(20, 'SessionStart', { source: 'resume' })]);
    expect(h.view(K1)).toMatchObject({ state: 'idle', generation: 3 });
    expect(await send(h, K1, 3)).toMatchObject({ ok: true });
  });

  it('leaves observed sessions alone: only a terminal Mini-Summa started can be "starting"', async () => {
    const h = await harness();
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S2)]);
    expect(h.view(K2)).toMatchObject({ origin: 'external', state: 'idle', stateLabel: 'Idle' });
    expect(h.sessions.targetCheck(K2, null).problem).toBe('Mini-Summa only types into sessions it started itself. This session is observed only.');
  });

  it('a terminal that stops while starting is simply not running any more', async () => {
    const h = await harness();
    await addProject(h);
    const key = (await h.sessions.start('p1', { mode: 'new' }, desktop)).key;
    h.managed.change(key, { status: 'exited', pid: null, exitedAt: 'E', exitCode: 1 });
    expect(h.view(key)).toMatchObject({ availability: 'ended', state: 'ended' });
    expect(h.sessions.targetCheck(key, null).problem).toBe('This session has ended.');
    expect(await send(h, key, null)).toMatchObject({ ok: false, code: 'not_live' });
  });
});

describe('subscribers and lifecycle', () => {
  it('can unsubscribe, and a failing subscriber does not stop the others or the pipeline', async () => {
    const h = await harness();
    const seen: string[] = [];
    const bad: ClaudeEventHandlers = { onSession() { throw new Error('boom'); }, onDerived() { throw new Error('boom'); } };
    const good: ClaudeEventHandlers = { onSession: (v) => { seen.push(v.state); } };
    const offBad = h.sessions.subscribe(bad);
    const offGood = h.sessions.subscribe(good);
    await h.feed([ev(1, 'SessionStart', { source: 'startup' })]);
    expect(seen).toEqual(['idle']);
    expect(h.log.count('error')).toBeGreaterThan(0);
    offBad();
    offGood();
    const errors = h.log.count('error');
    await h.feed([ev(2, 'UserPromptSubmit', { prompt_id: 'p' })]);
    expect(seen).toEqual(['idle']);
    expect(h.log.count('error')).toBe(errors);
  });

  it('init is safe to call twice and starts the managed manager once; shutdown stops it and stops looking', async () => {
    const h = await harness({ spoolPollMs: 20 });
    await h.sessions.init();
    expect(h.managed.initCalls).toBe(1);
    await h.sessions.shutdown();
    expect(h.managed.shutdownCalls).toBe(1);
    writeSpoolRecord(h.layout.spoolDirHost, ev(1, 'SessionStart', { source: 'startup' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(h.sessions.get(K1)).toBeNull(); // nothing is read after shutdown
  });

  it('flush waits for the pass it asked for, and the polling loop picks up a hook without being asked', async () => {
    const h = await harness({ spoolPollMs: 20 });
    writeSpoolRecord(h.layout.spoolDirHost, ev(1, 'SessionStart', { source: 'startup' }));
    await waitFor(() => h.sessions.get(K1)?.state === 'idle', { what: 'the polling loop to ingest the spool file' });
  });

  it('exposes the contract surface used by the composition root', async () => {
    const h = await harness();
    for (const m of ['list', 'get', 'start', 'stop', 'bind', 'setDefault', 'conversationBinding', 'refreshDiscovery', 'discoveryStatus', 'targetCheck', 'typeInto', 'answerPermission', 'subscribe', 'init', 'shutdown', 'flush', 'rebuild'] as const) {
      expect(typeof h.sessions[m], m).toBe('function');
    }
    expect(Object.keys(h.sessions.terminal).sort()).toEqual(['attach', 'input', 'resize']);
  });
});

// keep the type import used even if a later edit removes the last reference
export type _Unused = SessionKey | SessionView;
