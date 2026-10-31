# Qualification on a real machine

Goal: turn the NOT TESTED rows for Windows and WSL2 into PASS or FAIL, honestly. Nothing here touches your normal Claude
configuration or your repositories: everything lives in `%LOCALAPPDATA%\MiniSummaPoc` (and `~/.mini-summa-poc` in WSL), and
`qualify.mjs` hashes your normal settings before and after to prove it (Q16).

**What it costs.** Everything is free except two optional items that call a model: `--with-model` on the live run (one line, `Reply with
the single word ok.`) and Q14. Expect roughly US$0.1 to 0.2 each. Both are off by default.

**Authentication.** An isolated config directory starts logged out. Run `claude` once with it and complete Claude's own `/login`
yourself. Nothing is copied. Credentials then sit inside the config directory; delete it when finished.

**Reboots.** Nothing here restarts Windows. If `wsl --install` asks for a restart, that is your decision.

## 0. Preflight (read-only, installs nothing)
```powershell
$PSVersionTable.PSVersion; [System.Environment]::OSVersion.VersionString
node --version; git --version; claude --version
(Get-Command claude -ErrorAction SilentlyContinue).Source          # where Claude Code is installed from
winget list Anthropic.ClaudeCode 2>$null | Select-String Claude    # installed by winget?
wsl -l -v                                                          # distributions and their VERSION (needs 2)
Test-Path "$env:LOCALAPPDATA\MiniSummaPoc"                         # a previous qualification folder?
```
Reuse what is already installed; only install what is missing. Nothing in this guide touches `%USERPROFILE%\.claude`.

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
# switch to the branch that contains this guide (it lives in packages\claude-integration), then:
npm install                                           # at the repository root: the bundle test and the typecheck use esbuild and TypeScript from there
cd packages\claude-integration

npm test                                              # expect: all pass, 0 fail (the 131 proof-of-concept tests plus this package's own). Any failure is a result: copy it.
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
cd ~/Mini-Summa
# switch to the branch that contains this guide (it lives in packages/claude-integration), then:
npm install                                 # at the repository root, as on Windows
cd packages/claude-integration
npm test
node scripts/qualify.mjs run --only Q01,Q02,Q03,Q04,Q05,Q06,Q07,Q15,Q16,Q17
node scripts/qualify.mjs run --live --only Q08,Q09,Q10,Q12,Q13          # add --with-model for Q11
```
The WSL run keeps its config and repositories in `~/.mini-summa-poc` but writes its spool and reports to
`%LOCALAPPDATA%\MiniSummaPoc` through `/mnt/c/...`, which is how events cross the boundary.

Back in **PowerShell**, finish the cross-boundary test:
```powershell
node scripts\qualify.mjs run --only Q05
```
**Q18 needs one live idle session in each environment**, because an empty listing proves nothing. Shell variables do not survive across
terminal windows, so the two generated UUIDs are written to a file that every window reads. No placeholders are typed anywhere.

*Window 1 (PowerShell, the control window).* Generate the ids once and keep this window open:
```powershell
$qdir = Join-Path $env:LOCALAPPDATA "MiniSummaPoc"
@{ win = [guid]::NewGuid().ToString(); wsl = [guid]::NewGuid().ToString() } | ConvertTo-Json | Set-Content -Path (Join-Path $qdir "q18-ids.json")
Get-Content (Join-Path $qdir "q18-ids.json")
```
*Window 2 (a second PowerShell window): the Windows session.* It reads its own id from the file:
```powershell
$qdir = Join-Path $env:LOCALAPPDATA "MiniSummaPoc"
$uw = (Get-Content (Join-Path $qdir "q18-ids.json") | ConvertFrom-Json).win
$env:CLAUDE_CONFIG_DIR = Join-Path $qdir "config-win"
Set-Location (Join-Path $qdir "work\projA")
claude --session-id $uw
```
*Window 3 (Ubuntu): the WSL session.* It reads the same file through `/mnt/c`:
```bash
winla=$(wslpath "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")
ul=$(node -p "JSON.parse(require('fs').readFileSync('$winla/MiniSummaPoc/q18-ids.json','utf8')).wsl")
echo "WSL session id: $ul"
cd ~/.mini-summa-poc/work/projW && CLAUDE_CONFIG_DIR=~/.mini-summa-poc/config-wsl-Ubuntu claude --session-id "$ul"
```
Accept the folder-trust prompt ("Yes, I trust this folder") and `/login` if asked in each. Type no prompt. With both sessions idle, back in **Window 1**:
```powershell
$ids = Get-Content (Join-Path $qdir "q18-ids.json") | ConvertFrom-Json
$wslHome = (wsl -d Ubuntu -- bash -lc 'echo $HOME').Trim()
node scripts\qualify.mjs run --only Q18 --wsl-distro Ubuntu --wsl-config "$wslHome/.mini-summa-poc/config-wsl-Ubuntu" --expect-win $ids.win --expect-wsl $ids.wsl
node scripts\qualify.mjs merge "$qdir\qualification\report-win.json" "$qdir\qualification\report-wsl-Ubuntu.json"
```
Then type `/exit` in Windows 2 and Ubuntu 3, and delete the ids file: `Remove-Item (Join-Path $qdir "q18-ids.json")`.

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
| Q11 | `claude --resume` after a kill gives the same UUID and generation 2 (settled either by the resume hook landing after the snapshot, or by discovery listing a new process) | each, live, needs a prompt |
| Q12 | two registrations: raw is twice the logical count (live and synthetic) | each |
| Q13 | after `Stop-Process -Force` or `kill -9` the session ends as observed exit or suspected loss, with no SessionEnd hook. The report says which; they are different claims | each, live |
| Q14 | one real run yields a valid marker and a body equal to Claude's result | each, with model |
| Q15 | re-delivered spool files and a second ingestor process change nothing | each |
| Q16 | hash of your normal settings, CLAUDE.md, rules, commands, agents, skills and hooks is unchanged | each |
| Q17 | case, slash and trailing-separator spellings are one directory key; `wslpath -w` agrees with the canonical key | each |
| Q18 | both environments answered, each lists at least one valid session id (and the ones you started, if `--expect-*` is given), and **no id appears in both**. Empty listings, missing ids or a session that was never started give NOT TESTED; a failed query or a shared id gives FAIL | Windows, with live sessions |

PASS is recorded only in the environment that ran the test. A timeout while waiting for you is NOT TESTED, never FAIL.

**Windows note.** Native Windows has no trusted monotonic clock domain here, so hook-only ordering (a SessionEnd followed by a resume with no snapshot between) cannot be established there and shows as unresolved. This is expected, not a failure. The live flow settles it through the snapshot interval or by discovery seeing a new process.

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
3. Q11 and Q14 are PASS at least once per environment, with the understanding that Q14 shows the capture mechanism, not report-protocol reliability.
4. Q16 is PASS everywhere.
5. Any FAIL has a written cause and a fix with a regression test.
6. Report-protocol reliability is measured on a realistic sample of long tasks (not trivial ones) before any automatic hand-off relies on it.
Only then does the Claude integration layer move into the desktop application.
