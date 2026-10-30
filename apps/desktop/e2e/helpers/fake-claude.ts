// The fake Claude Code CLI (packages/core/src/testing/fake-claude): it runs the REAL hook command from the --settings file
// the core hands it, so hooks, spool, ingestion and reports are the real thing. This suite never starts the real `claude`.
import fs from 'node:fs';
import path from 'node:path';
import {
  directive, FAKE_CLAUDE_SCRIPT, readHookRuns, readLiveFiles, readReceived, readTerminalSize,
} from '../../../../packages/core/src/testing/fake-claude/index.ts';

export { directive, readHookRuns, readLiveFiles, readReceived, readTerminalSize };

/**
 * The `claude` that MINISUMMA_CLAUDE_BIN points at: a shell wrapper that runs the fake with its state directory. The node
 * binary is named by absolute path, so the wrapper needs nothing from PATH.
 */
export function writeClaudeWrapper(binDir: string, stateDir: string, knobs: Record<string, string> = {}): string {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'fake-claude');
  const exports = Object.entries(knobs).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(file, `#!/bin/sh\n${exports}${exports ? '\n' : ''}exec "${process.execPath}" "${FAKE_CLAUDE_SCRIPT}" --fake-state-dir "${stateDir}" "$@"\n`, { mode: 0o755 });
  return file;
}

/**
 * A `claude` that is first on PATH and records that it was started. The app is told which Claude to use through the
 * MINISUMMA_CLAUDE_BIN seam, so this must never run; if the app ever looked on PATH instead, the marker file would say so
 * and the test would fail instead of starting the real, authenticated CLI that may be installed on this machine.
 */
export function writeDecoyClaude(binDir: string, marker: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\necho "decoy claude started with: $*" >> "${marker}"\nexit 97\n`, { mode: 0o755 });
  return file;
}

/** Each fake session writes its registration here while it runs: the cwd and pid of the process, as the process sees them. */
export function liveSessionsOf(stateDir: string): { pid: number; cwd: string; sessionId: string; status: string }[] {
  return readLiveFiles(stateDir).map((e) => ({ pid: e.pid, cwd: e.cwd, sessionId: e.sessionId, status: e.status }));
}

export const isRunning = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
