# Windows and WSL2 audit of the core

Scope: `packages/core/src/claude/**`, `packages/core/src/infra/hooks.ts`, `packages/core/src/{cli,core}.ts` (data directory and
permissions), `packages/storage/src/**`, `packages/claude-integration/src/**` and `packages/shared/src/paths.ts`, with their tests.
The desktop shell, the renderer, Android and `infra/settings*.ts` were not looked at.

**Nothing in this audit was run on Windows or on WSL2.** The build machine is a Linux container. What was done instead:

* the code was read, and for the terminal library the Windows half of the shipped package was read as well
  (`apps/desktop/release/win-unpacked/.../@lydell/node-pty-win32-x64/lib/windowsPtyAgent.js` and `windowsTerminal.js`,
  version 1.2.0-beta.18; cited below as *node-pty (win32)*), because what `pty.kill()`, `pty.pid` and `encoding` do on Windows is
  decided there and cannot be seen from the Linux build;
* tests were written that inject the platform (`platform: 'win32'`), use `path.win32`, scripted PTYs, a fake `wsl.exe` and recorded
  UTF-16LE listings. **Every one of them is named or described as SIMULATED.** They show which program Mini-Summa would start, with
  which arguments, in which order, and how it reacts to what node-pty is known to do. They do not show what Windows does.

Verdicts: **OK** (read, and where it can be tested, tested; nothing found wrong), **FIXED** (a defect was demonstrated and fixed with a
regression test), **CANNOT VERIFY HERE** (cannot be decided without Windows or WSL2: the exact check is in the last section).
A FIXED row is still unverified on Windows; the fix is for a defect that is visible in the code.

## Summary of what changed

| # | Defect found | Where | Regression test |
| --- | --- | --- | --- |
| 1 | A graceful "Stop session" was recorded as "exited" and worded "The terminal process exited with code 0." | `managed.ts:673` | `managed-lifecycle.test.ts` "a graceful stop that works is still the user's stop" (and 2 more) |
| 2 | On Windows `pty.pid` is 0 when `spawn()` returns (ConPTY connects later, node-pty (win32) `windowsTerminal.js`: `_this._pid = _this._agent.innerPid`); the record stored 0 and never updated it | `managed.ts:398,656` | `windows-process-lifetime.test.ts` "records no pid (not 0) at first" |
| 3 | `encoding: 'utf8'` is passed to every spawn; on Windows node-pty prints "Setting encoding on Windows is not supported" for each terminal | `ptyHost.ts:76-86` | `windows-process-lifetime.test.ts` "does not pass `encoding` to ConPTY" |
| 4 | Stopping a session on Windows ended only what is attached to Claude's pseudo-console; children with a console of their own (MCP servers, shells) were left running, and the parent links that find them are gone once the parent is dead | `managed.ts:465-494`, `commandRunner.ts:151` | `windows-process-lifetime.test.ts` "ending a terminal also ends what Claude started" (6 tests) |
| 5 | A helper command that hangs behind the npm `claude.cmd` launcher was never ended on Windows: killing `cmd.exe` leaves `node.exe` holding the pipes, so the result never came and the discovery pass (which shares a queue with spool ingestion) waited for ever. Input was also left open | `commandRunner.ts:85-141`, `discovery.ts:75`, library `discovery.mjs:110` | `windows-process-lifetime.test.ts` "the deadline of a helper command reaches its children" (6), `windows-robustness.test.mjs` CHANGE 14 (6) |
| 6 | A WSL distribution where Claude is only on the login PATH (`~/.local/bin`, nvm) was a dead end ("make a symlink in /usr/local/bin"); `wsl.exe --exec` has no shell | `environments.ts:392-510`, `discovery.ts:98-118` | `observer-environments.test.ts` 7 SIMULATED tests, `pty-launch.test.ts` 4, `observer-windows-strings.test.ts` 1 |
| 7 | The claude launcher of a Windows npm install (`/mnt/c/.../npm/claude`, reached through the appended Windows PATH) was taken for Claude inside the distribution | `environments.ts:400-452` | `observer-environments.test.ts` "does not take the claude launcher of a Windows install" |
| 8 | wsl.exe error text (no distribution installed, WSL not enabled) printed with exit code 0 would have been offered as distribution names; Rancher Desktop's helper distributions were offered | `commandRunner.ts:160-184` | `windows-process-lifetime.test.ts` "SIMULATED WSL: decoding recorded wsl.exe listings" (5) |
| 9 | The hook's `rename(tmp, record)` was not retried: an antivirus scan or indexer holding the new file (EPERM/EBUSY on Windows) lost the hook event | library `capture.mjs:107,118` | `windows-robustness.test.mjs` CHANGE 13 (5) |
| 10 | Spool ingestion took a file that was busy for a moment (EBUSY/EPERM on read) for a damaged one and quarantined it; a busy move into `done/` aborted the pass at once | library `spool.mjs:41-100` | `windows-robustness.test.mjs` CHANGE 12 (6) |
| 11 | The per-session settings file was replaced with a bare `renameSync` (a resumed session replaces the file of its earlier run) | `settingsFile.ts:121`, `fsRetry.ts` | `windows-file-replace.test.ts` (6) |
| 12 | `\\?\C:\x` cwds and roots never matched the folder they name; `C:dev` was read as `C:\dev`; a network share got "enter an absolute path" | `paths.ts:21-32,72-74`, library `registry.mjs:19,30-35` | `paths.test.ts` (8 SIMULATED), `windows-paths.test.mjs` (10) |
| 13 | A root typed as `\\wsl$\ubuntu\...` did not match a session reported by `wsl:Ubuntu` (Windows treats the distribution name case-insensitively) | library `registry.mjs:61` | `windows-paths.test.mjs` "the distribution name is not case-sensitive" |
| 14 | The `--settings` path inside WSL assumed the `/mnt/<drive>` mount root while every other path used `wslpath -u` | `settingsFile.ts:50-85` | `pty-launch.test.ts` "follows the mount root the distribution really uses" |
| 15 | A UTF-16 `settings.json` (PowerShell's `>`, Notepad "Unicode") was reported as "check that the folder exists" | `hooks.ts:80,517` | `hooks.test.ts` "says that a UTF-16 settings.json ... is UTF-16" |
| 16 | winget installs (`Anthropic.ClaudeCode`, the command `installHelp` tells people to run) were looked for only on a PATH that may predate the install | `environments.ts:202` | `observer-environments.test.ts` "also knows where winget links claude.exe" |
| 17 | SQLite's WAL on a UNC data directory (WAL does not work over a network file system) | `db.ts:27-33,49` | `db.test.ts` "journalPragmaFor" (4) |
| 18 | The data directory outside the profile gets no warning although `chmod` does nothing on Windows | `core.ts:54-66` | `data-dir-windows.test.ts` (3) |
| 19 | The headless runner handled SIGINT and SIGTERM only; on Windows closing the console window is SIGHUP and Ctrl+Break is SIGBREAK, so terminals were left behind; handlers were also installed after the "ready" line | `cli.ts:63-72` | `cli-signals.test.ts` (3) |

## 1. Path handling

| Area | Today's behaviour | Risk | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| Drive letter case, case-insensitive match of a session cwd against roots, trailing separators, forward slashes (Git Bash `C:/x/`) | `canonicalize(p, 'win')` is `path.win32.normalize(p).toLowerCase()` with trailing separators stripped (`registry.mjs:30-45`); `rootKey` lower-cases and unifies `/` and `\` (`paths.ts:91`) | A cwd that differs only in spelling would be "unregistered" | OK | `windows-paths.test.mjs` test 1 (7 spellings match, 4 near-misses do not). SIMULATED (`path.win32` on Linux) |
| `\\?\C:\x`, `//?/C:/x`, `\\.\C:\x`, `\\?\UNC\...` | Not handled: a cwd in that form never matched; `normalizeRootInput` said "Enter an absolute path" | Silent loss of project attribution | **FIXED** (`registry.mjs:19`, `paths.ts:25`). Other uses of the prefix (`\\?\Volume{...}`) are refused/left alone | `windows-paths.test.mjs` tests 2-3 (fail on the old registry), `paths.test.ts` |
| UNC shares `\\server\share\x` | Rejected as a root (unchanged), with a message that called it "not an absolute path" | cmd.exe, which starts the npm `claude.cmd`, cannot use a UNC working directory: it prints "UNC paths are not supported. Defaulting to Windows directory" and Claude would run in `C:\Windows` | **FIXED** (message only: "A folder on a network share ... is not supported ... Map the share to a drive letter"). Not accepting shares is deliberate | `paths.test.ts`; the cmd.exe claim is CANNOT VERIFY HERE (check 7) |
| `\\wsl$\Distro\...` and `\\wsl.localhost\Distro\...` vs a WSL session's `/home/u/proj` | `normalizeRootInput` turns both spellings into `(wsl:Distro, /home/u/proj)` (`paths.ts:58-63`), so a registered root is already the Linux folder | Registered as UNC but matching only by string would never meet the Linux cwd | OK for both spellings and for `\\?\UNC\wsl$\...` (added) | `windows-paths.test.mjs` test 5; `paths.test.ts` |
| Case of the distribution name | The typed case is kept in the env id (`wsl:ubuntu`); the registry compared it exactly | A root typed in lower case never matched sessions from `wsl:Ubuntu`; two spellings of one folder could be registered twice | **FIXED** in the registry (`registry.mjs:61`: `wsl:` namespaces compare without case, Linux paths stay case-sensitive). **Not fixed**: `normalizeRootInput` still stores the typed case, and `sessions.ts` compares env ids exactly when starting a session, so such a root cannot start a session (see "Open items") | `windows-paths.test.mjs` tests 6 and 10 |
| `/mnt/c/...` vs `C:\...` | Both map to the same folder namespace (`registry.mjs:41-47`, `paths.ts:93-95`); the registry takes `config.automount` but `registryFileContents()` never supplies it | A custom `[automount] root` in `wsl.conf` breaks the mapping | OK for the default mount root; custom root CANNOT VERIFY HERE and is not mapped for attribution (the `--settings` path and the spool now do follow `wslpath`, row 14) | `windows-paths.test.mjs` test 8; `pty-launch.test.ts` |
| Distribution names with dots, dashes; with spaces | Env id pattern allows `A-Za-z0-9._-` (`shared/env.ts:13`); a name with a space is left out of the list with a note naming it (`environments.ts:370-381`) | A distribution called "My Distro" cannot be used | OK for dots/dashes (`Ubuntu-22.04` through env id, spool tag, hook command). Spaces: documented limitation, said in the UI note | `observer-environments.test.ts` "keeps a distribution whose name Mini-Summa cannot use out of the list"; `paths.test.ts` |
| Non-ASCII letters, spaces, parentheses in folder names | Pure string handling, no encoding step | None expected in the string logic | OK (SIMULATED) | `paths.test.ts`, `windows-paths.test.mjs` test 7 |
| 8.3 short names, junctions, symlinks | The hook resolves with `realpathSync.native` (`registry.mjs:75`) before matching; the core's registry is built with `{ real: false }` (`infra/projects.ts:522`) and compares strings only | A root added as a junction or short name and a cwd Claude reports as the real path attribute differently in the core than in the hook | CANNOT VERIFY HERE | check 8 |
| Windows and WSL sessions never merged | Identity is `<env>\|<uuid>` (`shared/env.ts:33`); the registry's canonical namespace is used for project attribution only | A shared folder (`/mnt/c/x`) makes the sessions of both environments belong to one project, as designed; their keys stay different | OK | `windows-paths.test.mjs` test 9 |

## 2. Finding Claude and starting a terminal

| Area | Today's behaviour | Risk | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| Finding `claude` | Settings, `overrides.claudeBin`, `MINI_SUMMA_CLAUDE_BIN`, then PATH with `claude.exe` before `claude.cmd` in every directory, then known folders (`environments.ts:190-216`): `~\.local\bin\claude.exe` (native installer), `~\.claude\local`, npm prefix, `%APPDATA%\npm\claude.cmd`, and now `%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`. No `where`, no PATHEXT; relative PATH entries are ignored | `claude.ps1` cannot be started by CreateProcess and is correctly not listed. `.exe` wins over `.cmd` even from a later PATH directory, which differs from the order a shell uses | OK; winget location **FIXED**. Order difference noted | `observer-environments.test.ts` "Windows host: finding Claude Code" (4 tests) |
| `.cmd` shim through ConPTY | `cmd.exe /d /s /c "<quoted parts>"` as ONE pre-escaped string (`ptyHost.ts:149-151`); `quoteForCmd` quotes spaces and `& \| < > ^ ( ) ! , ; =`, doubles a trailing backslash and refuses `"`, `%`, CR, LF, NUL (`ptyHost.ts:124-133`). node-pty (win32) builds `argsToCommandLine(file, []) + ' ' + args` for a string, so the line reaches CreateProcess unchanged | A profile folder with `%` makes the session refuse to start (clear message) | OK by reading; the exact behaviour of cmd.exe CANNOT VERIFY HERE | `pty-launch.test.ts` "Windows .cmd shim", `observer-windows-strings.test.ts` |
| Arguments with spaces (`--settings <path>`), cwd with spaces/non-ASCII | Arguments are an array for `.exe` and WSL; node-pty (win32) quotes with the MSVC rules (copied into the test); cwd is `path.resolve`d by node-pty and passed to ConPTY, not put on the command line | A name that both starts and ends with `"` would be treated as already quoted by node-pty; names cannot contain `"` (`normalizeSessionName`) | OK (SIMULATED round trip of quote + parse) | `pty-launch.test.ts` "arrives whole after node-pty's Windows quoting" |
| Environment scrubbing | Removes `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT/SSE_PORT/CHILD_SESSION`, `CLAUDE_CODE_SESSION_*` and `ANTHROPIC_*` except credentials/base URLs; names are upper-cased before the comparison, which is what Windows' case-insensitive names need (`managed.ts:81-108`) | None found. In a WSL launch the Windows environment does not reach the distribution except names listed in `WSLENV`, so nothing needs scrubbing there; `COLORTERM` is not forwarded (cosmetic: 256 colours at worst) | OK | `managed-lifecycle.test.ts` "environment" test |
| Initial size and resize | cols/rows go to `startProcess` (node-pty (win32) `WindowsPtyAgent`); resize is deferred until the first output and throws after exit, which `managed.resize` catches (`managed.ts:730-741`) | A resize before the first output is applied late | OK by reading | read of `windowsTerminal.js` |
| Writing input | Enter and "approve" are `\r`, reject is ESC, stop is `\x03`, multi-line text is one bracketed paste followed by `\r` 150 ms later (`keys.ts:20-35`) | `\r\n` would be two Enters on ConPTY; the code never sends it. Whether ConPTY hands bracketed-paste sequences to Claude unchanged is not knowable here | OK in code; behaviour CANNOT VERIFY HERE | checks 3 and 4 |
| `pty.pid` and `encoding` | see summary rows 2 and 3 | | **FIXED** | |
| WSL launch | `wsl.exe -d D --cd <linux cwd> --exec <file> <prefix...> <args...>` with `wsl.exe` by full path (`ptyHost.ts:142-146`, `managed.ts` passes `systemProgramPath`). `--exec` runs no shell | A user-level `claude` (`~/.local/bin`, nvm) is not on the PATH `--exec` sees. Env: only the WSL defaults; nothing from Windows is passed | **FIXED**: the probe finds Claude and Node.js plain first, and only if the plain lookup lacks one of them tries `sh -lc 'exec claude "$@"'` and then `bash -lic`, and the launch and discovery use exactly the command that worked (`environments.ts:392-510`). The script is fixed text; every variable part is an argument. If both are found plain nothing changes | `observer-environments.test.ts` (7), `pty-launch.test.ts` (4: quoting round trip included). SIMULATED. zsh/fish-only PATH setups are not covered |
| `--settings` file as WSL sees it | Written under `<dataDir>\managed-settings\wsl-D\` on the Windows side and passed as `/mnt/<drive>/...` | Custom mount root | **FIXED** (row 14); default unchanged | `pty-launch.test.ts` |
| wsl.exe missing, distribution stopped | Listing failure → no WSL environments, no note (`environments.ts:370-375`). A stopped distribution is started by the probe (20 s limit); a timeout gives "Mini-Summa could not start D: ... Open it once from the Start menu" (`environments.ts:449`); a launch of a stopped distribution lets wsl.exe start it | A user with WSL but a failing listing sees no hint | OK (acceptable); real wsl.exe exit codes in "The terminal process exited with code N" CANNOT VERIFY HERE | `observer-environments.test.ts` "says so when the distribution cannot be started at all", "lists only the Windows host when wsl.exe is not installed" |

## 3. WSL discovery

| Area | Today's behaviour | Risk | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| UTF-16LE output with/without BOM, CR LF, stray NULs | `decodeCommandOutput` handles BOM LE and BE, BOM-less LE by a zero-byte heuristic (even length, ≥40 % NULs in odd positions, none in even), UTF-8 with BOM, else UTF-8 (`commandRunner.ts:35-64`); `parseWslDistroList` removes NULs, BOM, U+FFFD, CR (`:180`) | A BOM-less listing with an odd byte count falls back to UTF-8 decoding; the NULs are then stripped, which is right for ASCII names | OK | `windows-process-lifetime.test.ts` "SIMULATED WSL: decoding recorded wsl.exe listings" (UTF-16LE with and without BOM, CR LF, trailing NUL, odd length) |
| Localized output | `-l -q` prints names only, so the happy path is language-independent. Error texts are localized | An error text printed with exit code 0 would have been read as names (and produced one note per line) | **FIXED**: a text with a `Wsl/...` or `WSL_E_...` error code (never localized) is not a listing | same tests (English and German) |
| Default marker | `-q` prints none; the English `(Default)` is stripped; nothing else in parentheses is touched ("Ubuntu (Work)") | Other languages' markers are not stripped, but `-q` never prints one | OK | same tests |
| Stopped state | Not read: `-l -q` lists registered distributions; a stopped one is started by the first `--exec` | First probe takes seconds; 20 s limit | OK | |
| Docker Desktop / Rancher Desktop helpers | `docker-desktop*` skipped; `rancher-desktop` and `rancher-desktop-data` now too | | OK / **FIXED** (Rancher) | same tests |
| WSL1 vs WSL2 | Nothing reads the version (`-l -v` is not used) | WSL1 has no real Linux kernel; `wslpath` and `\\wsl$` exist in both | CANNOT VERIFY HERE | check 12 |

## 4. Persistence

| Area | Today's behaviour | Risk | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| SQLite WAL on Windows | `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000` (`db.ts:48-50`). Non-ASCII/space paths go to SQLite as UTF-8, which it converts for Windows | Network share: WAL is unsafe. Antivirus on `-wal`/`-shm`: the 5 s busy timeout covers short holds. `%APPDATA%` is the *roaming* profile: with roaming/redirected profiles a large database moves at logon and may sit on a share | **FIXED** for UNC paths (rollback journal, `synchronous = FULL`). Roaming: documented, not changed (the desktop shell chooses the folder) | `db.test.ts` "journalPragmaFor"; WAL/AV/non-ASCII CANNOT VERIFY HERE (check 9) |
| Every temp + rename | See the table below | | | |
| JSON written by Windows tools: BOM, CRLF | `hooks.ts` reads bytes with `ignoreBOM: true`, `parseSettings` strips and remembers the BOM (`:290`), `serialize` writes BOM, CRLF, indent and final newline back (`:310`); the backup is a byte copy (`:100-109`); nothing is rewritten for a no-op plan | A UTF-16 file is not valid for Claude Code either; it was reported as "check that the folder exists" | OK for BOM/CRLF; message **FIXED** for UTF-16 | `hooks.test.ts` "formatting is preserved" (a byte order mark, BOM + CRLF + tabs, 8 cases), and the 2 new UTF-16/Windows-1252 tests |
| Default data directory | `cli.ts:17-19`: `%APPDATA%\Mini-Summa\data` (fallback `~\AppData\Roaming`). `core.ts` takes the directory it is given; the desktop shell passes its own | The shell must pass the same folder SECURITY.md names | OK for the CLI; the desktop value is outside this audit (check 10) | |
| Permissions | `restrictPermissions` does nothing on win32 (`core.ts:33-34`). No code relies on a mode for secrecy: the other chmod/mode uses are try/catch'd or harmless (`settingsFile.ts`, `push.ts:306`, `hooks.ts` `mkdirp`, spool). SECURITY.md already says the profile's ACL is the protection | A data directory outside the profile (another drive, a share) inherits that drive's/share's permissions, often readable by "Authenticated Users" | **FIXED**: `dataDirAdvice` logs a warning when the directory is outside `%USERPROFILE%` | `data-dir-windows.test.ts` |

Every temp + rename in the code base:

| Where | Retry before | Now | Note |
| --- | --- | --- | --- |
| Hook record `.tmp-<id>` to `<mono>-<id>.json` (`capture.mjs:107,118`) | none | 8 attempts, 10 to 640 ms, sync | the hook has 5 s; exit code stays 0 whatever happens |
| Ingestor move to `done/` and `quarantine/` (`spool.mjs:51`) | none | 7 attempts, 10 to 320 ms for EBUSY/EPERM, then the error (file stays pending; the append is idempotent) | a busy file at read time is skipped, not quarantined |
| `registry.json` (`registryFile.ts:17`) | 6 retries, 15 ms doubling, EPERM/EBUSY/EACCES | unchanged | |
| Per-session settings file (`settingsFile.ts:121`) | none | same helper, sync (`fsRetry.ts`), temp file removed on failure | the call has to stay synchronous |
| `settings.json` of the hook installer (`hooks.ts:115`) | 4 retries x 60 ms | unchanged | a longer wait would be harmless; kept |
| FCM key (`infra/push.ts:307`) | none | not changed (file not mine) | rare: only on import |
| `core.log` rotation (`core.ts:75`) | none; failure swallowed | unchanged | the log may then grow |
| Desktop `windowState.ts:77`, `log.ts:44` | none | not mine | reported |
| PoC `Store.writeAtomic` (`store.mjs:17`) | none | unchanged | research tooling, the core uses SQLite |

## 5. Hooks on Windows and WSL2

The exact command lines (generated by `hookCommand`; `Stop` as the event, `ms-managed` as the handler):

```text
win     (shell: "powershell", timeout 5)
$env:ELECTRON_RUN_AS_NODE='1'; & "C:\Users\me\AppData\Local\Programs\Mini-Summa\Mini-Summa.exe" "C:\Users\me\AppData\Local\Programs\Mini-Summa\resources\hook\capture.mjs" --spool "C:\Users\me\AppData\Roaming\Mini-Summa\data\spool\win" --registry "C:\Users\me\AppData\Roaming\Mini-Summa\data\registry.json" --env win --handler ms-managed Stop

wsl:Ubuntu-22.04   (no shell field: Claude's own shell inside the distribution, timeout 5)
"node" "/mnt/c/Users/me/AppData/Local/Programs/Mini-Summa/resources/hook/capture.mjs" --spool "/mnt/c/Users/me/AppData/Roaming/Mini-Summa/data/spool/wsl-Ubuntu-22.04" --registry "/mnt/c/Users/me/AppData/Roaming/Mini-Summa/data/registry.json" --env wsl:Ubuntu-22.04 --handler ms-managed Stop

posix
"/usr/bin/node" "/opt/ms/capture.mjs" --spool "..." --registry "..." --env posix --handler ms-managed Stop
```

| Area | Today's behaviour | Risk | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| Quoting | Paths are in double quotes; `"`, backtick, `$`, CR, LF and U+201C to U+201E are refused for PowerShell, `"`, `$`, backtick, CR, LF for POSIX/WSL (`setup.mjs:11,49-71`); handler/event/env are quoted or refused | A profile folder with `$` or a typographic double quote is refused with a clear message; `'`, `%`, `&`, `(`, `)` are fine inside the quotes | OK (existing tests; PowerShell never run) | `setup-powershell-quotes.test.mjs`, `setup-tokens.test.mjs` |
| `ELECTRON_RUN_AS_NODE` and the single-instance lock | The variable is set inside the PowerShell command only, so Claude's environment is untouched. In run-as-node mode Electron does not run the application's main script, where `requestSingleInstanceLock` lives. The electron-builder configuration does not flip the RunAsNode fuse | If the fuse were off the executable would open the whole application for every hook event | OK by reading; CANNOT VERIFY HERE | check 5 |
| Where a WSL distribution's `~/.claude/settings.json` is read and written | By the Windows core through the UNC path `\\wsl.localhost\<D>\home\<u>\.claude\settings.json` (`wslPathToWindows`, `envPaths.ts:51`; `hooks.ts:496,510,115`), with normal file calls, not `wsl.exe`. Backups go to `<dataDir>\backups` on the Windows side (`hooks.ts:539`). The plan hash is `sha256(env + action + settingsPath + before + after [+ link target])` (`hooks.ts:628`), so it names the UNC path | `\\wsl.localhost` may not resolve on older Windows 10 builds (`\\wsl$` is the older spelling and is read everywhere else); the distribution must be running (the share starts it); an atomic rename over the 9P redirector, a Linux symlink seen from Windows, and `chmod` over 9P are unverified | CANNOT VERIFY HERE | check 11 |
| Where the spool is and how Windows reads what a WSL hook wrote | `<dataDir>\spool\wsl-<D>` on the Windows drive; the hook in the distribution writes through `/mnt/<drive>/...` (the path comes from `wslpath -u`, falling back to the string rule, `environments.ts:475-480`); the core polls it with normal file calls every 700 ms (`ingestion.ts`) | Latency is the DrvFs write plus up to 700 ms. DrvFs ignores the modes the hook asks for (0700/0600); the Windows ACL of the data directory is the protection. Transient locks are now retried on both sides | OK by reading; latency and DrvFs behaviour CANNOT VERIFY HERE | check 11 |
| The hook runtime in WSL | Needs `node` in the distribution; probed plain and, if missing, through the login shell (the hooks run with Claude's PATH). Missing → environment note "Node.js was not found inside D, so hooks cannot run there" and `no_hook_runtime` (422) with "Install Node.js 22 or newer there ... The session was not started" (`settingsFile.ts:84-90`) | A clear message, not a silent failure. The version is not compared: an old Node would fail to load the script and Claude would show a (non-blocking) hook error | OK; version CANNOT VERIFY HERE | `observer-environments.test.ts` "explains missing Node.js", `managed-settings.test.ts` |
| Exit code 0 | `process.exit(0)` after `try/catch` around the whole capture (`capture.mjs:22-27`) | A failure before the script runs (the executable moved, a Node too old to parse the script) exits non-zero; Claude Code treats any exit other than 2 as non-blocking | OK; real behaviour CANNOT VERIFY HERE | check 5 |

## 6. Process lifetimes

| Area | Today's behaviour | Risk | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| `pty.kill()` on ConPTY | node-pty (win32) `WindowsPtyAgent.kill`: with the default (inbox ConPTY, no `useConptyDll`) it forks a helper that lists the processes attached to the console, `process.kill`s each, closes the pseudo-console and disposes the output worker. `kill('SIGTERM')` throws on Windows; the adapter never passes a signal there (`ptyHost.ts:67`) | Children with their own console are not on that list; the helper takes up to 5 s to answer | **FIXED** for the tree (summary row 4) | `windows-process-lifetime.test.ts` |
| After the grace period | Ctrl-C twice repeated for 4 s, then (Windows) `taskkill /pid N /T /F` by full path, then `kill()`, then a second `kill()` after 1 s (`managed.ts:475-494`) | The second `kill()` is the same call; harmless | OK / FIXED | |
| `process.kill(-pid)`, SIGTERM/SIGINT meanings | No production code uses a negative pid (only the fake CLI does); the only signals sent are through `pty.kill`, which ignores them on Windows | | OK | grep |
| App quit order | `core.stop()`: HTTP server, Tailscale, actions, orchestrator, `sessions.shutdown()` which ends the terminals (`managed.shutdown`: grace 1.5 s, tree kill, `app_exit`), then `db.close()` (`core.ts` `stop`) | The desktop shell must `await core.stop()` before it exits; not in this audit's scope | OK in the core; shell CANNOT VERIFY HERE | check 6 |
| Orphaned `conhost.exe` / `OpenConsole.exe` | The default is the inbox conhost; `ClosePseudoConsole` is part of `kill()` | | CANNOT VERIFY HERE | check 6 |
| Hanging `claude agents --json` and version checks | 20 s (30 s for WSL) and 10 s limits existed. On Windows the limit now ends the tree first; input is closed at once | see summary row 5 | **FIXED** | `windows-process-lifetime.test.ts`, `windows-robustness.test.mjs` |
| WSL terminals | The PTY process is `wsl.exe`; ending it should hang up the Linux side | A `claude` left running in the distribution | CANNOT VERIFY HERE | check 12 |

## 7. Permissions and security on Windows

| Area | Today's behaviour | Verdict | Evidence |
| --- | --- | --- | --- |
| Loopback only | `listen(port, '127.0.0.1')` (`http/server.ts:294`). Binding to the loopback address only is what keeps the Windows firewall from asking | OK; the absence of a prompt CANNOT VERIFY HERE (check 1) | |
| Host/Origin checks | String-level, independent of the platform | OK | existing HTTP tests |
| Tokens | The desktop token is generated per run and kept in memory (`devices.ts:142`); device tokens are stored as SHA-256 only; the FCM key is `<dataDir>\secrets\fcm-service-account.json` (`push.ts:3,111`) written with 0600, which Windows ignores | OK: the data directory's ACL is the protection, as SECURITY.md says; the new warning covers directories outside the profile | `data-dir-windows.test.ts` |
| Secrets in command lines | Hook commands carry paths, the handler, the event and the environment id only. Claude is started with `--session-id`, `--settings`, `--name`, `--remote-control` (stored with `redactArgv`, `managed.ts:109`). `taskkill` gets a pid, `wsl.exe` a distribution and a folder. Keys such as `ANTHROPIC_API_KEY` travel in the environment block, not on the command line | OK | `managed-argv.test.ts`, `windows-process-lifetime.test.ts` |

## Open items in files that are not mine

* `packages/core/src/claude/sessions.ts:701` (`start`: `(await environments.list()).find((e) => e.id === env)`): the comparison is exact, so
  a project root typed as `\\wsl$\ubuntu\...` (env `wsl:ubuntu`) answers "not available" although `environments.layout()` matches the name
  without case. Either canonicalize the distribution against the listing when a root is created (`infra/projects.ts` `prepareRoot`) or
  compare without case in `start` and use `info.id`.
* `apps/desktop/src/main/windowState.ts:77` and `log.ts:44` rename without a retry; `infra/push.ts:307` too.
* `docs/LIMITATIONS.md` section 3, the bullet "After a graceful Stop session the notice says ... exited with code 0", is fixed and can go.
* `packages/claude-integration/docs/CHANGES-FROM-POC.md` should list the library changes below as 12 to 15.
* `docs/WINDOWS_VERIFICATION.md` can take the checks of the last section.

## Library changes for `CHANGES-FROM-POC.md`

| # | File | Change | Tests (titles start with `CHANGE n:`) |
| --- | --- | --- | --- |
| 12 | `src/lib/spool.mjs` | A file that is EBUSY/EPERM when read is skipped, not quarantined; a move that meets EBUSY/EPERM is retried (10 to 320 ms) and then reported; other errors propagate at once | `windows-robustness.test.mjs` |
| 13 | `src/hook/capture.mjs` | The rename of the record is retried 7 times (10 to 640 ms) for EPERM, EBUSY, EACCES; the exit code is still 0 | `windows-robustness.test.mjs` |
| 14 | `src/lib/discovery.mjs` | `runAgentsJson` keeps its deadline in `execWithDeadline` (not part of the package API): on Windows the process tree is ended before the process, and the command's input is closed at once | `windows-robustness.test.mjs` |
| 15 | `src/lib/registry.mjs` | `\\?\` and `\\.\` forms of drive and UNC paths are read as the path they name; `wsl:` namespaces compare without case | `windows-paths.test.mjs` |

## Must be verified on a real Windows PC / real WSL2

Each item says what to do and what you should see. If you see something else, note the number and keep `%APPDATA%\Mini-Summa\data\logs`.

1. **No firewall prompt.** Start Mini-Summa for the first time on a PC that has never run it. *Expect:* no Windows Defender Firewall dialog.
2. **Claude is found.** Install Claude Code once with each of: the native installer, `npm install -g @anthropic-ai/claude-code`, `winget install Anthropic.ClaudeCode`; start Mini-Summa after each. *Expect:* the first screen names the path (`claude.exe` under `.local\bin`, `claude.cmd` under `%APPDATA%\npm`, the WinGet `Links` folder) and a version.
3. **A session starts in a folder with spaces and non-ASCII letters**, for each launcher (a `.exe` and a `.cmd`). *Expect:* Claude runs in that folder (type `pwd` or ask it), the session label shows its pid (not 0) within a second, and the terminal prints no "Setting encoding on Windows is not supported".
4. **Keys.** In a managed session: approve a permission from Mini-Summa; send a prompt of three lines from the phone or the desktop. *Expect:* one Enter per answer (the dialog closes once, no extra empty prompt) and the three lines arrive as ONE prompt. Resize the window while Claude is working. *Expect:* the terminal redraws, no crash.
5. **Hooks.** Start a session and run any tool. In Task Manager's Details tab watch the processes during a hook. *Expect:* a `powershell.exe` and a `Mini-Summa.exe` that live for well under a second and are not followed by a second Mini-Summa window or tray icon; a file appears in `%APPDATA%\Mini-Summa\data\spool\win` and moves to `done\` within a second; the first-hook latency of one tool call stays small. Rename `Mini-Summa.exe` for a moment and run a tool: *Expect:* Claude continues and shows a non-blocking hook error. Repeat with Defender real-time protection on; *expect* `capture-errors.log` stays absent (the rename retry).
6. **Stop and quit leave nothing behind.** Start a session that has an MCP server or runs `git`/a long `node` script, then (a) Stop, (b) force stop, (c) quit Mini-Summa from the tray while a session runs. *Expect* in Task Manager after 5 s: no `claude`/`node`/`git`/MCP child of that session, no stray `conhost.exe`/`OpenConsole.exe`, and the notice reads "You stopped the session." for (a) and (b) and "Mini-Summa was closed while it was running." for (c). Check the desktop shell awaits `core.stop()` before it exits.
7. **A folder on a network share** (`\\server\share\repo`) in the project dialog. *Expect:* the message about network shares. Optional: in a plain `cmd.exe` run `pushd`-less `cd \\server\share` and confirm it prints "UNC paths are not supported".
8. **Junction, 8.3 name, subst/mapped drive.** Register a project through a junction to the real folder, start a session, and look at which project the session lands in; repeat with the real path as the project folder and the junction as the cwd. *Expect:* the same project. If not, the core's string-only matching (row 1, junctions) needs the same `realpath` the hook uses.
9. **The database.** Use a profile name with spaces and non-ASCII letters; start, create a project, quit, start. *Expect:* it opens; `mini-summa.db-wal` appears next to the database while running and is gone after a clean quit. With Defender on, create 50 sessions' worth of activity (or run `npm run verify`); *expect* no "database is locked" in `core.log`.
10. **Data folder.** *Expect:* `%APPDATA%\Mini-Summa\data` with `mini-summa.db`, `logs`, `spool`; `icacls` on it lists only your account, SYSTEM and Administrators. Start with `--data-dir D:\ms` (headless CLI): *expect* the "outside your Windows profile" warning in the console and `core.log`.
11. **Hooks inside WSL2.** With Node.js in the distribution, install hooks for the WSL environment from Settings. *Expect:* the diff is for `\\wsl.localhost\<Distro>\home\<you>\.claude\settings.json` (also check that this path opens in Explorer on that Windows version; if only `\\wsl$\<Distro>` opens, the installer's file access fails and `wslPathToWindows` must use `\\wsl$`); a backup appears in `%APPDATA%\Mini-Summa\data\backups`; the file keeps its CRLF/BOM if it had them. Then start `claude` in the distribution's own terminal. *Expect:* hook files appear in `%APPDATA%\Mini-Summa\data\spool\wsl-<Distro>` within a second and are ingested. Remove Node.js from the distribution: *expect* the note "Node.js was not found inside <Distro>" and, on start, "none was found in WSL" and no session. With Node 12 to 18 in the distribution, note whether the hook errors.
12. **A managed WSL session.** Install Claude inside the distribution (a) as root in `/usr/local/bin`, (b) the native installer (`~/.local/bin`), (c) through nvm. *Expect:* (a) plain `claude`, no note; (b) and (c) the note "starts it through a login shell (sh -lc)" or "(bash -lic)", and the session starts in the project folder given as `/home/...`. Stop the session. *Expect:* `ps aux | grep claude` inside the distribution shows nothing left. Stop the distribution (`wsl --terminate`), start a session: *expect* it starts after a few seconds, or a clear message. Do this on WSL1 and on WSL2 if both exist. Install the Windows npm Claude only (not in the distribution): *expect* the distribution is "not found" with the note about the Windows installation.
13. **wsl.exe edge cases.** `wsl --list -q` in a PowerShell on a PC with no distribution: *expect* Mini-Summa lists only Windows and no strange names. With Docker Desktop or Rancher Desktop installed: *expect* none of their helper distributions in the list. With a distribution called `Ubuntu-22.04`: *expect* it listed as `wsl:Ubuntu-22.04` and sessions start.
14. **Custom mount root.** Put `[automount]\nroot = /windir/` in the distribution's `/etc/wsl.conf`, restart it, start a managed session. *Expect:* it starts and its hooks reach the spool (the `--settings` path is `/windir/c/...`). Attribution of a project registered on a `C:` drive from that distribution is not guaranteed in that setup.
15. **`settings.json` encodings.** Make a `settings.json` with PowerShell 5.1 (`'{}' > settings.json`). *Expect:* Settings, Hooks, Install shows the UTF-16 message and the file is untouched. Save it as UTF-8 with BOM and CRLF: *expect* install works and the file keeps both.
16. **Headless runner.** `npm run core` in a console, start a session, close the console window (or Ctrl+Break). *Expect:* "Stopping on SIGHUP" or "SIGBREAK" is not visible once the window is gone, but Task Manager shows no `claude` left after a few seconds.

Not covered by anything in this file, for completeness: the folder picker, the tray, toasts, the installer, `minisumma://` links and the real ChatGPT site (see [WINDOWS_VERIFICATION.md](../WINDOWS_VERIFICATION.md)).
