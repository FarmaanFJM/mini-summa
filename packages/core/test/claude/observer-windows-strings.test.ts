// Windows command lines (SEC-15), tested as STRINGS on Linux with an injected platform. Nothing here has been run on a real
// Windows host: it checks the exact programs and command lines that WOULD be started, not what Windows does with them.
//   - wsl.exe and cmd.exe are started by full path, never by a bare name the process-start code would look for in the current
//     directory first;
//   - a .cmd/.bat shim is asked for its version as one verbatim `cmd.exe /d /s /c ""<shim>" --version"` line, and a shim path
//     that cmd.exe could read as syntax is refused;
//   - a session name cannot carry the characters that split or re-quote a Windows command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@minisumma/storage';
import { createEventBus } from '../../src/bus.ts';
import type { CoreBase } from '../../src/contracts.ts';
import { systemClock } from '../../src/contracts.ts';
import { CoreError } from '../../src/errors.ts';
import { defaultCommandRunner } from '../../src/claude/commandRunner.ts';
import type { CommandOptions, CommandRunner } from '../../src/claude/commandRunner.ts';
import { createDiscovery, wslAgentsInvocation } from '../../src/claude/discovery.ts';
import type { ExecJson } from '../../src/claude/discovery.ts';
import { createEnvironmentsService } from '../../src/claude/environments.ts';
import { buildClaudeArgs, normalizeSessionName } from '../../src/claude/managed.ts';
import { buildLaunchPlan } from '../../src/claude/ptyHost.ts';
import { createRawStore } from '../../src/claude/rawStore.ts';
import { SerialQueue } from '../../src/claude/serialQueue.ts';
import { cmdShimPathProblem, systemProgramPath, windowsDirectory } from '../../src/claude/windowsPrograms.ts';
import { createFakeSettings, createStubEnvironments } from './helpers/observer-fakes.ts';
import type { FakeSettings } from './helpers/observer-fakes.ts';
import { collectingLogger, layoutFor } from './helpers/observer-harness.ts';
import { FakeSpawner, createHarness } from './managed-harness.ts';
import type { Harness as ManagedHarness } from './managed-harness.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

// ---------------------------------------------------------------------------------------------------------------
// The programs

describe('systemProgramPath', () => {
  it('is <SystemRoot>\\System32\\<program>, for wsl.exe and cmd.exe', () => {
    expect(systemProgramPath('wsl.exe', { SystemRoot: 'C:\\WINDOWS' })).toBe('C:\\WINDOWS\\System32\\wsl.exe');
    expect(systemProgramPath('cmd.exe', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\cmd.exe');
    expect(systemProgramPath('wsl.exe', { SystemRoot: 'D:\\Win\\' })).toBe('D:\\Win\\System32\\wsl.exe');
    expect(systemProgramPath('wsl.exe', { SystemRoot: 'D:/Win' })).toBe('D:\\Win\\System32\\wsl.exe');
  });

  it('reads the variable whatever its case (Windows does), and falls back from SystemRoot to windir', () => {
    expect(windowsDirectory({ SYSTEMROOT: 'E:\\OS' })).toBe('E:\\OS');
    expect(windowsDirectory({ windir: 'F:\\Windows' })).toBe('F:\\Windows');
    expect(windowsDirectory({ SystemRoot: 'E:\\OS', windir: 'F:\\Windows' })).toBe('E:\\OS');
  });

  it.each([
    ['nothing set', {}],
    ['an empty value', { SystemRoot: '' }],
    ['a relative path (searched from the current directory)', { SystemRoot: 'Windows' }],
    ['a dot', { SystemRoot: '.' }],
    ['a drive-relative path', { SystemRoot: 'C:Windows' }],
    ['a network share', { SystemRoot: '\\\\server\\share\\Windows' }],
    ['a quote in the path', { SystemRoot: 'C:\\Win"dows' }],
    ['a rooted path with no drive', { SystemRoot: '\\Windows' }],
  ])('uses C:\\Windows when SystemRoot is %s', (_name, env) => {
    expect(windowsDirectory(env)).toBe('C:\\Windows');
    expect(systemProgramPath('wsl.exe', env)).toBe('C:\\Windows\\System32\\wsl.exe');
  });

  it('takes cmd.exe from ComSpec when that is a local path to a cmd.exe, and from System32 otherwise', () => {
    const base = { SystemRoot: 'D:\\Win' };
    expect(systemProgramPath('cmd.exe', { ...base, ComSpec: 'D:\\Win\\system32\\cmd.exe' })).toBe('D:\\Win\\system32\\cmd.exe');
    expect(systemProgramPath('cmd.exe', { ...base, COMSPEC: 'C:\\WINDOWS\\SYSTEM32\\CMD.EXE' })).toBe('C:\\WINDOWS\\SYSTEM32\\CMD.EXE');
    for (const hostile of ['cmd.exe', '.\\cmd.exe', 'C:\\Users\\me\\powershell.exe', '\\\\server\\share\\cmd.exe', 'C:cmd.exe', '', 'C:\\x\\cmd.exe" /c calc']) {
      expect(systemProgramPath('cmd.exe', { ...base, ComSpec: hostile }), hostile).toBe('D:\\Win\\System32\\cmd.exe');
    }
  });

  it('never takes wsl.exe from anywhere but System32', () => {
    expect(systemProgramPath('wsl.exe', { SystemRoot: 'D:\\Win', ComSpec: 'C:\\evil\\cmd.exe', PATH: 'C:\\evil' })).toBe('D:\\Win\\System32\\wsl.exe');
  });
});

describe('cmdShimPathProblem', () => {
  it.each(['&', '|', '<', '>', '^', '%', '!', '"', '\n', '\r', '\u0000'])('refuses a path that contains %j', (ch) => {
    const problem = cmdShimPathProblem(`C:\\Tools\\a${ch}b\\claude.cmd`);
    expect(problem).toContain('cmd.exe');
    expect(problem).not.toContain('—');
  });

  it.each([
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Program Files (x86)\\nodejs\\claude.cmd',
    "C:\\Users\\Jane, O'Neil = 1\\claude.cmd",
    'D:\\Ünïcode\\日本語\\claude.bat',
    'C:\\a;b\\claude.cmd',
  ])('accepts %s (quoting handles spaces and punctuation)', (file) => {
    expect(cmdShimPathProblem(file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The environments service, as a Windows host

const base = (dataDir: string): CoreBase => ({ db: undefined as never, bus: createEventBus(), clock: systemClock, log: collectingLogger(), version: 't', mode: 'headless', dataDir });

interface Call { file: string; args: string[]; opts: CommandOptions }

function windowsHost(opts: { env?: Record<string, string>; files?: string[]; distros?: string[]; settings?: FakeSettings } = {}) {
  const files = new Set(opts.files ?? []);
  const probed: string[] = [];
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, o) => {
    calls.push({ file, args, opts: o });
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 as number | null });
    if (/[\\/]wsl\.exe$/i.test(file) && args[0] === '-l') return ok(`${(opts.distros ?? []).join('\r\n')}\r\n`);
    if (/[\\/]wsl\.exe$/i.test(file) && args[0] === '-d') {
      const [cmd, ...rest] = args.slice(3);
      if (cmd === 'claude' && rest[0] === '--version') return ok('2.1.314 (Claude Code)\n');
      if (cmd === 'node') return ok('v22.12.0\n');
      if (cmd === 'sh' && rest[rest.length - 1] === 'command -v claude') return ok('/home/me/.local/bin/claude\n');
      if (cmd === 'sh') return ok('/home/me');
      if (cmd === 'wslpath') return ok('/mnt/c/x\n');
    }
    if (/cmd\.exe$/i.test(file) || /claude\.exe$/i.test(file)) return ok('2.1.314 (Claude Code)\r\n');
    return { stdout: '', stderr: 'not handled', code: 1 };
  };
  const svc = createEnvironmentsService({
    base: base('C:\\Users\\me\\AppData\\Roaming\\Mini-Summa\\data'), settings: opts.settings ?? createFakeSettings(), run,
    overrides: { captureScript: 'C:\\app\\capture.mjs', nodeRuntime: { command: 'C:\\Program Files\\nodejs\\node.exe', runAsNode: false } },
    host: {
      platform: 'win32', homeDir: 'C:\\Users\\me', env: { PATH: 'C:\\Windows;C:\\Tools', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ...opts.env },
      fileExists: (p) => { probed.push(p); return files.has(p); },
    },
  });
  return { svc, calls, probed };
}

describe('a Windows host starts its system programs by full path', () => {
  it('asks wsl.exe under %SystemRoot%\\System32 for the distributions and everything about them, never the bare name', async () => {
    const t = windowsHost({ env: { SystemRoot: 'D:\\Win' }, distros: ['Ubuntu'], files: ['C:\\Tools\\claude.exe'] });
    const envs = await t.svc.list();
    expect(envs.map((e) => e.id)).toEqual(['win', 'wsl:Ubuntu']);
    const wsl = t.calls.filter((c) => /wsl\.exe$/i.test(c.file));
    expect(wsl.length).toBeGreaterThan(5); // the listing and every probe of the distribution
    for (const call of wsl) expect(call.file).toBe('D:\\Win\\System32\\wsl.exe');
    expect(t.calls.some((c) => c.file === 'wsl.exe' || c.file === 'cmd.exe')).toBe(false);
  });

  it('uses C:\\Windows when the process has no SystemRoot', async () => {
    const t = windowsHost({ distros: ['Ubuntu'] });
    await t.svc.list();
    expect(t.calls.filter((c) => /wsl\.exe$/i.test(c.file)).every((c) => c.file === 'C:\\Windows\\System32\\wsl.exe')).toBe(true);
  });

  it('starts a .cmd shim through the cmd.exe Windows names in ComSpec, as one verbatim line with the path quoted', async () => {
    const t = windowsHost({ env: { ComSpec: 'D:\\Win\\System32\\cmd.exe' }, files: ['C:\\Tools\\claude.cmd'] });
    const [info] = await t.svc.list();
    expect(info.claude).toEqual({ path: 'C:\\Tools\\claude.cmd', version: '2.1.314', error: null });
    const cmd = t.calls.filter((c) => /cmd\.exe$/i.test(c.file));
    expect(cmd).toHaveLength(1);
    expect(cmd[0].file).toBe('D:\\Win\\System32\\cmd.exe');
    expect(cmd[0].args).toEqual(['/d', '/s', '/c', '""C:\\Tools\\claude.cmd" --version"']);
    expect(cmd[0].opts.windowsVerbatimArguments).toBe(true);
    // nothing else is asked to be verbatim
    expect(t.calls.filter((c) => c !== cmd[0]).every((c) => c.opts.windowsVerbatimArguments === undefined)).toBe(true);
  });

  it('falls back to System32 when ComSpec names something else', async () => {
    const t = windowsHost({ env: { SystemRoot: 'D:\\Win', ComSpec: 'C:\\Users\\me\\Downloads\\powershell.exe' }, files: ['C:\\Tools\\claude.cmd'] });
    await t.svc.list();
    expect(t.calls.find((c) => /cmd\.exe$/i.test(c.file))?.file).toBe('D:\\Win\\System32\\cmd.exe');
  });

  it('quotes a shim path that has spaces, parentheses, commas and an apostrophe, and hands out the shim itself', async () => {
    const appdata = "C:\\Users\\Jane (work), O'Neil=1\\AppData\\Roaming";
    const shim = `${appdata}\\npm\\claude.cmd`;
    const t = windowsHost({ env: { APPDATA: appdata }, files: [shim] });
    const [info] = await t.svc.list();
    expect(info.claude.path).toBe(shim);
    expect(t.calls.find((c) => /cmd\.exe$/i.test(c.file))?.args).toEqual(['/d', '/s', '/c', `""${shim}" --version"`]);
    expect(await t.svc.claudeCommand('win')).toEqual({ file: shim, prefixArgs: [], wslDistro: null });
  });
});

describe('a .cmd shim whose path cmd.exe could read as syntax', () => {
  it.each(['&', '|', '<', '>', '^', '%', '!', '"'])('is not started when its folder contains %j', async (ch) => {
    const dir = `C:\\Tools\\a${ch}b`;
    const t = windowsHost({ env: { PATH: dir }, files: [`${dir}\\claude.cmd`] });
    const [info] = await t.svc.list();
    expect(t.calls.some((c) => /cmd\.exe$/i.test(c.file))).toBe(false);
    expect(info.available).toBe(false);
    expect(info.claude.path).toBe(`${dir}\\claude.cmd`);
    expect(info.claude.version).toBeNull();
    expect(info.claude.error).toContain('cmd.exe');
    expect(info.notes[0]).toContain(`Claude Code was found at ${dir}\\claude.cmd but did not start:`);
    expect(info.notes[0]).toContain('Move it to a folder without such a character, or install the native claude.exe.');
    expect(await t.svc.claudeCommand('win')).toBeNull();
  });

  it('is reported, not replaced, when it was chosen in Settings', async () => {
    const shim = 'C:\\Tools\\a&b\\claude.cmd';
    const t = windowsHost({ files: [shim, 'C:\\Tools\\claude.exe'], settings: createFakeSettings({ sessions: { claudeCommand: shim } }) });
    const [info] = await t.svc.list();
    expect(info.claude.path).toBe(shim);
    expect(info.available).toBe(false);
    expect(info.notes[0]).toMatch(/^The Claude command set in Settings \(C:\\Tools\\a&b\\claude\.cmd\) did not start: Its path contains a character that cmd\.exe reads as part of a command/);
    expect(t.calls.some((c) => /claude\.exe$/i.test(c.file))).toBe(false);
  });

  it('does not stop a safe claude.exe on PATH from being found first', async () => {
    const t = windowsHost({ env: { PATH: 'C:\\Tools\\a&b;C:\\Tools' }, files: ['C:\\Tools\\a&b\\claude.cmd', 'C:\\Tools\\claude.exe'] });
    const [info] = await t.svc.list();
    expect(info.claude.path).toBe('C:\\Tools\\claude.exe'); // .exe beats .cmd on PATH
    expect(info.available).toBe(true);
  });
});

describe('PATH entries that are not absolute are not searched', () => {
  it('on Windows', async () => {
    const t = windowsHost({ env: { PATH: '.;bin;..\\tools;C:\\Tools' }, files: ['claude.exe', 'bin\\claude.exe', '..\\tools\\claude.exe', 'C:\\Tools\\claude.exe'] });
    const [info] = await t.svc.list();
    expect(info.claude.path).toBe('C:\\Tools\\claude.exe');
    expect(t.probed.filter((p) => !/^[A-Za-z]:\\/.test(p))).toEqual([]); // no relative candidate was even looked at
  });

  it('on Linux', async () => {
    const probed: string[] = [];
    const svc = createEnvironmentsService({
      base: base('/data'), settings: createFakeSettings(), overrides: { homeDir: '/home/me', nodeRuntime: { command: '/usr/bin/node', runAsNode: false }, captureScript: '/opt/c.mjs' },
      run: async () => ({ stdout: '2.1.0\n', stderr: '', code: 0 }),
      host: { platform: 'linux', env: { PATH: '.:bin::/opt/claude/bin' }, fileExists: (p) => { probed.push(p); return p === '/opt/claude/bin/claude'; } },
    });
    expect((await svc.list())[0].claude.path).toBe('/opt/claude/bin/claude');
    expect(probed.filter((p) => !p.startsWith('/'))).toEqual([]);
  });
});

describe('the default command runner', () => {
  it('accepts the verbatim-arguments option (it only matters on Windows)', async () => {
    const r = await defaultCommandRunner(process.execPath, ['-e', 'process.stdout.write("fine")'], { timeoutMs: 10_000, windowsVerbatimArguments: true });
    expect(r).toMatchObject({ code: 0, stdout: 'fine' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The launch plan and the manager that builds it

describe('buildLaunchPlan with the programs the caller resolved', () => {
  const SESSION = '5d1a9a41-24c0-4b93-8c6a-93e2d9a9c001';
  const hostCwd = 'C:\\Users\\me\\AppData\\Roaming\\MiniSumma';

  it('starts WSL through the wsl.exe it is given, and keeps the bare name when it is given none', () => {
    const claude = { file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' };
    const args = ['--session-id', SESSION];
    const withPath = buildLaunchPlan({ claude, claudeArgs: args, cwd: '/home/me/app', hostCwd, platform: 'win32', wslExe: 'C:\\Windows\\System32\\wsl.exe' });
    expect(withPath.file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(withPath.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/app', '--exec', 'claude', '--session-id', SESSION]);
    expect(buildLaunchPlan({ claude, claudeArgs: args, cwd: '/home/me/app', hostCwd, platform: 'win32' }).file).toBe('wsl.exe');
  });

  it('starts a .cmd shim through the cmd.exe it is given', () => {
    const plan = buildLaunchPlan({
      claude: { file: 'C:\\Tools\\claude.cmd', prefixArgs: [], wslDistro: null }, claudeArgs: ['--session-id', SESSION], cwd: 'C:\\Dev', hostCwd,
      platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(plan).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: `/d /s /c "C:\\Tools\\claude.cmd --session-id ${SESSION}"`, cwd: 'C:\\Dev' });
  });
});

describe('the manager on a Windows platform', () => {
  function windowsManager(env: Record<string, string>) {
    const h: ManagedHarness = createHarness();
    cleanups.push(() => h.cleanup());
    const shim = path.join(h.root, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');
    h.environments.claude.set('posix', { file: shim, prefixArgs: [], wslDistro: null });
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner, overrides: { platform: 'win32', baseEnv: env } });
    return { h, manager, spawner };
  }

  it('starts a .cmd shim through cmd.exe by full path, from SystemRoot', async () => {
    const { h, manager, spawner } = windowsManager({ SystemRoot: 'D:\\Win' });
    await manager.start(h.startInput({ name: 'Fix login' }));
    expect(spawner.requests).toHaveLength(1);
    expect(spawner.requests[0].file).toBe('D:\\Win\\System32\\cmd.exe');
    expect(spawner.requests[0].args).toEqual(expect.stringMatching(/^\/d \/s \/c ".*claude\.cmd --session-id [0-9a-f-]{36} --settings .+ --name "Fix login""$/));
  });

  it('starts it through the ComSpec cmd.exe when there is one', async () => {
    const { h, manager, spawner } = windowsManager({ SystemRoot: 'D:\\Win', ComSpec: 'D:\\Win\\system32\\cmd.exe' });
    await manager.start(h.startInput());
    expect(spawner.requests[0].file).toBe('D:\\Win\\system32\\cmd.exe');
  });

  it('leaves the bare names alone on other platforms (they are never started there)', async () => {
    const h: ManagedHarness = createHarness();
    cleanups.push(() => h.cleanup());
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    await manager.start(h.startInput());
    expect(spawner.requests[0].file).toBe(process.execPath);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Discovery of a WSL distribution

describe('discovery asks a WSL distribution through the full path of wsl.exe', () => {
  function discoveryFor(platform: NodeJS.Platform, env: Record<string, string>, exec: ExecJson) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wsl-discovery-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const layouts = (['win', 'wsl:Ubuntu'] as const).map((e) => layoutFor({ dataDir: path.join(dir, 'data'), dir }, e));
    for (const l of layouts) fs.mkdirSync(l.spoolDirHost, { recursive: true });
    const environments = createStubEnvironments('win', layouts);
    environments.commands.set('wsl:Ubuntu', { file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' });
    const db = openDatabase(':memory:').db;
    cleanups.push(() => db.close());
    return createDiscovery({
      queue: new SerialQueue(), rawStore: createRawStore(db, systemClock), environments, exec, platform, env,
      intervalMs: () => 0, apply: () => undefined, clock: systemClock, log: collectingLogger(),
    });
  }

  it('builds the same arguments the library does, started by the wsl.exe it is given', () => {
    expect(wslAgentsInvocation('D:\\Win\\System32\\wsl.exe', 'Ubuntu', {})).toEqual({
      file: 'D:\\Win\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'claude', 'agents', '--json'],
    });
    expect(wslAgentsInvocation('wsl.exe', 'Debian-12', { all: true, cwd: '/home/me/app' }).args)
      .toEqual(['-d', 'Debian-12', '--exec', 'claude', 'agents', '--json', '--all', '--cwd', '/home/me/app']);
  });

  it('on a Windows host', async () => {
    const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
    const discovery = discoveryFor('win32', { SystemRoot: 'D:\\Win' }, async (file, args, o) => { calls.push({ file, args, timeoutMs: o.timeoutMs }); return []; });
    expect(await discovery.runNow('wsl:Ubuntu')).toEqual({ ran: ['wsl:Ubuntu'], errors: [] });
    expect(calls).toEqual([{ file: 'D:\\Win\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'claude', 'agents', '--json'], timeoutMs: 30_000 }]);
  });

  it('and reports a failure of that call as a failed discovery', async () => {
    const discovery = discoveryFor('win32', {}, async () => { throw new Error('wsl.exe failed: The Windows Subsystem for Linux has no installed distributions.'); });
    const result = await discovery.runNow('wsl:Ubuntu');
    expect(result.ran).toEqual([]);
    expect(result.errors).toEqual([{ env: 'wsl:Ubuntu', message: 'Claude Code could not list its sessions: wsl.exe failed: The Windows Subsystem for Linux has no installed distributions.' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Session names

describe('normalizeSessionName', () => {
  it('leaves ordinary names alone, including apostrophes, punctuation and non-Latin text', () => {
    for (const name of ['Fix login', "it's fine", 'Naïve café 日本語', 'a & b | c < d > e', '100% sure!', 'step (1): go']) expect(normalizeSessionName(name)).toBe(name);
  });

  it('removes double quotes and backslashes', () => {
    expect(normalizeSessionName('say "hi"')).toBe('say hi');
    expect(normalizeSessionName('C:\\work\\app')).toBe('C:workapp');
    expect(normalizeSessionName('trailing backslash\\')).toBe('trailing backslash');
    expect(normalizeSessionName('x" --dangerously-skip-permissions "y')).toBe('x --dangerously-skip-permissions y');
  });

  it.each(Array.from({ length: 8 }, (_v, i) => 0x2018 + i))('removes the typographic quote U+%s', (code) => {
    const quote = String.fromCharCode(code);
    expect(normalizeSessionName(`a${quote}b${quote}`)).toBe('ab');
    expect(normalizeSessionName(`${quote}quoted${quote}`)).toBe('quoted');
  });

  it.each([[0xff02, 'full-width quotation mark'], [0xff07, 'full-width apostrophe'], [0xff3c, 'full-width backslash']])('removes the full-width U+%s (%s), which some code pages turn into the ASCII character', (code) => {
    expect(normalizeSessionName(`a${String.fromCharCode(code)}b`)).toBe('ab');
  });

  it('removes them together and tidies the spaces they leave', () => {
    expect(normalizeSessionName('Bob’s “fix” for \\ the "thing"')).toBe('Bobs fix for the thing');
  });

  it('still turns control characters into spaces, caps the length, and gives null for nothing', () => {
    expect(normalizeSessionName('a\u0000b\nc')).toBe('a b c');
    expect(normalizeSessionName('x'.repeat(300))).toHaveLength(200);
    expect(normalizeSessionName('""\\“”')).toBeNull();
    expect(normalizeSessionName('   ')).toBeNull();
    expect(normalizeSessionName(null)).toBeNull();
    expect(normalizeSessionName(undefined)).toBeNull();
  });

  it('still refuses a name that starts with a dash, also when quotes hid the dash', () => {
    for (const name of ['-x', '--dangerously-skip-permissions', '"--dangerously-skip-permissions"', '“-x”', '\\-x']) {
      let error: unknown;
      try { normalizeSessionName(name); } catch (e) { error = e; }
      expect(error, name).toBeInstanceOf(CoreError);
      expect((error as CoreError).status).toBe(400);
    }
  });

  it('keeps every argument of the Claude command line whole: a name cannot add a quote, a backslash or an option', () => {
    const name = normalizeSessionName('evil" --settings C:\\x\\y.json "')!;
    const argv = buildClaudeArgs({ mode: 'new', sessionId: '0b9a6c5e-87a1-4d5c-9d3e-5d53b6b0a1c2', settingsPath: '/s.json', name, remoteControl: true });
    expect(argv.filter((a) => /["\\\u2018-\u201f]/.test(a))).toEqual([]);
    expect(argv).toEqual(['--session-id', '0b9a6c5e-87a1-4d5c-9d3e-5d53b6b0a1c2', '--settings', '/s.json', '--name', 'evil --settings C:xy.json', '--remote-control', 'evil --settings C:xy.json']);
  });
});

describe('a session name through the real manager', () => {
  it('reaches the process and the database without quotes or backslashes', async () => {
    const h: ManagedHarness = createHarness();
    cleanups.push(() => h.cleanup());
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    const record = await manager.start(h.startInput({ name: 'Bob’s “fix” for "the" C:\\thing' }));
    expect(record.name).toBe('Bobs fix for the C:thing');
    const args = spawner.requests[0].args as string[];
    expect(args[args.indexOf('--name') + 1]).toBe('Bobs fix for the C:thing');
    expect(h.db.get<{ name: string }>('SELECT name FROM managed_sessions WHERE session_key = ?', [record.key])?.name).toBe('Bobs fix for the C:thing');
  });

  it('refuses a name that is only an option once its quotes are gone, before anything exists', async () => {
    const h: ManagedHarness = createHarness();
    cleanups.push(() => h.cleanup());
    const spawner = new FakeSpawner();
    const manager = h.makeManager({ spawner });
    await expect(manager.start(h.startInput({ name: '"--dangerously-skip-permissions"' }))).rejects.toMatchObject({ status: 400 });
    expect(spawner.requests).toEqual([]);
    expect(h.db.all('SELECT * FROM managed_sessions')).toEqual([]);
  });
});
