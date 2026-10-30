import { defineConfig } from 'vitest/config';

// The Electron acceptance suite. Run it under Xvfb:  xvfb-run -a npm run e2e   (npm run e2e does that by itself when it has to).
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    // Builds the app into a private directory once, and checks the display.
    globalSetup: ['e2e/helpers/global-setup.ts'],
    setupFiles: ['e2e/helpers/setup.ts'],
    // Each test launches a whole Electron app and a PTY: generous, but finite.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One app at a time. No retries: a flaky test is a bug in the test or in the product, not something to hide.
    pool: 'forks',
    fileParallelism: false,
    retry: 0,
    reporters: ['default', 'json'],
    outputFile: { json: 'e2e/results/vitest-results.json' },
  },
});
