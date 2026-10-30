// End to end with the REAL capture script: the hook command Claude Code would run is spawned with the payload on stdin,
// writes into the spool, and the observer picks it up, applies it and publishes views. Nothing in the path is faked
// except Claude itself.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvLayout } from '../../src/contracts.ts';
import { keyOf, makeHarness } from './helpers/observer-harness.ts';
import type { Harness } from './helpers/observer-harness.ts';
import { CAPTURE_DIST, CAPTURE_SRC, S1, S2, hookPayload, runHook, runHookAsync, waitFor } from './helpers/observer-hook.ts';

const open: Harness[] = [];
async function harness(opts: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  const h = await makeHarness({ realEnvironments: true, ...opts });
  open.push(h);
  return h;
}
afterEach(async () => { for (const h of open.splice(0)) await h.cleanup(); });

const K1 = keyOf('posix', S1);
const REPORT = 'Implemented it.\n\n## Implementation Report\n- changed a.ts\n\n<!-- mini-summa:report status=partial task="Add login" -->\n';

/** Runs one hook the way Claude Code does, with the arguments the environment's layout prescribes. */
function hook(layout: EnvLayout, event: string, extra: Record<string, unknown> = {}, sid = S1, cwd = '/w/proj', script = layout.captureScriptInEnv) {
  return runHook({ script, spool: layout.spoolDirInEnv, registry: layout.registryFileInEnv, env: layout.env, event, payload: hookPayload(event, sid, { cwd, ...extra }) });
}
const spoolFiles = (layout: EnvLayout, sub = ''): string[] => {
  const dir = path.join(layout.spoolDirHost, sub);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
};

describe('the real hook script, the spool, the raw log and the views', () => {
  it('drives a session from start to a report to its end, with polling and without anyone calling flush', async () => {
    const h = await harness({ spoolPollMs: 25 });
    h.projects.add({ id: 'p1', name: 'Proj', roots: [{ path: '/w/proj' }] });
    const layout = await h.environments.layout('posix');
    await waitFor(() => fs.existsSync(layout.registryFileHost) && fs.readFileSync(layout.registryFileHost, 'utf8').includes('/w/proj'), { what: 'the registry file to list the project' });

    // The registry file is what makes the hook inject the report protocol: only for a directory inside a project.
    const start = hook(layout, 'SessionStart', { source: 'startup', model: 'claude-x' });
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart', additionalContext: expect.stringContaining('mini-summa:report') });
    expect(hook(layout, 'SessionStart', { source: 'startup' }, S2, '/not/a/project').stdout).toBe('');
    await waitFor(() => h.sessions.get(K1)?.state === 'idle', { what: 'the SessionStart to be ingested' });
    expect(h.view(K1)).toMatchObject({ origin: 'external', availability: 'live', projectId: 'p1', projectResolution: 'matched', generation: 1, stateEvidence: 'hook:SessionStart' });

    expect(hook(layout, 'UserPromptSubmit', { prompt_id: 'pr-1', prompt: 'add login' }).status).toBe(0);
    await waitFor(() => h.sessions.get(K1)?.state === 'working', { what: 'working' });

    // A secret in the tool input is redacted by the hook before it ever reaches the spool, and the excerpt carries what is left.
    hook(layout, 'PermissionRequest', { prompt_id: 'pr-1', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx" https://api.example.com/login' } });
    await waitFor(() => h.sessions.get(K1)?.state === 'needs_permission', { what: 'needs_permission' });
    expect(h.view(K1).attention).toMatchObject({ kind: 'permission' });
    const permission = h.collected.derived.find((d) => d.to === 'needs_permission')!;
    expect(permission.permission?.toolName).toBe('Bash');
    expect(permission.permission?.inputExcerpt).toContain('[REDACTED]');
    expect(permission.permission?.inputExcerpt).not.toContain('abcdefghijklmnop');
    expect(permission).toMatchObject({ notify: true, requiresUser: true, replay: false, sessionKey: K1 });

    hook(layout, 'PostToolUse', { prompt_id: 'pr-1', tool_name: 'Bash', tool_use_id: 'tu-1', tool_response: { stdout: 'ok' } });
    await waitFor(() => h.sessions.get(K1)?.state === 'working' && h.sessions.get(K1)?.attention === null, { what: 'working again' });

    hook(layout, 'Stop', { prompt_id: 'pr-1', stop_hook_active: false, last_assistant_message: REPORT, background_tasks: [], session_crons: [] });
    await waitFor(() => h.sessions.get(K1)?.state === 'report_ready', { what: 'report_ready' });
    expect(h.collected.reports).toHaveLength(1);
    expect(h.collected.reports[0]).toMatchObject({
      sessionKey: K1, projectId: 'p1', projectName: 'Proj', taskTitle: 'Add login', declaredStatus: 'partial', body: REPORT, promptId: 'pr-1', late: false,
    });
    expect(h.collected.reports[0].capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    hook(layout, 'SessionEnd', { reason: 'prompt_input_exit' });
    await waitFor(() => h.sessions.get(K1)?.state === 'ended', { what: 'ended' });
    expect(h.view(K1)).toMatchObject({ availability: 'ended', resumable: true, termination: { kind: 'observed' }, attention: null });

    // the transitions, in order, as derived events
    expect(h.collected.derived.filter((d) => d.kind === 'transition' && d.sessionKey === K1).map((d) => d.to)).toEqual(['idle', 'working', 'needs_permission', 'working', 'ended']);

    // the log: every receipt once, from the real hook (handler, environment, clock domain), and the files are filed away
    const rows = h.db.all<{ seq: number; transport_id: string; kind: string; env_id: string; entry_json: string }>('SELECT * FROM raw_events ORDER BY seq');
    expect(rows).toHaveLength(7); // 6 for S1, 1 for S2
    expect(new Set(rows.map((r) => r.transport_id)).size).toBe(7);
    const transport = JSON.parse(rows[0].entry_json).transport;
    expect(transport).toMatchObject({ handler_id: 'ms-test', env_id: 'posix', capture_version: 1 });
    expect(transport.clock_domain).toMatch(/^posix\|boot:/);
    expect(spoolFiles(layout)).toEqual([]);
    expect(spoolFiles(layout, 'done')).toHaveLength(7);
  });

  it('puts a registry change in front of the next hook, and re-attributes the session after the rebuild', async () => {
    const h = await harness();
    const layout = await h.environments.layout('posix');
    expect(hook(layout, 'SessionStart', { source: 'startup' }, S1, '/w/new/app').stdout).toBe(''); // not in any project yet
    await h.sessions.flush();
    expect(h.view(K1)).toMatchObject({ projectId: null, projectResolution: 'unregistered_directory' });

    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush(); // waits for the registry file write and the rebuild
    expect(JSON.parse(fs.readFileSync(layout.registryFileHost, 'utf8'))).toEqual({ defaultEnv: 'posix', projects: [{ id: 'p9', name: 'New', roots: [{ path: '/w/new', env: 'posix' }] }] });
    expect(hook(layout, 'SessionStart', { source: 'startup' }, S2, '/w/new/app').stdout).toContain('additionalContext');
    expect(h.view(K1)).toMatchObject({ projectId: 'p9', projectName: 'New', projectResolution: 'matched' });
  });

  it('treats hooks that were already waiting when the app started as history: replayed, never a fresh notification', async () => {
    const h = await harness({ init: false });
    const layout = await h.environments.layout('posix');
    h.projects.add({ id: 'p1', name: 'Proj', roots: [{ path: '/w/proj' }] });
    // written by Claude while Mini-Summa was not running
    hook(layout, 'SessionStart', { source: 'startup' });
    hook(layout, 'UserPromptSubmit', { prompt_id: 'pr-1' });
    hook(layout, 'PermissionRequest', { prompt_id: 'pr-1', tool_name: 'Bash', tool_input: { command: 'make' } });
    expect(spoolFiles(layout)).toHaveLength(3);

    await h.sessions.init();
    expect(spoolFiles(layout)).toEqual([]);
    expect(h.view(K1)).toMatchObject({ state: 'needs_permission', attention: { kind: 'permission' } }); // still visible in the view
    expect(h.collected.derived.length).toBeGreaterThan(0);
    expect(h.collected.derived.every((d) => d.replay)).toBe(true);

    hook(layout, 'PostToolUse', { prompt_id: 'pr-1', tool_use_id: 't' });
    await h.sessions.flush();
    const fresh = h.collected.derived.filter((d) => !d.replay);
    expect(fresh.map((d) => d.to)).toEqual(['working']);
  });

  it('moves files that are not hook records into quarantine and carries on', async () => {
    const h = await harness();
    const layout = await h.environments.layout('posix');
    fs.mkdirSync(layout.spoolDirHost, { recursive: true });
    fs.writeFileSync(path.join(layout.spoolDirHost, '00000000000000000001-garbage.json'), '{"this is": not json');
    fs.writeFileSync(path.join(layout.spoolDirHost, '00000000000000000002-other.json'), JSON.stringify({ schema: 'someone-else/1', payload: {}, transport: {} }));
    fs.writeFileSync(path.join(layout.spoolDirHost, '.tmp-in-flight'), '{"half":');
    hook(layout, 'SessionStart', { source: 'startup' });
    await h.sessions.flush();
    expect(spoolFiles(layout, 'quarantine')).toEqual(['00000000000000000001-garbage.json', '00000000000000000002-other.json']);
    expect(fs.existsSync(path.join(layout.spoolDirHost, '.tmp-in-flight'))).toBe(true);
    expect(h.view(K1).state).toBe('idle');
    expect(h.log.entries.some((e) => e.level === 'warn' && /quarantine/.test(e.msg))).toBe(true);
  });

  it('loses and duplicates nothing when many hook processes run at once', async () => {
    const h = await harness({ spoolPollMs: 15 });
    const layout = await h.environments.layout('posix');
    const sessions = [S1, S2, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
    const runs = Array.from({ length: 40 }, (_, i) => runHookAsync({
      script: layout.captureScriptInEnv, spool: layout.spoolDirInEnv, registry: layout.registryFileInEnv, env: 'posix', event: 'PreToolUse',
      payload: hookPayload('PreToolUse', sessions[i % 4], { prompt_id: 'p', tool_name: 'Read', tool_input: { file_path: `/w/proj/f${i}.ts` }, tool_use_id: `tu-${i}` }),
    }));
    expect((await Promise.all(runs)).every((r) => r.status === 0)).toBe(true);
    await waitFor(() => h.rawStore.count() === 40, { what: 'all 40 receipts in the raw log' });
    expect(new Set(h.db.all<{ transport_id: string }>('SELECT transport_id FROM raw_events').map((r) => r.transport_id)).size).toBe(40);
    await h.sessions.flush();
    expect(spoolFiles(layout)).toEqual([]);
    for (const sid of sessions) expect(h.view(keyOf('posix', sid))).toMatchObject({ state: 'working', availability: 'live' });
  });

  it.skipIf(!fs.existsSync(CAPTURE_DIST))('works the same with the built hook (dist/capture.mjs)', async () => {
    const h = await harness({ captureScript: CAPTURE_DIST });
    const layout = await h.environments.layout('posix');
    expect(layout.captureScriptInEnv).toBe(CAPTURE_DIST);
    expect(hook(layout, 'SessionStart', { source: 'startup' }).status).toBe(0);
    expect(hook(layout, 'UserPromptSubmit', { prompt_id: 'p' }).status).toBe(0);
    await h.sessions.flush();
    expect(h.view(K1).state).toBe('working');
  });

  it('uses the environment layout for everything the hook needs: the spool, the registry file and the script', async () => {
    const h = await harness({ captureScript: CAPTURE_SRC });
    const layout = await h.environments.layout('posix');
    expect(layout).toMatchObject({
      spoolDirHost: path.join(h.dataDir, 'spool', 'posix'), registryFileHost: path.join(h.dataDir, 'registry.json'), captureScriptInEnv: CAPTURE_SRC,
      runtime: { command: process.execPath, runAsNode: false },
    });
    expect(fs.existsSync(layout.registryFileHost)).toBe(true); // written at startup, even with no project yet
    expect(JSON.parse(fs.readFileSync(layout.registryFileHost, 'utf8'))).toEqual({ defaultEnv: 'posix', projects: [] });
  });
});
