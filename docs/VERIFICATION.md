# Verification

What was tested, at which layer, where it ran, and what was **not** run. Results of different layers and different
environments are kept apart on purpose: a Linux result says nothing about Windows, and a test against a fake Claude says
nothing about the real one. Every number below came from a command in this repository; `npm run verify` repeats all the layers
that can run on your machine and prints PASS, FAIL or NOT RUN for each. A layer that did not execute is never shown as passed.

The final run was made in a **fresh clone of the pushed branch** (`npm ci`, then `npm run verify`), so it does not depend on
anything that only exists in the working tree. Environment: Linux (container), Node 22, Electron 45.1 under Xvfb, Playwright
1.64, Claude Code 2.1.314. Date: 2026-10-30.

## At a glance

| Layer | Environment | Result |
| --- | --- | --- |
| Type check, every workspace | Linux | **PASS** |
| Unit and service tests (8 suites, 3,922 tests) | Linux | **PASS** |
| Integration: real core + real PTYs + fake Claude, four-project routing | Linux | **PASS** (inside the core suite) |
| Real Claude Code CLI through the core | Linux, Claude 2.1.314 | **PASS**, 17 of 17 steps (section 3) |
| Desktop acceptance: 25 behaviours + four-project scenario, real Electron | Linux, Xvfb | **25 PASS, 1 PARTIAL, 0 FAIL**; three consecutive full runs (section 4) |
| Desktop smoke: real Electron with the real embedded core | Linux, Xvfb | **PASS**, 9 of 9 checks |
| Browser integration: extension in real Chromium | Linux, Xvfb | **PASS**, 28 + 9 steps and the service-worker keep-alive check (section 5) |
| Android unit tests and phone-code-against-real-core check | Linux, Node | **PASS** (216 tests; 10 of 10 checks) |
| Packaging | Linux, Wine for the Windows target | see section 7 |
| **Windows runtime** | none | **NOT TESTED** |
| **WSL2** | none | **NOT TESTED** |
| **Real Android device or emulator** | none | **NOT TESTED** |
| **Android APK** | Linux | **NOT BUILT** (Maven Central rate limit, section 6) |
| **Real push delivery (Firebase)** | none | **NOT TESTED** |
| **The real ChatGPT site** | none | **NOT TESTED** |
| **Real Tailscale** | none | **NOT TESTED** |
| **Windows toast notifications** | none | **NOT TESTED** |

## 1. Unit and service tests (Linux)

| Suite | Tests | Result |
| --- | --- | --- |
| `packages/shared` (contracts, ChatGPT URL rules, client state) | 57 | PASS |
| `packages/storage` (SQLite, migrations) | 9 | PASS |
| `packages/claude-integration` (hook capture, reducer, discovery, redaction, spool, setup) | 242 | PASS |
| `poc/claude-integration` (the unmodified research record) | 131 | PASS |
| `packages/core` (services, HTTP and WebSocket, real-core integration) | 2,139 passed, 1 skipped | PASS |
| `apps/desktop` (Electron main process and React renderer) | 949 | PASS |
| `apps/browser-extension` | 179 | PASS |
| `apps/android` (Jest) | 216 | PASS |

The one skipped core test needs the built hook bundle (`npm run build:hook -w @minisumma/claude-integration`); in a clean
checkout it runs once that is built, and it passed in the working tree. Most security fixes were also checked by breaking them
on purpose and seeing a test fail ("mutation checks"); the workers' reports count them in the hundreds.

## 2. Integration tests (Linux)

The core suite starts the real core (SQLite, HTTP and WebSocket server, hook ingestion, PTY manager) and drives it with a
fake Claude Code CLI that runs the real hook command taken from the `--settings` file the core passes. It covers:

* application and database, restart recovery (no resubmission, no re-notification), project and session persistence;
* hook ingestion, terminal lifecycle, several projects and several sessions, project switching that never ends a session;
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
  the old event bus; see section 8);
* authentication and scopes for every route against every kind of token.

## 3. Real Claude Code CLI (Linux, Claude 2.1.314)

`npm run verify:claude` starts a headless core on a temporary data directory, launches the **real** `claude` as a managed
session in a temporary git repository, and drives it. The run used an isolated Claude configuration directory, the Haiku
model, and the default permission mode. All 17 steps passed:

core starts · project and mapped conversation registered · the CLI starts as a managed session in the project folder ·
the first real hook arrives and the session leaves "Starting" · a real final message becomes a report under the right project and
session (marked as a declaration, not verified) · its destination is frozen to the mapped conversation and nothing is sent ·
feed and notification record exist · the real permission dialog is detected and described · approving from the core sends
the approve key and Claude carries on · the second report is captured · rejecting from the core sends the reject key, nothing is
created and the item closes · the session still answers the next prompt · a paired phone's prompt waits, is typed only after
the desktop approves, and the real Claude answers it · stop ends the process · reports and deliveries survive a core restart
without re-notifying · `claude --resume` brings the same session back as managed in a new generation · nothing was written into
the repository.

Earlier runs of the same script are why it is trustworthy: the first showed that under Claude's `auto` permission mode no
dialog appears at all (the step is then reported NOT TESTED, never PASS); the second exposed a real gap (the core raised no
approval for the real permission request), which was fixed; later runs also caught that a state label alone could be stale, so
the check now requires Claude's actual answer.

Limits: it ran on Linux with this sandbox's authentication, one Claude version, one model. It does not cover Windows,
WSL2, the Claude desktop app or other Claude versions.

## 4. Desktop acceptance (Linux, real Electron under Xvfb)

The suite in `apps/desktop/e2e` launches the **built** Electron app (real main process, preload, React window and embedded
core, with real SQLite and real PTYs) for every test, with a fake Claude CLI that replays the real hook command and a local
HTTPS stand-in for `chatgpt.com`. Nothing reached the real ChatGPT or any other host (a check after every test, and a check
that the app's own host rules make every other name unresolvable), and the real `claude` never started (a decoy on `PATH` proves
it). Everything a person clicks or types was reached by role and accessible name; no test ids were added.

Result (`docs/ACCEPTANCE.md` is generated from the last run, one row per behaviour with its evidence):

* **A01 to A25 and the critical cross-project scenario: 25 PASS, 1 PARTIAL, 0 FAIL, 0 NOT TESTED.**
* **A21, desktop notifications, is PARTIAL.** Executed and asserted: a finished task and a permission request become
  notification records, the main process asks the platform to show them with the right title, body and target, quiet mode and
  the per-project switch suppress them, and click navigation works with the platform layer simulated. **Not observed:** an
  operating-system toast on screen. Electron on this Linux container reports no notification service. Windows toasts were not
  exercised.
* Four extra checks, each guarding a defect the suite found: the Handoff card follows the delivery, the window reopens on the
  selected project at the same address, an ended session is described in words, and the sandbox cannot reach any other host.
* **Three consecutive full runs passed** (143 s, 143 s, 147 s; 33 tests each: 32 passed, 1 skipped = the OS toast). In the fresh
  clone a fourth full run also passed (32 passed, 1 skipped, 145 s). The suite has no retries configured.

Not covered by this suite: the real Claude CLI (see section 3), the real ChatGPT site, a second application's view of the
clipboard (it is read back through Electron), a window manager or other screen sizes, touch, a real pointer, and GPU rendering
(xterm uses its DOM renderer here).

`npm run smoke:core -w @minisumma/desktop` (9 checks, all passed) separately starts the app with the real embedded core and checks
the window origin, the preload API, the HTTP API with the desktop token, the hook script, and a clean quit.

## 5. Browser integration (Linux, real Chromium under Xvfb)

The optional extension was loaded unpacked into a real Chromium and driven against a stand-in for ChatGPT and against the **real
core**:

* 28 of 28 steps: pairing, focusing an already open conversation tab without a reload, bringing its window to the front, opening a
  tab when none exists, no duplicate on a repeated or simultaneous request, address normalisation, honest reporting of a load that
  ends on a sign-in page, another site, a script redirect, a network failure or a page that never answers (given up on at 15
  seconds), refusal of bad addresses, no `tabs` permission and no content scripts (with a control extension proving the detector
  works), reconnection, revocation (close code 4003), re-pairing and unpairing;
* 9 of 9 steps with the real core: a mapped conversation opened through the extension, the second and first conversation reusing
  tabs, the sign-in and other-site cases reported as opened but not verified, the 15 s give-up passed on by the core, and removing
  the device in the core;
* the Manifest V3 service worker stays alive while paired (7 pings in 100 s, largest gap 20 s) and a control that is not paired
  is stopped by the browser at 30 s.

Not tested: Edge, Brave, Firefox, Windows, and the real chatgpt.com.

## 6. Android (Linux)

* 216 Jest tests (pairing, connection state, reports, activity, remote prompts, offline handling, notification handling).
* `npm run check:core` in `apps/android`: 10 of 10 checks, with the phone's **own** pairing, connection and send code run
  against the real headless core: pairing and its error messages, snapshots in order, live events, removal while connected
  (close 4003) and while away, a refused prompt, the permission boundary, the rate limit, and an unreachable PC.
* A bundling check of the app (the JavaScript bundle builds).
* **No APK was built.** `npm run build:apk` passes its prerequisite check and `expo prebuild`; Gradle then reached 94 tasks and
  cached 2.3 GB before Maven Central answered HTTP 429 to the same Fresco library downloads three runs in a row. Details and
  what to run on a normal network are in [ANDROID.md](ANDROID.md).
* **Not run:** any emulator or device, so no screen has been seen running; Firebase push; Remote Control.

## 7. Packaging

**Windows installer (built, never installed).** `npm run dist:win -w @minisumma/desktop` on Linux, with Wine for the Windows
resource editing, produced `apps/desktop/release/Mini-Summa-Setup-0.1.0-x64.exe`: 122,500,031 bytes (about 117 MiB), SHA-256
`9db75cad63932cef56a08c8b495c274285247b68fbea614c6234a15ff5221c9c`, a Nullsoft installer for 64-bit Windows, per-user, no
administrator rights, **not code-signed**. The build takes about one minute. Inside it: `Mini-Summa.exe` (a 64-bit Windows
executable), the app archive, the hook script as a separate resource, and the Windows terminal components of the PTY library
(`conpty.node`, `conpty.dll`, `OpenConsole.exe`) outside the archive where they can load. What this proves is that the package
assembles with the right pieces. It does **not** prove that the installer installs, that the app starts on Windows, or that
the uninstaller works: a silent install under Wine stops early because Wine lacks a PowerShell the installer's "is the app
running" check uses, which is a limit of Wine and not known to be a defect of the installer. The hash identifies this build only;
a rebuild embeds timestamps and will differ.

**Packaged app on Linux (run).** `npm run dist:dir` builds the same app unpacked for Linux, and the smoke test was run against that
packaged build (not against the sources): 9 of 9 checks passed. They include that the test seams are inert in a packaged build
(the data directory is the profile's, not the one an environment variable asked for), that the PTY library loads from where the
package puts it, that the hook script the core will install is the packaged one and runs the packaged executable, and that quitting
asks about the running terminal and exits cleanly.

**Android APK: not built** (section 6).

## 8. Defects found by verification

The layers above were not only confirmations; they found these defects, which are fixed and guarded by tests:

| Found by | Defect | Status |
| --- | --- | --- |
| Electron acceptance suite | Event bus: an event emitted while another was being delivered reached later subscribers under the wrong number, and clients dropped it, so the Handoff card stayed stale after "Copy and open" while the report list was right | Fixed; unit tests (6 of 10 fail on the old bus), a real-core WebSocket test, and acceptance check X01 |
| Electron acceptance suite | The desktop app pinned a random core port, so every start had a new address and the window forgot the selected project, per-project choices and setup state; the extension's default address (47811) did not match either | Fixed; unit test and acceptance check X02 |
| Electron acceptance suite | An ended session was described as "This session ended: app_exit." (an internal code) | Fixed; unit tests and acceptance check X03 |
| Real Claude CLI check | The core raised no approval item for the real permission request; under `auto` mode no dialog appears at all | Fixed; the step reports NOT TESTED when no dialog appears |
| Independent security review | 15 findings (none critical or high) | 14 fixed with tests, 1 documented trade-off ([SECURITY.md](SECURITY.md)) |
| Android core check | The script still assumed the old pairing limit that counted successes | Script updated to the failures-only limit |
| Component tests | Icons that drew nothing (attributes with digits dropped), sessions with a lost terminal had no tab, settings forms showed empty values before the snapshot loaded | Fixed |

A pattern worth knowing: the first three were invisible to unit tests, component tests and the headless integration tests, and
were found only by driving the real application. That is why the real-Electron and real-Claude layers exist.

## 9. What was not tested

Everything in the bold rows of the table above, and in particular:

* **Windows**: install, uninstall, ConPTY terminals, the folder picker, tray, `minisumma://` links, toasts, SmartScreen.
  [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) is the checklist for it.
* **WSL2**: launching Claude in a distribution, `wsl.exe` output, UNC and `/mnt` paths. Tests use recorded and simulated output.
* **Real devices**: no Android emulator or phone was available, and no APK could be built.
* **The real ChatGPT site** and sign-in inside the embedded view. A local HTTPS stand-in plays `chatgpt.com` for the real
  navigation policy and the real view.
* **Real Tailscale** (`tailscale serve`) and real Firebase delivery.
* **Windows notification toasts** and clicking them (Linux has no notification service).

## 10. Reproduce

```bash
npm install
npm run verify                      # every layer that can run here, honest PASS/FAIL/NOT RUN
npm run verify -- --with-real-claude
npm run e2e -w @minisumma/desktop   # needs xvfb-run; regenerates docs/ACCEPTANCE.md
```
