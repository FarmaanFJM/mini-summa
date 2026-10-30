import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/bus.ts';
import type { CoreBase, CoreOptions } from '../../src/contracts.ts';
import { systemClock } from '../../src/contracts.ts';
import { CoreError } from '../../src/errors.ts';
import { decodeCommandOutput, defaultCommandRunner, parseVersion, parseWslDistroList } from '../../src/claude/commandRunner.ts';
import type { CommandResult, CommandRunner } from '../../src/claude/commandRunner.ts';
import { createEnvironmentsService } from '../../src/claude/environments.ts';
import type { HostProbe } from '../../src/claude/environments.ts';
import { envTag, windowsPathToWsl, wslPathToWindows } from '../../src/claude/envPaths.ts';
import { collectingLogger } from './helpers/observer-harness.ts';
import { createFakeSettings } from './helpers/observer-fakes.ts';
import type { FakeSettings } from './helpers/observer-fakes.ts';

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-env-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const base = (dataDir: string): CoreBase => ({ db: undefined as never, bus: createEventBus(), clock: systemClock, log: collectingLogger(), version: 't', mode: 'headless', dataDir });

interface Call { file: string; args: string[]; env?: Record<string, string> }
function fakeRunner(handler: (file: string, args: string[], env?: Record<string, string>) => Partial<CommandResult> | undefined): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, opts) => {
    calls.push({ file, args, env: opts.env });
    const r = handler(file, args, opts.env);
    return { stdout: '', stderr: r ? '' : 'not handled by the fake', code: r ? 0 : 1, ...r };
  };
  return { run, calls };
}
const ok = (stdout: string): Partial<CommandResult> => ({ stdout, code: 0 });
const fail = (stderr: string, code = 1): Partial<CommandResult> => ({ stdout: '', stderr, code });

function exe(dir: string, name = 'claude'): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  return p;
}

/** A Linux host with a home directory, PATH and a capture script that need no real Claude. */
function linux(opts: { path?: string[]; env?: Record<string, string>; overrides?: CoreOptions['overrides']; settings?: FakeSettings; handler?: Parameters<typeof fakeRunner>[0]; host?: Partial<HostProbe> } = {}) {
  const root = tmp();
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const runner = fakeRunner(opts.handler ?? ((file, args) => (args[0] === '--version' ? ok(file.endsWith('node') ? 'v22.12.0\n' : '2.1.314 (Claude Code)\n') : undefined)));
  const settings = opts.settings ?? createFakeSettings();
  const svc = createEnvironmentsService({
    base: base(path.join(root, 'data')), settings, run: runner.run,
    overrides: { homeDir: home, captureScript: '/opt/ms/capture.mjs', nodeRuntime: { command: '/usr/bin/node', runAsNode: false }, ...opts.overrides },
    host: { platform: 'linux', env: { PATH: (opts.path ?? []).join(':'), ...opts.env }, ...opts.host },
  });
  return { root, home, svc, settings, ...runner };
}

describe('hostEnv', () => {
  it('follows the PoC detectEnv: win32 is win, WSL_DISTRO_NAME is wsl:<name>, anything else is posix', () => {
    const mk = (platform: NodeJS.Platform, env: Record<string, string>) => createEnvironmentsService({ base: base(tmp()), settings: createFakeSettings(), host: { platform, env } }).hostEnv();
    expect(mk('win32', {})).toBe('win');
    expect(mk('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe('wsl:Ubuntu');
    expect(mk('linux', {})).toBe('posix');
    expect(mk('darwin', {})).toBe('posix');
  });

  it('honours overrides.hostEnv', () => {
    expect(createEnvironmentsService({ base: base(tmp()), settings: createFakeSettings(), overrides: { hostEnv: 'wsl:Debian' }, host: { platform: 'linux', env: {} } }).hostEnv()).toBe('wsl:Debian');
  });
});

describe('Linux host: finding Claude Code', () => {
  it('describes the host environment when Claude is on PATH', async () => {
    const bin = tmp();
    const claude = exe(bin);
    const t = linux({ path: [bin] });
    const [info, ...rest] = await t.svc.list();
    expect(rest).toEqual([]);
    expect(info).toEqual({
      id: 'posix', label: 'Linux', available: true,
      claude: { path: claude, version: '2.1.314', error: null },
      node: { path: '/usr/bin/node', version: '22.12.0' },
      configDir: path.join(t.home, '.claude'), hooks: null, notes: [],
    });
    expect(t.calls.find((c) => c.file === claude)?.args).toEqual(['--version']);
  });

  it('says plainly that Claude was not found, and how to fix it', async () => {
    const t = linux({ path: [] });
    const [info] = await t.svc.list();
    expect(info.available).toBe(false);
    expect(info.claude).toEqual({ path: null, version: null, error: 'Claude Code was not found.' });
    expect(info.notes).toContain('Claude Code was not found. Install it from https://claude.com/product/claude-code, then press Refresh.');
    expect(await t.svc.claudeCommand('posix')).toBeNull();
  });

  it('prefers, in order: Settings > overrides.claudeBin > MINI_SUMMA_CLAUDE_BIN > PATH > the well-known folders', async () => {
    const t0 = tmp();
    const fromSettings = exe(path.join(t0, 'settings'));
    const fromOverride = exe(path.join(t0, 'override'));
    const fromEnv = exe(path.join(t0, 'env'));
    const onPath = exe(path.join(t0, 'path'));
    const root = tmp();
    const home = path.join(root, 'home');
    const known = exe(path.join(home, '.local', 'bin'));
    const settings = createFakeSettings({ sessions: { claudeCommand: fromSettings } });
    const runner = fakeRunner((_f, args) => (args[0] === '--version' ? ok('2.1.0\n') : undefined));
    const svc = createEnvironmentsService({
      base: base(path.join(root, 'data')), settings, run: runner.run,
      overrides: { homeDir: home, claudeBin: fromOverride, nodeRuntime: { command: '/usr/bin/node', runAsNode: false } },
      host: { platform: 'linux', env: { PATH: path.dirname(onPath), MINI_SUMMA_CLAUDE_BIN: fromEnv } },
    });
    const pick = async () => (await svc.list({ refresh: true }))[0].claude.path;
    expect(await pick()).toBe(fromSettings);
    fs.rmSync(fromSettings);
    expect(await pick()).toBe(fromOverride);
    fs.rmSync(fromOverride);
    expect(await pick()).toBe(fromEnv);
    fs.rmSync(fromEnv);
    expect(await pick()).toBe(onPath);
    fs.rmSync(onPath);
    expect(await pick()).toBe(known);
    fs.rmSync(known);
    expect((await svc.list({ refresh: true }))[0].claude.path).toBeNull();
  });

  it('notes a configured command that does not exist, and carries on with the usual places', async () => {
    const bin = tmp();
    const claude = exe(bin);
    const t = linux({ path: [bin], settings: createFakeSettings({ sessions: { claudeCommand: '/nowhere/claude' } }) });
    const [info] = await t.svc.list();
    expect(info.claude.path).toBe(claude);
    expect(info.available).toBe(true);
    expect(info.notes).toEqual(['The Claude command set in Settings (/nowhere/claude) was not found, so Mini-Summa looked in the usual places instead.']);
  });

  it('does not quietly replace a configured command that exists but does not start', async () => {
    const bin = tmp();
    exe(bin);
    const broken = exe(tmp(), 'my-claude');
    const t = linux({
      path: [bin], settings: createFakeSettings({ sessions: { claudeCommand: broken } }),
      handler: (file, args) => (args[0] === '--version' ? (file === broken ? fail('segfault') : ok('2.1.0')) : undefined),
    });
    const [info] = await t.svc.list();
    expect(info.available).toBe(false);
    expect(info.claude).toEqual({ path: broken, version: null, error: 'segfault.' });
    expect(info.notes[0]).toMatch(/set in Settings .* did not start: segfault\. Check it in a terminal, or clear the setting/);
    expect(await t.svc.claudeCommand('posix')).toBeNull();
  });

  it('resolves a bare command name from Settings through PATH', async () => {
    const bin = tmp();
    const claude = exe(bin, 'claude-nightly');
    const t = linux({ path: [bin], settings: createFakeSettings({ sessions: { claudeCommand: 'claude-nightly' } }) });
    expect((await t.svc.list())[0].claude.path).toBe(claude);
  });

  it('skips a broken executable on PATH when another known location works', async () => {
    const bin = tmp();
    const brokenOnPath = exe(bin);
    const root = tmp();
    const home = path.join(root, 'home');
    const good = exe(path.join(home, '.local', 'bin'));
    const runner = fakeRunner((file, args) => (args[0] === '--version' ? (file === brokenOnPath ? fail('bad CPU type') : ok('2.1.0')) : undefined));
    const svc = createEnvironmentsService({
      base: base(path.join(root, 'data')), settings: createFakeSettings(), run: runner.run,
      overrides: { homeDir: home, nodeRuntime: { command: '/usr/bin/node', runAsNode: false } }, host: { platform: 'linux', env: { PATH: bin } },
    });
    const [info] = await svc.list();
    expect(info.claude.path).toBe(good);
    expect(info.available).toBe(true);
  });

  it('reports a claude that was found but whose --version failed, with the reason', async () => {
    const bin = tmp();
    const claude = exe(bin);
    const t = linux({ path: [bin], handler: () => fail('error while loading shared libraries: libfoo.so', 127) });
    const [info] = await t.svc.list();
    expect(info.available).toBe(false);
    expect(info.claude.path).toBe(claude);
    expect(info.claude.error).toBe('error while loading shared libraries: libfoo.so.');
    expect(info.notes[0]).toContain(`Claude Code was found at ${claude} but did not start`);
  });

  it('times a version check out at 10 seconds', async () => {
    const bin = tmp();
    exe(bin);
    let seen = 0;
    const root = tmp();
    const svc = createEnvironmentsService({
      base: base(root), settings: createFakeSettings(), overrides: { nodeRuntime: { command: 'node', runAsNode: false }, homeDir: root },
      run: async (_f, _a, o) => { seen = o.timeoutMs; return { stdout: '2.1.0', stderr: '', code: 0 }; },
      host: { platform: 'linux', env: { PATH: bin } },
    });
    await svc.list();
    expect(seen).toBe(10_000);
  });
});

describe('Linux host: Node.js for the hooks', () => {
  it('uses overrides.nodeRuntime, and starts an Electron binary in run-as-node mode when probing it', async () => {
    const t = linux({
      overrides: { nodeRuntime: { command: '/opt/MiniSumma/MiniSumma', runAsNode: true } },
      handler: (_f, args, env) => (args[0] === '--version' ? ok(env?.ELECTRON_RUN_AS_NODE === '1' ? 'v22.12.0\n' : 'v39.0.0\n') : undefined),
    });
    const layout = await t.svc.layout('posix');
    expect(layout.runtime).toEqual({ command: '/opt/MiniSumma/MiniSumma', runAsNode: true, version: '22.12.0' });
    expect(t.calls.find((c) => c.file === '/opt/MiniSumma/MiniSumma')?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('inside Electron it is the app binary in run-as-node mode, with the embedded Node version and no process started', async () => {
    const t = linux({ overrides: { nodeRuntime: undefined }, host: { versions: { node: '22.18.0', electron: '39.1.0' }, execPath: '/opt/MiniSumma/MiniSumma' } });
    const layout = await t.svc.layout('posix');
    expect(layout.runtime).toEqual({ command: '/opt/MiniSumma/MiniSumma', runAsNode: true, version: '22.18.0' });
    expect(t.calls.some((c) => c.file === '/opt/MiniSumma/MiniSumma')).toBe(false);
    expect((await t.svc.list())[0].node).toEqual({ path: '/opt/MiniSumma/MiniSumma', version: '22.18.0' });
  });

  it('otherwise uses the absolute path of the node found on PATH', async () => {
    const bin = tmp();
    const node = exe(bin, 'node');
    const t = linux({ path: [bin], overrides: { nodeRuntime: undefined }, host: { versions: { node: '22.0.0' } } });
    const layout = await t.svc.layout('posix');
    expect(layout.runtime).toEqual({ command: node, runAsNode: false, version: '22.12.0' });
  });

  it('explains a missing Node.js: hooks cannot run, and the layout says so with runtime null', async () => {
    const t = linux({ path: [], overrides: { nodeRuntime: undefined }, host: { versions: { node: '22.0.0' } } });
    const [info] = await t.svc.list();
    expect(info.node).toEqual({ path: null, version: null });
    expect(info.notes).toContain('Node.js was not found, so hooks cannot run here. Install Node.js from https://nodejs.org, then press Refresh.');
    expect((await t.svc.layout('posix')).runtime).toBeNull();
  });
});

describe('layout', () => {
  it('puts the spool under <dataDir>/spool/<tag> and shares one registry file', async () => {
    const t = linux({ env: { CLAUDE_CONFIG_DIR: '/custom/claude-config' } });
    const layout = await t.svc.layout('posix');
    expect(layout).toEqual({
      env: 'posix',
      spoolDirHost: path.join(t.root, 'data', 'spool', 'posix'), registryFileHost: path.join(t.root, 'data', 'registry.json'),
      spoolDirInEnv: path.join(t.root, 'data', 'spool', 'posix'), registryFileInEnv: path.join(t.root, 'data', 'registry.json'),
      captureScriptInEnv: '/opt/ms/capture.mjs', runtime: { command: '/usr/bin/node', runAsNode: false, version: '22.12.0' },
      configDirHost: '/custom/claude-config', configDirInEnv: '/custom/claude-config',
    });
  });

  it('defaults the Claude config directory to ~/.claude', async () => {
    const t = linux();
    expect((await t.svc.layout('posix')).configDirHost).toBe(path.join(t.home, '.claude'));
  });

  it('finds the capture script itself when nothing overrides it: the built hook, else the source script', async () => {
    const t = linux({ overrides: { captureScript: undefined } });
    const script = (await t.svc.layout('posix')).captureScriptInEnv;
    expect(fs.existsSync(script)).toBe(true);
    expect(script).toMatch(/claude-integration[\\/](dist[\\/]capture\.mjs|src[\\/]hook[\\/]capture\.mjs)$/);
  });

  it('gives the host layout without waiting for a slow Claude version check (startup must not hang on it)', async () => {
    const bin = tmp();
    const claude = exe(bin);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const root = tmp();
    const svc = createEnvironmentsService({
      base: base(path.join(root, 'data')), settings: createFakeSettings(), overrides: { homeDir: root, captureScript: '/opt/ms/capture.mjs', nodeRuntime: { command: 'node', runAsNode: false } },
      run: async (file, args) => {
        if (file === claude && args[0] === '--version') await gate;
        return { stdout: file === claude ? '2.1.0\n' : 'v22.0.0\n', stderr: '', code: 0 };
      },
      host: { platform: 'linux', env: { PATH: bin } },
    });
    const layout = await svc.layout('posix'); // returns while the version check is still hanging
    expect(layout.runtime).toMatchObject({ command: 'node', version: '22.0.0' });
    let listed = false;
    const list = svc.list().then((l) => { listed = true; return l; });
    await new Promise((r) => setTimeout(r, 50));
    expect(listed).toBe(false); // the full description does wait for it
    release();
    expect((await list)[0]).toMatchObject({ available: true, claude: { version: '2.1.0' } });
  });

  it('refuses an environment it does not know: layout() rejects with 404, claudeCommand() answers null', async () => {
    const t = linux();
    await expect(t.svc.layout('win')).rejects.toMatchObject({ status: 404, code: 'unknown_environment' });
    await expect(t.svc.layout('wsl:Ubuntu')).rejects.toBeInstanceOf(CoreError);
    expect(await t.svc.claudeCommand('wsl:Ubuntu')).toBeNull();
  });

  it('hands out copies: changing a result does not change the cache', async () => {
    const t = linux();
    const a = await t.svc.layout('posix');
    a.spoolDirHost = '/tampered';
    const notes = (await t.svc.list())[0].notes.length;
    (await t.svc.list())[0].notes.push('x');
    expect((await t.svc.layout('posix')).spoolDirHost).not.toBe('/tampered');
    expect((await t.svc.list())[0].notes).toHaveLength(notes);
  });
});

describe('caching and refresh', () => {
  it('probes once, serves later calls from the cache and probes again only on refresh', async () => {
    const bin = tmp();
    exe(bin);
    const t = linux({ path: [bin] });
    await t.svc.list();
    const first = t.calls.length;
    expect(first).toBeGreaterThan(0);
    await t.svc.list();
    await t.svc.layout('posix');
    await t.svc.claudeCommand('posix');
    expect(t.calls.length).toBe(first);
    await t.svc.list({ refresh: true });
    expect(t.calls.length).toBe(first * 2);
  });

  it('shares one probe between concurrent callers', async () => {
    const bin = tmp();
    exe(bin);
    const t = linux({ path: [bin] });
    await Promise.all([t.svc.list(), t.svc.list(), t.svc.layout('posix'), t.svc.claudeCommand('posix')]);
    expect(t.calls.filter((c) => c.args[0] === '--version' && !c.file.endsWith('node')).length).toBe(1);
  });

  it('picks up a newly installed Claude after a refresh, and a changed Settings command without one', async () => {
    const bin = tmp();
    const t = linux({ path: [bin] });
    expect((await t.svc.list())[0].available).toBe(false);
    exe(bin);
    expect((await t.svc.list())[0].available).toBe(false); // still the cached answer
    expect((await t.svc.list({ refresh: true }))[0].available).toBe(true);

    const custom = exe(tmp(), 'my-claude');
    t.settings.update({ sessions: { claudeCommand: custom } });
    expect((await t.svc.list())[0].claude.path).toBe(custom);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Windows and WSL, through an injected runner and file system. NOT TESTED on a real Windows host.

const WIN_DATA = 'C:\\Users\\me\\AppData\\Roaming\\Mini-Summa\\data';
const WSL_DATA = '/mnt/c/Users/me/AppData/Roaming/Mini-Summa/data';
const utf16 = (text: string, bom = true): Buffer => Buffer.from(`${bom ? '\uFEFF' : ''}${text}`, 'utf16le');

interface Distro { claude?: 'ok' | 'missing' | 'login-only' | 'broken'; node?: boolean; home?: string | null; wslpath?: boolean; down?: boolean }

function windows(distros: Record<string, Distro>, opts: { listing?: (() => Partial<CommandResult>) | null; files?: string[]; env?: Record<string, string>; dataDir?: string; settings?: FakeSettings } = {}) {
  const files = new Set(opts.files ?? []);
  const handler = (file: string, args: string[]): Partial<CommandResult> | undefined => {
    if (/claude\.(exe|cmd)$/i.test(file) && args[0] === '--version') return ok('2.1.314 (Claude Code)\n');
    if (file === 'cmd.exe' && args[0] === '/d' && args[1] === '/c' && /claude\.(cmd|bat)$/i.test(args[2]) && args[3] === '--version') return ok('2.1.314 (Claude Code)\r\n');
    if (/node\.exe$/i.test(file) && args[0] === '--version') return ok('v22.12.0\r\n');
    if (file === 'wsl.exe' && args[0] === '-l') {
      if (opts.listing === null) return { code: null, error: 'wsl.exe was not found.' };
      if (opts.listing) return opts.listing();
      return { stdout: decodeCommandOutput(utf16(`${Object.keys(distros).join('\r\n')}\r\ndocker-desktop\r\ndocker-desktop-data\r\n`)), code: 0 };
    }
    if (file === 'wsl.exe' && args[0] === '-d' && args[2] === '--exec') {
      const d = distros[args[1]];
      if (!d) return fail('There is no distribution with the supplied name.', 1);
      if (d.down) return { code: null, error: 'Timed out after 20 seconds.' };
      const [cmd, ...rest] = args.slice(3);
      const script = rest[rest.length - 1];
      if (cmd === 'claude' && rest[0] === '--version') return d.claude === 'ok' ? ok('2.1.314 (Claude Code)\n') : d.claude === 'broken' ? fail('Illegal instruction', 132) : fail('execvpe(claude) failed: No such file or directory');
      if (cmd === 'node' && rest[0] === '--version') return d.node === false ? fail('execvpe(node) failed: No such file or directory') : ok('v22.12.0\n');
      if (cmd === 'sh' && rest[0] === '-c' && script === 'command -v claude') return d.claude === 'ok' || d.claude === 'broken' ? ok('/home/me/.local/bin/claude\n') : fail('', 1);
      if (cmd === 'sh' && rest[0] === '-lc' && script === 'command -v claude') return d.claude === 'login-only' ? ok('/home/me/.local/bin/claude\n') : fail('', 1);
      if (cmd === 'sh' && script === 'printf %s "$HOME"') return d.home === null ? fail('', 1) : ok(d.home ?? '/home/me');
      if (cmd === 'wslpath' && rest[0] === '-u') {
        if (d.wslpath === false) return fail('wslpath: not found', 127);
        const converted = windowsPathToWsl(rest[1], { distro: args[1] });
        return converted ? ok(`${converted}\n`) : fail('wslpath: invalid path', 1);
      }
    }
    return undefined;
  };
  const runner = fakeRunner(handler);
  const settings = opts.settings ?? createFakeSettings();
  const svc = createEnvironmentsService({
    base: base(opts.dataDir ?? WIN_DATA), settings, run: runner.run,
    overrides: { captureScript: 'C:\\app\\resources\\capture.mjs', nodeRuntime: { command: 'C:\\Program Files\\nodejs\\node.exe', runAsNode: false } },
    host: { platform: 'win32', env: { PATH: 'C:\\Windows;C:\\Tools', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ...opts.env }, homeDir: 'C:\\Users\\me', fileExists: (p) => files.has(p) },
  });
  return { svc, settings, ...runner };
}

describe('WSL listing', () => {
  it('decodes wsl.exe output (UTF-16LE with a byte order mark and CR LF), skips docker-desktop*, and lists the host first', async () => {
    const t = windows({ Ubuntu: { claude: 'ok' }, Debian: { claude: 'ok' } }, { files: ['C:\\Tools\\claude.exe'] });
    const envs = await t.svc.list();
    expect(envs.map((e) => [e.id, e.label])).toEqual([['win', 'Windows'], ['wsl:Ubuntu', 'WSL (Ubuntu)'], ['wsl:Debian', 'WSL (Debian)']]);
    expect(t.calls.find((c) => c.file === 'wsl.exe' && c.args[0] === '-l')?.args).toEqual(['-l', '-q']);
    expect(envs.some((e) => e.id.includes('docker'))).toBe(false);
  });

  it('parses every shape of the listing: with and without a BOM, NULs left by a naive decode, a Default marker, blank lines', () => {
    expect(parseWslDistroList(decodeCommandOutput(utf16('Ubuntu\r\ndocker-desktop\r\nDebian\r\n')))).toEqual(['Ubuntu', 'Debian']);
    expect(parseWslDistroList(decodeCommandOutput(utf16('Ubuntu\r\nDebian\r\n', false)))).toEqual(['Ubuntu', 'Debian']);
    expect(parseWslDistroList(utf16('Ubuntu\r\nDebian\r\n').toString('utf8'))).toEqual(['Ubuntu', 'Debian']); // undecoded: NULs and U+FFFD left in
    expect(parseWslDistroList('Ubuntu (Default)\n\n  Debian  \nDocker-Desktop-Data\nUbuntu\n')).toEqual(['Ubuntu', 'Debian']);
    expect(parseWslDistroList('')).toEqual([]);
  });

  it('lists only the Windows host when wsl.exe is not installed or cannot list', async () => {
    expect((await windows({}, { listing: null }).svc.list()).map((e) => e.id)).toEqual(['win']);
    expect((await windows({}, { listing: () => ({ stdout: 'Windows Subsystem for Linux has no installed distributions.', code: 1 }) }).svc.list()).map((e) => e.id)).toEqual(['win']);
  });

  it('does not list WSL at all when the core itself runs inside WSL (that distribution is the host)', async () => {
    const runner = fakeRunner((_f, args) => (args[0] === '--version' ? ok('2.1.0') : undefined));
    const svc = createEnvironmentsService({
      base: base(tmp()), settings: createFakeSettings(), run: runner.run, overrides: { homeDir: tmp(), nodeRuntime: { command: 'node', runAsNode: false } },
      host: { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu', PATH: '' } },
    });
    expect((await svc.list()).map((e) => e.id)).toEqual(['wsl:Ubuntu']);
    expect(runner.calls.some((c) => c.file === 'wsl.exe')).toBe(false);
    expect((await svc.layout('wsl:Ubuntu')).spoolDirHost).toMatch(/spool[\\/]wsl-Ubuntu$/);
  });

  it('keeps a distribution whose name Mini-Summa cannot use out of the list and says why', async () => {
    const t = windows({}, { listing: () => ({ stdout: 'Ubuntu\r\nMy Distro\r\n', code: 0 }) });
    const [host] = await t.svc.list();
    expect(host.notes.join(' ')).toContain('The WSL distribution "My Distro" has characters Mini-Summa cannot use');
  });
});

describe('a WSL distribution', () => {
  it('has Claude, Node.js, a config directory and a layout reached through /mnt/<drive>', async () => {
    const t = windows({ Ubuntu: { claude: 'ok' } });
    const ubuntu = (await t.svc.list()).find((e) => e.id === 'wsl:Ubuntu')!;
    expect(ubuntu).toEqual({
      id: 'wsl:Ubuntu', label: 'WSL (Ubuntu)', available: true,
      claude: { path: '/home/me/.local/bin/claude', version: '2.1.314', error: null },
      node: { path: 'node', version: '22.12.0' },
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude', hooks: null, notes: [],
    });
    expect(await t.svc.layout('wsl:Ubuntu')).toEqual({
      env: 'wsl:Ubuntu',
      spoolDirHost: `${WIN_DATA}\\spool\\wsl-Ubuntu`, registryFileHost: `${WIN_DATA}\\registry.json`,
      spoolDirInEnv: `${WSL_DATA}/spool/wsl-Ubuntu`, registryFileInEnv: `${WSL_DATA}/registry.json`,
      captureScriptInEnv: '/mnt/c/app/resources/capture.mjs', runtime: { command: 'node', runAsNode: false, version: '22.12.0' },
      configDirHost: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude', configDirInEnv: '/home/me/.claude',
    });
  });

  it('hands callers the command to run INSIDE the distribution plus the distribution name (the terminal host builds the wsl.exe line)', async () => {
    const t = windows({ Ubuntu: { claude: 'ok' } });
    expect(await t.svc.claudeCommand('wsl:Ubuntu')).toEqual({ file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' });
  });

  it('asks the distribution with the same non-login `--exec` it will later use to start Claude, and probes in parallel', async () => {
    const t = windows({ Ubuntu: { claude: 'ok' } });
    await t.svc.list();
    const forUbuntu = t.calls.filter((c) => c.file === 'wsl.exe' && c.args[0] === '-d');
    expect(forUbuntu.map((c) => c.args.slice(2).join(' '))).toEqual(expect.arrayContaining([
      '--exec claude --version', '--exec sh -c command -v claude', '--exec node --version', '--exec sh -c printf %s "$HOME"',
    ]));
    expect(forUbuntu.every((c) => c.args[1] === 'Ubuntu')).toBe(true);
  });

  it('explains missing Node.js inside the distribution: hooks cannot run there', async () => {
    const t = windows({ Debian: { claude: 'ok', node: false } });
    const debian = (await t.svc.list()).find((e) => e.id === 'wsl:Debian')!;
    expect(debian.available).toBe(true);
    expect(debian.node).toEqual({ path: null, version: null });
    expect(debian.notes).toEqual(['Node.js was not found inside Debian, so hooks cannot run there. Install Node.js in that distribution.']);
    expect((await t.svc.layout('wsl:Debian')).runtime).toBeNull();
  });

  it('explains missing Claude inside the distribution', async () => {
    const t = windows({ Debian: { claude: 'missing' } });
    const debian = (await t.svc.list()).find((e) => e.id === 'wsl:Debian')!;
    expect(debian.available).toBe(false);
    expect(debian.claude).toEqual({ path: null, version: null, error: 'Claude Code was not found.' });
    expect(debian.notes).toContain('Claude Code was not found inside Debian. Install it there from https://claude.com/product/claude-code, then press Refresh.');
    expect(await t.svc.claudeCommand('wsl:Debian')).toBeNull();
  });

  it('recognises Claude that only a login shell can find, and says how to make it reachable', async () => {
    const t = windows({ Ubuntu: { claude: 'login-only' } });
    const ubuntu = (await t.svc.list()).find((e) => e.id === 'wsl:Ubuntu')!;
    expect(ubuntu.available).toBe(false);
    expect(ubuntu.notes[0]).toBe('Claude Code is installed at /home/me/.local/bin/claude inside Ubuntu, but it is not on the PATH Mini-Summa starts it with. Make it available in /usr/local/bin (sudo ln -s /home/me/.local/bin/claude /usr/local/bin/claude), then press Refresh.');
  });

  it('reports a claude that is there but does not start', async () => {
    const t = windows({ Ubuntu: { claude: 'broken' } });
    const ubuntu = (await t.svc.list()).find((e) => e.id === 'wsl:Ubuntu')!;
    expect(ubuntu.available).toBe(false);
    expect(ubuntu.claude.path).toBe('/home/me/.local/bin/claude');
    expect(ubuntu.claude.error).toBe('Illegal instruction.');
  });

  it('says so when the distribution cannot be started at all', async () => {
    const t = windows({ Ubuntu: { down: true } });
    const ubuntu = (await t.svc.list()).find((e) => e.id === 'wsl:Ubuntu')!;
    expect(ubuntu.available).toBe(false);
    expect(ubuntu.notes[0]).toBe('Mini-Summa could not start Ubuntu: Timed out after 20 seconds. Open it once from the Start menu, then press Refresh.');
  });

  it('falls back to its own path conversion when wslpath is not available', async () => {
    const t = windows({ Ubuntu: { claude: 'ok', wslpath: false } });
    expect((await t.svc.layout('wsl:Ubuntu')).spoolDirInEnv).toBe(`${WSL_DATA}/spool/wsl-Ubuntu`);
  });

  it('cannot give a layout when the data folder is somewhere the distribution cannot reach, and the notes say so', async () => {
    const t = windows({ Ubuntu: { claude: 'ok', wslpath: false } }, { dataDir: '\\\\fileserver\\share\\ms' });
    const ubuntu = (await t.svc.list()).find((e) => e.id === 'wsl:Ubuntu')!;
    expect(ubuntu.notes.join(' ')).toContain('cannot reach Mini-Summa\'s data folder');
    await expect(t.svc.layout('wsl:Ubuntu')).rejects.toMatchObject({ status: 422, code: 'env_layout' });
    // the host environment is unaffected
    expect((await t.svc.layout('win')).spoolDirHost).toBe('\\\\fileserver\\share\\ms\\spool\\win');
  });

  it('is probed once per distribution, in the cache until a refresh', async () => {
    const t = windows({ Ubuntu: { claude: 'ok' }, Debian: { claude: 'ok' } });
    await t.svc.list();
    const n = t.calls.length;
    await t.svc.list();
    await t.svc.layout('wsl:Debian');
    expect(t.calls.length).toBe(n);
    await t.svc.list({ refresh: true });
    expect(t.calls.length).toBe(n * 2);
  });

  it('matches a distribution name regardless of case, like wsl.exe does', async () => {
    const t = windows({ Ubuntu: { claude: 'ok' } });
    await expect(t.svc.layout('wsl:ubuntu')).resolves.toMatchObject({ env: 'wsl:Ubuntu' });
  });
});

describe('Windows host: finding Claude Code', () => {
  it('looks for claude.exe on PATH before claude.cmd', async () => {
    const t = windows({}, { files: ['C:\\Windows\\claude.cmd', 'C:\\Tools\\claude.exe'], listing: null });
    expect((await t.svc.list())[0].claude).toEqual({ path: 'C:\\Tools\\claude.exe', version: '2.1.314', error: null });
  });

  it('starts a .cmd shim through cmd.exe for the version check, and hands it out as the shim itself', async () => {
    const t = windows({}, { files: ['C:\\Windows\\claude.cmd'], listing: null });
    const [info] = await t.svc.list();
    expect(info.claude).toEqual({ path: 'C:\\Windows\\claude.cmd', version: '2.1.314', error: null });
    expect(t.calls.find((c) => c.file === 'cmd.exe')?.args).toEqual(['/d', '/c', 'C:\\Windows\\claude.cmd', '--version']);
    expect(await t.svc.claudeCommand('win')).toEqual({ file: 'C:\\Windows\\claude.cmd', prefixArgs: [], wslDistro: null });
  });

  it('knows the well-known install folders: ~\\.local\\bin and the npm global bin', async () => {
    const native = windows({}, { files: ['C:\\Users\\me\\.local\\bin\\claude.exe'], listing: null });
    expect((await native.svc.list())[0].claude).toMatchObject({ path: 'C:\\Users\\me\\.local\\bin\\claude.exe', version: '2.1.314' });
    const npm = windows({}, { files: ['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'], listing: null });
    expect((await npm.svc.list())[0].claude).toMatchObject({ path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', version: '2.1.314' });
    expect(npm.calls.some((c) => c.file === 'cmd.exe')).toBe(true);
  });

  it('lays out the host environment with Windows paths and the Windows config directory', async () => {
    const t = windows({}, { listing: null });
    expect(await t.svc.layout('win')).toMatchObject({
      env: 'win', spoolDirHost: `${WIN_DATA}\\spool\\win`, spoolDirInEnv: `${WIN_DATA}\\spool\\win`, registryFileHost: `${WIN_DATA}\\registry.json`,
      configDirHost: 'C:\\Users\\me\\.claude', captureScriptInEnv: 'C:\\app\\resources\\capture.mjs',
    });
  });
});

describe('path conversion between a Windows host and WSL', () => {
  const table: [string, string | null, { distro?: string; automount?: string }?][] = [
    ['C:\\Users\\me\\Mini Summa', '/mnt/c/Users/me/Mini Summa'],
    ['c:/Users/me/x', '/mnt/c/Users/me/x'],
    ['D:\\', '/mnt/d'],
    ['D:', '/mnt/d'],
    ['E:\\a\\..\\b\\.\\c', '/mnt/e/b/c'],
    ['C:\\trailing\\', '/mnt/c/trailing'],
    ['C:\\Case\\Kept', '/mnt/c/Case/Kept'],
    ['\\\\?\\C:\\long\\path', '/mnt/c/long/path'],
    ['C:\\x', '/c/x', { automount: '/' }],
    ['C:\\x', '/win/c/x', { automount: '/win' }],
    ['\\\\wsl.localhost\\Ubuntu\\home\\me\\x', '/home/me/x', { distro: 'Ubuntu' }],
    ['\\\\wsl$\\ubuntu\\home\\me', '/home/me', { distro: 'Ubuntu' }],
    ['\\\\wsl.localhost\\Ubuntu', '/', { distro: 'Ubuntu' }],
    ['\\\\wsl.localhost\\Ubuntu\\home\\me', null, { distro: 'Debian' }],
    ['\\\\wsl.localhost\\Ubuntu\\home\\me', null],
    ['\\\\fileserver\\share\\x', null],
    ['relative\\path', null],
    ['/already/posix', null],
    ['', null],
  ];
  it.each(table)('%s -> %s', (input, expected, opts) => {
    expect(windowsPathToWsl(input, opts)).toBe(expected);
  });

  it('goes the other way for a path inside a distribution', () => {
    expect(wslPathToWindows('Ubuntu', '/home/me/.claude')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude');
    expect(wslPathToWindows('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu');
  });

  it('names the spool directory after the environment', () => {
    expect(envTag('win')).toBe('win');
    expect(envTag('posix')).toBe('posix');
    expect(envTag('wsl:Ubuntu-22.04')).toBe('wsl-Ubuntu-22.04');
  });
});

describe('command output and the default runner', () => {
  it('decodes UTF-16LE with and without a byte order mark, UTF-16BE, UTF-8 with and without a BOM, and passes strings through', () => {
    expect(decodeCommandOutput(utf16('Ubuntu\r\n'))).toBe('Ubuntu\r\n');
    expect(decodeCommandOutput(utf16('Ubuntu\r\n', false))).toBe('Ubuntu\r\n');
    const be = Buffer.from('\uFEFFUbuntu', 'utf16le').swap16();
    expect(decodeCommandOutput(be)).toBe('Ubuntu');
    expect(decodeCommandOutput(Buffer.from('\uFEFFhello', 'utf8'))).toBe('hello');
    expect(decodeCommandOutput(Buffer.from('plain text, ünïcode', 'utf8'))).toBe('plain text, ünïcode');
    expect(decodeCommandOutput('already text')).toBe('already text');
    expect(decodeCommandOutput(new Uint8Array(0))).toBe('');
    expect(decodeCommandOutput(null)).toBe('');
  });

  it('reads versions out of whatever the tool prints', () => {
    expect(parseVersion('2.1.314 (Claude Code)\n')).toBe('2.1.314');
    expect(parseVersion('v22.12.0\r\n')).toBe('22.12.0');
    expect(parseVersion('\n\n10.9.2-beta.1 extra')).toBe('10.9.2-beta.1');
    expect(parseVersion('weird output')).toBe('weird output');
    expect(parseVersion('  \n ')).toBeNull();
  });

  it('runs a real process and decodes UTF-16LE output exactly like a wsl.exe listing', async () => {
    const script = "process.stdout.write(Buffer.from('\\ufeffUbuntu\\r\\ndocker-desktop\\r\\nDebian\\r\\n', 'utf16le'))";
    const r = await defaultCommandRunner(process.execPath, ['-e', script], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 0, stdout: 'Ubuntu\r\ndocker-desktop\r\nDebian\r\n' });
    expect(parseWslDistroList(r.stdout)).toEqual(['Ubuntu', 'Debian']);
  });

  it('reports a failing exit code, a missing program and a timeout as results, never as exceptions', async () => {
    expect(await defaultCommandRunner(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], { timeoutMs: 10_000 })).toMatchObject({ code: 3, stderr: expect.stringContaining('boom') });
    const missing = await defaultCommandRunner('/definitely/not/here/claude', [], { timeoutMs: 10_000 });
    expect(missing.code).toBeNull();
    expect(missing.error).toContain('was not found');
    const slow = await defaultCommandRunner(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 });
    expect(slow.code).toBeNull();
    expect(slow.error).toMatch(/Timed out/);
  });

  it('passes extra environment variables to the process and keeps the rest', async () => {
    const r = await defaultCommandRunner(process.execPath, ['-e', 'process.stdout.write((process.env.MS_TEST_FOO ?? "") + "|" + (process.env.PATH ? "path" : "nopath"))'], { timeoutMs: 10_000, env: { MS_TEST_FOO: 'bar' } });
    expect(r.stdout).toBe('bar|path');
  });
});
