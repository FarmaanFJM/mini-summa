// What the demo terminals print. Looks like a Claude Code session so terminal readability (palette, box drawing,
// truecolor, diffs) can be judged from screenshots; nothing here runs a real process.
import type { SessionView } from '@minisumma/shared';

const ESC = '\x1b';
type Style = (text: string) => string;
const sgr = (code: string): Style => (text) => `${ESC}[${code}m${text}${ESC}[0m`;
const clay = sgr('38;2;217;119;87'); // Claude's own orange, sent as 24-bit colour
const dim = sgr('2');
const bold = sgr('1');
const red = sgr('31');
const green = sgr('32');
const yellow = sgr('33');
const blue = sgr('34');
const cyan = sgr('36');
const added = sgr('38;2;180;230;200;48;2;22;64;44');
const removed = sgr('38;2;240;190;190;48;2;78;30;34');

const nl = '\r\n';
const lines = (...rows: string[]): string => rows.join(nl) + nl;

type Part = string | [text: string, style: Style];
const plainLength = (parts: Part[]): number => parts.reduce((n, p) => n + (typeof p === 'string' ? p : p[0]).length, 0);
const styled = (parts: Part[]): string => parts.map((p) => (typeof p === 'string' ? p : p[1](p[0]))).join('');

/** A box whose right edge lines up, whatever the styling inside the rows. */
function box(inner: number, border: Style, rows: Part[][]): string {
  const row = (parts: Part[]) => `${border('│')} ${styled(parts)}${' '.repeat(Math.max(0, inner - 1 - plainLength(parts)))}${border('│')}`;
  return lines(border(`╭${'─'.repeat(inner)}╮`), ...rows.map(row), border(`╰${'─'.repeat(inner)}╯`));
}

function banner(cwd: string): string {
  return box(54, clay, [
    [[`✻ `, clay], ['Welcome to Claude Code', bold]],
    [],
    [['  /help for help, /status for your current setup', dim]],
    [],
    ['  ', ['cwd:', dim], ` ${cwd}`],
  ]) + nl;
}

const PROMPT_WIDTH = 62;
/** The top edge of the input box and the first line of it. The cursor waits after "> ". */
function promptBox(): string {
  return lines(dim(`╭${'─'.repeat(PROMPT_WIDTH)}╮`)) + `${dim('│')} ${bold('>')} `;
}

const workedTranscript = (): string => lines(
  `${bold('>')} Fix the flaky retry test in internal/push`,
  '',
  `${clay('●')} I'll start by looking at how the retry test measures time.`,
  '',
  `${clay('●')} ${bold('Search')}(pattern: "retry", path: "internal/push")`,
  `  ${dim('⎿')}  Found ${bold('6')} files`,
  '',
  `${clay('●')} ${bold('Read')}(internal/push/retry_test.go)`,
  `  ${dim('⎿')}  Read ${bold('142')} lines`,
  '',
  `${clay('●')} The test sleeps for real time, so it depends on`,
  `  the machine. I'll switch it to the fake clock.`,
  '',
  `${clay('●')} ${bold('Update')}(internal/push/retry_test.go)`,
  `  ${dim('⎿')}  Updated retry_test.go with ${green('12 additions')} and ${red('9 removals')}`,
  `      ${dim('36')}   func TestRetryBackoff(t *testing.T) {`,
  `      ${dim('37')}       clock := fakeclock.New()`,
  `      ${dim('38')} ${removed('-       time.Sleep(50 * time.Millisecond)            ')}`,
  `      ${dim('38')} ${added('+       clock.Advance(50 * time.Millisecond)         ')}`,
  `      ${dim('39')}       require.Equal(t, 2, attempts)`,
  '',
  `${clay('●')} ${bold('Bash')}(go test ./internal/push -run Retry -count=200)`,
  `  ${dim('⎿')}  ${green('ok')}  \tgitmanager/internal/push\t4.213s`,
  '',
  `${clay('✻')} ${yellow('Running tests')}${dim('… (12s · esc to interrupt)')}`,
  '',
);

const permissionTranscript = (): string => lines(
  `${bold('>')} Reinstall dependencies and rerun the build`,
  '',
  `${clay('●')} A clean install will rule out a stale lockfile.`,
  '',
  `${clay('●')} ${bold('Bash')}(rm -rf node_modules && npm ci)`,
  '',
) + box(60, dim, [
  [['Bash command', bold]],
  [],
  ['  rm -rf node_modules && npm ci'],
  [['  Remove packages and install from the lockfile', dim]],
  [],
  ['Do you want to proceed?'],
  [['❯ 1. Yes', cyan]],
  ['  2. Yes, and don\'t ask again for npm ci'],
  ['  3. No, and tell Claude what to do differently ', ['(esc)', dim]],
]);

const idleTranscript = (): string => lines(
  `${bold('>')} Summarise what changed in the auth middleware`,
  '',
  `${clay('●')} The middleware now validates the token audience`,
  `  before checking scopes. Three call sites were updated`,
  `  and two tests were added.`,
  '',
  `${clay('●')} ${blue('Report')} ${dim('· complete · "Review the auth middleware"')}`,
  '',
);

const failedTranscript = (): string => lines(
  `${bold('>')} Run the benchmark suite`,
  '',
  `${clay('●')} ${bold('Bash')}(npm run bench)`,
  `  ${dim('⎿')}  ${red('Error:')} Cannot find module './candles.worker'`,
  `      at Object.<anonymous> (bench/run.ts:14:1)`,
  `      ${dim('Process exited with code 1.')}`,
  '',
);

export interface ReplayIds { gmWorking: string; gmPermission: string; atlasIdle: string; dashFailed: string }

/** The screen a freshly attached terminal shows for this session. Ends where the cursor should wait for input. */
export function replayFor(session: Pick<SessionView, 'key' | 'cwd'>, ids: ReplayIds): string {
  const cwd = session.cwd ?? '~';
  if (session.key === ids.dashFailed) return banner(cwd) + failedTranscript();
  if (session.key === ids.gmPermission) return banner(cwd) + permissionTranscript();
  if (session.key === ids.gmWorking) return banner(cwd) + workedTranscript() + promptBox();
  if (session.key === ids.atlasIdle) return banner(cwd) + idleTranscript() + promptBox();
  return banner(cwd) + lines(dim('Type a message to start. Nothing typed here runs in the demo.'), '') + promptBox();
}

/** A tiny line editor so typing in a demo terminal feels alive: echo, backspace, Enter, Ctrl+C. */
export class EchoShell {
  private line = '';

  feed(data: string): string {
    let out = '';
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i];
      if (ch === ESC) { // skip escape sequences (arrows, function keys)
        i += 1;
        while (i < data.length && !/[A-Za-z~]/.test(data[i])) i += 1;
        continue;
      }
      if (ch === '\r') {
        const typed = this.line.trim();
        this.line = '';
        out += nl + dim(`╰${'─'.repeat(PROMPT_WIDTH)}╯`) + nl;
        if (typed !== '') out += `${clay('●')} ${dim('(demo)')} Got "${typed}". Nothing runs in the demo.${nl}`;
        out += nl + promptBox();
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line.length > 0) { this.line = this.line.slice(0, -1); out += '\b \b'; }
      } else if (ch === '\x03') {
        this.line = '';
        out += `${dim('^C')}${nl}${promptBox()}`;
      } else if (ch >= ' ') {
        this.line += ch;
        out += ch;
      }
    }
    return out;
  }
}
