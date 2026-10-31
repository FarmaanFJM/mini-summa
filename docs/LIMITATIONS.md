# Remaining limitations

This is the honest list of what is missing, unverified or imperfect, in the order it matters. The four groups are kept apart on
purpose: an *external* limitation is not Mini-Summa's to fix, an *environmental* one is a gap in what could be tested while
building it, a *defect* is something Mini-Summa gets wrong today, and *deferred polish* is nice to have.

## 1. Blockers for calling it verified on your PC (environmental)

These are not known to be broken. They have never been run, because the build environment was a Linux container with no
Windows, no WSL2, no phone and no ChatGPT login. Until you have done them, treat the matching feature as **unverified**.
[WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) is the 40-minute checklist for the PC and [PHONE_VERIFICATION.md](PHONE_VERIFICATION.md)
the 30-minute checklist for the phone.

| Not tested | What is covered instead | Risk |
| --- | --- | --- |
| **Everything on Windows**: install, start, the folder picker, ConPTY terminals, tray, protocol links, the installer's uninstall | The NSIS installer was built under Wine and its pieces were read out of the files (PE headers, manifest, fuses); Linux builds of the same Electron app pass the smoke and acceptance suites; 19 problems in the local service and the hook library and 12 in the desktop shell and installer, found by reading the code, were fixed with tests that **simulate** the Windows condition (paths, quoting, locked files, `taskkill`, UTF-16 output). [audit/windows-core.md](audit/windows-core.md) and [audit/windows-desktop.md](audit/windows-desktop.md) list them and the 39 checks that only a PC can answer | The most likely place for a first-run surprise. ConPTY terminals, the PowerShell hook (next row) and the unsigned installer's SmartScreen warning are the three to watch. |
| **The Windows hook waits for the program it starts** (audit item W-11) | `Mini-Summa.exe` is a GUI-subsystem program and PowerShell may not wait for those; the hook command now pipes the call into `Write-Output`, which is the usual way to make it wait. Only the text of the command is tested | If it does not wait, reports from Windows sessions may not arrive or may arrive late. One 10-second measurement in PowerShell settles it (step 11 of [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md)). |
| **WSL2**: launching Claude inside a distribution, `wsl.exe` interop, UNC and `/mnt` paths | Environment ids, path normalisation (both `\\wsl$\` and `\\wsl.localhost\`, any letter case of the distribution name) and command construction have unit tests with recorded and simulated `wsl.exe` output (UTF-16, helper distributions) | A real distribution may format listings differently, and Claude installed through nvm or `~/.local/bin` is started through a login shell that was never run. |
| **Windows toast notifications** and click-to-navigate | The notification decision, dedupe, quiet mode and the navigation target are tested; the Electron call is observed with a stand-in | Toasts also depend on Windows Focus assist settings. |
| **The real ChatGPT site** inside the embedded view: sign-in, loading a conversation, the clipboard permission | A local HTTPS stand-in for `chatgpt.com` exercises the real navigation policy and the real view | ChatGPT may change its pages or refuse embedded browsers (Google sign-in often does). The external-browser mode is the fallback. |
| **The ChatGPT overlap fix (page size)** | The report (floating controls over the writing blocks) was **not reproduced**: chatgpt.com cannot be reached from the build environment. What is built and tested is the mechanism: the view's own browser zoom follows its pane, in the real Electron app against a stand-in page that reports its own width, with clicks, selection, scrolling and the page's Copy button still working while zoomed ([CHATGPT_PANE.md](CHATGPT_PANE.md)) | The cause (a narrow pane makes ChatGPT use its compact layout) is a hypothesis, and the numbers (a target of 900 CSS pixels, never below 70 percent) are judgements. In a split pane on a 1280 wide window Automatic gives ChatGPT about 717 CSS pixels, which may not be enough; ChatGPT focus mode gives the page the whole window. The check on your PC takes 10 minutes (steps in [CHATGPT_PANE.md](CHATGPT_PANE.md)) |
| **Claude Code on the web inside the Cloud tab** | A local stand-in for claude.ai exercises the real view, navigation policy, profile, permissions and the pre-filled address. No Claude cloud session was ever started: no claude.ai subscription login was available ([CLOUD_SESSIONS.md](CLOUD_SESSIONS.md)) | claude.ai may refuse an embedded Electron view, Google sign-in is often refused in embedded windows (sign in with an email address or use "Open in your browser"), the GitHub connection may need a pop-up that cannot work in one view, and Cloudflare may challenge it. Whether Anthropic's terms allow showing claude.ai in another application is **not answered** by their documentation |
| **Linking an existing ChatGPT Project** | The pasted address is parsed and stored, opened in the embedded view, survives a restart (stand-in) | The address shapes are observed, not documented, and may change; an unrecognised form is kept as pasted. OpenAI's terms were not readable by the research tool and are unread ([CHATGPT_PROJECTS.md](CHATGPT_PROJECTS.md)) |
| **The Windows taskbar badge** | The count it shows is driven by the core and unit tested | Never seen on a real taskbar |
| **An Android device or emulator** | 216 Jest tests, a script that pairs and connects the phone's own code to the real headless core, a bundling check, and the **built APK** (46.2 MB, arm64, release; SHA-256 in [ANDROID.md](ANDROID.md)) read back with `apksigner` and `aapt2`: signature, 8 permissions, not debuggable, no backup, no cleartext. It was built after the Maven Central rate limit was got past with longer retries and a local, checksum-verified copy of 11 files; no verification was bypassed ([ANDROID.md](ANDROID.md), "Build outcome") | The app has never been installed or started: no screen has been seen, and the camera, notifications and Tailscale are untried. The APK is signed with a throwaway key made for this build, so a later build cannot update it (uninstall first, or sign your own with `MINISUMMA_KEYSTORE`); Play Protect warns about an unknown developer. |
| **Real push delivery** (Firebase Cloud Messaging) | Payload building, token registration, minimal payloads and failure handling against a local stand-in | Needs your own Firebase project and a device. |
| **Real Tailscale** | The status parser and Serve management against recorded and simulated output | `tailscale serve` flags can differ by version. |

## 2. External limitations (not Mini-Summa's to fix)

* **ChatGPT has no supported way to read or write an existing conversation.** Mini-Summa therefore cannot see that you pressed
  Send, nor ChatGPT's answer. Every review state after "sent" is something you tell it, and it says so. Optional paste
  assistance never presses Send. This is a design position, not a gap.
* **Claude Code is a moving target.** Hook payloads, the permission dialog's keys (Enter approves, Escape rejects) and the
  folder-trust screen were observed on version 2.1.314. `npm run verify:claude` repeats those checks against your installed
  version in about three minutes; run it after upgrading Claude Code.
* **Claude Code fires no hook for some things.** Escape on a permission dialog produces no event, so after you reject a
  request the session can keep showing "needs permission" until Claude's next event or the next discovery poll (the
  interval is a setting; the terminal shows the truth, and the feed entry is closed at once). A `Stop` event means the
  turn ended, not that the task is done; only a report marker (a declaration by the model) says "finished".
* **A person's ChatGPT Projects cannot be listed.** OpenAI documents no way for a third party to do it (sign-in scopes exclude
  conversations; "projects" in the OpenAI API are another thing). A workspace is linked by pasting the project's address;
  nothing is imported or synced ([CHATGPT_PROJECTS.md](CHATGPT_PROJECTS.md)).
* **Claude cloud sessions cannot be listed, watched or notified about by Mini-Summa.** Anthropic documents no API, event or
  completion signal an application can use, and hooks on your PC are not read by cloud sessions. The Cloud tab is a web page,
  not session control: to know a cloud task is done, look at the page or use Anthropic's own apps. Mini-Summa sends no
  notification for a cloud session ([CLOUD_SESSIONS.md](CLOUD_SESSIONS.md), [NOTIFICATIONS.md](NOTIFICATIONS.md)).
* **Claude Code may run in a mode that never asks permission.** Claude Code 2.1.314 starts in `auto` mode on the build machine
  (its hooks say `permission_mode: auto`) and writes files without a prompt, so no "needs permission" notification exists in that
  mode; "Claude finished" and the report notification still do. The permission checks of `npm run verify:claude-external` report
  "not tested" there.
* **Push notifications need your own Firebase project**, and the PC must be awake and on your tailnet to send them.
* **Remote access needs Tailscale** with HTTPS enabled for your tailnet. Mini-Summa never uses Funnel.
* **External sessions** (started outside Mini-Summa) can be observed but not typed into. Anthropic's Remote Control is the
  supported way to steer them from the phone; Mini-Summa only shows how.

## 3. Known defects and imperfections

These are things Mini-Summa gets wrong or does clumsily today. None blocks the core workflow.

* **One ChatGPT view and one Claude view are shared by all projects.** Selecting another project loads that project's page into
  the same view, so a half-written message that ChatGPT does not keep itself is lost on the switch, and the Cloud tab shows the
  remembered page of the project you switched to (the cloud session itself keeps running). Terminals are not affected: no
  terminal restarts. A view per project (a small cache) was left out to keep the memory footprint of a lightweight app.
* **"Claude finished" has limits.** It proves a turn ended, not that the task succeeded. It is not sent while background work is
  pending (a dev server or a recurring task keeps a session in that state, so it never says finished), not for sessions that
  belong to no project, and not while you are looking at that very session in a focused window.
* **The page size setting costs text size.** Automatic zooms ChatGPT out in a narrow pane, to 70 percent at the lowest. Choose
  100% in Settings, ChatGPT if you prefer the text large and do not see the overlap.
* **Moving work between cloud and local is a command, not a button.** A cloud session page offers the documented
  `claude --teleport <id>` command to copy; running it in a checkout of the same repository is up to you.
* **Quitting adds one unread "Session ended" feed entry per running terminal.**
* **`/clear` and `/resume` inside a managed terminal are followed, within limits.** The core moves the terminal's record to the
  new session id when `claude agents --json` shows the same process running it (verified with the real CLI for `/clear` and
  `/resume`, and in the real Electron app for `/clear` with a stand-in CLI), and the window moves the tab, the remembered choice
  and the keyboard along; the old session stays in the Sessions menu as ended history ("Replaced inside their terminal"). Not
  exercised: `/clear` while Claude is working or a dialog is open (then Mini-Summa may announce "A Claude session ended" for the
  old session although the terminal went on), and `/resume` in the Electron app. While Claude has not told Mini-Summa which
  session the terminal runs now, the pane says so and Mini-Summa does not type into that terminal (you still can). A phone prompt
  that was waiting for the old session cannot be approved afterwards ("not running") and stays until it expires or you reject it.
* **The window's remembered state is saved about 0.6 seconds after the last change.** A normal close sends it at once (a request
  that outlives the page); a process that is killed can lose the last 0.6 seconds of changes.
* **The strip at the bottom of the workspace shows the waiting report of the selected project only**, the one you are in the
  middle of first, then the newest, with "+N more" linking to the Reports queue. Discard, changing the destination and the
  alternatives for long messages stay in Reports.
* **ChatGPT's sign-in cookies are not encrypted on disk on Windows** (the build's cookie-encryption switch is off; audit item
  W-12). Another program running as you could read them from `%APPDATA%\Mini-Summa\Partitions\chatgpt`. Turning the switch on is
  a one-line change that was left alone because it cannot be tried here (it would probably sign you out of ChatGPT once).
* **Installing an update while Mini-Summa runs ends it abruptly.** The installer's own "is it running" check ends the program
  without letting it quit ([audit/windows-desktop.md](audit/windows-desktop.md), "Upgrade while the app runs"), so its terminals are lost (they stay listed as resumable) and the last
  seconds of ChatGPT cookie changes may be lost. Quit Mini-Summa before updating.
* **The smallest window (960 by 600 points) is larger than the usable area of a 1366 by 768 laptop at 150% scaling.** The window
  then extends past the screen edge.
* **A Windows toast counts as shown when Windows accepted it**, even if Focus assist sent it straight to the Action Center.
* **After a restart the previous terminal output is not shown** ("No terminal output is available for this session") until
  the session is resumed; the transcript lives in Claude Code, not in Mini-Summa.
* **A report keeps the project name it was captured under after the project is renamed.** It stays linked by project id, so it still belongs to the right project.
* **An API client with the desktop token can re-point a delivery to another project's conversation.** The window never offers
  this and the change is recorded as an explicit, audited step ("destination changed", marked as another project's). It is
  the owner's decision, not an accident, and nothing routes this way by itself.
* **Under Xvfb the acceptance suite parks the window out of the pointer's reach during drag tests**, a test-environment
  artefact and not a product defect.

* **Redaction is pattern based.** It catches the usual shapes of keys, tokens, private keys, passwords in URLs and command
  lines, but it cannot know a secret that looks like ordinary text. It does not cover lower-case or dotted names
  (`password=x`, `db.password=x`), YAML or JSON text such as `password: x`, `-p secret`, `Cookie:` and `X-API-Key:` headers,
  ADO.NET `Password=...;`, secrets mentioned in a sentence, or anything encoded or split. Placeholders with the shape of a
  credential (`user:pass@host`) are hidden too, because they cannot be told apart. Each report shows the number of
  replacements, including zero.
* **"Someone typed and has not pressed Enter" is a heuristic.** It follows the keystrokes Mini-Summa forwards to the terminal.
  A digit typed at a start-up dialog without Enter keeps the flag until Enter, Escape, Ctrl-C or Ctrl-U; a phone prompt left
  unsubmitted does not set it; terminals that use the kitty keyboard protocol are not understood. A remote permission approval
  does not wait for it, so in the rare case the dialog closed a moment earlier, that Enter could submit a line you were typing.
* **Programs running as your Windows user are trusted.** The hook spool is a folder they can write into. Mini-Summa treats
  spool contents as untrusted when deciding what you are asked to approve, but it does not defend the data directory
  against its own user.
* **The project name appears in push notification titles** (and so on a locked phone screen and in Google's delivery path).
  Use a neutral project name, or switch off phone push for that project.
* **Installer and APK are not code-signed by a publisher.** SmartScreen and Play Protect warn.

## 4. Deferred polish

* A ChatGPT view and a Claude view per project (a small cache), so switching projects keeps each page and its draft.
* Running in the tray when the window is closed, and starting with Windows, so notifications keep coming without the window.
* Real cloud-session control (list, resume, completion events) if Anthropic ever documents an interface for it, and listing of
  ChatGPT Projects if OpenAI does; both would replace pasting and page-showing.
* A shared base for the two view controllers (ChatGPT and Claude), which now duplicate about 60 lines.
* A light theme; the interface is dark only.
* When the sidebar is collapsed to its narrow rail, Reports and Settings show their own navigation column inside the view
  (recorded as exception X8 in [UI_PRINCIPLE_EXCEPTIONS.md](UI_PRINCIPLE_EXCEPTIONS.md)). A cleaner fix lets a view that
  replaces the sidebar borrow its full width while it is open.
* An automated accessibility audit (axe) of the interface; contrast ratios were computed from the tokens, not measured on screen.
* Keyboard shortcuts beyond maximising a pane.
* Auto-update for the desktop app.
* An iOS companion.
* Search across reports and a bulk export.
* Per-project quiet hours.
