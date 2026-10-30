import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentsCommand, runAgentsJson, claudeBin } from '../src/lib/discovery.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 6 (docs/CHANGES-FROM-POC.md): on Windows an npm install of Claude Code is a .cmd shim. The proof of concept started it
// with Node's `shell: true`, which pastes the arguments together without quoting, so a shim path or a --cwd with a space
// broke the command. It is now started as `cmd.exe /d /s /c "<every part quoted>"` with the arguments passed verbatim.
//
// WINDOWS: NOT TESTED. Nothing here runs cmd.exe. These tests build the command for platform 'win32' on any machine and
// check the file and the argument list that would be started; whether Windows then runs it as intended is not verified.

const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const win = (opts) => agentsCommand({ platform: 'win32', comSpec: COMSPEC, ...opts });
const SHIM = 'C:\\Program Files\\nodejs\\claude.cmd';

test('CHANGE 6: a shim path and a --cwd with spaces are started through cmd.exe /d /s /c, each part quoted, arguments verbatim', () => {
  const c = win({ bin: SHIM, cwd: 'C:\\Some One\\my app', all: true });
  assert.deepEqual(c, {
    file: SHIM, args: ['agents', '--json', '--all', '--cwd', 'C:\\Some One\\my app'], // the command as the caller sees it
    spawnFile: COMSPEC,
    spawnArgs: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\claude.cmd" agents --json --all --cwd "C:\\Some One\\my app""'],
    windowsVerbatimArguments: true,
  });
  // exactly one /c argument, whose outer quotes cmd /s strips: what is left is the command line with every part quoted
  assert.equal(c.spawnArgs.length, 4);
  assert.equal(c.spawnArgs[3].slice(1, -1), '"C:\\Program Files\\nodejs\\claude.cmd" agents --json --all --cwd "C:\\Some One\\my app"');
});

test('CHANGE 6: .bat and upper-case extensions are shims too; parts that need no quotes get none', () => {
  assert.equal(win({ bin: 'C:\\tools\\claude.bat' }).spawnArgs[3], '"C:\\tools\\claude.bat agents --json"');
  assert.equal(win({ bin: 'C:\\tools\\CLAUDE.CMD' }).spawnFile, COMSPEC);
  assert.deepEqual(win({ bin: 'claude.cmd' }).spawnArgs, ['/d', '/s', '/c', '"claude.cmd agents --json"']);
  assert.equal(win({ bin: SHIM, cwd: 'C:\\work\\app' }).spawnArgs[3], '""C:\\Program Files\\nodejs\\claude.cmd" agents --json --cwd C:\\work\\app"');
  // without a ComSpec the standard name is used
  assert.equal(agentsCommand({ platform: 'win32', comSpec: '', bin: 'claude.cmd' }).spawnFile, 'cmd.exe');
});

test('CHANGE 6: trailing backslashes are doubled so they cannot escape the closing quote', () => {
  assert.equal(win({ bin: SHIM, cwd: 'C:\\Some One\\app\\' }).spawnArgs[3], '""C:\\Program Files\\nodejs\\claude.cmd" agents --json --cwd "C:\\Some One\\app\\\\""');
  assert.equal(win({ bin: SHIM, cwd: 'C:\\Some One\\app\\\\' }).spawnArgs[3].endsWith('app\\\\\\\\""'), true);
  assert.equal(win({ bin: SHIM, cwd: 'C:\\a b\\x\\y' }).spawnArgs[3].includes('"C:\\a b\\x\\y"'), true, 'backslashes elsewhere are untouched');
});

test('CHANGE 6: cmd metacharacters that are inert inside double quotes are quoted, not refused', () => {
  for (const cwd of ['C:\\R&D\\app', 'C:\\Program Files (x86)\\app', 'C:\\a^b', 'C:\\a|b', 'C:\\a<b>c', 'C:\\a;b,c=d', "C:\\it's", 'C:\\a@b', 'C:\\100$', 'C:\\a b & c']) {
    const line = win({ bin: SHIM, cwd }).spawnArgs[3];
    assert.ok(line.endsWith(`--cwd "${cwd}""`), `${cwd}: ${line}`);
  }
});

test('CHANGE 6: what cmd.exe cannot be given safely is refused with a clear error: quotes, %, !, control characters, in the cwd and in the shim path', () => {
  for (const [what, ch] of Object.entries({ 'double quote': '"', percent: '%', exclamation: '!', newline: '\n', 'carriage return': '\r', tab: '\t', NUL: '\u0000' })) {
    assert.throws(() => win({ bin: SHIM, cwd: `C:\\a${ch}b` }), /cannot pass .* through cmd\.exe/, `cwd ${what}`);
    assert.throws(() => win({ bin: `C:\\a${ch}b\\claude.cmd` }), /cannot pass .* through cmd\.exe/, `shim ${what}`);
  }
  // other platforms and non-shims never reach that code, so the same text is fine there
  assert.doesNotThrow(() => agentsCommand({ platform: 'linux', bin: '/opt/claude.cmd', cwd: '/a%b"c!' }));
  assert.doesNotThrow(() => win({ bin: 'C:\\Program Files\\Claude\\claude.exe', cwd: 'C:\\a%b!c' }));
});

test('CHANGE 6: everything that is not a shim on Windows is started exactly as before, and so is every other platform', () => {
  const exe = win({ bin: 'C:\\Program Files\\Claude\\claude.exe', cwd: 'C:\\Some One\\app', all: true, configDir: 'C:\\cfg dir' });
  assert.deepEqual(exe, { file: 'C:\\Program Files\\Claude\\claude.exe', args: ['agents', '--json', '--all', '--cwd', 'C:\\Some One\\app'],
    spawnFile: 'C:\\Program Files\\Claude\\claude.exe', spawnArgs: ['agents', '--json', '--all', '--cwd', 'C:\\Some One\\app'], windowsVerbatimArguments: false });
  // WSL from Windows: wsl.exe with the same arguments as the proof of concept, even when `bin` names a shim
  const wsl = win({ bin: SHIM, wslDistro: 'Ubuntu', configDir: '/home/u/.cfg', cwd: '/home/u/app', all: true });
  assert.equal(wsl.spawnFile, 'wsl.exe'); assert.equal(wsl.windowsVerbatimArguments, false);
  assert.deepEqual(wsl.spawnArgs, ['-d', 'Ubuntu', '--exec', 'env', 'CLAUDE_CONFIG_DIR=/home/u/.cfg', 'claude', 'agents', '--json', '--all', '--cwd', '/home/u/app']);
  assert.deepEqual([wsl.file, wsl.args], [wsl.spawnFile, wsl.spawnArgs]);
  assert.deepEqual(win({ bin: SHIM, wslDistro: 'Debian' }).spawnArgs, ['-d', 'Debian', '--exec', 'claude', 'agents', '--json']);
  // a .cmd file name on Linux or macOS is just a file name
  const posix = agentsCommand({ platform: 'linux', bin: '/opt/my tools/claude.cmd', cwd: '/w/a b' });
  assert.deepEqual(posix, { file: '/opt/my tools/claude.cmd', args: ['agents', '--json', '--cwd', '/w/a b'], spawnFile: '/opt/my tools/claude.cmd', spawnArgs: ['agents', '--json', '--cwd', '/w/a b'], windowsVerbatimArguments: false });
  assert.equal(agentsCommand({ platform: 'darwin' }).file, claudeBin(process.env, 'darwin'));
  assert.equal(agentsCommand({ platform: 'win32', bin: undefined }).file, claudeBin(process.env, 'win32'));
});

test('CHANGE 6: MINI_SUMMA_CLAUDE_BIN naming a shim is handled like bin', () => {
  const before = process.env.MINI_SUMMA_CLAUDE_BIN;
  process.env.MINI_SUMMA_CLAUDE_BIN = SHIM;
  try {
    const c = agentsCommand({ platform: 'win32', comSpec: COMSPEC, cwd: 'C:\\Some One' });
    assert.equal(c.file, SHIM); assert.equal(c.spawnFile, COMSPEC); assert.equal(c.windowsVerbatimArguments, true);
  } finally { if (before === undefined) delete process.env.MINI_SUMMA_CLAUDE_BIN; else process.env.MINI_SUMMA_CLAUDE_BIN = before; }
});

// ---- the unchanged POSIX path, with a real executable ---------------------------------------------------------------

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX executable' : false };

function fakeClaude(t, body) {
  const d = tmpDir(t, 'agents');
  const dir = path.join(d, 'a dir with spaces'); fs.mkdirSync(dir);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { d, dir, bin };
}

test('CHANGE 6 does not touch this platform: a path and a --cwd with spaces reach a real executable as single arguments', posixOnly, async (t) => {
  const F = fakeClaude(t, 'printf \'%s\\n\' "$@" > "$(dirname "$0")/args.txt"; printf \'%s\' "$CLAUDE_CONFIG_DIR" > "$(dirname "$0")/cfg.txt"; printf \'[{"kind":"interactive","cwd":"/w","startedAt":1,"pid":1,"status":"idle","sessionId":"s"}]\'');
  const r = await runAgentsJson({ bin: F.bin, cwd: '/w/some where/app', all: true, configDir: '/home/u/cfg dir' });
  assert.deepEqual(r.raw, [{ kind: 'interactive', cwd: '/w', startedAt: 1, pid: 1, status: 'idle', sessionId: 's' }]);
  assert.equal(r.file, F.bin); assert.deepEqual(r.args, ['agents', '--json', '--all', '--cwd', '/w/some where/app']);
  assert.deepEqual(fs.readFileSync(path.join(F.dir, 'args.txt'), 'utf8').split('\n').slice(0, -1), ['agents', '--json', '--all', '--cwd', '/w/some where/app']);
  assert.equal(fs.readFileSync(path.join(F.dir, 'cfg.txt'), 'utf8'), '/home/u/cfg dir');
});

test('CHANGE 6 keeps the failure modes: a non-zero exit rejects with the command and stderr, bad output rejects as unparsable', posixOnly, async (t) => {
  const failing = fakeClaude(t, 'echo "not logged in" >&2; exit 3');
  await assert.rejects(runAgentsJson({ bin: failing.bin }), (e) => /failed:/.test(e.message) && e.message.includes('agents --json') && /not logged in/.test(e.stderr));
  const garbage = fakeClaude(t, 'echo "this is not json"');
  await assert.rejects(runAgentsJson({ bin: garbage.bin }), /unparsable output: this is not json/);
  await assert.rejects(runAgentsJson({ bin: path.join(garbage.d, 'missing', 'claude') }), /failed:/);
});
