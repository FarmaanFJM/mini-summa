import { describe, expect, it } from 'vitest';
import { DEFAULT_SCROLLBACK_CHARS, ScrollbackBuffer } from '../../src/claude/ptyHost.ts';

describe('ScrollbackBuffer', () => {
  it('numbers chunks 1, 2, 3... and replays them in order', () => {
    const b = new ScrollbackBuffer(1000);
    expect(b.snapshot()).toEqual({ data: '', seq: 0 });
    expect(b.append('hello ')).toBe(1);
    expect(b.append('world')).toBe(2);
    expect(b.snapshot()).toEqual({ data: 'hello world', seq: 2 });
    expect(b.seq).toBe(2);
    expect(b.size).toBe(11);
  });

  it('does not turn empty output into a chunk', () => {
    const b = new ScrollbackBuffer(1000);
    expect(b.append('')).toBe(0);
    b.append('a');
    expect(b.append('')).toBe(1);
    expect(b.snapshot().seq).toBe(1);
  });

  it('drops whole chunks from the FRONT when the bound is exceeded, and never cuts a chunk', () => {
    const b = new ScrollbackBuffer(10_000);
    const chunks = Array.from({ length: 50 }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(1000));
    for (const c of chunks) b.append(c);
    const snap = b.snapshot();
    expect(b.size).toBeLessThanOrEqual(10_000);
    expect(snap.data.length).toBe(b.size);
    // what is left is exactly the newest chunks, each complete
    const kept = snap.data.length / 1000;
    expect(Number.isInteger(kept)).toBe(true);
    expect(snap.data).toBe(chunks.slice(chunks.length - kept).join(''));
    expect(kept).toBe(10);
    expect(snap.data.startsWith(chunks[40])).toBe(true);
    expect(snap.data.endsWith(chunks[49])).toBe(true);
  });

  it('keeps seq counting up across drops, so a client can tell what it has already seen', () => {
    const b = new ScrollbackBuffer(100);
    let last = 0;
    for (let i = 0; i < 400; i++) {
      const seq = b.append('x'.repeat(30));
      expect(seq).toBe(last + 1);
      last = seq;
    }
    expect(b.snapshot().seq).toBe(400);
    expect(b.size).toBeLessThanOrEqual(100);
  });

  it('holds about 2,000,000 characters by default', () => {
    expect(DEFAULT_SCROLLBACK_CHARS).toBe(2_000_000);
    const b = new ScrollbackBuffer();
    const chunk = 'y'.repeat(65_536);
    for (let i = 0; i < 100; i++) b.append(chunk); // 6.5 million characters
    expect(b.size).toBeLessThanOrEqual(2_000_000);
    expect(b.size).toBeGreaterThan(2_000_000 - 65_536);
    expect(b.snapshot().data.length).toBe(b.size);
  });

  it('keeps a single chunk that is larger than the bound whole until the next chunk arrives', () => {
    const b = new ScrollbackBuffer(10);
    b.append('A'.repeat(25));
    expect(b.snapshot().data).toBe('A'.repeat(25));
    b.append('B');
    expect(b.snapshot()).toEqual({ data: 'B', seq: 2 });
  });

  it('stays correct while its internal array is compacted', () => {
    const b = new ScrollbackBuffer(50);
    const all: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const c = `[${i}]`;
      all.push(c);
      b.append(c);
    }
    const data = b.snapshot().data;
    expect(data.length).toBeLessThanOrEqual(50);
    expect(data.endsWith('[2999]')).toBe(true);
    expect(all.join('').endsWith(data)).toBe(true);
  });

  it('rejects a bound that is not a positive integer', () => {
    expect(() => new ScrollbackBuffer(0)).toThrow(RangeError);
    expect(() => new ScrollbackBuffer(1.5)).toThrow(RangeError);
  });
});
