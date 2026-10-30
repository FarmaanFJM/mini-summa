// Helpers for tests that use the fake Claude CLI (fake-claude.mjs): how to start it, how to steer its "model" and how to
// read what it recorded. Test code only; nothing here is imported by the shipped core.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CLAUDE_SCRIPT = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
export const FAKE_CLAUDE_VERSION = '2.1.314';

export interface FakeClaudeCommand {
  file: string;
  prefixArgs: string[];
  wslDistro: null;
}

/**
 * What `EnvironmentsService.claudeCommand()` returns for the fake: node running the script. The state directory travels
 * in the prefix arguments (`--fake-state-dir`), so it reaches the process however it is started (PTY, execFile for
 * `agents --json`) and several fakes with different directories can coexist in one test process.
 */
export function fakeClaudeCommand(stateDir: string): FakeClaudeCommand {
  return { file: process.execPath, prefixArgs: [FAKE_CLAUDE_SCRIPT, '--fake-state-dir', path.resolve(stateDir)], wslDistro: null };
}

/** The same thing as environment variables, for tests that start the script themselves. */
export function fakeClaudeEnv(stateDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { FAKE_CLAUDE_STATE_DIR: path.resolve(stateDir), ...extra };
}

// ---------------------------------------------------------------------------------------------------------------
// Steering the fake model: text to put into a prompt

const q = (s: string): string => `"${s.replace(/"/g, "'")}"`;
const dir = (name: string, ...parts: string[]): string => `[[fake:${[name, ...parts].join(' ')}]]`;

export const directive = {
  /** Runs a tool: PreToolUse then PostToolUse. `bash` really runs the command in the session's cwd. */
  tool: (name: string, ...args: string[]): string => dir('tool', name, ...args.map(q)),
  /** Asks for permission first: PermissionRequest, a dialog that waits for Enter (approve) or Esc (reject). */
  permission: (name = 'bash', ...args: string[]): string => dir('permission', name, ...args.map(q)),
  /** A question dialog (Notification elicitation_dialog); Enter answers. */
  input: (question = 'What should I do next?'): string => dir('input', q(question)),
  /** Ends the turn with an "## Implementation Report" whose last line is the marker. */
  report: (o: { status?: 'complete' | 'partial' | 'blocked'; task?: string } = {}): string =>
    dir('report', `status=${o.status ?? 'complete'}`, `task=${q(o.task ?? 'Fake task')}`),
  /** Ends the turn with StopFailure instead of Stop. */
  error: (code = 'api_error'): string => dir('error', `error=${code}`),
  sleep: (ms: number): string => `[[fake:sleep=${ms}]]`,
  say: (text: string): string => dir('say', q(text)),
  /** The process dies at once: no Stop, no SessionEnd. */
  crash: (code = 1): string => `[[fake:crash=${code}]]`,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Pasted prompts. The real CLI (2.1.314) shows a bracketed paste of 4 lines as "[Pasted text #1 +3 lines]" and reports it in
// UserPromptSubmit.prompt wrapped in <pasted_content> tags; a 2-line paste arrives verbatim. The fake does the same from 3
// newlines on (set FAKE_CLAUDE_PASTE_WRAP=0 to turn that off). received-*.jsonl always holds the text exactly as typed.

export const PASTE_WRAP_MIN_NEWLINES = 3;

/** true when the fake (like the real CLI) will report this pasted text wrapped. */
export const isWrappedWhenPasted = (text: string): boolean => (text.replace(/\r\n?/g, '\n').match(/\n/g) ?? []).length >= PASTE_WRAP_MIN_NEWLINES;

/** Turns a UserPromptSubmit prompt back into the text that was pasted. Text without a wrapper is returned unchanged. */
export const unwrapPastedContent = (prompt: string): string =>
  prompt.replace(/\n\n<pasted_content id="(\d+)">\n([\s\S]*?)\n<\/pasted_content id="\1">\n/g, (_m, _id, text: string) => text);

// ---------------------------------------------------------------------------------------------------------------
// Reading what the fake recorded

export interface FakeHookRun { event: string; command: string; code: number | null; timedOut: boolean; ms: number }
export interface FakeLiveEntry {
  pid: number; cwd: string; kind: 'interactive'; startedAt: number; sessionId: string;
  status: 'idle' | 'busy' | 'waiting'; name?: string; waitingFor?: string; remoteControl?: boolean;
}

function readLines<T>(file: string): T[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as T);
  } catch { return []; }
}

/** Every submitted prompt, exactly as typed. */
export const readReceived = (stateDir: string, sessionId: string): { text: string; at: string }[] =>
  readLines(path.join(stateDir, `received-${sessionId}.jsonl`));

/** additionalContext that SessionStart hooks returned for the latest start of this session, or null. */
export function readContext(stateDir: string, sessionId: string): string | null {
  try { return fs.readFileSync(path.join(stateDir, `context-${sessionId}.txt`), 'utf8'); } catch { return null; }
}

export const readHookRuns = (stateDir: string, sessionId: string): FakeHookRun[] =>
  readLines(path.join(stateDir, `hooks-${sessionId}.jsonl`));

export function readTerminalSize(stateDir: string, sessionId: string): { cols: number | null; rows: number | null } | null {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, `size-${sessionId}.json`), 'utf8')) as { cols: number | null; rows: number | null }; } catch { return null; }
}

/** Raw registrations of running fake sessions (not filtered by pid liveness; `claude agents --json` does that). */
export function readLiveFiles(stateDir: string): FakeLiveEntry[] {
  const dir = path.join(stateDir, 'live');
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: FakeLiveEntry[] = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as FakeLiveEntry); } catch { /* being rewritten */ }
  }
  return out;
}

/** Simulates sessions started elsewhere: extra entries for `claude agents --json`. Pass [] to clear. */
export function writeExternals(stateDir: string, entries: Record<string, unknown>[]): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'externals.json'), JSON.stringify(entries));
}

/** What the fake found in its environment when it started: variable names, plus TERM, COLORTERM and CLAUDE_CONFIG_DIR. */
export function readEnvReport(stateDir: string, sessionId: string): { names: string[]; TERM: string | null; COLORTERM: string | null; CLAUDE_CONFIG_DIR: string | null } | null {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, `env-${sessionId}.json`), 'utf8')); } catch { return null; }
}

/** Where the fake keeps the transcript of a session (it exists only after the first prompt). */
export function fakeTranscriptPath(stateDir: string, cwd: string, sessionId: string, configDir = path.join(stateDir, 'config')): string {
  return path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting

/** Polls until `probe` returns something other than undefined, null or false; rejects with `what` after `timeoutMs`. */
export async function waitFor<T>(probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, timeoutMs = 15_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
