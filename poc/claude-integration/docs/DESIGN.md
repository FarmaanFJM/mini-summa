# Design rules

## Components
| Component | Responsibility | Must not |
|---|---|---|
| `capture.mjs` (hook) | Wrap the documented payload with transport metadata, redact, write atomically, exit 0. Print SessionStart context for registered projects only. | Decide permissions, block, print anything else, fail loudly |
| Spool directory | One complete JSON file per hook invocation. Temp files start with `.tmp-` and are ignored. | Hold partial files |
| `Store` | Append-only `raw.jsonl` (fsynced), idempotent ingestion, persistence of reports and candidates. | Drop or rewrite raw events |
| `Reducer` | Pure function from the ordered raw log to derived events, sessions, reports. | Read the clock, the network or the disk |
| `takeSnapshot` | Run `claude agents --json`, classify hook receipts against the call interval, append it. | Mutate any session, or record a snapshot of a failed call |

## Session discovery
`claude agents --json` prints every live session, interactive and background, for one config directory. Fields used:
`cwd`, `kind`, `startedAt` always; `pid`, `status` while alive; `waitingFor`, `sessionId`, `name` when set. Only the first three are
assumed. Discovery is per config directory, so native Windows and each WSL distribution are queried separately
(`--wsl-distro` runs the query inside the distribution, and then pid liveness is unknown). A listing can outlive its process
for a moment, so absence is only ever "suspected" unless the pid is checked on the same host.
Discovery gives status, never content: reports and tool detail come from hooks.

## What each capability needs
| Capability | Needs | Does not give |
|---|---|---|
| Discover | `claude agents --json` | content |
| Observe status | same, polled | reports, history |
| Receive hook events | user-level hooks in that config directory, installed before the session starts | status of sessions started earlier |
| Resume | `claude --resume <uuid>`, only after the original process is gone, and only if the session received at least one message | control of a live session |
| Attach to a live interactive terminal | nothing documented | not possible |
| Attach to a background session | `claude attach` (not tested here) | interactive sessions |

## Hooks
Registered in the isolated `settings.json` for nine events. On Windows each command sets `"shell": "powershell"`, uses the call
operator with an absolute `node.exe`, and quotes every path. Each registration has a `--handler` id and an `--env` id. Claude Code
removes byte-identical hook commands itself, so two registrations only coexist if their command lines differ, which the handler id guarantees.
Observed on 2.1.314: PermissionRequest precedes the Notification `permission_prompt` by exactly 6 s; Esc at a prompt fires no Stop;
a failed model selection fires SessionStart, UserPromptSubmit and SessionEnd only; SessionEnd carries a `prompt_id`.

## Identity layers
They answer different questions and are never mixed.
| Layer | Identity | Source of truth | Idempotent across restart by |
|---|---|---|---|
| Receipt | `transport_id` of one hook process | the capture script | the persisted set of transport ids |
| Logical event | native id (`prompt_id`, `tool_use_id`) or (content hash, occurrence) | the reducer | replaying the raw log |
| Task | (session, `prompt_id`) | UserPromptSubmit | same |
| Report | (task, body hash); with no `prompt_id`, (logical event, body hash) | the Stop payload | same |
| Notification | id of the derived transition | a state change | the announced-set in `derived.jsonl` |
| Delivery | (report, destination) | not implemented here | |

**Occurrence rule.** For events without a native id, occurrence N of an identical payload from one handler is a distinct event.
Deliveries by different handlers that reach the same occurrence are one event. Consequences:
- Two real identical events are never merged, including parallel identical permission requests.
- Registering the hook twice produces duplicates that are flagged, never deleted.
- Arrival order of identical events does not change the set of logical events.

**Documented ambiguity.** If Claude Code itself ever retried a hook through the same registration, the retry would look like a second
real event. The reducer then keeps both (the safe direction), and nothing derived repeats: state changes are idempotent, a report with
the same prompt and text is one report, and notifications come only from state changes. Claude provides no event id that could settle it.
Without a `prompt_id`, a task cannot be identified, so distinct Stops stay distinct reports.

## Ordering and generations
A session id can outlive a process, so each process incarnation is a **generation**.

**A discovery call is an interval, not an instant.** `claude agents --json` takes time and hooks keep arriving while it runs.
`takeSnapshot` therefore scans the spool twice and records the result in the snapshot (`interval`):

| Class | Meaning | How it is known |
|---|---|---|
| Before | landed before the call started | present in the first scan; ingested first, so it precedes the snapshot in the log |
| Uncertain | landed while the call was in flight; may be before or after Claude's observation | absent from the first scan, present in the second; listed by transport id in `interval.uncertain` |
| After | landed after the call had returned | absent from both scans; ingested after the snapshot and not listed as uncertain |

"Landed" means the atomic rename into the spool. No clock, delay or retry is involved. A failed or interrupted call records a
`discovery_error` and no snapshot: it observed nothing, so nothing is inferred, and pending hooks stay in the spool for normal ingestion.

**Terminal transitions need affirmative evidence.** Closing a generation and opening the next are both terminal:
- A generic hook (tool use, permission, notification, Stop, prompt) never opens a generation. After a termination it is kept as history and counted as unresolved activity. A stale `Stop` still yields its report evidence but never changes state.
- A generation opens only on (a) a `startup`, `resume` or `fork` SessionStart whose order after the termination, or after the previous start, is established, or (b) discovery listing a live process whose identity (pid and start time) differs from the closed generation's known process. `clear` and `compact` happen inside a live process and are never a new one.
- A listing cannot open a generation if the closed generation never had a known process: it is indistinguishable from the dying tail of the old process, so it is recorded as unresolved.
- A `SessionEnd` closes a generation only if it provably belongs to it. A late one never creates a generation and never closes a newer one.

**What establishes "ordered after".** Only these:
1. The snapshot interval above: a hook classified After relative to the snapshot that closed the generation.
2. Two hooks of the same environment inside one trusted monotonic clock domain. A domain is known only where it can be identified exactly: Linux and every WSL distribution (boot id, which also covers reboots). Native Windows and macOS have none here, so monotonic comparison is unavailable there. Windows and WSL2 are different environments and are never compared.
3. Nothing else. Wall clocks establish no order. Anything not covered is **uncertain**, and uncertain stays uncertain: the hook is kept, `unresolved` records it with the reason, and a `unresolved_ordering` event is derived. It is resolved only by later affirmative evidence, such as a different live process being listed.

**Observed versus suspected.**
| | Evidence | Can it be reopened? |
|---|---|---|
| Observed termination | SessionEnd hook, or the listed pid is dead on this host | No. A lingering listing of the same process is ignored. A different process identity may open a new generation |
| Suspected presence loss | absent from a full snapshot, or pid liveness unknown (for example a WSL pid seen from Windows) | Yes, if the same process (pid and start time) is listed again |
Suspected loss is never converted into confirmed termination.

**Hard limits of the interface.** Stated, not hidden:
- Order is about when a record *landed*. How long a hook process ran before landing is not documented. A SessionStart from a process killed during startup could land after a "gone" snapshot and look like a resume. It is the only kind of hook that can, and only when it lands after the interval.
- A hook that lands during a call can never be placed relative to the observation. It stays uncertain until discovery or a later SessionStart settles it. If neither ever arrives, it remains uncertain permanently.
- On native Windows, hook-only ordering is unavailable. A resume there is settled by a snapshot interval or by discovery seeing a new process.
- A watcher that ingests an in-flight file before the snapshot is appended places it before the snapshot in the log. It is still listed as uncertain in the snapshot, and its effect is that of history preceding an observation of "gone".
- Each ingested hook is a receipt of one invocation. Claude Code provides no event id for most hooks.

## Report protocol
At SessionStart, for sessions whose directory is in the registry, the hook adds context asking the model to end a finished task with a
`## Implementation Report` section and a final line `<!-- mini-summa:report status=complete|partial|blocked task="Title" -->`.
Only the last non-empty line of `last_assistant_message` counts. Everything else, including malformed markers and markers with background
work still running, is stored whole as a **candidate** and can be promoted by hand. Nothing is truncated or summarised.
The marker is the model's declaration. It does not show that the code works or that tests passed, and every report is stored with `verified: false`.
No repository file is modified; the instruction travels through the user-level hook.

## Known limitations
- Report compliance is unmeasured beyond a few trivial runs on one model; a marker on an intermediate turn of a long task would be treated as a report.
- Permission state clears on the next tool event; there is no "permission answered" hook. A user interrupt fires no Stop; an idle observation corrects the state and says it is inferred.
- Hook payloads and the `agents --json` schema are not versioned. Unknown fields are ignored and unknown events are listed as unhandled.
- Session cwd is resolved once, from the first usable directory, and then kept.
- Cross-environment spools are never ordered against each other; within an environment, ingestion order across clock domains (for example across a reboot) carries no causal meaning.
