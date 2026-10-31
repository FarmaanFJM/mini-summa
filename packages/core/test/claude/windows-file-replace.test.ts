// Replacing a file on Windows (audit item 4): a rename over an existing file is refused with EPERM or EBUSY while another program
// (an antivirus scan, the indexer, an editor) has the old file open. SIMULATED: the refusals are injected on Linux with the codes
// libuv gives the Windows errors. Nothing here ran on Windows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvLayout } from '../../src/contracts.ts';
import { renameSyncWithRetry } from '../../src/claude/fsRetry.ts';
import { writeFileAtomic } from '../../src/claude/registryFile.ts';
import { writeManagedSettings } from '../../src/claude/settingsFile.ts';

const SESSION = '3c2f1d7e-9a44-4f0a-8d9e-0a9b7c6d5e41';
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-replace-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const refusal = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code, syscall: 'rename' });
const layout: EnvLayout = {
  env: 'posix', spoolDirHost: '/data/spool/posix', registryFileHost: '/data/registry.json', spoolDirInEnv: '/data/spool/posix', registryFileInEnv: '/data/registry.json',
  captureScriptInEnv: '/opt/minisumma/capture.mjs', runtime: { command: '/usr/bin/node', runAsNode: false, version: 'v22.12.0' }, configDirHost: null, configDirInEnv: null,
};

/** Makes the next `n` renames fail with `code`, then lets them through. */
function refuseRenames(n: number, code: string): { calls: () => number } {
  const real = fs.renameSync.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    calls++;
    if (calls <= n) throw refusal(code);
    return real(from, to);
  });
  return { calls: () => calls };
}

describe('renameSyncWithRetry', () => {
  it('SIMULATED Windows: tries again after EPERM, EBUSY and EACCES with growing pauses, and then succeeds', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const d = tmp();
      fs.writeFileSync(path.join(d, 'from'), 'new');
      fs.writeFileSync(path.join(d, 'to'), 'old');
      const pauses: number[] = [];
      const counter = refuseRenames(3, code);
      renameSyncWithRetry(path.join(d, 'from'), path.join(d, 'to'), (ms) => pauses.push(ms));
      expect(fs.readFileSync(path.join(d, 'to'), 'utf8'), code).toBe('new');
      expect(pauses, code).toEqual([15, 30, 60]);
      expect(counter.calls(), code).toBe(4);
      vi.restoreAllMocks();
    }
  });

  it('gives up after six pauses (about a second) and reports the refusal itself', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'from'), 'new');
    const pauses: number[] = [];
    const counter = refuseRenames(1000, 'EBUSY');
    expect(() => renameSyncWithRetry(path.join(d, 'from'), path.join(d, 'to'), (ms) => pauses.push(ms))).toThrow(expect.objectContaining({ code: 'EBUSY' }));
    expect(pauses).toEqual([15, 30, 60, 120, 240, 480]);
    expect(counter.calls()).toBe(7);
  });

  it('does not retry anything else', () => {
    const d = tmp();
    const pauses: number[] = [];
    refuseRenames(1000, 'ENOSPC');
    expect(() => renameSyncWithRetry(path.join(d, 'from'), path.join(d, 'to'), (ms) => pauses.push(ms))).toThrow(expect.objectContaining({ code: 'ENOSPC' }));
    expect(pauses).toEqual([]);
  });
});

describe('writeManagedSettings when the file of an earlier run is held for a moment', () => {
  it('SIMULATED Windows: a resumed session still gets its settings file', () => {
    const dataDir = tmp();
    const first = writeManagedSettings({ layout, sessionId: SESSION, dataDir });
    const before = fs.readFileSync(first.hostPath, 'utf8');
    const counter = refuseRenames(2, 'EPERM');
    const again = writeManagedSettings({ layout: { ...layout, captureScriptInEnv: '/opt/minisumma/other-capture.mjs' }, sessionId: SESSION, dataDir });
    expect(again.hostPath).toBe(first.hostPath);
    expect(counter.calls()).toBe(3);
    expect(fs.readFileSync(first.hostPath, 'utf8')).not.toBe(before);
    expect(fs.readFileSync(first.hostPath, 'utf8')).toContain('other-capture.mjs');
    expect(fs.readdirSync(path.dirname(first.hostPath)).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('SIMULATED Windows: a file that stays held is reported, the old file is untouched and no temp file is left', () => {
    const dataDir = tmp();
    const first = writeManagedSettings({ layout, sessionId: SESSION, dataDir });
    const before = fs.readFileSync(first.hostPath, 'utf8');
    refuseRenames(1000, 'EPERM');
    expect(() => writeManagedSettings({ layout: { ...layout, captureScriptInEnv: '/opt/minisumma/other-capture.mjs' }, sessionId: SESSION, dataDir })).toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(fs.readFileSync(first.hostPath, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(first.hostPath)).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('the project registry file', () => {
  it('SIMULATED Windows: already retried (a hook may have the old file open), and the temp file is removed when it gives up', async () => {
    const d = tmp();
    const file = path.join(d, 'registry.json');
    fs.writeFileSync(file, '{"old":true}');
    const counter = refuseRenames(2, 'EBUSY');
    await writeFileAtomic(file, '{"new":true}');
    expect(counter.calls()).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"new":true}');
    vi.restoreAllMocks();
    refuseRenames(1000, 'EPERM');
    await expect(writeFileAtomic(file, '{"newer":true}')).rejects.toMatchObject({ code: 'EPERM' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"new":true}');
    expect(fs.readdirSync(d).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});
