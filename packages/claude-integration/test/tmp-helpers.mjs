import fs from 'node:fs';
import path from 'node:path';
import { root } from './helpers.mjs';

// A scratch directory under <package>/.tmp-tests (git-ignored and skipped by the publish guard) that is removed when
// the test that asked for it ends. Tests added in the monorepo use this so they leave nothing behind.
export function tmpDir(t, prefix) {
  const base = path.join(root, '.tmp-tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
