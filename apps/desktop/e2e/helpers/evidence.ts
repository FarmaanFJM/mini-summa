// How a test tells the report generator what it saw, and how a test says "I could not run this here".
//
// Both go to append-only files in the results folder (the vitest JSON reporter does not carry them). The files are written
// from the test worker process; the generator (e2e/report.mjs) joins them to the JSON results by behaviour id.
import fs from 'node:fs';
import type { TestContext } from 'vitest';
import { EVIDENCE_FILE, NOT_TESTED_FILE, RESULTS_DIR } from './env.ts';

const ID = /^\[([A-Z]+\d*)\]/;

/** "[A06] Claude Code launches ..." -> "A06" */
export function behaviourOf(title: string): string | null {
  return ID.exec(title)?.[1] ?? null;
}

function append(file: string, record: unknown): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** One short line of what was actually observed. Shown next to the behaviour in docs/ACCEPTANCE.md. Never put a secret in it. */
export function evidence(id: string, text: string): void {
  append(EVIDENCE_FILE, { id, text: text.replace(/\s+/g, ' ').trim() });
}

/**
 * The test could not execute the behaviour (or the part of it named here) in this environment. Records why and skips the
 * test: the report shows NOT TESTED with this reason, never PASS.
 */
export function notTested(ctx: TestContext, id: string, reason: string): never {
  append(NOT_TESTED_FILE, { id, test: ctx.task.name, reason: reason.replace(/\s+/g, ' ').trim() });
  ctx.skip(reason);
  throw new Error('unreachable');
}
