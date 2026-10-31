# Mini-Summa

<p align="center"><img src="assets/brand/mini-summa-logo.png" alt="The Mini-Summa logo: an owl whose eyes are an infinity sign" width="180"></p>

**Automate communication. Preserve context. Keep the human in control.**

Mini-Summa is a personal workspace for AI-assisted development. It sits between the ChatGPT conversations you already
use to plan and review work and the real Claude Code sessions that implement it:

* A Windows desktop app (Electron + React) shows your existing ChatGPT conversation (or a ChatGPT Project you link by its address)
  next to a real Claude Code terminal, or next to Claude Code on the web, per project, with a draggable divider that follows the
  window's orientation, and a control that shows both, ChatGPT alone or Claude alone without reloading anything. A project needs
  only a name: a ChatGPT Project, a GitHub repository and local folders are optional and independent. Local or cloud is chosen for
  each Claude session and one is never started in place of the other.
* When Claude finishes a task and writes a report, Mini-Summa captures it, ties it to the right project and session,
  freezes the ChatGPT conversation it belongs to, tells you, and gets it onto your clipboard and in front of that
  conversation with one click. You press Send in ChatGPT yourself; Mini-Summa never submits for you.
* Desktop notifications tell you when a local Claude session needs permission, asks something, fails, declares a report or simply
  finished its turn, and a click opens that project and session. Cloud sessions cannot notify (Anthropic documents no way for an
  application to follow one).
* An Android companion shows project status, activity and reports, delivers notifications, and lets you approve or send
  user-authored text to the right managed Claude session, always behind an explicit approval boundary.

It is not an agent loop. Nothing is sent to ChatGPT or typed into Claude unless you chose to.

## Documentation

| | |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Install, launch, add projects, map ChatGPT conversations, use Claude Code locally and in the cloud |
| [docs/CLOUD_SESSIONS.md](docs/CLOUD_SESSIONS.md) | What Anthropic documents about Claude Code cloud sessions, what is not documented, and what Mini-Summa does with each |
| [docs/CHATGPT_PROJECTS.md](docs/CHATGPT_PROJECTS.md) | Why existing ChatGPT Projects are linked by pasted address, and what is and is not known about OpenAI's side |
| [docs/CHATGPT_PANE.md](docs/CHATGPT_PANE.md) | The embedded ChatGPT page, the page size setting against overlapping controls, and the 10-minute check on your PC |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Exactly what is automated in the ChatGPT handoff and what stays manual |
| [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | Which notifications exist, how each is known (event, polled or inferred), how fast, and what needs Mini-Summa running |
| [docs/ANDROID.md](docs/ANDROID.md) | Build, install, pair and connect the Android companion |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow and the product rules the code enforces |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, what is stored where, public-repository policy |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | What was tested, at which layer, and what was not |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | The 25 desktop behaviours, the four-project scenario and the extra checks, one row each, generated from the run |
| [docs/WINDOWS_VERIFICATION.md](docs/WINDOWS_VERIFICATION.md) | The 40-minute checklist for what only a Windows PC can confirm, and the deeper lists behind it ([core](docs/audit/windows-core.md), [desktop](docs/audit/windows-desktop.md)) |
| [docs/PHONE_VERIFICATION.md](docs/PHONE_VERIFICATION.md) | The 30-minute first-run checklist for the Android app on your phone |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Prioritised remaining limitations |
| [docs/UI_PRINCIPLE_EXCEPTIONS.md](docs/UI_PRINCIPLE_EXCEPTIONS.md) | Where the interface differs from the vendored Summa-UI guidance, and why |

## Repository layout

```
apps/desktop            Electron main + preload, React renderer (served by the core under /ui/)
apps/browser-extension  Optional MV3 extension: focuses the mapped ChatGPT tab (tabs/windows APIs only)
apps/android            Expo / React Native companion (separate install)
packages/shared         Entities, API route table, WebSocket protocol, client SDK, ChatGPT URL rules
packages/storage        node:sqlite wrapper, migrations, schema
packages/core           The local service: sessions, ingestion, reports, deliveries, devices, HTTP/WS server
packages/claude-integration  The verified hook/reducer/discovery library from the research phase
poc/claude-integration  The immutable research record (131 tests, never edited)
third_party/summa-ui-guidance  Owner-approved Summa-UI design bundle, digest-pinned (summa-ui.lock.json)
```

## Quick start (development)

Requires Node.js 22.12 or newer and Claude Code installed on the machine that runs sessions.

```bash
npm install
npm run dev            # builds the hook script and the app, then launches the desktop app
npm test               # unit and integration suites of every workspace
npm run verify         # every layer this machine can run (types, unit, integration, browser, Electron), PASS/FAIL/NOT RUN
npm run verify:claude  # drives your real Claude Code through the core: launch, hooks, report, approve, reject, /clear, restart, resume
npm run verify:protocol         # how reliably your Claude ends a finished task with the report marker (natural prompts)
npm run verify:claude-external  # a Claude you started yourself, followed through installed hooks (your settings are restored)
npm run core -- --print-connection   # the core without the desktop shell (prints its address and token)
```

Windows installer: `npm --workspace @minisumma/desktop run dist:win` (on Linux this needs `wine`; the installer is
unsigned). See [docs/SETUP.md](docs/SETUP.md).

## Status

The base application is implemented end to end and verified on Linux at every layer that could run there, in a fresh clone of the
pushed branch: 4,917 unit, service and integration tests; the real core with real terminals; the real Claude Code CLI driven through
the core (21 of 21 steps, including approving and rejecting a real permission dialog, a phone's prompt, `/clear` and `/resume`, and
the new "Claude finished" notification), and a Claude started outside Mini-Summa followed through installed hooks (8 steps; 1 not
exercised because Claude ran in a mode that never asks permission); the real Electron app under a virtual display (the 25 desktop
behaviours and the four-project scenario: 25 pass, desktop notifications partial because an operating-system toast cannot be observed
on Linux, plus ten extra checks that pass, among them a whole-journey test of a workspace made from an existing ChatGPT Project and a
GitHub repository with no folder); and the browser extension in a real Chromium.

**Round 3 added** GitHub-only and ChatGPT-only projects, a fix for the folder that Browse used to throw away, linking an existing
ChatGPT Project by address, a Cloud tab (browser based) beside local Claude sessions, a page size setting against overlapping
ChatGPT controls, Split, ChatGPT and Claude views, "Claude finished" notifications, and the interface rebuilt on the vendored Summa-UI.
**Not verified:** the overlap itself was never reproduced and its fix is unproven on the real site; no Claude cloud session was ever
started and the real claude.ai and chatgpt.com were never reached (local stand-ins played them); nothing ran on Windows.

**Built but never run on their target:** the Windows installer (assembled under Wine) and the Android APK (46 MB, built in round 2 and
not rebuilt since). **Not exercised:** Windows, WSL2, an Android device or emulator, real push delivery, the real ChatGPT and Claude
sites, real Tailscale. [docs/VERIFICATION.md](docs/VERIFICATION.md) lists every layer with its real result,
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) what remains, [docs/WINDOWS_VERIFICATION.md](docs/WINDOWS_VERIFICATION.md) (Part 0 is new) and
[docs/PHONE_VERIFICATION.md](docs/PHONE_VERIFICATION.md) what only your PC and your phone can confirm.
