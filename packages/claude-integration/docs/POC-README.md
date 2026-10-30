> **Research record.** This is the README of the Experiment A proof of concept, kept as it was written (the original stays in
> `poc/claude-integration/README.md` and is never edited). Its paths are relative to the package root, which has the same layout, and
> figures such as "131 automated tests" describe the proof of concept. The README of this package is [../README.md](../README.md).

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
| A hard kill is detected as **suspected** presence loss (absent from the listing, no pid evidence), and a resume opens a new generation of the same session | Q11, Q13 | Linux |
| Duplicate hook registrations collapse without losing real events | Q12, `test/identity.test.mjs` | Linux |
| A hook that lands while discovery is in flight, or arrives late, cannot fabricate a session generation; genuine resumes still open one | `test/ordering.test.mjs`, Q11 | Linux, synthetic and one real resume |
| A marker-declared final report is captured byte for byte. This shows the capture mechanism works, **not** that the protocol is reliable | Q14, `test/reports.test.mjs` | Linux, one run |
| Restarting the ingestor never repeats or loses events | Q15, `test/store.test.mjs` | Linux |
| No normal Claude setting or repository was modified | Q16 | Linux |

## What is NOT proven
- **Anything on native Windows or WSL2.** The Windows and WSL2 code paths exist and have unit tests, but no result here comes from either. `docs/QUALIFICATION.md` is the procedure.
- **Report-protocol reliability.** One real run and a handful of earlier trivial ones show the mechanism works. They say nothing about long tasks, other models or adversarial text. The marker is a model-written declaration, never proof that work or tests succeeded.
- StopFailure, background sessions, subagents, compaction, worktrees, hot reload of hooks into a running session, and a full machine reboot.

## Linux qualification evidence
Two real runs, both **16 PASS, 2 NOT TESTED** (Q05 and Q18 need Windows and WSL2):
- `docs/qualification-results/linux-posix.json`: the run reviewed in the first pull request (code before the ordering fix).
- `docs/qualification-results/linux-posix-after-ordering-fix.json`: the same sequence rerun against the corrected ordering code.

Q13 records **suspected** presence loss, not confirmed termination. Q14 captured one real report: it demonstrates the mechanism only.

## Run the tests
```
npm test        # 131 automated tests, no network, no Claude calls
```
Qualification on a real machine (hooks, discovery, resume, kill) is separate: `docs/QUALIFICATION.md`.

## Layout
```
src/hook/capture.mjs      hook script: always exits 0, never decides, atomic spool write, redaction
src/lib/registry.mjs      project registry across Windows, WSL and POSIX path namespaces
src/lib/reducer.mjs       raw log -> derived events: identities, generations, state machine, reports
src/lib/store.mjs         durable raw log, spool ingestion, reports, candidates
src/lib/snapshot.mjs      discovery snapshot that records the call interval
src/lib/clock.mjs         clock domains: when two monotonic timestamps may be compared
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
