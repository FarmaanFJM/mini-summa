// The words of the four feature areas follow the house rules, checked on the source so no screen can slip through.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src/renderer/src');
const FOLDERS = ['features/reports', 'features/activity', 'features/settings', 'features/onboarding'];
const EXTRA = ['dev/demo/features-handlers.ts', 'dev/demo/features-seed.ts'];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const files = [...FOLDERS.flatMap((f) => walk(path.join(SRC, f))), ...EXTRA.map((f) => path.join(SRC, f))].filter((f) => /\.(tsx?|css)$/.test(f));

describe('the source of the feature areas', () => {
  it('covers every file of the four areas', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('has no em dash and no en dash anywhere, in copy or in comments', () => {
    const offenders = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f: path.relative(SRC, f), line: i + 1, text: line })).filter((l) => /[–—]/.test(l.text)));
    expect(offenders).toEqual([]);
  });

  it('has no border-left decoration (an accent stripe on one edge)', () => {
    const offenders = files.filter((f) => f.endsWith('.css')).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f: path.relative(SRC, f), line: i + 1, text: line.trim() })).filter((l) => /border-left\s*:\s*[^;]*\b(solid|[1-9]\d*px)/.test(l.text)));
    expect(offenders).toEqual([]);
  });

  it('keeps every made-up email address in the demo data and the tests on an example domain', () => {
    const tests = fs.readdirSync(__dirname).filter((f) => /^features-.*\.tsx?$/.test(f)).map((f) => path.join(__dirname, f));
    const found = [...files, ...tests].flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)].map((m) => ({ f: path.basename(f), address: m[0], domain: m[1] })));
    expect(found.length).toBeGreaterThan(0); // the fixtures do use some, so the scan is looking at something
    expect(found.filter((a) => !/^example\./i.test(a.domain))).toEqual([]);
  });

  it('never says a report was "completed": Claude declares, nothing here has verified it', () => {
    const offenders = files.filter((f) => /\.tsx?$/.test(f) && !/dev\/demo/.test(f)).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f: path.relative(SRC, f), line: i + 1, text: line.trim() })).filter((l) => /['"`>][^'"`<]*\bcompleted\b/i.test(l.text) && !/^(\/\/|\/\*|\*)/.test(l.text)));
    expect(offenders).toEqual([]);
  });
});
