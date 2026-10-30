# Verification

What was tested, at which layer, where it ran, and what was **not** run. Results of different layers and different
environments are kept apart on purpose: a Linux result says nothing about Windows, and a test against a fake Claude says
nothing about the real one. Every number below came from a command in this repository; `npm run verify` repeats all the layers
that can run on your machine and prints PASS, FAIL or NOT RUN for each. A layer that did not execute is never shown as passed.

Environment of the runs below: Linux (container), Node 22, Electron 45 under Xvfb, Claude Code 2.1.314. Date: 2026-10-30.

## At a glance

| Layer | Environment | Result |
| --- | --- | --- |
| Type check, every workspace | Linux | **PASS** |
| Unit and service tests | Linux | **PASS**: <!-- TODO(verify) totals --> |
| Integration: real core + real PTYs + fake Claude, four-project routing | Linux | **PASS** (inside the core suite) |
| Real Claude Code CLI through the core | Linux, Claude 2.1.314 | **PASS**, 17 of 17 steps |
| Desktop acceptance (25 behaviours + four-project scenario), real Electron | Linux, Xvfb | <!-- TODO(verify) E2E --> |
| Browser integration (extension in real Chromium) | Linux, Xvfb | <!-- TODO(verify) extension browser --> |
| Android unit tests and phone-code-against-real-core check | Linux, Node | **PASS** (216 tests; 10 of 10 checks) |
| Packaging | Linux, Wine for the Windows target | <!-- TODO(verify) packaging --> |
| **Windows runtime** | none | **NOT TESTED** |
| **WSL2** | none | **NOT TESTED** |
| **Real Android device or emulator** | none | **NOT TESTED** |
| **Real push delivery (Firebase)** | none | **NOT TESTED** |
| **The real ChatGPT site** | none | **NOT TESTED** |
| **Real Tailscale** | none | **NOT TESTED** |
| **Windows toast notifications** | none | **NOT TESTED** |

## 1. Unit and service tests (Linux)

<!-- TODO(verify) table -->

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
  deliveries; the handoff copies A's text and opens A's address even though B's is focused;
* phone approval boundary: a prompt from a paired phone waits for the desktop's approval, a revoked device's prompts are
  rejected, approvals are bound to the permission request that is open;
* authentication and scopes for every route against every kind of token.

An integration test that follows the WebSocket the way a client does found a real defect during the acceptance run (see
"Defects found by verification" below).

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

## 4. Desktop acceptance (Linux, real Electron under Xvfb)

<!-- TODO(verify) E2E: link to ACCEPTANCE.md, summary, three consecutive runs -->

## 5. Browser integration (Linux, real Chromium under Xvfb)

<!-- TODO(verify) extension browser results -->

## 6. Android (Linux)

* 216 Jest tests (pairing, connection state, reports, activity, remote prompts, offline handling, notification handling).
* `npm run check:core` in `apps/android`: 10 of 10 checks, with the phone's **own** pairing, connection and send code run
  against the real headless core: pairing and its error messages, snapshots in order, live events, removal while connected
  (close 4003) and while away, a refused prompt, the permission boundary, the rate limit, and an unreachable PC.
* A bundling check of the app.
* <!-- TODO(verify) APK outcome -->
* **Not run:** any emulator or device, so no screen has been seen running; Firebase push; Remote Control.

## 7. Packaging

<!-- TODO(verify) packaging -->

## 8. Defects found by verification

<!-- TODO(verify) list -->

## 9. What was not tested

Everything in the bold rows of the table above, and in particular:

* **Windows**: install, uninstall, ConPTY terminals, the folder picker, tray, `minisumma://` links, toasts, SmartScreen.
  [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) is the checklist for it.
* **WSL2**: launching Claude in a distribution, `wsl.exe` output, UNC and `/mnt` paths. Tests use recorded and simulated output.
* **Real devices**: no Android emulator or phone was available.
* **The real ChatGPT site** and sign-in inside the embedded view. A local HTTPS stand-in plays `chatgpt.com` for the real
  navigation policy and the real view.
* **Real Tailscale** (`tailscale serve`) and real Firebase delivery.
* **Windows notification toasts** and clicking them (Linux has no notification service).

## 10. Reproduce

```bash
npm install
npm run verify                      # every layer that can run here, honest PASS/FAIL/NOT RUN
npm run verify -- --with-real-claude
npm run e2e -w @minisumma/desktop   # needs xvfb-run; see ACCEPTANCE.md
```
