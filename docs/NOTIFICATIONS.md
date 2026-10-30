# Notifications

## What produces a notification

| Event | Desktop | Phone (push) |
| --- | --- | --- |
| A report is ready for ChatGPT | yes | yes |
| Claude needs permission | yes | yes |
| Claude asks for your input | yes | yes |
| A session hit an error | yes | yes |
| A session vanished from Claude Code's listing (suspected, not confirmed) | yes | yes |
| A session ended abnormally (it was working) | yes | yes |
| A phone asked to send a prompt and waits for your approval | yes | yes |
| A normal session end, a turn ending, a resumed session | feed only | no |

Every event also appears in the activity feed, which keeps unread state across restarts. Notifications are deduplicated:
an event produces at most one notification, and replaying history after a restart never notifies again.

## Controls

* **Per project:** master switch plus permission, input, error, report, session ended, presence lost, and phone push.
* **Quiet mode:** manual (until you turn it off or until a time) or a daily schedule, including overnight windows. Quiet
  mode silences desktop and push notifications; events still land in the feed as unread.
* Clicking a desktop notification brings Mini-Summa forward and opens the project, session, or report it is about.

## Desktop

Windows toasts need the app's identity (`com.minisumma.app`), which the installer creates through the Start Menu
shortcut. Clicking a toast while Mini-Summa is running navigates to the right place. What happens when you click a toast
after Mini-Summa was fully closed is not verified (see `docs/VERIFICATION.md`): in that case the notification can only
come from a running app, so none is produced while the app is closed.

## Phone

* **While the phone is connected** (Tailscale reachable and the app open), events arrive live over the secure WebSocket.
* **While the app is closed**, notifications need a push provider. Mini-Summa uses Firebase Cloud Messaging with *your*
  Firebase project: you import its service account on the desktop and put its `google-services.json` into the Android
  build. Nothing is sent through a Mini-Summa server; there is none.
* **Payloads are minimal by design**: project name, a fixed sentence per event kind ("A report is ready"), and ids. Never
  report text, task text, tool inputs, or file paths. Opening the notification fetches the details from your PC.
* **If the PC is asleep, off, or not on your tailnet**, nothing can be pushed (the PC is the sender) and the phone cannot
  fetch data. The app says so plainly and shows when it last had contact; it never presents old data as live.
* Push delivery is only claimed once it was tested end to end on a real device with a real Firebase project. See
  `docs/VERIFICATION.md` for the current status.
