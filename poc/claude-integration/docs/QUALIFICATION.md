# Qualification on a real machine

Goal: turn the NOT TESTED rows for Windows and WSL2 into PASS or FAIL, honestly. Nothing here touches your normal Claude
configuration or your repositories: everything lives in `%LOCALAPPDATA%\MiniSummaPoc` (and `~/.mini-summa-poc` in WSL), and
`qualify.mjs` hashes your normal settings before and after to prove it (Q16).

**What it costs.** Everything is free except two optional items that call a model: `--with-model` on the live run (one line, `Reply with
the single word ok.`) and Q14. Expect roughly US$0.1 to 0.2 each. Both are off by default.

**Authentication.** An isolated config directory starts logged out. Run `claude` once with it and complete Claude's own `/login`
yourself. Nothing is copied. Credentials then sit inside the config directory; delete it when finished.

**Reboots.** Nothing here restarts Windows. If `wsl --install` asks for a restart, that is your decision.

## A. Native Windows (PowerShell)
```powershell
# prerequisites (skip what you have)
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Anthropic.ClaudeCode           # or: irm https://claude.ai/install.ps1 | iex
node --version; git --version; claude --version      # Node must be 22 or newer

# get the code (a new PowerShell window after the installs)
git clone https://github.com/FarmaanFJM/Mini-Summa.git
cd Mini-Summa
git switch research/claude-integration-poc
cd poc\claude-integration

npm test                                              # expect: 106 pass, 0 fail. Any failure is a result: copy it.
node scripts\qualify.mjs run                          # non-interactive tests Q01 to Q04, Q06, Q07, Q15 to Q17
```
Interactive run (free). The script prints a command; paste it into a **second** PowerShell window. Accept the folder-trust
prompt with "Yes, I trust this folder" (the default is No). Do not type a prompt.
```powershell
node scripts\qualify.mjs run --live --only Q08,Q09,Q10,Q12,Q13
```
Resume needs one real exchange, because a session that never received a prompt is not saved:
```powershell
node scripts\qualify.mjs run --live --with-model --only Q08,Q09,Q10,Q11,Q12,Q13
node scripts\qualify.mjs run --with-model --only Q14        # optional: one real report capture
```
Reports: `$env:LOCALAPPDATA\MiniSummaPoc\qualification\report-win.json`.

## B. WSL2 (Ubuntu)
```powershell
# PowerShell
wsl --status
wsl -l -v                                  # the distribution must show VERSION 2
wsl --install -d Ubuntu                    # only if missing; a restart may be requested, your choice
```
```bash
# inside Ubuntu
sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
curl -fsSL https://claude.ai/install.sh | bash           # see https://code.claude.com/docs/en/setup
node --version; claude --version
cmd.exe /c "echo %LOCALAPPDATA%"            # must work: WSL interop is how the Windows side is found

git clone https://github.com/FarmaanFJM/Mini-Summa.git ~/Mini-Summa        # keep the clone on the Linux file system
cd ~/Mini-Summa && git switch research/claude-integration-poc && cd poc/claude-integration
npm test
node scripts/qualify.mjs run --only Q01,Q02,Q03,Q04,Q05,Q06,Q07,Q15,Q16,Q17
node scripts/qualify.mjs run --live --only Q08,Q09,Q10,Q12,Q13          # add --with-model for Q11
```
The WSL run keeps its config and repositories in `~/.mini-summa-poc` but writes its spool and reports to
`%LOCALAPPDATA%\MiniSummaPoc` through `/mnt/c/...`, which is how events cross the boundary.

Back in **PowerShell**, finish the cross-boundary test and the separate discovery of WSL sessions:
```powershell
node scripts\qualify.mjs run --only Q05
node scripts\qualify.mjs run --only Q18 --wsl-distro Ubuntu --wsl-config /home/YOURNAME/.mini-summa-poc/config-wsl-Ubuntu
node scripts\qualify.mjs merge "$env:LOCALAPPDATA\MiniSummaPoc\qualification\report-win.json" "$env:LOCALAPPDATA\MiniSummaPoc\qualification\report-wsl-Ubuntu.json"
```

## C. Tests and what makes each one PASS
| ID | Passes when | Runs in |
|---|---|---|
| Q01 | `claude --version` runs and parses | each environment |
| Q02 | isolated config written; setup refuses the normal directory | each |
| Q03 | the exact hook command from `settings.json` exits 0, prints no decision, writes a parseable spool file, for all nine events, also under a path with spaces; PowerShell is the shell on Windows | each |
| Q04 | 30 concurrent hooks, a reader polling throughout sees no partial file and no temp residue | each |
| Q05 | 20 events written from WSL are ingested on Windows with `env_id wsl:*` and none missing | WSL then Windows |
| Q06 | events ingest; the report equals the Stop message byte for byte; project is correct | each |
| Q07 | `claude agents --json` works against the isolated config | each |
| Q08 | a session started by a human in another terminal is listed | each, live |
| Q09 | `--session-id`, hook `session_id` and the listing agree | each, live |
| Q10 | it maps to the expected project | each, live |
| Q11 | `claude --resume` after a kill gives the same UUID and generation 2 | each, live, needs a prompt |
| Q12 | two registrations: raw is twice the logical count (live and synthetic) | each |
| Q13 | after `Stop-Process -Force` or `kill -9` the session ends as observed exit or suspected loss, with no SessionEnd hook | each, live |
| Q14 | one real run yields a valid marker and a body equal to Claude's result | each, with model |
| Q15 | re-delivered spool files and a second ingestor process change nothing | each |
| Q16 | hash of your normal settings, CLAUDE.md, rules, commands, agents, skills and hooks is unchanged | each |
| Q17 | case, slash and trailing-separator spellings are one directory key; `wslpath -w` agrees with the canonical key | each |
| Q18 | Windows lists its sessions and the WSL distribution's separately, with no overlap | Windows |

PASS is recorded only in the environment that ran the test. A timeout while waiting for you is NOT TESTED, never FAIL.

## D. Native Windows and WSL2 in one registry
Each project root is `{env, path}`. Paths are canonicalized into one of three namespaces before comparison:
`C:\Dev\App`, `c:/dev/app` and `/mnt/c/Dev/App` seen from WSL are the same directory; `\\wsl$\Ubuntu\home\u\app` equals `/home/u/app` inside
Ubuntu; the same POSIX path in two distributions, or in WSL and on a Linux host, is different. Sessions are keyed by (environment, session id),
so identical-looking ids or paths in two environments cannot be confused, while one project can still collect sessions from both.

## E. Send back
Send `qualification\report-*.json` (paths, user names and session ids are already scrubbed) and any failing `npm test` output.
Do not send config directories, spools or stores.

## F. Clean up
```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\MiniSummaPoc"      # only this folder
```
```bash
rm -rf ~/.mini-summa-poc
```

## G. Acceptance criteria for the next phase
1. `npm test` passes on Windows and on WSL2.
2. Q01 to Q04, Q06 to Q10, Q12, Q13, Q15 to Q17 are PASS on native Windows; Q05, Q18 PASS across the boundary; the same set is PASS inside WSL2.
3. Q11 and Q14 are PASS at least once per environment, with the understanding that Q14 shows the mechanism, not reliability.
4. Q16 is PASS everywhere.
5. Any FAIL has a written cause and a fix with a regression test.
6. Report-protocol reliability is measured on a realistic sample of long tasks (not trivial ones) before any automatic hand-off relies on it.
Only then does the Claude integration layer move into the desktop application.
