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
| **An Android device or emulator** | 216 Jest tests, a script that pairs and connects the phone's own code to the real headless core, a bundling check, and the built APK read back with `apksigner` and `aapt2` (signature, 8 permissions, not debuggable, no backup, no cleartext) | The app has never been installed or started: no screen has been seen, the camera, notifications and Tailscale are untried. |
| **Real push delivery** (Firebase Cloud Messaging) | Payload building, token registration, minimal payloads and failure handling against a local stand-in | Needs your own Firebase project and a device. |
| **Real Tailscale** | The status parser and Serve management against recorded and simulated output | `tailscale serve` flags can differ by version. |
| **The Android APK as a tested product** | The APK **was built** (46.2 MB, arm64, release, SHA-256 in [ANDROID.md](ANDROID.md)) after the Maven Central rate limit was got past with longer retries and a local, checksum-verified copy of 11 files; no verification was bypassed ([ANDROID.md](ANDROID.md), "Build outcome") | It is signed with a throwaway key made for this build, so it can be installed once but a later build cannot update it (uninstall first, or sign your own with `MINISUMMA_KEYSTORE`). Play Protect warns about an unknown developer. |

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
* **Push notifications need your own Firebase project**, and the PC must be awake and on your tailnet to send them.
* **Remote access needs Tailscale** with HTTPS enabled for your tailnet. Mini-Summa never uses Funnel.
* **External sessions** (started outside Mini-Summa) can be observed but not typed into. Anthropic's Remote Control is the
  supported way to steer them from the phone; Mini-Summa only shows how.

## 3. Known defects and imperfections

These are things Mini-Summa gets wrong or does clumsily today. None blocks the core workflow.

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
