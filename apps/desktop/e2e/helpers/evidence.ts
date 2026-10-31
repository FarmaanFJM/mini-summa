// How a test tells the report generator what it saw, and how a test says "I could not run this here".
//
// Both are stored in the test's own `meta`, which the vitest JSON reporter writes next to the test's status. The generator
// (e2e/report.mjs) therefore needs nothing but that one JSON file.
import { TestRunner } from 'vitest';
import type { TestContext } from 'vitest';

const ID = /^\[([A-Z]+\d*)\]/;

/** "[A06] Claude Code launches ..." -> "A06" */
export function behaviourOf(title: string): string | null {
  return ID.exec(title)?.[1] ?? null;
}

interface E2EMeta { evidence?: string[]; notTested?: string }

function meta(): E2EMeta {
  const test = TestRunner.getCurrentTest();
  if (!test) throw new Error('evidence() must be called while a test is running.');
  return test.meta as E2EMeta;
}

/** One short line of what was actually observed. Shown next to the behaviour in docs/ACCEPTANCE.md. Never put a secret in it. */
export function evidence(_id: string, text: string): void {
  const m = meta();
  (m.evidence ??= []).push(text.replace(/\s+/g, ' ').trim());
}

/**
 * The test could not execute the behaviour (or the part of it named here) in this environment. Records why and skips the
 * test: the report shows NOT TESTED with this reason, never PASS.
 */
export function notTested(ctx: TestContext, _id: string, reason: string): never {
  (ctx.task.meta as E2EMeta).notTested = reason.replace(/\s+/g, ' ').trim();
  ctx.skip(reason);
  throw new Error('unreachable');
}
