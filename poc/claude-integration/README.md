# Claude integration proof of concept (Experiment A)

A small, dependency-free Node.js proof that Mini-Summa can observe Claude Code sessions through documented
mechanisms only: official hooks, `claude agents --json`, and `last_assistant_message`. It is research code, not the
application. Requires Node 22 or newer and the Claude Code CLI.

## What Experiment A proved, and where
| Claim | Evidence | Environment |
|---|---|---|
| Hooks deliver SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Notification, Stop and SessionEnd | real sessions, payloads in `examples/` | Linux |
| `claude agents --json` lists a session a human started elsewhere, with the UUID chosen by `--session-id` | `docs/qualification-results/linux-posix.json` Q08, Q09 | Linux |
| A session maps to the right project from its working directory | Q10 and the registry tests | Linux, plus Windows and WSL path rules by unit test only |
| A hard kill is detected, and a resume opens a new generation of the same session | Q11, Q13 | Linux |
| Duplicate hook registrations collapse without losing real events | Q12, `test/identity.test.mjs` | Linux |
| A marker-declared final report is captured byte for byte | Q14, `test/reports.test.mjs` | Linux, one run |
| Restarting the ingestor never repeats or loses events | Q15, `test/store.test.mjs` | Linux |
| No normal Claude setting or repository was modified | Q16 | Linux |

## What is NOT proven
- **Anything on native Windows or WSL2.** The Windows and WSL2 code paths exist and have unit tests, but no result here comes from either. `docs/QUALIFICATION.md` is the procedure.
- **Report-protocol reliability.** One real run and a handful of earlier trivial ones show the mechanism works. They say nothing about long tasks, other models or adversarial text. The marker is a model-written declaration, never proof that work or tests succeeded.
- StopFailure, background sessions, subagents, compaction, worktrees, hot reload of hooks into a running session, and a full machine reboot.

## Run the tests
```
npm test        # 106 automated tests, no network, no Claude calls
```
Qualification on a real machine (hooks, discovery, resume, kill) is separate: `docs/QUALIFICATION.md`.

## Layout
```
src/hook/capture.mjs      hook script: always exits 0, never decides, atomic spool write, redaction
src/lib/registry.mjs      project registry across Windows, WSL and POSIX path namespaces
src/lib/reducer.mjs       raw log -> derived events: identities, generations, state machine, reports
src/lib/store.mjs         durable raw log, spool ingestion, reports, candidates
src/lib/snapshot.mjs      discovery snapshot with an ordering barrier
src/lib/discovery.mjs     claude agents --json runner and validator (native and wsl.exe)
src/lib/marker.mjs, protocol.mjs   report protocol parser and the text injected at SessionStart
src/lib/setup.mjs         pure builders for hook commands and the isolated layout
src/cli/                  ingest, discover, reports
scripts/                  setup-isolated, qualify, make-fixtures, export-examples, pty-drive.py, claude-isolated.sh
fixtures/                 SYNTHETIC scenarios        examples/   sanitized REAL payloads
test/                     automated tests (including a publish guard)
docs/                     DESIGN.md, QUALIFICATION.md, EXPERIMENT-A.md, qualification-results/
```

## Security
Never commit raw hook payloads, transcripts, spools, stores or configs: they hold prompts, code and paths. `.gitignore`
blocks them and `test/publish-guard.test.mjs` fails on tokens, real home paths, harness identifiers, emails and
real-looking UUIDs. Test configuration directories contain Claude credentials after `/login`: delete them when done.
