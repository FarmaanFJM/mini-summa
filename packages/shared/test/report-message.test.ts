import { describe, expect, it } from 'vitest';
import { buildReportMessage, joinPayloads, splitMessage, fenceBegin, fenceEnd } from '../src/index.ts';

const base = { reportId: 'abcdef0123456789', projectName: 'GitManager', taskTitle: 'Fix login', sessionRef: 'a1b2c3d4, managed, Windows, generation 1',
  declaredStatus: 'complete' as const, capturedAt: '2026-10-30T10:00:00.000Z', reviewRequest: 'Please review.' };

describe('buildReportMessage', () => {
  it('carries the body verbatim between unique fences', () => {
    const body = '## Implementation Report\n\n  indented  line\n\ttab\n--- END ---\n```ts\nconst x = 1;\n```\n<!-- mini-summa:report status=complete task="Fix login" -->';
    const msg = buildReportMessage({ ...base, body });
    expect(msg).toContain(`${fenceBegin(base.reportId)}\n${body}\n${fenceEnd(base.reportId)}`);
    expect(msg).toContain('Project: GitManager');
    expect(msg).toContain('Task: Fix login');
    expect(msg).toContain('Claude session: a1b2c3d4, managed, Windows, generation 1');
    expect(msg.endsWith('Please review.')).toBe(true);
  });

  it('can omit the session reference and the review request', () => {
    const msg = buildReportMessage({ ...base, body: 'x', reviewRequest: null, includeSessionRef: false });
    expect(msg).not.toContain('Claude session:');
    expect(msg.trimEnd().endsWith(fenceEnd(base.reportId))).toBe(true);
  });

  it('says the declared status is not verified', () => {
    expect(buildReportMessage({ ...base, body: 'x' })).toMatch(/not verified/);
  });
});

describe('splitMessage', () => {
  it('returns one part unchanged when it fits', () => {
    const parts = splitMessage('short', base.reportId, 12000);
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe('short');
  });

  it('is lossless for awkward input at many limits', () => {
    const rnd = mulberry(42);
    const alphabet = ['a', 'b', ' ', '\n', '\r\n', '\t', '😀', '𝒳', 'é', '漢', '\u0000', '<!--', '-->'];
    for (let trial = 0; trial < 60; trial++) {
      let text = '';
      const len = 2500 + Math.floor(rnd() * 30000);
      while (text.length < len) text += alphabet[Math.floor(rnd() * alphabet.length)].repeat(1 + Math.floor(rnd() * 8));
      const limit = 2000 + Math.floor(rnd() * 9000);
      const parts = splitMessage(text, base.reportId, limit);
      expect(joinPayloads(parts)).toBe(text);
      expect(parts.map((p) => p.index)).toEqual(parts.map((_, i) => i + 1));
      for (const p of parts) {
        expect(p.text.length).toBeLessThanOrEqual(limit);
        expect(p.total).toBe(parts.length);
        // never cut a surrogate pair in half
        const first = p.payload.charCodeAt(0); const last = p.payload.charCodeAt(p.payload.length - 1);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });

  it('labels every part and tells the reader when it is complete', () => {
    const text = ('line of report text\n').repeat(900);
    const parts = splitMessage(text, base.reportId, 4000);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[0].text.startsWith(`[Mini-Summa report abcdef01, part 1 of ${parts.length}]`)).toBe(true);
    expect(parts[0].text).toMatch(/More parts follow/);
    expect(parts[parts.length - 1].text).toMatch(/complete report/);
  });
});

function mulberry(seed: number) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
