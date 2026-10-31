import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookCommand, buildSettings, EVENTS } from '../src/lib/setup.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 11 (docs/CHANGES-FROM-POC.md): hookCommand writes the node, capture, spool and registry paths of a Windows hook inside
// double quotes, in a PowerShell command. PowerShell reads not only " but also the typographic double quotes U+201C, U+201D
// and U+201E as the end of such a string. The proof of concept refused only " ` $ and line breaks in a path, so a path with
// one of those characters ended the string early and the rest of the path became PowerShell code. The paths now refuse them
// too. The typographic SINGLE quotes U+2018, U+2019, U+201A and U+201B mean nothing inside a double-quoted string, so a path
// that holds one (a Windows profile folder such as O'Neil with a typographic apostrophe) is still accepted. The tokens
// (handler, event, env) were already refused the whole range, which is the conservative choice for values that are not paths.
// POSIX and WSL commands are not run by PowerShell and are unchanged.

const chars = (cps) => cps.map((cp) => String.fromCodePoint(cp));
const SINGLE_QUOTES = chars([0x2018, 0x2019, 0x201a, 0x201b]);
const DOUBLE_QUOTES = chars([0x201c, 0x201d, 0x201e]);
const QUOTES = [...SINGLE_QUOTES, ...DOUBLE_QUOTES];
const FIELDS = ['node', 'capture', 'spool', 'registry'];
const win = { env: 'win', node: 'C:\\Program Files\\MiniSumma\\MiniSumma.exe', capture: 'C:\\Users\\Some One\\hook\\capture.mjs', spool: 'C:\\Users\\Some One\\spool', registry: 'C:\\Users\\Some One\\registry.json', handler: 'h1', event: 'Stop' };
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
// the character at the start, in the middle and at the end of the path's last segment, and as a folder name of its own
const placed = (p, ch) => [`${ch}${p}`, `${p.slice(0, -4)}${ch}${p.slice(-4)}`, `${p}${ch}`, `${p}\\${ch}x`];

test('CHANGE 11: a typographic double quote U+201C to U+201E in the node, capture, spool or registry path of a Windows hook is refused', () => {
  const accepted = [];
  for (const field of FIELDS) for (const ch of DOUBLE_QUOTES) for (const value of placed(win[field], ch)) {
    try { hookCommand({ ...win, [field]: value }); accepted.push(`${field} ${hex(ch)} ${JSON.stringify(value)}`); } catch (err) {
      assert.match(err.message, new RegExp(`^path for ${field} contains a character that is unsafe inside a PowerShell string`), `${field} ${hex(ch)}`);
      assert.ok(err.message.includes(value), 'the message shows the path that was refused');
    }
  }
  assert.deepEqual(accepted, []);
});

test('CHANGE 11: the refusal reaches buildSettings, with or without runAsNode, and names the field', () => {
  for (const ch of DOUBLE_QUOTES) for (const runAsNode of [undefined, true, false]) {
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
  // characters next to the range, the typographic single quotes, and quote-like characters PowerShell does not read as
  // double quotes, are not in the way inside a double-quoted path
  for (const ch of ['\u2017', '\u201f', "'", '\u00b4', '\u2032', '\u00ab', '\u00bb', '\u2039', '\u203a', '\u300c', ...SINGLE_QUOTES]) {
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

test('CHANGE 11: the tokens refuse every typographic quote, the paths refuse the double ones and keep a profile folder with an apostrophe usable', () => {
  for (const ch of QUOTES) {
    assert.throws(() => hookCommand({ ...win, handler: `h${ch}1` }), /handler contains a character that is unsafe/, hex(ch));
    assert.throws(() => hookCommand({ ...win, event: `S${ch}top` }), /event contains a character that is unsafe/, hex(ch));
  }
  for (const ch of DOUBLE_QUOTES) assert.throws(() => hookCommand({ ...win, spool: `${win.spool}${ch}` }), /path for spool contains a character that is unsafe/, hex(ch));
  for (const ch of SINGLE_QUOTES) {
    const profile = `C:\\Users\\O${ch}Neil`;
    const cmd = hookCommand({ ...win, node: `${profile}\\node.exe`, capture: `${profile}\\hook\\capture.mjs`, spool: `${profile}\\spool`, registry: `${profile}\\registry.json` }).command;
    assert.ok(cmd.includes(`--spool "${profile}\\spool"`), `${hex(ch)} in a profile folder is written inside the double quotes as it is`);
  }
});
