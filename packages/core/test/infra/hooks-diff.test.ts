import { describe, expect, it } from 'vitest';
import { joinHost, unifiedDiff } from '../../src/infra/hooks.ts';

const lines = (n: number, prefix = 'line'): string => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

describe('unifiedDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'f')).toBe('');
    expect(unifiedDiff('', '', 'f')).toBe('');
  });

  it('shows a new file against /dev/null', () => {
    expect(unifiedDiff('', '{\n  "a": 1\n}\n', '/x/settings.json', { created: true })).toBe(
      '--- /dev/null\n+++ /x/settings.json\n@@ -0,0 +1,3 @@\n+{\n+  "a": 1\n+}\n');
  });

  it('shows an addition with three lines of context on both sides', () => {
    const before = lines(10);
    const after = before.replace('line 5\n', 'line 5\nINSERTED\n');
    expect(unifiedDiff(before, after, 'f')).toBe([
      '--- f', '+++ f', '@@ -3,6 +3,7 @@',
      ' line 3', ' line 4', ' line 5', '+INSERTED', ' line 6', ' line 7', ' line 8', '',
    ].join('\n'));
  });

  it('shows a removal and a replacement', () => {
    const before = lines(8);
    expect(unifiedDiff(before, before.replace('line 4\n', ''), 'f')).toBe([
      '--- f', '+++ f', '@@ -1,7 +1,6 @@',
      ' line 1', ' line 2', ' line 3', '-line 4', ' line 5', ' line 6', ' line 7', '',
    ].join('\n'));
    expect(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f')).toBe(['--- f', '+++ f', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', ''].join('\n'));
  });

  it('merges changes closer than twice the context into one hunk and splits distant ones', () => {
    const before = lines(30);
    const near = before.replace('line 5\n', 'X\n').replace('line 11\n', 'Y\n'); // 5 unchanged lines between
    expect(unifiedDiff(before, near, 'f').match(/^@@/gm)).toHaveLength(1);
    const far = before.replace('line 5\n', 'X\n').replace('line 20\n', 'Y\n');
    const d = unifiedDiff(before, far, 'f');
    expect(d.match(/^@@/gm)).toHaveLength(2);
    expect(d).toContain('@@ -2,7 +2,7 @@');
    expect(d).toContain('@@ -17,7 +17,7 @@');
  });

  it('uses the least number of changed lines (LCS), not a block replace', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nc\nd\nX\ne\n';
    const d = unifiedDiff(before, after, 'f');
    expect(d.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l))).toEqual(['-b', '+X']);
  });

  it('marks a missing newline at the end of the file on the side that lacks it', () => {
    expect(unifiedDiff('a\nb', 'a\nb\n', 'f')).toBe(['--- f', '+++ f', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', ''].join('\n'));
    expect(unifiedDiff('a\nb\n', 'a\nb', 'f')).toBe(['--- f', '+++ f', '@@ -1,2 +1,2 @@', ' a', '-b', '+b', '\\ No newline at end of file', ''].join('\n'));
  });

  it('shows a change in line endings', () => {
    const d = unifiedDiff('a\nb\n', 'a\r\nb\r\n', 'f');
    expect(d).toContain('-a');
    expect(d).toContain('+a\r');
  });

  it('handles removing everything and large replacements', () => {
    expect(unifiedDiff('a\nb\n', '', 'f')).toBe(['--- f', '+++ f', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n'));
    const big1 = lines(3000, 'old');
    const big2 = lines(3000, 'new');
    const d = unifiedDiff(big1, big2, 'f');
    expect(d.split('\n').filter((l) => l.startsWith('-old')).length).toBe(3000);
    expect(d.split('\n').filter((l) => l.startsWith('+new')).length).toBe(3000);
  });

  it('honours a different amount of context', () => {
    const before = lines(10);
    const d = unifiedDiff(before, before.replace('line 5\n', 'X\n'), 'f', { context: 1 });
    expect(d).toContain('@@ -4,3 +4,3 @@');
  });
});

describe('joinHost', () => {
  it('joins Windows paths the Windows way and everything else the POSIX way', () => {
    expect(joinHost('C:\\Users\\me\\.claude', 'settings.json')).toBe('C:\\Users\\me\\.claude\\settings.json');
    expect(joinHost('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude', 'settings.json')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\settings.json');
    expect(joinHost('/home/me/.claude', 'settings.json')).toBe('/home/me/.claude/settings.json');
  });
});
