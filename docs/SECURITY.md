# Security

Mini-Summa runs on your own PC, controls real terminals and can be reached from your own phone. This page says what it
protects, what it relies on, what is stored where, and what it deliberately does not defend against. Sentences that
describe a limit are as important as the ones that describe a protection.

## What is at stake

| Asset | Why it matters |
| --- | --- |
| Typing into a Claude session | A prompt or a permission answer is an action on your machine and your repositories. |
| Reports and terminal history | They can contain code, file paths and, by accident, secrets. |
| Device tokens, the push service account | They let a phone act as you, or send notifications as you. |
| `~/.claude/settings.json` | Hooks in it run commands every time Claude runs. |
| The ChatGPT conversation mapping | A wrong destination would send a report to the wrong conversation. |

## Trust boundaries

* **You at the desktop** are the owner. The desktop token has every scope.
* **Your phone** is trusted only as far as the scopes you grant: `read`, `notify`, `prompt`, `approve`. A prompt from a
  phone waits for approval at the desktop unless you marked that device *trusted*. A phone can never approve its own
  prompt.
* **Other programs running as your Windows user** are trusted like you are. They can read the data directory and write
  into the hook spool, as they could read your repositories. Mini-Summa treats what it reads from the spool as untrusted
  *for decisions* (see "Approvals" below) but does not try to defend the data directory against its own user.
* **Other users of the PC** are kept out: on Windows the data directory is in your profile; on POSIX systems the data
  directory is mode `0700` and the database and its sidecar files `0600`.
* **Web pages, including the ChatGPT page** are untrusted. The page never receives a Node API or a token.

## Network surface

* The core listens on `127.0.0.1` only. A request needs a bearer token (pairing and health excepted), a `Host` header of
  localhost or your Tailscale name (this stops DNS rebinding), and, for anything that changes state, no foreign `Origin`.
  There is no CORS. Bodies over 1 MB are refused with 413, malformed input with 400, and unknown routes with 404.
* **Remote access uses `tailscale serve` only.** Mini-Summa never runs `tailscale funnel`. Any request that carries the
  `Tailscale-Funnel-Request` header (what Tailscale adds to Funnel traffic) is refused with 403 before anything else is
  looked at, and while Funnel is detected no phone address is offered at all.
* **The Serve entry belongs to Mini-Summa only while it is its own.** It records the entry it created and removes it when it
  quits, but only if that entry still forwards to its own port. An entry made by someone else, or re-pointed since, is never
  changed or removed. If the preferred port is taken and the core starts on another one, the phone address is withheld
  until Serve forwards to the port the core really uses (Settings, Remote access shows what to do), so another program that
  grabbed the old port can never receive a phone's token.
* Content-Security-Policy on the served UI: `default-src 'self'`, `connect-src 'self'`, no frames, no object embeds.
  `style-src` keeps `'unsafe-inline'` because the terminal component writes style elements at run time.
* Pairing: one-time codes (192 bits, stored only as a SHA-256 hash, valid for 5 minutes, burned after 5 wrong tries). The
  endpoint is rate-limited by *failures* (20 per minute), so a stranger cannot lock you out of pairing by sending
  empty requests, and a stranger cannot guess a code either.
* Device tokens are random, shown once, stored only as SHA-256 hashes, and revocable. Revoking a device closes its
  WebSocket, makes its token fail at once, and rejects the prompts it still had waiting. Device names are cleaned
  (control, bidirectional and invisible characters removed) so a name cannot hide text or imitate another device.

## Approvals: the human stays in control

These are product rules the code enforces, and tests pin each of them.

1. **Nothing is submitted to ChatGPT automatically.** Mini-Summa prepares a message, copies it, opens or focuses the
   mapped conversation and waits. Whether you sent it is your statement.
2. **Nothing is typed into Claude without an explicit action.** Text reaches a session only through a pending action whose
   target is checked again at execution: a managed session (a terminal Mini-Summa owns), live, same generation, in a
   state that accepts input. External sessions are never typed into.
3. **An approval refers to the dialog that is on screen.** Each permission request is its own item with the id of the
   request behind it. A newer request replaces the older item, and an approval whose request is no longer the open one is
   refused (409 `permission_changed`) instead of answering a different dialog. This matters because anything that can drop
   a file into the hook spool could otherwise forge a request and make you approve something you were not shown.
4. **Review states are your statements.** A phone cannot move a delivery to "follow-up sent": ids a device supplies are
   ignored, and the state changes only when the text that was typed equals the draft stored on that delivery.
5. **Phone prompts that start with `!` or `/` are refused.** In Claude Code those run a local shell command or a slash
   command, not a prompt, so an approval card would show "a prompt" for something else. The desktop is not restricted.
6. **A revoked device cannot leave approvals behind.** Its waiting prompts are rejected, and approving one of them is
   refused.
7. **A phone's prompt is never glued onto a line you started.** If you typed in the terminal and have not pressed Enter,
   a prompt from another device is refused ("Someone typed in that terminal and has not pressed Enter yet") until you finish
   or clear that line. This is detected from the keystrokes Mini-Summa forwards, so it is a heuristic. A permission approval
   does not wait for it, because the open dialog takes that key.

## Secrets and data

* **Where things live:** the data directory (`%APPDATA%\Mini-Summa\data` on Windows) holds the database, the hook spool,
  logs, backups, generated per-session hook settings and the push service-account file. Nothing runtime is written into a
  project repository, and the publish guard (`npm run guard`) keeps keys, tokens, absolute personal paths and database
  files out of Git.
* **Redaction at capture.** Hook payloads, reports and terminal excerpts are scrubbed for credential-shaped strings before
  they are stored: provider API keys, access tokens, private key blocks, passwords in URLs and command lines, `Authorization`
  headers, and values of variables whose names look secret. Every report shows how many strings were replaced, including
  zero. **Redaction is pattern based. It reduces the chance of a leak and does not guarantee there is none.** Read a report
  before you paste it somewhere you do not trust.
* **Push notifications** carry the project name, a fixed sentence per event kind and ids. They never carry report text, task
  titles, tool input or paths. The project name is visible to Google (Firebase Cloud Messaging) and on a locked phone
  screen. If a project's name is itself sensitive, rename the project or switch off phone push for it in the project's
  notification settings; the phone still shows the event the next time you open the app.
* **The window's own state** (the selected project and view, per project the selected session and conversation, setup
  dismissals) is kept by the core in its database so that it survives a restart and a change of port. It holds ids only
  (project, session and conversation ids), never tokens or report text. Like the rest of the settings it can be read with the read scope
  (a paired phone has it) and can be changed only with the desktop token.
* **Your own Firebase project.** Mini-Summa has no cloud service. The service-account key is stored in the data directory
  with owner-only permissions and is never logged or returned by the API.
* **The phone app** keeps its token in the platform's secure storage (Android Keystore through `expo-secure-store`) and
  talks to your PC only. It refuses plain `http` to anything except loopback and the emulator's host address, so a real
  phone always connects over the HTTPS address that Tailscale Serve provides. The built APK asks Android for 8 permissions
  (camera for the pairing QR code, internet, vibration, notifications, and five that libraries need to receive push and check
  the network) and 24 more that libraries declare (storage, overlay, microphone, start at boot, launcher badges, biometrics,
  install referrer) are removed from the manifest; Android cloud backup and cleartext traffic are off. All of that was read
  back from the built file, not from the configuration ([ANDROID.md](ANDROID.md), "Privacy and permissions").

## Claude Code hooks

* Managed sessions get their hooks from a settings file passed with `--settings` for that one process. Your own Claude
  configuration is not touched for them.
* Installing hooks for sessions you start yourself is optional and permission-gated: Mini-Summa shows the exact change as
  a diff, and writes only after you confirm that exact plan (the plan carries a hash; a changed file or a changed link
  target makes the confirmation fail with 409). It backs the file up first (`backups/`, owner-only), keeps your other hooks
  untouched, and can remove only what it added.
* If `settings.json` is a symbolic link, the plan names both the link and its real target and warns first when the
  target is outside your Claude configuration folder or inside a Git working tree; a dangling link is refused.
* The hook command is a short script that always exits 0 and never blocks Claude. It writes one file per event into the
  spool atomically; the core reads it. On Windows it is run by PowerShell with the application's own executable acting as
  Node (`ELECTRON_RUN_AS_NODE` is set inside that one command, never in Claude's environment), and the call ends in
  `| Write-Output` so that PowerShell waits for a GUI-subsystem program; whether Windows PowerShell does is unverified
  ([audit/windows-desktop.md](audit/windows-desktop.md), W-11).
* **A managed terminal follows its process, not a hook.** When Claude replaces the conversation inside a terminal Mini-Summa
  started (`/clear`, `/resume`), the core moves its record to the new session id only when `claude agents --json` shows that
  the same operating-system process now runs the new session. A hook event alone is never enough, because a hook payload
  carries an id the sender chose; where the process ids cannot be compared the core leaves the record alone and says so.
* No file is added to your repositories (no per-repository `CLAUDE.md`). The report protocol is delivered as session
  context by the hook, only for sessions whose folder belongs to a registered project.

## The ChatGPT view

* The embedded view is an isolated browser with its own persistent partition: sandboxed, context isolation on, no Node, no
  preload exposed to the page, and the only permission it may use is writing sanitized text to the clipboard.
* Navigation is restricted to ChatGPT and OpenAI hosts plus the identity providers ChatGPT offers for sign-in. Anything
  else opens in your default browser. An address that could be read two ways (a backslash, control or space characters)
  is refused outright rather than guessed at.
* Mini-Summa does not spoof a user agent, script the page, read the page or press Send. If the site refuses an embedded
  browser (Google sign-in often does), the view says so and you switch to the external-browser mode.
* The optional browser extension uses the tabs and windows APIs only. It has no content scripts and no access to page
  contents.

## What this does not defend against

* **Malware or another process running as you.** It can read the database and the spool and can talk to the loopback API
  if it learns the desktop token. On Windows it can also read the ChatGPT sign-in cookies in
  `%APPDATA%\Mini-Summa\Partitions\chatgpt`: the build's cookie-encryption switch is off, so they are not encrypted at rest
  (audit item W-12; turning the switch on is a one-line change that was not made because it could not be tried on Windows).
* **A stolen, unlocked phone that you marked trusted.** Revoke it from Settings > Devices. Keep "trusted" off unless you
  need it.
* **A Claude session that lies.** The report marker is a declaration by the model, never proof that the work succeeded,
  and Mini-Summa says so wherever a report appears.
* **Windows-specific hardening that could not be run on Windows.** Session names have quotes and look-alike quotes removed
  before they reach a command line; `wsl.exe`, `cmd.exe` and `tailscale.exe` are started by absolute path (never a bare
  name that Windows could resolve in the current folder); PATH entries that are not absolute are ignored; a Claude launcher
  path with shell metacharacters is refused. These are covered by tests that simulate Windows, but they were never run on
  Windows. See [LIMITATIONS.md](LIMITATIONS.md).
* **Code signing.** The Windows installer is not code-signed, so SmartScreen will warn. The Android APK is signed with a
  throwaway key generated for the build and deleted afterwards (or with your own key, `MINISUMMA_KEYSTORE`); it is meant for
  sideloading on your own phone, and Play Protect warns about an unknown developer.

## The independent security review

Before release, a separate reviewer read the code and attacked a running core (headless, fake Claude CLI) with forged hook
files, malformed requests, every route under every kind of token, pairing abuse, path tricks and a hostile local process. It
found no critical or high issue; transport, authentication, scopes and pairing held under test. Fifteen weaker findings are
recorded here with what was done. Every fix has tests, and each fix was also checked by breaking it on purpose to see the test
fail.

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| SEC-01 | medium | A forged or repeated permission request let an approval answer a different dialog than the one shown | Fixed. Approvals carry the id of the request shown and are refused when another is open |
| SEC-02 | medium | Redaction missed common secret shapes | Fixed. 32 shapes now covered, false positives measured against 20,000 files; limits listed in LIMITATIONS |
| SEC-03 | low-medium | A phone prompt could be typed after text the desktop user had already typed | Fixed with a heuristic guard |
| SEC-04 | low-medium | A phone could flip another delivery's review state | Fixed. Ids from devices are ignored; the state moves only when the typed text equals the stored draft |
| SEC-05 | low | A revoked device's waiting prompts stayed approvable | Fixed. They are rejected on revocation |
| SEC-06 | low | Anyone could lock out pairing by flooding it | Fixed. Only failures are counted |
| SEC-07 | low | Data directory, database and backups were readable by other local users on POSIX | Fixed. Directories 0700, files 0600, including the spool |
| SEC-08 | low | The hook installer followed a symbolic link without saying so | Fixed. The plan names the real file and warns first |
| SEC-09 | low | The project name is in push titles | Accepted and documented. Mitigations in "Secrets and data" |
| SEC-10 | low | URL classifier and browsers disagreed about backslashes | Fixed. Ambiguous addresses are refused |
| SEC-11 | medium-low | A leftover Serve entry could hand phone traffic to another local process | Fixed. Serve ownership is recorded; the entry is removed on quit; no address is offered unless it points at the core |
| SEC-12 | low | Funnel was detected but not refused | Fixed. Such requests get 403 |
| SEC-13 | info | CSP, unrestricted device names | Fixed (`connect-src 'self'`, cleaned names). Read-scope devices can still mark reports and activity as read |
| SEC-14 | medium if trusted | A phone prompt starting with `!` or `/` would run as a command in Claude Code | Fixed. Refused from non-desktop actors |
| SEC-15 | low, Windows | Quoting and lookup order for session names, `wsl.exe`, `cmd.exe`, `tailscale` and hook paths | Fixed in code with string-level tests. **Not run on Windows** |

## Reporting a problem

This is a personal project. Open an issue in the repository, and do not paste tokens, reports or hook payloads into it.
