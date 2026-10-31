import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../src/claude/managed.ts';
import { buildLaunchPlan } from '../../src/claude/ptyHost.ts';
import { CoreError } from '../../src/errors.ts';
import { hostPathToEnvPath, planManagedSettings } from '../../src/claude/settingsFile.ts';
import type { EnvLayout } from '../../src/contracts.ts';

// How a Claude command line is turned into a PTY launch. All pure string work: the Windows and WSL cases are compared as
// strings on Linux and have NOT been run on Windows.

const SESSION = '5d1a9a41-24c0-4b93-8c6a-93e2d9a9c001';
const hostCwd = 'C:\\Users\\me\\AppData\\Roaming\\MiniSumma';

describe('buildLaunchPlan: native', () => {
  it('runs the executable with the arguments as an array and the session folder as cwd', () => {
    const plan = buildLaunchPlan({
      claude: { file: '/usr/local/bin/claude', prefixArgs: [], wslDistro: null },
      claudeArgs: ['--session-id', SESSION], cwd: '/work/app', hostCwd: '/data', platform: 'linux',
    });
    expect(plan).toEqual({ file: '/usr/local/bin/claude', args: ['--session-id', SESSION], cwd: '/work/app' });
  });

  it('puts wrapper arguments before the Claude arguments (node + script, for the fake CLI and wrapped installs)', () => {
    const plan = buildLaunchPlan({
      claude: { file: '/usr/bin/node', prefixArgs: ['/opt/fake/fake-claude.mjs', '--fake-state-dir', '/state'], wslDistro: null },
      claudeArgs: ['--resume', SESSION], cwd: '/work', hostCwd: '/data', platform: 'linux',
    });
    expect(plan.args).toEqual(['/opt/fake/fake-claude.mjs', '--fake-state-dir', '/state', '--resume', SESSION]);
  });

  it('starts a native Windows claude.exe directly, arguments as an array (node-pty quotes them)', () => {
    const plan = buildLaunchPlan({
      claude: { file: 'C:\\Users\\me\\.local\\bin\\claude.exe', prefixArgs: [], wslDistro: null },
      claudeArgs: ['--session-id', SESSION, '--name', 'Fix login'], cwd: 'C:\\Dev\\App', hostCwd, platform: 'win32',
    });
    expect(plan).toEqual({
      file: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      args: ['--session-id', SESSION, '--name', 'Fix login'],
      cwd: 'C:\\Dev\\App',
    });
  });
});

describe('buildLaunchPlan: Windows .cmd shim (npm installs)', () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
  const settings = 'C:\\Users\\me\\AppData\\Roaming\\Mini Summa\\managed-settings\\win\\abc.json';

  it('goes through cmd.exe as ONE verbatim command line: /d /s /c "<shim> <args>"', () => {
    const plan = buildLaunchPlan({
      claude: { file: shim, prefixArgs: [], wslDistro: null },
      claudeArgs: ['--session-id', 'abc', '--settings', settings, '--name', 'Fix login'], cwd: 'C:\\Dev\\App', hostCwd, platform: 'win32',
    });
    expect(plan.file).toBe('cmd.exe');
    expect(plan.cwd).toBe('C:\\Dev\\App');
    expect(plan.args).toBe(
      '/d /s /c "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd --session-id abc --settings "C:\\Users\\me\\AppData\\Roaming\\Mini Summa\\managed-settings\\win\\abc.json" --name "Fix login""',
    );
  });

  it('quotes a shim path that contains spaces', () => {
    const plan = buildLaunchPlan({
      claude: { file: 'C:\\Program Files\\nodejs\\claude.cmd', prefixArgs: [], wslDistro: null },
      claudeArgs: ['--session-id', 'abc'], cwd: 'C:\\Dev', hostCwd, platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.args).toBe('/d /s /c ""C:\\Program Files\\nodejs\\claude.cmd" --session-id abc"');
  });

  it('doubles a backslash run before a closing quote and quotes shell metacharacters', () => {
    const plan = buildLaunchPlan({
      claude: { file: shim, prefixArgs: [], wslDistro: null },
      claudeArgs: ['--add-dir', 'C:\\My Dir\\', '--name', 'a & b'], cwd: 'C:\\Dev', hostCwd, platform: 'win32',
    });
    expect(plan.args).toBe('/d /s /c "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd --add-dir "C:\\My Dir\\\\" --name "a & b""');
  });

  it.each(['say "hi"', '100%', 'two\nlines', '%PATH%'])('refuses an argument cmd.exe could misread: %j', (name) => {
    let error: unknown;
    try {
      buildLaunchPlan({ claude: { file: shim, prefixArgs: [], wslDistro: null }, claudeArgs: ['--name', name], cwd: 'C:\\Dev', hostCwd, platform: 'win32' });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe('unsafe_argument');
  });

  it('is not special on a platform where .cmd means nothing', () => {
    const plan = buildLaunchPlan({ claude: { file: '/tmp/claude.cmd', prefixArgs: [], wslDistro: null }, claudeArgs: ['--x'], cwd: '/w', hostCwd: '/d', platform: 'linux' });
    expect(plan).toEqual({ file: '/tmp/claude.cmd', args: ['--x'], cwd: '/w' });
  });
});

describe('buildLaunchPlan: WSL', () => {
  it('is exactly: wsl.exe -d <distro> --cd <cwd> --exec claude <args>, with the PTY itself started in a host folder', () => {
    const settingsInWsl = hostPathToEnvPath('wsl:Ubuntu', `${hostCwd}\\managed-settings\\wsl-Ubuntu\\${SESSION}.json`);
    expect(settingsInWsl).toBe(`/mnt/c/Users/me/AppData/Roaming/MiniSumma/managed-settings/wsl-Ubuntu/${SESSION}.json`);
    const claudeArgs = buildClaudeArgs({ mode: 'new', sessionId: SESSION, settingsPath: settingsInWsl, name: 'Fix login', remoteControl: false });
    const plan = buildLaunchPlan({
      claude: { file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' }, claudeArgs, cwd: '/home/me/app', hostCwd, platform: 'win32',
    });
    expect(plan).toEqual({
      file: 'wsl.exe',
      args: [
        '-d', 'Ubuntu', '--cd', '/home/me/app', '--exec', 'claude',
        '--session-id', SESSION,
        '--settings', `/mnt/c/Users/me/AppData/Roaming/MiniSumma/managed-settings/wsl-Ubuntu/${SESSION}.json`,
        '--name', 'Fix login',
      ],
      cwd: hostCwd,
    });
  });

  it('uses the claude path the environment resolved inside the distribution, and resumes with the same id', () => {
    const claudeArgs = buildClaudeArgs({ mode: 'resume', sessionId: SESSION, settingsPath: '/mnt/d/ms/s.json', name: null, remoteControl: true });
    const plan = buildLaunchPlan({
      claude: { file: '/home/me/.local/bin/claude', prefixArgs: [], wslDistro: 'Debian-12' }, claudeArgs, cwd: '/mnt/d/code/app', hostCwd, platform: 'win32',
    });
    expect(plan.args).toEqual(['-d', 'Debian-12', '--cd', '/mnt/d/code/app', '--exec', '/home/me/.local/bin/claude', '--resume', SESSION, '--settings', '/mnt/d/ms/s.json', '--remote-control']);
    expect(plan.file).toBe('wsl.exe');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SIMULATED: WSL through a login shell, and what node-pty's Windows command line does to the arguments.
//
// quoteLikeNodePty is a copy of argsToCommandLine from @lydell/node-pty-win32-x64 (lib/windowsPtyAgent.js), which turns the
// argument array into the one command line ConPTY starts. parseWindowsCommandLine is the CommandLineToArgvW rule that a
// program, and as far as is known wsl.exe for --exec, uses to take it apart again. Together they show that the arguments
// survive the round trip; they do NOT show how wsl.exe really parses its line (only a real WSL2 can).

function quoteLikeNodePty(file: string, args: string[]): string {
  const argv = [file, ...args];
  let result = '';
  for (let index = 0; index < argv.length; index++) {
    if (index > 0) result += ' ';
    const arg = argv[index];
    const lopsided = (arg[0] !== '"') !== (arg[arg.length - 1] !== '"');
    const noEnclosing = arg[0] !== '"' && arg[arg.length - 1] !== '"';
    const quote = arg === '' || ((arg.includes(' ') || arg.includes('\t')) && arg.length > 1 && (lopsided || noEnclosing));
    if (quote) result += '"';
    let backslashes = 0;
    for (const ch of arg) {
      if (ch === '\\') backslashes++;
      else if (ch === '"') { result += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; }
      else { result += '\\'.repeat(backslashes) + ch; backslashes = 0; }
    }
    result += quote ? '\\'.repeat(backslashes * 2) + '"' : '\\'.repeat(backslashes);
  }
  return result;
}

function parseWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let inQuote = false;
    while (i < line.length && (inQuote || (line[i] !== ' ' && line[i] !== '\t'))) {
      let backslashes = 0;
      while (line[i] === '\\') { backslashes++; i++; }
      if (line[i] === '"') {
        arg += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) arg += '"'; else inQuote = !inQuote;
        i++;
      } else {
        arg += '\\'.repeat(backslashes);
        if (i < line.length && (inQuote || (line[i] !== ' ' && line[i] !== '\t'))) arg += line[i++];
      }
    }
    out.push(arg);
  }
  return out;
}

describe('SIMULATED WSL: starting Claude through a login shell', () => {
  const login = { file: 'sh', prefixArgs: ['-lc', 'exec claude "$@"', 'claude'], wslDistro: 'Ubuntu' };
  const settings = `/mnt/c/Users/Zoë Müller/AppData/Roaming/Mini-Summa/data/managed-settings/wsl-Ubuntu/${SESSION}.json`;
  const plan = buildLaunchPlan({
    claude: login, cwd: '/home/zoë/my project', hostCwd, platform: 'win32', wslExe: 'C:\\Windows\\System32\\wsl.exe',
    claudeArgs: buildClaudeArgs({ mode: 'new', sessionId: SESSION, settingsPath: settings, name: 'Fix the login page', remoteControl: false }),
  });

  it('is wsl.exe -d <distro> --cd <cwd> --exec sh -lc \'exec claude "$@"\' claude <args>: the script is fixed, every variable part is an argument', () => {
    expect(plan.file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(plan.cwd).toBe(hostCwd);
    expect(plan.args).toEqual([
      '-d', 'Ubuntu', '--cd', '/home/zoë/my project', '--exec', 'sh', '-lc', 'exec claude "$@"', 'claude',
      '--session-id', SESSION, '--settings', settings, '--name', 'Fix the login page',
    ]);
    // the script is the same text whatever the arguments are
    const other = buildLaunchPlan({ claude: login, cwd: '/x', hostCwd, platform: 'win32', claudeArgs: ['--name', '$(rm -rf ~); `id`'] });
    expect((other.args as string[]).slice(0, 9)).toEqual(['-d', 'Ubuntu', '--cd', '/x', '--exec', 'sh', '-lc', 'exec claude "$@"', 'claude']);
  });

  it('arrives whole after node-pty\'s Windows quoting: spaces, non-ASCII, the quotes of the script', () => {
    const line = quoteLikeNodePty(plan.file, plan.args as string[]);
    expect(parseWindowsCommandLine(line)).toEqual([plan.file, ...(plan.args as string[])]);
    expect(line).toContain('"exec claude \\"$@\\""');
    expect(line).toContain(`"${settings}"`);
  });

  it('keeps a trailing backslash and an embedded quote of a value whole as well', () => {
    const args = ['-d', 'Ubuntu', '--exec', 'sh', '-lc', 'exec claude "$@"', 'claude', '--name', 'C:\\dir with space\\', '--x', 'say "hi" there'];
    expect(parseWindowsCommandLine(quoteLikeNodePty('wsl.exe', args))).toEqual(['wsl.exe', ...args]);
  });

  it('a plain command is unchanged', () => {
    const plain = buildLaunchPlan({ claude: { file: 'claude', prefixArgs: [], wslDistro: 'Ubuntu' }, cwd: '/home/me', hostCwd, platform: 'win32', claudeArgs: ['--resume', SESSION] });
    expect(plain.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/me', '--exec', 'claude', '--resume', SESSION]);
  });
});

describe('hostPathToEnvPath / planManagedSettings for WSL', () => {
  const wslLayout: EnvLayout = {
    env: 'wsl:Ubuntu',
    spoolDirHost: 'C:\\Users\\me\\AppData\\Roaming\\MiniSumma\\spool\\wsl-Ubuntu',
    registryFileHost: 'C:\\Users\\me\\AppData\\Roaming\\MiniSumma\\registry.json',
    spoolDirInEnv: '/mnt/c/Users/me/AppData/Roaming/MiniSumma/spool/wsl-Ubuntu',
    registryFileInEnv: '/mnt/c/Users/me/AppData/Roaming/MiniSumma/registry.json',
    captureScriptInEnv: '/mnt/c/Program Files/MiniSumma/resources/capture.mjs',
    runtime: { command: '/usr/bin/node', runAsNode: false, version: 'v22.12.0' },
    configDirHost: null, configDirInEnv: null,
  };

  it('converts Windows drive paths to /mnt/<drive>/... and \\\\wsl$ paths of the same distribution to the Linux path', () => {
    expect(hostPathToEnvPath('wsl:Ubuntu', 'D:\\Data\\x.json')).toBe('/mnt/d/Data/x.json');
    expect(hostPathToEnvPath('wsl:Ubuntu', 'c:/a//b/c.json')).toBe('/mnt/c/a/b/c.json');
    expect(hostPathToEnvPath('wsl:Ubuntu', '\\\\wsl$\\Ubuntu\\home\\me\\ms\\x.json')).toBe('/home/me/ms/x.json');
    expect(hostPathToEnvPath('wsl:Ubuntu', '\\\\wsl.localhost\\ubuntu\\tmp\\x.json')).toBe('/tmp/x.json');
    expect(hostPathToEnvPath('win', 'C:\\x\\y.json')).toBe('C:\\x\\y.json');
    expect(hostPathToEnvPath('posix', '/x/y.json')).toBe('/x/y.json');
  });

  it('refuses a data folder the distribution cannot reach', () => {
    expect(() => hostPathToEnvPath('wsl:Ubuntu', '\\\\wsl$\\Debian\\tmp\\x.json')).toThrow(CoreError);
    expect(() => hostPathToEnvPath('wsl:Ubuntu', '/tmp/linux-host-path.json')).toThrow(/cannot reach/);
  });

  it('plans the settings file under the data folder and tells Claude the /mnt path', () => {
    const plan = planManagedSettings({ layout: wslLayout, sessionId: SESSION, dataDir: 'C:\\Users\\me\\AppData\\Roaming\\MiniSumma' });
    expect(plan.tag).toBe('wsl-Ubuntu');
    expect(plan.hostPath).toBe(`C:\\Users\\me\\AppData\\Roaming\\MiniSumma\\managed-settings\\wsl-Ubuntu\\${SESSION}.json`);
    expect(plan.envPath).toBe(`/mnt/c/Users/me/AppData/Roaming/MiniSumma/managed-settings/wsl-Ubuntu/${SESSION}.json`);
    const command = plan.settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toBe(`"/usr/bin/node" "${wslLayout.captureScriptInEnv}" --spool "${wslLayout.spoolDirInEnv}" --registry "${wslLayout.registryFileInEnv}" --env wsl:Ubuntu --handler ms-managed SessionStart`);
  });

  it('SIMULATED: follows the mount root the distribution really uses (wsl.conf [automount] root), as wslpath reported it for the other paths', () => {
    const custom: EnvLayout = {
      ...wslLayout,
      spoolDirInEnv: '/windir/c/Users/me/AppData/Roaming/MiniSumma/spool/wsl-Ubuntu',
      registryFileInEnv: '/windir/c/Users/me/AppData/Roaming/MiniSumma/registry.json',
      captureScriptInEnv: '/windir/c/Program Files/MiniSumma/resources/capture.mjs',
    };
    const plan = planManagedSettings({ layout: custom, sessionId: SESSION.toUpperCase(), dataDir: 'C:\\Users\\me\\AppData\\Roaming\\MiniSumma' });
    expect(plan.envPath).toBe(`/windir/c/Users/me/AppData/Roaming/MiniSumma/managed-settings/wsl-Ubuntu/${SESSION}.json`);
    expect(plan.hostPath).toBe(`C:\\Users\\me\\AppData\\Roaming\\MiniSumma\\managed-settings\\wsl-Ubuntu\\${SESSION}.json`);
    // a layout whose spool path does not have the expected shape falls back to the default /mnt rule
    const odd = planManagedSettings({ layout: { ...wslLayout, spoolDirInEnv: '/somewhere/else' }, sessionId: SESSION, dataDir: 'C:\\Users\\me\\AppData\\Roaming\\MiniSumma' });
    expect(odd.envPath).toBe(`/mnt/c/Users/me/AppData/Roaming/MiniSumma/managed-settings/wsl-Ubuntu/${SESSION}.json`);
    // a data folder inside the distribution itself (\\wsl$\Ubuntu\...) stays a Linux path
    const inside: EnvLayout = { ...wslLayout, spoolDirInEnv: '/home/me/ms/spool/wsl-Ubuntu' };
    expect(planManagedSettings({ layout: inside, sessionId: SESSION, dataDir: '\\\\wsl$\\Ubuntu\\home\\me\\ms' }).envPath).toBe(`/home/me/ms/managed-settings/wsl-Ubuntu/${SESSION}.json`);
  });
});
