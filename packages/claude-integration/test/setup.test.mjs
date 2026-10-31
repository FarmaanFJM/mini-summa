import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookCommand, buildSettings, layout, isNormalConfigDir, EVENTS } from '../src/lib/setup.mjs';
import { root, S1 } from './helpers.mjs';

const win = { env: 'win', node: 'C:\\Program Files\\nodejs\\node.exe', capture: 'C:\\Users\\Some One\\poc\\src\\hook\\capture.mjs',
  spool: 'C:\\Users\\Some One\\AppData\\Local\\MiniSummaPoc\\spool-win', registry: 'C:\\Users\\Some One\\AppData\\Local\\MiniSummaPoc\\registry.json' };
const wsl = { env: 'wsl:Ubuntu', node: '/usr/bin/node', capture: '/home/u/poc/src/hook/capture.mjs',
  spool: '/mnt/c/Users/Some One/AppData/Local/MiniSummaPoc/spool-wsl-Ubuntu', registry: '/mnt/c/Users/Some One/AppData/Local/MiniSummaPoc/registry.json' };

test('Windows hook: explicit PowerShell shell, call operator, absolute node, quoted paths with spaces, env and handler tagged', () => {
  const h = hookCommand({ ...win, handler: 'h1', event: 'Stop' });
  assert.equal(h.shell, 'powershell'); assert.equal(h.timeout, 5);
  assert.ok(h.command.startsWith('& "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Some One\\poc\\src\\hook\\capture.mjs"'));
  assert.match(h.command, /--spool "C:\\Users\\Some One\\AppData\\Local\\MiniSummaPoc\\spool-win"/);
  assert.match(h.command, /--env win --handler h1 Stop$/);
});

test('WSL hook: no shell override, spool is a /mnt/<drive> path so Windows can read it, env names the distribution', () => {
  const h = hookCommand({ ...wsl, handler: 'h1', event: 'Stop' });
  assert.equal(h.shell, undefined);
  assert.match(h.command, /--spool "\/mnt\/c\/Users\/Some One\/AppData\/Local\/MiniSummaPoc\/spool-wsl-Ubuntu"/);
  assert.match(h.command, /--env wsl:Ubuntu --handler h1 Stop$/);
});

test('paths that would break shell quoting are refused instead of producing a broken hook', () => {
  assert.throws(() => hookCommand({ ...win, spool: 'C:\\a"b', handler: 'h1', event: 'Stop' }), /unsafe/);
  assert.throws(() => hookCommand({ ...win, spool: 'C:\\a$env', handler: 'h1', event: 'Stop' }), /unsafe/);
  assert.throws(() => hookCommand({ ...wsl, spool: '/a`b', handler: 'h1', event: 'Stop' }), /unsafe/);
  assert.throws(() => hookCommand({ ...wsl, handler: '', event: 'Stop' }), /required/);
});

test('settings: nine events, two registrations get distinct handler ids, one registration by default', () => {
  const two = buildSettings({ ...win, handlers: ['h1', 'h2'] });
  assert.deepEqual(Object.keys(two.hooks), EVENTS);
  for (const ev of EVENTS) { const hs = two.hooks[ev][0].hooks; assert.equal(hs.length, 2); assert.notEqual(hs[0].command, hs[1].command); }
  assert.equal(buildSettings(wsl).hooks.Stop[0].hooks.length, 1);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(two)));
});

test('layout keeps the config local to the environment and the spool in the Windows-visible shared directory', () => {
  const w = layout({ env: 'win', base: 'C:\\P\\MiniSummaPoc', shared: 'C:\\P\\MiniSummaPoc' });
  assert.equal(w.config, 'C:\\P\\MiniSummaPoc\\config-win'); assert.equal(w.spool, 'C:\\P\\MiniSummaPoc\\spool-win');
  const l = layout({ env: 'wsl:Ubuntu', base: '/home/u/.mini-summa-poc', shared: '/mnt/c/P/MiniSummaPoc' });
  assert.equal(l.config, '/home/u/.mini-summa-poc/config-wsl-Ubuntu'); assert.equal(l.spool, '/mnt/c/P/MiniSummaPoc/spool-wsl-Ubuntu');
  assert.equal(l.registry, '/mnt/c/P/MiniSummaPoc/registry.json');
});

test('capture tags env and handler into transport so the ingestor can namespace and de-duplicate', () => {
  fs.mkdirSync(path.join(root, '.tmp-tests'), { recursive: true });
  const d = fs.mkdtempSync(path.join(root, '.tmp-tests', 'envtag-'));
  const r = spawnSync('node', [path.join(root, 'src/hook/capture.mjs'), '--spool', d, '--env', 'wsl:Ubuntu', '--handler', 'h7', 'Stop'],
    { input: JSON.stringify({ session_id: S1, hook_event_name: 'Stop' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  const f = fs.readdirSync(d).find((x) => x.endsWith('.json'));
  const t = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).transport;
  assert.equal(t.env_id, 'wsl:Ubuntu'); assert.equal(t.handler_id, 'h7');
});

test('the normal Claude configuration directory is recognised in POSIX and Windows spellings, and nothing else is', () => {
  assert.equal(isNormalConfigDir('/home/u/.claude', ['/home/u']), true);
  assert.equal(isNormalConfigDir('/home/u/.claude/sub', ['/home/u']), true);
  assert.equal(isNormalConfigDir('/home/u/.claude-poc', ['/home/u']), false, 'a sibling that merely starts with the same text is fine');
  assert.equal(isNormalConfigDir('C:\\Users\\Some One\\.claude', ['C:\\Users\\Some One']), true);
  assert.equal(isNormalConfigDir('c:/users/some one/.CLAUDE/x', ['C:\\Users\\Some One']), true);
  assert.equal(isNormalConfigDir('C:\\Users\\Some One\\AppData\\Local\\MiniSummaPoc\\config-win', ['C:\\Users\\Some One']), false);
  assert.equal(isNormalConfigDir('/elsewhere/cfg', ['/home/u'], '/elsewhere/cfg'), true, 'an explicit CLAUDE_CONFIG_DIR counts as normal too');
});

test('the setup script itself refuses the normal directory', () => {
  fs.mkdirSync(path.join(root, '.tmp-tests'), { recursive: true });
  const home = fs.mkdtempSync(path.join(root, '.tmp-tests', 'home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const refused = spawnSync(process.execPath, [path.join(root, 'scripts/setup-isolated.mjs'), '--base', path.join(home, '.claude'), '--shared', home], { encoding: 'utf8', env });
  assert.equal(refused.status, 2); assert.match(refused.stderr, /refusing/);
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')));
});
