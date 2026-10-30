# Mini-Summa

**Automate communication. Preserve context. Keep the human in control.**

Mini-Summa is a personal workspace for AI-assisted development. It sits between the ChatGPT conversations you already
use to plan and review work and the real Claude Code sessions that implement it:

* A Windows desktop app (Electron + React) shows your existing ChatGPT conversation next to a real Claude Code terminal,
  per project, with a draggable divider that follows the window's orientation.
* When Claude finishes a task and writes a report, Mini-Summa captures it, ties it to the right project and session,
  freezes the ChatGPT conversation it belongs to, tells you, and gets it onto your clipboard and in front of that
  conversation with one click. You press Send in ChatGPT yourself; Mini-Summa never submits for you.
* An Android companion shows project status, activity and reports, delivers notifications, and lets you approve or send
  user-authored text to the right managed Claude session, always behind an explicit approval boundary.

It is not an agent loop. Nothing is sent to ChatGPT or typed into Claude unless you chose to.

## Documentation

| | |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Install, launch, register projects, map ChatGPT conversations, use Claude Code |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Exactly what is automated in the ChatGPT handoff and what stays manual |
| [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | Which notifications exist, what depends on external setup |
| [docs/ANDROID.md](docs/ANDROID.md) | Build, install, pair and connect the Android companion |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow and the product rules the code enforces |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, what is stored where, public-repository policy |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | What was tested, at which layer, and what was not |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | The 25 desktop behaviours and the four-project scenario, one row each, generated from the run |
| [docs/WINDOWS_VERIFICATION.md](docs/WINDOWS_VERIFICATION.md) | The 40-minute checklist for what only a Windows PC can confirm |
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
npm run verify:claude  # drives your real Claude Code through the core: launch, hooks, report, approve, reject, restart, resume
npm run core -- --print-connection   # the core without the desktop shell (prints its address and token)
```

Windows installer: `npm --workspace @minisumma/desktop run dist:win` (on Linux this needs `wine`; the installer is
unsigned). See [docs/SETUP.md](docs/SETUP.md).

## Status

The base application is implemented end to end. It was verified on Linux at every layer that could run there: about 3,900 unit,
service and integration tests; the real core with real terminals; the real Claude Code CLI driven through the core (17 of 17
steps, including approving and rejecting a real permission dialog and a phone's prompt); the real Electron app under a virtual
display (the 25 desktop behaviours and the four-project scenario: 25 pass, and desktop notifications are partial because an
operating-system toast cannot be observed on Linux); and the browser extension in a real Chromium.

**Not exercised:** Windows, WSL2, an Android device or emulator, real push delivery, the real ChatGPT site, real Tailscale.
**Not built:** the Android APK (Maven Central rate-limited the build from the sandbox it was made in; see
[docs/ANDROID.md](docs/ANDROID.md)). The Windows installer builds but has never been installed.
[docs/VERIFICATION.md](docs/VERIFICATION.md) lists every layer with its real result, [docs/LIMITATIONS.md](docs/LIMITATIONS.md)
what remains, and [docs/WINDOWS_VERIFICATION.md](docs/WINDOWS_VERIFICATION.md) what only your PC can confirm.
