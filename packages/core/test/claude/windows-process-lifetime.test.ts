// Process lifetimes on Windows (audit item 6), tested on Linux with an injected platform and scripted PTYs.
//
// EVERYTHING HERE IS SIMULATED. Nothing in this file ran on Windows, ConPTY or WSL2: the tests prove what Mini-Summa asks the
// platform to do (which program, in which order, with which arguments) and how it reacts to what node-pty is known to do from
// reading its Windows sources (@lydell/node-pty-win32-x64 1.2.0-beta.18: pid 0 until the pseudo-console is connected, a warning
// when `encoding` is given, kill() that ends only the processes attached to the console). They do not prove that Windows
// behaves that way. docs/audit/windows-core.md lists what only a real Windows PC can confirm.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandRunner, decodeCommandOutput, killProcessTree, parseWslDistroList } from '../../src/claude/commandRunner.ts';
import type { CommandOptions, CommandRunner } from '../../src/claude/commandRunner.ts';
import { createNodePtySpawner } from '../../src/claude/ptyHost.ts';
import type { PtyExitInfo, PtyProcess, PtySpawnRequest, PtySpawner } from '../../src/claude/ptyHost.ts';
import { systemProgramPath } from '../../src/claude/windowsPrograms.ts';
import { FakeSpawner, createHarness, waitFor } from './managed-harness.ts';
import type { Harness } from './managed-harness.ts';

let h: Harness | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const c of cleanups.splice(0)) c();
});

const row = (harness: Harness, key: string) => harness.db.get<Record<string, unknown>>('SELECT * FROM managed_sessions WHERE session_key = ?', [key]);

// ---------------------------------------------------------------------------------------------------------------
// The node-pty adapter

describe('SIMULATED Windows: the node-pty adapter', () => {
  const fakeModule = () => {
    const seen: Record<string, unknown>[] = [];
    const load = () => ({
      spawn: (_file: string, _args: unknown, options: Record<string, unknown>) => {
        seen.push(options);
        return { pid: 1, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} };
      },
    }) as never;
    return { seen, load };
  };
  const request: PtySpawnRequest = { file: 'x', args: [], cwd: '/', env: {}, cols: 80, rows: 24 };

  it('does not pass `encoding` to ConPTY (node-pty prints "Setting encoding on Windows is not supported" for every terminal), and still does elsewhere', () => {
    const win = fakeModule();
    createNodePtySpawner(win.load, 'win32').spawn(request);
    expect(win.seen[0]).not.toHaveProperty('encoding');
    expect(win.seen[0]).toMatchObject({ name: 'xterm-256color', cols: 80, rows: 24, cwd: '/' });

    for (const platform of ['linux', 'darwin'] as const) {
      const other = fakeModule();
      createNodePtySpawner(other.load, platform).spawn(request);
      expect(other.seen[0]).toMatchObject({ encoding: 'utf8' });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// pid 0 right after spawn

/** A terminal like ConPTY at spawn time: the process is connected later, and only then does it have an id. */
class LateConnectPty implements PtyProcess {
  pid = 0;
  readonly killed: (string | undefined)[] = [];
  private readonly data = new Set<(d: string) => void>();
  private readonly exits = new Set<(i: PtyExitInfo) => void>();
  onData(listener: (d: string) => void) { this.data.add(listener); return { dispose: () => { this.data.delete(listener); } }; }
  onExit(listener: (i: PtyExitInfo) => void) { this.exits.add(listener); return { dispose: () => { this.exits.delete(listener); } }; }
  write(): void {}
  resize(): void {}
  kill(signal?: string): void { this.killed.push(signal); for (const l of this.exits) l({ exitCode: null, signal: 9 }); }
  emitData(d: string): void { for (const l of this.data) l(d); }
}

describe('SIMULATED Windows: a terminal whose process id is not known at spawn', () => {
  it('records no pid (not 0) at first and takes the real one with the first output', async () => {
    h = createHarness();
    const pty = new LateConnectPty();
    const spawner: PtySpawner = { spawn: () => pty };
    const manager = h.makeManager({ spawner });
    const changes: (number | null)[] = [];
    manager.onChange((r) => changes.push(r.pid));

    const record = await manager.start(h.startInput());
    expect(record.pid).toBeNull();
    expect(row(h, record.key)).toMatchObject({ status: 'running', pid: null });

    pty.pid = 4242; // ConPTY connected its process
    pty.emitData('first output');
    expect(manager.get(record.key)?.pid).toBe(4242);
    expect(row(h, record.key)).toMatchObject({ pid: 4242 });
    expect(changes).toContain(4242);
    expect(changes).not.toContain(0);

    // later output changes nothing about the pid
    pty.emitData('more');
    expect(manager.get(record.key)?.pid).toBe(4242);
  });

  it('a terminal that has its pid at once (every POSIX pty) is recorded at once', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    const record = await manager.start(h.startInput());
    expect(record.pid).toBe(spawner.ptys[0].pid);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Stopping: the process tree

describe('SIMULATED Windows: ending a terminal also ends what Claude started', () => {
  const setup = async (platform: NodeJS.Platform, extra: Record<string, unknown> = {}) => {
    h = createHarness();
    const order: string[] = [];
    const trees: number[] = [];
    const spawner = new FakeSpawner();
    const killTree = async (pid: number) => { trees.push(pid); order.push(`tree:${pid}`); };
    const manager = h.makeManager({ spawner, overrides: { platform, killTree, termWaitMs: 60, killWaitMs: 60, ...extra } });
    const record = await manager.start(h.startInput());
    const pty = spawner.ptys[0];
    const kill = pty.kill.bind(pty);
    pty.kill = (signal?: string) => { order.push(`kill:${signal}`); kill(signal); };
    return { manager, record, pty, trees, order };
  };

  it('a forced stop ends the tree of the terminal\'s process BEFORE the terminal is killed (the parent links are gone afterwards)', async () => {
    const { manager, record, pty, trees, order } = await setup('win32');
    const stopped = await manager.stop(record.key, { force: true });
    expect(trees).toEqual([pty.pid]);
    expect(order).toEqual([`tree:${pty.pid}`, 'kill:SIGTERM']);
    expect(stopped).toMatchObject({ status: 'exited', exitReason: 'killed_by_user' });
  });

  it('a graceful stop that works never needs it', async () => {
    const { manager, record, trees, order } = await setup('win32', { stopGraceMs: 2000, ctrlCGapMs: 5 });
    await manager.stop(record.key, {});
    expect(trees).toEqual([]);
    expect(order).toEqual([]);
  });

  it('a graceful stop that does not work ends the tree after the grace period', async () => {
    const { manager, record, pty, trees, order } = await setup('win32', { stopGraceMs: 120, ctrlCRepeatMs: 60, ctrlCGapMs: 5 });
    pty.politeExit = false;
    const stopped = await manager.stop(record.key, {});
    expect(trees).toEqual([pty.pid]);
    expect(order[0]).toBe(`tree:${pty.pid}`);
    expect(stopped).toMatchObject({ status: 'exited', exitReason: 'killed_by_user' });
  });

  it('quitting the app ends the tree of a terminal that will not leave, and the reason stays "app_exit"', async () => {
    const { manager, record, pty, trees } = await setup('win32', { shutdownGraceMs: 60, ctrlCGapMs: 5 });
    pty.politeExit = false;
    await manager.shutdown();
    expect(trees).toEqual([pty.pid]);
    expect(manager.get(record.key)).toMatchObject({ status: 'exited', exitReason: 'app_exit' });
  });

  it('keeps killing when the tree kill fails or hangs on a rejection', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = h.makeManager({
      spawner, overrides: { platform: 'win32', killTree: async () => { throw new Error('taskkill could not start'); }, termWaitMs: 60, killWaitMs: 60 },
    });
    const record = await manager.start(h.startInput());
    const stopped = await manager.stop(record.key, { force: true });
    expect(spawner.ptys[0].killed).toEqual(['SIGTERM']);
    expect(stopped).toMatchObject({ status: 'exited', exitReason: 'killed_by_user' });
  });

  it('is a Windows rule only: other platforms never start taskkill', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const { manager, record, trees, order } = await setup(platform);
      await manager.stop(record.key, { force: true });
      expect(trees).toEqual([]);
      expect(order).toEqual(['kill:SIGTERM']);
      await h?.cleanup();
      h = undefined;
    }
  });

  it('does not ask taskkill about a process id it does not have (ConPTY not connected yet)', async () => {
    h = createHarness();
    const trees: number[] = [];
    const pty = new LateConnectPty();
    const manager = h.makeManager({ spawner: { spawn: () => pty }, overrides: { platform: 'win32', killTree: async (pid: number) => { trees.push(pid); }, termWaitMs: 60, killWaitMs: 60 } });
    const record = await manager.start(h.startInput());
    await manager.stop(record.key, { force: true });
    expect(trees).toEqual([]);
    expect(pty.killed).toEqual(['SIGTERM']);
  });
});

describe('SIMULATED Windows: killProcessTree', () => {
  it('runs taskkill.exe from %SystemRoot%\\System32 with /pid N /T /F, never the bare name', async () => {
    const calls: { file: string; args: string[]; opts: CommandOptions }[] = [];
    const run: CommandRunner = async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '', stderr: '', code: 0 }; };
    const result = await killProcessTree(31337, { run, env: { SystemRoot: 'D:\\Win' } });
    expect(result).toMatchObject({ code: 0 });
    expect(calls).toEqual([{ file: 'D:\\Win\\System32\\taskkill.exe', args: ['/pid', '31337', '/T', '/F'], opts: { timeoutMs: 5000 } }]);
    expect(systemProgramPath('taskkill.exe', {})).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  it('a process that is already gone is a result (taskkill answers 128), and a bad pid never starts anything', async () => {
    const calls: unknown[] = [];
    const run: CommandRunner = async (file) => { calls.push(file); return { stdout: '', stderr: 'ERROR: The process "5" not found.', code: 128, error: 'ERROR: The process "5" not found.' }; };
    expect(await killProcessTree(5, { run, env: {} })).toMatchObject({ code: 128 });
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(await killProcessTree(bad, { run, env: {} })).toMatchObject({ code: null, error: expect.stringContaining('no process id') });
    }
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The command runner's deadline

describe('SIMULATED Windows: the deadline of a helper command reaches its children', () => {
  const sleeper = ['-e', 'setInterval(() => {}, 1000)'];

  it('ends the process tree first and then the process, and reports a timeout (the npm claude.cmd shim leaves a grandchild that holds the pipes)', async () => {
    const trees: number[] = [];
    const run = createCommandRunner({
      platform: 'win32',
      killTree: async (pid) => { trees.push(pid); await new Promise((r) => setTimeout(r, 20)); },
    });
    const started = Date.now();
    const result = await run(process.execPath, sleeper, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(trees).toHaveLength(1);
    expect(trees[0]).toBeGreaterThan(0);
    expect(result).toMatchObject({ code: null, error: 'Timed out after 0 seconds.' });
  });

  it('a command that finishes in time is untouched, also with a deadline pending', async () => {
    const trees: number[] = [];
    const run = createCommandRunner({ platform: 'win32', killTree: async (pid) => { trees.push(pid); } });
    const result = await run(process.execPath, ['-e', 'process.stdout.write("done")'], { timeoutMs: 20_000 });
    expect(result).toEqual({ stdout: 'done', stderr: '', code: 0 });
    expect(trees).toEqual([]);
  });

  it('keeps execFile\'s own deadline everywhere else', async () => {
    const trees: number[] = [];
    const run = createCommandRunner({ platform: 'linux', killTree: async (pid) => { trees.push(pid); } });
    const result = await run(process.execPath, sleeper, { timeoutMs: 300 });
    expect(result).toMatchObject({ code: null, error: expect.stringMatching(/^Timed out after/) });
    expect(trees).toEqual([]);
  });

  it('closes the command\'s input at once, so a program that waits for input ends with end-of-file instead of waiting for ever', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const run = createCommandRunner({ platform, killTree: async () => undefined });
      const result = await run(process.execPath, ['-e', 'process.stdin.on("end", () => process.stdout.write("eof")).resume()'], { timeoutMs: 20_000 });
      expect(result, platform).toEqual({ stdout: 'eof', stderr: '', code: 0 });
    }
  });

  it('reports a program that does not exist as a result on both paths', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const run = createCommandRunner({ platform });
      const result = await run('/definitely/not/a/program', [], { timeoutMs: 5000 });
      expect(result, platform).toMatchObject({ code: null, error: '/definitely/not/a/program was not found.' });
    }
  });

  it('really ends a grandchild that holds the pipes, with a tree killer that does what taskkill /T does (POSIX stand-in)', async () => {
    // A parent that starts a long-lived child sharing its stdout, like cmd.exe in front of node.exe. Killing only the parent
    // would leave the pipe open and the callback would never come.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-tree-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pidFile = path.join(dir, 'grandchild.pid');
    const parent = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
    const run = createCommandRunner({
      platform: 'win32',
      killTree: async () => { // what taskkill /T /F does: the children by their recorded parent, then the parent
        const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
        process.kill(grandchild, 'SIGKILL');
      },
    });
    const result = await run(process.execPath, ['-e', parent], { timeoutMs: 600 });
    expect(result).toMatchObject({ code: null, error: expect.stringMatching(/^Timed out/) });
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitFor(() => { try { process.kill(grandchild, 0); return undefined; } catch { return true; } }, 'the grandchild to be gone', 5000);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// wsl.exe listings

/** What wsl.exe really writes when its output is captured: UTF-16LE, usually with no byte order mark, CR LF line ends. */
const utf16 = (text: string, opts: { bom?: boolean } = {}): Buffer => Buffer.concat([opts.bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);

describe('SIMULATED WSL: decoding recorded wsl.exe listings (UTF-16LE)', () => {
  const names = (bytes: Buffer): string[] => parseWslDistroList(decodeCommandOutput(bytes));

  it('reads a listing with and without a byte order mark, CR LF, and a stray NUL at the end', () => {
    const text = 'Ubuntu-22.04\r\nDebian\r\n';
    expect(names(utf16(text))).toEqual(['Ubuntu-22.04', 'Debian']);
    expect(names(utf16(text, { bom: true }))).toEqual(['Ubuntu-22.04', 'Debian']);
    expect(names(utf16(`${text}\u0000`))).toEqual(['Ubuntu-22.04', 'Debian']);
    expect(names(Buffer.concat([utf16(text), Buffer.from([0])]))).toEqual(['Ubuntu-22.04', 'Debian']); // an odd number of bytes
  });

  it('does not offer the helper distributions of Docker Desktop and Rancher Desktop', () => {
    const listing = 'Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nrancher-desktop\r\nrancher-desktop-data\r\nDebian\r\n';
    expect(names(utf16(listing))).toEqual(['Ubuntu', 'Debian']);
    expect(names(utf16('rancher-desktop-extra\r\n'))).toEqual(['rancher-desktop-extra']); // only the two names of the helper
  });

  it('keeps a name with a space and parentheses whole, and removes only the English "(Default)" marker', () => {
    expect(names(utf16('Ubuntu (Work)\r\nDebian (Default)\r\n'))).toEqual(['Ubuntu (Work)', 'Debian']);
  });

  it('reads distribution names with dots and dashes whole, in either order of the default', () => {
    expect(names(utf16('Ubuntu-24.04\r\nkali-linux\r\nopenSUSE-Tumbleweed\r\n'))).toEqual(['Ubuntu-24.04', 'kali-linux', 'openSUSE-Tumbleweed']);
  });

  it('is empty when wsl.exe printed an error instead of a listing (no distribution installed, WSL not enabled), in any language', () => {
    const noDistros = [
      'Windows Subsystem for Linux has no installed distributions.',
      'You can resolve this by installing a distribution with the instructions below:',
      '',
      "Use 'wsl.exe --list --online' to list available distributions",
      "and 'wsl.exe --install <Distro>' to install.",
      '',
      'Error code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND',
    ].join('\r\n');
    const german = 'Das Windows-Subsystem für Linux hat keine installierten Distributionen.\r\nFehlercode: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND\r\n';
    expect(names(utf16(noDistros, { bom: true }))).toEqual([]);
    expect(names(utf16(german))).toEqual([]);
    expect(names(utf16('Das Windows-Subsystem für Linux ist nicht aktiviert.\r\nFehlercode: Wsl/Service/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\r\n'))).toEqual([]);
  });

  it('is empty for empty output', () => {
    expect(names(Buffer.alloc(0))).toEqual([]);
    expect(names(utf16('\r\n'))).toEqual([]);
  });
});
