// @vitest-environment node
//
// SIMULATED: Windows refuses a rename (EPERM, EBUSY, EACCES) while an antivirus scan, the indexer or a log viewer holds the file.
// Nothing here ran on Windows; the refusals are produced by an injected `rename`, and the pauses by an injected `pause`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RETRIES, isRenameRefusal, renameSyncWithRetry } from '../../src/main/fsRetry.ts';
import { createFileLogger } from '../../src/main/log.ts';
import { loadWindowState, saveWindowState } from '../../src/main/windowState.ts';

const refusal = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename refused`), { code });
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-retry-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A rename that is refused `times` times, then really renames. */
const refusedThenFine = (times: number, code = 'EBUSY') => {
  let calls = 0;
  const rename = vi.fn((from: string, to: string) => {
    calls += 1;
    if (calls <= times) throw refusal(code);
    fs.renameSync(from, to);
  });
  return rename;
};

describe('renameSyncWithRetry', () => {
  it('knows which refusals are Windows file-lock refusals, and no others', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) expect(isRenameRefusal(refusal(code))).toBe(true);
    for (const code of ['ENOENT', 'EISDIR', 'ENOTEMPTY', 'EXDEV', 'ENOSPC']) expect(isRenameRefusal(refusal(code))).toBe(false);
    expect(isRenameRefusal(new Error('plain'))).toBe(false);
    expect(isRenameRefusal(undefined)).toBe(false);
  });

  it('retries a refusal with pauses of 15 ms, doubling, and then succeeds', () => {
    const pause = vi.fn();
    const rename = vi.fn()
      .mockImplementationOnce(() => { throw refusal('EPERM'); })
      .mockImplementationOnce(() => { throw refusal('EBUSY'); })
      .mockImplementationOnce(() => { throw refusal('EACCES'); })
      .mockImplementation(() => undefined);
    renameSyncWithRetry('a', 'b', { rename, pause });
    expect(rename).toHaveBeenCalledTimes(4);
    expect(pause.mock.calls.map((c) => c[0])).toEqual([15, 30, 60]);
  });

  it('gives up after the bounded number of tries and throws the last refusal', () => {
    const pause = vi.fn();
    const rename = vi.fn(() => { throw refusal('EBUSY'); });
    expect(() => renameSyncWithRetry('a', 'b', { rename, pause })).toThrow(/EBUSY/);
    expect(DEFAULT_RETRIES).toBe(6);
    expect(rename).toHaveBeenCalledTimes(DEFAULT_RETRIES + 1);
    expect(pause.mock.calls.map((c) => c[0])).toEqual([15, 30, 60, 120, 240, 480]);
  });

  it('honours a smaller bound', () => {
    const pause = vi.fn();
    const rename = vi.fn(() => { throw refusal('EPERM'); });
    expect(() => renameSyncWithRetry('a', 'b', { rename, pause, retries: 2 })).toThrow(/EPERM/);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('does not retry any other error', () => {
    const pause = vi.fn();
    const rename = vi.fn(() => { throw refusal('ENOENT'); });
    expect(() => renameSyncWithRetry('a', 'b', { rename, pause })).toThrow(/ENOENT/);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it('really pauses (without a seam) for no longer than the schedule says', () => {
    const rename = vi.fn()
      .mockImplementationOnce(() => { throw refusal('EBUSY'); })
      .mockImplementation(() => undefined);
    const started = Date.now();
    renameSyncWithRetry('a', 'b', { rename });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('the window state file (defect: a refused rename lost the save)', () => {
  const state = { x: 10, y: 20, width: 1200, height: 800, maximized: false };

  it('is saved after the rename was refused twice', () => {
    const file = path.join(tmp(), 'window-state.json');
    const rename = refusedThenFine(2, 'EPERM');
    expect(saveWindowState(file, state, { rename, pause: () => undefined })).toBe(true);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(loadWindowState(file)).toEqual(state);
  });

  it('is not saved when the file stays locked, and no temporary file is left beside it', () => {
    const dir = tmp();
    const file = path.join(dir, 'window-state.json');
    fs.writeFileSync(file, JSON.stringify({ ...state, width: 999 }));
    const rename = vi.fn(() => { throw refusal('EBUSY'); });
    expect(saveWindowState(file, state, { rename, pause: () => undefined })).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['window-state.json']);
    expect(loadWindowState(file)?.width).toBe(999); // the old state is intact
  });

  it('still saves normally', () => {
    const file = path.join(tmp(), 'sub', 'window-state.json');
    expect(saveWindowState(file, state)).toBe(true);
    expect(loadWindowState(file)).toEqual(state);
  });
});

describe('log rotation (defect: a refused rename lost every later line)', () => {
  it('rotates after the rename was refused once, and loses no line', () => {
    const dir = tmp();
    const rename = refusedThenFine(1, 'EBUSY');
    const log = createFileLogger(dir, { maxBytes: 400, rename, pause: () => undefined });
    for (let i = 0; i < 30; i += 1) log.info(`line ${i} ${'x'.repeat(40)}`);
    expect(rename).toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'main.1.log'))).toBe(true);
    const text = fs.readFileSync(path.join(dir, 'main.1.log'), 'utf8') + fs.readFileSync(log.file, 'utf8');
    for (let i = 0; i < 30; i += 1) expect(text).toContain(`line ${i} `);
  });

  it('keeps every line while the file stays locked, and does not hammer the rename on every line', () => {
    const dir = tmp();
    const rename = vi.fn(() => { throw refusal('EPERM'); });
    const log = createFileLogger(dir, { maxBytes: 400, rename, pause: () => undefined });
    for (let i = 0; i < 200; i += 1) log.info(`line ${i} ${'x'.repeat(40)}`);
    expect(fs.readFileSync(log.file, 'utf8').trim().split('\n')).toHaveLength(200);
    // one attempt (1 + 3 retries) until another 256 KB of output has been written
    expect(rename).toHaveBeenCalledTimes(4);
  });
});
