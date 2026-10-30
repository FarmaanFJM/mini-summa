# Claude Code cloud sessions and Mini-Summa

Read this before relying on anything about the cloud in Mini-Summa. It separates what Anthropic documents from what is assumed or unknown, and says plainly what Mini-Summa does with each.

**Method and date.** Researched on 2026-10-30 from Anthropic's published pages (code.claude.com, platform.claude.com, support.claude.com, anthropic.com legal) and from `claude --help` of the installed Claude Code 2.1.314. Page text was read through a fetch tool that summarises pages, so quote exact wording from the live page before repeating it elsewhere. No private endpoint, no reverse engineering, no credential or cookie reading was used. **No cloud session was started and no claude.ai subscription login was available in the test environment, so nothing below about the cloud has been exercised against the real service.** The automated tests use a local stand-in for claude.ai, which proves what Mini-Summa does with a page (which address it opens, that it never types or submits), not how claude.ai behaves.

## What Mini-Summa does

Per project, in the Claude pane:

* **Cloud tab (browser based).** If the project has a GitHub repository, the tab shows Claude Code on the web (`claude.ai/code`) in an isolated browser view inside Mini-Summa, opened on the documented new-session address with the repository preselected: `https://claude.ai/code?repositories=owner/repo`. Opening that address starts nothing; the person writes the task and submits on the page.
* **Remembered page.** The last `claude.ai/code` address the person was on in each project is remembered (without query string or fragment) and opened again next time. This is a bookmark. The session itself lives on Anthropic's side and keeps running whether or not Mini-Summa is open.
* **Continue in a terminal.** On a session page, one button copies the documented command `claude --teleport <session id>`.
* **Open in your browser.** Always available. It is the fallback when the page refuses the embedded view or the person prefers their own browser.
* **Local sessions stay local.** "New local session" starts Claude in a project folder, as before. "New cloud session" opens the Cloud tab. Neither is ever substituted for the other: when a choice is impossible (no folder, no repository) the menu says why and offers the fix.

What this is not: **it is browser navigation, not native session control.** Mini-Summa shows a web page. It cannot list the person's cloud sessions, cannot tell whether one is working, finished, failed or waiting for input, cannot start one by itself, and cannot approve anything in one.

## What is documented

| Capability | Documented? | What Mini-Summa does |
| --- | --- | --- |
| Start a cloud session from the CLI: `claude --cloud "<task>"` (flag shown by `claude --help` 2.1.314: `--cloud [description\|session_id\|url]`) | Yes | Nothing. It needs a local clone and the person's claude.ai login. The person can run it in any terminal. |
| Start in the browser, repository preselected by URL parameter (`repositories`, alias `repo`; also `prompt`/`q`, `prompt_url`, `environment`) | Yes (web quickstart, "pre-fill sessions") | Opens that address, repository only, never a prompt of its own. |
| Branch selection in the address | Not documented | Not offered. The branch is chosen on the page. |
| Associate a session with a GitHub repository | Yes: the session is created for the repository chosen at creation. The Claude GitHub App or a GitHub connection is needed for private repositories | Preselects the project's repository. Mini-Summa never touches GitHub. |
| Start without a local clone | Yes, from the browser. The CLI path has no documented option without a clone | A GitHub-only project can open the Cloud tab without a folder. |
| Follow up on a running session: `claude -p "<message>" --cloud <session id> --output-format json` (the result is `{ok, session_id, url}`, the send result only) | Yes | Not used. |
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
* The embedded view allows no camera, microphone, location or notification permission; only writing to the clipboard (for copy buttons) is allowed. Links to other sites open in the person's browser. Sign-in providers and GitHub's authorisation pages are allowed inside the view so that signing in and connecting GitHub can finish.
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
