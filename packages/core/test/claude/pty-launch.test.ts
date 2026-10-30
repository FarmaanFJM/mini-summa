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
});
