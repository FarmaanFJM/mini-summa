# Claude Code cloud sessions and Mini-Summa

Read this before relying on anything about the cloud in Mini-Summa. It separates what Anthropic documents from what is assumed or unknown, and says plainly what Mini-Summa does with each.

**Method and date.** Researched on 2026-10-30 (the rest of this page, and the table below); the CLI probes in the section above were run on 2026-11-01. Original research: from Anthropic's published pages (code.claude.com, platform.claude.com, support.claude.com, anthropic.com legal) and from `claude --help` of the installed Claude Code 2.1.314. Page text was read through a fetch tool that summarises pages, so quote exact wording from the live page before repeating it elsewhere. No private endpoint, no reverse engineering, no credential or cookie reading was used. **No cloud session was started and no claude.ai subscription login was available in the test environment, so nothing below about the cloud has been exercised against the real service.** The automated tests use a local stand-in for claude.ai, which proves what Mini-Summa does with a page (which address it opens, that it never types or submits), not how claude.ai behaves.

## What Mini-Summa does (since the cloud dispatch work)

Per project, in the Claude pane, **plus button, Cloud session**:

1. **Checks** (all read-only): the installed `claude` (`--version`, and `--help` for the `--cloud` option), its login (`claude auth status`; Mini-Summa reads only whether it says logged in and how), that the project has a GitHub repository, and which local folder the CLI will run in: it must be a Git repository whose `origin` is the project's repository. It shows the branch, warns about local commits GitHub does not have, and about uncommitted changes. Anything that blocks says what and why; nothing is launched against an unknown repository.
2. **Disclosure and consent.** The cloud session runs on Anthropic's servers from the repository **on GitHub**, not from your working tree. Claude Code may upload parts of a local repository when GitHub access is not set up (documented behaviour is not specific; Mini-Summa cannot see whether it happens). The send button stays disabled until you accept this.
3. **Dispatch.** The CLI is started with `claude --cloud "<your prompt>"` in a terminal Mini-Summa owns (a PTY), because **creating a session needs a terminal** (verified below). Phases shown: Preparing, Waiting for you (the CLI asked a question, answered with Enter/Up/Down/Esc/y/n), Submitting, **Session created** (a validated claude.ai/code session link was printed), Failed, **Result unknown**.
4. **Record.** A validated link is stored in `cloud_sessions` (project, repository, the branch git reported in the folder before dispatch, session id, URL, time, method, last result, title). It survives restarts. A saved record is never shown as "running".
5. **Afterwards.** Open in your browser, Copy link, Show in Cloud tab, follow-up messages (below), and the Cloud tab keeps listing the sessions started here.

### Verified on Claude Code 2.1.316 (2026-11-01, this machine, read-only probes)

| Fact | How it was checked |
| --- | --- |
| `claude --help` lists `--cloud [description\|session_id\|url]` and `--environment <ccpool_...>` | `claude --help` |
| **`claude -p "<task>" --cloud` is refused: "--cloud cannot be combined with --print. Starting a new cloud session with --cloud is interactive only"** | ran it in an empty directory |
| **`claude --cloud "<task>"` without a terminal is refused**: "--cloud can only send the prompt to an existing cloud session ... To start a new cloud session, run from a TTY" | ran it with no TTY |
| In a terminal, the first thing a fresh CLI asks is the theme, the security note and **"Is this a project you created or one you trust?" (default "No, exit")** before anything else | drove it through a PTY, stopped there |
| `claude auth status` prints JSON with `loggedIn`, `authMethod`, `apiProvider` | ran it |
| Follow-up form `claude -p ... --cloud <id> --output-format json` returns `{"ok":false,"session_id":...,"error":...}` on failure (here: "Session expired. Please run /login") and accepts the message as an argument **or** with no argument (stdin) | ran it against a fake id; **no session or message was created** |

What the probes **could not** show, and is therefore **NOT TESTED**: what the CLI prints on a successful creation, whether it exits afterwards or stays attached, whether the link appears on its own line, whether it uploads a bundle, and that a follow-up message reaches a real session. The sandbox login could not create cloud sessions, and starting a real one would act on your account. The output reader is built from the documented link shape and accepts a session only when a complete, validated claude.ai session address appears; otherwise the result is "unknown", which is true.

### Long prompts

The CLI takes the task as **one command-line argument** (nothing else is documented), so:

* The whole prompt goes into that argument when it can be passed whole and unchanged: on Linux/macOS up to 100,000 bytes (one argument is limited to 128 KiB); on Windows up to 24,000 characters for a native `claude.exe` or WSL (the CreateProcess limit is 32,767 for the whole line).
* A Windows `.cmd` launcher (the npm install) goes through `cmd.exe`, which has an 8,191 character limit and cannot carry a quote, a percent sign or a line break safely, so such prompts are limited to 6,000 characters without those characters.
* A prompt that starts with a dash would be read as an option, a NUL cannot be in a command line, and an empty prompt is refused.
* **Otherwise the browser route**: the full prompt is copied to the clipboard and `https://claude.ai/code?repositories=owner/repo` opens in your browser; you paste and submit there, then paste the session address back so it is kept. Mini-Summa cannot see whether you submitted. This needs your explicit tick. **The prompt is never shortened and never put in an address.**
* Prompts over 250,000 characters are refused with a message to split them.
* The argument is visible to other programs running as you while the process lives (process listings). Do not rely on it for secrets.
* Windows with a native `claude.exe` and a multi-line prompt is **NOT TESTED**.

### Follow-ups

`claude -p "<message>" --cloud <session id> --output-format json`, the documented form. The result is shown as **accepted** (`ok: true`; not that Claude acted), **rejected** (`ok: false`, with the CLI's reason) or **unknown** (timeout or unreadable output). The same limits as above apply; a message that cannot be passed whole is not sent, and you are told to send it on claude.ai.

### The blank Cloud tab

*Observed:* on Windows the Cloud tab showed its toolbar and sentence and an empty area, and "Open in your browser" worked.

*Cause found in the code (not reproduced; no Windows machine or claude.ai access was available here):* the view reported **"ready"** for any main-frame load that did not raise `did-fail-load`. Chromium treats an HTTP response with an error status and a body (a 403 from a bot check, a 429, a 5xx page) as a successful load, so a refused or empty page produced no error, no note and a native view drawn over the area, hiding everything the renderer could say. The view also had no limit on a load that never finishes, and no way to tell a loaded-but-empty page from a working one.

*Changes:* the view now records the HTTP status of the main page (`did-navigate`) and reports **blocked** (401/403/429, with the number) or **error** (5xx). A security check page the person can complete (the "Just a moment" title) stays a page, as before. A load running longer than 25 s is **stalled**. A load that finishes with no title and still has none 4 s later is **blank** (a guess from the title only; a title that arrives late clears it). In those four states the renderer hides the native view and shows a native panel instead: what failed, the repository, Retry, Open in your browser, Copy session link, New cloud task (the CLI path, which does not need the page), Temporary local session, the sessions started here, and "Show the page anyway" for the two uncertain cases. The log gets one line per settled page with the HTTP status, whether it had a title, the native bounds and visibility (never an address) so the next real run shows which cause it was. Cause candidates **not** ruled out without a Windows run: claude.ai refusing the Electron identity, a challenge the view cannot show, a renderer problem, or bounds on a scaled display. The tests prove the new states with a fake page; they do not prove what claude.ai does.

The page failing never disables CLI dispatch, and Mini-Summa never redirects its window to a browser by itself.

## What is documented

| Capability | Documented? | What Mini-Summa does |
| --- | --- | --- |
| Start a cloud session from the CLI: `claude --cloud "<task>"` (flag shown by `claude --help`: `--cloud [description\|session_id\|url]`) | Yes; interactive only (verified, 2.1.316) | Runs it in a managed terminal after the checks and consent described above. |
| Start in the browser, repository preselected by URL parameter (`repositories`, alias `repo`; also `prompt`/`q`, `prompt_url`, `environment`) | Yes (web quickstart, "pre-fill sessions") | Opens that address, repository only, never a prompt of its own. |
| Branch selection in the address | Not documented | Not offered. The branch is chosen on the page. |
| Associate a session with a GitHub repository | Yes: the session is created for the repository chosen at creation. The Claude GitHub App or a GitHub connection is needed for private repositories | Preselects the project's repository. Mini-Summa never touches GitHub. |
| Start without a local clone | Yes, from the browser. The CLI path has no documented option without a clone | A GitHub-only project can open the Cloud tab without a folder, and can dispatch through the CLI: Mini-Summa then makes a shallow checkout only so the CLI has a repository to run in ([TEMP_WORKSPACES.md](TEMP_WORKSPACES.md)). |
| Follow up on a running session: `claude -p "<message>" --cloud <session id> --output-format json` (the result is `{ok, session_id, url}`, the send result only) | Yes | Used for follow-ups; the result is accepted, rejected or unknown, never completion. |
| Continue a cloud session in a terminal: `claude --teleport [session id]` | Yes (clean git state, a checkout of the same repository, the branch pushed, the same claude.ai account; it makes a copy, not a sync) | Copies the command. |
| Move a local session to the cloud | Desktop app only ("Open in", "Cloud"), carried over as a summary. From the CLI the handoff is one way | Not offered. |
| Trigger a saved routine over HTTP (`/fire`) | Yes, experimental; claude.ai users only; a per-routine token; it neither streams output nor waits for completion | Not used. It cannot list, watch or start arbitrary sessions. |
| List a person's cloud sessions | **No.** The claude.ai/code sidebar is the only list. `claude --resume` does not list them. `claude agents --json` covers sessions on this machine | Cannot show one. |
| Status, completion or "needs input" events for a cloud session (API, webhook, stream, hook) | **No** | Cannot notify about one. |
| Notifications from Anthropic's own apps | Partly. Remote Control (a local session driven from the phone) "can send push notifications to your phone" when a long task finishes or it needs a decision. The desktop app "sends an OS notification when a Code session finishes a task and you aren't currently viewing that session". Neither page names cloud sessions. Email and GitHub notifications for cloud sessions: not documented | Mini-Summa does not control or rely on them. |
| Concurrency | Partly: cloud sessions share the account's rate limits; an organisation can cap how many run at once; no number is documented | Nothing is limited or counted by Mini-Summa. |
| Who can use cloud sessions | Pro, Max, Ultra and Team plans, and Enterprise with premium or Claude Code seats; GitHub connected; the organisation must allow remote sessions. Bedrock, Vertex and Foundry are not supported for `--cloud` | Shows the page; sign-in problems are reported as they appear. |
| Programmatic start under a subscription | CLI and `/fire` only. The Agent SDK and Managed Agents use API keys and are other products | Not used. |

## Not documented, so not built on

* Any API, webhook or event stream for the state of a cloud session, and any way to list cloud sessions.
* Whether `claude agents --json` or `/tasks` include cloud sessions.
* A branch parameter in the address, and the `&` prefix as a way to start a cloud session.
* Embedding `claude.ai/code` in another application, and sign-in with Google or company single sign-on inside an embedded view (see below).
* Whether a long-lived `claude setup-token` token satisfies `--cloud`.
* Notifications for cloud sessions by desktop app, email or GitHub.

`claude --cloud` also accepts an existing session id or `claude.ai/code` address to attach to a cloud session from a terminal (`claude --help`, 2.1.314). Its behaviour was not tested here, so Mini-Summa does not use it.

## Notifications: what is and is not possible

* **Local sessions.** Event driven. Claude's hooks (Notification, Stop, and the report marker) reach Mini-Summa through a spool it reads about every 700 ms, so a desktop notification follows within a second or so while Mini-Summa is running. See `docs/NOTIFICATIONS.md`.
* **Cloud sessions.** **Mini-Summa can send no notification for a cloud session.** Anthropic documents no event, status call or completion signal that an application can use, and hooks defined on the person's machine are not read by cloud sessions. A cloud session keeps working on Anthropic's side after Mini-Summa is closed, which is a separate matter from whether anything tells the person it finished. Anything claimed here about Anthropic's own mobile or desktop notifications for cloud sessions would be a guess.
* Mini-Summa does not poll the page, does not read its content and does not infer completion from it.

## Sign-in, terms, and the embedded view

* The embedded Claude view is a separate browser profile. claude.ai documents sign-in with Google, an email link or an email code. The person signs in on claude.ai's own page, which is what Anthropic's terms ask for ("sign-in to a Claude account must complete through Anthropic's own flow"); Mini-Summa never sees, copies or stores credentials and never reads cookies or session tokens. It does not change the browser's identity string and does not try to get around a refusal.
* **Google refuses sign-in inside embedded windows in many cases.** If the sign-in method is refused, use "Open in your browser", or sign in with an email address. Mini-Summa reports the refusal; it does not work around it. Company single sign-on inside the embedded view is untested.
* The embedded view allows no camera, microphone, location or notification permission; only writing to the clipboard (for copy buttons) is allowed. Links to other sites open in the person's browser. Sign-in providers, and GitHub's sign-in, authorisation and app-installation pages only, are allowed inside the view so that signing in and connecting GitHub can finish; any other GitHub page (a pull request linked from a session, say) opens in the person's browser.
* **Open question for the owner (not confirmed with Anthropic).** Anthropic's published terms allow a person to sign in to the unmodified Claude Code binary with their own subscription. They do not permit third-party developers to offer claude.ai login inside their own applications, to route requests through subscription credentials on users' behalf, or to collect, store or intermediate claude.ai credentials or session tokens. Mini-Summa does none of those. Whether a desktop application that shows `claude.ai/code` in an embedded view, or that runs the person's own `claude` in a managed terminal (as local sessions do), is acceptable is **not answered** by the documentation. The remedy that needs no one's permission is already built: "Open in your browser". Confirm the wording with Anthropic before distributing Mini-Summa beyond its owner.

## Checking it on Windows

These steps need a claude.ai subscription that can use Claude Code on the web, with GitHub connected. They are part of `docs/WINDOWS_VERIFICATION.md`.

1. Open a project that has a GitHub repository. In the Claude pane open "New cloud session". Expect the Claude Code on the web page with the repository preselected and nothing started.
2. Sign in on the page. Note which method worked, and if the method was refused in the embedded view, whether "Open in your browser" worked.
3. Start a small task on a throwaway repository. Switch to another project and back: the page of the first project should be the one remembered.
4. Close Mini-Summa while the task runs and open it again: the task keeps running on Anthropic's side; confirm on claude.ai.
5. On the session page use "Copy command to continue in a terminal" and run it in a checkout of the same repository.
6. Confirm you receive **no** Mini-Summa notification when the cloud session finishes, and note whether Anthropic's own apps notified you.

## Sources

Read on 2026-10-30:

* https://code.claude.com/docs/en/claude-code-on-the-web
* https://code.claude.com/docs/en/web-quickstart (pre-fill sessions)
* https://code.claude.com/docs/en/cli-reference
* https://code.claude.com/docs/en/cloud-environments
* https://code.claude.com/docs/en/desktop
* https://code.claude.com/docs/en/remote-control
* https://code.claude.com/docs/en/routines and https://platform.claude.com/docs/en/api/claude-code/routines-fire
* https://code.claude.com/docs/en/hooks
* https://code.claude.com/docs/en/legal-and-compliance
* https://www.anthropic.com/legal/consumer-terms
* https://support.claude.com/en/articles/13189465-logging-in-to-your-claude-account
