# How a report reaches ChatGPT

This page states exactly what Mini-Summa automates and what stays in your hands.

## What is automatic

1. **Detection.** Mini-Summa learns that a Claude Code turn ended through Claude Code's documented hooks. A turn ending
   (`Stop`) is *not* treated as a finished task. A task is reported only when Claude's final message ends with the
   report marker `<!-- mini-summa:report status=complete|partial|blocked task="..." -->`. The marker is a declaration
   written by the model. It is never treated as proof that the work succeeded or that tests passed.
2. **Attribution.** The report is tied to the project and the exact session (`environment|session id`) it came from.
   Managed sessions are bound to their project when Mini-Summa starts them; other sessions are matched by their
   working directory or assigned by you.
3. **Storage.** The complete final message is stored locally. Credential-like strings are replaced by `[REDACTED]` when
   the message is captured, and the report tells you how many were hidden (including zero). Nothing else is shortened or
   rewritten. Redaction recognises the usual shapes of keys, tokens, private keys, passwords and credentials in URLs; it is
   pattern based, so read a report before you paste it somewhere you do not trust.
4. **Destination.** Mini-Summa takes the ChatGPT conversation you mapped: the conversation bound to that session, else
   the project's preferred conversation, else the project's only conversation. The choice is **frozen into the delivery
   record**. It does not follow whichever tab or project is on screen, and changing the preferred conversation later does
   not redirect reports that already exist. Re-pointing a delivery is an explicit action and is logged.
5. **Preparation.** Mini-Summa builds the message: project, task title, session reference, status as declared, the full
   report between unique fences, and a review request you can edit in Settings. Very long messages are split into
   numbered parts without loss (the parts concatenate back to the exact message).
6. **Notification.** You are told that a report is ready, and which project owns it.
7. **One-click handoff.** *Copy and open* puts the message (or the next part) on the clipboard and opens or focuses the
   mapped conversation: the embedded ChatGPT view, or, in external-browser mode, the already-open tab if the optional
   extension is installed, otherwise the default browser. The button is in the Reports queue and, for the project you are looking
   at, in a **strip at the bottom of the workspace** ("Report ready: <task>"), so you can paste, send and press *I sent it* without
   leaving ChatGPT and the terminal. After *Copy and open* the strip reads "Waiting for you to send: <task> to <conversation>.
   It is not marked as sent until you press I sent it." It shows the report that waits longest in the middle of a handoff first,
   mentions how many others wait, and offers only the main button, *Copy again*, *Open conversation* and *Not sure*; discarding,
   changing the destination and preparing long messages stay in the Reports queue.

## When Claude does not write the marker

The marker is an instruction Mini-Summa gives the session when it starts (through the SessionStart hook, only for folders that
belong to a registered project), and a model can ignore an instruction. Measured with the real Claude Code CLI 2.1.314 on Linux, with
natural prompts that did not mention the marker: the default model wrote it for 3 of 3 tasks and Haiku for 7 of 7 after the
wording of the instruction was broadened, and none of the 4 plain questions that were not tasks got one
(`npm run verify:protocol` repeats this against your own Claude). That is a small sample on one machine, not a guarantee. A
final message without the marker is **not lost and not handed off**: it is stored and shown under *Other messages* in the
Reports view, where you can still read it and decide yourself.

## What stays manual, on purpose

* **Pasting into ChatGPT and pressing Send.** There is no documented, permitted way to submit a message into an existing
  ChatGPT web conversation, so Mini-Summa does not do it. It never types into the page, clicks Send, reads ChatGPT's
  answer, scripts the page's DOM, or uses undocumented endpoints.
* **Saying that it was sent.** After you send it, press *I sent it*. Until then the delivery says *Awaiting your send*.
  Copying a report is not recorded as sending it, and opening the conversation is not recorded as delivery.
* **Reading the review.** Mini-Summa cannot see ChatGPT's answer. Review progress (*Review awaiting you*, *Review noted*,
  *Follow-up prepared*) is what you tell it.
* **Sending feedback back to Claude.** You choose the project and session, see the exact text, and approve it. It is typed
  only into a managed, live session whose identity and generation are re-checked at the moment of sending. Nothing is
  ever sent to Claude automatically because ChatGPT recommended it.

## Delivery states

| State | Meaning |
| --- | --- |
| Report captured | Stored. Destination not resolved yet. |
| Destination missing | No ChatGPT conversation is mapped. Choose one. |
| Destination unverified | A conversation is mapped but has not been confirmed to open. |
| Ready for handoff | Destination known and verified. |
| Copied | At least one part is on the clipboard. This is **not** sent. |
| Awaiting your send | Copied and the conversation was opened. Waiting for you. |
| You confirmed it was sent | Your statement. |
| Delivery uncertain | You are not sure, or something failed. Nothing is retried for you. |
| Discarded | You decided not to hand it off. |

A restart never advances, repeats or resubmits a delivery. It stays exactly where you left it.

## Large reports

*Copy and open* copies part 1 of N; the delivery shows which parts you copied. Alternatives: copy the full message, save
it as a file (attach it manually where ChatGPT supports file attachments), or open the stored report in Mini-Summa.

## Embedded view versus external browser

The embedded ChatGPT view uses its own persistent browser profile, with the normal web security model, no Node.js
access, and no changes to the user agent or security headers. If ChatGPT or your identity provider refuses to sign in
inside an embedded browser (Google sign-in often does), Mini-Summa tells you and you can switch to external-browser mode
in Settings. Everything above works the same in both modes.
