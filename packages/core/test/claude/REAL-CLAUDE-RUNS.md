# Real Claude Code confirmation runs

Date 2026-10-30. Claude Code **2.1.314** (`claude --version` prints `2.1.314 (Claude Code)`), Linux container (x64), model alias
`haiku` (Haiku 5.5) with `--effort low`. Driven through Mini-Summa's own code: `createManagedManager` + the real
`createNodePtySpawner` (@lydell/node-pty) + `writeManagedSettings` + the real `capture.mjs` hook. Nothing was typed by a script
that bypasses the manager except the first-run onboarding keys, which are listed below.

**Not run on Windows (ConPTY), in WSL2, or with a `.cmd` shim. Those paths are unit-tested as strings only: NOT TESTED.**

## How the runs were set up

* Budget: 3 interactive sessions, no more. Run 1 never reached the model, run 2 sent three short prompts, run 3 sent none.
  Total model use: three Haiku turns at low effort.
* The brief said a temporary `CLAUDE_CONFIG_DIR` was not possible because authentication comes from the inherited environment.
  I checked that first (`claude auth status`, free, no model call): an empty config directory is also `loggedIn: true,
  authMethod: oauth_token` in this container. So every run used a fresh, isolated config directory
  (`<scratch>/runN/out/claude-config`) and the harness' own `~/.claude` was never touched. The only thing passed to Claude besides
  `--model haiku --effort low` was `--session-id` / `--resume`, `--settings <managed file>` and `--name`.
* Throwaway working folder under the scratchpad, registered as a project (so the report protocol is injected).
* Child environment: the app's environment without `CLAUDECODE` and without any `CLAUDE_CODE_*`, `CLAUDE_AUTO*`, `CLAUDE_PID`,
  `SESSION_INGRESS_URL`. Run 1 found out why this matters (finding 8). Credentials were inherited, never copied or written.
* The terminal is read from the PTY scrollback of the managed session. Claude draws with cursor moves instead of spaces, so the
  excerpts below have their spaces restored.

| Run | What | Model calls |
| --- | --- | --- |
| 1 | Start, onboarding, idle prompt, graceful stop. Its environment still carried `CLAUDE_CODE_CHILD_SESSION` (my driver's env strip had a bug), which is how finding 8 was found | none |
| 2 | Clean environment. Onboarding, a 4-line prompt, approve (Enter), a 1-line prompt, reject (Escape), a 2-line prompt, approve, graceful stop | 3 prompts |
| 3 | `--resume` of run 2's session, graceful stop | none |

## Result per goal

| Goal | Result |
| --- | --- |
| (a) hooks from `--settings` reach the spool | **Confirmed.** SessionStart (startup and resume), UserPromptSubmit, PreToolUse, PermissionRequest, Notification `permission_prompt`, PostToolUse, Stop, SessionEnd all arrived with `handler_id: ms-managed`, `env_id: posix`. Not triggered on the real CLI in these runs: StopFailure, Notification `elicitation_dialog` / `idle_prompt` |
| (b) multi-line `typeText` + submit is ONE prompt | **Confirmed**: exactly one UserPromptSubmit for a 4-line and for a 2-line paste (see finding 3 for how the text is reported) |
| (c) which keystroke answers the permission dialog | **Confirmed**: Enter approves (tool ran, `PostToolUse`, file written), Escape rejects (tool did not run, no `PostToolUse`, no `Stop`). `keys.ts` needed no change |
| extra: protocol injection through the `--settings` SessionStart hook | **Confirmed** on the real model (finding 2) |
| extra: graceful stop = Ctrl-C twice | **Confirmed**, exit code 0 and SessionEnd every time (finding 6) |
| extra: `--resume <id> --settings <file> --name <n>` | **Confirmed** (finding 7) |

## Findings

1. **Hooks from `--settings` work.** No user-level `settings.json` hook was involved: the isolated config dir only contained
   `{"theme":"dark"}`. Every hook ran the managed command (`... --env posix --handler ms-managed <Event>`).
2. **The report protocol reaches the model through a `--settings` SessionStart hook.** For a real task prompt the final message
   ended with the exact marker line. For a prompt that said "a harness check, nothing else is needed" the model answered
   "This was a harness check, not an implementation task, so there is no implementation report", which it could only say
   with the injected context.
3. **Pasted text is reported differently from typed text.** A single line arrives verbatim. A bracketed paste of 2 lines arrives
   verbatim. A bracketed paste of 4 lines is shown as `[Pasted text #1 +3 lines]` and `UserPromptSubmit.prompt` is
   `"\n\n<pasted_content id=\"4098\">\n<the 4 lines>\n</pasted_content id=\"4098\">\n"`. The threshold between 2 and 4 lines is
   unknown. Anything that compares a typed text with `prompt` (or shows `prompt` to the user) has to handle the wrapper. The fake
   CLI now does the same from 3 line breaks on (`FAKE_CLAUDE_PASTE_WRAP=0` turns it off) and `received-*.jsonl` keeps the
   exact text.
4. **Permission dialog.** Layout and numbering (manual mode, Bash):

   ```
   Bash command
     Tip: auto mode handles these prompts for you - choose "switch to auto mode" below
     Create mini-summa-check.txt containing "hi" and verify
     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
     │ printf 'hi' > "<cwd>/mini-summa-check.txt" && cat "<cwd>/mini-summa-check.txt"
     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Do you want to proceed?
   ❯ 1. Yes
     2. Yes, and always allow access to <cwd> from this project
     3. Yes, and switch to auto mode · auto mode handles these prompts for you
     4. No

   Esc to cancel · Tab to amend
   ```

   * Enter (`sendKeys('approve')`): the first option, tool ran. Done twice (a `Write`-like redirect and an append).
   * Escape (`sendKeys('reject')`): terminal shows `● Interrupted · What should Claude do instead?`, `rejected.txt` was not
     created, **no further hook fired at all** (no PostToolUse, no Stop; consistent with the PoC note "Esc fires no Stop"), the
     input box came back (`manual mode on · ? for shortcuts`) and the session stayed usable. A later answer in the same
     session knew the command had been rejected.
   * Order and timing: `PreToolUse` and `PermissionRequest` land within 0.1 s of each other; the `permission_prompt` Notification
     follows the PermissionRequest by 6.08 s, 5.99 s and 6.05 s (three dialogs).
   * Enter always takes the highlighted option. This is safe for this dialog ("1. Yes") but **not** for the first-run
     folder-trust dialog, whose highlighted option is "No, exit" (finding 9).
5. **`permission_mode` in the payloads is `"default"` while the banner says "manual mode"**; the CLI's `--permission-mode` choices
   are `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. Mini-Summa passes no permission mode.
6. **Graceful stop.** `stop()` wrote Ctrl-C, 100 ms later Ctrl-C (the runs used `ctrlCGapMs: 100`; the default is 150). At an idle
   prompt the first Ctrl-C prints `Press Ctrl-C again to exit`, the second exits with code 0. The `SessionEnd` hook
   (`reason: prompt_input_exit`) landed **0.29 s, 0.56 s and 0.31 s before** the exit was observed on the PTY in the three runs, so
   Claude waits for that hook. A hard kill gives no SessionEnd (unit-tested with the fake; not repeated on the real CLI).
7. **Resume.** `claude --resume <id> --settings <file> --name <n> --model haiku --effort low` resumed the saved conversation (the
   earlier answers, including the report, were redrawn) with no trust dialog. SessionStart had `source: "resume"` and, unlike a
   startup, **no `model`**; it carried `seconds_since_last_response: 74`, `context_tokens: 35878`, `prompt_cache_likely_expired:
   false`, `estimated_cache_write_usd: 0.0072` (the capture script redacted nothing: `redactions: 0`). The fake CLI now emits the same.
8. **Environment leak found by run 1.** Inheriting `CLAUDE_CODE_CHILD_SESSION` made Claude print
   `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…` (nothing could have been
   resumed) and start in **manual** mode. Without it (run 2) the default permission mode of this fresh configuration was **auto**
   ("Auto mode is now Claude Code's default permission mode"), where dialogs are rare. `CLAUDE_CODE_CHILD_SESSION` is now removed by
   `scrubEnvironment`. Consequence for the product: a managed session uses the user's own default mode; permission dialogs only
   appear in manual mode (Shift+Tab cycles auto → manual → accept edits → plan → auto).
9. **First run in a fresh configuration / new folder.** Three screens, none involving the model: the theme picker ("Dark mode"
   preselected, Enter), the security notes ("Press Enter to continue", Enter), and the folder trust dialog:

   ```
   Accessing workspace:  <cwd>
   Quick safety check: Is this a project you created or one you trust? ...
   ❯ No, exit
     Yes, I trust this folder
   Enter to confirm · Esc to cancel
   ```

   The default is **No, exit**; selecting Yes took Down then Enter. Mini-Summa never answers these.
10. **Real payloads carry more than the captured examples.** A named session's `UserPromptSubmit` also has `session_title` and
    `scratchpad_dir`; the examples in `packages/claude-integration/examples/captured-hooks` lack them. Unknown fields are ignored
    by the reducer, so nothing breaks.

## Raw evidence (spool, run 2; paths shortened to `<scratch>`; times are the hook's `received_at`)

```
14:58:59.346 SessionStart      handler=ms-managed env=posix {"source":"startup","model":"claude-haiku-5-5","session_title":"mini-summa-real-run"}
14:58:57.300 UserPromptSubmit  permission_mode=default prompt="\n\n<pasted_content id=\"4098\">\nTask for this session (a harness check, nothing else is needed):\n1. Create a file named mini-summa-check.txt in the current directory.\n2. Its content must be exactly the word hi.\nThen finish the task.\n</pasted_content id=\"4098\">\n"
14:58:59.786 PreToolUse        tool_name=Bash tool_input={"command":"printf 'hi' > \"<cwd>/mini-summa-check.txt\" && cat \"<cwd>/mini-summa-check.txt\"", ...}
14:58:59.871 PermissionRequest tool_name=Bash (same tool_input)
14:59:05.950 Notification      notification_type=permission_prompt message="Claude needs your permission"
   -- sendKeys('approve') = "\r" --
14:59:31.473 PostToolUse       tool_name=Bash
14:59:32.612 Stop              last_assistant_message="I created `mini-summa-check.txt` ... This was a harness check, not an implementation task, so there is no implementation report."
14:59:58.065 UserPromptSubmit  prompt="Run exactly this bash command and nothing else: echo mini-summa-check > rejected.txt"
14:59:59.431 PermissionRequest tool_input={"command":"echo mini-summa-check > rejected.txt", ...}
15:00:05.425 Notification      notification_type=permission_prompt
   -- sendKeys('reject') = "\x1b" -- terminal: "● Interrupted · What should Claude do instead?"; nothing else fired; rejected.txt absent
15:00:41.657 UserPromptSubmit  prompt="Implement this small change:\nAppend a line containing the word done to mini-summa-check.txt."   (2 lines: verbatim)
15:00:44.002 PermissionRequest tool_name=Bash
   -- sendKeys('approve') --
15:00:59.770 PostToolUse       tool_name=Bash          (file now: "hi\ndone\n")
15:01:02.079 Stop              last_assistant_message="... ## Implementation Report ... <!-- mini-summa:report status=complete task=\"Append done line to mini-summa-check.txt\" -->"
15:01:32.094 SessionEnd        reason=prompt_input_exit          (after stop(): Ctrl-C, Ctrl-C; exit code 0 observed at 15:01:32.657)
```

Run 3 (resume): `15:02:16.225 SessionStart {"source":"resume","session_title":"mini-summa-real-run","seconds_since_last_response":74,
"context_tokens":35878,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.0072}` then `15:03:04.974 SessionEnd
{"reason":"prompt_input_exit"}`.

Run 1 (the environment leak), terminal status line: `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…`
and `⏸ manual mode on · ? for shortcuts`. Run 2 banner: `Haiku 5.5 with low effort · Claude API`, `⏵⏵ auto mode on (shift+tab to cycle)`.

## What these runs do NOT show

* Windows ConPTY, WSL2 (`wsl.exe -d ... --exec claude`), a `.cmd` shim, a Windows PowerShell hook command: NOT TESTED.
* The number keys of the dialog (`1`..`4`), Tab-to-amend and the "always allow" options were not pressed.
* `StopFailure`, `elicitation_dialog`, `idle_prompt` and Remote Control (`--remote-control`) were not exercised on the real CLI.
* The size at which a paste is wrapped (between 2 and 4 lines) and how a very long single-line paste is reported.
* Reliability: one session, three prompts, one model.
