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
| 9 | `src/lib/redact.mjs` | The hook hides the ways a secret is typed (tokens of other providers, a password in a URL or after `curl -u`, `--password=...`, `DB_PASSWORD=...`, private keys), not only six token shapes |
| 10 | `src/hook/capture.mjs`, `src/lib/spool.mjs` | The spool directory is created `0700` (files stay `0600`); a directory of the earlier version is tightened |
| 11 | `src/lib/setup.mjs` | A Windows hook path with a typographic double quote (U+201C to U+201E) is refused |
| 12 | `src/lib/spool.mjs` | A spool file that is busy for a moment (EBUSY, EPERM) is not quarantined, and a move that meets the same is retried |
| 13 | `src/hook/capture.mjs` | The hook retries the rename of its record, so a scanner holding the new file does not lose the event |
| 14 | `src/lib/discovery.mjs` | The deadline of `claude agents --json` also ends the children of a Windows `.cmd` launcher, and the command's input is closed |
| 15 | `src/lib/registry.mjs` | `\\?\` and `\\.\` paths are read as the path they name; the name of a WSL distribution is compared without case |
| 16 | `src/lib/setup.mjs` | The Windows hook that runs the Electron executable waits for it: the call is made part of a pipeline (`| Write-Output`) |

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
- **Limit.** A sharing violation (EBUSY, EPERM) on Windows while a file is open is handled by change 12; other races are not.

## 6. A Windows `claude.cmd` / `.bat` shim is started through a correctly quoted `cmd.exe`

- **Proof of concept.** For a `.cmd` or `.bat` file on Windows (what an npm install of Claude Code is) the call used Node's `shell:
  true`, which pastes the arguments together without quoting. A shim path or a `--cwd` containing a space broke the command, and
  shell metacharacters in the `--cwd` were interpreted by cmd.exe. (By inspection of the code; not run.)
- **Now.** `agentsCommand` (exported from `src/lib/discovery.mjs`, not part of the package API) returns what to start. For a shim on
  `win32`: `ComSpec` (or `cmd.exe`) with `['/d', '/s', '/c', '"<every part quoted>"']` and `windowsVerbatimArguments: true`. A part
  with nothing special in it is not quoted, trailing backslashes in a quoted part are doubled, and a part containing a double
  quote, `%`, `!` or a control character is refused with an error (the promise rejects, so `takeSnapshot` records a
  `discovery_error`). Everything else is started as before: `.exe`, `wsl.exe`, any other platform. `runAgentsJson` still reports the
  command as the caller wrote it (`file`, `args`). The deadline of that call is change 14.
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

## 9. The hook hides the ways a secret is typed, not only six token shapes

- **Proof of concept.** `redactString` knew six shapes (`sk-ant-`, `sk-` plus 20, `Bearer` plus 12, GitHub tokens, JWTs, AWS access
  key ids) and `redactDeep` replaced the value under any key that looks like a credential. An independent review found that these
  went to the spool in clear: OpenAI `sk-proj-` keys, Stripe `sk_live_` / `rk_live_` (and `_test_`), GitLab `glpat-`, Slack
  `xoxb-` `xoxp-` `xoxa-` `xoxr-` `xoxs-` and Slack webhook URLs, Google `AIza` keys, `aws_secret_access_key` assignments,
  `Authorization: Basic`, `curl -u user:password`, `scheme://user:password@host`, PEM private key blocks, `npm_` and `hf_` tokens,
  Azure `AccountKey=`, `--password=hunter2` and its siblings, `export DB_PASSWORD=...` and the like, and a `Bearer` token shorter
  than 12 characters. (Reproduced here: the tests below, run against a copy of the proof of concept's redactor, fail for each of
  them.)
- **Now.** `redactString` also hides the following; each hidden value adds one to the count, as before, and a value that two rules
  could hide is hidden and counted once (the second rule finds `[REDACTED]` and leaves it). Text that has been hidden is a fixed
  point: hiding it again changes nothing and counts nothing.
  - *Token shapes*, replaced as a whole: `sk-proj-` / `sk-svcacct-` / `sk-admin-` (8 or more characters after the prefix),
    `sk_live_` / `rk_live_` / `sk_test_` / `rk_test_` (8+), `glpat-` (8+), `xoxb-` `xoxp-` `xoxa-` `xoxr-` `xoxs-` `xoxe-` and `xapp-` (8+),
    `hooks.slack.com/services/T/B/token` with or without `https://`, `AIza` (20+), `npm_` (16+), `hf_` (16+), a PEM private key block
    of any type (`RSA`, `EC`, `DSA`, `OPENSSH`, `ENCRYPTED`, `PGP ... BLOCK`, plain `PRIVATE KEY`; not `PUBLIC KEY`, not a certificate).
    A block is hidden from its BEGIN line to its END line when the END line is within 4096 characters and only base64, line breaks
    (also as the two characters `\n`) and the `Proc-Type` / `DEK-Info` lines of old keys lie between. With no END line (a capture cut
    short) the base64 that follows is hidden, at most 4096 characters, and the line break that ends it stays outside the hidden
    part. A header with fewer than 8 base64 characters after it (a mention in a sentence) is not a key and is left alone. The cap is
    deliberate: what is hidden never grows with the text after it.
  - *Bearer*: `Bearer <6 or more characters>` as a whole (before: 12 or more), unless the word is one that follows "Bearer" in a
    sentence (`tokens`, `scheme`, `schemes`, `header`, `headers`, `prefix`, `strategy`, `access`, `credential(s)`, `values`,
    `protocol`) or a challenge parameter (`realm=`, `error=`, `scope=` ...: `WWW-Authenticate: Bearer realm="api"`). After
    `Authorization:` the value is hidden in any case spelling (`authorization: bearer abc123`), with the same exceptions.
  - *The value goes, the name stays* (so the log still says what was passed): `aws_secret_access_key = [REDACTED]` (INI, YAML, env,
    JSON text and `aws configure set`; the value must be 16 characters or contain a digit, `/`, `+` or `=`, so that "aws_secret_access_key
    is required" is left alone); `Authorization: Basic [REDACTED]` (the credentials are not one plain word, so "Basic Authentication"
    is left alone); `curl -u [REDACTED]` for `-u`, `--user` and clusters such as `-sSu`, only when the same command (its line and the
    lines it continues with a trailing backslash, looking back at most 2000 characters) starts or contains `curl`, only when a password
    is given (`user:password`), and not when it is a `$variable`; `scheme://[REDACTED]@host` for `scheme://user:password@host`
    (also an empty user, `redis://:password@host`); `AccountKey=[REDACTED]` and `SharedAccessKey=[REDACTED]` (6+ characters);
    `--password=[REDACTED]`, `--passwd`, `--token`, `--secret`, `--api-key`, with `=` (also with a prefix: `--client-secret=`,
    `--db-password=`, `--auth-token=`) or after a space (only the five bare names, and not when the next word is one of a short list
    that follows a flag in a sentence, `<placeholder>`, an upper-case `TOKEN`, a `$variable`, `-` or another option);
    `NAME=[REDACTED]` for `NAME=value` where NAME is in capitals and ends in `PASSWORD`, `PASSWD`, `PASSPHRASE`, `SECRET`, `TOKEN`,
    `API_KEY`, `APIKEY`, `SECRET_KEY`, `ACCESS_KEY` or `PRIVATE_KEY` (`export`, `set`, `ENV`, `docker -e`, `$env:` and bare forms; quoted
    values too), when the value is not empty, not a `$variable` or `$(command)`, not `[REDACTED]`, not `true` / `false`, not `...` or
    `****`, and does not start with another `=` (so `if (TOKEN==x)` is not touched). `MAX_TOKENS=100`, `TOKEN_LIMIT=5000` and
    `PASSWORD_MIN_LENGTH=8` do not end in a secret word and are left alone.
- **Why.** The spool, the raw log and the reports hold whatever a tool printed or a person typed. The hook is the only place
  where a secret can still be kept out of them; after that it is in a file.
- **False positives are measured, not guessed.** The new rules were run over text that is not credentials, and every difference to
  the proof of concept's redactor was read:

  | Text | Size | Files that differ | Hidden before → now | What the differences are |
  |---|---|---|---|---|
  | this repository outside this package (core, shared, apps, docs, scripts) | 580 files, 6.1 MB | 11 | 5 → 18 | 8 lines with `scheme://user:pw@host` in tests of URL validation, a garbage PEM block in a test, `--token=abc` in a test of argv redaction, 3 fake bearer tokens (`Bearer tok-secret`, `Bearer at-prod`) |
  | this package's `fixtures/`, `examples/`, `scripts/` | 26 files, 0.1 MB | 0 | 0 → 0 | none |
  | `poc/` | 60 files, 0.3 MB | 0 | 5 → 5 | none |
  | every text file in `node_modules` (README, typings, code, JSON, shell) | 19,756 files, 214 MB | 32 | 2 → 76 | 65 `new URL('https://user:pass@example.com')` style examples, 4 PEM blocks and 5 `SECRET_KEY="..."` lines in the dotenv READMEs |
  | `git log -p` of 400 commits of this repository, 53 build, test and `npm ci` logs | 8.2 MB | 1 | 17 → 44 | the redactor's own test fixtures and comments |

  Nothing that is prose, code, a type annotation, a file name, a hash, a UUID, an image path or a URL without a password changed in
  any of them. What does change is documentation and tests that use the shape of a credential with a placeholder inside
  (`user:pass@host`, `PASSWORD="s1mpl3"`): the redactor cannot tell a placeholder from a secret and hides it, which is the safe
  direction, and the comment at the top of `redact.mjs` says so. The measurement found five false positives, all fixed before this was
  written: a PEM header named in a sentence ("lines that start with ..."), code that builds a PEM string around `${data}`,
  `WWW-Authenticate: Bearer realm="..."` in an HTTP library, `PASSWORD=...` as an elision in a README, and usage text such as
  `--token <token>`. Each has a test.
- **Cost.** About 90 microseconds for a string of 8 KB (the cap for tool input and output) against 13 for the six rules of the
  proof of concept: 41 MB/s against 286 MB/s on 60 MB of source and documentation. A hook invocation took 40 ms with either (30
  runs each); starting node is what it costs. 25 hostile inputs of one megabyte each (one capitalised run, 75,000 names without a
  value, an unterminated quote, 95,000 `BEGIN` headers, `Bearer` followed by a megabyte of spaces, 80,000 `http://u:p@h`, a long
  `curl` line with 90,000 `-u a:b`, and others) finish in 0.4 s at the most each, in proportion to their size. One detail, the
  `(?<![A-Za-z0-9_])` anchor of the `NAME=` rule, is what keeps a long run of capitals from costing the square of its length;
  removing it makes the test fail by its deadline.
- **Tests** (`test/redaction-patterns.test.mjs`, 21 tests; the secrets in it are assembled at run time, because the publish guard
  and the hosts' secret scanners read every file): the 19 token shapes in 11 surroundings each; every written form with its exact
  output (aws in 9 spellings, Basic, `curl -u` in 14 spellings and 15 that must stay, URLs, Azure, 5 flags times 7 forms and 6
  prefixed flags, 18 names times 15 forms, Bearer); PEM of 7 types with LF, CRLF and escaped line ends, with and without END, the
  4096 cap, two blocks, a legacy encrypted key; the exact count for 18 combinations that two rules could hide, and idempotence of
  every positive; `redactDeep` with the new shapes next to key-based hiding; the proof of concept's six rules copied into the test,
  to show that nothing it left alone changes and that what it hid is hidden the same way and counted the same; 164 look-alikes
  (prose about passwords and tokens, type annotations such as `password: string`, code, file names, git SHAs, UUIDs, base64 and
  image paths, URLs without userinfo, `--passport`, `--max-tokens`, `MAX_TOKENS=100`, `docker run -u 1000:1000`) that neither
  redactor changes; every fixture and example of the package giving the proof of concept's output and count, as text and as a
  document; the 25 hostile inputs, run in a child process with a deadline so that a bad rule fails the test instead of hanging it;
  and one test through the real hook that checks the spool file and `transport.redactions`.
- **Checked.** Against a copy of the proof of concept's redactor 15 of the 21 tests fail; the 6 that pass pin what did not change
  (the look-alikes, the fixtures and examples, the proof of concept's own shapes, the PEM mentions, the prefix mentions, the cost).
  Then 55 changes were made to the redactor one at a time, each in a scratch copy: every one of the 22 rules disabled, the PEM
  pass disabled, and 32 changes to the guards (a stop-list removed, a placeholder check dropped, a threshold raised, the 4096 cap
  doubled and quartered, the line-break trim dropped, the `NAME=` anchor and lookbehind dropped, the counter not incremented, and so
  on). All 55 fail at least one test; none survives.
- **Limits.** It is a deny-list. Not covered: a lower-case or dotted name (`password=hunter2`, `db.password=...`, `?token=...` in a
  query string), a name that ends in another word (`ENCRYPTION_KEY=`, `DB_CREDENTIALS=`), `NAME = "value"` with spaces, `password:
  value` in YAML or JSON text (a JSON *key* is hidden, as before), short options such as `mysql -phunter2` or `docker login -p`,
  `Cookie:` and `X-API-Key:` headers, ADO.NET `Password=...;`, a legacy `_authToken` that is a UUID, a secret mentioned in a sentence
  ("the password is hunter2"), anything encoded, split or reversed, and a secret in a file name. The word lists (what follows a flag or
  `Bearer` in a sentence) are English. A key larger than 4096 characters is hidden up to the cap. The capture cuts strings at 8192
  characters before it redacts, as before, so a token cut in two by that limit can be too short to be recognised. An `Authorization:
  Bearer` value is hidden even when it is a word of six letters, because there it is a credential.

## 10. The spool is private: directories `0700`, files `0600`

- **Proof of concept.** `capture.mjs` created the spool with `fs.mkdirSync(spool, { recursive: true })`: mode 0777 minus the umask,
  0755 for the usual 022. Any other account on the machine could list the directory and walk into `done/` and `quarantine/`, which
  the ingestor creates the same way. The files are 0600, so their content was not readable, but names (a clock reading and an id), sizes and
  timing were, and a file that ever arrived with a looser mode (a copy, a restore) was readable. `capture-errors.log` was created
  with the default mode. (Reproduced with the proof of concept's `capture.mjs`: the spool and the parents it creates come out
  0755 under umask 022 and 0777 under umask 0, the records 0600, the error log 0644.)
- **Now.** The spool directory, and the parents the hook has to create, are made with mode `0700`, whatever the umask. A spool of the
  earlier version is tightened to `0700` when it is plainly the hook's: a real directory (not a link), owned by the current user, with
  group or world access, and holding only names the hook and the ingestor write (`<digits>-<uuid>.json`, `.tmp-<uuid>`, `done`,
  `quarantine`; an empty directory qualifies). Anything else (a folder someone pointed `--spool` at, a directory with other files, a
  symbolic link, a directory of another user) is left exactly as it was and the capture goes on. Failing to tighten never fails
  the capture. An already private directory costs one `lstat`. The files stay `0600`; `capture-errors.log` is created `0600`; and
  `done/` and `quarantine/` are created `0700` by `src/lib/spool.mjs`, which is where the application's ingestor makes them.
- **Why.** Prompts, file contents and command output are what the spool holds. A directory that others can enter is a bet
  that the files inside never get the wrong mode.
- **Windows: modes are not applied and not tested.** `mkdir` ignores the mode there and the hook does not call `chmod`; the
  directory takes the access rules of its parent. The tests skip their mode assertions on `win32` and still run the hook.
- **Not changed.** A parent directory that already exists keeps its mode. The store's own directory (`new Store(dir)`) is still created with
  the default mode; the files in it are 0600 as before.
- **Tests** (`test/spool-privacy.test.mjs`, 7 tests, the mode assertions skipped on Windows): a new nested spool is `0700` with its
  parents under umasks 0, 002, 022 and 077 and the record is `0600`; a legacy `0755` and a `0750` spool with a `done/`, a stale temp
  file and 300 records are tightened; an empty existing directory is tightened; a folder with a foreign file, a folder with one
  record and a stranger, names that only look like ours, a symbolic link and (as root) a directory of another user are left alone and
  the capture still writes; the error log is `0600` under umask 0; the ingestor's `done/` and `quarantine/` are `0700` and what it
  moves is `0600`; and the bundle built the way `build:hook` builds it behaves the same.
- **Checked.** Against the proof of concept's `capture.mjs` and a `spool.mjs` without the mode, 6 of the 7 tests fail (the seventh
  pins that foreign directories are left alone). Then 12 changes were made one at a time (the mode dropped, the tightening never
  called or never applied, the owner check dropped, `stat` for `lstat`, the name check dropped or loosened, a name pattern
  shortened, the error log's mode dropped, the ingestor's mode dropped); none survives.

## 11. A typographic double quote in a Windows hook path is refused

- **Proof of concept.** The node, capture, spool and registry paths of a Windows hook are written inside double quotes in a
  PowerShell command, and a path was refused only if it held `"`, a backtick, `$` or a line break. PowerShell also reads the
  typographic double quotes U+201C, U+201D and U+201E as the end of a string, so a path with one of them ended the string early
  and the rest of the path was parsed as PowerShell. (Change 3 had already given the `handler`, `event` and `env` tokens the
  whole range U+2018 to U+201E; the paths were missed.)
- **Now.** `FORBIDDEN_IN_PS` adds U+201C to U+201E, so the same error ("path for spool contains a character that is unsafe inside a
  PowerShell string") is thrown for those characters in any of the four paths of a `win` hook, by `hookCommand` and
  `buildSettings`, with or without `runAsNode`. POSIX and WSL commands are not run by PowerShell and are unchanged: a real `sh`
  starts a capture script under a folder called `O` U+2019 `Neil` in the test.
- **Decided (lead).** The first version also refused U+2018, U+2019, U+201A and U+201B. PowerShell reads only U+201C to U+201E as
  *double* quotes; the other four are single-quote characters and mean nothing inside a double-quoted string, so a Windows profile
  folder such as `C:\Users\O` U+2019 `Neil` would have been refused for a reason that is not a safety one. The path rule is therefore
  `\u201c-\u201e`. The tokens (`handler`, `event`, `env`) keep refusing the whole range U+2018 to U+201E (change 3): they are not
  paths, so the conservative choice costs nothing.
- **Windows: NOT TESTED.** PowerShell was not available. That these characters are PowerShell's quote characters is taken from its
  language specification (the tokenizer's single-quote and double-quote character sets), not from running it.
- **Tests** (`test/setup-powershell-quotes.test.mjs`, 5 tests): 3 double quotes x 4 paths x 4 positions are refused with the message
  that names the field; the refusal reaches `buildSettings` for every field with and without `runAsNode`; `"`, backtick, `$`, CR and
  LF are still refused and an ordinary path gives the command it always did; U+2017, U+201F, `'`, the four typographic single quotes and
  other quote-like characters that PowerShell does not read as double quotes are accepted in a path; POSIX and WSL accept all seven,
  and a real shell takes such a path as one argument; and the tokens refuse all seven while the paths refuse the three double quotes
  and keep a profile folder with a typographic apostrophe usable.
- **Checked.** Against the `setup.mjs` without the added characters, 3 of the 5 tests fail (the other two pin what did not change).
  With the first version's wider range (U+2018 to U+201E) restored, 2 of the 5 fail: they pin that a typographic apostrophe in a
  profile folder is accepted.

## 12. A spool file that is busy for a moment is not taken for a damaged one

- **Proof of concept.** Any error while a pending file was read counted as "this file is damaged": the `catch` moved it to
  `quarantine/` (ENOENT apart, change 5). On Windows another program can have a file open for a moment (an antivirus scan of a file
  written a moment ago, the search indexer, a backup), and Windows reports that as EBUSY (sharing violation) or EPERM (access
  denied). A hook event that was merely busy therefore went to `quarantine/` for good. The move into `done/` had the same exposure:
  the rename threw at once, the pass was aborted, and every file after it waited. (By inspection of the code, and with injected
  errors; not seen on Windows.)
- **Now.** EBUSY or EPERM while reading: the file is skipped (not quarantined, not counted) and read on the next pass; the other files
  of the pass are ingested. EBUSY or EPERM on the move into `done/` or `quarantine/`: retried up to 6 times, pausing 10, 20, 40, 80,
  160 and 320 ms (about 0.6 s), then the error propagates as before; the file stays pending, and because the append is idempotent
  the next pass moves it without ingesting it twice. A file that really is damaged is still quarantined, and every other error
  (EACCES, ENOSPC, ...) still propagates at once.
- **Why.** libuv gives ERROR_SHARING_VIOLATION as EBUSY and ERROR_ACCESS_DENIED as EPERM. Both pass within a moment and say nothing
  about the file. Losing a permission request or a report to quarantine because a scanner was looking at the file is the one
  place not to be careless: the spool file is the only copy.
- **Tests** (`test/windows-robustness.test.mjs`): `CHANGE 12 (simulated Windows): a pending file that is EBUSY when it is read is
  skipped, not quarantined, and read on the next pass` (and the same for EPERM); `... a file that really is damaged is still
  quarantined, busy files around it or not`; `... a move into done/ that is EPERM or EBUSY a few times is retried and then
  succeeds`; `... a file that stays busy is reported after the retries, stays pending, and is not ingested twice later`; `CHANGE
  12: any other error still propagates at once, without a pause`. The errors are injected on Linux (`t.mock.method` on
  `fs.readFileSync` and `fs.renameSync`) with the codes libuv gives the Windows errors.
- **Checked.** With the busy-file skip and the retries removed, 4 of the 6 tests fail (the two reads, the retried move, the file that
  stays busy); the other 2 pin what did not change (a damaged file is quarantined, other errors propagate at once).
- **Windows: NOT TESTED.** The tests inject the error codes. No sharing violation was ever produced by a real scanner.
- **Limit.** A file that stays busy for longer than the retries is reported by every pass and stays pending until the other program
  lets go; the pass does not go on past it, so the files after it wait. The pause blocks the thread for at most 0.6 s per file.

## 13. The hook retries the rename of its record

- **Proof of concept.** `capture.mjs` wrote the record to `.tmp-<id>` and renamed it to its final name with one `fs.renameSync`. On
  Windows the rename of a file written a moment ago fails with EPERM or EBUSY while a scanner or the indexer holds it. The error was
  caught, appended to `capture-errors.log` and swallowed (the hook must exit 0), so that hook event never reached the spool, and
  the temp file stayed behind. (By inspection; reproduced with injected errors.)
- **Now.** When the rename fails with EPERM, EBUSY or EACCES it is tried again, up to 8 attempts in all, pausing 10, 20, 40, 80, 160, 320
  and 640 ms between them (about 1.3 s of the hook's 5). Any other error, and a lock that does not let go, end as before: the error
  is logged to `capture-errors.log`, the hook exits 0 and prints nothing. The pause is a synchronous `Atomics.wait`. Nothing is
  written outside the spool.
- **Why.** A lost hook event is a lost report, permission request or lifecycle fact, and nothing can recover it: the hook is the only
  place the event exists.
- **Tests** (`test/windows-robustness.test.mjs`): `CHANGE 13 (simulated Windows): the hook retries a rename that fails with EPERM,
  so the record still reaches the spool` (and the same for EBUSY and EACCES; the real `capture.mjs` in a child process, with a
  preload that makes the first 3 renames of the temp file fail; the record is in the spool, no temp file is left, nothing is
  logged); `... a lock that never
  lets go still exits 0, logs the error, and takes about a second and a quarter at most`; `CHANGE 13: a rename that works at once
  costs nothing extra, and another error is not retried`.
- **Checked.** With the single rename restored, the 3 retry tests fail (no record in the spool); the other 2 pin what did not change.
  `npm run build:hook` bundles the same code.
- **Windows: NOT TESTED.** The failures are injected. No scanner was involved.

## 14. The deadline of `claude agents --json` reaches the children of a Windows launcher

- **Proof of concept.** `runAgentsJson` relied on the `timeout` of `execFile`, which kills the direct child with SIGTERM. For an npm
  install on Windows the direct child is `cmd.exe /d /s /c "claude.cmd ..."` (change 6). Killing cmd.exe leaves the node.exe behind
  it running with the pipes open, and `execFile` calls back only when the pipes are closed, so `runAgentsJson` never settled. A
  caller that awaits it, such as the core's discovery pass, which shares a queue with spool ingestion, waited for ever. The
  command's input was also left open, so a program that stops to read from it (a prompt) waited for ever too. (By inspection of how a
  process tree is ended on Windows; not seen on Windows.)
- **Now.** `runAgentsJson` runs the command through `execWithDeadline` (exported from `src/lib/discovery.mjs`, not part of the package
  API). The command's input is closed at once, on every platform. On Windows the function keeps the deadline itself: when it passes,
  `taskkill.exe /pid N /T /F` (by its full path under `%SystemRoot%\System32`, the variable accepted only when it names a local
  drive) ends the process and everything it started, and only then is the process killed, so the callback comes and the promise
  rejects with `... failed: timed out after N seconds`. taskkill runs first because the tree is found through the parent links, which
  are gone once the parent has died. A tree killer that fails or throws does not stop the kill. Everywhere else `execFile`'s own
  `timeout` is used as before, and a failed call rejects with the message it always had.
- **Why.** A call that cannot be ended is worse than a call that failed: nothing queued behind it can happen.
- **Tests** (`test/windows-robustness.test.mjs`, 6): `CHANGE 14 (simulated Windows): the deadline ends the process tree first and
  then the process, and says it timed out`; `... a tree killer that fails or throws still ends the process`; `... a command that
  finishes in time is untouched, and the deadline timer does not keep the process alive`; `CHANGE 14: elsewhere execFile's own
  deadline is used, and no tree killer runs`; `CHANGE 14: the command's input is closed at once, so a program waiting for input ends
  with end-of-file`; `CHANGE 14: runAgentsJson on a hung command rejects with the failure as before (the message names the
  command)`. The platform and the tree killer are injected, and a real sleeping process stands in for node.exe.
- **Checked.** With the tree kill and the closing of the input removed, the first test fails and the input test waits until its
  deadline; the tests of what did not change (finishing in time, the other platforms, the message) pass either way.
- **Windows: NOT TESTED.** taskkill was never started and no cmd.exe is in the tests. The core applies the same rule to its own
  helper commands (`packages/core/src/claude/commandRunner.ts`).

## 15. `\\?\` paths are read as the path they name, and WSL distribution names compare without case

- **Proof of concept.** `canonicalize(p, 'win')` turned `\\?\C:\Dev\App` (the long-path spelling some Windows tools report) into
  `\\?\c:\dev\app`, which is not `c:\dev\app`, so a working directory in that form never matched the folder it names;
  `\\?\UNC\wsl$\Ubuntu\home\u\proj` was not recognised as a path inside WSL either. And `within()` compared the file-system names
  exactly: a root typed `\\wsl$\ubuntu\home\u\proj` (file system `wsl:ubuntu`) did not contain the `/home/u/proj` that a session of
  `wsl:Ubuntu` reported, although Windows treats the two spellings as one share, and two projects claiming the same folder as
  `ubuntu` and `Ubuntu` were not reported as ambiguous. (Reproduced as strings.)
- **Now.** For the `win` namespace a `\\?\` or `\\.\` prefix (also written `//?/`) in front of a drive path (`\\?\C:\x`) or of `UNC\`
  (`\\?\UNC\server\share\x`) is removed before the path is canonicalised: `\\?\C:\Dev\App\` is `c:\dev\app`, and
  `\\?\UNC\wsl$\Ubuntu\home\u` is the same WSL folder as `\\wsl$\Ubuntu\home\u`. Any other use of the prefix (`\\?\Volume{...}`,
  `\\?\GLOBALROOT`) is left as it is. File systems of the form `wsl:<Distro>` compare without case; everything else (Linux paths
  inside a distribution, `win`, `posix`, another distribution) compares exactly as before, and `canonicalize` still returns the
  name as it was written.
- **Why.** A working directory that matches no root silently loses its project: no report protocol is injected and the session
  is unassigned. And the share name is not case-sensitive for Windows.
- **Tests** (`test/windows-paths.test.mjs`): `CHANGE 15 (simulated Windows): the long-path prefix (...) names the same folder`;
  `CHANGE 15 (simulated WSL): a root registered as \\wsl$\Distro\... or \\wsl.localhost\Distro\... is the Linux folder a WSL session
  reports`; `CHANGE 15 (simulated WSL): the distribution name is not case-sensitive (...), nothing else is`; `CHANGE 15 (simulated):
  two projects claiming one folder through different spellings are reported as ambiguous, never guessed`. Six more tests in the
  file pin behaviour that was already right and did not change (case, slashes and trailing separators of drive paths, the
  `/mnt/<drive>` mapping, distribution names with dots, folders with spaces and non-ASCII letters, Windows and WSL file systems
  staying different).
- **Checked.** Against the registry of the proof of concept (the earlier file restored), the 4 `CHANGE 15` tests fail and the 6 others
  pass.
- **Windows: NOT TESTED.** Pure string logic (`path.win32` on any machine, `{ real: false }`). Whether Windows ever hands a hook a
  `\\?\` working directory is not known; the change makes it harmless if it does. Junctions, 8.3 short names and symbolic links
  are resolved by `realpath` in the hook only (when `real` is true, which is the default there); the core builds its registry with
  `{ real: false }` and compares strings.

## 16. The Windows hook waits for the Electron executable

- **Proof of concept.** The hook ran `node.exe`, a console program, which PowerShell always waits for. The product runs the hook with the
  application's own executable in Node mode when the PC has no Node (`runAsNode`), and the first version of that form was
  `$env:ELECTRON_RUN_AS_NODE='1'; & "<exe>" "<capture>" ...`.
- **Why that is a problem (found by reading, not by running).** `Mini-Summa.exe` is a Windows-subsystem (GUI) program. PowerShell does not
  wait for a GUI program that is the only command of its pipeline, so on Windows the hook could return before `capture.mjs` had run:
  the `SessionStart` context that carries the report protocol could be lost, and the hook's 5-second limit would not bound the script.
  The audit of the desktop shell raised this as W-11 and could not confirm it without Windows.
- **Now.** With `runAsNode` the Windows command ends with ` | Write-Output`. A call that is part of a pipeline is waited for, and its output
  is passed on to the hook's output. Without `runAsNode` (a console `node.exe`), and for POSIX and WSL, nothing changes. The script's
  output is ASCII, so PowerShell's re-encoding of it does no harm; the exit code of the hook is that of the last pipeline element, so
  it stays 0.
- **Windows: NOT TESTED.** The change follows PowerShell's documented behaviour for GUI programs (the `| Out-Null` idiom). Whether the
  old form really returned early, and that the new form waits and still delivers the protocol text, must be confirmed on a Windows PC:
  `docs/audit/windows-desktop.md`, check 8, and `docs/WINDOWS_VERIFICATION.md`.
- **Tests** (`test/setup-runasnode.test.mjs`, `test/setup-tokens.test.mjs`): the exact command with and without `runAsNode`; the settings built
  for every event carry the wait only with `runAsNode`; the other environments are byte-identical to before. These pin strings only.

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
- `Store.writeAtomic` (used by `persist` and by `promote`, which rewrites an existing candidate file) renames without a retry, so on
  Windows it can meet EPERM while the old file is open. The store is the research tooling's durable log; the Mini-Summa core keeps
  its log in SQLite and never calls it.
