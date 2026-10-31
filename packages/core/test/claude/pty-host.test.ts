import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createNodePtySpawner } from '../../src/claude/ptyHost.ts';
import type { PtyExitInfo, PtyProcess } from '../../src/claude/ptyHost.ts';
import { waitFor } from './managed-harness.ts';

// These run the real @lydell/node-pty on Linux. Windows (ConPTY) is NOT TESTED.

const spawner = createNodePtySpawner();
const env = (extra: Record<string, string> = {}): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  return { ...e, ...extra };
};

function run(script: string, opts: { cols?: number; rows?: number; cwd?: string; env?: Record<string, string> } = {}): { pty: PtyProcess; out: () => string; exit: () => PtyExitInfo | null } {
  const pty = spawner.spawn({ file: process.execPath, args: ['-e', script], cwd: opts.cwd ?? os.tmpdir(), env: env(opts.env), cols: opts.cols ?? 100, rows: opts.rows ?? 30 });
  let out = '';
  let exit: PtyExitInfo | null = null;
  pty.onData((d) => { out += d; });
  pty.onExit((e) => { exit = e; });
  return { pty, out: () => out, exit: () => exit };
}

const WIN = process.platform === 'win32';
const READY = 'process.stdout.write("ready\\n");';

describe('createNodePtySpawner (real PTY)', () => {
  it('delivers output as strings and reports a normal exit with its code and no signal', async () => {
    const r = run('process.stdout.write("hi from pty"); process.exit(3);');
    await waitFor(() => r.exit(), 'exit');
    expect(r.out()).toContain('hi from pty');
    expect(r.exit()).toEqual({ exitCode: 3, signal: null });
    expect(r.pty.pid).toBeGreaterThan(0);
  });

  // NOT VERIFIED ON WINDOWS: a Node child under ConPTY did not report the resize in the first native run (CI, 'Windows runner findings'). The initial size works.
  it.skipIf(WIN)('gives the child a terminal of the requested size and applies resize()', async () => {
    const r = run(`${READY} process.stdout.on("resize", () => process.stdout.write("size " + process.stdout.columns + "x" + process.stdout.rows + "\\n")); setInterval(() => {}, 1000); process.stdout.write("start " + process.stdout.columns + "x" + process.stdout.rows + "\\n");`, { cols: 91, rows: 27 });
    await waitFor(() => r.out().includes('start 91x27'), 'initial size');
    r.pty.resize(77, 21);
    await waitFor(() => r.out().includes('size 77x21'), 'resized size');
    r.pty.kill();
  });

  it('writes keystrokes to the child, byte for byte', async () => {
    const r = run(`process.stdin.setRawMode(true); process.stdout.write("ready\\n"); process.stdin.on("data", (d) => { process.stdout.write("got:" + JSON.stringify(d.toString()) + "\\n"); if (d.toString() === "q") process.exit(0); });`);
    await waitFor(() => r.out().includes('ready'), 'ready');
    r.pty.write('a\x1b[200~b\nc\x1b[201~\r');
    await waitFor(() => r.out().includes('got:"a\\u001b[200~b\\nc\\u001b[201~\\r"'), 'echo of the bytes');
    r.pty.write('q');
    await waitFor(() => r.exit(), 'exit');
  });

  it('passes the environment and the working directory to the child', async () => {
    const r = run('process.stdout.write("cwd=" + process.cwd() + " v=" + process.env.MS_PTY_PROBE + " term=" + process.env.TERM + "\\n");', { cwd: WIN ? (process.env.SystemRoot ?? 'C:\\Windows') : '/usr', env: { MS_PTY_PROBE: 'probe-value' } });
    await waitFor(() => r.exit(), 'exit');
    expect(r.out()).toContain(`cwd=${WIN ? (process.env.SystemRoot ?? 'C:\\Windows') : '/usr'} v=probe-value term=`);
  });

  it('reports a process ended by a signal as {exitCode: null, signal}', async () => {
    const r = run(`${READY} setInterval(() => {}, 1000);`);
    await waitFor(() => r.out().includes('ready'), 'ready');
    r.pty.kill('SIGKILL');
    await waitFor(() => r.exit(), 'exit');
    // Windows has no signals: a terminated ConPTY child reports an NT exit code (0xC000013A as a signed number), never a signal.
    if (WIN) expect(r.exit()).toMatchObject({ signal: null, exitCode: expect.any(Number) });
    else expect(r.exit()).toEqual({ exitCode: null, signal: 9 });
  });

  it('reports a program that cannot be executed as an immediate exit, not as an exception (node-pty forks first)', async () => {
    const pty = spawner.spawn({ file: '/definitely/not/a/program', args: [], cwd: os.tmpdir(), env: env(), cols: 80, rows: 24 });
    let out = '';
    let exit: PtyExitInfo | null = null;
    pty.onData((d) => { out += d; });
    pty.onExit((e) => { exit = e; });
    await waitFor(() => exit, 'exit');
    expect(exit).toEqual({ exitCode: 1, signal: null });
    expect(out).toContain(WIN ? 'File not found' : 'No such file or directory');
  });

  it('loads the native module lazily and reports a load failure from spawn(), not from import', () => {
    const broken = createNodePtySpawner(() => { throw new Error('platform package missing'); });
    expect(() => broken.spawn({ file: 'x', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })).toThrow('platform package missing');
  });
});

describe('createNodePtySpawner when the program cannot start (Windows ConPTY throws instead of forking)', () => {
  it('turns the throw into an exit with code 1 and the reason, only on win32', async () => {
    const throwing = () => ({ spawn: () => { throw new Error('File not found: '); } }) as never;
    const pty = createNodePtySpawner(throwing, 'win32').spawn({ file: 'x', args: [], cwd: '.', env: {}, cols: 80, rows: 24 });
    let out = '';
    let exit: PtyExitInfo | null = null;
    pty.onData((d) => { out += d; });
    pty.onExit((e) => { exit = e; });
    await waitFor(() => exit, 'exit');
    expect(exit).toEqual({ exitCode: 1, signal: null });
    expect(out).toContain('File not found');
    expect(() => createNodePtySpawner(throwing, 'linux').spawn({ file: 'x', args: [], cwd: '.', env: {}, cols: 80, rows: 24 })).toThrow('File not found');
  });
});
