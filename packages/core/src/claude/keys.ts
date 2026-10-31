// Keystrokes Mini-Summa sends into a Claude Code terminal, in one place.
//
// CONFIRMED against the real CLI (Claude Code 2.1.314, Linux, 2026-10-30; evidence in
// packages/core/test/claude/REAL-CLAUDE-RUNS.md). Not run on Windows (ConPTY) or in WSL.
//  - approve = Enter. The permission dialog is "Do you want to proceed?  1. Yes / 2. Yes, and always allow ... / 3. Yes, and
//    switch to auto mode / 4. No" with "1. Yes" highlighted; Enter ran the tool (PostToolUse fired, the file was written).
//  - reject = Escape. "Interrupted - What should Claude do instead?": the tool did not run, no PostToolUse, no Stop.
//  - text = the text, then Enter as its own write 150 ms later: one prompt, verbatim. Several lines go in as ONE bracketed
//    paste (then Enter 150 ms later): a single UserPromptSubmit. Caveat of the real CLI: a paste of 4 lines is reported in
//    UserPromptSubmit.prompt wrapped in <pasted_content id="N"> tags; a paste of 2 lines is reported verbatim.
//  - Enter selects whatever is highlighted. In the permission dialog that is "Yes", but in the first-run folder-trust dialog it
//    is "No, exit". Callers must only answer a dialog the hooks have reported (state needs_permission), never blindly.
// If a later Claude Code release changes a dialog, this is the only file that has to change; the rest of the code asks for
// `approve`/`reject` and for "type this text".

export type PermissionDecision = 'approve' | 'reject';

/** What answers Claude Code's permission dialog. Enter takes the highlighted first option ("Yes"); Escape cancels. */
export const PERMISSION_KEYS: Readonly<Record<PermissionDecision, string>> = {
  approve: '\r',
  reject: '\x1b',
};

export const ENTER = '\r';
export const ESCAPE = '\x1b';
export const CTRL_C = '\x03';

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Wait before the Enter that submits typed or pasted text. Claude Code treats data that arrives in one burst as a paste,
 * and an Enter inside a paste is a new line, not "submit". Sending Enter as its own, later write makes it a key press.
 */
export const SUBMIT_DELAY_MS = 150;

export interface KeyStep {
  /** Bytes to write to the terminal. */
  data: string;
  /** Pause before writing `data`, measured from the previous step. */
  delayMs: number;
}

/**
 * Makes user-authored text safe to send to a terminal:
 *  - line endings become `\n`;
 *  - control characters are dropped (the ESC of `ESC [ 2 0 1 ~` would end a bracketed paste early and let the rest of
 *    the text act as key presses; DEL, NUL, bell and the 8-bit C1 controls are never text), keeping only newline and tab.
 */
export function sanitizeUserText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/**
 * The writes that make Claude Code receive `text` as the user's prompt.
 *  - single line: the text itself;
 *  - several lines (or a tab): one bracketed paste, so the line breaks stay inside ONE prompt;
 *  - `submit`: a separate Enter after a short delay. Without `submit` the text is left in the input box for the user.
 */
export function encodeUserText(text: string, opts: { submit: boolean; submitDelayMs?: number }): KeyStep[] {
  const clean = sanitizeUserText(text);
  const steps: KeyStep[] = [];
  if (clean !== '') {
    const needsPaste = clean.includes('\n') || clean.includes('\t');
    steps.push({ data: needsPaste ? `${BRACKETED_PASTE_START}${clean}${BRACKETED_PASTE_END}` : clean, delayMs: 0 });
  }
  if (opts.submit) steps.push({ data: ENTER, delayMs: clean === '' ? 0 : opts.submitDelayMs ?? SUBMIT_DELAY_MS });
  return steps;
}
