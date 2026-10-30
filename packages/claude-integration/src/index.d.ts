// Hand-written declarations for @minisumma/claude-integration (src/index.js).
//
// Every shape below was read off the code in src/lib and src/hook, not guessed. Claude Code's hook payloads and the
// `claude agents --json` schema are not versioned, so those types describe what was observed and always allow unknown
// extra fields. test/types/usage.ts is compiled by `npm run typecheck`; test/api.test.mjs checks that this file declares
// exactly the names src/index.js exports.

/* ----------------------------------------------------------------------------------------------------------------- */
/* Environments and paths                                                                                            */
/* ----------------------------------------------------------------------------------------------------------------- */

/**
 * The file-system namespace a process, session or path belongs to: native Windows, plain Linux or macOS, or one WSL
 * distribution. Native Windows and WSL2 are different environments and are never compared with each other.
 */
export type EnvId = 'win' | 'posix' | `wsl:${string}`;

/** A reducer session's environment. `local` is used for entries recorded without an `env_id`. */
export type SessionEnv = EnvId | 'local';

/** A directory in canonical form: the namespace it lives in, and its normalized path (Windows paths lower-cased). */
export interface CanonicalPath {
  fs: EnvId;
  path: string;
}

export interface CanonicalizeOptions {
  /** WSL automount root, default `/mnt/`. `/mnt/c/Dev` inside WSL is the Windows directory `c:\dev`. */
  automount?: string;
}

/** Name of the environment this process runs in. `platform` and `env` default to `process.platform` / `process.env`. */
export function detectEnv(platform?: string, env?: Record<string, string | undefined>): EnvId;

/** Canonical form of a path as seen from `env`, or `null` for a missing or empty path. */
export function canonicalize(p: string | null | undefined, env: EnvId, opts?: CanonicalizeOptions): CanonicalPath | null;

/** Back-compat helper: the canonical path string for the native environment of `platform`, or `null`. */
export function normPath(p: string | null | undefined, platform?: string): string | null;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Project registry                                                                                                  */
/* ----------------------------------------------------------------------------------------------------------------- */

/** What a registered project looks like to the rest of the system. */
export interface RegistryProject {
  id: string;
  name: string;
}

/** A project root: a bare path (in the registry's default environment) or a path with its environment. */
export interface RegistryRootSpec {
  path: string;
  env?: EnvId;
}

export interface RegistryProjectConfig {
  id: string;
  name: string;
  roots?: ReadonlyArray<string | RegistryRootSpec>;
}

/** The content of a registry file (`registry.json`). */
export interface RegistryConfig {
  /** Environment of bare-string roots. Defaults to the environment this process runs in. */
  defaultEnv?: EnvId;
  /** WSL automount root, default `/mnt/`. */
  automount?: string;
  projects?: ReadonlyArray<RegistryProjectConfig>;
}

export interface CreateRegistryOptions {
  /** Test seam: `'win32'` makes `win` the native environment, any other value makes it `posix`. */
  platform?: string;
  /** Resolve symlinks of native-environment paths through the real file system. Default `true`; tests pass `false`. */
  real?: boolean;
}

/**
 * Outcome of mapping a working directory to a project. It is never a guess: a directory that matches no root, or two
 * different projects at the same depth, leaves `project` null with the reason.
 */
export type ResolveResult =
  | { project: RegistryProject; reason: 'matched'; canonical: CanonicalPath; candidates?: undefined }
  | { project: null; reason: 'no_cwd'; canonical?: undefined; candidates?: undefined }
  | { project: null; reason: 'unregistered_directory'; canonical: CanonicalPath; candidates?: undefined }
  | { project: null; reason: 'ambiguous'; candidates: string[]; canonical?: undefined };

export interface Registry {
  /** Environment assumed when `resolve` is called without one. */
  readonly defaultEnv: EnvId;
  /** The longest matching root wins, by path segment (not by string prefix). */
  resolve(cwd: string | null | undefined, env?: EnvId): ResolveResult;
}

/**
 * The only thing the reducer needs from a registry: a project and the reason for it. The full {@link Registry} satisfies
 * this, and so does any matcher of your own (for example one backed by a database) that returns at least these two fields.
 */
export interface RegistryResolver {
  resolve(cwd: string, env?: EnvId): { project: RegistryProject | null; reason: ProjectReason };
}

export function createRegistry(config: RegistryConfig, opts?: CreateRegistryOptions): Registry;
/** Reads and parses a registry file. Throws if the file is missing or is not JSON. */
export function loadRegistry(file: string, opts?: CreateRegistryOptions): Registry;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Hook payloads and transport metadata                                                                              */
/* ----------------------------------------------------------------------------------------------------------------- */

/** The nine events Mini-Summa registers. */
export const EVENTS: readonly [
  'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'StopFailure', 'SessionEnd',
];
export type HookEventName = (typeof EVENTS)[number];

/**
 * The JSON Claude Code writes to a hook's stdin, after redaction. Only the fields the reducer reads are listed; unknown
 * fields are kept and ignored. When stdin was not valid JSON the payload is `{ unparsed_stdin_prefix }` instead.
 */
export interface HookPayload {
  session_id?: string;
  /** Usually one of {@link HookEventName}; `PostToolUseFailure` is understood too, anything else is "unhandled". */
  hook_event_name?: HookEventName | 'PostToolUseFailure' | (string & {});
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  /** Identifies one user prompt (a task). Not sent before the first prompt. */
  prompt_id?: string;
  prompt?: string;
  /** SessionStart. `startup`, `resume` and `fork` start a new process; `clear` and `compact` happen inside a live one. */
  source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | (string & {});
  model?: string;
  /** SessionEnd. */
  reason?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** Native id of a tool call (PreToolUse, PostToolUse, PostToolUseFailure). */
  tool_use_id?: string;
  notification_type?: 'permission_prompt' | 'idle_prompt' | 'elicitation_dialog' | 'elicitation_url_dialog' | (string & {});
  message?: string;
  title?: string;
  stop_hook_active?: boolean;
  /** Stop and StopFailure. Never truncated by the capture script; like every string it is redacted if it contains a token-shaped value. */
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
  /** StopFailure. */
  error?: string;
  error_details?: string;
  /** Present only when the hook's stdin was not valid JSON. */
  unparsed_stdin_prefix?: string;
  [field: string]: unknown;
}

/**
 * Metadata the capture script adds around a payload. Records written by an older capture lack `handler_id`, `env_id`
 * and `clock_domain` (see examples/captured-hooks); the reducer treats them as absent.
 */
export interface HookTransport {
  /** One id per hook process invocation: the identity of a receipt. */
  transport_id: string;
  received_at: string;
  wall_ms: number;
  /** `process.hrtime.bigint()` as a decimal string. Comparable only inside one `clock_domain`. */
  monotonic_ns: string;
  capture_version: number;
  /** The event name the hook was registered with (last command-line argument). */
  hook_arg: string | null;
  /** Names one registration of the hook, so two registrations can be told from two real identical events. */
  handler_id: string | null;
  env_id: EnvId;
  /** `<env>|boot:<boot id>` on Linux and WSL, `null` where no monotonic clock can be vouched for (Windows, macOS). */
  clock_domain: string | null;
  pid: number;
  ppid: number;
  platform: string;
  claude_project_dir: string | null;
  claude_config_dir: string | null;
  claude_code_remote: string | null;
  /** How many values were redacted (never which). */
  redactions: number;
  truncations: number;
  truncated_chars: number;
  parse_error: string | null;
}

/** The content of one spool file, exactly as the hook writes it. */
export interface SpoolRecord {
  schema: 'mini-summa.spool/1';
  transport: HookTransport;
  payload: HookPayload;
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Discovery (`claude agents --json`)                                                                                */
/* ----------------------------------------------------------------------------------------------------------------- */

/** Documented fields of `claude agents --json` (code.claude.com/docs/en/agent-view). */
export const DOCUMENTED: {
  readonly always: readonly string[];
  readonly background_only: readonly string[];
  readonly while_alive: readonly string[];
  readonly conditional: readonly string[];
};

export type AgentKind = 'interactive' | 'background' | (string & {});
export type AgentStatus = 'idle' | 'busy' | 'waiting' | (string & {});

/** One entry of `claude agents --json` with every optional field made explicit (`null`). */
export interface NormalizedAgent {
  kind: AgentKind | null;
  cwd: string | null;
  /** Epoch milliseconds, as observed on Claude Code 2.1.314. */
  startedAt: number | null;
  /** Background sessions only. */
  id: string | null;
  /** Background sessions only. */
  state: string | null;
  /** Present while the process is alive. */
  pid: number | null;
  /** Present while the process is alive. */
  status: AgentStatus | null;
  /** For example `permission prompt`. */
  waitingFor: string | null;
  sessionId: string | null;
  name: string | null;
  /** Keys of the raw entry that are not documented. */
  _extra_keys: string[];
}

/** A normalized entry as recorded in a snapshot: plus the same-host liveness hint, minus `_extra_keys`. */
export interface AgentsSession extends Omit<NormalizedAgent, '_extra_keys'> {
  /** `true`/`false` when the pid could be checked on this host, `null` when it cannot (another OS, or inside WSL). */
  pid_alive: boolean | null;
}

export interface AgentsValidationReport {
  count: number;
  missing_always: Array<{ index: number; field: string }>;
  undocumented_keys: string[];
  no_sessionId: number;
  kinds: Record<string, number>;
  key_presence: Record<string, number>;
}

export interface RunAgentsJsonOptions {
  /** Sets `CLAUDE_CONFIG_DIR` for the call. */
  configDir?: string;
  /** `--cwd`: only sessions in this directory. A scoped listing never causes "presence lost". */
  cwd?: string;
  /** `--all`. */
  all?: boolean;
  /** Run inside this WSL distribution through `wsl.exe`; the answer then describes WSL sessions only. */
  wslDistro?: string;
  /** Default 20000. */
  timeoutMs?: number;
  /**
   * Executable to run instead of `claudeBin()`. On Windows a `.cmd` or `.bat` shim (what an npm install of Claude Code
   * is) is started through `cmd.exe /d /s /c` with every part quoted, so a path or `cwd` with spaces works. A `cwd` or
   * shim path containing a double quote, `%`, `!` or a control character is rejected there. Not tested on Windows.
   */
  bin?: string;
}

export interface RunAgentsJsonResult {
  /** The parsed JSON the command printed (expected to be an array of agent entries). */
  raw: unknown;
  args: string[];
  file: string;
}

/** What `runAgentsJson` rejects with when the process fails; plain `Error` when the output is not JSON. */
export interface AgentsCommandError extends Error {
  stderr?: string;
}

/** Runs `claude agents --json`. Rejects if the process fails, times out, or prints something that is not JSON. */
export function runAgentsJson(opts?: RunAgentsJsonOptions): Promise<RunAgentsJsonResult>;
/** Throws unless `json` is an array. Optional fields are never assumed to exist. */
export function normalizeAgents(json: unknown): NormalizedAgent[];
/** Field validation of a raw listing against what the installed CLI actually prints. Expects an array (it throws on anything else). */
export function validateAgents(json: ReadonlyArray<object>): AgentsValidationReport;
/** Same-host liveness hint. `null` means it cannot be checked (`remote: true`, or no integer pid). */
export function pidAlive(pid: number | null | undefined, opts?: { remote?: boolean }): boolean | null;
/** `MINI_SUMMA_CLAUDE_BIN`, else `claude.exe` on Windows and `claude` elsewhere. */
export function claudeBin(env?: Record<string, string | undefined>, platform?: string): string;

export interface SeparateDiscoveryInput {
  /** The `agents --json` array from native Windows, or the `Error` the query failed with. Anything else is a FAIL. */
  win: unknown;
  /** The same for one WSL distribution. */
  wsl: unknown;
  /** Session ids the operator started in each environment. */
  expect?: { win?: string; wsl?: string };
}
export type SeparateDiscoveryStatus = 'PASS' | 'FAIL' | 'NOT TESTED';
/** Qualification check Q18: do native Windows and one WSL distribution discover their sessions separately? */
export function evaluateSeparateDiscovery(input: SeparateDiscoveryInput): { status: SeparateDiscoveryStatus; notes: string[] };

/* ----------------------------------------------------------------------------------------------------------------- */
/* Raw log                                                                                                           */
/* ----------------------------------------------------------------------------------------------------------------- */

export type RawKind = 'hook' | 'discovery' | 'discovery_error';

/** Transport metadata of an entry that did not come from a hook process (discovery snapshots and their errors). */
export interface DiscoveryTransport {
  received_at: string;
  wall_ms: number;
  env_id: EnvId;
}

/**
 * How a snapshot classified hook receipts against the whole `claude agents --json` call. `uncertain` lists the
 * transport ids of receipts that landed while the call was in flight: they may be before or after what it observed.
 */
export interface SnapshotInterval {
  complete: boolean;
  /** Spool files present when the call started. */
  before_files: number;
  /** How many of those were newly ingested ahead of the snapshot. */
  drained: number;
  uncertain: string[];
}

/** Payload of a `discovery` entry. */
export interface DiscoverySnapshotPayload {
  /** `cwd` is null for a full listing; a scoped listing proves nothing about sessions elsewhere. */
  scope: { cwd: string | null };
  interval: SnapshotInterval;
  sessions: AgentsSession[];
}

/** Payload of a `discovery_error` entry: a failed or interrupted call observed nothing. */
export interface DiscoveryErrorPayload {
  message: string;
  /** Spool files that were pending when the call started. */
  pending_before: number;
}

/** An entry as handed to {@link RawStoreLike.appendRaw} (before the store adds `seq` and `ingested_at`). */
export interface HookRawEntryInput { kind: 'hook'; transport: HookTransport; payload: HookPayload }
export interface DiscoveryRawEntryInput { kind: 'discovery'; transport: DiscoveryTransport; payload: DiscoverySnapshotPayload }
export interface DiscoveryErrorRawEntryInput { kind: 'discovery_error'; transport: DiscoveryTransport; payload: DiscoveryErrorPayload }
export type RawEntryInput = HookRawEntryInput | DiscoveryRawEntryInput | DiscoveryErrorRawEntryInput;

/** The fields a store adds when it appends. */
export interface StoredFields {
  /** 1-based position in the log. */
  seq: number;
  /** ISO time of the append. Nothing derives order from it. */
  ingested_at: string;
}
/** One line of the append-only raw log. The raw log is never rewritten or pruned. */
export interface HookRawEntry extends HookRawEntryInput, StoredFields {}
export interface DiscoveryRawEntry extends DiscoveryRawEntryInput, StoredFields {}
export interface DiscoveryErrorRawEntry extends DiscoveryErrorRawEntryInput, StoredFields {}
export type RawEntry = HookRawEntry | DiscoveryRawEntry | DiscoveryErrorRawEntry;

/**
 * What the reducer actually reads from an entry. Hand-made logs and old captures may omit `ingested_at` and most of the
 * transport, and a snapshot may lack `scope` and `interval`; every {@link RawEntry} is assignable to this.
 */
export type ReducerEntry =
  | { seq: number; ingested_at?: string; kind: 'hook'; transport?: Partial<HookTransport>; payload?: HookPayload }
  | { seq: number; ingested_at?: string; kind: 'discovery'; transport?: Partial<DiscoveryTransport>; payload: ReducerSnapshotPayload }
  | { seq: number; ingested_at?: string; kind: 'discovery_error'; transport?: Partial<DiscoveryTransport>; payload?: Partial<DiscoveryErrorPayload> };

/** A snapshot payload as the reducer tolerates it. Without `interval`, every later hook is "uncertain" relative to it. */
export interface ReducerSnapshotPayload {
  scope?: { cwd?: string | null };
  interval?: Partial<SnapshotInterval>;
  sessions: ReadonlyArray<Partial<AgentsSession>>;
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Spool                                                                                                             */
/* ----------------------------------------------------------------------------------------------------------------- */

/** The entry {@link ingestSpoolFiles} hands to its `appendRaw` callback. */
export interface SpoolHookEntry {
  kind: 'hook';
  transport: HookTransport;
  payload: HookPayload;
}

export interface IngestSpoolOptions {
  /** The barrier set: only these file names are read or moved. An empty set admits nothing. */
  only?: ReadonlySet<string>;
}

export interface SpoolIngestResult {
  /** Newly stored receipts. */
  ingested: number;
  /** Receipts the store already had (same `transport_id`). Their files are still moved to `done/`. */
  already_ingested: number;
  /**
   * Files this pass moved to `quarantine/` untouched: anything that is not a `mini-summa.spool/1` record, and a record that
   * names a clock domain but whose `monotonic_ns` is not a decimal integer (it cannot be ordered, and would otherwise make
   * every pass fail). A file another ingestor moved away first is skipped and counted nowhere.
   */
  quarantined: number;
}

/** Names of the `*.json` files waiting in a spool directory, sorted. Dotfiles (the hook's temp files) are ignored. */
export function pendingSpoolFiles(spoolDir: string): string[];

/**
 * Ingests the pending files of one spool directory through `appendRaw`: parse and validate, quarantine anything that is
 * not a `mini-summa.spool/1` record (or whose `monotonic_ns` is not a decimal integer while a clock domain is named),
 * order by monotonic clock inside one clock domain (otherwise by file name), append, then move each file to `done/`.
 * A file that another ingestor has already moved (ENOENT) is skipped; any other file-system error propagates.
 *
 * `appendRaw` runs synchronously. It must return the stored entry (any truthy value) for a new receipt and `null` for one
 * it already has: a falsy result is counted as already ingested, so a callback that forgets to return anything is
 * rejected by the types. If it throws, the failing file stays pending and the error propagates. Pass `undefined` for
 * `opts` to ingest everything pending.
 */
export function ingestSpoolFiles(
  spoolDir: string,
  opts: IngestSpoolOptions | undefined,
  appendRaw: (entry: SpoolHookEntry) => {} | null,
): SpoolIngestResult;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Store                                                                                                             */
/* ----------------------------------------------------------------------------------------------------------------- */

/**
 * The part of a durable store that {@link takeSnapshot} needs. {@link Store} implements it over files; the Mini-Summa
 * core implements it over SQLite using {@link ingestSpoolFiles} and {@link pendingSpoolFiles}.
 */
export interface RawStoreLike {
  /** Idempotent per `transport.transport_id`: returns `null` when that receipt is already stored. */
  appendRaw(entry: RawEntryInput): RawEntry | null;
  /** File names currently pending in a spool directory (builds the barrier). */
  pendingSpool(spoolDir: string): string[];
  ingestSpool(spoolDir: string, opts?: IngestSpoolOptions): SpoolIngestResult;
}

/** What {@link Store.persist} reads from a reducer. */
export type PersistableReducer = Pick<Reducer, 'reports' | 'candidates' | 'derived'>;

/** A candidate promoted to a report by the user (`Store.promote`). */
export interface PromotedReport extends ReportBase {
  report_id: string;
  source: 'user_promoted';
  declared_status: DeclaredStatus | null;
  task_title: string | null;
  /** Copied from the candidate as it was read, so it is `false` even in the promoted report file. */
  promoted: boolean;
  verified: false;
  note: string;
}

/**
 * Durable store under one directory: append-only `raw.jsonl` (fsynced per append), `derived.jsonl` (events already
 * announced), `reports/<id>.json` and `candidates/<id>.json`.
 */
export class Store implements RawStoreLike {
  constructor(dir: string);
  readonly dir: string;
  readonly rawPath: string;
  readonly derivedPath: string;
  /** Unparsable lines skipped while loading (a torn final line after a crash). They are skipped, never deleted. */
  torn: number;
  /** Every stored entry, in log order. */
  raw: RawEntry[];
  /** The persisted set of receipt ids. */
  transportIds: Set<string>;
  /** `derived_id`s already announced, so a restart does not announce them again. */
  announced: Set<string>;
  loadRaw(): RawEntry[];
  appendRaw(entry: RawEntryInput): RawEntry | null;
  pendingSpool(spoolDir: string): string[];
  ingestSpool(spoolDir: string, opts?: IngestSpoolOptions): SpoolIngestResult;
  /** Writes new reports and candidates and returns the derived events not announced before (restart-safe). */
  persist(reducer: PersistableReducer): DerivedEvent[];
  /** Manual promotion of a preserved non-marker message to a report: a user decision. */
  promote(candidateId: string): PromotedReport;
}

/* ----------------------------------------------------------------------------------------------------------------- */
/* Snapshots                                                                                                         */
/* ----------------------------------------------------------------------------------------------------------------- */

/** The transport id inside a spool file name `<monotonic>-<transport id>.json`; the name itself if it does not fit. */
export function tidOfSpoolName(name: string): string;

export interface TakeSnapshotOptions {
  store: RawStoreLike;
  /** Spool directories to drain ahead of the snapshot and to scan for the interval. */
  spools?: readonly string[];
  envId: EnvId;
  /** Replaces `runAgentsJson` (tests, or a remote runner). It is called with `runOpts` and `cwd: scopeCwd`. */
  run?: (opts: RunAgentsJsonOptions) => Promise<{ raw: unknown }>;
  runOpts?: RunAgentsJsonOptions;
  /** Limits the listing to one directory. A scoped snapshot never causes "presence lost". */
  scopeCwd?: string | null;
  /** The listing comes from another OS (a WSL distribution seen from Windows): pid liveness is then unknown. */
  remote?: boolean;
}

export interface TakeSnapshotResult {
  /** The stored `discovery` entry. */
  entry: DiscoveryRawEntry;
  sessions: AgentsSession[];
  /** The parsed output of the command, before normalization. */
  raw: unknown;
}

/**
 * Runs one discovery call and records it as an interval: hooks already pending are ingested first, hooks that land while
 * the call is in flight are listed in `interval.uncertain`. If `run` fails or is interrupted, or its output is not a
 * listing (not an array, or an entry that is not an object), it appends one `discovery_error` (no snapshot, so nothing is
 * inferred as gone, and the spool is left undrained) and rejects with the error.
 */
export function takeSnapshot(opts: TakeSnapshotOptions): Promise<TakeSnapshotResult>;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Clock domains                                                                                                     */
/* ----------------------------------------------------------------------------------------------------------------- */

/** Identity of one hook receipt for ordering purposes. */
export interface ClockMarker {
  tid: string | null;
  env: SessionEnv;
  domain: string | null;
  /** Monotonic nanoseconds as a decimal string. */
  mono: string | null;
}

/** Relation of the second marker to the first. `uncertain` is an answer, not an error: no order is established. */
export type MarkerRelation = 'after' | 'before' | 'uncertain';

/** Linux boot id, or `null` where none can be read (Windows, macOS, unreadable). `read` is a test seam. */
export function bootKey(platform?: string, read?: (file: string) => string): string | null;
/** `<envId>|boot:<boot id>` where a monotonic clock can be vouched for, otherwise `null`. */
export function clockDomain(envId: string, platform?: string, read?: (file: string) => string): string | null;
export function markerOf(transport?: Partial<Pick<HookTransport, 'transport_id' | 'env_id' | 'clock_domain' | 'monotonic_ns'>>): ClockMarker;
export function compareMarkers(a: ClockMarker | null | undefined, b: ClockMarker | null | undefined): MarkerRelation;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Report protocol                                                                                                   */
/* ----------------------------------------------------------------------------------------------------------------- */

export type DeclaredStatus = 'complete' | 'partial' | 'blocked';
export type MarkerRejection = 'missing_or_empty_message' | 'blank_message' | 'malformed_or_misplaced_marker' | 'no_marker';

export type ParsedMarker =
  | { valid: true; status: DeclaredStatus; task: string; has_heading: boolean; marker_line: number }
  | { valid: false; reason: MarkerRejection };

/**
 * Parses the report marker: only the last non-empty line of the message counts. The marker is the model's declaration,
 * not evidence that anything worked. Never throws; non-string input is simply invalid.
 */
export function parseMarker(message: unknown): ParsedMarker;

export const PROTOCOL_VERSION: 1;
/** The text injected at SessionStart (only for registered projects) that asks the model to end a task with the marker. */
export const REPORT_INSTRUCTION: string;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Reducer                                                                                                           */
/* ----------------------------------------------------------------------------------------------------------------- */

export type SessionState =
  | 'unknown' | 'idle' | 'working' | 'needs_permission' | 'needs_input' | 'waiting_for_you' | 'turn_ended'
  | 'background_wait' | 'report_ready' | 'error' | 'ended' | 'presence_lost';

/** Human label of each state, as used in notification text. */
export const LABELS: Readonly<Record<Exclude<SessionState, 'unknown'>, string>>;

/** Why a session maps (or does not map) to a project. */
export type ProjectReason = ResolveResult['reason'];

/** What the current state was derived from. */
export type StateEvidence = 'none' | 'discovery' | 'discovery:absent' | `hook:${string}`;

/**
 * Phase of a process incarnation. `superseded` only ever appears on an archived generation: the current one is `none`
 * (nothing seen yet), `live`, `ended_observed` (SessionEnd hook, or a pid known dead on this host: final) or
 * `lost_suspected` (absent from a full snapshot: can be revised if the same process reappears).
 */
export type GenerationPhase = 'none' | 'live' | 'ended_observed' | 'lost_suspected' | 'superseded';

/** Identity of an operating-system process as `claude agents --json` reports it. */
export interface ProcessIdentity {
  pid: number | null;
  startedAt: number | null;
}

/** The evidence that opened a generation. */
export type GenerationOpening =
  | { kind: 'hook'; marker: ClockMarker }
  | { kind: 'discovery'; snapshot_seq: number };

/** The evidence that closed a generation. `seq` is the raw log entry that closed it. */
export type GenerationTermination =
  | { kind: 'hook_session_end'; marker: ClockMarker; seq: number }
  | { kind: 'process_exit'; snapshot_seq: number; seq: number }
  | { kind: 'absent_from_snapshot'; snapshot_seq: number; seq: number };

/** A hook or listing that could not be placed relative to a termination or an opening. It is kept, never dropped. */
export interface UnresolvedRecord {
  seq: number;
  /** The hook event name, or `discovery_listing`. */
  hook_event: string;
  relation: 'uncertain';
  why: string;
}

/** The current process incarnation of a session id. */
export interface Generation {
  /** 0 until something is seen; the first incarnation is 1. */
  n: number;
  phase: Exclude<GenerationPhase, 'superseded'>;
  proc: ProcessIdentity | null;
  /** Marker of the first startup/resume/fork SessionStart of this generation. */
  start: ClockMarker | null;
  open: GenerationOpening | null;
  term: GenerationTermination | null;
}

/** A generation that was replaced by a later one, with the unresolved items it was withheld from. */
export interface ArchivedGeneration extends Omit<Generation, 'phase'> {
  phase: Exclude<GenerationPhase, 'none' | 'live'>;
  unresolved: UnresolvedRecord[];
}

/** The latest `claude agents --json` observation of a session. */
export interface SessionObservation {
  status: string | null;
  waitingFor: string | null;
  kind: string | null;
  pid: number | null;
}

export interface TaskRecord {
  prompt_id: string | null;
  started_seq: number;
}

export interface ReducerSession {
  /** `<env>|<session id>`; just the session id for entries without an env. */
  key: string;
  session_id: string;
  env: SessionEnv;
  /** Resolved once, from the first usable directory, and then kept. */
  cwd: string | null;
  project: RegistryProject | null;
  project_reason: ProjectReason;
  state: SessionState;
  evidence: StateEvidence;
  current_prompt_id: string | null;
  /** True once any hook of this session was seen; after that a snapshot never rewrites hook-derived state. */
  hook_seen: boolean;
  /** True when discovery listed the session without a `sessionId`. */
  weak_identity: boolean;
  /** Occurrence counters per (content hash, handler): the basis of logical event identity. */
  occ: Map<string, number>;
  /** Keyed by `<session key>:<prompt id>`. */
  tasks: Map<string, TaskRecord>;
  /** The latest listing of the current generation's process, or null if no snapshot has listed it. Reset when a generation opens. */
  observed: SessionObservation | null;
  /** True once a snapshot has listed the current generation. Only then can a full snapshot that lacks it report "presence lost". Reset when a generation opens. */
  in_prev_snapshot: boolean;
  last_prompt_mark: ClockMarker | null;
  gen: Generation;
  generations: ArchivedGeneration[];
  unresolved: UnresolvedRecord[];
}

/** One real Claude event: native id when Claude provides one, otherwise (content hash, occurrence). */
export interface LogicalEvent {
  /** Raw log position of the first receipt. */
  seq: number;
  ev: string;
  /** Key of the session. */
  session: string;
  occurrence: number;
  basis: 'native' | 'occurrence';
}

/** A receipt that repeats a logical event delivered by another registration. Flagged, never deleted from the raw log. */
export interface DuplicateRecord {
  seq: number;
  logical: string;
  duplicate_of_seq: number;
  basis: 'native' | 'occurrence';
  handler: string;
}

/** Fields shared by reports, candidates and promoted reports. */
export interface ReportBase {
  session_id: string;
  env: SessionEnv;
  generation: number;
  project_id: string | null;
  project_name: string | null;
  cwd: string | null;
  prompt_id: string | null;
  /** `<session key>:<prompt id or "none">`. */
  task_id: string;
  /** The complete final message exactly as stored in the raw log (that is, after the hook's redaction): never truncated or summarised. */
  body: string;
  body_sha256: string;
  stop_hook_active: boolean;
  /** The Stop belonged to an older prompt or to a stale generation. */
  late: boolean;
  captured_seq: number;
  /**
   * How many credential-like values the hook replaced with `[REDACTED]` when it captured this Stop (never which). The count is
   * for the whole hook payload, so it can include values that are not in `body`; when it is above 0 the stored `body` may
   * not be exactly what the model wrote. 0 when the log entry carries no count.
   */
  redactions: number;
  /** How many over-long strings the hook cut (only inside `tool_input` and `tool_response`, never in `body`). 0 when unknown. */
  truncations: number;
}

/** A final message that satisfied the marker protocol. `verified` is always false: the marker is a declaration. */
export interface Report extends ReportBase {
  report_id: string;
  source: 'marker';
  declared_status: DeclaredStatus;
  task_title: string;
  has_heading: boolean;
  verified: false;
  note: string;
}

export type CandidateReason = 'marker_present_but_background_work_pending' | MarkerRejection;

/** Every final message that is not a report. Never discarded; can be promoted by hand. */
export interface Candidate extends ReportBase {
  candidate_id: string;
  reason: CandidateReason;
  /** Set only for `marker_present_but_background_work_pending`. */
  declared_status: DeclaredStatus | null;
  task_title: string | null;
  promoted: boolean;
}

/** Fields of every derived event. */
export interface DerivedEventBase {
  /** Stable across replays and restarts: the identity of a notification. */
  derived_id: string;
  session_id: string;
  env: SessionEnv;
  generation: number;
  project_id: string | null;
  /** `(unregistered <cwd>)` when the session maps to no project. */
  project_name: string;
  registered: boolean;
  notify: boolean;
  requires_user: boolean;
  cause_key: string;
  /** Raw log position that caused the event. */
  raw_seq: number;
  /** `<project> / Session <first 8 characters> / <text or state label>`; present for events that carry a `to`. */
  label?: string;
}

/** A state change. Only a change produces one, so notifications never repeat. */
export interface TransitionEvent extends DerivedEventBase {
  kind: 'transition';
  from: SessionState;
  to: SessionState;
  evidence: StateEvidence;
  label: string;
  /** Replaces the state label in `label`. */
  text?: string;
  /** A session ended while working, waiting for permission or input, with no Stop seen. */
  abnormal?: boolean;
}

/** A new process incarnation of an existing session id was established. */
export interface GenerationEvent extends DerivedEventBase {
  kind: 'generation';
  why: string;
}

/** A hook that belongs to an older prompt or a stale generation: kept, but it changes no state. */
export interface LateEvent extends DerivedEventBase {
  kind: 'late_event';
  hook_event: string;
  prompt_id?: string;
  stale_generation?: boolean;
}

/** A hook or listing whose order relative to a termination is not established. It stays uncertain. */
export interface UnresolvedOrderingEvent extends DerivedEventBase {
  kind: 'unresolved_ordering';
  hook_event: string;
  relation: 'uncertain';
  why: string;
}

export interface ReportReadyEvent extends DerivedEventBase {
  kind: 'report_ready';
  report_id: string;
  declared_status: DeclaredStatus;
  task_title: string;
  late: boolean;
  to: 'report_ready';
  text: string;
  label: string;
  notify: true;
}

/** The same task and text arrived again: still one report, the repeat is audited. */
export interface ReportDuplicateEvent extends DerivedEventBase {
  kind: 'report_duplicate';
  report_id: string;
}

export interface SessionDiscoveredEvent extends DerivedEventBase {
  kind: 'session_discovered';
  observed: SessionObservation;
  to: 'discovered';
  text: string;
  label: string;
}

/** A hook event the reducer does not know. Listed, never dropped. */
export interface UnhandledEvent extends DerivedEventBase {
  kind: 'unhandled_event';
  hook_event: string;
}

export type DerivedEvent =
  | TransitionEvent | GenerationEvent | LateEvent | UnresolvedOrderingEvent
  | ReportReadyEvent | ReportDuplicateEvent | SessionDiscoveredEvent | UnhandledEvent;

/** How one snapshot classified later hooks (`interval`) and which receipts it listed as in flight. */
export interface SnapshotRecord {
  interval: boolean;
  uncertain: Set<string>;
}

/**
 * Deterministic reducer: derived state is a pure function of the ordered raw log. It reads no clock, network or disk.
 * Feed it with {@link Reducer.apply} (or use {@link replay}) in log order.
 */
export class Reducer {
  constructor(opts: { registry: RegistryResolver });
  readonly registry: RegistryResolver;
  /** Keyed by {@link ReducerSession.key}. */
  readonly sessions: Map<string, ReducerSession>;
  readonly logical: Map<string, LogicalEvent>;
  readonly duplicates: DuplicateRecord[];
  /** Keyed by `report_id`. */
  readonly reports: Map<string, Report>;
  /** Keyed by `candidate_id`. */
  readonly candidates: Map<string, Candidate>;
  readonly derived: DerivedEvent[];
  /** Hooks without a session id or an event name. */
  readonly unattributed: number;
  /** Hooks and listings withheld from state because their order is not established. */
  readonly ordering_ambiguous: number;
  /** Listings of a process already known to be dead. */
  readonly stale_listings: number;
  readonly discovery_errors: number;
  /** Keyed by the raw `seq` of the discovery entry. */
  readonly snapshots: Map<number, SnapshotRecord>;
  apply(entry: ReducerEntry): void;
}

/** Applies every entry, in order, to a new {@link Reducer}. Replaying the same log always gives the same result. */
export function replay(entries: Iterable<ReducerEntry>, registry: RegistryResolver): Reducer;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Hook registration                                                                                                 */
/* ----------------------------------------------------------------------------------------------------------------- */

export interface HookCommandOptions {
  /** Required. Selects the command form (`win` is PowerShell, anything else is POSIX) and is written as `--env`. */
  env: EnvId;
  /**
   * Absolute path of the executable that runs the capture script: node, or with `runAsNode` the application's own
   * Electron executable.
   */
  node: string;
  /** Absolute path of the standalone capture script (`dist/capture.mjs`). */
  capture: string;
  spool: string;
  registry: string;
  /** Names this registration. Two registrations must use different ids. A token: see {@link hookCommand}. */
  handler: string;
  /** The hook event the command is registered for. A token: see {@link hookCommand}. */
  event: string;
  /**
   * Set `ELECTRON_RUN_AS_NODE=1` for this one invocation so an Electron executable acts as Node. POSIX and WSL:
   * `ELECTRON_RUN_AS_NODE=1 "<exe>" ...`. Windows (PowerShell): `$env:ELECTRON_RUN_AS_NODE='1'; & "<exe>" ...`.
   * Absent or `false` leaves the command line exactly as it was.
   */
  runAsNode?: boolean;
}

/** One hook definition as written into Claude Code's `settings.json`. */
export interface HookCommandDefinition {
  type: 'command';
  /** `powershell` on Windows only. */
  shell?: 'powershell';
  /** Seconds. */
  timeout: number;
  command: string;
}

export interface HookSettings {
  hooks: Record<HookEventName, Array<{ hooks: HookCommandDefinition[] }>>;
}

export interface BuildSettingsOptions extends Omit<HookCommandOptions, 'handler' | 'event'> {
  /** `['h1']` for normal use; `['h1', 'h2']` registers every event twice on purpose (qualification). */
  handlers?: readonly string[];
}

/**
 * One hook command line. Throws if a field is missing (`env` included) or if a path contains a character that is unsafe
 * inside the shell string (a double quote, `$`, a backtick or a line break): such a hook is refused rather than written
 * broken. The four paths are always quoted.
 *
 * `handler`, `event` and `env` are tokens: they are refused if they contain a quote of any kind (also the typographic
 * ones), a backtick, `$`, a control character or a line break. A token made only of letters, digits and `_ . : + = % @ / -`
 * is written as it is (so are `,` in a POSIX shell and `\` in PowerShell; PowerShell quotes a leading `@` and the lone
 * `--%`), which gives the usual ids the same line as always. Anything else is put in double quotes, correctly for the
 * form: `wsl:My Distro` becomes `"wsl:My Distro"`. In PowerShell a token that needs quotes must not end in a backslash.
 */
export function hookCommand(opts: HookCommandOptions): HookCommandDefinition;
/** User-level `settings.json` hooks for all nine events. */
export function buildSettings(opts: BuildSettingsOptions): HookSettings;

export interface Layout {
  config: string;
  work: string;
  spool: string;
  registry: string;
  store: string;
  reports: string;
}
/** Where things live. `shared` must be visible from Windows; WSL reaches it through `/mnt/<drive>/`. */
export function layout(opts: { env: EnvId; base: string; shared: string }): Layout;
/** True if `dir` is a normal Claude configuration directory (or inside one). The setup script refuses these. */
export function isNormalConfigDir(dir: string, homes: ReadonlyArray<string | null | undefined>, normalEnv?: string): boolean;

/* ----------------------------------------------------------------------------------------------------------------- */
/* Redaction                                                                                                         */
/* ----------------------------------------------------------------------------------------------------------------- */

export interface RedactionCounter {
  n: number;
}
export interface TruncationStats {
  n: number;
  bytes_dropped: number;
}

/**
 * Hides, inside a string, what looks like a credential, and adds one to `counter.n` for each value hidden. A deny-list: what
 * it does not recognise it leaves, and it prefers to hide a placeholder that has the shape of a secret.
 *
 * Token shapes are replaced as a whole by `[REDACTED]`: the providers' prefixed tokens (Anthropic, OpenAI, GitHub, GitLab,
 * Stripe, Slack and Slack webhooks, Google, AWS access key ids, npm, Hugging Face), JWTs, a bearer token of six characters or
 * more, and PEM private key blocks. A secret written into a command or a configuration keeps its name or option and loses its
 * value: `aws_secret_access_key = [REDACTED]`, `Authorization: Basic [REDACTED]`, `curl -u [REDACTED]`,
 * `postgres://[REDACTED]@host`, `AccountKey=[REDACTED]`, `--password=[REDACTED]`, `DB_PASSWORD=[REDACTED]`. Ordinary text that
 * only mentions these words is left as it is. Hiding the same text again changes nothing and counts nothing. Which shapes, and
 * what is not covered, are in docs/CHANGES-FROM-POC.md, change 9.
 */
export function redactString(s: string, counter: RedactionCounter): string;
/**
 * Replaces values under credential-like key names, and what `redactString` recognises inside strings, with `[REDACTED]`.
 * Numbers and booleans are never replaced. The result has the same shape except where a credential-named field was replaced
 * by that string.
 */
export function redactDeep<T>(value: T, counter?: RedactionCounter): T;
/** Caps every string longer than `max` and records what was dropped in `stats`. */
export function limitStrings<T>(value: T, max: number, stats: TruncationStats): T;
