// The one way a test is declared in this suite. Wraps `it` so that every test, whatever it checks, also proves the
// guarantees that hold for the whole suite, and always cleans up after itself:
//
//   * nothing was sent to any host except the chatgpt.com stand-in, and nothing but GET requests ever reached it
//     (Mini-Summa never submits anything to ChatGPT);
//   * the decoy `claude` on PATH was never started (the real Claude CLI is never run);
//   * the window had no uncaught exception;
//   * every process the app started is killed and the sandbox is deleted.
//
// A failed test keeps a screenshot, the app's output and the logs under e2e/results/artifacts/.
import path from 'node:path';
import { expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { cleanupAll, decoyClaudeStarted, liveHandles, saveArtifacts } from './app.ts';
import { ARTIFACTS_DIR } from './env.ts';

export interface ScenarioOptions {
  /** Milliseconds for the whole test. Generous but finite. */
  timeout?: number;
}

const slug = (name: string): string => name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export function scenario(name: string, body: (ctx: TestContext) => Promise<void>, options: ScenarioOptions = {}): void {
  it(name, { timeout: options.timeout ?? 120_000 }, async (ctx) => {
    try {
      await body(ctx);
      const decoys = decoyClaudeStarted();
      expect(decoys, 'the decoy claude on PATH was started: the app looked for Claude on PATH instead of using the fake').toEqual([]);
      for (const handle of liveHandles()) {
        expect(handle.standIn.strays().map((r) => `${r.method} ${r.host}${r.path}`), 'requests for a host other than chatgpt.com reached the stand-in').toEqual([]);
        expect(handle.standIn.submissions().map((r) => `${r.method} ${r.path}`), 'something other than GET reached the ChatGPT stand-in (Mini-Summa must never submit)').toEqual([]);
        expect(handle.pageErrors.filter((e) => e.startsWith('pageerror')), 'uncaught exceptions in the window').toEqual([]);
      }
    } catch (error) {
      // A test that declares itself NOT TESTED (ctx.skip) is not a failure: no artifacts for it.
      if ((error as { code?: string }).code !== 'VITEST_PENDING') await saveArtifacts(path.join(ARTIFACTS_DIR, slug(name))).catch(() => undefined);
      throw error;
    } finally {
      await cleanupAll();
    }
  });
}
