// Against the real, installed Claude Code when there is one (skipped otherwise). Read-only: --version, --help, auth status and a
// non-interactive refusal. It never creates a cloud session and never sends a message.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCommandRunner } from '../../src/claude/commandRunner.ts';
import { probeCli } from '../../src/cloud/cliCapability.ts';

let claude: string | null = null;
try { claude = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0] || null; } catch { claude = null; }
const real = claude ? describe : describe.skip;

real('the installed Claude Code', () => {
  it('has --cloud in its help and reports a version', async () => {
    const probe = await probeCli(defaultCommandRunner, { file: claude!, prefixArgs: [], wslDistro: null });
    expect(probe.found).toBe(true);
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(probe.cloudFlag).toBe(true);
    expect(['logged_in', 'logged_out', 'unknown']).toContain(probe.auth.state);
  }, 60_000);

  it('refuses to create a cloud session without a terminal, which is why a dispatch runs in a PTY', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-real-'));
    try {
      const r = await defaultCommandRunner(claude!, ['--cloud', 'noop'], { timeoutMs: 30_000 });
      expect(`${r.stdout}${r.stderr}`).toMatch(/not a cloud session ID or URL|TTY|interactive/i);
      const p = await defaultCommandRunner(claude!, ['-p', 'noop', '--cloud'], { timeoutMs: 30_000 });
      expect(`${p.stdout}${p.stderr}`).toMatch(/cannot be combined with --print/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
