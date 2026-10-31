// @vitest-environment node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Found by the first run on a real Windows runner: ui/Popover.tsx and ui/popover.ts (and HandoffStrip.tsx / handoffStrip.ts) are two
// files on Linux but one name on Windows and macOS, so an import of './Popover' could bind to the wrong file or fail the build.
describe('file names on a case-insensitive file system', () => {
  it('no two tracked files differ only in letter case, or only in case and a source extension', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const exact = new Map<string, string[]>();
    const stems = new Map<string, string[]>();
    for (const f of files) {
      exact.set(f.toLowerCase(), [...(exact.get(f.toLowerCase()) ?? []), f]);
      if (/\.(m?[jt]sx?|cjs)$/.test(f)) {
        const stem = f.replace(/\.[^./]+$/, '').toLowerCase();
        stems.set(stem, [...(stems.get(stem) ?? []), f]);
      }
    }
    const clash = [...exact.values(), ...stems.values()].filter((v) => v.length > 1);
    expect(clash).toEqual([]);
  });
});
