# Notifications

What Mini-Summa can tell you about a Claude session, how it knows, how long that takes, and what needs Mini-Summa to be running.
Measured numbers come from a Linux sandbox with a fake Claude. They are not Windows numbers. Nothing on Windows (toasts, hook
start-up time) has been measured.

## In short

* Mini-Summa hears about a Claude session on **this computer** through Claude Code **hooks** (an event arrives) and through
  `claude agents --json` (polled). It hears nothing from **cloud** sessions: no event source for them is implemented.
* A hook event is read from a spool folder by a **700 ms poll**, not by a folder watcher. From the hook's file to the call that
  shows the notification took 12 to 690 ms on Linux, median about 300 ms. That is Mini-Summa's part only.
* **Mini-Summa has to be running.** Closing its window quits it. Nothing is delivered while it is closed, to the desktop or the phone.

## What produces a notification

"Event" means a Claude Code hook arrived. "Polled" means a timer asked. "Inferred" means Mini-Summa concluded it from something else.
Every event kind is late by the hook's start-up plus up to 0.7 s (next table).

| Desktop title | Produced by | Class | On by default |
| --- | --- | --- | --- |
| `<project>: needs permission` | `PermissionRequest` hook | **Event** | yes |
| `<project>: needs your input` | `Notification` hook of type `elicitation_dialog` or `elicitation_url_dialog`. Also a paired phone asking to send a prompt (an HTTP request, shown at once) | **Event** | yes |
| `<project>: error` | `StopFailure` hook | **Event** | yes |
| `<project>: report ready` | `Stop` hook whose last line is the report marker, with no background work pending | **Event**, but only if the model wrote the marker. The marker is a declaration, not proof | yes |
| `<project>: Claude finished` | `Stop` hook **without** a valid marker, with no background work pending | **Event.** Proves the turn ended, not that the task succeeded | yes |
| `<project>: session ended` | `SessionEnd` hook that arrived while the session was working or waiting, with no `Stop` before it | **Event** | **no** |
| `<project>: session no longer visible` | `claude agents --json` stopped listing a session it had listed. Late by up to one poll: `discoveryIntervalSec`, 15 s by default | **Polled** and **inferred**: absent does not mean ended | yes |

Feed only, no notification: a session started, found or resumed; "Waiting for you" (**inferred** from Claude's `idle_prompt` notice,
about a minute after a turn); a turn that ended with background work pending; a turn you interrupted (Esc fires no hook, so the
session is only seen idle by the next poll); delivery states.

Not observable: whether the work succeeded, whether Claude is stuck, an Esc at a permission prompt (no hook; the entry closes when you
answer through Mini-Summa or when Claude's next event arrives), and background work that never ends (a dev server, or a recurring task
scheduled in the session, keeps it at "turn ended, background work pending", so it never says "finished").

A session with no hooks (started before they were installed, or where the install does not reach) is seen by polling only: presence
and busy, waiting or idle. It can produce "needs permission", "needs your input" and "no longer visible", up to one poll late. It
never produces "Claude finished" or a report.

## How long it takes

| Step | What decides it | Measured on Linux | Windows |
| --- | --- | --- | --- |
| Claude Code starts the hook | A process start: `node`, then `capture.mjs` writes the spool file | 38 to 166 ms from spawn to exit, median 43 to 52 ms (81 runs, twice) | Not measured. PowerShell, then Electron in Node mode; the hook has a 5 s limit and is not retried |
| The core notices the file | A timer, `spoolPollMs`, **700 ms** after the previous pass ended. A pass waits for a `claude agents --json` call that is running (every 15 s by default; the call has a 20 s limit, 30 s for WSL) | 0 to about 700 ms, median about 300 ms. The fake `claude agents --json` takes 36 to 62 ms here, so the real CLI's wait is not in this number | Same code. Not measured |
| Read, reduce, record, ask the desktop | In the same process | 10 to 30 ms | Same |
| The toast | The operating system | Not measurable (no notification service here) | Not measured |
| The phone's push | Firebase | Not measured | Not measured |

From the hook's file appearing in the spool folder to the notification record existing, with the default interval, two runs of 40
turns: minimum 29 and 13 ms, median 306 and 288 ms, maximum 642 and 690 ms. The call that asks the desktop to show it came within
2 ms of the record. `packages/core/test/integration/notification-latency.test.ts` fails if any turn takes 2 seconds or more; run
it with `MS_LATENCY_SAMPLES=40 npx vitest run --root packages/core test/integration/notification-latency.test.ts --reporter=verbose --disableConsoleIntercept`
to see the numbers.

Do not read "under a second" as "instant". The slowest case is the poll (0.7 s), plus a `claude agents --json` call that happens to be
running (usually short, but it can hold the queue for up to 20 s), plus Windows starting the hook and showing the toast. The last two are unmeasured.

## One turn, one notification

* A notification is keyed by its cause (the derived event of that `Stop`), and the key is stored with the record. The same cause never
  notifies twice: not after a restart, and not when two hook registrations deliver the same event (tested with both installed).
* A turn that ends **with** a report notifies as `report ready` only. One `Stop` cannot produce both, and a second `Stop` with no
  work in between (a stop hook that sent Claude on for one more step) is the same turn, so it does not add "finished".
* A turn that ends with **background work pending** does not notify. Claude goes on by itself when that work ends, nobody has to
  come, and "finished" would be untrue. When the turn ends for good it notifies once. The cost: work that never ends stays silent.
* **Replayed history never notifies.** After a restart the log is read again; entries are made, toasts are not.
* A session that belongs to **no project** does not notify "Claude finished": hooks run for every Claude session on the computer.
* "Waiting for you" after a turn is a feed entry, never a second notification.

## Not shown when you are looking at it

"Claude finished" (only that one) is not shown when **all** of these hold: the Mini-Summa window is in front, you used the keyboard or
mouse in the last 2 minutes, the window shows the workspace of that project with that session's tab selected, and the Claude pane is
not hidden by a maximized ChatGPT pane. Anything unknown means "show it". Permission, input, error, report, ended and lost are never held back.

* The record says **Not shown: you were looking at that session** (not quiet mode, not a failure), and the feed keeps the entry, unread.
* The **phone follows the same rule**, so a pocket does not buzz for what you are watching. After 2 minutes without input, or with
  another window in front, the push goes.
* The core learns what the window shows about 0.6 s after you change it, so just after switching session the answer can still be the
  one for the session you left.

## When Mini-Summa is not running

| What | Happens |
| --- | --- |
| You close the window | Mini-Summa **quits**. It asks first if Claude terminals are running, and ends them (they can be resumed). There is no tray-only mode, and the tray icon exists only while the app runs |
| A Claude you started in your own terminal | Keeps running. Its hooks keep writing files to the spool folder; nobody reads them |
| You start Mini-Summa again | The waiting files are read as **history**: feed entries appear, unread. **No toast and no push** for them, by design |
| The phone | Pushes are sent by this PC. PC off, asleep or Mini-Summa closed: none arrive |
| Start with Windows | Not a feature today. Mini-Summa runs when you start it |

## Opening the session from the notification

A click shows the window (restores it if minimized, shows it if hidden), then selects the project and the session tab, whichever
project was selected. A report notification opens the report. If the window is still loading, the target is held until it is ready.
Notifications are made for every project's sessions, selected or not. Verified in the real app on Linux with a simulated
notification service; a click on a real Windows toast is not verified.

Indicators today: a dot on a project in the sidebar for permission, input, error, lost or abnormal end (it clears when the state
changes), the footer counts, the tray tooltip, a dot on the Windows taskbar button with the number of sessions that wait for you (the
same count, driven by the core in the main process; wired in this round and **not tested on a real taskbar**), and the Notifications
list in Activity, which says what became of each one.
"Claude finished" does not light the dot: that state lasts until your next prompt and you cannot acknowledge it, so it would never clear.

## Cloud sessions

Mini-Summa receives hook events from sessions on this computer only. **A cloud session produces no notification from Mini-Summa.**

* Anthropic documents no event, status call, webhook or listing of cloud sessions that an application can use, and the hooks in your
  own Claude settings are not read by cloud sessions. Details and sources: `docs/CLOUD_SESSIONS.md`.
* Mini-Summa does not poll the claude.ai page, does not read its content and does not infer "finished" from it. The Cloud tab shows a
  web page; it is not session control.
* **Dispatching a task through the CLI changes none of this.** "Session created" means the CLI printed a validated session link. It does not
  mean Claude started, is working, is waiting for you or finished, and Mini-Summa shows no such state for a cloud session at any time: not from the
  elapsed time, not from whether the process is still open, not from the browser tab. A follow-up shown as "accepted" means the CLI took the
  message. A pull request or workflow on GitHub is a separate signal that you can look at; Mini-Summa does not equate it with the session.
* Local sessions started in a temporary workspace are ordinary managed sessions: hooks, reports and notifications work as for any local session.
* If Anthropic documents a status mechanism later, it would be added behind its own capability check; there is none today.
* A cloud session keeps working on Anthropic's side while this PC is off or Mini-Summa is closed. That it keeps working is a different
  question from whether anything tells you it finished.
* Anthropic's own apps document some notifications (Remote Control push for a local session driven from the phone, and an operating
  system notification from the desktop app when a Code session finishes a task and you are not looking at it). Neither page names cloud
  sessions, so nothing here can be promised about them. To know when a cloud task is done, look at the claude.ai page or use their apps.

## Controls

* **Per project:** master switch, then permission, input, error, report, Claude finished, session ended, session no longer visible, and phone.
* **Desktop switch** (Settings, Notifications): turns the toasts off; the phone follows the project's phone switch.
* **Quiet mode:** manual, until a time, or a daily window (overnight too). Silences toast and push; events stay in the feed, unread.
* Windows toasts need the app identity `com.minisumma.app`, which the installer creates. A toast counts as shown when Windows
  accepted it, even if Focus assist sent it to the Action Center.

## Phone

* Payloads carry the project name, a fixed sentence per kind ("Claude finished and is waiting for you") and ids. Never report text,
  task text, tool input or paths. The phone opens the notification by id and loads the details from your PC.
* With the phone connected (Tailscale, app open) events also arrive over the WebSocket. With the app closed, push needs your own
  Firebase project. A phone app that does not know "Claude finished" reads it as a plain update and still opens the session.
* Push delivery is only claimed once it was tested end to end on a real device. See `docs/VERIFICATION.md`.
