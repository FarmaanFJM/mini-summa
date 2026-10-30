import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { replay } from '@minisumma/claude-integration';
import type { RegistryResolver } from '@minisumma/claude-integration';
import { openDatabase } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import { createEventBus } from '../../src/bus.ts';
import type { ClaudeDerivedEvent, Clock } from '../../src/contracts.ts';
import { attribute, createProjection, excerptOf } from '../../src/claude/projection.ts';
import type { Projection } from '../../src/claude/projection.ts';
import { createRawStore } from '../../src/claude/rawStore.ts';
import type { RawStore } from '../../src/claude/rawStore.ts';
import { createFakeProjects } from './helpers/observer-fakes.ts';
import type { FakeProjects } from './helpers/observer-fakes.ts';
import { FIXTURES_DIR, S1, S2, discoveryEntry, fixtureEntries, hookEntry, hookPayload, isoAt } from './helpers/observer-hook.ts';

const clock: Clock = { now: () => new Date('2026-03-01T12:00:00.000Z') };

interface Setup { db: Db; projects: FakeProjects; rawStore: RawStore; projection: Projection }
function setup(opts: { chunkSize?: number; log?: { warn(m: string): void; error(m: string, d?: Record<string, unknown>): void } } = {}): Setup {
  const db = openDatabase(':memory:').db;
  const projects = createFakeProjects({ bus: createEventBus(), db });
  projects.add({ id: 'p-git', name: 'GitManager', roots: [{ path: '/w/GitManager' }] });
  projects.add({ id: 'p-herc', name: "Herc's Adventure", roots: [{ path: '/w/Herc' }, { path: '/w/Herc-wt' }] });
  const rawStore = createRawStore(db, clock);
  const projection = createProjection({ db, rawStore, projects, hostEnv: 'posix', clock, chunkSize: opts.chunkSize, log: opts.log });
  return { db, projects, rawStore, projection };
}

const append = (s: Setup, entries: Parameters<RawStore['appendRaw']>[0][]): void => { for (const e of entries) s.rawStore.appendRaw(e); };
const key = (id: string, env = 'posix') => `${env}|${id}` as `${'posix'}|${string}`;
const hookAt = (n: number, event: string, extra: Record<string, unknown> = {}, sessionId = S1, cwd = '/w/GitManager') =>
  hookEntry({ n, payload: hookPayload(event, sessionId, { cwd, ...extra }) });

describe('replaying the verified fixtures through the host', () => {
  const names = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json')).sort();
  it('has the fixtures it is meant to cover', () => {
    expect(names).toEqual(['background-pending', 'concurrent-sessions', 'discovery', 'duplicate-delivery', 'happy-path', 'identical-legitimate', 'late-stop', 'no-marker', 'no-prompt-id', 'stop-failure']);
  });

  it.each(names)('%s: derived events, reports, candidates and session states equal the library reducer on the same log', (name) => {
    const s = setup();
    append(s, fixtureEntries(name));
    const result = s.projection.applyNew();
    const oracle = replay(s.rawStore.since(0), s.projects.registry() as unknown as RegistryResolver);

    expect(result.applied).toBe(s.rawStore.count());
    expect(result.derived.map((d) => d.derivedId)).toEqual(oracle.derived.map((d) => d.derived_id));
    expect(result.derived.map((d) => d.kind)).toEqual(oracle.derived.map((d) => d.kind));
    expect(result.reports.map((r) => r.reportId)).toEqual([...oracle.reports.keys()]);
    expect(result.candidates.map((c) => c.candidateId)).toEqual([...oracle.candidates.keys()]);
    for (const rs of oracle.sessions.values()) {
      const mine = s.projection.session(key(rs.session_id));
      expect(mine?.state, `${rs.session_id} state`).toBe(rs.state);
      expect(mine?.gen.n, `${rs.session_id} generation`).toBe(rs.gen.n);
    }
    expect(s.projection.sessionKeys().length).toBe(oracle.sessions.size);
  });

  it('the happy path yields one report with the complete body, and the contract fields filled in', () => {
    const s = setup();
    append(s, fixtureEntries('happy-path'));
    const { reports, derived } = s.projection.applyNew();
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r).toMatchObject({
      sessionKey: `posix|${S1}`, env: 'posix', sessionId: S1, generation: 1, projectId: 'p-git', projectName: 'GitManager', cwd: '/w/GitManager',
      promptId: 'pp-0001', taskId: `posix|${S1}:pp-0001`, taskTitle: 'Storage System', declaredStatus: 'complete', stopHookActive: false, late: false,
      capturedSeq: 8, redactions: 0, truncations: 0,
    });
    expect(r.body).toContain('Implemented the storage layer.');
    expect(r.body).toMatch(/<!-- mini-summa:report status=complete task="Storage System" -->\n$/);
    expect(r.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.capturedAt).toBe(isoAt(8));
    expect(r.note).toMatch(/declaration written by the model/);
    expect(derived.find((d) => d.kind === 'report_ready')).toMatchObject({ reportId: r.reportId, to: 'report_ready', notify: true, sessionKey: `posix|${S1}` });
  });

  it('copies the redaction and truncation counts the reducer carries, and is 0 when it carries none', () => {
    const s = setup();
    const stop = hookEntry({ n: 2, payload: hookPayload('Stop', S1, { cwd: '/w/GitManager', prompt_id: 'p1', last_assistant_message: 'done\n<!-- mini-summa:report status=complete task="T" -->' }) });
    stop.transport.redactions = 3;
    stop.transport.truncations = 2;
    const plain = hookEntry({ n: 3, payload: hookPayload('Stop', S2, { cwd: '/w/GitManager', prompt_id: 'p2', last_assistant_message: 'just progress, no marker' }) });
    append(s, [hookAt(1, 'UserPromptSubmit', { prompt_id: 'p1' }), stop, plain]);
    const { reports, candidates } = s.projection.applyNew();
    const oracle = replay(s.rawStore.since(0), s.projects.registry() as unknown as RegistryResolver);
    const oracleReport = [...oracle.reports.values()][0] as unknown as { redactions?: number; truncations?: number };
    const oracleCandidate = [...oracle.candidates.values()][0] as unknown as { redactions?: number; truncations?: number };
    expect(reports[0].redactions).toBe(oracleReport.redactions ?? 0);
    expect(reports[0].truncations).toBe(oracleReport.truncations ?? 0);
    expect(candidates[0].redactions).toBe(oracleCandidate.redactions ?? 0);
    expect(candidates[0].truncations).toBe(oracleCandidate.truncations ?? 0);
    for (const n of [reports[0].redactions, reports[0].truncations, candidates[0].redactions, candidates[0].truncations]) expect(Number.isInteger(n)).toBe(true);
  });

  it('keeps a final message without a marker as a candidate with the reason, never as a report', () => {
    const s = setup();
    append(s, fixtureEntries('no-marker'));
    const { reports, candidates } = s.projection.applyNew();
    expect(reports).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ reason: 'no_marker', declaredStatus: null, taskTitle: null, projectId: 'p-git', sessionKey: `posix|${S1}`, late: false });
    expect(candidates[0].body.length).toBeGreaterThan(0);
  });

  it('a Stop that arrives after the next prompt is still captured (late) and does not change the state', () => {
    const s = setup();
    append(s, fixtureEntries('late-stop'));
    const { reports } = s.projection.applyNew();
    expect(reports).toHaveLength(1);
    expect(reports[0].late).toBe(true);
    expect(s.projection.session(key(S1))?.state).toBe('working');
  });
});

describe('applyNew: always everything after lastAppliedSeq, in seq order', () => {
  it('applies entries that something else appended in between (takeSnapshot appends hook entries itself)', () => {
    const s = setup();
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' }), hookAt(2, 'UserPromptSubmit', { prompt_id: 'p1' })]);
    const first = s.projection.applyNew();
    expect(first.applied).toBe(2);
    expect(s.projection.lastAppliedSeq).toBe(2);
    expect(s.projection.session(key(S1))?.state).toBe('working');

    // appended behind the projection's back, as takeSnapshot does while it drains a spool
    append(s, [hookAt(3, 'PermissionRequest', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'ls' } }), hookAt(4, 'PostToolUse', { prompt_id: 'p1', tool_use_id: 't1' })]);
    const second = s.projection.applyNew();
    expect(second.applied).toBe(2);
    expect(second.derived.map((d) => [d.kind, d.to])).toEqual([['transition', 'needs_permission'], ['transition', 'working']]);
    expect(s.projection.lastAppliedSeq).toBe(4);

    const third = s.projection.applyNew();
    expect(third).toMatchObject({ applied: 0, derived: [], reports: [], candidates: [], rebuilt: false });
    expect(third.touched.size).toBe(0);
  });

  it('applies in seq order whatever the order the receipts were captured in', () => {
    const s = setup();
    // log order (seq) is what counts: the second receipt has the EARLIER monotonic value but the later seq
    append(s, [hookAt(5, 'SessionStart', { source: 'startup' }), hookAt(2, 'UserPromptSubmit', { prompt_id: 'p1' })]);
    s.projection.applyNew();
    expect(s.projection.session(key(S1))?.state).toBe('working');
  });

  it('reads long logs in chunks and gets the same result as one big read', () => {
    const one = setup({ chunkSize: 1000 });
    const many = setup({ chunkSize: 2 });
    for (const t of [one, many]) append(t, fixtureEntries('happy-path'));
    const a = one.projection.applyNew();
    const b = many.projection.applyNew();
    expect(b.applied).toBe(a.applied);
    expect(b.derived).toEqual(a.derived);
    expect(b.reports).toEqual(a.reports);
    expect(many.projection.lastAppliedSeq).toBe(one.projection.lastAppliedSeq);
  });

  it('reports which sessions were touched; a discovery snapshot touches every session of its environment', () => {
    const s = setup();
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' }, S1), hookAt(2, 'SessionStart', { source: 'startup' }, S2)]);
    expect([...s.projection.applyNew().touched].sort()).toEqual([key(S1), key(S2)]);
    append(s, [hookAt(3, 'UserPromptSubmit', { prompt_id: 'p' }, S1)]);
    expect([...s.projection.applyNew().touched]).toEqual([key(S1)]);
    append(s, [discoveryEntry({ n: 4, sessions: [{ kind: 'interactive', cwd: '/w/GitManager', sessionId: S1, pid: 1, startedAt: 1, status: 'busy' }] })]);
    expect([...s.projection.applyNew().touched].sort()).toEqual([key(S1), key(S2)]);
  });

  it('keeps going when the reducer chokes on one entry: it is skipped, counted and logged', () => {
    const errors: string[] = [];
    const s = setup({ log: { warn() {}, error: (m) => { errors.push(m); } } });
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' })]);
    s.rawStore.appendRaw({ kind: 'discovery', transport: { received_at: isoAt(2), wall_ms: 0, env_id: 'posix' }, payload: {} } as never); // no `sessions`: the reducer throws
    append(s, [hookAt(3, 'UserPromptSubmit', { prompt_id: 'p1' })]);
    const result = s.projection.applyNew();
    expect(result.applied).toBe(3);
    expect(s.projection.stats().applyErrors).toBe(1);
    expect(errors).toHaveLength(1);
    expect(s.projection.session(key(S1))?.state).toBe('working');
  });

  it('treats a receipt without an environment as the host environment', () => {
    const s = setup();
    const e = hookAt(1, 'SessionStart', { source: 'startup' });
    delete (e.transport as { env_id?: string }).env_id;
    s.rawStore.appendRaw(e);
    s.projection.applyNew();
    expect(s.projection.sessionKeys()).toEqual([key(S1)]);
  });
});

describe('derived events', () => {
  it('carry stable ids, the evidence, the raw position and the time of the raw entry (not the clock)', () => {
    const s = setup();
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' }), hookAt(2, 'UserPromptSubmit', { prompt_id: 'p1' })]);
    const { derived } = s.projection.applyNew();
    expect(derived).toHaveLength(2);
    expect(derived[0]).toMatchObject({ kind: 'transition', sessionKey: `posix|${S1}`, generation: 1, from: 'unknown', to: 'idle', evidence: 'hook:SessionStart', rawSeq: 1, at: isoAt(1), replay: false, notify: false, requiresUser: false });
    expect(derived[0].derivedId).toMatch(/^[0-9a-f]{16}$/);
    expect(derived[1]).toMatchObject({ to: 'working', evidence: 'hook:UserPromptSubmit', rawSeq: 2, at: isoAt(2) });
  });

  it('flag replay only when asked, and a rebuild produces the same ids and times, all marked replay', async () => {
    const s = setup();
    append(s, fixtureEntries('happy-path'));
    const live = s.projection.applyNew();
    expect(live.derived.every((d) => d.replay === false)).toBe(true);
    const rebuilt = await s.projection.rebuild();
    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.derived.every((d) => d.replay === true)).toBe(true);
    expect(rebuilt.derived.map((d) => [d.derivedId, d.at, d.rawSeq])).toEqual(live.derived.map((d) => [d.derivedId, d.at, d.rawSeq]));
    expect(rebuilt.reports.map((r) => r.reportId)).toEqual(live.reports.map((r) => r.reportId));

    const catchUp = setup();
    append(catchUp, fixtureEntries('happy-path'));
    expect(catchUp.projection.applyNew({ replay: true }).derived.every((d) => d.replay)).toBe(true);
  });

  it('carry the usual notify / requiresUser / abnormal flags of the reducer', () => {
    const s = setup();
    append(s, [
      hookAt(1, 'UserPromptSubmit', { prompt_id: 'p1' }),
      hookAt(2, 'PermissionRequest', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'ls' } }),
      hookAt(3, 'SessionEnd', { reason: 'other' }),
    ]);
    const { derived } = s.projection.applyNew();
    const perm = derived.find((d) => d.to === 'needs_permission')!;
    expect(perm).toMatchObject({ notify: true, requiresUser: true });
    const ended = derived.find((d) => d.to === 'ended')!;
    expect(ended).toMatchObject({ abnormal: true, notify: true });
    expect(ended.text).toContain('Session ended while needs permission');
  });

  it('does not carry the reducer\'s `discovered` pseudo-state as a SessionState', () => {
    const s = setup();
    append(s, [discoveryEntry({ n: 1, sessions: [{ kind: 'interactive', cwd: '/w/GitManager', sessionId: S1, pid: 1, startedAt: 1, status: 'idle' }] })]);
    const ev = s.projection.applyNew().derived.find((d) => d.kind === 'session_discovered')!;
    expect(ev.to).toBeUndefined();
    expect(ev.text).toBe('Discovered (interactive, idle)');
  });
});

describe('permission prompts', () => {
  const permissionOf = (s: Setup, input: unknown, tool: string | null = 'Bash'): ClaudeDerivedEvent['permission'] => {
    append(s, [hookAt(1, 'UserPromptSubmit', { prompt_id: 'p1' }), hookAt(2, 'PermissionRequest', { prompt_id: 'p1', ...(tool ? { tool_name: tool } : {}), tool_input: input })]);
    return s.projection.applyNew().derived.find((d) => d.to === 'needs_permission')?.permission;
  };

  it('names the tool and gives an excerpt of the input found in the raw hook entry', () => {
    expect(permissionOf(setup(), { command: 'rm -rf build' })).toEqual({ toolName: 'Bash', inputExcerpt: 'rm -rf build' });
  });

  it('picks the part of the input a person recognises: file path, url, pattern; else compact JSON', () => {
    expect(permissionOf(setup(), { file_path: '/w/GitManager/src/a.ts', content: 'x'.repeat(5000) }, 'Write')).toEqual({ toolName: 'Write', inputExcerpt: '/w/GitManager/src/a.ts' });
    expect(permissionOf(setup(), { url: 'https://example.com/docs', prompt: 'summarise' }, 'WebFetch')?.inputExcerpt).toBe('https://example.com/docs');
    expect(permissionOf(setup(), { mode: 'x', depth: 3 }, 'Custom')?.inputExcerpt).toBe('{"mode":"x","depth":3}');
  });

  it('is at most 200 characters, ends with an ellipsis when cut, and collapses whitespace', () => {
    const long = permissionOf(setup(), { command: `echo ${'a'.repeat(500)}` })!.inputExcerpt!;
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    expect(permissionOf(setup(), { command: 'git   commit\n  -m\t"x"' })!.inputExcerpt).toBe('git commit -m "x"');
  });

  it('scrubs token shapes again even though the hook redacted them already', () => {
    const p = permissionOf(setup(), { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" https://x.example && echo ghp_abcdefghijklmnopqrstuvwx' })!;
    expect(p.inputExcerpt).not.toMatch(/abcdefghijklmnop/);
    expect(p.inputExcerpt).toContain('[REDACTED]');
  });

  it('has null fields when the hook supplied no tool, and for a permission prompt that only discovery saw', () => {
    expect(permissionOf(setup(), undefined, null)).toEqual({ toolName: null, inputExcerpt: null });
    const s = setup();
    append(s, [discoveryEntry({ n: 1, sessions: [{ kind: 'interactive', cwd: '/w/GitManager', sessionId: S1, pid: 1, startedAt: 1, status: 'waiting', waitingFor: 'permission prompt' }] })]);
    const ev = s.projection.applyNew().derived.find((d) => d.to === 'needs_permission')!;
    expect(ev.permission).toEqual({ toolName: null, inputExcerpt: null });
  });

  it('is only present on the transition into needs_permission', () => {
    const s = setup();
    append(s, [hookAt(1, 'UserPromptSubmit', { prompt_id: 'p1' }), hookAt(2, 'PermissionRequest', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'ls' } }), hookAt(3, 'PostToolUse', { prompt_id: 'p1', tool_use_id: 't' })]);
    const { derived } = s.projection.applyNew();
    expect(derived.filter((d) => d.permission !== undefined).map((d) => d.to)).toEqual(['needs_permission']);
  });

  it('excerptOf on odd values', () => {
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf(undefined)).toBeNull();
    expect(excerptOf('   ')).toBeNull();
    expect(excerptOf({ command: '   ' })).toBe('{"command":" "}'); // no usable field: the whole input, whitespace collapsed
    expect(excerptOf(42)).toBe('42');
    expect(excerptOf('abcdef', 4)).toBe('abc…');
  });
});

describe('attribution: the binding first, then the registry match; never the focus', () => {
  const addBinding = (s: Setup, sessionKey: string, projectId: string | null, source: 'managed' | 'manual'): void => {
    s.db.run(`INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at) VALUES (?, ?, NULL, ?, 'x', 'x')`, [sessionKey, projectId, source]);
  };
  const lookup = (s: Setup) => (id: string) => { const p = s.projects.get(id); return p ? { id: p.id, name: p.name } : null; };

  it('uses the registry match for a session with no binding, and says why when there is none', () => {
    const s = setup();
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' }, S1, '/w/GitManager/sub'), hookAt(2, 'SessionStart', { source: 'startup' }, S2, '/elsewhere')]);
    s.projection.applyNew();
    const ctx = s.projection.attributionContext();
    expect(s.projection.attribute(key(S1), ctx)).toEqual({ projectId: 'p-git', projectName: 'GitManager', resolution: 'matched' });
    expect(s.projection.attribute(key(S2), ctx)).toEqual({ projectId: null, projectName: null, resolution: 'unregistered_directory' });
    expect(s.projection.attribute(key('99999999-9999-4999-8999-999999999999'), ctx)).toEqual({ projectId: null, projectName: null, resolution: 'no_cwd' });
  });

  it('an ambiguous directory (two projects, same depth) stays unassigned and says so', async () => {
    const s = setup();
    s.projects.add({ id: 'p-twin', name: 'Twin', roots: [{ path: '/w/GitManager' }] });
    await s.projection.rebuild(); // a registry change takes effect through a rebuild (the sessions service does it on every roots change)
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' })]);
    s.projection.applyNew();
    expect(s.projection.attribute(key(S1), s.projection.attributionContext())).toEqual({ projectId: null, projectName: null, resolution: 'ambiguous' });
  });

  it('a manual binding beats the registry: reports captured after it carry the bound project', () => {
    const s = setup();
    append(s, [hookAt(1, 'UserPromptSubmit', { prompt_id: 'p1' })]);
    s.projection.applyNew();
    addBinding(s, key(S1), 'p-herc', 'manual');
    append(s, [hookAt(2, 'Stop', { prompt_id: 'p1', last_assistant_message: 'ok\n<!-- mini-summa:report status=complete task="T" -->' })]);
    const { reports } = s.projection.applyNew();
    expect(reports[0]).toMatchObject({ projectId: 'p-herc', projectName: "Herc's Adventure" });
    expect(s.projection.attribute(key(S1), s.projection.attributionContext())).toEqual({ projectId: 'p-herc', projectName: "Herc's Adventure", resolution: 'manual' });
  });

  it('a managed binding is reported as managed, and beats the registry too', () => {
    const s = setup();
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' })]);
    s.projection.applyNew();
    addBinding(s, key(S1), 'p-herc', 'managed');
    expect(s.projection.attribute(key(S1), s.projection.attributionContext())).toMatchObject({ projectId: 'p-herc', resolution: 'managed' });
  });

  it('a binding to a project that no longer exists is ignored: the registry decides', () => {
    const s = setup();
    s.projects.add({ id: 'p-gone', name: 'Gone', roots: [] });
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' })]);
    s.projection.applyNew();
    addBinding(s, key(S1), 'p-gone', 'manual');
    s.projects.remove('p-gone'); // the foreign key sets the binding's project_id to NULL
    expect(s.projection.attribute(key(S1), s.projection.attributionContext())).toMatchObject({ projectId: 'p-git', resolution: 'matched' });
  });

  it('attribute() is the same rule as a pure function', () => {
    const s = setup();
    const rs = { project: { id: 'p-git', name: 'GitManager' }, project_reason: 'matched' as const };
    const manual = { sessionKey: key(S1), projectId: 'p-herc', conversationId: null, source: 'manual' as const };
    expect(attribute(manual, rs, lookup(s))).toMatchObject({ projectId: 'p-herc', resolution: 'manual' });
    expect(attribute({ ...manual, projectId: null }, rs, lookup(s))).toMatchObject({ projectId: 'p-git', resolution: 'matched' });
    expect(attribute(undefined, { project: null, project_reason: 'ambiguous' }, lookup(s))).toEqual({ projectId: null, projectName: null, resolution: 'ambiguous' });
    expect(attribute(undefined, undefined, lookup(s))).toEqual({ projectId: null, projectName: null, resolution: 'no_cwd' });
  });
});

describe('rebuild with a fresh registry', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
    append(s, [hookAt(1, 'UserPromptSubmit', { prompt_id: 'p1' }, S1, '/w/New'), hookAt(2, 'Stop', { prompt_id: 'p1', last_assistant_message: 'done\n<!-- mini-summa:report status=partial task="Half" -->' }, S1, '/w/New')]);
  });

  it('resolves the project again for sessions that were unregistered before, and reports carry it', async () => {
    const before = s.projection.applyNew();
    expect(before.reports[0].projectId).toBeNull();
    expect(s.projection.session(key(S1))?.project_reason).toBe('unregistered_directory');

    s.projects.add({ id: 'p-new', name: 'New', roots: [{ path: '/w/New' }] });
    // the old state keeps answering until the replay is complete and swapped in
    expect(s.projection.session(key(S1))?.project).toBeNull();
    const after = await s.projection.rebuild();
    expect(s.projection.session(key(S1))?.project).toEqual({ id: 'p-new', name: 'New' });
    expect(after.reports[0]).toMatchObject({ projectId: 'p-new', projectName: 'New', reportId: before.reports[0].reportId });
    expect(after.touched.has(key(S1))).toBe(true);
    expect(s.projection.lastAppliedSeq).toBe(2);
  });

  it('continues with applyNew on the new state', async () => {
    s.projection.applyNew();
    await s.projection.rebuild();
    append(s, [hookAt(3, 'UserPromptSubmit', { prompt_id: 'p2' }, S1, '/w/New')]);
    const next = s.projection.applyNew();
    expect(next.applied).toBe(1);
    expect(next.derived.map((d) => d.to)).toEqual(['working']);
  });
});

describe('what is remembered about a session', () => {
  it('first and last hook time, start, name, end reason, since when it is in its state, and how it ended', () => {
    const s = setup();
    append(s, [
      hookAt(1, 'SessionStart', { source: 'startup' }),
      discoveryEntry({ n: 2, sessions: [{ kind: 'interactive', cwd: '/w/GitManager', sessionId: S1, pid: 10, startedAt: 5, status: 'idle', name: 'Fix login' }] }),
      hookAt(3, 'UserPromptSubmit', { prompt_id: 'p1' }),
      hookAt(4, 'SessionEnd', { reason: 'prompt_input_exit' }),
    ]);
    s.projection.applyNew();
    expect(s.projection.facts(key(S1))).toEqual({
      firstAt: isoAt(1), lastHookAt: isoAt(4), hookCount: 3, startedAtHook: isoAt(1), name: 'Fix login', sessionEndReason: 'prompt_input_exit',
      stateSince: { state: 'ended', at: isoAt(4) }, abnormalEnd: true, endedAt: isoAt(4),
    });
    expect(s.projection.isPrompted(key(S1))).toBe(true);
  });

  it('a new generation clears the end markers; isPrompted is false before any prompt', () => {
    const s = setup();
    append(s, [hookAt(1, 'SessionStart', { source: 'startup' }), hookAt(2, 'SessionEnd', { reason: 'other' })]);
    s.projection.applyNew();
    expect(s.projection.isPrompted(key(S1))).toBe(false);
    expect(s.projection.facts(key(S1))).toMatchObject({ endedAt: isoAt(2), sessionEndReason: 'other', abnormalEnd: false });
    append(s, [hookAt(3, 'SessionStart', { source: 'resume' })]);
    s.projection.applyNew();
    expect(s.projection.facts(key(S1))).toMatchObject({ endedAt: null, sessionEndReason: null, startedAtHook: isoAt(3), stateSince: { state: 'idle', at: isoAt(3) } });
    expect(s.projection.session(key(S1))?.gen.n).toBe(2);
  });
});
