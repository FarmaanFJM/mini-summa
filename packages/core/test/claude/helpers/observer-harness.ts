// A wired-up observer for the tests: in-memory SQLite, temp directories, fake projects/settings/managed manager, the
// real sessions service, and collectors for everything it hands to subscribers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RawEntryInput } from '@minisumma/claude-integration';
import type { EnvId, SessionKey, SessionView } from '@minisumma/shared';
import { openDatabase } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import { createEventBus } from '../../../src/bus.ts';
import type {
  CapturedCandidate, CapturedReport, ClaudeDerivedEvent, Clock, CoreBase, EnvLayout, EnvironmentsService, EventBus, Logger, PermissionRequestInfo,
} from '../../../src/contracts.ts';
import { systemClock } from '../../../src/contracts.ts';
import { createEnvironmentsService } from '../../../src/claude/environments.ts';
import type { CommandRunner } from '../../../src/claude/commandRunner.ts';
import { envTag } from '../../../src/claude/envPaths.ts';
import type { AgentsRunner } from '../../../src/claude/discovery.ts';
import { createRawStore } from '../../../src/claude/rawStore.ts';
import type { RawStore } from '../../../src/claude/rawStore.ts';
import { createSessionsService } from '../../../src/claude/sessions.ts';
import type { ObserverSessionsService } from '../../../src/claude/sessions.ts';
import { createFakeManaged, createFakeProjects, createFakeSettings, createStubEnvironments } from './observer-fakes.ts';
import type { FakeManaged, FakeProjects, FakeSettings } from './observer-fakes.ts';
import { CAPTURE_SRC } from './observer-hook.ts';

export interface CollectingLogger extends Logger {
  entries: { level: string; msg: string; data?: Record<string, unknown> }[];
  count(level: string): number;
}

export function collectingLogger(): CollectingLogger {
  const entries: CollectingLogger['entries'] = [];
  const mk = (level: string) => (msg: string, data?: Record<string, unknown>) => { entries.push({ level, msg, data }); };
  return { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), entries, count: (level) => entries.filter((e) => e.level === level).length };
}

export interface HarnessOptions {
  hostEnv?: EnvId;
  clock?: Clock;
  dir?: string;
  db?: Db;
  bus?: EventBus;
  projects?: FakeProjects;
  managed?: FakeManaged;
  settings?: FakeSettings;
  /** Use the real EnvironmentsService (with a fake command runner and a fake claude file) instead of a stub. */
  realEnvironments?: boolean;
  /** A ready environments service, or a function that builds one around the harness's own layout. */
  environments?: EnvironmentsService | ((layout: EnvLayout) => EnvironmentsService);
  run?: AgentsRunner;
  /** 0 (default) = no automatic polling; tests call flush(). */
  spoolPollMs?: number;
  /** 0 (default) = no automatic discovery; tests call refreshDiscovery(). */
  discoveryIntervalMs?: number;
  /** The core's environment variables as discovery sees them (CLAUDE_CONFIG_DIR). Default: none. */
  sessionsEnv?: Record<string, string | undefined>;
  captureScript?: string;
  /** Call sessions.init() (default true). */
  init?: boolean;
  /** Subscribe the collectors before init so replayed events are collected too (default true). */
  collect?: boolean;
}

export interface Collected {
  derived: ClaudeDerivedEvent[];
  /** Every onPermissionRequest call, with the view that was handed over with it. */
  permissions: { info: PermissionRequestInfo; view: SessionView }[];
  reports: CapturedReport[];
  candidates: CapturedCandidate[];
  sessionChanges: { view: SessionView; previous: SessionView | null }[];
  busUpserts: SessionView[];
}

export interface Harness {
  dir: string;
  dataDir: string;
  hostEnv: EnvId;
  db: Db;
  bus: EventBus;
  base: CoreBase;
  log: CollectingLogger;
  projects: FakeProjects;
  settings: FakeSettings;
  managed: FakeManaged;
  environments: EnvironmentsService;
  rawStore: RawStore;
  sessions: ObserverSessionsService;
  collected: Collected;
  layout: EnvLayout;
  /** Appends raw entries and applies them. */
  feed(entries: RawEntryInput[]): Promise<void>;
  view(key: SessionKey): SessionView;
  cleanup(): Promise<void>;
}

export const keyOf = (env: EnvId, sessionId: string): SessionKey => `${env}|${sessionId}` as SessionKey;

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const hostEnv = opts.hostEnv ?? 'posix';
  const ownsDir = !opts.dir;
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ms-observer-'));
  const dataDir = path.join(dir, 'data');
  const db = opts.db ?? openDatabase(':memory:').db;
  const bus = opts.bus ?? createEventBus();
  const clock = opts.clock ?? systemClock;
  const log = collectingLogger();
  const base: CoreBase = { db, bus, clock, log, version: 'test', mode: 'headless', dataDir };
  const projects = opts.projects ?? createFakeProjects({ bus, db, defaultEnv: hostEnv === 'win' ? 'win' : 'posix' });
  const settings = opts.settings ?? createFakeSettings();
  const managed = opts.managed ?? createFakeManaged({ db, clock });
  const captureScript = opts.captureScript ?? CAPTURE_SRC;

  const layout: EnvLayout = {
    env: hostEnv, spoolDirHost: path.join(dataDir, 'spool', envTag(hostEnv)), registryFileHost: path.join(dataDir, 'registry.json'),
    spoolDirInEnv: path.join(dataDir, 'spool', envTag(hostEnv)), registryFileInEnv: path.join(dataDir, 'registry.json'),
    captureScriptInEnv: captureScript, runtime: { command: process.execPath, runAsNode: false, version: process.versions.node },
    configDirHost: path.join(dir, 'home', '.claude'), configDirInEnv: path.join(dir, 'home', '.claude'),
  };

  let environments: EnvironmentsService;
  if (typeof opts.environments === 'function') environments = opts.environments(layout);
  else if (opts.environments) environments = opts.environments;
  else if (opts.realEnvironments) {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', { mode: 0o755 });
    const run: CommandRunner = async (file, args) => (/claude$/.test(file) && args[0] === '--version'
      ? { stdout: '2.1.0 (Claude Code)\n', stderr: '', code: 0 }
      : { stdout: '', stderr: 'unexpected command', code: 1 });
    environments = createEnvironmentsService({
      base, settings, run,
      overrides: { hostEnv, captureScript, nodeRuntime: { command: process.execPath, runAsNode: false }, homeDir: path.join(dir, 'home') },
      host: { platform: 'linux', env: { PATH: bin } },
    });
  } else {
    environments = createStubEnvironments(hostEnv, [layout]);
  }

  const collected: Collected = { derived: [], permissions: [], reports: [], candidates: [], sessionChanges: [], busUpserts: [] };
  const rawStore = createRawStore(db, clock);
  const sessions = createSessionsService({
    base, settings, projects, environments, managed, rawStore, run: opts.run, env: opts.sessionsEnv ?? {},
    overrides: { hostEnv, spoolPollMs: opts.spoolPollMs ?? 0, discoveryIntervalMs: opts.discoveryIntervalMs ?? 0, captureScript },
  });
  const offBus = bus.subscribe((_seq, event) => { if (event.type === 'session.upserted') collected.busUpserts.push(event.session); });
  let offSessions = (): void => {};
  if (opts.collect !== false) {
    offSessions = sessions.subscribe({
      onDerived: (event) => { collected.derived.push(event); },
      onPermissionRequest: (info, view) => { collected.permissions.push({ info, view: structuredClone(view) }); },
      onReport: (report) => { collected.reports.push(report); },
      onCandidate: (candidate) => { collected.candidates.push(candidate); },
      onSession: (view, previous) => { collected.sessionChanges.push({ view, previous }); },
    });
  }
  if (opts.init !== false) await sessions.init();

  const harness: Harness = {
    dir, dataDir, hostEnv, db, bus, base, log, projects, settings, managed, environments, rawStore, sessions, collected, layout,
    async feed(entries) {
      for (const e of entries) {
        if (!rawStore.appendRaw(e) && e.kind === 'hook') throw new Error(`entry was a duplicate receipt: ${e.transport.transport_id}`);
      }
      await sessions.flush();
    },
    view(key) {
      const v = sessions.get(key);
      if (!v) throw new Error(`no view for ${key}`);
      return v;
    },
    async cleanup() {
      offBus();
      offSessions();
      await sessions.shutdown();
      if (ownsDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** A layout for another environment under the same data directory (for tests with several environments). */
export function layoutFor(h: Pick<Harness, 'dataDir' | 'dir'>, env: EnvId): EnvLayout {
  const tag = envTag(env);
  return {
    env, spoolDirHost: path.join(h.dataDir, 'spool', tag), registryFileHost: path.join(h.dataDir, 'registry.json'),
    spoolDirInEnv: path.join(h.dataDir, 'spool', tag), registryFileInEnv: path.join(h.dataDir, 'registry.json'),
    captureScriptInEnv: CAPTURE_SRC, runtime: { command: 'node', runAsNode: false, version: '22.0.0' },
    configDirHost: null, configDirInEnv: null,
  };
}
