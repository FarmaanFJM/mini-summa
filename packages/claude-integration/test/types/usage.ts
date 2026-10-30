// Compile-time proof that src/index.d.ts is usable the way the Mini-Summa core and desktop app use the package.
// It is never executed: `npm run typecheck` compiles it against the declarations only (allowJs is off), so every line
// here must type-check, and every `@ts-expect-error` line must be an error, or the typecheck fails.
import {
  Reducer, replay, LABELS,
  Store, ingestSpoolFiles, pendingSpoolFiles,
  createRegistry, canonicalize, detectEnv, loadRegistry, normPath,
  parseMarker, REPORT_INSTRUCTION, PROTOCOL_VERSION,
  takeSnapshot, tidOfSpoolName,
  runAgentsJson, normalizeAgents, validateAgents, pidAlive, claudeBin, evaluateSeparateDiscovery, DOCUMENTED,
  hookCommand, buildSettings, layout, isNormalConfigDir, EVENTS,
  clockDomain, bootKey, markerOf, compareMarkers,
  redactDeep, redactString, limitStrings,
} from '../../src/index.js';
import type {
  AgentsSession, Candidate, ClockMarker, DerivedEvent, DiscoveryRawEntry, EnvId, HookPayload, HookTransport,
  RawEntry, RawEntryInput, RawStoreLike, Registry, ReducerEntry, ReducerSession, Report, ResolveResult,
  SessionState, SpoolHookEntry, SpoolIngestResult,
} from '../../src/index.js';

/* ---- environments, canonical paths, registry ---------------------------------------------------------------- */

const registry: Registry = createRegistry({
  defaultEnv: 'posix',
  projects: [
    { id: 'p-git', name: 'GitManager', roots: ['/w/GitManager', { env: 'wsl:Ubuntu', path: '/home/u/git' }, { path: 'C:\\Dev\\Git', env: 'win' }] },
    { id: 'p-none', name: 'No roots' },
  ],
}, { platform: 'linux', real: false });

const ubuntu = 'Ubuntu';
export const wslEnv: EnvId = `wsl:${ubuntu}`; // template literal types are accepted
export const here: EnvId = detectEnv();
export const other: EnvId = detectEnv('linux', { WSL_DISTRO_NAME: 'Debian' });
// @ts-expect-error 'linux' is a platform, not an environment id
export const notAnEnv: EnvId = 'linux';

export function resolveExample(cwd: string | undefined): string {
  const r: ResolveResult = registry.resolve(cwd, 'posix');
  switch (r.reason) {
    case 'matched': return `${r.project.id} ${r.project.name} ${r.canonical.fs} ${r.canonical.path}`;
    case 'ambiguous': return r.candidates.join(',');
    case 'unregistered_directory': return r.canonical.path;
    case 'no_cwd': return r.project === null ? 'no cwd' : 'impossible';
  }
}
export const alwaysReadable: string | undefined = registry.resolve('/x').canonical?.path; // no narrowing needed to look
export const defaultEnv: EnvId = registry.defaultEnv;
export const fromFile: Registry = loadRegistry('registry.json', { real: false });
export const c = canonicalize('C:\\Dev\\Git\\src', 'win');
export const cPath: string | undefined = c?.path;
export const cNone: null = canonicalize(undefined, 'posix') as null;
export const normalized: string | null = normPath('C:\\Dev\\X\\', 'win32');
// @ts-expect-error a registry root needs a path
createRegistry({ projects: [{ id: 'x', name: 'X', roots: [{ env: 'win' }] }] });

/* ---- raw log entries and the reducer ------------------------------------------------------------------------ */

const transport: Partial<HookTransport> = { transport_id: 't1', monotonic_ns: '10', env_id: 'posix', clock_domain: 'posix|boot:x', handler_id: 'h1' };
const payload: HookPayload = { session_id: 's1', cwd: '/w/GitManager', hook_event_name: 'SessionStart', source: 'startup', model: 'm', surprise: { any: 'thing' } };
const snapshotSessions: Array<Partial<AgentsSession>> = [{ kind: 'interactive', cwd: '/w/GitManager', startedAt: 1, pid: 1, status: 'idle', sessionId: 's1' }];

export const entries: ReducerEntry[] = [
  { seq: 1, kind: 'hook', transport, payload },
  { seq: 2, kind: 'hook', transport: {}, payload: { session_id: 's1', hook_event_name: 'Stop', last_assistant_message: 'done', background_tasks: [] } },
  { seq: 3, kind: 'discovery', transport: { env_id: 'posix' }, payload: { scope: { cwd: null }, interval: { complete: true, uncertain: [] }, sessions: snapshotSessions } },
  { seq: 4, kind: 'discovery', payload: { sessions: [] } }, // a hand-made, legacy snapshot
  { seq: 5, kind: 'discovery_error' },
];
// @ts-expect-error an entry needs a known kind
export const badEntry: ReducerEntry = { seq: 6, kind: 'other', payload: {} };

// A matcher of your own (for example database-backed) works wherever a registry is expected: the reducer only needs the
// project and the reason. This is the shape the core declares for its project registry.
interface CoreProjectRegistry {
  defaultEnv: EnvId;
  resolve(cwd: string, env?: EnvId): {
    project: { id: string; name: string } | null;
    reason: 'matched' | 'unregistered_directory' | 'ambiguous' | 'no_cwd';
    canonical?: { fs: string; path: string };
    candidates?: string[];
  };
}
export const coreRegistry: CoreProjectRegistry = registry; // the verified registry can stand in for it
export const withCoreRegistry: Reducer = replay(entries, coreRegistry);
export const withOwnMatcher: Reducer = new Reducer({ registry: { resolve: (cwd: string) => ({ project: cwd.startsWith('/w') ? { id: 'p', name: 'P' } : null, reason: 'matched' as const }) } });
// @ts-expect-error a matcher must say why a directory did (not) match
export const noReason: Reducer = new Reducer({ registry: { resolve: () => ({ project: null }) } });

export function reducerExample(log: Iterable<RawEntry>): ReadonlyMap<string, ReducerSession> {
  const reducer = new Reducer({ registry });
  for (const e of log) reducer.apply(e); // every stored entry is acceptable input
  const replayed: Reducer = replay(log, registry);
  const counters: number[] = [replayed.unattributed, replayed.ordering_ambiguous, replayed.stale_listings, replayed.discovery_errors, replayed.duplicates.length];
  void counters;
  for (const logical of replayed.logical.values()) { const basis: 'native' | 'occurrence' = logical.basis; void basis; }
  for (const snap of replayed.snapshots.values()) { const unc: Set<string> = snap.uncertain; void unc; }
  for (const dup of replayed.duplicates) { const of: number = dup.duplicate_of_seq; void of; }
  // @ts-expect-error the reducer's collections are not meant to be replaced
  replayed.sessions = new Map();
  return replayed.sessions;
}

export function sessionExample(s: ReducerSession): string {
  const state: SessionState = s.state;
  const label: string = s.state === 'unknown' ? 'Unknown' : LABELS[s.state];
  const phase: 'none' | 'live' | 'ended_observed' | 'lost_suspected' = s.gen.phase;
  const archived: Array<'superseded' | 'ended_observed' | 'lost_suspected'> = s.generations.map((g) => g.phase);
  // @ts-expect-error 'superseded' only exists on archived generations, never on the current one
  if (s.gen.phase === 'superseded') return 'impossible';
  const term = s.gen.term;
  const how = term === null ? 'open'
    : term.kind === 'hook_session_end' ? term.marker.env
    : term.kind === 'process_exit' ? String(term.snapshot_seq)
    : String(term.seq);
  const opened = s.gen.open?.kind === 'hook' ? s.gen.open.marker.mono : s.gen.open?.snapshot_seq;
  const proc: number | null | undefined = s.gen.proc?.pid;
  const unresolved: string[] = [...s.unresolved, ...s.generations.flatMap((g) => g.unresolved)].map((u) => `${u.hook_event}:${u.relation}:${u.why}`);
  const tasks = [...s.tasks.values()].map((t) => t.prompt_id ?? `seq ${t.started_seq}`);
  const project: string | undefined = s.project?.name;
  const observed = s.observed ? `${s.observed.kind} ${s.observed.status} ${s.observed.pid}` : '';
  const mark: ClockMarker | null = s.last_prompt_mark;
  void [state, label, phase, archived, opened, proc, unresolved, tasks, project, observed, mark, s.evidence, s.weak_identity, s.hook_seen, s.in_prev_snapshot, s.occ.size, s.current_prompt_id, s.cwd, s.project_reason];
  return how;
}

export function derivedExample(d: DerivedEvent): string {
  switch (d.kind) {
    case 'transition': return `${d.from} -> ${d.to}: ${d.label} ${d.text ?? ''} ${d.abnormal ?? false}`;
    case 'generation': return `${d.generation} ${d.why}`;
    case 'late_event': return `${d.hook_event} ${d.prompt_id ?? ''} ${d.stale_generation ?? false}`;
    case 'unresolved_ordering': return `${d.hook_event} ${d.relation} ${d.why}`;
    case 'report_ready': return `${d.report_id} ${d.declared_status} ${d.task_title} ${d.late} ${d.notify}`;
    case 'report_duplicate': return d.report_id;
    case 'session_discovered': return `${d.observed.status ?? '?'} ${d.label}`;
    case 'unhandled_event': return d.hook_event;
    default: { const exhaustive: never = d; return exhaustive; }
  }
}
export function derivedCommon(d: DerivedEvent): [string, boolean, boolean, string, number, string | undefined, string | null] {
  return [d.derived_id, d.notify, d.requires_user, d.project_name, d.raw_seq, d.label, d.project_id];
}

export function reportExample(reports: Iterable<Report>, candidates: Iterable<Candidate>): string[] {
  const out: string[] = [];
  for (const r of reports) {
    const neverVerified: false = r.verified;
    const status: 'complete' | 'partial' | 'blocked' = r.declared_status;
    out.push(`${r.report_id} ${r.source} ${status} ${r.task_title} ${r.body.length} ${r.late} ${neverVerified} ${r.has_heading}`);
    // @ts-expect-error a marker is a declaration; nothing in the types lets it become verified
    r.verified = true;
  }
  for (const k of candidates) out.push(`${k.candidate_id} ${k.reason} ${k.declared_status ?? 'none'} ${k.task_title ?? 'none'} ${k.promoted}`);
  return out;
}

/* ---- report protocol ---------------------------------------------------------------------------------------- */

export const marker = parseMarker('done\n<!-- mini-summa:report status=complete task="T" -->');
export const markerText: string = marker.valid ? `${marker.status} ${marker.task} ${marker.marker_line} ${marker.has_heading}` : marker.reason;
export const version: 1 = PROTOCOL_VERSION;
export const instruction: string = REPORT_INSTRUCTION;
export const anything = parseMarker(undefined);

/* ---- the store, the spool, and a store of your own ---------------------------------------------------------- */

export function storeExample(dir: string, spool: string): { counts: SpoolIngestResult; fresh: DerivedEvent[]; raw: RawEntry[] } {
  const store = new Store(dir);
  const counts = store.ingestSpool(spool);
  const barrier = new Set(store.pendingSpool(spool));
  const inBarrier: SpoolIngestResult = store.ingestSpool(spool, { only: barrier });
  void inBarrier;
  const reducer = replay(store.raw, registry);
  const fresh: DerivedEvent[] = store.persist(reducer);
  const promoted = store.promote('abc');
  const status: 'user_promoted' = promoted.source;
  void [status, store.torn, store.dir, store.rawPath, store.derivedPath, store.transportIds.has('x'), store.announced.size, store.loadRaw().length];
  return { counts, fresh, raw: store.raw };
}

/** What the core does: its own durable store, driven by the package's spool algorithm. */
export class MemoryStore implements RawStoreLike {
  readonly log: RawEntry[] = [];
  readonly #seen = new Set<string>();
  appendRaw(entry: RawEntryInput): RawEntry | null {
    if (entry.kind === 'hook') {
      if (this.#seen.has(entry.transport.transport_id)) return null; // already ingested
      this.#seen.add(entry.transport.transport_id);
    }
    const stored: RawEntry = { seq: this.log.length + 1, ingested_at: new Date().toISOString(), ...entry };
    this.log.push(stored);
    return stored;
  }
  pendingSpool(spoolDir: string): string[] { return pendingSpoolFiles(spoolDir); }
  ingestSpool(spoolDir: string, opts?: { only?: ReadonlySet<string> }): SpoolIngestResult {
    return ingestSpoolFiles(spoolDir, opts, (entry: SpoolHookEntry) => this.appendRaw(entry));
  }
}

export function spoolExample(spool: string, insert: (e: SpoolHookEntry) => { rowid: number } | null): SpoolIngestResult {
  const pending: string[] = pendingSpoolFiles(spool);
  const result = ingestSpoolFiles(spool, undefined, insert);
  const barrier = ingestSpoolFiles(spool, { only: new Set(pending) }, insert);
  const viaEntry = ingestSpoolFiles(spool, {}, (entry) => (entry.payload.session_id === undefined ? null : { stored: entry.transport.transport_id }));
  void [barrier, viaEntry];
  // @ts-expect-error the callback must return the stored entry or null: undefined would be counted as "already ingested"
  ingestSpoolFiles(spool, undefined, () => {});
  // @ts-expect-error the callback is required
  ingestSpoolFiles(spool, undefined);
  return result;
}

/* ---- discovery ---------------------------------------------------------------------------------------------- */

export async function snapshotExample(store: RawStoreLike, spool: string): Promise<DiscoveryRawEntry> {
  const { entry, sessions, raw } = await takeSnapshot({ store, spools: [spool], envId: 'posix', run: async () => ({ raw: [] }), scopeCwd: null, remote: false });
  const first: AgentsSession | undefined = sessions[0];
  const alive: boolean | null | undefined = first?.pid_alive;
  const uncertain: string[] = entry.payload.interval.uncertain.map(tidOfSpoolName);
  void [raw, alive, uncertain, entry.payload.scope.cwd, entry.payload.interval.drained, entry.seq, entry.ingested_at];
  const real = await takeSnapshot({ store, envId: 'wsl:Ubuntu', run: runAgentsJson, runOpts: { wslDistro: 'Ubuntu', configDir: '/home/u/.claude-x', timeoutMs: 5000 }, remote: true });
  void real;
  return entry;
}
export async function runExample(): Promise<void> {
  const { raw, args, file } = await runAgentsJson({ configDir: 'cfg', cwd: '/w', all: true, wslDistro: 'Ubuntu', timeoutMs: 1000, bin: 'claude' });
  const agents = normalizeAgents(raw); // throws unless raw is an array
  const report = Array.isArray(raw) ? validateAgents(raw) : null; // `raw` is unknown until narrowed
  const keys: string[] = (report?.undocumented_keys ?? []).concat(agents.flatMap((a) => a._extra_keys), args, [file]);
  const kind: string | null | undefined = agents[0]?.kind;
  void [keys, kind, report?.count, report?.missing_always.map((m) => m.field), report?.kinds.interactive, report?.key_presence.cwd, report?.no_sessionId];
}
export const alive: boolean | null = pidAlive(process.pid, { remote: false });
export const bin: string = claudeBin({ MINI_SUMMA_CLAUDE_BIN: 'x' }, 'linux');
export const q18 = evaluateSeparateDiscovery({ win: [], wsl: new Error('wsl.exe exited 1'), expect: { win: 'id' } });
export const q18status: 'PASS' | 'FAIL' | 'NOT TESTED' = q18.status;
export const documented: boolean = DOCUMENTED.always.includes('cwd');
export const spoolTid: string = tidOfSpoolName('00000000000000001000-abc.json');

/* ---- hook registration -------------------------------------------------------------------------------------- */

const base = { env: 'win' as const, node: 'C:\\Program Files\\MiniSumma\\MiniSumma.exe', capture: 'C:\\x\\capture.mjs', spool: 'C:\\x\\spool', registry: 'C:\\x\\registry.json' };
export const hook = hookCommand({ ...base, handler: 'h1', event: 'Stop', runAsNode: true });
export const hookShell: 'powershell' | undefined = hook.shell;
export const hookText: string = `${hook.type} ${hook.timeout} ${hook.command}`;
export const settings = buildSettings({ ...base, env: 'posix', node: '/usr/bin/node', handlers: ['h1', 'h2'], runAsNode: false });
export const stopCommand: string = settings.hooks.Stop[0].hooks[0].command;
export const everyEvent: string[] = EVENTS.map((ev) => settings.hooks[ev][0].hooks[0].command);
export const laid = layout({ env: 'wsl:Ubuntu', base: '/home/u/.x', shared: '/mnt/c/P' });
export const spoolDir: string = laid.spool;
export const normalDir: boolean = isNormalConfigDir('/home/u/.claude', ['/home/u', undefined, null], process.env.CLAUDE_CONFIG_DIR);
hookCommand({
  ...base, handler: 'h1', event: 'Stop',
  // @ts-expect-error runAsNode is a boolean
  runAsNode: 'yes',
});
buildSettings({
  ...base,
  // @ts-expect-error env must be an environment id
  env: 'linux',
});

/* ---- clocks and redaction ----------------------------------------------------------------------------------- */

const earlier: ClockMarker = markerOf({ transport_id: 'a', env_id: 'posix', clock_domain: 'D', monotonic_ns: '1' });
export const relation: 'after' | 'before' | 'uncertain' = compareMarkers(earlier, markerOf({ monotonic_ns: '2' }));
export const domain: string | null = clockDomain('posix', 'linux', () => 'boot-id');
export const boot: string | null = bootKey();

const counter = { n: 0 };
export const redacted = redactDeep({ api_key: 'k', note: 'ok', nested: { list: ['a'] } }, counter);
export const redactedNote: string = redacted.note;
export const redactedText: string = redactString('text', counter);
export const limited = limitStrings({ a: 'x'.repeat(10) }, 5, { n: 0, bytes_dropped: 0 });
