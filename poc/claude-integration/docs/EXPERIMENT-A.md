# Experiment A record

Date 2026-10-30, Claude Code 2.1.314, Node 22.22, Linux container. Every prompt ran on a single model; idle sessions never prompted a model. Model spend was roughly US$2 in total (client-side estimates).
The original unredacted artifacts stay in the author's scratch location and are not published.

## Defects the live runs found that synthetic fixtures had missed
1. A second prompt in one session was reported as a late event.
2. A session ending mid-turn without a Stop looked like a clean end.
3. The redactor replaced the numeric field `context_tokens` because its name contains "token".
4. A hook file ingested after a later "gone" snapshot resurrected a dead session. This led to the barrier and generations.
5. A listing can outlive a killed process for a moment, so one snapshot cannot establish absence.
6. The first identity design (anchor on the last different event) could collapse two real events with equal content, such as parallel identical permission requests. It was replaced by the handler and occurrence rule.

## Facts observed on 2.1.314 (no claim beyond this version)
- `--session-id` is honoured in interactive and `-p` mode; `agents --json` returns that UUID once the session has started, even while idle.
- An idle, never-prompted session is not saved: `claude --resume` finds nothing.
- Fresh config directories show onboarding and a folder-trust prompt whose default is No.
- While a permission dialog is open, `agents --json` reports `status: waiting`, `waitingFor: permission prompt`.
- A hard kill produces no SessionEnd.
- Identical hook command strings are executed once; command lines that differ run separately and deliver byte-identical payloads.
- Invalid `--model`: no Stop and no StopFailure fire.

## Report capture in practice
Three of three task prompts carried a valid marker with an accurate status, one of them `blocked` after a permission denial; none of four non-task
prompts did, and no marker appeared in a directory outside the registry. This shows the mechanism works. It is far too little to claim reliability.
