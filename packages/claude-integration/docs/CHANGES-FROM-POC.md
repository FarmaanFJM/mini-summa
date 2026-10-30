# Changes from the proof of concept

`poc/claude-integration` is the research record of Experiment A and is never edited. This package is that code plus its
regression suite. The 131 tests it inherited (`test/*.test.mjs` files that are byte-identical to the proof of concept's) are
unchanged and pass. Everything in which this package behaves differently from the proof of concept is listed here, with the
reason and the test that pins it.

Every test of a divergence has a title that starts with `CHANGE n:`. For each one the regression tests were also run against
the old behaviour (the earlier file restored, or the fix removed line by line) and fail there; only the tests that pin
behaviour that did **not** change still pass.

| # | Where | Divergence |
|---|---|---|
| 1 | `src/lib/spool.mjs` | A spool record that cannot be ordered is quarantined instead of wedging every pass |
| 2 | `src/lib/snapshot.mjs` | Invalid `claude agents --json` output is recorded as a `discovery_error`, like a failed call |
| 3 | `src/lib/setup.mjs` | `handler`, `event` and `env` are validated and quoted; `env` is required |
| 4 | `src/lib/reducer.mjs` | A new generation forgets what discovery saw of the previous one |
| 5 | `src/lib/spool.mjs` | A file another ingestor already moved is skipped instead of aborting the pass |
| 6 | `src/lib/discovery.mjs` | A Windows `claude.cmd` / `.bat` shim is started through a correctly quoted `cmd.exe` |
| 7 | `package.json` | `exports` adds `./hook`, `./hook-source` and `./package.json` |
| 8 | `src/lib/reducer.mjs` | Reports and candidates carry `redactions` and `truncations` |

## 1. A spool record that cannot be ordered no longer wedges ingestion

- **Proof of concept.** Records were ordered with `BigInt(transport.monotonic_ns)` inside the sort comparator. A record that names
  a `clock_domain` and whose `monotonic_ns` BigInt cannot read (`"not-a-number"`, `1.5`) made every pass throw before anything was
  ingested, moved or quarantined. The spool stayed wedged until someone removed the file by hand. (Reproduced.)
- **Now.** While a file is validated, a record with a clock domain whose `monotonic_ns` is not one of: absent, a string of decimal
  digits, a non-negative safe integer, is quarantined like any other unusable file: moved untouched to `quarantine/` and counted in
  `quarantined`. The pass goes on. A record without a clock domain is not checked, because the value was never read. Valid records
  are ordered exactly as before.
- **Why.** One damaged or foreign file must not stop hooks from reaching the log, and quarantine is the mechanism the spool already
  has for files it cannot use.
- **Tests** (`test/spool-robustness.test.mjs`): `CHANGE 1: a record with a clock domain and a monotonic_ns that is not a decimal
  integer is quarantined, and the same pass ingests everything else` (23 bad values); `CHANGE 1: the same through Store.ingestSpool,
  with the exact files that wedged the proof of concept`; `CHANGE 1: what the hook writes, and what never mattered, is still
  ingested`; `CHANGE 1: the order of valid records is unchanged`.
- **Limit.** The hook always writes a decimal string, so only a damaged or hand-made file is affected. Values the proof of concept
  happened to accept but the hook never writes (hex or padded or signed strings, an empty string, booleans) are quarantined too.

## 2. Invalid `agents --json` output is a failed call

- **Proof of concept.** If the command succeeded but printed something that was not a listing (an error object, `null`, a row of
  nulls), `normalizeAgents` threw after the pending hooks had been drained and after the second spool scan. No `discovery_error`
  was recorded, although `docs/DESIGN.md` says a call that observed nothing leaves one. (Reproduced.)
- **Now.** The output is checked (an array whose entries are all objects) before anything is drained. If it is not: one
  `discovery_error` with the shape of a failed call's (`message` cut at 300 characters, `pending_before`), no snapshot, the spool
  left undrained so the pending hooks go through the normal path, and the same error rethrown.
- **Why.** A call that printed garbage observed nothing, exactly like one that failed; the audit trail should say so, and nothing
  may be inferred from it.
- **Tests** (`test/snapshot-invalid-output.test.mjs`): `CHANGE 2: output that is not an array is recorded as a discovery_error,
  like a failed call, and the error is rethrown` (8 outputs); `CHANGE 2: the record is the one a failed call leaves`; `CHANGE 2:
  a listing with an entry that is not an object is invalid too, and nothing from it is recorded`; `CHANGE 2: real listings are
  unaffected`.
- **Limit.** Only the structure is checked. An array of objects with unexpected values is still recorded, as before, because the
  reducer tolerates missing optional fields. `normalizeAgents` itself is unchanged.

## 3. `hookCommand` validates and quotes `handler`, `event` and `env`; `env` is required

- **Proof of concept.** The three were pasted into the command line as they were. `handler: 'h1; id'` produced `--handler h1; id
  Stop`; a WSL distribution called `My Distro` became two arguments; an omitted `env` produced `--env undefined`. Only the four
  paths were checked. (Reproduced as strings; nothing was executed.)
- **Now.** All three must be non-empty strings (`hookCommand: env required` otherwise). A token is refused (message contains
  "unsafe") if it holds `"`, `'`, a backtick, `$`, a control character (C0, DEL, C1 including NEL), U+2028 or U+2029, or one of the
  typographic quotes U+2018 to U+201E, which PowerShell reads as quotes. These are the characters that cannot be made safe inside
  double quotes. A token made only of letters, digits, combining marks and `_ . : + = % @ / -` is written exactly as before, and so
  is a `,` in a POSIX shell and a `\` in PowerShell (PowerShell does quote a comma, a leading `@` and the lone `--%`). Every other
  token is put in double quotes: for a POSIX shell with backslashes doubled, for PowerShell as it is. `wsl:My Distro` becomes
  `"wsl:My Distro"` and `a;b` becomes `"a;b"`, one inert argument instead of a second command. In PowerShell a token that needs
  quotes and ends in a backslash is refused, because the backslash would escape the closing quote.
- **Why.** The line is run by the user's shell. The same care the paths always had now covers every part of it.
- **Compatibility.** Checked once against the proof of concept over 295,680 input combinations: every plain token gives the
  identical line, every quoted line equals the proof of concept's line with only those tokens replaced by their quoted form, and
  the remaining inputs are the ones above that now throw. A call with several problems reports a missing `env` before an unsafe
  path (the proof of concept never checked `env`).
- **Tests** (`test/setup-tokens.test.mjs`): `CHANGE 3: tokens that were safe unquoted are written exactly as the proof of concept
  wrote them`; `... a token with a character that splits arguments is quoted, so a WSL distribution called "My Distro" is one
  argument`; `... characters that are shell syntax but harmless inside double quotes are quoted rather than refused`; `... handler,
  event and env refuse quotes, backticks, $, line breaks and control characters, in both command forms`; `... env is required`;
  `... a PowerShell token that needs quotes cannot end in a backslash`; `... the checks on the four paths come first and say what
  they always said`; and two that run a real shell (`/bin/sh` and bash): `CHANGE 3: real shell: shell syntax in a token stays
  data` and `CHANGE 3: real shell: 300 seeded random tokens are either refused ... or delivered intact, in every position`.
- **Not tested: PowerShell.** The PowerShell form is checked as strings only; no PowerShell was available. The quoting rule for it
  rests on PowerShell's documented behaviour (inside double quotes only `$` and the backtick are special, and both are refused).

## 4. A new generation forgets what discovery saw of the previous one

- **Proof of concept.** `in_prev_snapshot` and `observed` survived into the next generation. Scenario: `SessionStart(startup)`;
  a snapshot lists the session; a full snapshot omits it ("Presence lost (suspected)"); `SessionStart(resume)` opens generation 2
  from a hook; the next full snapshot, which had never listed generation 2, said "Presence lost (suspected)" again, with a
  notification, on the strength of generation 1. `observed` also kept generation 1's status and pid. (Reproduced.)
- **Now.** `#openGeneration` clears both. A listing that opens a generation, or that lists a hook-opened one, sets them again, so
  a process that was listed and then vanishes is still reported lost; one that no snapshot has ever listed is not.
- **Why.** "Suspected presence loss" needs a listing to lose. A just-resumed process may simply not be in the list yet, and the
  notification asks the user to look at a session that is fine.
- **Compatibility.** Checked once over 20,000 random logs of hooks and snapshots: 19,622 give identical results, and in all 378
  others the first point at which the proof of concept and this package disagree is a "Presence lost (suspected)" transition of
  generation 2 or later that the package does not emit. Later differences in those logs follow from the generation not having been
  falsely closed.
- **Tests** (`test/reducer-generation-reset.test.mjs`): `CHANGE 4: the traced scenario: resumed by a hook, never listed since, the
  next full snapshot does not report it lost`; `... once a snapshot lists the new process, losing it is reported`; `... a generation
  opened by discovery records its own listing`; `... a hook-opened generation after an observed SessionEnd also starts with no
  listing history`; `... nothing else moves`.

## 5. A file another ingestor already moved is skipped

- **Proof of concept.** If a second ingestor (`ingest --watch` next to `discover --record`, or a snapshot's drain) moved a pending
  file between this pass's listing and its own move, `renameSync` threw ENOENT and the pass aborted. The quarantine branch had the
  same problem, because its `catch` also swallowed read errors. No data was lost: the files stayed pending. (Reproduced with a
  simulated concurrent move.)
- **Now.** ENOENT while reading: the file is skipped (not quarantined, not counted). ENOENT on the move to `done/` or `quarantine/`
  when the file is gone: nothing left to do, the pass continues, and counts follow the durable append's answer. ENOENT while the
  file is still there (the destination folder vanished): the move is retried once, then the error propagates. Any other error
  propagates as before.
- **Why.** Concurrent ingestors are a supported way to run the tools; the durable `appendRaw` is idempotent per `transport_id`, which
  is what makes skipping safe.
- **Tests** (`test/spool-robustness.test.mjs`): `CHANGE 5: a file that another ingestor moves to done/ while this pass runs is
  skipped, and the pass carries on`; `... a file that vanishes between the listing and the read is skipped`; `... a garbage file
  that another ingestor already quarantined is skipped`; `... an ENOENT caused by a vanished destination folder is retried once;
  the same error twice, and every other error, still propagates`; `... Store.ingestSpool has the same tolerance`.
- **Limit.** Other races, such as a sharing violation (EBUSY, EPERM) on Windows while a file is open, are not handled.

## 6. A Windows `claude.cmd` / `.bat` shim is started through a correctly quoted `cmd.exe`

- **Proof of concept.** For a `.cmd` or `.bat` file on Windows (what an npm install of Claude Code is) the call used Node's `shell:
  true`, which pastes the arguments together without quoting. A shim path or a `--cwd` containing a space broke the command, and
  shell metacharacters in the `--cwd` were interpreted by cmd.exe. (By inspection of the code; not run.)
- **Now.** `agentsCommand` (exported from `src/lib/discovery.mjs`, not part of the package API) returns what to start. For a shim on
  `win32`: `ComSpec` (or `cmd.exe`) with `['/d', '/s', '/c', '"<every part quoted>"']` and `windowsVerbatimArguments: true`. A part
  with nothing special in it is not quoted, trailing backslashes in a quoted part are doubled, and a part containing a double
  quote, `%`, `!` or a control character is refused with an error (the promise rejects, so `takeSnapshot` records a
  `discovery_error`). Everything else is started as before: `.exe`, `wsl.exe`, any other platform. `runAgentsJson` still reports the
  command as the caller wrote it (`file`, `args`).
- **Tests** (`test/agents-command.test.mjs`): the nine `CHANGE 6` tests build the command for `win32` on any machine and assert the
  exact file and argument list, the quoting of metacharacters, the refusals, and that nothing else changed; two of them run a real
  POSIX executable through `runAgentsJson` to show the unchanged path (arguments with spaces arrive intact, failures reject the
  same way).
- **Windows: NOT TESTED.** Nothing here runs cmd.exe. The tests prove the constructed file and arguments, not that Windows runs
  them as intended.

## 7. The manifest exports the hook

- **Proof of concept.** There was no package.
- **Now.** `exports` keeps `"."` unchanged and adds `"./hook"` (`./dist/capture.mjs`, the file `npm run build:hook` writes),
  `"./hook-source"` (`./src/hook/capture.mjs`) and `"./package.json"`. Nothing else inside the package is reachable by subpath.
- **Why.** The desktop app has to find the file it copies next to the user's Claude settings without reaching into the package.
- **Tests** (`test/package-exports.test.mjs`): the four `CHANGE 7` tests, including resolution by package name from CommonJS and
  ES modules, and that `./hook` resolves when `dist/` exists and fails as "not found" (never "not exported") when it does not.

## 8. Reports and candidates say how much was hidden

- **Proof of concept.** The hook counted redacted values and truncated strings in the transport, and the reducer dropped the counts.
  A stored report looked untouched even when `[REDACTED]` had been written into it, and the documents and tests describe reports as
  byte-for-byte.
- **Now.** `#stop` adds `redactions` and `truncations` (non-negative integers from the Stop's transport, 0 when absent or not a
  count) to every report and every candidate, and therefore to a promoted report. They are additive: ids, hashes, derived events
  and all other fields are unchanged. `redactions` counts the whole hook payload, so it can include values that are not in `body`;
  when it is above 0 the body may differ from what the model wrote.
- **Why.** The core can show "N credential-like strings were hidden when this report was captured".
- **Tests** (`test/report-redaction.test.mjs`): the six `CHANGE 8` tests, including one through the real hook with a credential in
  the message and an over-long `tool_response`.

## Additions that change no existing behaviour

- `src/lib/spool.mjs`: the spool algorithm extracted from `Store.ingestSpool` as `ingestSpoolFiles(spoolDir, { only }, appendRaw)`
  and `pendingSpoolFiles` (the 131 inherited tests and two differential runs show `Store` behaves as before, apart from changes 1
  and 5). It throws a `TypeError` before touching any file when the callback is missing.
- `runAsNode` on `hookCommand` and `buildSettings` (`test/setup-runasnode.test.mjs`); it must be a boolean when given.
- `src/index.js`, `src/index.d.ts`, `tsconfig.json`, `test/types/usage.ts`, `test/api.test.mjs`: the public API and its types.
- `npm run build:hook` and `test/bundle.test.mjs`.
- `docs/QUALIFICATION.md`: the clone and `cd` instructions point at this package, and `npm install` at the repository root is added.
  `docs/POC-README.md` is the proof of concept's README with a banner.

## Left exactly as in the proof of concept

- `Store.appendRaw` numbers entries `raw.length + 1`; if a line in the middle of `raw.jsonl` that was once valid is later corrupted,
  the next entry reuses an existing `seq`. A torn final line after a crash is handled and does not do this.
- `Store.promote` copies `promoted: false` from the candidate into the promoted report file.
- `normalizeAgents` throws a `TypeError` on a `null` entry (the snapshot path now rejects such output before reaching it).
- The `capture.mjs` argument parser reads an event that starts with `--` as an option.
