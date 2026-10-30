import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookCommand, buildSettings, EVENTS } from '../src/lib/setup.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 11 (docs/CHANGES-FROM-POC.md): hookCommand writes the node, capture, spool and registry paths of a Windows hook inside
// double quotes, in a PowerShell command. PowerShell reads not only " but also the typographic double quotes U+201C, U+201D
// and U+201E as the end of such a string, and the single typographic quotes U+2018, U+2019, U+201A and U+201B as quotes. The
// proof of concept refused only " ` $ and line breaks in a path, so a path with one of those characters ended the string early
// and the rest of the path became PowerShell code. The tokens (handler, event, env) were already refused these characters;
// the paths now are too. POSIX and WSL commands are not run by PowerShell and are unchanged.

const QUOTES = [0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x201e].map((cp) => String.fromCodePoint(cp));
const FIELDS = ['node', 'capture', 'spool', 'registry'];
const win = { env: 'win', node: 'C:\\Program Files\\MiniSumma\\MiniSumma.exe', capture: 'C:\\Users\\Some One\\hook\\capture.mjs', spool: 'C:\\Users\\Some One\\spool', registry: 'C:\\Users\\Some One\\registry.json', handler: 'h1', event: 'Stop' };
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
// the character at the start, in the middle and at the end of the path's last segment, and as a folder name of its own
const placed = (p, ch) => [`${ch}${p}`, `${p.slice(0, -4)}${ch}${p.slice(-4)}`, `${p}${ch}`, `${p}\\${ch}x`];

test('CHANGE 11: a typographic quote U+2018 to U+201E in the node, capture, spool or registry path of a Windows hook is refused', () => {
  const accepted = [];
  for (const field of FIELDS) for (const ch of QUOTES) for (const value of placed(win[field], ch)) {
    try { hookCommand({ ...win, [field]: value }); accepted.push(`${field} ${hex(ch)} ${JSON.stringify(value)}`); } catch (err) {
      assert.match(err.message, new RegExp(`^path for ${field} contains a character that is unsafe inside a PowerShell string`), `${field} ${hex(ch)}`);
      assert.ok(err.message.includes(value), 'the message shows the path that was refused');
    }
  }
  assert.deepEqual(accepted, []);
});

test('CHANGE 11: the refusal reaches buildSettings, with or without runAsNode, and names the field', () => {
  for (const ch of QUOTES) for (const runAsNode of [undefined, true, false]) {
    for (const field of FIELDS) {
      assert.throws(() => buildSettings({ ...win, [field]: `${win[field]}${ch}`, runAsNode }), new RegExp(`path for ${field} contains a character that is unsafe inside a PowerShell string`), `${field} ${hex(ch)} runAsNode=${runAsNode}`);
    }
  }
  assert.equal(Object.keys(buildSettings({ ...win }).hooks).length, EVENTS.length, 'the same input without the character still builds every event');
});

test('CHANGE 11: what was refused before still is, and ordinary Windows paths are written as before', () => {
  for (const bad of ['"', '`', '$', '\r', '\n']) for (const field of FIELDS) assert.throws(() => hookCommand({ ...win, [field]: `${win[field]}${bad}` }), /unsafe inside a PowerShell string/, `${field} ${JSON.stringify(bad)}`);
  assert.equal(hookCommand(win).command,
    '& "C:\\Program Files\\MiniSumma\\MiniSumma.exe" "C:\\Users\\Some One\\hook\\capture.mjs" --spool "C:\\Users\\Some One\\spool" --registry "C:\\Users\\Some One\\registry.json" --env win --handler h1 Stop');
  // characters next to the range, and quote-like characters PowerShell does not read as quotes, are not in the way
  for (const ch of ['\u2017', '\u201f', "'", '\u00b4', '\u2032', '\u00ab', '\u00bb', '\u2039', '\u203a', '\u300c', '\u201f']) {
    const cmd = hookCommand({ ...win, spool: `C:\\Users\\Some One\\sp${ch}ool` }).command;
    assert.ok(cmd.includes(`--spool "C:\\Users\\Some One\\sp${ch}ool"`), `${hex(ch)} is written as it is`);
  }
});

test('CHANGE 11: POSIX and WSL commands are not run by PowerShell and still accept the characters; a real shell takes the path as one argument', (t) => {
  for (const ch of QUOTES) {
    const posix = hookCommand({ env: 'posix', node: '/usr/bin/node', capture: `/home/u/O${ch}Neil/hook/capture.mjs`, spool: `/home/u/O${ch}Neil/spool`, registry: `/home/u/O${ch}Neil/registry.json`, handler: 'h1', event: 'Stop' }).command;
    assert.ok(posix.includes(`"/home/u/O${ch}Neil/spool"`), hex(ch));
    const wsl = hookCommand({ env: 'wsl:Ubuntu', node: '/usr/bin/node', capture: '/home/u/ms/hook/capture.mjs', spool: `/mnt/c/Users/Some One/O${ch}Neil/spool`, registry: '/mnt/c/r.json', handler: 'h1', event: 'Stop' }).command;
    assert.ok(wsl.includes(`"/mnt/c/Users/Some One/O${ch}Neil/spool"`), hex(ch));
  }
  if (process.platform === 'win32') return;
  const d = tmpDir(t, 'ps-quotes');
  const dir = path.join(d, 'O\u2019Neil'); fs.mkdirSync(dir);
  const stub = path.join(dir, 'capture.mjs');
  fs.writeFileSync(stub, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const cmd = hookCommand({ env: 'posix', node: process.execPath, capture: stub, spool: path.join(dir, 'spool'), registry: path.join(dir, 'registry.json'), handler: 'h1', event: 'Stop' }).command;
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['--spool', path.join(dir, 'spool'), '--registry', path.join(dir, 'registry.json'), '--env', 'posix', '--handler', 'h1', 'Stop']);
});

test('CHANGE 11: the paths and the tokens now refuse the same typographic quotes', () => {
  for (const ch of QUOTES) {
    assert.throws(() => hookCommand({ ...win, handler: `h${ch}1` }), /handler contains a character that is unsafe/, hex(ch));
    assert.throws(() => hookCommand({ ...win, event: `S${ch}top` }), /event contains a character that is unsafe/, hex(ch));
    assert.throws(() => hookCommand({ ...win, spool: `${win.spool}${ch}` }), /path for spool contains a character that is unsafe/, hex(ch));
  }
});
