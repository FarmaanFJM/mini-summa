import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS, buildSettings } from '@minisumma/claude-integration';
import { openDatabase } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import type { EnvId, EnvironmentInfo, HookPlan, ServerEvent } from '@minisumma/shared';
import { createEventBus } from '../../src/bus.ts';
import type { CoreBase, EnvLayout, EnvironmentsService } from '../../src/contracts.ts';
import { CoreError } from '../../src/errors.ts';
import { createHooksService, nodeHooksFs } from '../../src/infra/hooks.ts';
import type { HooksFs } from '../../src/infra/hooks.ts';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.close();
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const canon = (obj: unknown, indent: string | number = 2) => `${JSON.stringify(obj, null, indent)}\n`;
const NOW = Date.parse('2026-10-30T14:15:00.000Z');

function posixLayout(root: string, over: Partial<EnvLayout> = {}): EnvLayout {
  return {
    env: 'posix',
    spoolDirHost: '/data/ms/spool/posix', registryFileHost: '/data/ms/registry.json',
    spoolDirInEnv: '/data/ms/spool/posix', registryFileInEnv: '/data/ms/registry.json',
    captureScriptInEnv: '/opt/mini-summa/capture.mjs',
    runtime: { command: '/usr/bin/node', runAsNode: false, version: 'v22.12.0' },
    configDirHost: path.join(root, 'home', '.claude'), configDirInEnv: path.join(root, 'home', '.claude'),
    ...over,
  };
}

function fakeEnvironments(layouts: Record<string, EnvLayout>, available: Record<string, boolean> = {}): EnvironmentsService {
  const info = (id: string): EnvironmentInfo => ({
    id: id as EnvId, label: id, available: available[id] ?? true, claude: { path: null, version: null, error: null },
    node: { path: null, version: null }, configDir: layouts[id].configDirHost, hooks: null, notes: [],
  });
  return {
    hostEnv: () => 'posix',
    list: async () => Object.keys(layouts).map(info),
    layout: async (env) => { const l = layouts[env]; if (!l) throw new Error(`There is no environment ${env}.`); return l; },
    claudeCommand: async () => null,
  };
}

function setup(opts: { fs?: HooksFs; layouts?: (root: string) => Record<string, EnvLayout>; available?: Record<string, boolean> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-hooks-'));
  dirs.push(root);
  const dataDir = path.join(root, 'data');
  const layouts = (opts.layouts ?? ((r) => ({ posix: posixLayout(r) })))(root);
  const { db } = openDatabase(':memory:');
  dbs.push(db);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((_seq, e) => events.push(e));
  const logs: string[] = [];
  const log = { debug: () => undefined, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const base: CoreBase = { db, bus, clock: { now: () => new Date(NOW) }, log, version: 'test', mode: 'headless', dataDir };
  const service = createHooksService({ base, environments: fakeEnvironments(layouts, opts.available), fs: opts.fs });
  const claudeDir = path.join(root, 'home', '.claude');
  return { root, dataDir, claudeDir, settingsPath: path.join(claudeDir, 'settings.json'), layouts, db, bus, events, logs, service };
}
type Ctx = ReturnType<typeof setup>;

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file: string) => fs.readFileSync(file, 'utf8');
const rejection = async (p: Promise<unknown>): Promise<CoreError> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CoreError);
  return err as CoreError;
};
const handlerCount = (text: string) => (text.match(/--handler ms-user/g) ?? []).length;
const added = (diff: string) => diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
const removed = (diff: string) => diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));

const builtFor = (layout: EnvLayout, env: EnvId = 'posix') => buildSettings({
  env, node: layout.runtime!.command, capture: layout.captureScriptInEnv, spool: layout.spoolDirInEnv,
  registry: layout.registryFileInEnv, handlers: ['ms-user'], runAsNode: layout.runtime!.runAsNode,
});

const userSettings = () => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test)', 'Read(src/**)'], deny: ['Bash(rm -rf:*)'] },
  env: { EDITOR: 'vim' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop', timeout: 3 }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check.sh', timeout: 10 }] }],
    SubagentStop: [{ hooks: [{ type: 'command', command: 'echo sub' }] }],
  },
  statusLine: { type: 'command', command: 'echo status' },
});

// ---------------------------------------------------------------------------------------------------------------

describe('fresh install', () => {
  it('plans exactly what the PoC builder produces and writes it', async () => {
    const c = setup();
    const plan = await c.service.plan('posix', 'install');
    expect(plan.action).toBe('install');
    expect(plan.env).toBe('posix');
    expect(plan.settingsPath).toBe(c.settingsPath);
    expect(plan.before).toBe('');
    expect(plan.after).toBe(canon(builtFor(c.layouts.posix)));
    expect(JSON.parse(plan.after).hooks).toEqual(builtFor(c.layouts.posix).hooks);
    expect(Object.keys(JSON.parse(plan.after).hooks)).toEqual([...EVENTS]);
    expect(plan.planHash).toBe(sha256(`posixinstall${c.settingsPath}${plan.before}${plan.after}`));
    expect(plan.backupPath).toBe('');
    expect(plan.unifiedDiff.startsWith(`--- /dev/null\n+++ ${c.settingsPath}\n@@ -0,0 +1,`)).toBe(true);
    expect(removed(plan.unifiedDiff)).toEqual([]);
    expect(plan.warnings.some((w) => /does not exist yet/.test(w))).toBe(true);
    expect(plan.warnings.some((w) => /Configuration folder|configuration folder/.test(w))).toBe(true);
    expect(plan.warnings.some((w) => /own terminals/.test(w))).toBe(true);
    expect(plan.status).toMatchObject({ installed: false, settingsExists: false, events: [], missingEvents: [...EVENTS] });
    // planning writes nothing
    expect(fs.existsSync(c.claudeDir)).toBe(false);

    const status = await c.service.apply('posix', 'install', plan.planHash);
    expect(status).toMatchObject({ env: 'posix', installed: true, settingsExists: true, duplicateRegistrations: false, events: [...EVENTS], missingEvents: [], issues: [] });
    expect(status.runtime).toEqual({ command: '/usr/bin/node', kind: 'node', version: 'v22.12.0' });
    expect(status.captureScript).toBe('/opt/mini-summa/capture.mjs');
    expect(read(c.settingsPath)).toBe(plan.after);
    if (process.platform !== 'win32') expect(fs.statSync(c.settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(c.dataDir, 'backups'))).toBe(false);
  });

  it('records the install, emits hooks.changed and reports the status', async () => {
    const c = setup();
    const plan = await c.service.plan('posix', 'install');
    const status = await c.service.apply('posix', 'install', plan.planHash);
    expect(c.events).toEqual([{ type: 'hooks.changed', env: 'posix', status }]);
    expect(c.db.get('SELECT * FROM hook_installs WHERE env = ?', ['posix'])).toEqual({
      env: 'posix', settings_path: c.settingsPath, handler_id: 'ms-user', plan_hash: plan.planHash, backup_path: null, installed_at: '2026-10-30T14:15:00.000Z',
    });
    expect(await c.service.status('posix')).toEqual(status);
    expect(await c.service.list()).toEqual([status]);
  });

  it('is a plain install for an empty or whitespace-only file too', async () => {
    const c = setup();
    write(c.settingsPath, '  \n');
    const plan = await c.service.plan('posix', 'install');
    expect(plan.action).toBe('install');
    expect(JSON.parse(plan.after).hooks).toEqual(builtFor(c.layouts.posix).hooks);
    await c.service.apply('posix', 'install', plan.planHash);
    expect(JSON.parse(read(c.settingsPath)).hooks.Stop).toHaveLength(1);
  });
});

describe('existing user settings', () => {
  it('adds only our entries, keeps everything else and the order of keys, and undoes to the exact original bytes', async () => {
    const c = setup();
    const original = canon(userSettings());
    write(c.settingsPath, original);
    const plan = await c.service.plan('posix', 'install');
    expect(plan.action).toBe('install');
    expect(plan.before).toBe(original);
    // nothing of the user's is removed or changed: the diff only adds lines
    expect(removed(plan.unifiedDiff)).toEqual([]);
    expect(added(plan.unifiedDiff).length).toBeGreaterThan(40);

    const after = JSON.parse(plan.after);
    const user = userSettings();
    expect(Object.keys(after)).toEqual(Object.keys(user));
    for (const k of ['model', 'permissions', 'env', 'statusLine']) expect(after[k]).toEqual((user as Record<string, unknown>)[k]);
    expect(after.hooks.Stop[0]).toEqual(user.hooks.Stop[0]);
    expect(after.hooks.PreToolUse[0]).toEqual(user.hooks.PreToolUse[0]);
    expect(after.hooks.SubagentStop).toEqual(user.hooks.SubagentStop);
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.Stop[1]).toEqual(builtFor(c.layouts.posix).hooks.Stop[0]);
    expect(Object.keys(after.hooks).slice(0, 3)).toEqual(['Stop', 'PreToolUse', 'SubagentStop']);
    for (const e of EVENTS) expect(handlerCount(JSON.stringify(after.hooks[e]))).toBe(1);

    await c.service.apply('posix', 'install', plan.planHash);
    expect(read(c.settingsPath)).toBe(plan.after);
    const un = await c.service.plan('posix', 'uninstall');
    expect(un.action).toBe('uninstall');
    expect(added(un.unifiedDiff)).toEqual([]);
    await c.service.apply('posix', 'uninstall', un.planHash);
    expect(read(c.settingsPath)).toBe(original);
  });

  it('writes a backup that is a byte-for-byte copy of the original before changing it', async () => {
    const c = setup();
    const original = canon(userSettings());
    write(c.settingsPath, original);
    const plan = await c.service.plan('posix', 'install');
    expect(plan.backupPath).toBe(path.join(c.dataDir, 'backups', 'settings-posix-20261030T141500Z.json'));
    expect(fs.existsSync(plan.backupPath)).toBe(false);
    await c.service.apply('posix', 'install', plan.planHash);
    expect(read(plan.backupPath)).toBe(original);
    expect(read(c.settingsPath)).not.toBe(original);
    expect(c.db.get<{ backup_path: string }>('SELECT backup_path FROM hook_installs')?.backup_path).toBe(plan.backupPath);
  });

  it('tags the backup with the environment and never overwrites an earlier backup', async () => {
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    const first = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', first.planHash);
    const second = await c.service.plan('posix', 'uninstall');
    expect(second.backupPath).toBe(path.join(c.dataDir, 'backups', 'settings-posix-20261030T141500Z-2.json'));
    await c.service.apply('posix', 'uninstall', second.planHash);
    expect(fs.readdirSync(path.join(c.dataDir, 'backups')).sort()).toEqual(['settings-posix-20261030T141500Z-2.json', 'settings-posix-20261030T141500Z.json']);
  });

  it('writes the backup where the plan said even if apply runs a moment later', async () => {
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    const plan = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', plan.planHash);
    expect(fs.existsSync(plan.backupPath)).toBe(true);
  });

  it('keeps the file mode', async () => {
    if (process.platform === 'win32') return;
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    fs.chmodSync(c.settingsPath, 0o640);
    const plan = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', plan.planHash);
    expect(fs.statSync(c.settingsPath).mode & 0o777).toBe(0o640);
  });

  it('writes through a symlinked settings.json and leaves the link in place', async () => {
    if (process.platform === 'win32') return;
    const c = setup();
    const real = path.join(c.root, 'dotfiles', 'claude-settings.json');
    write(real, canon({ model: 'opus' }));
    fs.mkdirSync(c.claudeDir, { recursive: true });
    fs.symlinkSync(real, c.settingsPath);
    const plan = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', plan.planHash);
    expect(fs.lstatSync(c.settingsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(read(real)).hooks.Stop).toHaveLength(1);
    expect(JSON.parse(read(real)).model).toBe('opus');
  });
});

describe('installing twice', () => {
  it('plans a noop the second time, writes nothing and adds no duplicates', async () => {
    const c = setup();
    const first = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', first.planHash);
    const written = read(c.settingsPath);
    const mtime = fs.statSync(c.settingsPath).mtimeMs;
    const eventsBefore = c.events.length;

    const again = await c.service.plan('posix', 'install');
    expect(again).toMatchObject({ action: 'noop', unifiedDiff: '', backupPath: '', warnings: [] });
    expect(again.after).toBe(again.before);
    expect(again.status.installed).toBe(true);

    // applying a noop plan, or the old plan again, is fine and changes nothing
    for (const hash of [again.planHash, first.planHash, 'f'.repeat(64)]) {
      const status = await c.service.apply('posix', 'install', hash);
      expect(status.installed).toBe(true);
    }
    expect(read(c.settingsPath)).toBe(written);
    expect(fs.statSync(c.settingsPath).mtimeMs).toBe(mtime);
    expect(c.events.length).toBe(eventsBefore);
    expect(handlerCount(read(c.settingsPath))).toBe(EVENTS.length);
    expect(fs.existsSync(path.join(c.dataDir, 'backups'))).toBe(false);
  });

  it('stays exactly one entry per event after the same install is applied concurrently', async () => {
    const c = setup();
    const plan = await c.service.plan('posix', 'install');
    const results = await Promise.all([c.service.apply('posix', 'install', plan.planHash), c.service.apply('posix', 'install', plan.planHash), c.service.apply('posix', 'install', plan.planHash)]);
    expect(results.every((s) => s.installed && !s.duplicateRegistrations)).toBe(true);
    expect(handlerCount(read(c.settingsPath))).toBe(EVENTS.length);
    expect(c.events).toHaveLength(1);
  });

  it('uninstalling when nothing is installed is a noop too', async () => {
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    const plan = await c.service.plan('posix', 'uninstall');
    expect(plan.action).toBe('noop');
    expect((await c.service.apply('posix', 'uninstall', plan.planHash)).installed).toBe(false);
    expect(read(c.settingsPath)).toBe(canon(userSettings()));
    expect((await c.service.plan('posix', 'uninstall')).action).toBe('noop');
  });

  it('uninstalling when the file does not exist is a noop and creates nothing', async () => {
    const c = setup();
    const plan = await c.service.plan('posix', 'uninstall');
    expect(plan.action).toBe('noop');
    await c.service.apply('posix', 'uninstall', plan.planHash);
    expect(fs.existsSync(c.claudeDir)).toBe(false);
  });
});

describe('a stale or duplicated registration', () => {
  it('replaces it in place instead of adding a second one', async () => {
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    const first = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', first.planHash);
    const installed = JSON.parse(read(c.settingsPath));

    c.layouts.posix = posixLayout(c.root, { spoolDirInEnv: '/elsewhere/spool', registryFileInEnv: '/elsewhere/registry.json' });
    const status = await c.service.status('posix');
    expect(status.installed).toBe(true);
    expect(status.issues.join(' ')).toMatch(/differ from what this version would write/);

    const plan = await c.service.plan('posix', 'install');
    expect(plan.action).toBe('install');
    expect(removed(plan.unifiedDiff)).toHaveLength(EVENTS.length);
    expect(added(plan.unifiedDiff)).toHaveLength(EVENTS.length);
    expect(removed(plan.unifiedDiff).every((l) => l.includes('/data/ms/spool/posix'))).toBe(true);
    expect(added(plan.unifiedDiff).every((l) => l.includes('/elsewhere/spool'))).toBe(true);
    expect(plan.warnings.some((w) => /points somewhere else/.test(w))).toBe(true);

    await c.service.apply('posix', 'install', plan.planHash);
    const after = JSON.parse(read(c.settingsPath));
    for (const e of EVENTS) {
      expect(handlerCount(JSON.stringify(after.hooks[e]))).toBe(1);
      expect(JSON.stringify(after.hooks[e])).toContain('/elsewhere/spool');
      expect(JSON.stringify(after.hooks[e])).not.toContain('/data/ms/spool/posix');
    }
    // same positions, user entries untouched
    expect(after.hooks.Stop[0]).toEqual(installed.hooks.Stop[0]);
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.model).toBe('opus');
    expect((await c.service.status('posix')).issues).toEqual([]);
  });

  it('replaces a stale entry whose runtime or capture script moved', async () => {
    const c = setup();
    const plan = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', plan.planHash);
    c.layouts.posix = posixLayout(c.root, { runtime: { command: '/opt/node22/bin/node', runAsNode: false, version: 'v22.13.0' } });
    const next = await c.service.plan('posix', 'install');
    expect(next.action).toBe('install');
    await c.service.apply('posix', 'install', next.planHash);
    expect(read(c.settingsPath)).toContain('/opt/node22/bin/node');
    expect(read(c.settingsPath)).not.toContain('"/usr/bin/node"');
  });

  it('detects duplicate registrations and collapses them to one per event', async () => {
    const c = setup();
    const built = builtFor(c.layouts.posix);
    const doubled = structuredClone(built) as unknown as { hooks: Record<string, { hooks: unknown[] }[]> };
    doubled.hooks.Stop.push(structuredClone(doubled.hooks.Stop[0]));
    doubled.hooks.SessionStart[0].hooks.push(structuredClone(doubled.hooks.SessionStart[0].hooks[0]));
    write(c.settingsPath, canon(doubled));

    const status = await c.service.status('posix');
    expect(status.duplicateRegistrations).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.issues.join(' ')).toMatch(/Stop/);

    const plan = await c.service.plan('posix', 'install');
    expect(plan.action).toBe('install');
    expect(plan.warnings.some((w) => /More than one Mini-Summa hook is registered for Stop, SessionStart|SessionStart, Stop|Stop/.test(w))).toBe(true);
    await c.service.apply('posix', 'install', plan.planHash);
    const after = JSON.parse(read(c.settingsPath));
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect((await c.service.status('posix')).duplicateRegistrations).toBe(false);
  });
});

describe('uninstall', () => {
  it('removes only our entries, drops what it emptied, and keeps the user\'s own', async () => {
    const c = setup();
    const built = builtFor(c.layouts.posix);
    const mixed = userSettings() as ReturnType<typeof userSettings> & { hooks: Record<string, unknown[]> };
    // the user's Stop hook and ours share one matcher entry; ours also sits alone in other events
    mixed.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo user-stop' }, built.hooks.Stop[0].hooks[0]] }];
    for (const e of EVENTS.filter((x) => x !== 'Stop')) mixed.hooks[e] = [...(mixed.hooks[e] ?? []), built.hooks[e][0]];
    write(c.settingsPath, canon(mixed));

    const plan = await c.service.plan('posix', 'uninstall');
    expect(plan.action).toBe('uninstall');
    await c.service.apply('posix', 'uninstall', plan.planHash);
    const after = JSON.parse(read(c.settingsPath));
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'echo user-stop' }] }]);
    expect(after.hooks.PreToolUse).toEqual(userSettings().hooks.PreToolUse);
    expect(after.hooks.SubagentStop).toEqual(userSettings().hooks.SubagentStop);
    expect(Object.keys(after.hooks).sort()).toEqual(['PreToolUse', 'Stop', 'SubagentStop']);
    expect(handlerCount(read(c.settingsPath))).toBe(0);
    expect((await c.service.status('posix')).installed).toBe(false);
    expect(c.db.get('SELECT * FROM hook_installs')).toBeUndefined();
  });

  it('drops an emptied hooks object but leaves a hooks object that was already empty', async () => {
    const c = setup();
    write(c.settingsPath, canon({ model: 'opus' }));
    const install = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', install.planHash);
    const un = await c.service.plan('posix', 'uninstall');
    await c.service.apply('posix', 'uninstall', un.planHash);
    expect(read(c.settingsPath)).toBe(canon({ model: 'opus' }));

    write(c.settingsPath, canon({ model: 'opus', hooks: {} }));
    expect((await c.service.plan('posix', 'uninstall')).action).toBe('noop');
  });

  it('also removes our entries from events outside the nine that earlier versions may have used', async () => {
    const c = setup();
    const ours = builtFor(c.layouts.posix).hooks.Stop[0].hooks[0];
    write(c.settingsPath, canon({ hooks: { SubagentStop: [{ hooks: [{ ...ours, command: ours.command.replace(' Stop', ' SubagentStop') }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    const plan = await c.service.plan('posix', 'uninstall');
    await c.service.apply('posix', 'uninstall', plan.planHash);
    expect(JSON.parse(read(c.settingsPath))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
  });

  it('works when no runtime is available any more', async () => {
    const c = setup();
    const plan = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', plan.planHash);
    c.layouts.posix = posixLayout(c.root, { runtime: null });
    const un = await c.service.plan('posix', 'uninstall');
    expect(un.action).toBe('uninstall');
    await c.service.apply('posix', 'uninstall', un.planHash);
    expect(handlerCount(read(c.settingsPath))).toBe(0);
  });
});

describe('what counts as ours', () => {
  const hook = (command: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command, ...extra });
  const statusFor = async (hooks: Record<string, unknown>) => {
    const c = setup();
    write(c.settingsPath, canon({ hooks }));
    return c.service.status('posix');
  };

  it('needs the capture script name and the exact handler id in a command hook', async () => {
    const s = await statusFor({
      Stop: [{ hooks: [hook('"/usr/bin/node" "/opt/mini-summa/capture.mjs" --env posix --handler ms-user Stop')] }],
      SessionStart: [{ hooks: [hook('"/usr/bin/node" "/opt/mini-summa/capture.mjs" --env posix --handler ms-user2 SessionStart')] }],
      SessionEnd: [{ hooks: [hook('"/usr/bin/node" "/elsewhere/other-tool.mjs" --handler ms-user SessionEnd')] }],
      Notification: [{ hooks: [hook('"/usr/bin/node" "/opt/mini-summa/capture.mjs" --handler h1 Notification')] }],
      PreToolUse: [{ hooks: [{ type: 'prompt', command: '/opt/mini-summa/capture.mjs --handler ms-user' }] }],
      PostToolUse: [{ hooks: ['--handler ms-user capture.mjs'] }],
      StopFailure: 'not a list',
    });
    expect(s.events).toEqual(['Stop']);
    expect(s.installed).toBe(false);
    expect(s.missingEvents).toEqual(EVENTS.filter((e) => e !== 'Stop'));
  });

  it('reports a partial install in words', async () => {
    const c = setup();
    const built = builtFor(c.layouts.posix);
    const partial = { hooks: Object.fromEntries(EVENTS.slice(0, 5).map((e) => [e, built.hooks[e]])) };
    write(c.settingsPath, canon(partial));
    const s = await c.service.status('posix');
    expect(s.installed).toBe(false);
    expect(s.events).toEqual(EVENTS.slice(0, 5));
    expect(s.issues.join(' ')).toMatch(/5 of 9 events/);
    const plan = await c.service.plan('posix', 'install');
    expect(plan.action).toBe('install');
    expect(Object.keys(JSON.parse(plan.after).hooks)).toEqual([...EVENTS]);
    expect(removed(plan.unifiedDiff)).toEqual([]);
  });
});

describe('files it must not touch', () => {
  it.each([
    ['text that is not JSON at all', 'this is not json', 'settings_not_json'],
    ['JSON that ends too early', '{ "model": ', 'settings_not_json'],
    ['JSON with a comment', '{ // keep\n "model": "opus" }', 'settings_not_json'],
    ['a trailing comma', '{ "model": "opus", }', 'settings_not_json'],
    ['a JSON array', '[]', 'settings_unexpected_shape'],
    ['a JSON string', '"hello"', 'settings_unexpected_shape'],
    ['JSON null', 'null', 'settings_unexpected_shape'],
  ])('refuses %s, never overwrites it and says what to do', async (_what, text, code) => {
    const c = setup();
    write(c.settingsPath, text);
    for (const action of ['install', 'uninstall'] as const) {
      const err = await rejection(c.service.plan('posix', action));
      expect(err.status).toBe(422);
      expect(err.code).toBe(code);
      expect(err.message).toContain(c.settingsPath);
      expect(err.message).toMatch(/Fix|fix|Replace/);
    }
    const err = await rejection(c.service.apply('posix', 'install', 'a'.repeat(64)));
    expect(err.status).toBe(422);
    expect(read(c.settingsPath)).toBe(text);
    expect(fs.existsSync(path.join(c.dataDir, 'backups'))).toBe(false);
    const status = await c.service.status('posix');
    expect(status.installed).toBe(false);
    expect(status.issues[0]).toContain(c.settingsPath);
    expect(c.events).toEqual([]);
  });

  it('does not quote the file in its message (it may hold secrets)', async () => {
    const c = setup();
    write(c.settingsPath, '{ "env": { "API_KEY": "sk-super-secret-value" } oops }');
    const err = await rejection(c.service.plan('posix', 'install'));
    expect(err.message).not.toContain('sk-super-secret-value');
    expect((await c.service.status('posix')).issues.join(' ')).not.toContain('sk-super-secret-value');
  });

  it.each([
    ['hooks is a list', { hooks: [] }, /"hooks" entry that is not an object/],
    ['hooks is a string', { hooks: 'x' }, /"hooks" entry that is not an object/],
    ['an event is a string', { hooks: { Stop: 'x' } }, /"Stop" hook entry that is not a list/],
    ['an event is an object', { hooks: { SessionEnd: {} } }, /"SessionEnd" hook entry that is not a list/],
  ])('refuses to install when %s', async (_what, settings, message) => {
    const c = setup();
    write(c.settingsPath, canon(settings));
    const err = await rejection(c.service.plan('posix', 'install'));
    expect(err).toMatchObject({ status: 422, code: 'settings_unexpected_shape' });
    expect(err.message).toMatch(message);
    expect(read(c.settingsPath)).toBe(canon(settings));
  });

  it('refuses a settings file that is not valid UTF-8', async () => {
    const c = setup();
    fs.mkdirSync(c.claudeDir, { recursive: true });
    fs.writeFileSync(c.settingsPath, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    const err = await rejection(c.service.plan('posix', 'install'));
    expect(err.code).toBe('settings_unreadable');
    expect((await c.service.status('posix')).issues[0]).toMatch(/could not be read/);
  });

  it('refuses a settings.json that is a directory', async () => {
    const c = setup();
    fs.mkdirSync(c.settingsPath, { recursive: true });
    const err = await rejection(c.service.plan('posix', 'install'));
    expect(err.code).toBe('settings_unreadable');
  });
});

describe('a plan is consent to one exact change', () => {
  it('refuses a plan after the file changed (409 plan_stale) and writes nothing', async () => {
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    const plan = await c.service.plan('posix', 'install');
    const edited = canon({ ...userSettings(), model: 'sonnet' });
    write(c.settingsPath, edited);
    const err = await rejection(c.service.apply('posix', 'install', plan.planHash));
    expect(err).toMatchObject({ status: 409, code: 'plan_stale' });
    expect(err.message).toMatch(/Review the new plan/);
    expect(read(c.settingsPath)).toBe(edited);
    expect(fs.existsSync(path.join(c.dataDir, 'backups'))).toBe(false);
    expect(c.events).toEqual([]);
    expect(c.db.get('SELECT * FROM hook_installs')).toBeUndefined();
    // the new plan applies
    const fresh = await c.service.plan('posix', 'install');
    expect(fresh.planHash).not.toBe(plan.planHash);
    await c.service.apply('posix', 'install', fresh.planHash);
    expect(JSON.parse(read(c.settingsPath)).model).toBe('sonnet');
  });

  it('refuses a hash for the other action, another environment or garbage', async () => {
    const c = setup({ layouts: (r) => ({ posix: posixLayout(r), 'wsl:Ubuntu': posixLayout(r, { env: 'wsl:Ubuntu', configDirHost: path.join(r, 'wsl', '.claude') }) }) });
    write(c.settingsPath, canon(userSettings()));
    const install = await c.service.plan('posix', 'install');
    const other = await c.service.plan('wsl:Ubuntu', 'install');
    expect(other.planHash).not.toBe(install.planHash);
    for (const hash of [other.planHash, 'f'.repeat(64), '', install.planHash.toUpperCase()]) {
      expect(await rejection(c.service.apply('posix', 'install', hash))).toMatchObject({ status: 409, code: 'plan_stale' });
    }
    // the hash of the (noop) uninstall plan does not authorise the install
    const uninstall = await c.service.plan('posix', 'uninstall');
    expect(uninstall.action).toBe('noop');
    expect(await rejection(c.service.apply('posix', 'install', uninstall.planHash))).toMatchObject({ status: 409, code: 'plan_stale' });
    expect(read(c.settingsPath)).toBe(canon(userSettings()));
  });

  it('notices a change made while the backup was being taken', async () => {
    let tamper: (() => void) | null = null;
    const c = setup({ fs: { ...nodeHooksFs, copyFile: async (from, to) => { await nodeHooksFs.copyFile(from, to); tamper?.(); } } });
    write(c.settingsPath, canon(userSettings()));
    const plan = await c.service.plan('posix', 'install');
    const theirs = canon({ ...userSettings(), model: 'changed meanwhile' });
    tamper = () => write(c.settingsPath, theirs);
    expect(await rejection(c.service.apply('posix', 'install', plan.planHash))).toMatchObject({ status: 409, code: 'plan_stale' });
    expect(read(c.settingsPath)).toBe(theirs);
  });
});

describe('formatting is preserved', () => {
  const settings = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } };
  const cases: [string, string][] = [
    ['two spaces', canon(settings, 2)],
    ['four spaces', canon(settings, 4)],
    ['tabs', canon(settings, '\t')],
    ['three spaces', canon(settings, 3)],
    ['CRLF line endings', canon(settings, 2).replace(/\n/g, '\r\n')],
    ['no final newline', JSON.stringify(settings, null, 2)],
    ['a byte order mark', `\uFEFF${canon(settings, 2)}`],
    ['a byte order mark and CRLF with tabs', `\uFEFF${canon(settings, '\t').replace(/\n/g, '\r\n')}`],
  ];

  it.each(cases)('keeps %s through install and uninstall', async (_what, original) => {
    const c = setup();
    write(c.settingsPath, original);
    const plan = await c.service.plan('posix', 'install');
    const indentOf = (text: string) => /^([ \t]+)"/m.exec(text.replace(/^\uFEFF/, ''))?.[1];
    expect(indentOf(plan.after)).toBe(indentOf(original));
    expect(plan.after.startsWith('\uFEFF')).toBe(original.startsWith('\uFEFF'));
    expect(plan.after.includes('\r\n')).toBe(original.includes('\r\n'));
    expect(/\n$/.test(plan.after)).toBe(/\n$/.test(original));
    if (original.includes('\r\n')) expect(plan.after.replace(/\r\n/g, '')).not.toContain('\n');
    await c.service.apply('posix', 'install', plan.planHash);
    const un = await c.service.plan('posix', 'uninstall');
    await c.service.apply('posix', 'uninstall', un.planHash);
    expect(read(c.settingsPath)).toBe(original);
  });

  it('defaults to two spaces and a final newline when there is nothing to copy', async () => {
    const c = setup();
    write(c.settingsPath, '{}');
    const plan = await c.service.plan('posix', 'install');
    expect(/^ {2}"hooks"/m.test(plan.after)).toBe(true);
    // the file had no trailing newline, so none is added
    expect(plan.after.endsWith('}')).toBe(true);
  });

  it('says so when the file is laid out in a way JSON.stringify would change', async () => {
    const c = setup();
    write(c.settingsPath, '{\n  "permissions": { "allow": ["Bash(ls)", "Bash(pwd)"] },\n  "model": "opus"\n}\n');
    const plan = await c.service.plan('posix', 'install');
    expect(plan.warnings.some((w) => /re-indents lines that are not part of this change/.test(w))).toBe(true);
    expect(removed(plan.unifiedDiff).length).toBeGreaterThan(0);
    expect(JSON.parse(plan.after).permissions).toEqual({ allow: ['Bash(ls)', 'Bash(pwd)'] });
    // a canonically laid out file produces no such warning
    write(c.settingsPath, canon(settings));
    expect((await c.service.plan('posix', 'install')).warnings.some((w) => /re-indents/.test(w))).toBe(false);
  });
});

describe('runtime and environment problems', () => {
  it('refuses to install without a runtime (422 no_hook_runtime) and says so in the status', async () => {
    const c = setup({ layouts: (r) => ({ posix: posixLayout(r, { runtime: null }) }) });
    write(c.settingsPath, canon(userSettings()));
    const err = await rejection(c.service.plan('posix', 'install'));
    expect(err).toMatchObject({ status: 422, code: 'no_hook_runtime' });
    expect(err.message).toMatch(/Install Node\.js/);
    const status = await c.service.status('posix');
    expect(status.runtime).toEqual({ command: '', kind: 'missing', version: null });
    expect(status.issues.join(' ')).toMatch(/No Node\.js runtime/);
    expect(status.installed).toBe(false);
    expect(await rejection(c.service.apply('posix', 'install', 'a'.repeat(64)))).toMatchObject({ code: 'no_hook_runtime' });
    expect(read(c.settingsPath)).toBe(canon(userSettings()));
  });

  it('reports an Electron runtime as such', async () => {
    const c = setup({ layouts: (r) => ({ posix: posixLayout(r, { runtime: { command: '/opt/Mini-Summa/mini-summa', runAsNode: true, version: 'v22.12.0' } }) }) });
    expect((await c.service.status('posix')).runtime).toEqual({ command: '/opt/Mini-Summa/mini-summa', kind: 'electron', version: 'v22.12.0' });
    const plan = await c.service.plan('posix', 'install');
    expect(JSON.parse(plan.after).hooks.Stop[0].hooks[0].command).toMatch(/^ELECTRON_RUN_AS_NODE=1 "\/opt\/Mini-Summa\/mini-summa" /);
  });

  it('refuses paths that would break the shell command (422 unsafe_hook_path)', async () => {
    const c = setup({ layouts: (r) => ({ posix: posixLayout(r, { spoolDirInEnv: '/data/with "quote"/spool' }) }) });
    const err = await rejection(c.service.plan('posix', 'install'));
    expect(err).toMatchObject({ status: 422, code: 'unsafe_hook_path' });
    expect(err.message).toMatch(/Move the Mini-Summa data folder/);
  });

  it('cannot do anything when the Claude configuration folder is unknown', async () => {
    const c = setup({ layouts: (r) => ({ posix: posixLayout(r, { configDirHost: null, configDirInEnv: null }) }) });
    const status = await c.service.status('posix');
    expect(status).toMatchObject({ configDir: '', settingsPath: '', installed: false, settingsExists: false });
    expect(status.issues[0]).toMatch(/could not find the Claude configuration folder/);
    expect(await rejection(c.service.plan('posix', 'install'))).toMatchObject({ status: 422, code: 'config_dir_unknown' });
    expect(await rejection(c.service.plan('posix', 'uninstall'))).toMatchObject({ code: 'config_dir_unknown' });
  });

  it('answers with an issue, not an exception, for an environment it cannot look at', async () => {
    const c = setup();
    const status = await c.service.status('wsl:Gone' as EnvId);
    expect(status.installed).toBe(false);
    expect(status.issues[0]).toMatch(/could not look at WSL \(Gone\)/);
    expect(await rejection(c.service.plan('wsl:Gone' as EnvId, 'install'))).toMatchObject({ code: 'environment_unavailable' });
  });

  it('lists every environment, each with its own status', async () => {
    const c = setup({ layouts: (r) => ({
      posix: posixLayout(r),
      'wsl:Ubuntu': posixLayout(r, { env: 'wsl:Ubuntu', configDirHost: path.join(r, 'wsl', '.claude'), runtime: null }),
      win: posixLayout(r, { env: 'win', configDirHost: null }),
    }) });
    const plan = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', plan.planHash);
    const all = await c.service.list();
    expect(all.map((s) => [s.env, s.installed])).toEqual([['posix', true], ['wsl:Ubuntu', false], ['win', false]]);
    expect(all[1].runtime.kind).toBe('missing');
    expect(all[2].issues[0]).toMatch(/configuration folder/);
  });

  it('warns when a WSL distribution does not look reachable', async () => {
    const c = setup({
      layouts: (r) => ({ 'wsl:Ubuntu': posixLayout(r, { env: 'wsl:Ubuntu', configDirHost: path.join(r, 'wsl', '.claude') }) }),
      available: { 'wsl:Ubuntu': false },
    });
    const plan = await c.service.plan('wsl:Ubuntu', 'install');
    expect(plan.warnings.some((w) => /WSL distribution Ubuntu does not look reachable/.test(w))).toBe(true);
  });
});

describe('Windows and WSL command lines (built by the PoC builder; Windows is NOT TESTED here, strings only)', () => {
  it('uses PowerShell for Windows, with the call operator and quoted paths with spaces', async () => {
    const c = setup({ layouts: (r) => ({ win: {
      env: 'win', spoolDirHost: 'C:\\x', registryFileHost: 'C:\\x\\r.json',
      spoolDirInEnv: 'C:\\Users\\Some One\\AppData\\Roaming\\Mini-Summa\\spool\\win', registryFileInEnv: 'C:\\Users\\Some One\\AppData\\Roaming\\Mini-Summa\\registry.json',
      captureScriptInEnv: 'C:\\Program Files\\Mini-Summa\\resources\\capture.mjs',
      runtime: { command: 'C:\\Program Files\\nodejs\\node.exe', runAsNode: false, version: 'v22.12.0' },
      configDirHost: path.join(r, 'winhome', '.claude'), configDirInEnv: 'C:\\Users\\Some One\\.claude',
    } }) });
    const plan = await c.service.plan('win', 'install');
    const stop = JSON.parse(plan.after).hooks.Stop[0].hooks[0];
    expect(stop.shell).toBe('powershell');
    expect(stop.type).toBe('command');
    expect(stop.timeout).toBe(5);
    expect(stop.command).toBe('& "C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\Mini-Summa\\resources\\capture.mjs" --spool "C:\\Users\\Some One\\AppData\\Roaming\\Mini-Summa\\spool\\win" --registry "C:\\Users\\Some One\\AppData\\Roaming\\Mini-Summa\\registry.json" --env win --handler ms-user Stop');
    expect(JSON.parse(plan.after).hooks).toEqual(builtFor(c.layouts.win, 'win').hooks);
    await c.service.apply('win', 'install', plan.planHash);
    expect((await c.service.status('win')).installed).toBe(true);
    // a second pass recognises them (the capture file name is matched across Windows separators)
    expect((await c.service.plan('win', 'install')).action).toBe('noop');
  });

  it('sets ELECTRON_RUN_AS_NODE inside the PowerShell command when the app\'s own executable is the runtime', async () => {
    const c = setup({ layouts: (r) => ({ win: {
      env: 'win', spoolDirHost: 'C:\\x', registryFileHost: 'C:\\x\\r.json', spoolDirInEnv: 'C:\\ms\\spool', registryFileInEnv: 'C:\\ms\\registry.json',
      captureScriptInEnv: 'C:\\ms\\capture.mjs', runtime: { command: 'C:\\Apps\\Mini-Summa\\Mini-Summa.exe', runAsNode: true, version: null },
      configDirHost: path.join(r, 'winhome', '.claude'), configDirInEnv: 'C:\\Users\\me\\.claude',
    } }) });
    const cmd = JSON.parse((await c.service.plan('win', 'install')).after).hooks.SessionStart[0].hooks[0].command as string;
    expect(cmd.startsWith('$env:ELECTRON_RUN_AS_NODE=\'1\'; & "C:\\Apps\\Mini-Summa\\Mini-Summa.exe" "C:\\ms\\capture.mjs"')).toBe(true);
    expect(cmd.endsWith('--env win --handler ms-user SessionStart')).toBe(true);
    expect((await c.service.status('win')).runtime.kind).toBe('electron');
  });

  it('names the distribution and uses /mnt paths for WSL, with no shell override', async () => {
    const c = setup({ layouts: (r) => ({ 'wsl:Ubuntu-22.04': {
      env: 'wsl:Ubuntu-22.04', spoolDirHost: '\\\\x', registryFileHost: '\\\\y',
      spoolDirInEnv: '/mnt/c/Users/me/AppData/Roaming/Mini-Summa/spool/wsl-Ubuntu-22.04', registryFileInEnv: '/mnt/c/Users/me/AppData/Roaming/Mini-Summa/registry.json',
      captureScriptInEnv: '/mnt/c/Program Files/Mini-Summa/resources/capture.mjs', runtime: { command: '/usr/bin/node', runAsNode: false, version: 'v20.0.0' },
      configDirHost: path.join(r, 'wslhome', '.claude'), configDirInEnv: '/home/me/.claude',
    } }) });
    const hook = JSON.parse((await c.service.plan('wsl:Ubuntu-22.04', 'install')).after).hooks.Stop[0].hooks[0];
    expect(hook.shell).toBeUndefined();
    expect(hook.command).toBe('"/usr/bin/node" "/mnt/c/Program Files/Mini-Summa/resources/capture.mjs" --spool "/mnt/c/Users/me/AppData/Roaming/Mini-Summa/spool/wsl-Ubuntu-22.04" --registry "/mnt/c/Users/me/AppData/Roaming/Mini-Summa/registry.json" --env wsl:Ubuntu-22.04 --handler ms-user Stop');
  });

  it('tags the backup of a WSL environment with the same tag the PoC layout uses (no colon, no dots)', async () => {
    const c = setup({ layouts: (r) => ({ 'wsl:Ubuntu-22.04': posixLayout(r, { env: 'wsl:Ubuntu-22.04' }) }) });
    write(c.settingsPath, canon({ model: 'opus' }));
    const plan = await c.service.plan('wsl:Ubuntu-22.04', 'install');
    expect(path.basename(plan.backupPath)).toBe('settings-wsl-Ubuntu-22-04-20261030T141500Z.json');
  });
});

describe('when writing fails', () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });

  it('leaves the original in place and changes nothing else', async () => {
    const c = setup({ fs: { ...nodeHooksFs, writeAtomic: async () => { throw denied; } } });
    const original = canon(userSettings());
    write(c.settingsPath, original);
    const plan = await c.service.plan('posix', 'install');
    const err = await rejection(c.service.apply('posix', 'install', plan.planHash));
    expect(err).toMatchObject({ status: 422, code: 'settings_unwritable' });
    expect(err.message).toMatch(/Nothing was changed/);
    expect(err.message).toContain('EACCES');
    expect(read(c.settingsPath)).toBe(original);
    expect(c.events).toEqual([]);
    expect(c.db.get('SELECT * FROM hook_installs')).toBeUndefined();
  });

  it('does not write when the backup cannot be verified', async () => {
    const c = setup({ fs: { ...nodeHooksFs, copyFile: async (_from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, 'garbage'); } } });
    const original = canon(userSettings());
    write(c.settingsPath, original);
    const plan = await c.service.plan('posix', 'install');
    expect(await rejection(c.service.apply('posix', 'install', plan.planHash))).toMatchObject({ status: 422, code: 'backup_failed' });
    expect(read(c.settingsPath)).toBe(original);
  });

  it('does not write when the backup cannot be made at all', async () => {
    const c = setup({ fs: { ...nodeHooksFs, copyFile: async () => { throw denied; } } });
    const original = canon(userSettings());
    write(c.settingsPath, original);
    const plan = await c.service.plan('posix', 'install');
    expect(await rejection(c.service.apply('posix', 'install', plan.planHash))).toMatchObject({ code: 'settings_unwritable' });
    expect(read(c.settingsPath)).toBe(original);
  });

  it('leaves no temporary file behind after a real atomic write', async () => {
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    const plan = await c.service.plan('posix', 'install');
    await c.service.apply('posix', 'install', plan.planHash);
    expect(fs.readdirSync(c.claudeDir)).toEqual(['settings.json']);
  });

  it('removes its temporary file when the rename fails', async () => {
    const c = setup();
    write(c.settingsPath, canon(userSettings()));
    // a directory where the target should be makes the rename fail after the temp file was written
    const real = path.join(c.claudeDir, 'settings.json');
    const plan = await c.service.plan('posix', 'install');
    fs.rmSync(real);
    fs.mkdirSync(real);
    await expect(nodeHooksFs.writeAtomic(real, plan.after, 0o600)).rejects.toBeTruthy();
    expect(fs.readdirSync(c.claudeDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('wording', () => {
  it('uses no em dashes in anything a person reads', async () => {
    const texts: string[] = [];
    const collect = (p: HookPlan) => texts.push(...p.warnings, ...p.status.issues);
    const c = setup();
    write(c.settingsPath, '{ "model": "opus", "hooks": {} }');
    const install = await c.service.plan('posix', 'install');
    collect(install);
    await c.service.apply('posix', 'install', install.planHash);
    collect(await c.service.plan('posix', 'uninstall'));
    c.layouts.posix = posixLayout(c.root, { spoolDirInEnv: '/elsewhere' });
    collect(await c.service.plan('posix', 'install'));
    texts.push(...(await c.service.status('posix')).issues);

    const errors: CoreError[] = [];
    for (const [text, layoutOver] of [['{', {}], ['[]', {}], ['{"hooks":[]}', {}], [canon({}), { runtime: null }], [canon({}), { configDirHost: null }], [canon({}), { spoolDirInEnv: '/a"b' }]] as const) {
      const d = setup({ layouts: (r) => ({ posix: posixLayout(r, layoutOver as Partial<EnvLayout>) }) });
      write(d.settingsPath, text);
      errors.push(await rejection(d.service.plan('posix', 'install')));
      texts.push(...(await d.service.status('posix')).issues);
    }
    const stale = setup();
    write(stale.settingsPath, canon({}));
    const plan = await stale.service.plan('posix', 'install');
    write(stale.settingsPath, canon({ a: 1 }));
    errors.push(await rejection(stale.service.apply('posix', 'install', plan.planHash)));
    texts.push(...errors.map((e) => e.message));
    expect(texts.length).toBeGreaterThan(15);
    for (const t of texts) {
      expect(t, t).not.toMatch(/\u2014|\u2013/);
      expect(t.trim().length).toBeGreaterThan(10);
    }
  });
});
