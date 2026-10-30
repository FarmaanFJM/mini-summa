# Setting up Mini-Summa

This is the desktop guide: install, start, register projects, map ChatGPT conversations and use Claude Code. For the phone see
[ANDROID.md](ANDROID.md). For what is automated and what stays manual see [HANDOFF.md](HANDOFF.md).

## What you need

* Windows 10 (21H2) or Windows 11, 64-bit (the installer refuses anything older than Windows 10 version 1809). Mini-Summa runs
  without administrator rights.
* **Claude Code**, installed and logged in. Open PowerShell and run `claude --version`; if that prints a version you are
  ready. Claude Code on Windows needs Git for Windows. If you work inside WSL2, install Claude Code in the distribution too.
* A **ChatGPT** account and at least one existing conversation for each project you want to connect.
* Optional: Tailscale (to reach Mini-Summa from your phone), a browser extension install (see below), a Firebase project
  (for push notifications when the app is closed on the phone).

Mini-Summa is not an agent loop. It never submits anything to ChatGPT and never types into Claude unless you press the button.

## Install

Build the installer once on any machine with Node.js 22.12 or newer:

```powershell
git clone https://github.com/FarmaanFJM/mini-summa
cd mini-summa
git checkout feat/mini-summa-full-base
npm install
npm run dist:win
```

The installer appears in `apps/desktop/release/` (`Mini-Summa-Setup-<version>.exe`). Run it: it installs for your user only
(under `%LOCALAPPDATA%\Programs\Mini-Summa`), needs no administrator prompt, adds a Start Menu entry and registers the
`minisumma://` link. The installer is **not code-signed**, so Windows SmartScreen shows "Windows protected your PC": choose
**More info**, then **Run anyway**. **Neither the installer nor the application has been run on Windows yet**: the installer in this
repository's status report was built on Linux with `wine`, which is also how `dist:win` works there. Building it on Windows is
untried too. [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) is the checklist for the first run; start with its step 11.

To run from source instead: `npm install`, then `npm run dev`. The desktop app starts its own local service; you never start a
server yourself.

## First start: the checklist

The first screen is a checklist built from facts Mini-Summa reads, not from boxes you tick. It is right even if you did a step
another way.

1. **Claude Code is installed.** Mini-Summa looks in Windows and in every WSL2 distribution and shows the version it found.
   If it found none, install Claude Code and press **Refresh**. A message names what is missing; it does not guess.
2. **Create your first project.** A project is a name plus one or more repository folders.
3. **Add its ChatGPT conversation.** See below.
4. **Choose how ChatGPT opens.** Inside Mini-Summa, or in your browser.
5. **Install Claude hooks** (optional). See below.
6. **Start a Claude session.**

## Register a project

**New project** (the plus next to Projects in the sidebar) asks for:

* a **name** (shown everywhere, so choose the one you would say aloud: "GitManager");
* the **repository folder**, picked with the Windows folder picker. For work inside WSL2, choose the folder in the distribution
  (`\\wsl$\Ubuntu\home\you\project` or the Linux path); Windows and WSL2 folders are kept apart and are never merged;
* optionally the GitHub repository (`owner/repo`) and a description;
* where **new sessions start**: Windows or a WSL2 distribution.

A project can have several folders (a monorepo with a separate docs folder, say). A Claude session belongs to the project
whose folder it runs in.

## Map ChatGPT conversations

Mini-Summa never finds a conversation by looking at the tab you happen to have open. You tell it which conversation belongs
to which project, once:

1. Open the existing conversation in ChatGPT (in the app or in your browser).
2. Copy its address from the address bar. It looks like `https://chatgpt.com/c/0a1b2c3d-...`.
3. In the project, **Add conversation** and paste it. Mini-Summa checks the address, shows the cleaned-up form it will use
   and warns if it is a project page or a landing page rather than one conversation.

A project can have several conversations: give them titles and mark one **preferred**. A report goes to the conversation bound
to its Claude session, then to the project's preferred conversation, then to the project's only conversation. If none of these
exist the report waits with the plain message "no destination" until you map one; it is never sent to another project's
conversation. The destination is written into the delivery when the report arrives, so changing the preferred conversation
later does not move reports already waiting. Changing a waiting delivery's destination is an explicit button, and it is logged.

## ChatGPT inside the app, or in your browser

* **Inside Mini-Summa** (default): ChatGPT loads in a view of its own with its own saved sign-in. It is a normal browser
  profile, not a modified one. If ChatGPT or Google refuses to sign in inside an embedded view, Mini-Summa says so; sign in
  with your email and password, or choose your browser (below).
* **In your browser** (Settings, ChatGPT): Mini-Summa opens the mapped conversation in your default browser. To avoid a new tab
  every time, install the optional **Mini-Summa tab focus** extension for Chrome, Edge or Brave
  ([apps/browser-extension/README.md](../apps/browser-extension/README.md)): build it with `npm run build -w
  @minisumma/browser-extension`, load the `dist` folder from `chrome://extensions` (Developer mode, **Load unpacked**), and
  pair it with the pairing link shown under Settings, Browser extension. The extension can only focus or open the tab. It
  cannot read the page.

Either way the handoff itself is the same: the message is on your clipboard and you paste it.

## Use Claude Code

Select a project and press **New session**. A real Claude Code terminal starts on the right (or below, in portrait) in the
project's folder. Type in it as you would anywhere else.

* The line above the terminal always says where your keystrokes go: "Input goes to: GitManager / Session a1b2c3d4 (managed,
  Windows)". Sessions you started in another terminal are shown as **observed**: you can read their state, not type into them.
* The first time Claude Code opens a folder it asks whether you trust it. The default answer is "No, exit". Mini-Summa never
  answers that for you; if a session sits on "Starting" for a few seconds it tells you this might be why.
* Several sessions can run per project, and several projects can be active at once. Switching projects only changes what you see:
  no terminal is restarted. Quitting Mini-Summa ends the terminals it owns; the sessions stay in the list as **resumable** and
  **Resume** continues them with `claude --resume`.
* Closing the window with the X **quits** Mini-Summa; there is no run-in-the-tray mode. If terminals are running it asks once
  ("Quit and end terminals" or Cancel), then hides the window, ends the terminals, stops the local service and exits. The tray icon
  offers Open, Quiet mode and Quit.
* The window follows its shape: ChatGPT on the left and Claude on the right when it is wide, ChatGPT above Claude when it is
  tall. Drag the divider to change the proportion (it is remembered per orientation), double-click a pane header or use
  Ctrl+Shift+arrow to maximize one pane, and choose the orientation yourself in the view menu if you do not want automatic.

## Reports and the handoff

When a Claude session finishes a task it ends its message with the report block. Mini-Summa gives managed sessions the
instructions for that automatically through the hook it started them with, only in folders that belong to a registered project. Then:

1. The report appears in the project's feed and in **Reports**, and you get a notification. A strip at the bottom of the
   workspace says "Report ready: <task>" for the project you are looking at.
2. Open it, or just use the strip. The report shows the full text, the session it came from, and its destination conversation.
3. **Copy and open** (on the report or in the strip) puts the whole message on the clipboard and brings the mapped conversation to
   the front. Long reports are split into numbered parts, and each part is copied in turn.
4. Paste and press Send in ChatGPT yourself.
5. Press **I sent it** (the strip keeps it within reach: "Waiting for you to send ..."), or **Not sure**, or **Discard** (in
   Reports). Mini-Summa records what you say; it cannot see ChatGPT.
6. Later you can note that ChatGPT answered, paste the answer's follow-up, and, if you want Claude to act on it, send it to a
   verified Claude session. That last step types into the terminal only after you approve exactly that text.

Claude's marker is a declaration by the model. A report is shown as "Claude says it is complete", never as verified work.

## Claude hooks

Managed sessions already report to Mini-Summa through settings passed on their command line; your own Claude configuration is not
touched. Install hooks only to follow sessions you start yourself (for example in Windows Terminal or VS Code):

1. Settings, Claude hooks, choose the environment, **Install hooks**.
2. Mini-Summa shows the exact change to `settings.json` as a diff. Nothing is written until you confirm.
3. It backs the file up first and only ever removes its own entries (**Remove hooks**).

Sessions you start yourself are observed: reports, activity and notifications work, typing into them from Mini-Summa does not.

## Notifications, phone, and your data

* Windows notifications and quiet mode: [NOTIFICATIONS.md](NOTIFICATIONS.md).
* Phone, Tailscale, pairing and push: [ANDROID.md](ANDROID.md).
* Your data lives in `%APPDATA%\Mini-Summa\data` (database, logs, hook spool, backups). Settings, Data and privacy shows how
  much space it uses and lets you clear old history. Nothing is written into your repositories.
* Security and privacy: [SECURITY.md](SECURITY.md).

## Troubleshooting

| You see | What it means and what to do |
| --- | --- |
| "Claude Code was not found" | It is not on `PATH` for Mini-Summa. Install it, or check `claude --version` in PowerShell, then **Refresh**. |
| A session stays on "Starting" | Claude is probably waiting for you in the terminal (folder trust, login). Answer there. |
| ChatGPT will not sign in inside the app | Use email sign-in, or Settings, ChatGPT, open in your browser. |
| Port in use at start | Another program uses 47811. Mini-Summa takes another free port. If Tailscale Serve was publishing the old port, Settings, Remote access says so and offers to re-point it; the phone address is not offered until it points at the right port. |
| A report says "no destination" | The project has no conversation mapped. Add one and the report can be handed off. |
| No toasts | Windows Focus assist or Do not disturb is on, or Mini-Summa quiet mode is on. |

Logs: `%APPDATA%\Mini-Summa\logs\main.log` (the application shell: start, quit, links, second launches) and
`%APPDATA%\Mini-Summa\data\logs` (the local service). They never contain tokens or report text.
