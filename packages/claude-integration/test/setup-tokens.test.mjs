import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookCommand, buildSettings, EVENTS } from '../src/lib/setup.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 3 (docs/CHANGES-FROM-POC.md): handler, event and env are validated and, when they need it, quoted. In the proof of
// concept they were pasted into the command line as they were: `handler: 'h1; id'` became a second command, a WSL distribution
// called "My Distro" became two arguments, and a missing env became the text `undefined`.

const win = { env: 'win', node: 'C:\\Program Files\\MiniSumma\\MiniSumma.exe', capture: 'C:\\Users\\Some One\\hook\\capture.mjs', spool: 'C:\\Users\\Some One\\spool', registry: 'C:\\Users\\Some One\\registry.json' };
const posix = { env: 'posix', node: '/usr/bin/node', capture: '/home/u/hook/capture.mjs', spool: '/home/u/spool', registry: '/home/u/registry.json' };
const hook = (cfg, extra) => hookCommand({ handler: 'h1', event: 'Stop', ...cfg, ...extra });
// The proof of concept's command line: every part pasted in as it is.
const pocPosix = (c) => `"${c.node}" "${c.capture}" --spool "${c.spool}" --registry "${c.registry}" --env ${c.env} --handler ${c.handler} ${c.event}`;
const pocWin = (c) => `& "${c.node}" "${c.capture}" --spool "${c.spool}" --registry "${c.registry}" --env win --handler ${c.handler} ${c.event}`;

const PLAIN = ['h1', 'h2', 'H1', 'qual-h_1.x', 'a:b', 'a+b', 'a=b', 'a%b', 'a/b', 'a-b', '1', '_x', '.x', '-x', 'é-handler', '日本語', 'Ünï'];
const UNSAFE = { 'double quote': '"', 'single quote': "'", backtick: '`', dollar: '$', newline: '\n', 'carriage return': '\r', tab: '\t', NUL: '\u0000', escape: '\u001b',
  DEL: '\u007f', 'C1 control': '\u0085', 'line separator': '\u2028', 'paragraph separator': '\u2029', 'left single quote': '\u2018', 'right single quote': '\u2019',
  'low single quote': '\u201a', 'reversed single quote': '\u201b', 'left double quote': '\u201c', 'right double quote': '\u201d', 'low double quote': '\u201e' };
const messageOf = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

test('CHANGE 3: tokens that were safe unquoted are written exactly as the proof of concept wrote them', () => {
  for (const token of PLAIN) {
    for (const [what, input] of [['handler', { handler: token }], ['event', { event: token }]]) {
      assert.equal(hook(posix, input).command, pocPosix({ ...posix, handler: 'h1', event: 'Stop', ...input }), `posix ${what} ${token}`);
      assert.equal(hook(win, input).command, pocWin({ ...win, handler: 'h1', event: 'Stop', ...input }), `win ${what} ${token}`);
    }
  }
  for (const env of ['posix', 'wsl:Ubuntu', 'wsl:Ubuntu-22.04', 'wsl:Debian_12', 'wsl:docker-desktop-data', 'wsl:Ünï', 'linux', 'win32']) {
    assert.equal(hook(posix, { env }).command, pocPosix({ ...posix, env, handler: 'h1', event: 'Stop' }), env);
  }
  // recorded from the proof of concept, character for character
  assert.equal(hook({ ...posix, env: 'wsl:Ubuntu' }, { handler: 'h2', event: 'SessionStart' }).command,
    '"/usr/bin/node" "/home/u/hook/capture.mjs" --spool "/home/u/spool" --registry "/home/u/registry.json" --env wsl:Ubuntu --handler h2 SessionStart');
  assert.equal(hook(win, {}).command,
    '& "C:\\Program Files\\MiniSumma\\MiniSumma.exe" "C:\\Users\\Some One\\hook\\capture.mjs" --spool "C:\\Users\\Some One\\spool" --registry "C:\\Users\\Some One\\registry.json" --env win --handler h1 Stop');
  // and every other part of the definition is as it was
  assert.deepEqual(Object.keys(hook(win, {})), ['type', 'shell', 'timeout', 'command']);
  assert.deepEqual(hook(posix, {}), { type: 'command', timeout: 5, command: pocPosix({ ...posix, handler: 'h1', event: 'Stop' }) });
});

test('CHANGE 3: a token with a character that splits arguments is quoted, so a WSL distribution called "My Distro" is one argument', () => {
  assert.equal(hook(posix, { env: 'wsl:My Distro' }).command,
    '"/usr/bin/node" "/home/u/hook/capture.mjs" --spool "/home/u/spool" --registry "/home/u/registry.json" --env "wsl:My Distro" --handler h1 Stop');
  assert.equal(hook(posix, { handler: 'my handler', event: 'Stop now' }).command,
    '"/usr/bin/node" "/home/u/hook/capture.mjs" --spool "/home/u/spool" --registry "/home/u/registry.json" --env posix --handler "my handler" "Stop now"');
  assert.equal(hook(win, { handler: 'my handler', event: 'Stop now' }).command,
    '& "C:\\Program Files\\MiniSumma\\MiniSumma.exe" "C:\\Users\\Some One\\hook\\capture.mjs" --spool "C:\\Users\\Some One\\spool" --registry "C:\\Users\\Some One\\registry.json" --env win --handler "my handler" "Stop now"');
  assert.equal(hook(win, { handler: 'my handler' }).shell, 'powershell');
  // runAsNode and quoting combine
  assert.match(hook(posix, { env: 'wsl:My Distro', runAsNode: true }).command, /^ELECTRON_RUN_AS_NODE=1 "\/usr\/bin\/node" .* --env "wsl:My Distro" --handler h1 Stop$/);
  assert.match(hook(win, { handler: 'a b', runAsNode: true }).command, /^\$env:ELECTRON_RUN_AS_NODE='1'; & .* --env win --handler "a b" Stop$/);
  // buildSettings quotes the environment in all nine registrations, and keeps handlers apart
  const s = buildSettings({ ...posix, env: 'wsl:My Distro', handlers: ['h 1', 'h2'] });
  for (const ev of EVENTS) {
    const hs = s.hooks[ev][0].hooks;
    assert.equal(hs.length, 2); assert.notEqual(hs[0].command, hs[1].command);
    assert.ok(hs[0].command.endsWith(`--env "wsl:My Distro" --handler "h 1" ${ev}`), hs[0].command);
    assert.ok(hs[1].command.endsWith(`--env "wsl:My Distro" --handler h2 ${ev}`), hs[1].command);
  }
});

test('CHANGE 3: characters that are shell syntax but harmless inside double quotes are quoted rather than refused', () => {
  for (const token of ['a;b', 'a&b', 'a|b', 'a<b', 'a>b', 'a(b)', 'a*b', 'a?b', 'a[b]', 'a{b}', 'a#b', '~a', 'a!b', 'a^b', 'a b', ' a', 'a ', 'a;touch x', 'a&&b', 'a||b', 'a\\b']) {
    assert.equal(hook(posix, { handler: token }).command, pocPosix({ ...posix, handler: `"${token.replace(/\\/g, '\\\\')}"`, event: 'Stop' }), `posix ${JSON.stringify(token)}`);
  }
  for (const token of ['a;b', 'a&b', 'a|b', 'a<b', 'a>b', 'a(b)', 'a{b}', 'a#b', '~a', 'a b', 'a,b', '@a', '--%', 'a;touch x']) {
    assert.equal(hook(win, { handler: token }).command, pocWin({ ...win, handler: `"${token}"`, event: 'Stop' }), `win ${JSON.stringify(token)}`);
  }
  // the comma builds an array in PowerShell but is just a character in a POSIX shell; @ only splats at the start
  assert.equal(hook(posix, { handler: 'a,b' }).command, pocPosix({ ...posix, handler: 'a,b', event: 'Stop' }));
  assert.equal(hook(posix, { handler: '@a' }).command, pocPosix({ ...posix, handler: '@a', event: 'Stop' }));
  assert.equal(hook(win, { handler: 'a@b' }).command, pocWin({ ...win, handler: 'a@b', event: 'Stop' }));
});

test('CHANGE 3: handler, event and env refuse quotes, backticks, $, line breaks and control characters, in both command forms', () => {
  for (const [what, ch] of Object.entries(UNSAFE)) {
    for (const where of [`a${ch}b`, ch, `${ch}x`, `x${ch}`]) {
      for (const [form, cfg] of [['posix', posix], ['win', win]]) {
        for (const field of ['handler', 'event']) {
          const m = messageOf(() => hook(cfg, { [field]: where }));
          assert.ok(m && /unsafe/.test(m) && m.includes(`hookCommand: ${field}`), `${form} ${field} ${what}: ${m}`);
        }
      }
      const m = messageOf(() => hook(posix, { env: `wsl:${where}` }));
      assert.ok(m && /unsafe/.test(m) && m.includes('hookCommand: env'), `env ${what}: ${m}`);
    }
  }
  // the offending value is shown escaped, so a log line cannot be forged with it
  assert.match(messageOf(() => hook(posix, { handler: 'h1\nrm -rf' })), /"h1\\nrm -rf"/);
  // the exact value that opened a hole in the proof of concept
  assert.throws(() => hook(posix, { handler: 'h1; $(id)' }), /unsafe/);
  assert.throws(() => hook(posix, { handler: 'h1`id`' }), /unsafe/);
  assert.throws(() => hook(win, { event: 'Stop"; calc; "' }), /unsafe/);
  assert.throws(() => hook(posix, { env: "wsl:Ubuntu' ; id #" }), /unsafe/);
  // buildSettings reports it too
  assert.throws(() => buildSettings({ ...posix, handlers: ['h1', 'h"2'] }), /unsafe/);
});

test('CHANGE 3: env is required, in both forms and through buildSettings; it was silently written as "undefined" before', () => {
  for (const env of [undefined, '', null, 0, 5, {}, [], true]) {
    for (const cfg of [posix, win]) {
      assert.throws(() => hook(cfg, { env }), /hookCommand: env required/, `${cfg.node} ${JSON.stringify(env)}`);
    }
    assert.throws(() => buildSettings({ ...posix, env }), /hookCommand: env required/);
  }
  const { env, ...withoutEnv } = posix; void env;
  assert.throws(() => hookCommand({ ...withoutEnv, handler: 'h1', event: 'Stop' }), /env required/);
  // the other required fields still come first, with their old messages
  assert.throws(() => hookCommand({ ...withoutEnv, node: '', handler: 'h1', event: 'Stop' }), /node required/);
});

test('CHANGE 3: a PowerShell token that needs quotes cannot end in a backslash (it would escape the closing quote); one that needs none can', () => {
  assert.throws(() => hook(win, { handler: 'a b\\' }), /cannot end with a backslash/);
  assert.throws(() => hook(win, { event: 'x;y\\' }), /cannot end with a backslash/);
  assert.equal(hook(win, { handler: 'ab\\' }).command, pocWin({ ...win, handler: 'ab\\', event: 'Stop' }));
  assert.equal(hook(win, { handler: 'a\\b c' }).command, pocWin({ ...win, handler: '"a\\b c"', event: 'Stop' }));
  // a POSIX shell takes the trailing backslash by doubling it
  assert.equal(hook(posix, { handler: 'a b\\' }).command, pocPosix({ ...posix, handler: '"a b\\\\"', event: 'Stop' }));
});

test('CHANGE 3: the checks on the four paths come first and say what they always said', () => {
  const m = messageOf(() => hook({ ...win, spool: 'C:\\a"b' }, { handler: 'h"1' }));
  assert.match(m, /^path for spool contains a character that is unsafe inside a PowerShell string/);
  const p = messageOf(() => hook({ ...posix, registry: '/a`b' }, { env: 'wsl:"x' }));
  assert.match(p, /^path for registry contains a character that is unsafe inside a shell string/);
});

// ---- a real shell ----------------------------------------------------------------------------------------------------

const shells = process.platform === 'win32' ? [] : ['/bin/sh', ...['/bin/bash', '/usr/bin/bash'].filter((f) => fs.existsSync(f)).slice(0, 1)];
const posixOnly = { skip: shells.length ? false : 'needs a POSIX shell' };

// Starts a command line the way a hook is started, with a tiny script standing in for capture.mjs that writes its arguments,
// one per NUL-terminated record, so the test sees exactly how the shell split the line.
function rig(t) {
  const d = tmpDir(t, 'tokens');
  const probe = path.join(d, 'with space', 'probe.sh');
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(probe, '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$2/argv"\n');
  let n = 0;
  return {
    d,
    run(shell, input) {
      const spool = path.join(d, `out-${++n}`); fs.mkdirSync(spool);
      const h = hookCommand({ env: 'posix', node: '/bin/sh', capture: probe, spool, registry: path.join(d, 'r.json'), handler: 'h1', event: 'Stop', ...input });
      const r = spawnSync(shell, ['-c', h.command], { encoding: 'utf8' });
      const argv = fs.existsSync(path.join(spool, 'argv')) ? fs.readFileSync(path.join(spool, 'argv'), 'utf8').split('\0').slice(0, -1) : null;
      return { r, argv, command: h.command, spool };
    },
    expected: (spool, { env = 'posix', handler = 'h1', event = 'Stop' } = {}) => ['--spool', spool, '--registry', path.join(d, 'r.json'), '--env', env, '--handler', handler, event],
  };
}

test('CHANGE 3: real shell: shell syntax in a token stays data; nothing is run, expanded or split', posixOnly, (t) => {
  const R = rig(t);
  const canary = path.join(R.d, 'canary');
  const tokens = ['a b', 'a;touch canary', `a&touch ${canary}&`, 'a|b', 'a>canary', 'a<b', '(a)', '*', '?', '[ab]', '{a,b}', '#x', '~', '~root', 'a!b', 'a^b', '\\', 'a\\b', 'a\\\\b', 'trail\\', '-n', '--', '%PATH%', 'a=b', ' ', '  two  spaces  ', 'wsl:Ubuntu (Preview)', 'é ñ 日本 😀', 'a\u00a0b', 'a\u200bb'];
  for (const shell of shells) {
    for (const token of tokens) {
      for (const [field, pick] of [['handler', (v) => ({ handler: v })], ['event', (v) => ({ event: v })], ['env', (v) => ({ env: `wsl:${v}` })]]) {
        const { r, argv, command, spool } = R.run(shell, pick(token));
        assert.equal(r.status, 0, `${shell} ${field} ${JSON.stringify(token)}: ${r.stderr} :: ${command}`);
        const want = field === 'env' ? { env: `wsl:${token}` } : { [field]: token };
        assert.deepEqual(argv, R.expected(spool, want), `${shell} ${field} ${JSON.stringify(token)}: ${command}`);
      }
    }
    assert.equal(fs.existsSync(canary), false, `${shell}: the command inside a token was run`);
    assert.equal(fs.existsSync(path.join(R.d, 'canary')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'canary')), false);
  }
});

test('CHANGE 3: real shell: 300 seeded random tokens are either refused (exactly the documented unsafe class) or delivered intact, in every position', posixOnly, (t) => {
  const R = rig(t);
  let seed = 20261030; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const pool = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '\t', '\n', '\r', '\u0000', '\u001b', '\u007f', '\u0085', '\u00a0', '\u2028', '\u2029', '\u2018', '\u201c', '\u201e',
    'é', 'ß', '日', '😀', '\u0301', '\u200b', '\\', '\\', ' ', ';', '&', '|', '*', '~', '#'];
  const unsafe = /["'`$\u0000-\u001f\u007f-\u009f\u2028\u2029\u2018-\u201e]/;
  let refused = 0; let delivered = 0;
  for (let i = 0; i < 300; i++) {
    const token = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pool[Math.floor(rnd() * pool.length)]).join('');
    const field = ['handler', 'event', 'env'][i % 3];
    const input = field === 'env' ? { env: `wsl:${token}` } : { [field]: token };
    const bad = unsafe.test(token);
    if (bad) { assert.throws(() => hookCommand({ env: 'posix', node: '/bin/sh', capture: '/x', spool: '/s', registry: '/r', handler: 'h1', event: 'Stop', ...input }), /unsafe/, `${field} ${JSON.stringify(token)}`); refused++; continue; }
    for (const shell of shells) {
      const { r, argv, spool, command } = R.run(shell, input);
      assert.equal(r.status, 0, `${shell} ${field} ${JSON.stringify(token)}: ${r.stderr} :: ${command}`);
      assert.deepEqual(argv, R.expected(spool, field === 'env' ? { env: `wsl:${token}` } : { [field]: token }), `${shell} ${field} ${JSON.stringify(token)}: ${command}`);
    }
    delivered++;
  }
  assert.ok(refused > 20 && delivered > 100, `the generator should exercise both outcomes (refused ${refused}, delivered ${delivered})`);
});
