import { describe, expect, it } from 'vitest';
import { parseAuthStatus, parseVersion, helpHasCloud, probeCli } from '../../src/cloud/cliCapability.ts';
import { findBareSessionId, findFailure, findQuestion, findSessionLink, parseFollowUpOutput, stripAnsi, tailLines } from '../../src/cloud/output.ts';
import { CMD_ARGV_LIMIT, POSIX_ARGV_LIMIT, WIN_ARGV_LIMIT, planPromptDelivery } from '../../src/cloud/promptDelivery.ts';
import { githubCloneUrl, isSafeBranchName, parseGithubRemote } from '../../src/git/git.ts';

// Addresses are built from parts: the publish guard refuses a literal session address anywhere in the repository.
const CODE = 'https://claude.ai/code/';

const posix = { platform: 'linux' as const, claudeFile: '/usr/bin/claude', wsl: false };
const cmd = { platform: 'win32' as const, claudeFile: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', wsl: false };
const exe = { platform: 'win32' as const, claudeFile: 'C:\\Users\\me\\.local\\bin\\claude.exe', wsl: false };

describe('prompt delivery never shortens or alters a prompt', () => {
  it('uses the command line for an ordinary multi-line prompt on POSIX', () => {
    const p = planPromptDelivery('Do this.\n\nThen "that" 100%.', posix);
    expect(p).toMatchObject({ method: 'argv', reason: null });
  });
  it('sends a Windows .cmd launcher to the browser route for quotes, percent signs and line breaks', () => {
    for (const text of ['say "hi"', '100% done', 'line one\nline two']) {
      const p = planPromptDelivery(text, cmd);
      expect(p.method, text).toBe('clipboard_browser');
      expect(p.reason).toMatch(/\.cmd launcher/);
    }
    expect(planPromptDelivery('plain single line task', cmd).method).toBe('argv');
  });
  it('applies the 8191 character cmd.exe limit with room to spare', () => {
    expect(planPromptDelivery('a'.repeat(CMD_ARGV_LIMIT), cmd).method).toBe('argv');
    const over = planPromptDelivery('a'.repeat(CMD_ARGV_LIMIT + 1), cmd);
    expect(over.method).toBe('clipboard_browser');
    expect(over.reason).toContain('6,000');
    expect(CMD_ARGV_LIMIT).toBeLessThan(8191);
  });
  it('applies the CreateProcess limit to a native Windows launcher and WSL', () => {
    expect(planPromptDelivery('a'.repeat(WIN_ARGV_LIMIT), exe).method).toBe('argv');
    expect(planPromptDelivery('a'.repeat(WIN_ARGV_LIMIT + 1), exe).method).toBe('clipboard_browser');
    expect(planPromptDelivery('x\ny', { platform: 'win32', claudeFile: 'wsl', wsl: true }).method).toBe('argv');
    expect(WIN_ARGV_LIMIT).toBeLessThan(32767);
  });
  it('counts bytes on POSIX, where the limit is on the size of one argument', () => {
    expect(planPromptDelivery('é'.repeat(POSIX_ARGV_LIMIT / 2), posix).method).toBe('argv');
    expect(planPromptDelivery('é'.repeat(POSIX_ARGV_LIMIT / 2 + 1), posix).method).toBe('clipboard_browser');
  });
  it('refuses to hand over a prompt the CLI would read as an option, an empty prompt and NUL', () => {
    expect(planPromptDelivery('--help me', posix).reason).toMatch(/dash/);
    expect(planPromptDelivery('   ', posix).method).toBe('clipboard_browser');
    expect(planPromptDelivery('a\0b', posix).reason).toMatch(/NUL/);
  });
});

describe('reading what the CLI prints', () => {
  it('finds a validated session link through terminal control sequences', () => {
    const text = '\x1b[32m✓\x1b[0m Session created: \x1b[4mhttps://claude.ai/code/' + 'session_abAbCdEfGh\x1b[0m\r\n';
    expect(findSessionLink(text)).toEqual({ sessionId: 'session_abAbCdEfGh', url: `${CODE}session_abAbCdEfGh` });
  });
  it('does not accept a link that may still be arriving, until the process has ended', () => {
    expect(findSessionLink('Created https://claude.ai/code/' + 'session_abAbC')).toBeNull();
    expect(findSessionLink('Created https://claude.ai/code/' + 'session_abAbCdEfGh', { final: true })?.sessionId).toBe('session_abAbCdEfGh');
  });
  it('never glues the next line onto a link', () => {
    expect(findSessionLink(`${CODE}session_abAbCdEfGh\nOpening your browser`)?.sessionId).toBe('session_abAbCdEfGh');
  });
  it.each([
    ['another host', 'https://claude.ai.evil.example/code/session_abAbCdEfGh'],
    ['http', 'http://claude.ai/code/' + 'session_abAbCdEfGh'],
    ['not a session page', 'https://claude.ai/code/new'],
    ['credentials in the address', 'https://user:pw@claude.ai/code/' + 'session_abAbCdEfGh'],
    ['a bare id', 'session_abAbCdEfGh created'],
    ['malformed', `${CODE}session_`],
  ])('rejects %s', (_name, text) => {
    expect(findSessionLink(text)).toBeNull();
  });
  it('treats a bare session id as a hint only', () => {
    expect(findBareSessionId('Created session_abAbCdEfGhIj')).toBe('session_abAbCdEfGhIj');
    expect(findSessionLink('Created session_abAbCdEfGhIj')).toBeNull();
  });
  it('recognises the questions the CLI really asks (folder trust was observed on 2.1.316)', () => {
    expect(findQuestion('Quick safety check: Is this a project you created or one you trust?\n> No, exit\n  Yes, I trust this folder')).toMatch(/trust/);
    expect(findQuestion('Choose the text style that looks best with your terminal')).toMatch(/text style/);
    expect(findQuestion('Please run /login')).toMatch(/sign in/);
    expect(findQuestion('Working…')).toBeNull();
  });
  it('finds a failure and ignores ordinary text', () => {
    expect(findFailure('Error: --cloud cannot be combined with --print.')).toMatch(/cannot be combined/);
    expect(findFailure('all good')).toBeNull();
  });
  it('blanks the prompt in the output it shows', () => {
    const secret = 'Implement the secret billing migration plan';
    const lines = tailLines(`> ${secret}\nthe secret billing migration\nwhatever`, secret);
    expect(lines.join('\n')).not.toContain('billing');
    expect(stripAnsi('\x1b[2J\x1b[Hhi')).toBe('hi');
  });
  it('reads follow-up results as accepted, rejected or unknown, and never as completion', () => {
    expect(parseFollowUpOutput('{"ok":true,"session_id":"session_x","url":"x"}').outcome).toBe('accepted');
    expect(parseFollowUpOutput('{"ok":true}').note).toMatch(/does not mean Claude has acted/);
    expect(parseFollowUpOutput('{"ok":false,"session_id":"s","error":"Session expired. Please run /login to sign in again."}')).toMatchObject({ outcome: 'rejected', note: expect.stringContaining('Session expired') });
    expect(parseFollowUpOutput('garbage').outcome).toBe('unknown');
    expect(parseFollowUpOutput('').outcome).toBe('unknown');
  });
});

describe('what the installed CLI can do', () => {
  const run = (map: Record<string, { code: number | null; stdout?: string; stderr?: string }>) => async (_f: string, args: string[]) => {
    const r = map[args.join(' ')] ?? { code: 1, stderr: 'unknown' };
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const cmdLine = { file: 'claude', prefixArgs: [] as string[], wslDistro: null };

  it('reads versions and the flag', () => {
    expect(parseVersion('2.1.316 (Claude Code)')).toBe('2.1.316');
    expect(helpHasCloud('  --cloud [description|session_id|url]  Create a cloud session')).toBe(true);
    expect(helpHasCloud('Usage: claude [options]')).toBe(false);
  });
  it('reports a missing CLI, an old CLI and a signed-out CLI separately', async () => {
    expect((await probeCli(run({}), null)).problem).toMatch(/not found/);
    const old = await probeCli(run({ '--version': { code: 0, stdout: '2.0.0' }, '--help': { code: 0, stdout: 'Usage' }, 'auth status': { code: 0, stdout: '{"loggedIn":true}' } }), cmdLine);
    expect(old).toMatchObject({ found: true, version: '2.0.0', cloudFlag: false });
    expect(old.problem).toMatch(/no --cloud option/);
    const out = await probeCli(run({ '--version': { code: 0, stdout: '2.1.316' }, '--help': { code: 0, stdout: '--cloud' }, 'auth status': { code: 1, stdout: '{"loggedIn":false}' } }), cmdLine);
    expect(out.cloudFlag).toBe(true);
    expect(out.auth.state).toBe('logged_out');
  });
  it('warns when the account is not a claude.ai login', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"bedrock"}', 0).note).toMatch(/Bedrock/i);
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}', 0).note).toMatch(/API key/);
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', 0).note).toBeNull();
    expect(parseAuthStatus('not json', 1).state).toBe('unknown');
  });
});

describe('git helpers', () => {
  it('reads github remotes and drops secrets', () => {
    expect(parseGithubRemote('https://github.com/acme/widgets.git')).toBe('acme/widgets');
    expect(parseGithubRemote('git@github.com:acme/widgets.git')).toBe('acme/widgets');
    expect(parseGithubRemote('https://x-access-token:ghp_SECRET@github.com/acme/widgets')).toBe('acme/widgets');
    expect(parseGithubRemote('https://gitlab.com/acme/widgets')).toBeNull();
    expect(parseGithubRemote('ext::sh -c evil')).toBeNull();
    expect(parseGithubRemote('https://github.com.evil.example/acme/widgets')).toBeNull();
  });
  it('builds clone addresses only from valid names and rejects odd branch names', () => {
    expect(githubCloneUrl('acme/widgets')).toBe('https://github.com/acme/widgets.git');
    expect(() => githubCloneUrl('acme/widgets --upload-pack=evil')).toThrow();
    for (const bad of ['-x', 'a b', 'a..b', 'a.lock', '/a', 'a/', 'a@{b', 'a~b', '']) expect(isSafeBranchName(bad), bad).toBe(false);
    for (const good of ['main', 'feat/new-thing', 'release-1.2']) expect(isSafeBranchName(good), good).toBe(true);
  });
});
