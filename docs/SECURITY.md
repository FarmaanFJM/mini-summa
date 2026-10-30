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
* **Your own Firebase project.** Mini-Summa has no cloud service. The service-account key is stored in the data directory
  with owner-only permissions and is never logged or returned by the API.
* **The phone app** keeps its token in the platform's secure storage (Android Keystore through `expo-secure-store`) and
  talks to your PC only. It refuses plain `http` to anything except loopback and the emulator's host address, so a real
  phone always connects over the HTTPS address that Tailscale Serve provides.

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
  spool atomically; the core reads it.
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
  if it learns the desktop token.
* **A stolen, unlocked phone that you marked trusted.** Revoke it from Settings > Devices. Keep "trusted" off unless you
  need it.
* **A Claude session that lies.** The report marker is a declaration by the model, never proof that the work succeeded,
  and Mini-Summa says so wherever a report appears.
* **Windows-specific hardening that could not be tested here.** Quoting of unusual session names, executable lookup order
  and WSL2 launching were reviewed and covered by tests with simulated Windows paths, but they were not run on Windows. See
  [LIMITATIONS.md](LIMITATIONS.md).
* **Code signing.** The Windows installer is not code-signed, so SmartScreen will warn. An Android APK, when you build one,
  is signed with a key on your own machine and is meant for sideloading on your own phone.

## Reporting a problem

This is a personal project. Open an issue in the repository, and do not paste tokens, reports or hook payloads into it.
