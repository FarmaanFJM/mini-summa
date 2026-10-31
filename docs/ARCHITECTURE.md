# Mini-Summa architecture

Philosophy: **automate communication, preserve context, keep the human in control.**
Mini-Summa moves information between a person's existing ChatGPT conversations and their real Claude Code sessions.
It never submits anything to ChatGPT, never types into Claude without an explicit user action, and always says
plainly what it knows and what it only suspects.

## Components

```
apps/desktop (Electron)                       packages/core (Node, runs inside Electron main or headless)
 ├─ main     window, ChatGPT WebContentsView   ├─ http/   Hono API on 127.0.0.1 + WebSocket (/ws) + /ui static
 │           NativeBridge, notifications,      ├─ claude/ sessions, managed PTYs, discovery, ingestion, environments
 │           tray, minisumma:// protocol       ├─ workflow/ activity, notifications, reports, deliveries, actions
 ├─ preload  window.miniSumma (NativeApi)      ├─ infra/  settings, projects, devices+pairing, hooks installer,
 └─ renderer React web client of the core API  │          tailscale, push (FCM), extension bridge, data retention
                                               └─ core.ts composition root, orchestrator.ts glue
apps/browser-extension (MV3)  focuses a ChatGPT tab through tabs/windows APIs only
apps/android (Expo)           companion: status, reports, activity, notifications, guarded intervention
packages/shared               entities, route table (zod), WebSocket protocol, client SDK, client state reducer,
                              ChatGPT URL rules, report message + lossless splitting, pairing payload, root-path rules
packages/storage              node:sqlite wrapper, migrations, the schema (the contract between services)
packages/claude-integration   the verified Phase 0A library: hook capture, reducer, discovery, registry, markers
poc/claude-integration        the immutable research record (131 tests, never edited)
```

The renderer is **not** special: it talks to the core through the same typed client SDK (`@minisumma/shared`
`MiniSummaClient`) as the Android app. The only things a web page cannot do (native view, clipboard, folder picker,
notifications that navigate) come from `window.miniSumma`, exposed by the preload.

## Hard rules (these are product behaviour, not style)

1. **Identity.** A session is `(environment, session id)`, written `<env>|<uuid>` (`SessionKey`). Environments are
   `win`, `wsl:<Distro>`, `posix`. A bare session id is never an identity. Windows and WSL are never merged.
   A managed terminal follows its *process*, not the id: when Claude replaces the conversation inside it (`/clear`, `/resume`),
   Claude keeps running in the same process under a new session id. The core re-keys the managed record to the new id when the
   process identity proves it (the pid in `claude agents --json`, which the spool cannot forge; hooks decide only where pids cannot
   be compared), the old key becomes ordinary history (`SessionView.replacedBy` names its successor), and an ambiguous case is
   left alone and shown as such, never guessed.
2. **Routing.** The destination of a report is resolved from explicit mappings only (session binding, then the
   project's preferred conversation, then the project's only conversation) and **frozen into the delivery record**
   when the delivery is created. It never follows the focused tab or window. Changing it is an explicit user action
   with an audit event.
3. **No automated ChatGPT submission.** Mini-Summa prepares the message, copies it (one click), opens or focuses the
   mapped conversation and then waits. Whether it was sent is a statement by the user (`user_confirmed_sent`).
   Optional paste assist (default off) pastes on the user's click and never presses Send. Mini-Summa cannot read
   ChatGPT's answer by any supported means, so every review state after `requested` is a user statement.
4. **No automated typing into Claude.** Text reaches a Claude session only through a `PendingAction` whose target is
   re-verified at execution: managed (a PTY Mini-Summa owns), live, same generation, a state that accepts input. A
   click on the desktop is itself the approval; a prompt from a phone waits for approval unless that device was
   marked trusted. External sessions are observed, never typed into.
5. **Honest lifecycle.** `Stop` is not task completion. A report marker is a declaration by the model, never proof.
   Observed termination (SessionEnd hook, dead pid) is kept apart from suspected termination (absent from a listing).
   Ordering that cannot be established stays `uncertain`. Wall clocks establish nothing. The PoC reducer enforces this
   and its 131 tests are preserved.
6. **Managed PTYs do not survive the app.** When Mini-Summa exits, its terminals end. On the next start those
   sessions are `disconnected`/`resumable` and can be resumed with `claude --resume`.
7. **Secrets.** Hook payloads are redacted at capture. Device tokens are stored only as SHA-256 hashes. Push payloads
   carry no report bodies, tool inputs or paths. Runtime data lives in the user's data directory, never in a repo.
8. **Tailscale.** Remote access uses `tailscale serve` only. Funnel is never enabled and is reported if detected.
   When the PC is asleep or offline, the phone says so; it never shows stale data as live.
9. **A project is a set of independent associations, and execution is chosen per session.** A project has an identity (its
   name) and, each optional and none depending on another: a GitHub repository (`owner/repo`), local folders, a link to an
   existing ChatGPT Project (its address only: Mini-Summa cannot list ChatGPT Projects and imports nothing from them), ChatGPT
   conversations used as report destinations, and Claude sessions. A project with only a GitHub repository is complete. A project is a
   persistent workspace, not a chat: opening or creating a ChatGPT conversation never creates a project or maps a destination, and the
   project reopens on the last ChatGPT page used in it (tracked locally; the newest conversation of a ChatGPT Project cannot be found). Where a
   Claude session runs is decided when the session starts: Local needs a local folder, Cloud needs the GitHub repository. One is
   never substituted for the other; when the chosen one is impossible the interface says why and what to add.

## Data flow: a report

```
Claude Code (managed or external)
  └─ hook process (capture.mjs, always exit 0) ─ atomic file ─▶ spool/<env>/*.json
                                                                   │
core/claude/ingestion: ingestSpoolFiles ─▶ raw_events (SQLite) ─▶ Reducer.apply (in memory, replayable)
                                                                   │ derived events, reports, candidates
core/claude/sessions: attribute (managed binding > manual binding > registry) ─▶ SessionView + ClaudeEventHandlers
                                                                   │
core/orchestrator (glue):
   report   ─▶ reports.capture ─▶ deliveries.onReportCaptured (resolve + freeze destination, honest state)
            ─▶ activity.record ("Report ready: <task>") ─▶ notifications.consider (native + push)
   permission/input/error/ended/presence_lost ─▶ activity.record ─▶ notifications.consider
   managed needs_permission ─▶ actions.raisePermission
                                                                   │
bus.emit(ServerEvent) ─▶ WebSocket clients (desktop renderer, phone) ─▶ client state reducer (shared)
```

Handoff (all steps are user actions on the desktop):
`ready_for_handoff` → **Copy and open** (`deliveries.handoff`: clipboard + open/focus frozen destination) →
`awaiting_user_send` → user pastes and presses Send in ChatGPT → **I sent it** → `user_confirmed_sent`
(`review: requested`). Anything unclear: **Not sure** → `delivery_uncertain`; **Discard** → `user_discarded`.
Long reports are split losslessly into numbered parts (each copied separately, tracked per part).

## Storage

SQLite via `node:sqlite` (WAL), file `<dataDir>/mini-summa.db`. Schema and migrations: `packages/storage/src/schema.ts`.
`raw_events` is the append-only replay source of truth for session state; `reports`, `deliveries`, `activity`, …
are the durable product records. Reducer state is rebuilt by replay at startup; activity ids derive from the cause so a
replay never re-creates or re-notifies old events. Retention (settings) prunes old raw events/activity/notifications;
reports and deliveries are kept unless the user sets `reportsDays`.

## Core services and who owns what

| Directory | Contents | Contracts |
| --- | --- | --- |
| `packages/core/src/claude/` | `SessionsService`, `EnvironmentsService`: managed PTYs, discovery polling, spool ingestion, SQLite raw store, reducer projection, `SessionView` building, registry file, per-env layout | `contracts.ts` |
| `packages/core/src/workflow/` | `ActivityService`, `NotificationsService`, `ReportsService`, `DeliveriesService`, `ActionsService` | `contracts.ts` |
| `packages/core/src/infra/` | `SettingsService`, `ProjectsService`, `DevicesService`, `HooksService`, `TailscaleService`, FCM `PushProvider`, `ExtensionBridge`, `DataService`, HTTP/WebSocket server, headless CLI | `contracts.ts`, `shared/routes.ts` |
| `packages/core/src/{core,orchestrator}.ts` | composition root and glue | architect |

Each service is a factory taking the dependencies it needs (`createXService(deps)`), never a global. Cross-service
calls go through the interfaces in `contracts.ts`. Services own their SQL; every service tests itself against an
in-memory database created by `openDatabase(':memory:')`.

## HTTP and WebSocket

`routes` in `@minisumma/shared` is the single source of truth: method, path, minimum scope, zod schemas. The server
registers a handler per route name (the type `Record<RouteName, Handler>` makes a missing one a compile error), the SDK
builds its calls from the same table. Errors are `{error:{code,message,details?}}`. All routes except `system.health` and
`pairing.redeem` need `Authorization: Bearer <token>`. Scopes: `desktop` (owner, everything), `read`, `notify`,
`prompt`, `approve`, `extension`. The server binds `127.0.0.1` only, validates the `Host` header (localhost, 127.0.0.1,
and the configured Tailscale DNS name), and applies `Idempotency-Key` to routes marked `idempotent`.

`/ws`: first message `hello` with the token; then numbered events (`ServerEvent`) filtered by topic and scope; terminal
traffic (`term.*`) for managed sessions needs `desktop`. Reconnect with `since=<last seq>`; if the buffer no longer
reaches back the server answers `resync: true` and the client reloads snapshots (`system.state` carries `seq`).

## What the window remembers

The desktop shell starts the core on the same port every time (47811, or the next free one when it is taken) and the window keeps
the choices that matter in the core, not in the browser profile that belongs to that port: the selected project and view, per
project the selected session, the selected conversation, the last page of Claude Code on the web (`cloudUrl`, only an address on
claude.ai/code, stored without its query) and the last page of ChatGPT (`chatgptUrl`, only a conversation or project page on
chatgpt.com, no query, recorded by `app/chatgptRecorder.ts` from the address the view reports), and the dismissed setup hints (`Settings.ui`, validated by the route's schema; ids and
addresses only). While a project's Cloud tab is the one shown, its remembered session is sent as null, so the host knows no local
session is on screen (a "Claude finished" notification is held back only for a session that is). The renderer sends changes after 0.6 s of quiet and, as the page closes, with a request that
outlives it (`app/uiSync.ts`, `app/keepalive.ts`). The window's size, position and maximised state are the shell's own
(`apps/desktop/src/main/windowState.ts`); the open tabs and the divider stay in the renderer. When a managed terminal goes on under another session id (`/clear`,
`/resume`) the core names the successor in `SessionView.replacedBy` and the renderer moves the tab and the remembered choice to it
(`app/followSessions.ts`).

## ChatGPT integration modes

* **Embedded** (default): a sandboxed `WebContentsView` for each project (a bounded set of four live views, least recently used
  unloaded with a notice; `main/chatgptViews.ts`, [CHATGPT_PANE.md](CHATGPT_PANE.md)), all in one persistent partition (`persist:chatgpt`),
  context isolation, no Node, navigation restricted by `classifyNavigation`, no user-agent spoofing. If the site
  refuses the embedded view (Google sign-in often does), the status says so and the user switches to external mode.
* **External**: opens the mapped URL in the default browser. The optional MV3 extension (tabs/windows APIs only, no
  content scripts, no page access) lets Mini-Summa focus an already-open tab instead of opening a duplicate.
* In both modes the clipboard handoff is the reliable path; no mode reads from or writes into the ChatGPT page.
* The view's own browser zoom follows its pane (Settings, ChatGPT, Page size; `main/pageScale.ts`), the only thing the shell does to the
  page. Why, and what is hypothesis: [CHATGPT_PANE.md](CHATGPT_PANE.md). A workspace can be linked to an existing ChatGPT Project by its
  address (nothing imported; [CHATGPT_PROJECTS.md](CHATGPT_PROJECTS.md)); with no mapped conversation the embedded view shows that page.

## Claude Code on the web (the Cloud tab)

A second native view, `persist:claude`, the same hardening as the ChatGPT view, shown by the Cloud tab of the Claude pane
(`main/claudeView.ts`, `claudeElectronView.ts`; policy `classifyClaudeNavigation` in `packages/shared/src/claude-web.ts`). It is the
page of Claude Code on the web and nothing more: Mini-Summa cannot list, follow or notify about cloud sessions because Anthropic
documents no way to ([CLOUD_SESSIONS.md](CLOUD_SESSIONS.md)). Local and cloud are chosen for each session and one is never started in
place of the other. One overlay switch hides both native views while a menu or dialog is over the window; hiding never destroys a view.

## Testing layers

unit (shared, storage, claude-integration incl. the 131 PoC tests) → service tests on SQLite (core) → integration with a
**fake Claude CLI** that runs the real hook command from `--settings` (managed sessions, permission dialogs, discovery,
restart recovery, the four-project routing scenario) → renderer component tests → Electron acceptance under Xvfb with
Playwright → a few confirmation runs against the real Claude Code CLI. Results are reported separately per layer and per
environment; Windows, WSL2, real devices, real push and the real ChatGPT site are reported **NOT TESTED** unless
actually exercised there.
