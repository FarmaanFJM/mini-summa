// How the full text of a prompt reaches `claude --cloud`, or why it cannot.
//
// Verified on Claude Code 2.1.316 (see docs/CLOUD_SESSIONS.md): `claude --cloud "<description>"` takes the task as ONE command line
// argument and needs a terminal. `--print` cannot be combined with it, and without a terminal it refuses to start a new session. There is
// no documented file or stdin input for creating a cloud session, so none is used.
//
// Consequences, all decided here and nowhere else:
//  * The prompt goes into argv only when it can be passed whole and unchanged. It is never shortened, summarised or "fixed".
//  * A Windows .cmd launcher (the npm install) goes through cmd.exe, which has an 8191 character line limit and cannot carry a quote,
//    a percent sign or a line break safely (ptyHost.quoteForCmd refuses them), so those prompts take the browser route.
//  * Anything else that does not fit takes the documented browser route: the text goes to the clipboard and claude.ai/code opens with the
//    repository preselected. The text never travels in a URL.
import type { PromptDeliveryPlan } from '@minisumma/shared';

export interface DeliveryContext {
  platform: NodeJS.Platform;
  /** The claude launcher file: a .cmd or .bat on Windows means cmd.exe parses the line. */
  claudeFile: string;
  wsl: boolean;
}

// cmd.exe stops at 8191 characters for the whole line; leave room for the launcher path, flags and quoting.
export const CMD_ARGV_LIMIT = 6_000;
// CreateProcess stops at 32767 characters for the whole line; wsl.exe adds its own arguments.
export const WIN_ARGV_LIMIT = 24_000;
// One argument may be at most 128 KiB on Linux (MAX_ARG_STRLEN); macOS allows far more. Stay well below.
export const POSIX_ARGV_LIMIT = 100_000;

const CMD_SHIM = /\.(cmd|bat)$/i;

export function planPromptDelivery(prompt: string, ctx: DeliveryContext): PromptDeliveryPlan {
  const chars = prompt.length;
  const bytes = Buffer.byteLength(prompt, 'utf8');
  const windows = ctx.platform === 'win32';
  const cmd = windows && !ctx.wsl && CMD_SHIM.test(ctx.claudeFile);
  const limit = cmd ? CMD_ARGV_LIMIT : windows || ctx.wsl ? WIN_ARGV_LIMIT : POSIX_ARGV_LIMIT;
  const browser = (reason: string): PromptDeliveryPlan => ({ method: 'clipboard_browser', reason, chars, bytes, argvLimitChars: limit });

  if (prompt.trim() === '') return browser('The prompt is empty.');
  if (prompt.includes('\0')) return browser('The prompt contains a NUL character, which a command line cannot carry.');
  if (/^\s*-/.test(prompt)) return browser('The prompt starts with a dash, so the CLI would read it as an option instead of a task.');
  if (cmd && /["%\r\n]/.test(prompt)) {
    return browser('Claude is started through a Windows .cmd launcher, which cannot pass a quote, a percent sign or a line break safely. The native claude.exe does not have this limit.');
  }
  const size = (cmd || windows || ctx.wsl) ? chars : bytes;
  if (size > limit) {
    return browser(`The prompt is ${size.toLocaleString('en-US')} ${cmd || windows || ctx.wsl ? 'characters' : 'bytes'} and a command line on this computer takes at most ${limit.toLocaleString('en-US')}.`);
  }
  return { method: 'argv', reason: null, chars, bytes, argvLimitChars: limit };
}
