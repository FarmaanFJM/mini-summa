// Project roots change: the Reducer is rebuilt over the new registry, sessions are re-attributed, and the registry file
// that hook processes read is rewritten atomically.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRegistryFileWriter, writeFileAtomic } from '../../src/claude/registryFile.ts';
import { collectingLogger, keyOf, makeHarness } from './helpers/observer-harness.ts';
import type { Harness } from './helpers/observer-harness.ts';
import { S1, S2, hookEntry, hookPayload, waitFor } from './helpers/observer-hook.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
async function harness(opts: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  const h = await makeHarness(opts);
  cleanups.push(() => h.cleanup());
  return h;
}
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-registry-')); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

const ev = (n: number, event: string, extra: Record<string, unknown> = {}, sid = S1, cwd = '/w/new/app') =>
  hookEntry({ n, payload: hookPayload(event, sid, { cwd, ...extra }) });
const report = (task: string) => `Done.\n\n<!-- mini-summa:report status=complete task="${task}" -->\n`;
const K1 = keyOf('posix', S1);

describe('a registry change re-attributes through a rebuild', () => {
  async function unregisteredWithReport(h: Harness): Promise<void> {
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }), ev(2, 'UserPromptSubmit', { prompt_id: 'p1' }), ev(3, 'Stop', { prompt_id: 'p1', last_assistant_message: report('Build it') })]);
  }

  it('assigns a session to the project whose root was just added, and its reports with it', async () => {
    const h = await harness();
    await unregisteredWithReport(h);
    expect(h.view(K1)).toMatchObject({ projectId: null, projectName: null, projectResolution: 'unregistered_directory' });
    expect(h.collected.reports).toHaveLength(1);
    expect(h.collected.reports[0]).toMatchObject({ projectId: null, projectName: null });
    const derivedBefore = h.collected.derived.length;
    const changesBefore = h.collected.sessionChanges.length;

    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush();

    expect(h.view(K1)).toMatchObject({ projectId: 'p9', projectName: 'New', projectResolution: 'matched', state: 'report_ready' });
    const change = h.collected.sessionChanges.slice(changesBefore).find((c) => c.view.key === K1)!;
    expect(change.previous).toMatchObject({ projectId: null });
    expect(change.view).toMatchObject({ projectId: 'p9' });
    // the same report is handed over again, now with the project; it is the same report
    expect(h.collected.reports).toHaveLength(2);
    expect(h.collected.reports[1]).toMatchObject({ reportId: h.collected.reports[0].reportId, projectId: 'p9', projectName: 'New', capturedAt: h.collected.reports[0].capturedAt });
    // nothing that already happened is announced a second time
    expect(h.collected.derived.length).toBe(derivedBefore);
    expect(h.db.get<{ project_id: string }>('SELECT project_id FROM sessions_projection WHERE session_key = ?', [K1])).toEqual({ project_id: 'p9' });
  });

  it('takes the session out of the project again when the root is removed', async () => {
    const h = await harness();
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush();
    await unregisteredWithReport(h);
    expect(h.view(K1)).toMatchObject({ projectId: 'p9' });
    h.projects.removeRoot('p9', h.projects.get('p9')!.roots[0].id);
    await h.sessions.flush();
    expect(h.view(K1)).toMatchObject({ projectId: null, projectResolution: 'unregistered_directory' });
    expect(h.collected.reports.at(-1)).toMatchObject({ projectId: null });
  });

  it('follows a deleted project, and a manual binding survives every registry change', async () => {
    const h = await harness();
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    h.projects.add({ id: 'p2', name: 'Two', roots: [{ path: '/w/two' }] });
    await h.sessions.flush();
    await unregisteredWithReport(h);
    h.sessions.bind(K1, 'p2');
    h.projects.addRoot('p9', { path: '/w/more' });
    await h.sessions.flush();
    expect(h.view(K1)).toMatchObject({ projectId: 'p2', projectResolution: 'manual' });
    h.projects.remove('p2'); // the binding's project is gone: the registry match is what is left
    await h.sessions.flush();
    expect(h.view(K1)).toMatchObject({ projectId: 'p9', projectResolution: 'matched' });
  });

  it('a rename shows up at once in the view, without waiting for a rebuild', async () => {
    const h = await harness();
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush();
    await unregisteredWithReport(h);
    h.projects.rename('p9', 'Renamed');
    await waitFor(() => h.sessions.get(K1)?.projectName === 'Renamed', { what: 'the renamed project in the view' });
  });

  it('a manual rebuild changes nothing that is visible and hands nothing over again', async () => {
    const h = await harness();
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush();
    await unregisteredWithReport(h);
    const views = h.sessions.list({ includeEnded: true });
    const counts = [h.collected.derived.length, h.collected.reports.length, h.collected.candidates.length, h.collected.sessionChanges.length];
    await h.sessions.rebuild();
    expect(h.sessions.list({ includeEnded: true })).toEqual(views);
    expect([h.collected.derived.length, h.collected.reports.length, h.collected.candidates.length, h.collected.sessionChanges.length]).toEqual(counts);
  });

  it('keeps ingesting correctly after a rebuild (the cursor is where the replay ended)', async () => {
    const h = await harness();
    await unregisteredWithReport(h);
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush();
    await h.feed([ev(4, 'UserPromptSubmit', { prompt_id: 'p2' }), ev(5, 'Stop', { prompt_id: 'p2', last_assistant_message: report('Second') })]);
    expect(h.collected.reports.map((r) => [r.taskTitle, r.projectId])).toEqual([['Build it', null], ['Build it', 'p9'], ['Second', 'p9']]);
    expect(h.view(K1).state).toBe('report_ready');
  });

  it('handles roots that change several times in a row', async () => {
    const h = await harness();
    await unregisteredWithReport(h);
    h.projects.add({ id: 'a', name: 'A', roots: [{ path: '/w/aaa' }] });
    h.projects.add({ id: 'b', name: 'B', roots: [{ path: '/w/new' }] });
    h.projects.addRoot('a', { path: '/w/bbb' });
    await h.sessions.flush();
    expect(h.view(K1)).toMatchObject({ projectId: 'b' });
    expect(h.log.count('error')).toBe(0);
  });

  it('keeps the separate sessions of one directory in the same project, and others out of it', async () => {
    const h = await harness();
    await h.feed([ev(1, 'SessionStart', { source: 'startup' }, S1, '/w/new/a'), ev(2, 'SessionStart', { source: 'startup' }, S2, '/w/other')]);
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush();
    expect(h.view(K1).projectId).toBe('p9');
    expect(h.view(keyOf('posix', S2)).projectId).toBeNull();
  });
});

describe('the registry file', () => {
  it('is written at startup, with a project list the hook\'s own registry loader reads', async () => {
    const h = await harness();
    const file = h.layout.registryFileHost;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ defaultEnv: 'posix', projects: [] });
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }, { path: 'C:\\Dev\\app', env: 'win' }] });
    await h.sessions.flush();
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written).toEqual({ defaultEnv: 'posix', projects: [{ id: 'p9', name: 'New', roots: [{ path: '/w/new', env: 'posix' }, { path: 'C:\\Dev\\app', env: 'win' }] }] });
    const { loadRegistry } = await import('@minisumma/claude-integration');
    expect(loadRegistry(file, { platform: 'linux', real: false }).resolve('/w/new/deep', 'posix')).toMatchObject({ reason: 'matched', project: { id: 'p9' } });
  });

  it('follows project changes that are not root changes (a rename, an archive) too', async () => {
    const h = await harness();
    h.projects.add({ id: 'p9', name: 'New', roots: [{ path: '/w/new' }] });
    await h.sessions.flush();
    h.projects.rename('p9', 'Renamed');
    await waitFor(() => JSON.parse(fs.readFileSync(h.layout.registryFileHost, 'utf8')).projects[0].name === 'Renamed', { what: 'the registry file to carry the new name' });
  });

  it('leaves no temporary files behind', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) { h.projects.add({ id: `p${i}`, name: `P${i}`, roots: [{ path: `/w/p${i}` }] }); }
    await h.sessions.flush();
    expect(fs.readdirSync(path.dirname(h.layout.registryFileHost)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('writing the file', () => {
  const contents = (n: number) => ({ defaultEnv: 'posix' as const, projects: [{ id: `p${n}`, name: `P${n}`, roots: [{ path: `/w/${n}`, env: 'posix' as const }] }] });

  it('writes only when the contents changed or the file is gone', async () => {
    const file = path.join(tmp(), 'registry.json');
    let n = 1;
    const log = collectingLogger();
    const writer = createRegistryFileWriter({ projects: { registryFileContents: () => contents(n) }, file: async () => file, log });
    expect(await writer.write()).toBe(true);
    expect(await writer.write()).toBe(false);
    const stamp = fs.statSync(file).mtimeMs;
    expect(await writer.write()).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
    n = 2;
    expect(await writer.write()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].id).toBe('p2');
    fs.rmSync(file);
    expect(await writer.write()).toBe(true); // somebody deleted it: it comes back
    expect(fs.existsSync(file)).toBe(true);
  });

  it('never throws: a folder that cannot be written is logged, and the old file stays', async () => {
    const dir = tmp();
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, 'a file where a folder should be');
    const log = collectingLogger();
    const writer = createRegistryFileWriter({ projects: { registryFileContents: () => contents(1) }, file: async () => path.join(blocker, 'registry.json'), log });
    expect(await writer.write()).toBe(false);
    expect(log.entries.some((e) => e.level === 'warn' && e.msg.includes('Could not write the project registry file'))).toBe(true);
  });

  it('replaces the file atomically: a reader sees the old or the new contents, never a mixture, with 0600 permissions', async () => {
    const file = path.join(tmp(), 'sub', 'registry.json');
    await writeFileAtomic(file, 'old\n');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const big = (c: string) => `${c.repeat(200_000)}\n`;
    const seen = new Set<string>();
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        const text = fs.readFileSync(file, 'utf8');
        seen.add(text === 'old\n' ? 'old' : text === big('a') ? 'a' : text === big('b') ? 'b' : `torn:${text.length}`);
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 20; i++) await writeFileAtomic(file, big(i % 2 ? 'a' : 'b'));
    stop = true;
    await reader;
    expect([...seen].filter((s) => s.startsWith('torn'))).toEqual([]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['registry.json']);
  });

  it('concurrent writes end with one of the contents written, intact', async () => {
    const file = path.join(tmp(), 'registry.json');
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeFileAtomic(file, `{"n":${i}}\n`)));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).n).toBeGreaterThanOrEqual(0);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['registry.json']);
  });
});
