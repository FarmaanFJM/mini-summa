// What the installed Claude CLI can do, read from the CLI itself: `claude --version`, `claude --help` and `claude auth status`.
// Nothing is assumed from the version number alone, because the flag is what matters. No credential is read: `auth status` is the
// CLI's own report, and Mini-Summa only looks at whether it says "logged in".
import type { CommandRunner } from '../claude/commandRunner.ts';
import type { ClaudeCommand } from '../claude/ptyHost.ts';

export interface CliProbe {
  found: boolean;
  version: string | null;
  cloudFlag: boolean;
  problem: string | null;
  auth: { state: 'logged_in' | 'logged_out' | 'unknown'; method: string | null; note: string | null };
}

export function parseVersion(out: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  return m ? m[1] : null;
}

/** `--cloud [description|session_id|url]` appears in the help of a CLI that has the feature. */
export function helpHasCloud(help: string): boolean {
  return /--cloud\b/.test(help);
}

export function parseAuthStatus(stdout: string, code: number | null): CliProbe['auth'] {
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      const j = JSON.parse(stdout.slice(start)) as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
      if (j.loggedIn === true) {
        const provider = typeof j.apiProvider === 'string' ? j.apiProvider : null;
        const method = typeof j.authMethod === 'string' ? j.authMethod : null;
        const note = provider && provider !== 'firstParty'
          ? `Claude Code is configured for ${provider}. Cloud sessions need a claude.ai account; Bedrock, Vertex and Foundry are not supported.`
          : method === 'api_key' || method === 'apiKey'
            ? 'Claude Code is using an API key. Cloud sessions need a claude.ai subscription login.'
            : null;
        return { state: 'logged_in', method, note };
      }
      if (j.loggedIn === false) return { state: 'logged_out', method: null, note: 'Claude Code is not signed in. Run claude in a terminal and use /login.' };
    } catch { /* unreadable */ }
  }
  return { state: 'unknown', method: null, note: code === 0 ? 'Claude Code printed a login status Mini-Summa does not understand.' : 'Claude Code could not report its login status.' };
}

export async function probeCli(run: CommandRunner, command: ClaudeCommand | null, env?: Record<string, string>): Promise<CliProbe> {
  const none = { state: 'unknown' as const, method: null, note: null };
  if (!command) return { found: false, version: null, cloudFlag: false, problem: 'Claude Code was not found on this computer. Install it from code.claude.com, then try again.', auth: none };
  const call = (args: string[], timeoutMs: number) => run(command.file, [...command.prefixArgs, ...args], { timeoutMs, env });
  const ver = await call(['--version'], 15_000);
  if (ver.code !== 0) {
    return { found: false, version: null, cloudFlag: false, problem: `Claude Code did not start (${ver.error ?? (ver.stderr.trim().slice(0, 160) || `exit code ${String(ver.code)}`)}).`, auth: none };
  }
  const version = parseVersion(ver.stdout);
  const help = await call(['--help'], 20_000);
  const cloudFlag = help.code === 0 && helpHasCloud(help.stdout);
  const auth = await call(['auth', 'status'], 20_000);
  return {
    found: true, version, cloudFlag,
    problem: cloudFlag ? null : `This Claude Code${version ? ` (${version})` : ''} has no --cloud option. Update it with claude update, then try again.`,
    auth: parseAuthStatus(auth.stdout, auth.code),
  };
}
