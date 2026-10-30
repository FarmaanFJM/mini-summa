# Design rules

## Components
| Component | Responsibility | Must not |
|---|---|---|
| `capture.mjs` (hook) | Wrap the documented payload with transport metadata, redact, write atomically, exit 0. Print SessionStart context for registered projects only. | Decide permissions, block, print anything else, fail loudly |
| Spool directory | One complete JSON file per hook invocation. Temp files start with `.tmp-` and are ignored. | Hold partial files |
| `Store` | Append-only `raw.jsonl` (fsynced), idempotent ingestion, persistence of reports and candidates. | Drop or rewrite raw events |
| `Reducer` | Pure function from the ordered raw log to derived events, sessions, reports. | Read the clock, the network or the disk |
| `takeSnapshot` | Run `claude agents --json`, order it causally against hooks (barrier), append it. | Mutate any session |

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
- **Observed termination:** a SessionEnd hook, or a listed pid that is dead on this host. It closes the generation for good: a lingering listing of the same process is ignored.
- **Suspected presence loss:** absent from a full snapshot, or unknown pid. It is revised if the same process is listed again.
- **New generation:** a SessionStart after a closed generation, a second startup or resume in a live one, or discovery listing a different pid or start time for the session id.

Ordering, strongest first:
1. **Barrier.** Before asking Claude for a snapshot, record which hook files already wait in the spool; ingest exactly those first, then append the snapshot. Hooks written before the snapshot began are therefore earlier in the log, and later ones later, with no clock comparison.
2. **Monotonic clock** between two hooks of the same environment.
3. **Wall clock** only for a snapshot recorded without a barrier.
4. **Unknown.** The hook does not revive a closed generation; the case is counted in `ordering_ambiguous`.
A stale hook is kept as history (and a stale Stop still yields its report) but never changes state. Different environments are never ordered by clock.

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
- Cross-environment spools are ordered per environment only.
