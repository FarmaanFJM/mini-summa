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
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Prioritised remaining limitations |

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
npm run core -- --print-connection   # the core without the desktop shell (prints its address and token)
```

Windows installer: `npm --workspace @minisumma/desktop run dist:win` (on Linux this needs `wine`; the installer is
unsigned). See [docs/SETUP.md](docs/SETUP.md).

## Status

The base application is implemented end to end. Windows, WSL2, real Android devices, real push delivery and the real
ChatGPT site could not be exercised from the cloud environment this was built in, and are reported as **NOT TESTED**
rather than assumed. [docs/VERIFICATION.md](docs/VERIFICATION.md) lists every layer with its real result.
