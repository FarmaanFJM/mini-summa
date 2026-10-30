// What a person typed at the DESKTOP terminal, read for one question only: could Claude's input line now hold text that was
// typed but not submitted? If it could, text sent from elsewhere (the phone) would be appended to it and submitted as one
// prompt, so the sessions layer refuses to type until the line is dealt with.
//
// This is a heuristic, because the terminal is a picture and Mini-Summa never reads the input line back:
//   sets      a printable character, or pasted text (a bracketed paste, including its line breaks), since the last reset
//   clears    Enter (CR), Ctrl-C, Ctrl-U, a lone Escape (also the first of two)
//   ignores   everything that is not text: cursor and function keys, focus and mouse reports, the terminal's answers to
//             Claude's queries (OSC / DCS strings), Alt+key, Tab, Ctrl+letter other than C and U
//   Backspace and Delete do NOT clear: "a, Backspace" leaves the flag set, because deleting characters cannot be told apart
//   from editing a longer line. The cost of a wrong "set" is one refused send (press Enter or Ctrl-U); the cost of a wrong
//   "clear" would be the phone's text glued onto someone's half-typed line.
// Only bytes a person typed at the desktop count. Text and answers Mini-Summa sends itself never pass through here.
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, CTRL_C } from './keys.ts';

const ESC = '\x1b';
const CR = '\r';
export const CTRL_U = '\x15';

export interface InputLine {
  /** The input line may hold typed text that was not submitted. */
  unsent: boolean;
  /** Inside a bracketed paste whose end has not arrived yet (it can span several writes). */
  pasting: boolean;
}

export const emptyInputLine = (): InputLine => ({ unsent: false, pasting: false });

const isPrintable = (code: number): boolean => code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);

/** Index just after the string sequence that starts at `from` (up to BEL or ESC \, else the end of the data). */
function endOfString(data: string, from: number): number {
  for (let i = from; i < data.length; i++) {
    if (data[i] === '\x07') return i + 1;
    if (data[i] === ESC && data[i + 1] === '\\') return i + 2;
  }
  return data.length;
}

/** Index just after the control sequence `ESC [ params intermediates final` that starts at `at` (the ESC). */
function endOfCsi(data: string, at: number): number {
  let i = at + 2;
  while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) i++;
  while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) i++;
  return i < data.length ? i + 1 : data.length;
}

/**
 * Reads one write of desktop input. `typed` says whether the write contained text (printable characters or pasted content),
 * whatever the state ended up as: "a\r" is typed text and ends with an empty line.
 */
export function scanDesktopInput(before: InputLine, data: string): { line: InputLine; typed: boolean } {
  let { unsent, pasting } = before;
  let typed = false;
  let i = 0;
  while (i < data.length) {
    if (pasting) {
      const end = data.indexOf(BRACKETED_PASTE_END, i);
      const content = end === -1 ? data.slice(i) : data.slice(i, end);
      if (content !== '') { unsent = true; typed = true; }
      if (end === -1) { i = data.length; } else { pasting = false; i = end + BRACKETED_PASTE_END.length; }
      continue;
    }
    const ch = data[i];
    if (ch === ESC) {
      if (data.startsWith(BRACKETED_PASTE_START, i)) { pasting = true; i += BRACKETED_PASTE_START.length; continue; }
      const next = data[i + 1];
      if (next === undefined || next === ESC) { unsent = false; i += 1; continue; } // Escape on its own
      if (next === '[') { i = endOfCsi(data, i); continue; }
      if (next === 'O') { i = Math.min(data.length, i + 3); continue; }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') { i = endOfString(data, i + 2); continue; }
      i += 2; // Alt+key
      continue;
    }
    if (ch === CR || ch === CTRL_C || ch === CTRL_U) {
      unsent = false;
    } else if (isPrintable(data.charCodeAt(i)) || ch === '\n') {
      // A line feed (Ctrl-J) adds a line break to the input; it does not submit.
      unsent = true;
      typed = true;
    }
    i += 1;
  }
  return { line: { unsent, pasting }, typed };
}
