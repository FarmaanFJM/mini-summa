# Verifying Mini-Summa on Windows

This page has three tiers, so that your time goes only to what a machine cannot check.

| Tier | Who runs it | What it covers | Time |
| --- | --- | --- | --- |
| **1. Automated** | GitHub Actions, a real Windows runner, on every push | build, tests, installer, silent install and uninstall, launch, restart persistence, PowerShell hook, test toast request | 0 |
| **2. Essential manual** | **You**, on your PC | R1, R3, R4, R5, R7, the PowerShell hook (step 11), and the project/conversation continuity checks (P1 to P4) | about 45 minutes |
| **3. Optional** | You, if you want more | the rest of Part 0, Part 1, WSL2, phone, real-Claude developer checks | as you like |

**Nothing is claimed as verified beyond what a tier shows.** Tier 1 ran on a Windows Server image with an administrator account, one
virtual display, no person at the screen and no ChatGPT or Claude login. It cannot show what a human sees, clicks or signs in to.

## Tier 1: what CI already checked (details: [WINDOWS_CI.md](WINDOWS_CI.md))

Latest complete native run of the installed application: **commit 91bd25d, run 41179575582 (and 41179579093 for the pull request), runner image
win25-vs2026 20261021.278.1, Windows build 10.0.26100, Node 22.23.4, Electron 45.1.0. All jobs green; the installed-app report: 24 checks passed, 0 failed,
3 informational.** The first run (41176630640) had 22 passed and 2 failed; the failures were a wrong uninstall command in the check, a race in the
check, and a continuity defect found by it (below).

* **Passed on the runner:** the installer asks for no elevation; silent per-user install; files and ConPTY components on disk; the `minisumma://` key;
  per-user uninstall entry, nothing in Program Files or HKLM; the installed app launches and shows its window; a project with a GitHub repository and a
  ChatGPT link but no folder is accepted; a folder (spaces, accented letter) persists and is read back; a missing folder is refused with a message and
  nothing is stored; everything the app held (project, folder, associations, route, the remembered Cloud and ChatGPT pages) is identical after quit and
  relaunch; the Windows host environment and the `claude` CLI are found; **the PowerShell hook (W-11): PowerShell does not wait for the app without
  `| Write-Output` (0.01 s) and does with it (3.06 s), and the SessionStart and Stop commands wrote their spool record before PowerShell returned**;
  `notifications.test`: Windows accepted the toast request; silent uninstall (with the command Windows registered, `/currentuser /S`) removes the program,
  the protocol key and the uninstall entry (the entry goes about 2 s after the folder) and keeps your data.
* **What the restart check does and does not show for ChatGPT continuity.** The running app replaced the address the check had written (a conversation) with
  the linked project page before the check quit it, because the window records the ChatGPT page it shows. The check therefore shows that the page the app
  recorded survives a restart on Windows. It does **not** show that a remembered conversation is reopened: the runner has no signed-in ChatGPT and the
  conversation address is made up. The first run exposed a real defect in the restore (a failed or redirected restore overwrote the remembered
  conversation); it is fixed and covered on Linux against a stand-in (X11), and **untested on Windows and on the real chatgpt.com**. P1 to P4 below are the
  check that matters.
* **Also run natively by CI:** type check, unit tests of six packages, the installer build. Known exclusions and Windows-only observations are listed in
  [WINDOWS_CI.md](WINDOWS_CI.md): 17 core test files that need a POSIX fake `claude` are skipped on Windows (untested there), ConPTY resize is not
  verified, and an oversize request body can be answered with a connection reset instead of a 413 message. The installer is **not code-signed**.

**The installer built by that run** (artifact `mini-summa-windows-installer` of run 41179575582): `Mini-Summa-Setup-0.1.0-x64.exe`, 122,559,111 bytes,
SHA-256 `8aedb95980b54c7b83fed0648d72a51f63ae19fa790dd3fd8b3294a6c0056243`, commit `91bd25d7ee0f424559c9213ada431a5044b9b07c`, built on the runner above.
Commits after it change documentation only unless the status report says otherwise.

Tier 1 does **not** show: a toast on a screen or a click on it, SmartScreen, anything needing a ChatGPT or Claude login, layout, display
scaling, typing in the terminal, resize, Ctrl+C, a real Claude session on Windows, or behaviour as a standard (non-admin) user.

## Get the installer, and check it before you run it

Use the installer from the CI run you are told to test (the status report names the exact commit). Never run an installer whose origin
and hash you have not compared.

1. Download the artifact `mini-summa-windows-installer` from the run's page on GitHub (Actions, the run, Artifacts) while signed in to
   GitHub, and unzip it. It holds the `.exe`, `BUILD-INFO.txt` (commit, runner image, size, SHA-256) and `SHA256SUMS.txt`.
2. In PowerShell in that folder: `Get-FileHash -Algorithm SHA256 .\Mini-Summa-Setup-0.1.0-x64.exe`. The hash must equal the one in
   `SHA256SUMS.txt` **and** the one in the status report. The commit in `BUILD-INFO.txt` must be the commit named in the report.
3. If any of these differ, **do not run it** and say so.
4. Only after the origin (your own GitHub run of this repository) and the hash match, Windows SmartScreen may say "Windows protected your
   PC" because the file is unsigned and unknown. That is expected here: choose More info, then Run anyway. If the hash or origin did not
   match, that choice is not safe and you should stop.

The installer installs for your user only and asks for no administrator rights. Alternatively build it yourself: Node.js 22.12 or newer,
`git clone https://github.com/FarmaanFJM/mini-summa`, `git checkout feat/mini-summa-full-base`, `npm ci`, `npm run dist:win`.

## Tier 2: what only you can check (about 45 minutes, in this order)

You need: Windows 10 1809 or newer, or Windows 11, as a normal user; Claude Code installed and logged in (`claude --version` works in PowerShell); Git for Windows; a ChatGPT account with **at least two ChatGPT Projects and a few conversations in them**. Stop at the first step that fails, write its number and what you saw, and send `%APPDATA%\Mini-Summa\logs\main.log` and `%APPDATA%\Mini-Summa\data\logs\core.log` (no tokens in them). Do not paste tokens, pairing codes or report text.

**Why these and nothing else.** Everything a Windows machine without a person, a screen or a login could check has been checked (Tier 1). What follows needs a real ChatGPT account, a real Claude Code, a real screen, or your eyes. A test against a stand-in page or a fake Claude proves nothing about the real ones.

### A. Real Claude sessions and the terminal (15 minutes) - most important
1. **Folder and local session (R1).** New project, source GitHub repository, any `owner/repo`. Open its settings, **Browse**, pick a real folder. *Expect:* the folder is listed at once; the header shows it. Quit and start again: still there. **New local session** starts Claude in that folder.
   *Send:* pass/fail.
2. **The hook and the first report (H).** In PowerShell run the two lines of Part 1, step 11 (`$env:ELECTRON_RUN_AS_NODE='1'` ... `Measure-Command`). Then in the session ask for a very small change ("add a comment to README.md"), approve it in **Activity** or the terminal, wait for Claude to finish. *Expect:* the second number about 3; a report appears under this project with its destination conversation; Claude Code shows no hook error.
   *Send:* the two numbers; pass/fail.
3. **The terminal.** Type, paste a few lines, press Ctrl+C once at an idle prompt, then **resize the Mini-Summa window and drag the divider while Claude shows its prompt**. *Expect:* keys arrive as typed; paste works; the terminal redraws to the new width (Claude's box lines up). **Known unknown:** a Node test child under ConPTY did not see a resize; if the real Claude does not redraw, say so.
   *Send:* pass/fail, and whether the redraw happened.
4. **Stop and start again; `/clear`; `/resume`.** Stop the session from Mini-Summa and start it again with resume. Then in a session type `/clear`, send a prompt, type `/resume` and choose the first session. *Expect:* after each, the tab follows the session Claude now runs, the session shows as live (not ended), and typing still works. **Known unknown:** a fake Claude behind a `.cmd` shim did not refresh the resumed session's state; with a real Claude this may be fine or not.
   *Send:* pass/fail per action; a screenshot of the session list if a session shows as ended while it is running.

### B. Real ChatGPT Projects and continuity (15 minutes)
5. **Link a real ChatGPT Project (R3).** New project, source ChatGPT Project, paste the address of one of your own ChatGPT Projects. *Expect:* its page opens in the ChatGPT pane (sign in if asked). Open a conversation in it and press **Use this conversation for reports**.
   *Send:* pass/fail; **the pasted address with the long ids replaced by `xxx`** (the shape is undocumented by OpenAI and may have changed).
6. **Many conversations, one project (P1).** In that ChatGPT Project start a **new** conversation and write two lines. *Expect:* no new Mini-Summa project appears and nothing is mapped on its own.
7. **Several projects, restart (P2, P3).** Make a second Mini-Summa project from your second ChatGPT Project. Switch A, B, A. *Expect:* each shows its own last conversation. Quit and start Mini-Summa: each reopens its last conversation. An unsent draft is not promised across a restart.
   *Send:* pass/fail per step; if a project opened the project page instead of its last conversation, the project and what you had open.
8. **A project without a link (P4).** Keep one project with no ChatGPT link and a local Claude session; switch to it and back, use **Split / ChatGPT / Claude**. *Expect:* everything works; ChatGPT does not pick a conversation by itself.

### C. Notifications and the screen (15 minutes)
9. **Toast and click (R7).** Settings, Notifications, **Send a test notification**. *Expect:* a Windows toast; clicking it brings Mini-Summa to the front. Then with two projects, let a session in the **other** project finish while you look at this one. *Expect:* a toast "Claude finished" for that project within a few seconds; clicking it opens **that** project and session.
   *Send:* appeared or not; seconds from Claude's last output to the toast. If no toast: Windows Settings, System, Notifications, Mini-Summa on, Focus assist off.
10. **The overlap (R4).** At your usual window size and display scaling, show ChatGPT beside Claude, ask ChatGPT for a short draft, and look at the writing block and its Copy button; then Settings, ChatGPT, Page size: **100%** against **Automatic**. *Expect:* the floating controls do not sit on the text with Automatic. **Only a person can decide this**; the overlap was never reproduced by me.
   *Send:* window size, scaling, which setting overlaps, one screenshot.
11. **View modes (R5).** Write half a message in ChatGPT, switch to Claude and back to Split. *Expect:* the half message and the scroll position are still there; nothing reloads.

### Not on this list on purpose
Cloud tab (needs a Claude Code on the web plan; read the six steps in [CLOUD_SESSIONS.md](CLOUD_SESSIONS.md) if you use it), WSL2, the phone, SmartScreen after you have verified the installer, a standard-user install on a normal Windows edition. They are in Tier 3.

## Tier 3: optional and extended

Everything below is the earlier, longer checklist. Run what interests you; none of it is required for a first decision.

## Part 0: what changed in round 3 (R1 to R8; Tier 2 uses R1, R3, R4, R5, R7)

Round 3 added a GitHub-only project, linking an existing ChatGPT Project, the Cloud tab, view modes, the ChatGPT page size, a
"Claude finished" notification and a test notification. All of it was tested on Linux with local stand-ins for ChatGPT and
claude.ai and with the real Claude Code CLI; **none of it has been run on Windows**, and nothing was ever run against the real
chatgpt.com or claude.ai. Numbers are the same as in Part 1: write down the step and what you saw.

**R1. The folder defect that started this round.**
1. New project, **Start from: GitHub repository**, type `owner/repo` (any repository), **Create project**.
   *Expect:* the project opens; its header names the repository and says nothing about a missing folder.
2. Open its settings (the pencil in the header), under **Local folders** press **Browse** and choose a real folder.
   *Expect:* the folder is listed at once, under the Local folders heading, before you press anything else. Press **Done**: no
   "No changes to save", and the header shows the folder. A path to a folder that does not exist, typed in the field, is refused
   beside the field with a reason.
3. Quit Mini-Summa and start it again.
   *Expect:* the project, its repository and its folder are still there. **New local session** starts Claude in that folder.

**R2. A project without a folder is usable.** With a GitHub-only project selected, the Claude pane offers **New cloud session**
and shows why **New local session** is not possible and how to fix it (add a folder in the project's settings). No toast, no dead end.

**R3. Link an existing ChatGPT Project.** New project, **Start from: ChatGPT Project**, paste the address of one of your own
ChatGPT Projects (open the project in ChatGPT and copy the address bar). Mini-Summa shows the title it will use; **Create project**.
*Expect:* the ChatGPT pane opens that project's page (sign in if asked). Open one of its conversations and press **Use this
conversation for reports**; a report can then be handed to it. Nothing is imported: only the address is stored. **Write down the
shape of the address you pasted with the long ids replaced by `xxx`.** If it was refused or opened the wrong page, send that shape.

**R4. The overlapping controls.** Follow the 10-minute check in [CHATGPT_PANE.md](CHATGPT_PANE.md) (page size 100% against
Automatic, split against ChatGPT alone, your usual window size and display scaling). Report which of the three outcomes you got.

**R5. View modes.** In the workspace header choose **ChatGPT**, then **Claude**, then **Split** (Ctrl+Shift+Left and Right do the same).
*Expect:* nothing reloads. Write half a message in ChatGPT, switch to **Claude** and back: the half message and the scroll position
are still there. A running Claude terminal keeps its output while hidden. A dialog or menu opened over the workspace is never
covered by the ChatGPT or Claude page.

**R6. The Cloud tab (needs a claude.ai subscription that can use Claude Code on the web, and GitHub connected).** Follow the six
steps in [CLOUD_SESSIONS.md](CLOUD_SESSIONS.md), "Checking it on Windows". The points that matter most: whether you can sign in
inside the tab (note the method), whether **Open in your browser** is needed, and that Mini-Summa sends **no** notification when a
cloud session finishes.

**R7. Notifications.**
1. Settings, Notifications, **Send a test notification**.
   *Expect:* a Windows toast "Mini-Summa: This is a test notification". If you see nothing: Windows Settings, System,
   Notifications, Mini-Summa must be on, and Focus assist must be off. Click the toast: Mini-Summa comes to the front on Activity.
2. Make two projects with a local Claude session each, A and B. Select B. In A's terminal (from another window, or earlier) let
   Claude finish a task without a report, for example "Reply with the word ok".
   *Expect:* within a second or two a toast "A: Claude finished"; clicking it brings Mini-Summa forward on **A**, with that session's
   tab selected, although B was selected. **Write down roughly how many seconds passed between Claude's last output and the toast.**
3. Let a session ask for permission (only when Claude Code actually asks; in `auto` mode it never does).
   *Expect:* a toast "needs permission", a dot on that project in the sidebar and a dot on the Mini-Summa taskbar button with the number
   of sessions waiting. The dot goes when the state changes.
4. Watch a session in the focused window until it finishes.
   *Expect:* no "Claude finished" toast for what you are looking at (the feed keeps the entry, unread).
5. Quit Mini-Summa while a session works.
   *Expect:* no notification arrives while it is closed (by design); on the next start the feed shows the history, unread, without toasts.

**R8. Restart.** Quit and start again. The GitHub repository, the linked ChatGPT Project, the absence of a folder, the chosen view mode and the
Cloud tab's remembered page are all as you left them.

## Part 1: is it usable? (about 40 minutes)

### Install and start

1. Run the installer. SmartScreen shows "Windows protected your PC": **More info**, then **Run anyway**.
   *Expect:* no administrator (UAC) prompt; "Anyone who uses this computer" is greyed out; the program is installed under
   `%LOCALAPPDATA%\Programs\Mini-Summa`; there is a Start Menu entry; Mini-Summa starts and a tray icon appears (it may sit under the
   "^" overflow).
2. Open PowerShell: `netstat -ano | findstr 47811`.
   *Expect:* `127.0.0.1:47811 LISTENING` and no other address. Windows showed **no** Defender Firewall dialog at any point.
3. Close the window with the X (nothing is running yet).
   *Expect:* the window goes away at once and the whole program ends within a couple of seconds (the tray icon disappears). The X
   quits Mini-Summa; it does not keep running in the tray. Start it again from the Start Menu.
   *Expect:* `%APPDATA%\Mini-Summa\data` holds `mini-summa.db`, `logs` and `spool`; `%USERPROFILE%\.claude\settings.json` has not been touched.

### Claude, a project and ChatGPT

4. Look at the checklist on the first screen.
   *Expect:* it finds Claude Code and names the version and where it found it. If Claude Code is installed only in WSL2, it names the
   distribution instead of Windows. If it says nothing was found although `claude --version` works in PowerShell, press **Refresh**,
   and if that does not help, note where `where.exe claude` points.
5. Create a project: a name, **Choose folder** (the Windows folder picker) for a real git repository, ideally one whose path has a
   space or an accented letter (for example `C:\Users\<you>\Documents\My Projects\café`). Add the address of an existing ChatGPT
   conversation (copy it from your browser).
   *Expect:* the project appears in the sidebar and the address is shown in its normalised `https://chatgpt.com/c/...` form.
6. Select the project.
   *Expect:* ChatGPT loads next to the terminal area at the right conversation. Sign in inside the view if asked. If Google sign-in is
   refused in the embedded view, Mini-Summa says so and offers the external-browser mode (Settings, ChatGPT): that is expected.
7. Resize and move the window, select another project and back, then close the window and start Mini-Summa again.
   *Expect:* the window comes back where and as large as you left it, on the same project.

### The terminal

8. In the Claude pane press the plus next to the session tabs and choose **New session**.
   *Expect:* a Claude Code terminal in the project's folder (ask it to run `pwd`, or look at its header), with the line "Input goes
   to: <project> / Session ..." above it. The first time, Claude asks whether you trust the folder: answer it yourself in the
   terminal (the default is "No, exit", so choose Yes). Mini-Summa never answers for you. Within a second or two the session shows a
   process id.
9. Type, paste a multi-line text, press Ctrl+C, resize the window, drag the divider, switch the layout between side by side and
   stacked.
   *Expect:* it behaves like a normal terminal (Windows uses ConPTY): colours, cursor, scrollback; nothing restarts when the layout
   changes. Start a second session in the same project, select another project and come back.
   *Expect:* both sessions are still running.
10. Open the session menu in the Claude pane, choose **Stop session** and confirm, then look at Task Manager, Details.
    *Expect:* after a few seconds no `claude.exe`, `node.exe`, `git.exe`, `conhost.exe` or `OpenConsole.exe` of that session remains, and
    the session says "You stopped the session."

### Hooks and reports: the part that matters most

11. **Do PowerShell wait for the Mini-Summa executable?** Mini-Summa's hooks run its own `Mini-Summa.exe` as Node, through
    PowerShell. That executable is a GUI-subsystem program, and PowerShell may not wait for those. The hook command now ends in
    `| Write-Output` to make PowerShell wait, but nobody has watched Windows PowerShell do it. In PowerShell:
    ```powershell
    $env:ELECTRON_RUN_AS_NODE='1'
    $exe = "$env:LOCALAPPDATA\Programs\Mini-Summa\Mini-Summa.exe"
    (Measure-Command { & $exe -e "setTimeout(()=>{},3000)" }).TotalSeconds
    (Measure-Command { & $exe -e "setTimeout(()=>{},3000)" | Write-Output }).TotalSeconds
    ```
    *Expect:* the **second** number is about 3. The first one tells you whether the pipe was needed (about 3: it never was; a few
    hundredths: it was). **If the second number is also close to zero, stop here and send both numbers**: the hooks cannot be relied
    on yet, and reports from Windows sessions may not arrive. (To undo the test: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.)
12. In a session, ask Claude for a very small change ("add a comment to README.md"). When Claude asks for permission, open **Activity**,
    **Needs you**: under "Waiting for your approval" is a "Permission request" with the tool and a short excerpt. Press **Approve**.
    *Expect:* the dialog in the terminal closes once (no extra empty prompt) and Claude carries on. Ask for another change and press
    **Reject**: *Expect:* nothing is created and the item closes. (Answering in the terminal yourself is fine too.)
13. Wait for Claude to finish.
    *Expect:* the feed shows the session working and then a report under the right project, with its destination conversation. A file
    appeared in `%APPDATA%\Mini-Summa\data\spool\win` and moved to `done` within a second. Claude Code showed no hook error. (If it
    did: open `%APPDATA%\Mini-Summa\data\spool\capture-errors.log` if it exists, and send it.)
14. **The handoff, from the workspace.** A strip appears at the bottom of the workspace: "Report ready: <task>" with **Copy and open**.
    Press it.
    *Expect:* the whole message is on the clipboard (paste it into Notepad to check), the mapped ChatGPT conversation is in front, and
    the strip now reads "Waiting for you to send: <task> to <conversation>" with **I sent it**. Paste into ChatGPT yourself and press
    Send there; Mini-Summa never presses Send. Then press **I sent it** in the strip.
    *Expect:* the delivery moves to "You confirmed it was sent" (your statement), and the strip goes away. You never had to leave the
    workspace.
15. With a second project selected, make the first project's session finish another task.
    *Expect:* its report belongs to its own project and opens its own conversation, never the one you are looking at. A long report
    (ask for a long summary) is offered in numbered parts, one copy at a time.

### Notifications, restart, `/clear`

16. Minimise Mini-Summa and make a session ask for permission (or finish a task).
    *Expect:* a Windows toast named "Mini-Summa" naming the project; clicking it brings the right project and session to the front. In
    quiet mode (tray menu or Settings) there is no toast, but the feed still records the event. If no toast appears, check Windows
    Settings, System, Notifications: Focus assist or Do not disturb mutes them.
17. Leave one report unhandled and one session running, then close the window with the X.
    *Expect:* one question ("Quit and end terminals" / Cancel). Cancel keeps everything running. Choose to quit: the window
    disappears at once and the process is gone in a few seconds, with nothing left in Task Manager. Start Mini-Summa again.
    *Expect:* the project, conversations and the unhandled report are still there with their destination; the session is listed as
    resumable, not running; nothing was notified again. **Resume** brings the same Claude session back.
18. In a running managed terminal type `/clear` and press Enter (Claude starts a fresh conversation).
    *Expect:* Mini-Summa keeps the terminal and its tab; the tab and the "Input goes to" line now show the new session id, and the earlier
    conversation is listed under "Replaced inside their terminal" in the session menu, not as a dead terminal. A task you finish after
    the `/clear` produces a report under the same project. If the tab is replaced by a message that the session ended, note what the
    message said.
19. With two terminals running, end `Mini-Summa.exe` from Task Manager (End task on the whole tree).
    *Expect:* after a few seconds no `claude.exe`, `node.exe` or `OpenConsole.exe` of those terminals is left, and on the next start both sessions are resumable.
20. Uninstall (Settings, Apps, Mini-Summa, Uninstall).
    *Expect:* one message that says your data in `%APPDATA%\Mini-Summa` and any Claude hooks you installed are kept; afterwards `reg query HKCU\Software\Classes\minisumma` finds nothing.

## Part 2: sessions you start yourself (optional, 10 minutes)

Managed sessions report to Mini-Summa through settings passed on their command line, and your own Claude configuration is not
touched. To follow sessions you start in Windows Terminal or VS Code, Mini-Summa has to install hooks into your Claude settings.

21. Settings, Claude hooks, the Windows environment, **Install hooks**.
    *Expect:* an exact diff of `settings.json` first and nothing written until you confirm; a backup in `%APPDATA%\Mini-Summa\data\backups`; afterwards only
    entries named for Mini-Summa were added. Make a `settings.json` with PowerShell 5.1 (`'{}' > $env:USERPROFILE\.claude\settings.json` writes UTF-16): *expect* Mini-Summa
    refuses with a message about the encoding and leaves the file alone.
22. Start `claude` yourself in Windows Terminal, in a registered project's folder, and run a tool.
    *Expect:* the session appears as **observed**: its activity and reports show, typing into it from Mini-Summa is refused, and a
    permission request is announced but has no Approve button. No second Mini-Summa window or tray icon opens when a hook runs.
    **Remove hooks** removes only Mini-Summa's entries.

## Part 3: WSL2 and the phone (only if you use them)

23. **WSL2.** Add a project whose folder is inside a distribution (`\\wsl.localhost\<Distro>\home\...`, `\\wsl$\<Distro>\...` or a `/home/...` path) and start a
    session there. *Expect:* the session runs inside the distribution, the project's folder is the Linux path, the Windows and WSL
    environments are listed separately, and the distribution name works in any letter case. See [audit/windows-core.md](audit/windows-core.md)
    checks 11 to 14 for the rest (hooks inside WSL2, Claude installed in `~/.local/bin` or through nvm, a stopped distribution, a custom mount root).
24. **Phone.** [PHONE_VERIFICATION.md](PHONE_VERIFICATION.md) is the 15-step checklist; it needs the APK and Tailscale.

## Deeper checks

These are the complete lists of what only Windows can confirm. Parts of them repeat Part 1 with more detail; the rest cover
corners (mixed-DPI monitors, a disconnected monitor, junctions and mapped drives, network shares, Defender interfering with files,
the upgrade installer running while Mini-Summa runs, shutdown with terminals open).

* [audit/windows-core.md](audit/windows-core.md), "Must be verified on a real Windows PC / real WSL2": 16 checks for finding Claude
  (native installer, npm, winget), launching in folders with spaces, key handling, hooks and Defender, process cleanup, network
  shares, junctions, the database, WSL2 discovery and sessions, `settings.json` encodings.
* [audit/windows-desktop.md](audit/windows-desktop.md), "Must be verified on a real Windows PC": 23 checks for the installer,
  `minisumma://` links, the single-instance behaviour, uninstall, upgrade while running, hooks that wait (W-11), toasts, tray,
  monitors and DPI, the ChatGPT pane, the clipboard, command lines, file locks.

## Optional: the developer checks against your real Claude

From a checkout of the repository (`npm install` first). They were written to work on Windows but have **only been run on Linux**.
Each starts a headless core on a temporary data directory, in a temporary git repository, with your real `claude`:

* `npm run verify:claude`: launch, hooks, report, approve, reject, a phone prompt, a several-line follow-up, `/clear`, `/resume`, `--resume`, restart (about 5 minutes, a handful of short prompts).
* `npm run verify:protocol`: how reliably your Claude version ends a finished task with the report marker, with natural prompts.
* `npm run verify:claude-external`: a Claude you started yourself, followed through installed hooks; your own settings are restored.

Each prints PASS, FAIL or NOT TESTED per step. A step that could not run is never shown as PASS.

## Please send back

Which numbered steps passed, which did not, and for each failure what you saw, plus the newest files in
`%APPDATA%\Mini-Summa\logs` and `%APPDATA%\Mini-Summa\data\logs`. The most valuable single result is step 11. From Part 0: the
shape of your ChatGPT Project address (ids removed), your window size and display scaling with the outcome of the page size check, the
way you signed in inside the Cloud tab (or that you could not), whether the test notification appeared, and the seconds between
Claude finishing and its toast.
