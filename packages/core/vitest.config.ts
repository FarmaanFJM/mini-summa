import { defineConfig } from 'vitest/config';

/**
 * Files that cannot run on a Windows host yet because they drive a POSIX shell-script fake `claude` / `tailscale`, POSIX signals,
 * POSIX file modes or a "posix" project environment, which a Windows host reports as unavailable. They are skipped ONLY when the
 * suite runs on Windows (they all run on Linux), and each skip is listed in docs/WINDOWS_CI.md as UNTESTED ON WINDOWS. Nothing
 * here is evidence that the behaviour works on Windows. Porting the fakes to a Node script behind a .cmd shim is the follow-up.
 */
const POSIX_FIXTURE_FILES = [
  'test/infra/tailscale-ownership.test.ts',
  'test/claude/observer-environments.test.ts',
  'test/claude/observer-ingestion.test.ts',
  'test/claude/observer-integration.test.ts',
  'test/claude/observer-discovery.test.ts',
  'test/claude/observer-continuation.test.ts',
  'test/claude/managed-fake-claude.test.ts',
  'test/claude/managed-lifecycle.test.ts',
  'test/claude/managed-settings.test.ts',
  'test/cli-signals.test.ts',
];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.platform === 'win32' ? ['**/node_modules/**', ...POSIX_FIXTURE_FILES] : ['**/node_modules/**'],
    environment: 'node', testTimeout: 30_000, hookTimeout: 30_000, pool: 'forks',
  },
});
