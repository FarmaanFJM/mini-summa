import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The headless runner must stop its terminals on every signal a console can deliver. SIGHUP is what Windows sends when the console
// window is closed and SIGBREAK is Ctrl+Break; SIGTERM never arrives there. Here SIGHUP is sent on Linux as the stand-in (SIMULATED:
// Windows delivers it through the console control handler, which this test cannot exercise).
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function stopWith(signal: NodeJS.Signals): Promise<{ code: number | null; stderr: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cli-'));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, '--data-dir', dataDir, '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MINI_SUMMA_CLAUDE_BIN: '' } });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the runner did not start: ${stderr}`)), 60_000);
      child.stderr.on('data', (d: string) => { stderr += d; if (stderr.includes('listening on')) { clearTimeout(timer); resolve(); } });
      child.on('exit', () => { clearTimeout(timer); reject(new Error(`the runner exited early: ${stderr}`)); });
    });
    await ready;
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code))); // 'close': stderr is fully read
    child.kill(signal);
    const code = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000))]);
    if (code === null) child.kill('SIGKILL');
    return { code, stderr };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('the headless runner stops cleanly on', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('%s', async (signal) => {
    const { code, stderr } = await stopWith(signal);
    expect(stderr).toContain(`Stopping on ${signal}`);
    expect(code).toBe(0);
  }, 120_000);
});
