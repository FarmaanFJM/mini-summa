// Reading what `claude --cloud` prints. The CLI has no documented machine readable output for creating a session, so this looks for
// two things in the plain text: a claude.ai/code session address (validated with the same parser the Cloud tab uses) and a
// question that needs the person. It never decides that a task finished.
import { parseClaudeCodeUrl } from '@minisumma/shared';

// CSI and OSC sequences, character set selections, and lone ESC controls.
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78MNOPXZ\\^_cDEH]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export interface FoundSession { sessionId: string; url: string }

const URL_CANDIDATE = /https:\/\/(?:www\.)?claude\.ai\/code\/[A-Za-z0-9_%.\-/]*/gi;

/** The first valid session link in the text. A link that is not https, not claude.ai, or does not name a session is ignored. */
export function findSessionLink(text: string, opts: { final?: boolean } = {}): FoundSession | null {
  // A link is read only as printed. Joining a line break back into a link would let the next word become part of a session id, and a
  // wrong id is worse than a missing link (the dispatch is then reported as unknown, which is true).
  // While output is still arriving a chunk can end in the middle of an id, so a link counts only once something follows it. At the end of
  // the process (`final`) the end of the text is a terminator too.
  const flat = stripAnsi(text);
  for (const match of flat.matchAll(URL_CANDIDATE)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= flat.length && opts.final !== true) continue;
    const read = parseClaudeCodeUrl(match[0].replace(/[.,;:)\]]+$/, ''));
    if (read.ok && read.info.kind === 'session' && read.info.sessionId) return { sessionId: read.info.sessionId, url: read.info.url };
  }
  return null;
}

/** A session id typed by itself (`session_...` or `cse_...`) next to words like "session": a hint only, never enough to record a link. */
export function findBareSessionId(text: string): string | null {
  const m = /\b(session_[A-Za-z0-9]{8,}|cse_[A-Za-z0-9]{8,})\b/.exec(stripAnsi(text));
  return m ? m[1] : null;
}

const NEEDS_PERSON: { re: RegExp; what: string }[] = [
  { re: /trust this folder|quick safety check|Yes, I trust/i, what: 'Claude Code asks whether you trust this folder.' },
  { re: /choose the text style|Choose the text style|\/theme/i, what: 'Claude Code is asking for a text style (first run).' },
  { re: /\/login|Please run \/login|not logged in|sign in again|Select login method/i, what: 'Claude Code needs you to sign in.' },
  { re: /Press Enter to continue/i, what: 'Claude Code is waiting for Enter.' },
  { re: /\(y\/n\)|\[y\/N\]|\[Y\/n\]|Do you want to proceed|Do you want to/i, what: 'Claude Code is asking a question.' },
  { re: /install the Claude GitHub App|Connect (?:to )?GitHub|GitHub (?:app|access).*(?:required|needed|not installed)/i, what: 'Claude Code reports that GitHub needs to be connected.' },
];

export function findQuestion(text: string): string | null {
  const flat = stripAnsi(text);
  for (const q of NEEDS_PERSON) if (q.re.test(flat)) return q.what;
  return null;
}

const FAILURES: RegExp[] = [
  /^\s*Error:.*$/im,
  /failed to (?:create|start|send|upload)[^\n]*/i,
  /could not (?:create|start|find|determine)[^\n]*cloud[^\n]*/i,
  /cloud sessions? (?:is|are) not (?:available|supported|enabled)[^\n]*/i,
];

/** The first line that reads like an error, trimmed to a sentence, or null. Used for a failed dispatch's detail. */
export function findFailure(text: string): string | null {
  const flat = stripAnsi(text);
  for (const re of FAILURES) {
    const m = re.exec(flat);
    if (m) return m[0].trim().slice(0, 300);
  }
  return null;
}

/** The last non-empty lines, for showing what the CLI printed. A prompt that appears verbatim is blanked first. */
export function tailLines(text: string, secret: string | null, count = 14): string[] {
  let flat = stripAnsi(text);
  if (secret && secret.length >= 4) flat = flat.split(secret).join('[prompt hidden]');
  // A terminal wraps and re-draws the prompt line by line, so a line that is part of the prompt is blanked too.
  const promptLines = secret ? secret.split('\n').map((x) => x.trim()).filter((x) => x.length >= 12) : [];
  const part = (l: string): boolean => {
    const t = l.trim();
    return secret !== null && t.length >= 12 && (secret.includes(t) || promptLines.some((pl) => t.includes(pl)));
  };
  return flat.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '').slice(-count).map((l) => (part(l) ? '[prompt hidden]' : l.slice(0, 240)));
}

/** `{ok, session_id, url?, error?}` as printed by `claude -p "<message>" --cloud <id> --output-format json`. */
export function parseFollowUpOutput(stdout: string): { outcome: 'accepted' | 'rejected' | 'unknown'; note: string } {
  const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).reverse().find((l) => l.startsWith('{'));
  if (!line) return { outcome: 'unknown', note: 'The CLI printed no result Mini-Summa can read.' };
  try {
    const j = JSON.parse(line) as { ok?: unknown; error?: unknown };
    if (j.ok === true) return { outcome: 'accepted', note: 'The CLI reports that the message was sent. That does not mean Claude has acted on it.' };
    if (j.ok === false) return { outcome: 'rejected', note: typeof j.error === 'string' ? j.error.slice(0, 300) : 'The CLI reports that the message was not sent.' };
  } catch { /* falls through */ }
  return { outcome: 'unknown', note: 'The CLI printed a result Mini-Summa does not understand.' };
}
