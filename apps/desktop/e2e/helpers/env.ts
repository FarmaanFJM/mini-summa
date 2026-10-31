// Where things live, for the acceptance suite. Nothing here touches the disk.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.resolve(E2E_DIR, '..');
export const REPO_ROOT = path.resolve(APP_DIR, '../..');

/** Everything a run produces (JSON results, evidence, failure artifacts). Git-ignored; docs/ACCEPTANCE.md is the committed summary. */
export const RESULTS_DIR = path.join(E2E_DIR, 'results');
export const META_FILE = path.join(RESULTS_DIR, 'meta.json');
export const ARTIFACTS_DIR = path.join(RESULTS_DIR, 'artifacts');
export const JSON_RESULTS_FILE = path.join(RESULTS_DIR, 'vitest-results.json');
/** One line per finished run, appended by e2e/run.mjs. The only file in the results directory that survives into the next run. */
export const HISTORY_FILE = path.join(RESULTS_DIR, 'runs.jsonl');

/** The built app tree that the tests launch. Set by global setup (a private build), or by the caller to reuse a build. */
export const APP_DIR_ENV = 'MINISUMMA_E2E_APP_DIR';

/** The behaviours the suite must account for, in order. A behaviour with no test in the results is reported NOT TESTED. */
export const BEHAVIOURS_FILE = path.join(E2E_DIR, 'behaviours.json');
