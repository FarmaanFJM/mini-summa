import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookCommand, buildSettings, EVENTS } from '../src/lib/setup.mjs';
import { root, S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// `runAsNode` lets the application's own Electron executable act as the Node runtime for the hook (the user may have no
// node on PATH). It is purely additive: test/setup.test.mjs is the proof-of-concept suite and is untouched.

const cfg = {
  win: { env: 'win', node: 'C:\\Program Files\\MiniSumma\\MiniSumma.exe', capture: 'C:\\Users\\Some One\\AppData\\Roaming\\MiniSumma\\hook\\capture.mjs',
    spool: 'C:\\Users\\Some One\\AppData\\Roaming\\MiniSumma\\spool-win', registry: 'C:\\Users\\Some One\\AppData\\Roaming\\MiniSumma\\registry.json' },
  wsl: { env: 'wsl:Ubuntu', node: '/usr/bin/node', capture: '/home/u/ms/hook/capture.mjs',
    spool: '/mnt/c/Users/Some One/AppData/Roaming/MiniSumma/spool-wsl-Ubuntu', registry: '/mnt/c/Users/Some One/AppData/Roaming/MiniSumma/registry.json' },
  posix: { env: 'posix', node: '/opt/Mini Summa/mini-summa', capture: '/home/u/.mini-summa/hook/capture.mjs',
    spool: '/home/u/.mini-summa/spool', registry: '/home/u/.mini-summa/registry.json' },
};
// Output of the proof-of-concept implementation for these inputs, recorded before the change. It must never move.
const GOLDEN = {
  win: '& "C:\\Program Files\\MiniSumma\\MiniSumma.exe" "C:\\Users\\Some One\\AppData\\Roaming\\MiniSumma\\hook\\capture.mjs" --spool "C:\\Users\\Some One\\AppData\\Roaming\\MiniSumma\\spool-win" --registry "C:\\Users\\Some One\\AppData\\Roaming\\MiniSumma\\registry.json" --env win --handler h1 Stop',
  wsl: '"/usr/bin/node" "/home/u/ms/hook/capture.mjs" --spool "/mnt/c/Users/Some One/AppData/Roaming/MiniSumma/spool-wsl-Ubuntu" --registry "/mnt/c/Users/Some One/AppData/Roaming/MiniSumma/registry.json" --env wsl:Ubuntu --handler h1 Stop',
  posix: '"/opt/Mini Summa/mini-summa" "/home/u/.mini-summa/hook/capture.mjs" --spool "/home/u/.mini-summa/spool" --registry "/home/u/.mini-summa/registry.json" --env posix --handler h1 Stop',
};
const PS_PREFIX = "$env:ELECTRON_RUN_AS_NODE='1'; ";
// The Electron executable is a GUI-subsystem program, which PowerShell does not wait for when it is the only command of a pipeline
// (change 16): the call is therefore made part of a pipeline, which also passes the script's output on.
const PS_WAIT = ' | Write-Output';
const SH_PREFIX = 'ELECTRON_RUN_AS_NODE=1 ';
const stop = (c, extra = {}) => hookCommand({ ...c, handler: 'h1', event: 'Stop', ...extra });
const messageOf = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

test('default output is byte-identical to the proof of concept when runAsNode is absent, undefined or false', () => {
  for (const [name, c] of Object.entries(cfg)) {
    const expected = name === 'win'
      ? { type: 'command', shell: 'powershell', timeout: 5, command: GOLDEN.win }
      : { type: 'command', timeout: 5, command: GOLDEN[name] };
    assert.deepEqual(stop(c), expected, name);
    assert.deepEqual(stop(c, { runAsNode: undefined }), expected, `${name} undefined`);
    assert.deepEqual(stop(c, { runAsNode: false }), expected, `${name} false`);
    assert.deepEqual(Object.keys(stop(c, { runAsNode: false })), Object.keys(expected), 'no new key leaks into the hook definition');
  }
});

test('runAsNode on POSIX and WSL: the command starts with ELECTRON_RUN_AS_NODE=1 and nothing else changes', () => {
  for (const name of ['posix', 'wsl']) {
    const h = stop(cfg[name], { runAsNode: true });
    assert.equal(h.command, SH_PREFIX + GOLDEN[name], name);
    assert.ok(h.command.startsWith(`${SH_PREFIX}"${cfg[name].node}" "${cfg[name].capture}" --spool `), name);
    assert.equal(h.shell, undefined, 'no shell override outside Windows');
    assert.equal(h.timeout, 5); assert.equal(h.type, 'command');
  }
});

test('runAsNode on Windows: PowerShell assignment, then the call operator with the quoted executable', () => {
  const h = stop(cfg.win, { runAsNode: true });
  assert.equal(h.command, PS_PREFIX + GOLDEN.win + PS_WAIT);
  assert.equal(h.shell, 'powershell'); assert.equal(h.timeout, 5); assert.equal(h.type, 'command');
  assert.ok(h.command.startsWith(`$env:ELECTRON_RUN_AS_NODE='1'; & "C:\\Program Files\\MiniSumma\\MiniSumma.exe" "C:\\Users\\Some One\\AppData\\Roaming\\MiniSumma\\hook\\capture.mjs" --spool `));
  assert.match(h.command, /--env win --handler h1 Stop \| Write-Output$/);
  // without runAsNode the executable is a console program that PowerShell always waits for: nothing is added
  assert.equal(stop(cfg.win).command, GOLDEN.win);
  assert.ok(!stop(cfg.win).command.includes('Write-Output'));
});

test('CHANGE 16 (simulated Windows): the call to the Electron executable is a pipeline element so that PowerShell waits for it, on every event', () => {
  // PowerShell starts a GUI-subsystem program without waiting when it is the only command of a pipeline; the hook would then return
  // before the capture script has written the record. Piping the call into Write-Output makes PowerShell wait and passes the output on.
  // This asserts the text of the command; whether Windows PowerShell then waits is a native check (docs/WINDOWS_VERIFICATION.md).
  for (const ev of EVENTS) {
    const h = hookCommand({ ...cfg.win, handler: 'h1', event: ev, runAsNode: true });
    assert.ok(h.command.endsWith(` ${ev} | Write-Output`), `${ev}: ${h.command}`);
    assert.equal((h.command.match(/Write-Output/g) ?? []).length, 1, 'exactly once, after the whole call');
    assert.ok(h.command.indexOf(' | Write-Output') > h.command.indexOf('--handler h1'), 'the pipe comes after the arguments, never inside them');
    assert.equal(h.shell, 'powershell');
  }
  // a console program (node.exe) is always waited for: without runAsNode, and on POSIX and WSL, nothing is added
  for (const name of ['win', 'wsl', 'posix']) {
    assert.ok(!stop(cfg[name]).command.includes('Write-Output'), `${name} without runAsNode`);
  }
  for (const name of ['posix', 'wsl']) assert.ok(!stop(cfg[name], { runAsNode: true }).command.includes('Write-Output'), `${name} with runAsNode`);
});

test('the unsafe-character guards still apply to every path with runAsNode on, with the same messages as with it off', () => {
  const bad = { double_quote: '"', dollar: '$', backtick: '`', newline: '\n', carriage_return: '\r' };
  for (const [name, c] of Object.entries(cfg)) {
    for (const field of ['node', 'capture', 'spool', 'registry']) {
      for (const [what, ch] of Object.entries(bad)) {
        const input = { ...c, [field]: `${c[field]}${ch}x` };
        const reference = messageOf(() => stop(input));
        assert.match(reference, /unsafe/, `${name}.${field} ${what}`);
        assert.ok(reference.includes(`path for ${field}`), reference);
        for (const runAsNode of [true, false, undefined]) {
          assert.equal(messageOf(() => stop(input, { runAsNode })), reference, `${name}.${field} ${what} runAsNode=${runAsNode}`);
        }
      }
    }
  }
  // the executable path is what runAsNode is about: values that would leave the quotes or expand in the shell
  assert.throws(() => stop({ ...cfg.win, node: 'C:\\App\\x"; calc; "' }, { runAsNode: true }), /unsafe/);
  assert.throws(() => stop({ ...cfg.win, node: 'C:\\App\\$env\\app.exe' }, { runAsNode: true }), /unsafe/);
  assert.throws(() => stop({ ...cfg.posix, node: '/opt/$(id)/app' }, { runAsNode: true }), /unsafe/);
  assert.throws(() => stop({ ...cfg.posix, node: '/opt/`id`/app' }, { runAsNode: true }), /unsafe/);
  // text that is harmless inside double quotes stays allowed, exactly as before
  assert.doesNotThrow(() => stop({ ...cfg.win, node: "C:\\Program Files\\It's Mini\\app.exe" }, { runAsNode: true }));
});

test('required fields are still required, and runAsNode itself must be a boolean when given', () => {
  for (const field of ['node', 'capture', 'spool', 'registry', 'handler', 'event']) {
    assert.throws(() => hookCommand({ ...cfg.posix, handler: 'h1', event: 'Stop', [field]: '', runAsNode: true }), /required/, field);
    assert.throws(() => hookCommand({ ...cfg.win, handler: 'h1', event: 'Stop', [field]: undefined, runAsNode: true }), /required/, field);
  }
  for (const bad of ['true', '1', 1, 0, null, {}, []]) {
    assert.throws(() => stop(cfg.posix, { runAsNode: bad }), /runAsNode must be a boolean/, String(bad));
    assert.throws(() => stop(cfg.win, { runAsNode: bad }), /runAsNode must be a boolean/, String(bad));
  }
});

test('buildSettings passes runAsNode to every event and every registration; without it the settings are unchanged', () => {
  // `suffix` is what the Windows form appends so that PowerShell waits for the GUI executable (change 16)
  const stripPrefix = (settings, prefix, suffix = '') => ({ hooks: Object.fromEntries(Object.entries(settings.hooks).map(([ev, groups]) => [ev,
    groups.map((g) => ({ hooks: g.hooks.map((h) => ({ ...h, command: h.command.slice(prefix.length, h.command.length - suffix.length) })) }))])) });
  const plain = buildSettings({ ...cfg.win, handlers: ['h1', 'h2'] });
  const asNode = buildSettings({ ...cfg.win, handlers: ['h1', 'h2'], runAsNode: true });
  assert.deepEqual(Object.keys(asNode.hooks), EVENTS);
  for (const ev of EVENTS) {
    const hs = asNode.hooks[ev][0].hooks;
    assert.equal(hs.length, 2);
    assert.notEqual(hs[0].command, hs[1].command, 'the handler id still keeps two registrations apart');
    for (const h of hs) { assert.ok(h.command.startsWith(`${PS_PREFIX}& "`), ev); assert.equal(h.shell, 'powershell'); }
  }
  assert.deepEqual(stripPrefix(asNode, PS_PREFIX, PS_WAIT), plain, 'removing the prefix and the wait leaves exactly the default settings');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(asNode)));

  for (const name of ['posix', 'wsl']) {
    const base = buildSettings(cfg[name]);
    assert.deepEqual(buildSettings({ ...cfg[name], runAsNode: false }), base);
    assert.deepEqual(buildSettings({ ...cfg[name], runAsNode: undefined }), base);
    assert.equal(base.hooks.Stop[0].hooks[0].command, GOLDEN[name]);
    assert.deepEqual(stripPrefix(buildSettings({ ...cfg[name], runAsNode: true }), SH_PREFIX), base);
  }
  assert.throws(() => buildSettings({ ...cfg.posix, runAsNode: 'yes' }), /runAsNode must be a boolean/);
  assert.throws(() => buildSettings({ ...cfg.win, node: 'C:\\a"b', runAsNode: true }), /unsafe/);
});

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell syntax' : false };

test('real shell (POSIX): the variable reaches the process the command starts, and only when requested', posixOnly, (t) => {
  const d = tmpDir(t, 'asnode');
  const probe = path.join(d, 'a dir with spaces', 'probe.mjs');
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  // stands in for capture.mjs: records the variable and the arguments it was started with
  fs.writeFileSync(probe, [
    "import fs from 'node:fs';",
    "const out = process.argv[process.argv.indexOf('--spool') + 1];",
    'fs.mkdirSync(out, { recursive: true });',
    "fs.writeFileSync(out + '/probe.json', JSON.stringify({ v: process.env.ELECTRON_RUN_AS_NODE ?? null, argv: process.argv.slice(2) }));",
  ].join('\n'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const registry = path.join(d, 'registry.json');
  const seen = (runAsNode) => {
    const spool = path.join(d, `spool-${runAsNode}`);
    const h = hookCommand({ env: 'posix', node: process.execPath, capture: probe, spool, registry, handler: 'h1', event: 'Stop', runAsNode });
    const r = spawnSync('sh', ['-c', h.command], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(spool, 'probe.json'), 'utf8'));
  };
  const on = seen(true); const off = seen(false);
  assert.equal(on.v, '1');
  assert.equal(off.v, null, 'not set when not requested, and not leaked from this process');
  const argv = (spool) => ['--spool', spool, '--registry', registry, '--env', 'posix', '--handler', 'h1', 'Stop'];
  assert.deepEqual(on.argv, argv(path.join(d, 'spool-true')), 'the prefix shifts no argument');
  assert.deepEqual(off.argv, argv(path.join(d, 'spool-false')));
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined, 'the test process environment is untouched');
});

test('real shell (POSIX): a runAsNode command line drives the real capture script end to end', posixOnly, (t) => {
  const d = tmpDir(t, 'asnode-e2e'); const spool = path.join(d, 'spool');
  const h = hookCommand({ env: 'posix', node: process.execPath, capture: path.join(root, 'src/hook/capture.mjs'), spool,
    registry: path.join(d, 'registry.json'), handler: 'h1', event: 'Stop', runAsNode: true });
  assert.ok(h.command.startsWith(SH_PREFIX));
  const payload = { session_id: S1, cwd: d, prompt_id: 'p1', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done', background_tasks: [], session_crons: [] };
  const r = spawnSync('sh', ['-c', h.command], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  const files = fs.readdirSync(spool);
  assert.equal(files.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(spool, files[0]), 'utf8'));
  assert.deepEqual(rec.payload, payload);
  assert.equal(rec.transport.handler_id, 'h1'); assert.equal(rec.transport.env_id, 'posix'); assert.equal(rec.transport.hook_arg, 'Stop');
});
