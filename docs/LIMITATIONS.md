# Remaining limitations

This is the honest list of what is missing, unverified or imperfect, in the order it matters. The four groups are kept apart on
purpose: an *external* limitation is not Mini-Summa's to fix, an *environmental* one is a gap in what could be tested while
building it, a *defect* is something Mini-Summa gets wrong today, and *deferred polish* is nice to have.

## 1. Blockers for calling it verified on your PC (environmental)

These are not known to be broken. They have never been run, because the build environment was a Linux container with no
Windows, no WSL2, no phone and no ChatGPT login. Until you have done them, treat the matching feature as **unverified**.
[WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) is the 40-minute checklist.

| Not tested | What is covered instead | Risk |
| --- | --- | --- |
| **Everything on Windows**: install, start, the folder picker, ConPTY terminals, tray, protocol links, the installer's uninstall | The NSIS installer was built under Wine; Linux builds of the same Electron app pass the smoke and acceptance suites; path and quoting rules are tested with Windows-style strings | The most likely place for a first-run surprise. Terminal behaviour with ConPTY and the unsigned installer's SmartScreen warning are the two to watch. |
| **WSL2**: launching Claude inside a distribution, `wsl.exe` interop, UNC and `/mnt` paths | Environment ids, path normalisation and command construction have unit tests with recorded `wsl.exe` output | A real distribution may format listings differently. |
| **Windows toast notifications** and click-to-navigate | The notification decision, dedupe, quiet mode and the navigation target are tested; the Electron call is observed with a stand-in | Toasts also depend on Windows Focus assist settings. |
| **The real ChatGPT site** inside the embedded view: sign-in, loading a conversation, the clipboard permission | A local HTTPS stand-in for `chatgpt.com` exercises the real navigation policy and the real view | ChatGPT may change its pages or refuse embedded browsers (Google sign-in often does). The external-browser mode is the fallback. |
| **An Android device or emulator** | 216 Jest tests, a script that pairs and connects the phone's own code to the real headless core, and a bundling check | Screens have never been seen on a screen. |
| **Real push delivery** (Firebase Cloud Messaging) | Payload building, token registration, minimal payloads and failure handling against a local stand-in | Needs your own Firebase project and a device. |
| **Real Tailscale** | The status parser and Serve management against recorded and simulated output | `tailscale serve` flags can differ by version. |
| **An Android APK** | The build passes its prerequisite check and `expo prebuild`, and Gradle got through 94 tasks and 2.3 GB of downloads before Maven Central's HTTP 429 stopped it on the same Fresco libraries three runs in a row (see [ANDROID.md](ANDROID.md), "Build outcome") | No APK exists. Nothing in the app is known to be wrong; run `npm run build:apk` on a normal network. |

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

* **After "Copy and open" the report card is out of sight.** The handoff takes you to the workspace so that ChatGPT is in front.
  After you paste and press Send there, you go back to Reports to press **I sent it**; nothing in the workspace offers that
  button. A short "waiting for you to send" strip in the ChatGPT pane would remove a click. The state itself is recorded
  correctly and shown in the queue, the feed and the counters.
* **If the preferred port 47811 is busy at start, the window forgets its own saved state.** The core then takes another port and
  the window's saved choices (selected project, setup dismissal) belong to the old address. Your projects, sessions and reports
  are unaffected. The acceptance check for this reports NOT TESTED rather than PASS in that case.
* **After a graceful "Stop session" the notice says "The terminal process exited with code 0."** instead of "You stopped the
  session." A forced stop and a quit are worded correctly.
* **Quitting adds one unread "Session ended" feed entry per running terminal.**
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
