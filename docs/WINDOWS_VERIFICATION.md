# Verifying Mini-Summa on Windows

Mini-Summa was built and tested on Linux. Nothing here has been run on Windows or WSL2, so these are the checks only your
PC can do. It takes about 40 minutes. For each item, "Expect" says what a correct result looks like. If something differs,
note the step and keep the log folder (`%APPDATA%\Mini-Summa\data\logs`). Do not paste tokens or reports into an issue.

You need Windows 10 (21H2) or Windows 11, Claude Code installed and logged in (`claude --version` works in PowerShell), Git
for Windows (Claude Code needs it), and a ChatGPT account. Optional: WSL2 with Claude Code installed inside it, Tailscale
on the PC and the phone, a Firebase project for push.

## 1. Install and start

1. Run the installer (`Mini-Summa-Setup-<version>.exe`, built by `npm run dist:win`). Windows SmartScreen will warn because
   the installer is not code-signed: choose **More info**, then **Run anyway**.
   *Expect:* no administrator prompt, a Start Menu entry, the app opens, a tray icon appears.
2. Close the window with the X, then open the tray icon.
   *Expect:* the app keeps running in the tray; **Quit** from the tray ends it.
3. Start it again. Open `%APPDATA%\Mini-Summa\data`.
   *Expect:* `mini-summa.db`, `logs`, `spool` exist. `%USERPROFILE%\.claude\settings.json` is unchanged (no hooks yet).

## 2. First run and a project

4. *Expect:* the checklist on the first screen finds Claude Code (it names the version and environment). If you installed
   Claude Code only in WSL2, it should name the WSL distribution instead of Windows.
5. Create a project: a name, **Choose folder** (the Windows folder picker), and a real repository. Add the address of an
   existing ChatGPT conversation (copy it from your browser).
   *Expect:* the project appears in the sidebar; the address is accepted and shown in its normalized `https://chatgpt.com/c/...`
   form.
6. Select the project.
   *Expect:* ChatGPT loads on the left (landscape) or on top (portrait) at the right conversation. If the site asks you to
   sign in, do it in the view. If Google sign-in is refused inside the embedded view, Mini-Summa should say so and offer the
   external-browser mode (Settings, ChatGPT). That is expected behaviour, not a defect.

## 3. Claude Code in a real terminal

7. **New session**.
   *Expect:* a terminal on the right with the label "Input goes to: <project> / Session ...". Claude Code starts in your
   repository folder. The first time, Claude asks whether you trust the folder: answer in the terminal (the default is
   "No, exit", so choose Yes). Mini-Summa never answers for you.
8. Type, paste, press Ctrl+C, resize the window, drag the divider, switch orientation (Settings, or resize to portrait).
   *Expect:* text, colours and the cursor behave like a normal terminal (Windows uses ConPTY), the terminal keeps its
   scrollback, and the terminal does not restart when the layout changes.
9. Start a second session in the same project, then select another project and come back.
   *Expect:* both sessions are still running; nothing was restarted. The label always names the project and session that
   receive your keystrokes.

## 4. A report, from Claude to ChatGPT

10. In a session, ask Claude for a very small change, such as "add a comment to README.md". Approve the permission dialog in
    the terminal.
    *Expect:* the project's feed shows the session working, then a report. A Windows notification appears if the window is
    not in front (item 12). The report is under the right project and shows its destination conversation.
11. Open the report and press **Copy and open** (the handoff).
    *Expect:* the clipboard holds the whole report message (paste it into Notepad to check), the mapped ChatGPT conversation
    comes to the front, and the state becomes "waiting for you to send". Paste into ChatGPT yourself and press Send. Then
    press **I sent it**. Mini-Summa never presses Send.
12. With another project selected, make a second project's session finish a task.
    *Expect:* its report belongs to its own project and opens its own conversation, never the one you are looking at.

## 5. Notifications

13. Minimise Mini-Summa. Trigger a permission request in a session.
    *Expect:* a Windows toast naming the project. Clicking it brings the right project and session to the front. Toggle
    quiet mode (Settings, Notifications): no toast, but the feed still records the event as unread.
14. If toasts do not appear, check Windows Settings, System, Notifications ("Focus assist" or "Do not disturb" mutes them).

## 6. Restart and recovery

15. Leave one report unhandled and one session running. **Quit** from the tray, then start the app.
    *Expect:* the project, conversations and report are still there with their destination; the session is shown as
    resumable, not running; nothing was re-notified. **Resume** brings the same Claude session back.

## 7. Hooks

16. Settings, Claude hooks, **Install hooks** for the Windows environment.
    *Expect:* an exact diff of `settings.json` first, and nothing written until you confirm. After confirming, only Mini-Summa's
    entries were added. **Remove hooks** removes only those.

## 8. WSL2 (only if you use it)

17. Add a project whose folder is inside WSL (`\\wsl$\<distro>\home\...` or a `/home/...` path), start a session.
    *Expect:* the session runs inside the distribution, the project's folder is the Linux path, and the Windows and WSL
    environments are listed separately. A Windows session and a WSL session with the same id would not merge.

## 9. Phone (optional)

18. Follow [ANDROID.md](ANDROID.md): enable Tailscale Serve in Settings, Remote access, pair the phone with the QR code, then
    send a prompt from the phone to a Mini-Summa session and approve it on the PC. Revoke the phone afterwards.

## 10. Developer check against your real Claude (optional)

19. From a checkout of the repository: `npm install`, then `npm run verify:claude`. It starts a headless core with a temporary
    data directory, launches your real `claude`, and reports PASS, FAIL or NOT TESTED for each step. It sends two short
    prompts. (Written for Windows but only run on Linux so far.)

Please send back: which numbered steps passed, which did not, and for failures the newest files in
`%APPDATA%\Mini-Summa\data\logs`.
