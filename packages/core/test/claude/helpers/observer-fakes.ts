// In-memory stand-ins for the services the observer half of the Claude layer depends on: projects (with the real
// verified registry matcher), settings, the managed-session manager and the environments service. They implement only
// what the observer calls, with test controls added.
import { randomUUID } from 'node:crypto';
import { createRegistry } from '@minisumma/claude-integration';
import { defaultNotificationPrefs, defaultSettings, makeSessionKey, mergeSettings, parseSessionKey } from '@minisumma/shared';
import type { EnvId, EnvironmentInfo, Project, ProjectRoot, SessionKey, Settings, SettingsPatch } from '@minisumma/shared';
import type { Db } from '@minisumma/storage';
import type {
  Clock, EnvLayout, EnvironmentsService, EventBus, ManagedManager, ManagedSessionRecord, ManagedStartInput, ProjectRegistry, TerminalAttachment,
  TerminalSink,
} from '../../../src/contracts.ts';
import { notFound } from '../../../src/errors.ts';
import type { ProjectsPort } from '../../../src/claude/sessions.ts';

// ---------------------------------------------------------------------------------------------------------------
// Projects

export interface FakeProjects extends ProjectsPort {
  /** Adds a project; roots use the registry default environment unless they say otherwise. */
  add(input: { id: string; name: string; roots?: { path: string; env?: EnvId }[]; defaultEnv?: EnvId; archived?: boolean }): Project;
  /** Adds a root and tells the roots listeners, like ProjectsService.addRoot. */
  addRoot(projectId: string, root: { path: string; env?: EnvId }): Project;
  removeRoot(projectId: string, rootId: string): Project;
  rename(projectId: string, name: string): Project;
  remove(projectId: string): void;
  rootListeners: number;
}

/** `db` is optional: with it, projects also exist as rows, so session_bindings can point at them (foreign key). */
export function createFakeProjects(opts: { bus: EventBus; defaultEnv?: EnvId; db?: Db }): FakeProjects {
  const defaultEnv: EnvId = opts.defaultEnv ?? 'posix';
  const store = new Map<string, Project>();
  const listeners = new Set<() => void>();
  let rootSeq = 0;
  const now = '2026-01-01T00:00:00.000Z';

  const upsert = (p: Project): Project => { store.set(p.id, p); opts.bus.emit({ type: 'project.upserted', project: structuredClone(p) }); return p; };
  const rootsChanged = (): void => { for (const fn of [...listeners]) fn(); };
  const mkRoot = (projectId: string, r: { path: string; env?: EnvId }, position: number): ProjectRoot =>
    ({ id: `rot_${++rootSeq}`, projectId, env: r.env ?? defaultEnv, path: r.path, label: null, position });

  const api: FakeProjects = {
    list: (o) => [...store.values()].filter((p) => o?.includeArchived || !p.archivedAt).map((p) => structuredClone(p)),
    get: (id) => (store.has(id) ? structuredClone(store.get(id)!) : null),
    require(id) {
      const p = store.get(id);
      if (!p) throw notFound('Project');
      return structuredClone(p);
    },
    registry(): ProjectRegistry {
      const config = {
        defaultEnv,
        projects: [...store.values()].filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name, roots: p.roots.map((r) => ({ path: r.path, env: r.env })) })),
      };
      // real: false keeps the matcher away from the machine's real file system
      return createRegistry(config, { platform: 'linux', real: false }) as unknown as ProjectRegistry;
    },
    registryFileContents: () => ({
      defaultEnv,
      projects: [...store.values()].filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name, roots: p.roots.map((r) => ({ path: r.path, env: r.env })) })),
    }),
    onRootsChanged(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setDefaultSession(projectId, key) {
      const p = store.get(projectId);
      if (!p) throw notFound('Project');
      return structuredClone(upsert({ ...p, defaultSessionKey: key }));
    },
    conversations: { require: () => { throw notFound('Conversation'); } },

    add(input) {
      const p: Project = {
        id: input.id, name: input.name, description: null, githubRepo: null, roots: [], defaultEnv: input.defaultEnv ?? defaultEnv,
        preferredConversationId: null, defaultSessionKey: null, notificationPrefs: defaultNotificationPrefs(), sortOrder: store.size,
        archivedAt: input.archived ? now : null, createdAt: now, updatedAt: now,
      };
      p.roots = (input.roots ?? []).map((r, i) => mkRoot(p.id, r, i));
      opts.db?.run(
        `INSERT OR REPLACE INTO projects (id, name, default_env, notification_prefs_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`,
        [p.id, p.name, p.defaultEnv, now, now],
      );
      upsert(p);
      if (p.roots.length) rootsChanged();
      return structuredClone(p);
    },
    addRoot(projectId, root) {
      const p = store.get(projectId);
      if (!p) throw notFound('Project');
      p.roots = [...p.roots, mkRoot(projectId, root, p.roots.length)];
      upsert(p);
      rootsChanged();
      return structuredClone(p);
    },
    removeRoot(projectId, rootId) {
      const p = store.get(projectId);
      if (!p) throw notFound('Project');
      p.roots = p.roots.filter((r) => r.id !== rootId);
      upsert(p);
      rootsChanged();
      return structuredClone(p);
    },
    rename(projectId, name) {
      const p = store.get(projectId);
      if (!p) throw notFound('Project');
      return structuredClone(upsert({ ...p, name }));
    },
    remove(projectId) {
      store.delete(projectId);
      opts.db?.run('DELETE FROM projects WHERE id = ?', [projectId]); // bindings to it become NULL, like the real schema
      opts.bus.emit({ type: 'project.removed', id: projectId });
      rootsChanged();
    },
    get rootListeners() { return listeners.size; },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

export interface FakeSettings {
  get(): Settings;
  update(patch: SettingsPatch): Settings;
  onChange(fn: (next: Settings, prev: Settings) => void): () => void;
}

export function createFakeSettings(initial?: SettingsPatch): FakeSettings {
  let current = mergeSettings(defaultSettings(), initial ?? {});
  const listeners = new Set<(next: Settings, prev: Settings) => void>();
  return {
    get: () => structuredClone(current),
    update(patch) {
      const prev = current;
      current = mergeSettings(prev, patch);
      for (const fn of [...listeners]) fn(structuredClone(current), structuredClone(prev));
      return structuredClone(current);
    },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Managed sessions

export interface FakeManaged extends ManagedManager {
  initCalls: number;
  shutdownCalls: number;
  started: ManagedStartInput[];
  stopped: { key: SessionKey; force: boolean }[];
  typed: { key: SessionKey; text: string; submit: boolean }[];
  keys: { key: SessionKey; keys: 'approve' | 'reject' }[];
  written: { key: SessionKey; data: string }[];
  prompted: SessionKey[];
  /** What typeText / sendKeys answer (false = the terminal is gone). */
  terminalAvailable: boolean;
  /** Adds or replaces a record (without telling the listeners unless `notify`). */
  seed(record: Partial<ManagedSessionRecord> & { key: SessionKey }, notify?: boolean): ManagedSessionRecord;
  /** Changes a record and tells the listeners, like the real manager does. */
  change(key: SessionKey, patch: Partial<ManagedSessionRecord>): ManagedSessionRecord;
}

export function createFakeManaged(deps: { db: Db; clock: Clock }): FakeManaged {
  const records = new Map<SessionKey, ManagedSessionRecord>();
  const listeners = new Set<(record: ManagedSessionRecord, previous: ManagedSessionRecord | null) => void>();
  const at = (): string => deps.clock.now().toISOString();

  const fire = (next: ManagedSessionRecord, previous: ManagedSessionRecord | null): void => {
    for (const fn of [...listeners]) fn({ ...next }, previous ? { ...previous } : null);
  };
  const writeBinding = (r: ManagedSessionRecord): void => {
    if (!r.projectId) return;
    deps.db.run(
      `INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at) VALUES (?, ?, ?, 'managed', ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET project_id = excluded.project_id, conversation_id = excluded.conversation_id, source = 'managed', updated_at = excluded.updated_at`,
      [r.key, r.projectId, r.conversationId, at(), at()],
    );
  };
  const base = (key: SessionKey): ManagedSessionRecord => {
    const parsed = parseSessionKey(key)!;
    return {
      key, env: parsed.env, sessionId: parsed.sessionId, projectId: null, rootId: null, cwd: '/w/proj', name: null, mode: 'new', resumedFrom: null,
      remoteControl: false, status: 'running', pid: 4321, startedAt: at(), exitedAt: null, exitCode: null, exitSignal: null, exitReason: null,
      cols: 120, rows: 32, prompted: false, lastOutputAt: null, appRunId: 'run_test', conversationId: null,
    };
  };

  const fake: FakeManaged = {
    initCalls: 0, shutdownCalls: 0, started: [], stopped: [], typed: [], keys: [], written: [], prompted: [], terminalAvailable: true,

    init() { fake.initCalls++; },
    list: () => [...records.values()].map((r) => ({ ...r })),
    get: (key) => (records.has(key) ? { ...records.get(key)! } : null),
    async start(input) {
      fake.started.push(input);
      const sessionId = input.mode === 'resume' && input.resumeSessionId ? input.resumeSessionId : randomUUID();
      const key = makeSessionKey(input.env, sessionId);
      const previous = records.get(key) ?? null;
      const record: ManagedSessionRecord = {
        ...base(key), projectId: input.projectId, rootId: input.rootId, cwd: input.cwd, name: input.name, mode: input.mode,
        resumedFrom: input.mode === 'resume' ? key : null, remoteControl: input.remoteControl, cols: input.cols, rows: input.rows,
        prompted: input.mode === 'resume', conversationId: input.conversationId,
      };
      records.set(key, record);
      writeBinding(record);
      fire(record, previous);
      return { ...record };
    },
    async stop(key, opts) {
      fake.stopped.push({ key, force: opts.force === true });
      return fake.change(key, { status: 'exited', pid: null, exitedAt: at(), exitCode: 0, exitReason: 'Stopped from Mini-Summa.' });
    },
    write(key, data) { fake.written.push({ key, data }); return fake.terminalAvailable && records.get(key)?.status === 'running'; },
    async typeText(key, text, opts) { fake.typed.push({ key, text, submit: opts.submit }); return fake.terminalAvailable; },
    async sendKeys(key, k) { fake.keys.push({ key, keys: k }); return fake.terminalAvailable; },
    resize() {},
    attach(key, size, _sink: TerminalSink): TerminalAttachment | { error: string } {
      if (!records.has(key)) return { error: 'no terminal' };
      return { replay: '', seq: 0, cols: size.cols, rows: size.rows, detach() {} };
    },
    markPrompted(key) {
      fake.prompted.push(key);
      const r = records.get(key);
      if (r && !r.prompted) fake.change(key, { prompted: true });
    },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async shutdown() { fake.shutdownCalls++; },

    seed(partial, notify = false) {
      const previous = records.get(partial.key) ?? null;
      const record: ManagedSessionRecord = { ...base(partial.key), ...partial };
      records.set(record.key, record);
      writeBinding(record);
      if (notify) fire(record, previous);
      return { ...record };
    },
    change(key, patch) {
      const previous = records.get(key);
      if (!previous) throw new Error(`no managed record ${key}`);
      const next = { ...previous, ...patch };
      records.set(key, next);
      fire(next, previous);
      return { ...next };
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------------------------------------------
// Environments (when a test does not exercise the real detection)

export interface StubEnvironments extends EnvironmentsService {
  infos: Map<EnvId, EnvironmentInfo>;
  layouts: Map<EnvId, EnvLayout>;
  commands: Map<EnvId, { file: string; prefixArgs: string[]; wslDistro: string | null } | null>;
}

export function createStubEnvironments(host: EnvId, layouts: EnvLayout[], available: boolean = true): StubEnvironments {
  const infos = new Map<EnvId, EnvironmentInfo>();
  const byEnv = new Map<EnvId, EnvLayout>();
  const commands = new Map<EnvId, { file: string; prefixArgs: string[]; wslDistro: string | null } | null>();
  for (const l of layouts) {
    byEnv.set(l.env, l);
    infos.set(l.env, {
      id: l.env, label: l.env, available, claude: { path: '/usr/bin/claude', version: '2.1.0', error: null },
      node: { path: 'node', version: '22.0.0' }, configDir: l.configDirHost, hooks: null, notes: available ? [] : ['Claude Code was not found.'],
    });
    commands.set(l.env, available ? { file: '/usr/bin/claude', prefixArgs: [], wslDistro: l.env.startsWith('wsl:') ? l.env.slice(4) : null } : null);
  }
  return {
    infos, layouts: byEnv, commands,
    hostEnv: () => host,
    list: async () => [...infos.values()].map((i) => structuredClone(i)),
    async layout(env) {
      const l = byEnv.get(env);
      if (!l) throw notFound('Environment');
      return structuredClone(l);
    },
    claudeCommand: async (env) => commands.get(env) ?? null,
  };
}
