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
   If it found none, install Claude Code and press **Refresh**. A message names what is missing; it does not guess. This step, and
   the two that need a folder (a conversation, a session), are optional while every project is a GitHub-only or ChatGPT-only one.
2. **Create your first project.** A project needs only a name. Everything else is optional and independent: a ChatGPT Project, a
   GitHub repository, local folders.
3. **Add its ChatGPT conversation.** See below.
4. **Choose how ChatGPT opens.** Inside Mini-Summa, or in your browser.
5. **Install Claude hooks** (optional). See below.
6. **Start a Claude session.** Local (needs a folder) or cloud (needs a GitHub repository).

## Add a project

**New project** (the button at the top of the sidebar) asks how the project starts. Choose one of four, give the one thing it needs,
check the name and press **Create project**:

* **ChatGPT Project**: paste the address of a ChatGPT Project you already have (open it in ChatGPT and copy the address bar). The
  title is read from the words in the address. Only the address is saved; nothing in the project is imported or synced, and an
  invitation token pasted with it is dropped. OpenAI offers no way to list your projects, so pasting is the way
  ([CHATGPT_PROJECTS.md](CHATGPT_PROJECTS.md)).
* **GitHub repository**: `owner/repo`, or any way of pasting it (a link, a clone address). No folder, no clone.
* **Local folder**: **Browse** or type a path (for work inside WSL2 choose the folder in the distribution; Windows and WSL2 folders
  are kept apart and never merged). The path must exist.
* **Empty project**: just a name. Add the rest later.

The name suggests itself from what you gave (the project's title, the repository name or the folder name); type another if you
like. A project that has only a GitHub repository is complete, not unfinished.

**Project settings** (the pencil in the workspace header, or the project's menu in the sidebar) holds the rest, in order: Name,
ChatGPT Project (link, change, open, unlink), GitHub repository, Local folders (Browse adds the folder at once; a typed path with
Enter) and the ChatGPT conversations used for reports. **Every change is applied as you make it** and shows "Saved"; there is no Save
button and nothing is thrown away: **Done** (or Esc) first finishes whatever you typed, and keeps the dialog open to tell you if
something cannot be saved.

A project can have several folders (a monorepo with a separate docs folder, say). A local Claude session belongs to the project
whose folder it runs in.

## Map ChatGPT conversations

Mini-Summa never finds a conversation by looking at the tab you happen to have open. You tell it which conversation belongs
to which project, once:

1. Open the existing conversation in ChatGPT (in the app or in your browser).
2. Copy its address from the address bar. It looks like `https://chatgpt.com/c/0a1b2c3d-...`.
3. In the project's settings, under ChatGPT conversations, paste it into **Conversation address** and press **Add conversation**.
   Mini-Summa checks the address, shows the cleaned-up form it will use and warns if it is a project page or a landing page rather
   than one conversation. If the ChatGPT pane is showing a conversation of a linked ChatGPT Project, **Use this conversation for
   reports** does the same in one press.

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

**Page size** (Settings, ChatGPT, only for the embedded view): Automatic (default), 100%, 90%, 80% or 70%. It is the view's own
browser zoom, what Ctrl and minus do in a browser. In a narrow pane Automatic zooms out so that ChatGPT gets about 900 CSS pixels
(never below 70%); it was added against ChatGPT's floating controls overlapping the writing blocks, a report that could not be
reproduced here. Choose 100% if you want the text large and do not see the overlap. Details and the check to run on your PC:
[CHATGPT_PANE.md](CHATGPT_PANE.md).

## Use Claude Code

Select a project. In the Claude pane, **New local session** (the button of an empty pane, or the **+** next to the tabs) starts a real
Claude Code terminal on the right (or below, in portrait) in the project's folder. Type in it as you would anywhere else.

**Local or cloud is chosen for each session, and one is never started in place of the other.** A local session needs a folder; a
cloud session needs a GitHub repository. When one is not possible the menu says why and offers the way to fix it. **New cloud
session** opens the **Cloud** tab: the page of Claude Code on the web with your repository preselected. Nothing starts until you
write the task and submit on that page. Mini-Summa only shows the page; it cannot see whether a cloud session is working, done or
waiting, and sends no notification for one. Read [CLOUD_SESSIONS.md](CLOUD_SESSIONS.md) before relying on it.

* The line above the terminal always says where your keystrokes go: "Input goes to: GitManager / Session a1b2c3d4 (managed,
  Windows)". Sessions you started in another terminal are shown as **observed**: you can read their state, not type into them.
* The first time Claude Code opens a folder it asks whether you trust it. The default answer is "No, exit". Mini-Summa never
  answers that for you; if a session sits on "Starting" for a few seconds it tells you this might be why.
* Several sessions can run per project, and several projects can be active at once. Switching projects only changes what you see:
  no terminal is restarted. Quitting Mini-Summa ends the terminals it owns; the sessions stay in the list as **resumable** and
  **Resume** continues them with `claude --resume`.
* You can type `/clear` or `/resume` in the terminal. Claude then starts another conversation inside the same terminal;
  Mini-Summa notices that the same process now runs a new session, keeps your tab and keyboard where they are and moves them to
  the new session. The earlier conversation stays in the session menu under "Replaced inside their terminal", as ended.
* Closing the window with the X **quits** Mini-Summa; there is no run-in-the-tray mode. If terminals are running it asks once
  ("Quit and end terminals" or Cancel), then hides the window, ends the terminals, stops the local service and exits. The tray icon
  offers Open, Quiet mode and Quit.
* The window follows its shape: ChatGPT on the left and Claude on the right when it is wide, ChatGPT above Claude when it is
  tall. Drag the divider to change the proportion (it is remembered per orientation) and choose the orientation yourself in the
  layout menu if you do not want automatic. The **Workspace view** control in the header shows **Split**, **ChatGPT** only or
  **Claude** only (Ctrl+Shift+Left and Ctrl+Shift+Right do the same while the keyboard is in the Mini-Summa window). Nothing is closed
  or reloaded when you switch: the hidden pane keeps its page, its half-written message and its terminal.
* **Search** (the entry under New project, or Ctrl+Shift+P) switches project by typing part of its name, repository or folder.

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
| "Local sessions need a folder" | The project has no folder. Open its settings and add one, or use **New cloud session** if it has a repository. |
| The Cloud tab asks you to sign in, or sign-in is refused | Sign in on the page. If your sign-in method (Google, say) is refused inside Mini-Summa, use an email address or **Open in your browser**. |
| ChatGPT looks small | Settings, ChatGPT, Page size: choose 100%. |
| "Send a test notification" shows nothing | Windows Settings, System, Notifications, Mini-Summa must be on and Focus assist off. |
| No toasts | Windows Focus assist or Do not disturb is on, or Mini-Summa quiet mode is on. |

Logs: `%APPDATA%\Mini-Summa\logs\main.log` (the application shell: start, quit, links, second launches) and
`%APPDATA%\Mini-Summa\data\logs` (the local service). They never contain tokens or report text.
