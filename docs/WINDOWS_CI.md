# Windows CI: what it proves and what it does not

[`.github/workflows/windows.yml`](../.github/workflows/windows.yml) runs Mini-Summa on **native Windows** (GitHub-hosted
`windows-latest`) on every push to a `feat/**` branch, every pull request, and on demand (Actions, "Windows", Run workflow).
It exists to catch POSIX assumptions and installer problems early, and to hand you an installer whose origin you can check.
It does **not** replace the checklist in [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md): a runner has no human, no
signed-in ChatGPT or Claude, and no real notification centre. Read "What CI proves and what only a person can prove" below
before trusting a green tick.

The first runs are expected to be red in places. Test steps have no `continue-on-error` and nothing is skipped, so a POSIX
assumption in a test shows up as a failing `unit` job. That is information, not noise.

## The jobs

| Job | Runs | Proves |
| --- | --- | --- |
| `typecheck` | `npm ci`, `npm run typecheck` (every workspace), and `node --test scripts/windows/lib/helpers.test.mjs` | The TypeScript compiles with Windows installs of the dependencies. The helper tests cover the pure code of the installed-app script. |
| `unit` (matrix, `fail-fast: false`) | One job per workspace: `shared`, `storage`, `claude-integration`, `core`, `desktop`, `browser-extension`. Each does `npm ci`, builds the hook bundle, then `npm test -w <package>`. `desktop` runs both vitest projects (renderer in jsdom, node). | The existing unit and integration tests pass on Windows paths, line endings (Git for Windows default `autocrlf`), locking and process behaviour. Failures are POSIX assumptions to fix, or tests that simulate Windows and are wrong about it. |
| `package` | `npm ci`, native `npm run dist:win` (no wine: NSIS and rcedit run for real), then `BUILD-INFO.txt` and `SHA256SUMS.txt`; uploads artifact `mini-summa-windows-installer`. Fails if the installer is missing. | The installer builds natively. This is the first time the NSIS include script (`apps/desktop/build/installer.nsh`) is compiled and run on Windows, and the first installer not assembled under wine. |
| `installed-checks` (needs `package`) | Downloads that artifact, checks it against `SHA256SUMS.txt` and the commit, installs Claude Code from npm (unauthenticated, only for discovery), then runs `scripts/windows/installed-smoke.mjs` in four steps: `install`, `smoke`, `uninstall`, `report`. | The installed application behaves as described below. Output: `windows-installed-report.md` in the job summary and in the artifact `windows-installed-report`. |

Every job uploads its logs with `if: always()` (`logs-typecheck`, `logs-unit-<workspace>`, `logs-package`, and inside
`windows-installed-report` for the installed checks, together with `results.json` and copies of the app's `main.log`,
`core.log` and `capture-errors.log`). Each check in the installed-app script prints `PASS`, `FAIL`, `NOT RUN` (with the
reason) or `INFO` (a measurement that proves nothing by itself); the script exits non-zero on any `FAIL`.

### What `installed-smoke.mjs` does, check by check

1. `install`: silent per-user install (`<installer> /S`, waited for by process, then polled for the files). Asserts
   `%LOCALAPPDATA%\Programs\Mini-Summa\Mini-Summa.exe`, `resources\hook\capture.mjs`, the ConPTY files (`conpty.dll`,
   `OpenConsole.exe`, the pty `.node`, none of them inside `app.asar`), the `minisumma://` key under HKCU pointing at the installed
   exe, a per-user uninstall entry (HKCU yes, HKLM and WOW6432Node no), no copy in Program Files. Reports the elevation of the
   job (`WindowsPrincipal`). **The runner account is an administrator**, so "no UAC prompt appeared" cannot be shown by the job
   being unelevated; the evidence offered instead is that the installer's embedded manifest asks for no elevation (when that text
   can be found in the file) and that nothing was written outside per-user locations.
2. `smoke`, launch and persistence: starts the installed exe through Playwright `_electron.launch({ executablePath })`, waits for
   the window, reads `window.miniSumma.connection()`, then through the core's HTTP API creates a project with `githubRepo` and
   `chatgptProject` and **no folder**; adds a temp folder (its name contains a space and an accented letter) as a root and reads
   it back; shows that a missing folder is refused with a message and stores nothing; writes the window's remembered state
   (`ui.route`, `ui.perProject.<id>.cloudUrl`, and a per-project `chatgptUrl` only if the field exists in `packages/shared`,
   otherwise the report says "NOT YET PRESENT"); quits with `app.quit()` and checks no `Mini-Summa.exe` is left; launches the same
   exe again and compares everything read back, field by field. If the packaged build cannot be driven by Playwright (a fuse
   disabling the inspector, for instance) the script says so, falls back to a plain launch plus `GET /api/v1/health` and the files
   on disk, and marks every check that needs the API token `NOT RUN`.
3. Environments: `environments.list` must list the host Windows environment as available. If `claude --version` works from the
   job, the core must report the same version; if the npm install of Claude Code failed, that part is `INFO`/`NOT RUN` with the reason.
4. PowerShell hook behaviour (audit item W-11, [audit/windows-desktop.md](audit/windows-desktop.md)):
   * 4.1 repeats step 11 of the manual checklist with the **installed** exe: a 3 second Node child through Windows PowerShell,
     with and without `| Write-Output`, timed with `Measure-Command`. The piped call must take about 3 s.
   * 4.2 asks the running core for `hooks.plan` (action `install`, environment `win`) **without applying it**, takes the
     `SessionStart` and `Stop` commands from `plan.after`, runs each exactly as written through
     `powershell.exe -NoProfile -Command` with a minimal hook JSON on stdin, and asserts that the spool record exists at the moment
     PowerShell returns, that it returned in under 10 s, and that `~\.claude\settings.json` was not touched. The test records land
     in the real spool of the running app and are ingested as an unknown observed session named `ms-ci-*`.
5. Notification routing: calls `notifications.test` and records `{shown, reason, quiet}`, labelled "Windows accepted the toast
   request (not seen by a human)".
6. `uninstall`: silent `Uninstall Mini-Summa.exe /S`, polled until the install directory is gone; asserts the directory, the
   protocol key and the uninstall entry are removed and that `%APPDATA%\Mini-Summa\data\mini-summa.db` is kept
   (`deleteAppDataOnUninstall: false`).

The script uses plain `fetch` for the API (routes and bodies as in `packages/shared/src/routes.ts`) rather than the typed
`MiniSummaClient`, because that client is TypeScript source and would need `tsx` for no gain here. No secrets are used, the token
is never printed, and the only network traffic from the script itself is `127.0.0.1` and the `npm install` of Claude Code. (The
application it launches may of course contact chatgpt.com when its window loads.)

## Download the installer and check it

From the workflow run page (Actions, the run, "Artifacts"), download `mini-summa-windows-installer` and unzip it. It contains:

* `Mini-Summa-Setup-<version>-x64.exe` and its `.blockmap`
* `BUILD-INFO.txt`: commit, ref, run id and url, runner image, Node, Electron, installer name, size and SHA-256
* `SHA256SUMS.txt`

In PowerShell, in the folder you unzipped to:

```powershell
Get-Content .\SHA256SUMS.txt
Get-FileHash -Algorithm SHA256 .\Mini-Summa-Setup-0.1.0-x64.exe   # the Hash must equal the first line of SHA256SUMS.txt, ignoring case
Get-Content .\BUILD-INFO.txt
git rev-parse origin/feat/mini-summa-full-base                    # compare with the line "Checked-out commit" in BUILD-INFO.txt
```

`SHA256SUMS.txt` and `BUILD-INFO.txt` come from the same artifact, so they prove the file is the one the job produced and not
that it was produced from the commit you expect; that comes from comparing "Checked-out commit" with the commit you mean. Note
that for a `pull_request` event `GITHUB_SHA` is a temporary merge commit; the workflow checks out the pull request head and
`BUILD-INFO.txt` lists both. The installer is **not code-signed**: Windows SmartScreen will warn about an unknown publisher when
you run it from a browser download. Nothing in CI changes that.

## What CI proves and what only a person can prove

"CI covers" is what a green `installed-checks` job shows. "Remains" is what you still have to do on a real PC, following
[WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md).

| Item | CI covers | Remains for a person on a real desktop |
| --- | --- | --- |
| **R1** a GitHub-only project, and a folder added later persists | At the core level: a project with `githubRepo` and no folder is accepted; a real folder added as a root is returned at once and survives quit and relaunch of the installed exe; a missing folder is refused with a message. Check 2.2 to 2.4 and 2.7. | The UI path: the header text, Browse with the Windows folder picker, Done without "No changes to save", **New local session** starting Claude in the folder. |
| **R3** link an existing ChatGPT Project | The address is accepted, stored and read back identically after a restart (`chatgptProject`). | That the ChatGPT pane opens that project's page while signed in, the shape of a real project address, and "Use this conversation for reports". CI never signs in to ChatGPT. |
| **R4** overlapping controls, page size | Nothing. (A screenshot of the first window is saved as a diagnostic, but nobody judges it, and the runner has one display at one scale.) | The whole check in [CHATGPT_PANE.md](CHATGPT_PANE.md): window size, display scaling, split against ChatGPT alone. |
| **R5** view modes | Nothing. | Switching ChatGPT, Claude and Split, keeping half a message and the terminal output while hidden, dialogs never covered by the pages. |
| **R7** notifications | Routing only: `notifications.test` returns `{shown, reason}` from the application. The report labels it "Windows accepted the toast request (not seen by a human)". If `shown` is false it is a FAIL with the reason; on a Server image that can be an environment limit, which the table in the report cannot tell apart from a bug. | A human sees the toast, it carries the right text and name, clicking it brings Mini-Summa forward on the right project and session, quiet mode, Focus assist, the taskbar badge, the seconds between Claude finishing and its toast. |
| **W-11** PowerShell waits for the GUI-subsystem `Mini-Summa.exe` | The exact `SessionStart` and `Stop` commands from `hooks.plan`, run through Windows PowerShell with the installed exe as Node: the spool record exists when PowerShell returns, within 10 s; plus the raw 3 second measurement with and without `| Write-Output` (steps 4.1, 4.2). | Claude Code on the user's PC actually launching those hooks (its own PowerShell choice, `pwsh` against Windows PowerShell, profile and execution policy, Defender and antivirus scanning the spool, a real report arriving from a real session). Step 11 of the checklist as written. |
| Installer, per-user, protocol key, uninstall keeps data | Checks 1.x and 6.x on a clean image. | UAC behaviour as a standard user (the runner is an administrator), SmartScreen, the Start menu entry and tray icon, "Anyone who uses this computer" being greyed out, the uninstall message text, upgrade while running. |
| Managed Claude sessions, ConPTY terminals | The ConPTY files are installed beside the exe and outside `app.asar`; `environments.list` and `claude --version` discovery. | Everything interactive: starting a session, typing, paste, Ctrl+C, resize, Stop session leaving no `claude.exe`/`node.exe`/`OpenConsole.exe`. The packaged build has its test seams off, so no fake Claude can be injected, and the real one is not authenticated on the runner. |

## Core tests skipped on the Windows runner (UNTESTED ON WINDOWS)

The first native run of `packages/core` failed 109 tests. After triage:

* **Fixed, genuine product defect.** `createNodePtySpawner` let ConPTY's "File not found" throw escape when the program cannot start; POSIX reports an immediate exit. It is now reported as an exit with code 1 and the reason (test added, runs everywhere).
* **Fixed, test assumptions.** The folder tests used a POSIX environment with a Windows temp path; the verbatim-arguments test used quotes that verbatim mode must not receive; the pty tests assumed `/usr`, signals and POSIX error text.
* **Not verified on Windows: resize of a ConPTY child.** The first native run did not see a Node child report `resize`; that test is skipped on win32. Check it by hand (resize the terminal pane while Claude runs).
* **Observed on Windows: an oversize request body (over 1 MB) can be answered with a connection reset instead of the 413 message.** The server refuses it, but closes the socket with data unread, and on Windows TCP then resets the connection before the client reads the answer. The wording test tolerates this only on win32 and only for that one request. A phone or script that sends an oversize body on Windows may see a reset, not a message. Not fixed.
* **Skipped on win32 (they run on Linux), 17 files.** They drive a POSIX shell-script fake `claude` or `tailscale`, POSIX signals or file modes, or make projects in a "posix" environment that a Windows host reports as unavailable. The list is `POSIX_FIXTURE_FILES` in `packages/core/vitest.config.ts`. **No claim is made about the behaviour they cover on Windows**: session start with a fake Claude, hook spool to notification, remote access over tailscale, signal shutdown of the CLI, and the multi-environment observer. Follow-up: port the fakes to a Node script behind a `.cmd` shim.

## Limitations of the runner

`windows-latest` is a Windows **Server** image, driven by a service with no person at it. It has a desktop session, so an
Electron window can open and Playwright can attach, but there is no human, no real notification centre or Focus assist
behaviour you can rely on, one virtual display at one scale, no WSL2 distribution with Claude Code, and the account is an
administrator (UAC is off), unlike the standard user the installer is designed for. A pass here means "this works on a clean
Server image", never "this works on your PC". Each report ends with a section "What this does NOT prove" that says so in the
same words.

## Assumptions about Windows made here and not yet confirmed

These were written without a Windows machine and are the first things to look at when a run misbehaves:

* A silent `/S` install by an NSIS installer built with `perMachine: false` goes to `%LOCALAPPDATA%\Programs\Mini-Summa` even
  when the process is elevated, and the uninstaller is named `Uninstall Mini-Summa.exe`.
* The installer exits with code 0 and does not leave a running Mini-Summa (`runAfterFinish` in a silent run); if it does, the
  script stops that process and writes it in the report.
* The uninstaller process may return before the work is done (NSIS copies itself to `%TEMP%`), so the script polls for up to 2 minutes.
* The installer's manifest is readable as plain text; if not, check 1.2 says `INFO` rather than guessing.
* A packaged Electron can be driven by Playwright `_electron` (the inspector fuse is not disabled by electron-builder defaults).
* The first window URL contains `/ui/` and the core listens on 47811 (it takes another port if that one is busy).
* `app.quit()` with no terminals running shows no confirmation (a patched `dialog.showMessageBox` answers "Quit" if one appears).
* `claude` installed by `npm install -g` is `claude.cmd` on the npm prefix, which the workflow adds to the job `PATH`; the core
  finds it from `PATH` like a person's PowerShell would.
* Windows PowerShell 5.1 (`powershell.exe`) is the shell the hook commands are tested with, as in the checklist. PowerShell 7
  (`pwsh`) is not used for check 4.
* Start menu and Desktop shortcut names (`Mini-Summa.lnk`) follow electron-builder defaults; a miss there is only `INFO`.
* `GET /api/v1/health` is reachable without a token and `POST /api/v1/notifications/test` takes an empty JSON body.

## Running the script on a real PC

It also works on a Windows PC (use a throw-away profile or a VM: it installs and uninstalls the application, stops any running
`Mini-Summa.exe`, and the uninstall keeps `%APPDATA%\Mini-Summa`, so existing data stays but projects named "CI project" are added):

```powershell
npm ci
node scripts/windows/installed-smoke.mjs all --installer .\Mini-Summa-Setup-0.1.0-x64.exe --out $env:TEMP\windows-ci-out
```
