import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, buildSettings } from '@minisumma/claude-integration';
import { CoreError } from '../../src/errors.ts';
import type { EnvLayout } from '../../src/contracts.ts';
import { MANAGED_HANDLER_ID, managedSettingsTag, planManagedSettings, writeManagedSettings } from '../../src/claude/settingsFile.ts';

const SESSION = '3c2f1d7e-9a44-4f0a-8d9e-0a9b7c6d5e41';
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-settings-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const layout = (over: Partial<EnvLayout> = {}): EnvLayout => ({
  env: 'posix',
  spoolDirHost: '/data/spool/posix', registryFileHost: '/data/registry.json',
  spoolDirInEnv: '/data/spool/posix', registryFileInEnv: '/data/registry.json',
  captureScriptInEnv: '/opt/minisumma/capture.mjs',
  runtime: { command: '/usr/bin/node', runAsNode: false, version: 'v22.12.0' },
  configDirHost: null, configDirInEnv: null,
  ...over,
});

describe('writeManagedSettings', () => {
  it('writes <dataDir>/managed-settings/<tag>/<sessionId>.json with mode 0600 and returns both views of the path', () => {
    const dataDir = tmp();
    const file = writeManagedSettings({ layout: layout(), sessionId: SESSION, dataDir });
    const expected = path.join(dataDir, 'managed-settings', 'posix', `${SESSION}.json`);
    expect(file.hostPath).toBe(expected);
    expect(file.envPath).toBe(expected);
    expect(file.tag).toBe('posix');
    expect(file.handlerId).toBe('ms-managed');
    expect(fs.statSync(expected).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(expected, 'utf8'))).toEqual(file.settings);
  });

  it('registers all nine events with the capture hook and the managed handler id', () => {
    const file = writeManagedSettings({ layout: layout(), sessionId: SESSION, dataDir: tmp() });
    const settings = JSON.parse(fs.readFileSync(file.hostPath, 'utf8')) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number; shell?: string }[] }[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual([...EVENTS].sort());
    expect(EVENTS).toHaveLength(9);
    for (const event of EVENTS) {
      const groups = settings.hooks[event];
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks).toHaveLength(1);
      const hook = groups[0].hooks[0];
      expect(hook.type).toBe('command');
      expect(hook.timeout).toBe(5);
      expect(hook.shell).toBeUndefined();
      expect(hook.command).toBe(`"/usr/bin/node" "/opt/minisumma/capture.mjs" --spool "/data/spool/posix" --registry "/data/registry.json" --env posix --handler ms-managed ${event}`);
    }
    expect(MANAGED_HANDLER_ID).toBe('ms-managed');
  });

  it('is exactly what the verified PoC builder produces for this layout', () => {
    const l = layout({ env: 'wsl:Ubuntu' });
    const plan = planManagedSettings({ layout: l, sessionId: SESSION, dataDir: 'C:\\MS' });
    expect(plan.settings).toEqual(buildSettings({
      env: 'wsl:Ubuntu', node: '/usr/bin/node', capture: '/opt/minisumma/capture.mjs', spool: '/data/spool/posix',
      registry: '/data/registry.json', handlers: ['ms-managed'], runAsNode: false,
    }));
  });

  it('uses the ELECTRON_RUN_AS_NODE form when the runtime is the app itself (runAsNode)', () => {
    const l = layout({ runtime: { command: '/opt/MiniSumma/mini-summa', runAsNode: true, version: 'v22.12.0' } });
    const plan = planManagedSettings({ layout: l, sessionId: SESSION, dataDir: tmp() });
    expect(plan.settings.hooks.Stop[0].hooks[0].command).toBe(
      'ELECTRON_RUN_AS_NODE=1 "/opt/MiniSumma/mini-summa" "/opt/minisumma/capture.mjs" --spool "/data/spool/posix" --registry "/data/registry.json" --env posix --handler ms-managed Stop',
    );
  });

  it('native Windows hooks run in PowerShell with the call operator and the runAsNode prefix', () => {
    const l = layout({
      env: 'win',
      spoolDirInEnv: 'C:\\MS\\spool\\win', registryFileInEnv: 'C:\\MS\\registry.json', captureScriptInEnv: 'C:\\MS\\capture.mjs',
      runtime: { command: 'C:\\Program Files\\MiniSumma\\MiniSumma.exe', runAsNode: true, version: 'v22.12.0' },
    });
    const plan = planManagedSettings({ layout: l, sessionId: SESSION, dataDir: 'C:\\MS' });
    expect(plan.tag).toBe('win');
    expect(plan.hostPath).toBe(`C:\\MS\\managed-settings\\win\\${SESSION}.json`);
    expect(plan.envPath).toBe(plan.hostPath);
    const hook = plan.settings.hooks.SessionStart[0].hooks[0];
    expect(hook.shell).toBe('powershell');
    expect(hook.command).toBe(
      "$env:ELECTRON_RUN_AS_NODE='1'; & \"C:\\Program Files\\MiniSumma\\MiniSumma.exe\" \"C:\\MS\\capture.mjs\" --spool \"C:\\MS\\spool\\win\" --registry \"C:\\MS\\registry.json\" --env win --handler ms-managed SessionStart | Write-Output",
    ); // the pipe makes PowerShell wait for the GUI-subsystem executable (SIMULATED: strings only)
  });

  it('refuses with no_hook_runtime (422) and a plain-language message when the environment has no Node, and writes nothing', () => {
    const dataDir = tmp();
    let error: unknown;
    try { writeManagedSettings({ layout: layout({ runtime: null }), sessionId: SESSION, dataDir }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).status).toBe(422);
    expect((error as CoreError).code).toBe('no_hook_runtime');
    expect((error as CoreError).message).toMatch(/Node\.js/);
    expect((error as CoreError).message).toMatch(/Linux/);
    expect(fs.existsSync(path.join(dataDir, 'managed-settings'))).toBe(false);
  });

  it('replaces an existing file for the same session (resume) and leaves no temporary files', () => {
    const dataDir = tmp();
    writeManagedSettings({ layout: layout(), sessionId: SESSION, dataDir });
    const second = writeManagedSettings({ layout: layout({ captureScriptInEnv: '/opt/new/capture.mjs' }), sessionId: SESSION, dataDir });
    expect(fs.readFileSync(second.hostPath, 'utf8')).toContain('/opt/new/capture.mjs');
    expect(fs.readdirSync(path.dirname(second.hostPath))).toEqual([`${SESSION}.json`]);
  });

  it('keeps environments apart on disk', () => {
    const dataDir = tmp();
    const a = writeManagedSettings({ layout: layout({ env: 'posix' }), sessionId: SESSION, dataDir });
    const b = writeManagedSettings({ layout: layout({ env: 'win', spoolDirInEnv: '/data/spool/win', captureScriptInEnv: '/opt/capture.mjs' }), sessionId: SESSION, dataDir });
    expect(path.dirname(a.hostPath)).not.toBe(path.dirname(b.hostPath));
    expect(path.basename(path.dirname(a.hostPath))).toBe('posix');
    expect(path.basename(path.dirname(b.hostPath))).toBe('win');
    expect(path.basename(a.hostPath)).toBe(path.basename(b.hostPath));
  });

  it('rejects a session id that is not a UUID, so it can never become a path', () => {
    for (const bad of ['../../etc/passwd', 'abc', '']) {
      expect(() => planManagedSettings({ layout: layout(), sessionId: bad, dataDir: '/data' })).toThrow(/not a valid UUID/);
    }
  });

  it('reports a hook path that is unsafe in a shell string instead of writing a broken hook', () => {
    let error: unknown;
    try { planManagedSettings({ layout: layout({ spoolDirInEnv: '/data/sp"ool' }), sessionId: SESSION, dataDir: '/data' }); } catch (e) { error = e; }
    expect((error as CoreError).code).toBe('unsafe_hook_path');
  });

  it('names directories after the environment: win, posix, wsl-<distro>', () => {
    expect(managedSettingsTag('win')).toBe('win');
    expect(managedSettingsTag('posix')).toBe('posix');
    expect(managedSettingsTag('wsl:Ubuntu-22.04')).toBe('wsl-Ubuntu-22.04');
    expect(managedSettingsTag('wsl:Weird Name')).toBe('wsl-Weird-Name');
  });
});
