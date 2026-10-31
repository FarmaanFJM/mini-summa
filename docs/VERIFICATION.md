# Verification

What was tested, at which layer, where it ran, and what was **not** run. Results of different layers and different
environments are kept apart on purpose: a Linux result says nothing about Windows, and a test against a fake Claude says
nothing about the real one. Every number below came from a command in this repository; `npm run verify` repeats all the layers
that can run on your machine and prints PASS, FAIL or NOT RUN for each. A layer that did not execute is never shown as passed.

The final run was made in a **fresh clone of the pushed branch** (`git clone`, `npm ci`, then `npm run verify`) at commit
`b78488b`, with the installer, the packaged Linux app and its smoke test built and run in the same clone; later commits change
documentation only (this file, the README and the pull request text). The real-Claude scripts of section 3 ran from the working tree at `868c192`, the last commit that changed the core, the shared
package or those scripts; nothing they exercise changed afterwards. Round 3 (GitHub-only projects, cloud entry, workspace redesign,
notifications) is summarised in section 12, with what could not be checked.
Environment: Linux (container), Node 22, Electron 45.1 under Xvfb, Playwright 1.64, Claude Code 2.1.314. Date: 2026-10-31.

## At a glance

| Layer | Environment | Result |
| --- | --- | --- |
| Type check, every workspace | Linux | **PASS** |
| Unit and service tests (8 suites, 4,917 tests: 4,914 pass, 3 skipped) | Linux | **PASS** |
| Integration: real core + real PTYs + fake Claude, four-project routing | Linux | **PASS** (inside the core suite) |
| Real Claude Code CLI through the core, including `/clear` and `/resume` in the terminal and the new "Claude finished" notification | Linux, Claude 2.1.314 | **PASS**, 21 of 21 steps (section 3) |
| A Claude started outside Mini-Summa, followed through installed hooks | Linux, Claude 2.1.314 | **PASS**, 8 steps; 1 **NOT TESTED** (Claude ran in `auto` mode and never asked permission) (section 3) |
| Desktop acceptance: 25 behaviours, ten extra checks and the four-project scenario, real Electron | Linux, Xvfb | **25 PASS, 1 PARTIAL, 0 FAIL**, ten extra checks PASS (section 4) |
| Desktop smoke: real Electron with the real embedded core | Linux, Xvfb | **PASS**, 13 of 13 checks |
| Browser integration: extension in real Chromium | Linux, Xvfb | **PASS**, 28 of 28 + 9 of 9 steps and the service-worker keep-alive check (section 5) |
| Android unit tests and phone-code-against-real-core check | Linux, Node | **PASS** (216 tests; 10 checks) |
| Android APK: built, signed, read back with `apksigner` and `aapt2` | Linux | **BUILT**; never installed (section 6) |
| Windows installer: built under Wine, packaged Linux app and its smoke test | Linux + Wine | **BUILT**; packaged Linux smoke 13 of 13; installer never installed (section 7) |
| **Windows runtime** | none | **NOT TESTED** (a code audit and simulated tests only: section 8) |
| **WSL2** | none | **NOT TESTED** (simulated tests only) |
| **The Android app on a device or emulator** | none | **NOT TESTED** |
| **Real push delivery (Firebase)** | none | **NOT TESTED** |
| **The real ChatGPT site** | none | **NOT TESTED** |
| **Real Tailscale** | none | **NOT TESTED** |
| **Windows toast notifications** | none | **NOT TESTED** |
| **The real claude.ai inside the Cloud tab, and any Claude cloud session** | none | **NOT TESTED** (a local stand-in only; no claude.ai login was available) |
| **The ChatGPT overlap fix on the real site** | none | **NOT TESTED**, and the overlap itself was never reproduced (section 12) |
| **Linking a real ChatGPT Project** | none | **NOT TESTED** (a local stand-in only; the address shapes are not documented by OpenAI) |
| **Windows taskbar badge** | none | **NOT TESTED** |

## 1. Unit and service tests (Linux)

| Suite | Tests | Result |
| --- | --- | --- |
| `packages/shared` (contracts, ChatGPT and Claude address rules, client state, window-state rules) | 109 | PASS |
| `packages/storage` (SQLite, migrations) | 14 | PASS |
| `packages/claude-integration` (hook capture, reducer, discovery, redaction, spool, setup) | 270 | PASS |
| `poc/claude-integration` (the unmodified research record) | 131 | PASS |
| `packages/core` (services, HTTP and WebSocket, real-core integration) | 2,361 passed, 1 skipped | PASS |
| `apps/desktop` (Electron main process and React renderer) | 1,634 passed, 2 skipped | PASS |
| `apps/browser-extension` | 179 | PASS |
| `apps/android` (Jest) | 216 | PASS |

The skipped core test needs the built hook bundle (`npm run build:hook -w @minisumma/claude-integration`); in a checkout where
that has been built it runs and passes. Most security and Windows fixes were also checked by breaking them on purpose and
seeing a test fail ("mutation checks"); the workers' reports count them in the hundreds. Tests that simulate Windows (a
platform injected into the code, Windows-style paths, a rename that fails the way an antivirus makes it fail) are labelled
SIMULATED in their titles; they prove the logic and nothing about Windows.

## 2. Integration tests (Linux)

The core suite starts the real core (SQLite, HTTP and WebSocket server, hook ingestion, PTY manager) and drives it with a
fake Claude Code CLI that runs the real hook command taken from the `--settings` file the core passes. It covers:

* application and database, restart recovery (no resubmission, no re-notification), project and session persistence;
* hook ingestion, terminal lifecycle, several projects and several sessions, project switching that never ends a session;
* a terminal that goes on under another session id (`/clear`, `/resume`) is re-keyed on process evidence, ambiguous cases are
  left alone with a plain notice, and the old key becomes history;
* the report queue and the delivery state machine, with the destination frozen at capture;
* the **critical four-project scenario**: four projects with four different ChatGPT conversations (one project has two, the
  second preferred; one has none). Claude finishes tasks in A, C and D while B is selected and its conversation is in front.
  Each report is stored under its own project and session; each destination stays that project's conversation; D has no
  destination and is never given another project's; a later change of the preferred conversation does not move existing
  deliveries; the handoff copies A's text and opens A's address even though B's is focused. The same scenario is repeated
  in the real Electron app (section 4);
* the phone approval boundary: a prompt from a paired phone waits for the desktop's approval, a revoked device's prompts are
  rejected, approvals are bound to the permission request that is open;
* a client that follows the WebSocket the way the window does ends with the same delivery states as the API (this test failed on
  the old event bus; see section 9);
* authentication and scopes for every route against every kind of token.

## 3. Real Claude Code CLI (Linux, Claude 2.1.314)

Three scripts drive the **real** `claude` (isolated configuration directory, temporary git repositories, the Haiku model for the
repeated runs and the default model for some, default permission mode). They are for you to repeat against your own Claude
Code after upgrading it.

**`npm run verify:claude`: a managed session through the headless core.** Result of the round 3 run: **21 passed, 0 failed, 0 not tested** (the machine's default model and its normal Claude login; the permission dialog did appear in this run). The 21st check is new: a real turn that ends without a report produced exactly one "Claude finished" notification record 2.7 s after the prompt was sent in the last run (3.3 s and 4.3 s in two earlier runs; this includes the model's reply time), the turn that ended with a report produced none, and a plain answer created no report. The round 2 result was 20 of 20 (Haiku, isolated configuration directory). After `/clear` the managed terminal was following the new session id 1.5 s later, in the same process; `/resume <id>` moved it back in 1.5 s.

The checks, in order: the core starts · a project and its mapped conversation are registered · the CLI starts as a managed
session in the project folder · the first real hook arrives and the session leaves "Starting" · a real final message becomes a
report under the right project and session (marked as a declaration, not verified) · its destination is frozen to the mapped
conversation and nothing is sent · feed and notification records exist · the real permission dialog is detected and
described · approving from the core sends the approve key and Claude carries on · the second report is captured · rejecting
sends the reject key, nothing is created and the item closes · the session still answers the next prompt · a paired phone's
prompt waits, is typed only after the desktop approves, and the real Claude answers it · a text of **several lines** with
quotes, a backtick, `$`, a backslash, a bullet, a `#` line, unicode and an indented line reaches Claude as one prompt, identical
line for line (read from Claude's own `UserPromptSubmit` hook record, not from the model's answer) · `/clear` typed in the
terminal keeps it managed under the new session id and the old one becomes history · `/resume <id>` does the same the other way ·
stop ends the process · reports and deliveries survive a core restart without re-notifying · `claude --resume` brings the same
session back as managed in a new generation · nothing was written into the repository.

**`npm run verify:claude-external`: a Claude Mini-Summa did not start.** It runs `claude` in a terminal of its own, installs
hooks through the same consent flow the Settings page uses (a plan with a hash, a backup, the user's own keys preserved), and
checks that the session is attributed from the hook evidence only, typing into it is refused, a permission request is announced
but cannot be acted on, a report is captured, the end is observed, and removing the hooks restores the user's keys (Claude adds
keys of its own to `settings.json`, which the comparison ignores). Result of the round 3 run: **8 passed, 0 failed, 1 not tested**. The one not tested is "the permission request is announced": Claude Code 2.1.314 started in `auto` permission mode on this machine (its hooks say `permission_mode: auto`), wrote the file without asking and no permission request existed to observe; the script now says so instead of waiting two minutes and failing. Round 2: 9 of 9.

**`npm run verify:protocol`: does Claude write the report marker by itself?** With natural prompts that never mention a report
(create a file, add a small function and run it, change a heading, write a to-do list), the default model wrote the marker for 6
of 6 tasks (two runs) and Haiku for 11 of 11 (three runs) with the current wording of the instruction, the last run of each on
the final code (Haiku 4 of 4, default model 3 of 3); none of 6 plain questions got a marker. Haiku had managed only 1 of 3 with the earlier,
narrower wording, which is why it was broadened. Small samples on one machine, a measurement and not a guarantee. A final
message without the marker is kept under "Other messages".

Earlier runs of these scripts are why they are trustworthy: the first showed that under Claude's `auto` permission mode no
dialog appears at all (the step is then reported NOT TESTED, never PASS); the second exposed a real gap (the core raised no
approval for the real permission request), which was fixed; later runs caught that a state label alone could be stale, so the
checks require Claude's actual answer; one run showed that `/clear` made the managed terminal "end" while an unrelated observed
session appeared beside it (fixed, section 9); and a driver flake (the first-run trust dialog answered too early under heavy CPU
load, selecting "No, exit") was fixed by choosing the highlighted option and by waiting for the screen to settle.

In round 3 the managed-session script first reported two failures that were not the product's: `claude agents --json` lists every Claude process of the computer, including the one that started the run, so a check that no observed session exists anywhere, and one that exactly one session is live anywhere, counted it. Those two checks now look only at sessions inside the run's own temporary directory (a phantom made by the terminal under test would be there), and the second run passed all 21.

Limits: Linux, this sandbox's authentication, one Claude version, two models. Not covered: Windows, WSL2, the Claude desktop
app, other Claude versions, `/clear` while Claude is working or a dialog is open, and the real Electron window together with the
real Claude (the Electron suite uses a stand-in CLI so that no model is called).

## 4. Desktop acceptance (Linux, real Electron under Xvfb)

The suite in `apps/desktop/e2e` launches the **built** Electron app (real main process, preload, React window and embedded
core, with real SQLite and real PTYs) for every test, with a fake Claude CLI that replays the real hook command and a local
HTTPS stand-in for `chatgpt.com`. Nothing reached the real ChatGPT or any other host (a check after every test, and a check
that the app's own host rules make every other name unresolvable), and the real `claude` never started (a decoy on `PATH` proves
it). Everything a person clicks or types was reached by role and accessible name; no test ids were added.

Result (`docs/ACCEPTANCE.md` is generated from the last run, one row per behaviour with its evidence):

* **A01 to A25 and the critical cross-project scenario: 25 PASS, 1 PARTIAL, 0 FAIL, 0 NOT TESTED.** The ten extra checks X01 to X10: 10 PASS.
  51 tests ran: 50 passed, 1 skipped (the operating-system toast part of A21, declared NOT TESTED).
* **The full suite passed in the fresh clone** of the pushed branch (the e2e layer of `npm run verify`: 50 passed, 1 skipped in 4 min 7 s)
  and in the working tree before that (3 min 43 s), each against an app build made for the run. Round 2 took 2 min 54 s for 38 tests.
  The suite has no retries; during round 3 a few runs of single files failed for reasons that were not the product's (a test that
  encoded the old project dialog, a setup that now opens a conversation earlier, a certificate helper that wrote an empty line into
  a PEM file for two host names) and each was fixed at its cause.
* **A21, desktop notifications, is PARTIAL.** Executed and asserted: a finished task and a permission request become
  notification records, the main process asks the platform to show them with the right title, body and target, quiet mode and
  the per-project switch suppress them, and click navigation works with the platform layer simulated. **Not observed:** an
  operating-system toast on screen. Electron on this Linux container reports no notification service. Windows toasts were not
  exercised.
* Ten extra checks, each guarding a defect the suite or a later review found (X07 to X10 are round 3's, section 12): X01 the Handoff card follows the delivery; X02
  the window reopens on the selected project at the same address; X03 an ended session is described in words; X04 the sandbox
  cannot reach any other host; X05 a report is handed over and confirmed from the strip at the bottom of the workspace, without
  going back to Reports (portrait and landscape, a collapsed sidebar, several reports, a very long title, a long report copied
  part by part); X06 after `/clear` typed in a managed terminal the pane follows to the new session, the old one is listed as
  history, typing still reaches the process, and a restart reopens on the new session (a negative control, the follower disabled,
  makes it fail).
* The suite has no retries configured.

Not covered by this suite: the real Claude CLI (section 3), the real ChatGPT site, a second application's view of the clipboard
(it is read back through Electron), a window manager or other screen sizes, touch, a real pointer, GPU rendering (xterm uses
its DOM renderer here), `/resume` in the window, and a `/clear` whose new session the core cannot identify (component tests only).

`npm run smoke:core -w @minisumma/desktop` (13 of 13 checks, all passed) separately starts the app with the real embedded core and
checks the window origin, the preload API, the HTTP API with the desktop token, the hook script, and a clean quit.

## 5. Browser integration (Linux, real Chromium under Xvfb)

The optional extension was loaded unpacked into a real Chromium and driven against a stand-in for ChatGPT and against the **real
core**:

* 28 of 28 steps: pairing, focusing an already open conversation tab without a reload, bringing its window to the front,
  opening a tab when none exists, no duplicate on a repeated or simultaneous request, address normalisation, honest reporting
  of a load that ends on a sign-in page, another site, a script redirect, a network failure or a page that never answers (given
  up on at 15 seconds), refusal of bad addresses, no `tabs` permission and no content scripts (with a control extension proving
  the detector works), reconnection, revocation (close code 4003), re-pairing and unpairing;
* 9 of 9 steps with the real core: a mapped conversation opened through the extension, the second and first conversation
  reusing tabs, the sign-in and other-site cases reported as opened but not verified, the 15 s give-up passed on by the core, and
  removing the device in the core;
* the Manifest V3 service worker stays alive while paired (7 pings in 100 s, largest gap 20 s) and a control that is not paired
  is stopped by the browser 31 s after launch (re-measured in the final pass).

Not tested: Edge, Brave, Firefox, Windows, and the real chatgpt.com.

## 6. Android (Linux)

* 216 Jest tests (pairing, connection state, reports, activity, remote prompts, offline handling, notification handling).
* `npm run check:core` in `apps/android`: 10 checks, with the phone's **own** pairing, connection and send code run
  against the real headless core: pairing and its error messages, snapshots in order, live events, removal while connected
  (close 4003) and while away, a refused prompt, the permission boundary, the rate limit, and an unreachable PC.
* A bundling check of the app (the JavaScript bundle builds) and `expo-doctor` (20 of 20).
* **The APK was built**: `Mini-Summa-0.1.0-release-sideload.apk`, 46,206,686 bytes, SHA-256
  `4427f35256ba6395d190b492c192541b00d2de3af8683bdcc5536b8a60b3cf54`, arm64, release, not debuggable, signed with a throwaway
  local key. The earlier attempts failed on Maven Central's HTTP 429 rate limit; the build got through with Gradle retry settings
  that actually take effect (the first ones used names Gradle does not read) and a local repository of 11 files whose SHA-1 (and,
  where published, SHA-256 and PGP signature) were compared with what Maven Central publishes. No verification was bypassed and
  nothing was changed in the app to get past it ([ANDROID.md](ANDROID.md), "Build outcome"). Read back from the file:
  signature valid (v2 and v3), exactly 8 permissions (24 library permissions removed), no backup, no cleartext traffic, Hermes
  bundle embedded.
* **Not run:** the APK on any emulator or device, so no screen has been seen running; the camera and the pairing QR code;
  Firebase push; Tailscale. [PHONE_VERIFICATION.md](PHONE_VERIFICATION.md) is the checklist for the first run.

## 7. Packaging

**Windows installer (built, never installed).** `npm run dist:win -w @minisumma/desktop` on Linux, with Wine for the Windows
resource editing, produced `Mini-Summa-Setup-0.1.0-x64.exe`: 122,553,112 bytes (about 117 MiB), SHA-256 `a8e048380fd3f6b8846252c00f07bde2ab0fd9969ae5344be1eb453c72b83b2c`, built in the fresh clone of `b78488b` in 72 seconds, a Nullsoft installer for 64-bit Windows, per-user,
no administrator rights, **not code-signed**. Inside it: `Mini-Summa.exe` (a 64-bit Windows executable, GUI subsystem), the app
archive, the hook script as a separate resource, and the Windows terminal components of the PTY library (`conpty.node`,
`conpty.dll`, `OpenConsole.exe`) outside the archive where they can load. The installer script registers `minisumma://`, refuses
Windows older than 10 version 1809, offers no all-users install, and says on uninstall what is kept. What this proves is that the
package assembles with the right pieces; those pieces were read out of the files (PE headers, manifest, Electron fuses, the
unpacked PTY package). **Under Wine 9.0, which is not Windows:** the application starts and its core answers; a hook call
(`ELECTRON_RUN_AS_NODE=1 Mini-Summa.exe capture.mjs ...`) runs and writes its record; a second launch with a `minisumma://` link
reaches the running copy; a close request quits cleanly. In a scratch Wine prefix in which Wine's PowerShell stub (which never
finishes the installer's "is the app running" check) was replaced by a program that fails, a silent per-user install, its
shortcuts and registry entries, the uninstall, and the refusal on emulated Windows 7 and 8.1 behaved as designed. Showing the
main window aborts the process under Wine (a Wine limit), so first paint was not observed, and Wine's pseudo console is not
ConPTY, so no terminal was tried. None of this is evidence about Windows. The hash identifies this build only; a rebuild embeds timestamps and will differ.

**Packaged app on Linux (run).** `npm run dist:dir -w @minisumma/desktop` builds the same app unpacked for Linux (278 MB, 8 seconds), and
`smoke-real-core.mjs --packaged` was run against that packaged build in the fresh clone of `b78488b` (not against the sources): 13 of 13 checks passed. They include that the test seams are inert in a packaged build (the data
directory is the profile's, not the one an environment variable asked for), that the PTY library loads from where the package puts
it, that the hook script the core will install is the packaged one and runs the packaged executable, and that quitting asks about
the running terminal and exits cleanly.

## 8. Windows and WSL2: audited, simulated, not run

Two audits read the Windows-relevant code and built files (not by running them on Windows): the local service and the hook
library ([audit/windows-core.md](audit/windows-core.md)) and the Electron shell, installer and packaging
([audit/windows-desktop.md](audit/windows-desktop.md)). They found 19 problems in the first and 12 in the second that are visible
in the code (for example: a pty process id that is 0 until ConPTY connects, stopping a session left child processes with their own
console running, a hung `claude.cmd` helper never ended, `\\?\` paths never matching their folder, a distribution name compared
case-sensitively, the hook's rename not retried when an antivirus holds the file, closing the window leaving a frozen app on
screen, `minisumma://` never registered by the installer). All are fixed, each with a test that **simulates** the condition and
fails when the fix is removed. One more change (change 16 in `packages/claude-integration/docs/CHANGES-FROM-POC.md`) makes the
hook command wait for the Electron executable by piping the call into `Write-Output`; only the text of the command is tested.
The audits list **39 numbered checks that only a Windows PC can answer**; [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) puts
the ones that decide whether Mini-Summa is usable first, in order, and its step 11 (does PowerShell wait for the executable)
is the single most valuable one.

## 9. Defects found by verification

The layers above were not only confirmations; they found these defects, which are fixed and guarded by tests:

| Found by | Defect | Status |
| --- | --- | --- |
| Electron acceptance suite | Event bus: an event emitted while another was being delivered reached later subscribers under the wrong number, and clients dropped it, so the Handoff card stayed stale after "Copy and open" while the report list was right | Fixed; unit tests (6 of 10 fail on the old bus), a real-core WebSocket test, and acceptance check X01 |
| Electron acceptance suite | The desktop app pinned a random core port, so every start had a new address and the window forgot the selected project, per-project choices and setup state; the extension's default address (47811) did not match either | Fixed; unit test and acceptance check X02. The window's choices now also live in the core |
| Electron acceptance suite | An ended session was described as "This session ended: app_exit." (an internal code) | Fixed; unit tests and acceptance check X03 |
| Real Claude CLI check | The core raised no approval item for the real permission request; under `auto` mode no dialog appears at all | Fixed; the step reports NOT TESTED when no dialog appears |
| Real Claude CLI check | `/clear` or `/resume` inside a managed terminal made the terminal "end" in the window while an unrelated observed session appeared beside it, and the person was left on a dead tab | Fixed in the core (re-key on process evidence) and in the window (the pane follows); `verify:claude` and acceptance check X06 |
| Report-protocol measurement | The instruction asked for the marker too narrowly: Haiku wrote it for 1 of 3 small tasks | Wording broadened; 7 of 7 afterwards, 0 of 4 false alarms |
| Windows audits | 19 problems in the service and the hook library, 12 in the shell and installer (section 8) | Fixed with simulated tests; unverified on Windows |
| Android build | The Gradle retry settings never took effect (wrong property names), so the rate limit stopped every run at the same files | Fixed; the APK was built (section 6) |
| Independent security review | 15 findings (none critical or high) | 14 fixed with tests, 1 documented trade-off ([SECURITY.md](SECURITY.md)) |
| Android core check | The script still assumed the old pairing limit that counted successes | Script updated to the failures-only limit |
| Component tests | Icons that drew nothing (attributes with digits dropped), sessions with a lost terminal had no tab, settings forms showed empty values before the snapshot loaded | Fixed |

A pattern worth knowing: the event bus, the random port, the internal code and the `/clear` dead end were invisible to unit
tests, component tests and the headless integration tests, and were found only by driving the real application or the real
Claude. That is why the real-Electron and real-Claude layers exist.

## 10. What was not tested

Everything in the bold rows of the table above, and in particular:

* **Windows**: install, uninstall, ConPTY terminals, the PowerShell hook, the folder picker, tray, `minisumma://` links, toasts,
  SmartScreen. [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) is the checklist for it.
* **WSL2**: launching Claude in a distribution, `wsl.exe` output, UNC and `/mnt` paths. Tests use recorded and simulated output.
* **Real devices**: no Android emulator or phone was available. The APK exists but has never been installed.
* **The real ChatGPT site** and sign-in inside the embedded view. A local HTTPS stand-in plays `chatgpt.com` for the real
  navigation policy and the real view.
* **Real Tailscale** (`tailscale serve`) and real Firebase delivery.
* **Windows notification toasts** and clicking them (Linux has no notification service).
* `/resume` and `/clear` while Claude is working, in the real window; the real window with the real Claude.
* **The real claude.ai** in the Cloud tab, sign-in there, GitHub's authorisation flow, and any Claude cloud session (no claude.ai login was
  available). A local stand-in plays `claude.ai`. Nothing was claimed about cloud execution.
* **The real chatgpt.com layout**: whether the narrow-pane overlap exists and whether the page size setting removes it.
* **A real ChatGPT Project address**: the stand-in serves the shape seen in a browser; OpenAI does not document it.
* **The Windows taskbar badge** and a click on a real toast.
* Continuous integration: the repository has no CI workflow, so nothing runs automatically on a push or on the pull request.

## 11. Reproduce

```bash
npm install
npm run verify                      # every layer that can run here, honest PASS/FAIL/NOT RUN
npm run verify -- --with-real-claude
npm run verify:claude               # real Claude through the core (a handful of short prompts, about 5 minutes)
npm run verify:claude-external      # a Claude you started yourself, followed through hooks
npm run verify:protocol             # does your Claude write the report marker unprompted
npm run e2e -w @minisumma/desktop   # needs xvfb-run; regenerates docs/ACCEPTANCE.md
```

## 12. Round 3: what is new and how it was checked

| Change | Evidence that ran (Linux) | Not covered |
| --- | --- | --- |
| **The folder defect** (Browse only filled a field, Save saw no change, the header kept "No folder yet") | Root cause found and fixed; the project settings now apply each change as it is made. Renderer tests for every way a folder gets in and for closing with text pending; **X07** in the real app (a GitHub-only project, Browse, Done, restart, a local session starts in the folder), which fails when Browse is put back to the old behaviour | The Windows folder picker and WSL paths |
| **Folders optional; five independent associations** (name, GitHub repository, local folders, ChatGPT Project link, conversations and sessions); migration v2; a folder must exist and be a folder | Storage upgrade test of a round 2 database; core tests; A02 creates a project from each of four sources against the real core; X10 | A real installation's database (only a synthetic older one was upgraded) |
| **Linking an existing ChatGPT Project** (no official listing exists: [CHATGPT_PROJECTS.md](CHATGPT_PROJECTS.md)) | Parser tests (query and fragment dropped, refusals with reasons, unknown forms kept as pasted); dialog and pane tests; **X10** against a stand-in. A mutation that kept the pasted query makes X10 fail | Real address shapes; OpenAI's terms were unreadable to the research tool and are unread |
| **Claude Code on the web in a Cloud tab** (browser based; local and cloud chosen per session and never swapped: [CLOUD_SESSIONS.md](CLOUD_SESSIONS.md)) | Address and navigation-policy tests; the view's own tests; **X09** (5 scenarios; 8 deliberately broken builds were all caught) and **X10** against a claude.ai stand-in: one GET with the repository preselected, nothing typed or submitted, no local session started instead, hide and show keep the page, a profile separate from ChatGPT's | The real claude.ai, sign-in, GitHub flow, any cloud session; Anthropic's terms for embedding are not answered by their documentation |
| **ChatGPT page size** (the overlap mitigation: the view's own zoom follows its pane; [CHATGPT_PANE.md](CHATGPT_PANE.md)) | Pure function tests; view tests; **X08** (4 scenarios; 4 broken builds caught): the page gets the width the table promises, clicks, selection, scrolling and its own Copy button still work while zoomed, the zoom survives navigation to another host | **The overlap was never reproduced.** Whether zoom removes it on the real site is unknown; Windows and display scaling (a Linux 150% run is a proxy) |
| **Workspace**: one slim header, Split, ChatGPT and Claude views, Cloud tab, explicit local and cloud entries | Renderer tests (about 110 for the workspace); X08, X09 and X10 prove the same two native views, the same draft and no new request across view changes | A native page's square corners over the panel's rounded corner (cosmetic) |
| **Notifications**: "Claude finished" (once per turn, never together with a report), no toast for what you are looking at, a test notification, a taskbar badge | Core and main tests incl. 13 live-core scenarios and a latency test (spool to notification: median about 300 ms, at most about 690 ms with the fake Claude); A21 in the real app (click goes to the right project and session); the **real Claude**: one "Claude finished" 2.7 to 4.3 s after the prompt including the model's reply, none after a report | Windows toasts and Focus assist, the hook's start-up time on Windows, Firebase delivery, the taskbar badge, a click on a real toast |
| **Summa-UI**: the vendored bundle's tokens with no override, a flat sidebar and quick switcher, no second navigation column | The reference collector's checks (CHK-001 to 022) over 25 screens in a real browser, 149 keyboard focus stops, a contrast table ([UI_PRINCIPLE_EXCEPTIONS.md](UI_PRINCIPLE_EXCEPTIONS.md)); the real Electron window looked at under a virtual display at 1440x900, 1280x720, 960x600 and 960x1200 (split, each view, GitHub-only, the Cloud tab, the switcher, settings) | Windows rendering; the shortcuts do not reach the app while an embedded page has the keyboard focus |

Defects that verification found in round 3, all fixed: the test certificate helper wrote an empty line into its PEM for certain sizes (found when
the stand-in served two host names, 29 of 40 certificates failed); the taskbar badge was never fed by anything; a setup order that opened a
conversation early (found by the cross-project test); the verifiers counting the machine's own Claude session; a stale scratch copy a worker left
inside the repository (removed from the tree in `8ad35b7`, it remains in earlier snapshot commits of this branch and holds no secrets).
