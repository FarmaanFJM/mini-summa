// node --test scripts/windows/lib/helpers.test.mjs   (any OS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Results, STATUS, renderReport, extractHookCommands, spoolFromCommand, exeFromCommand, stripWriteOutput, encodePsCommand,
  samePath, deepDiff, hasChatgptUrlField, manifestExecutionLevel, findByName, findFilesContaining, pollUntil,
} from './helpers.mjs';

const CMD = '$env:ELECTRON_RUN_AS_NODE=\'1\'; & "C:\\Some One\\Mini-Summa.exe" "C:\\Some One\\hook\\capture.mjs" --spool "C:\\Some One\\spool\\win" --registry "C:\\Some One\\registry.json" --env win --handler h1 Stop | Write-Output';

test('Results counts and failures by phase', () => {
  const r = new Results();
  r.add('install', '1', 'a', STATUS.PASS);
  r.add('smoke', '2', 'b', STATUS.FAIL, ['why']);
  r.add('smoke', '3', 'c', STATUS.NOT_RUN, 'reason');
  assert.equal(r.failures('install').length, 0);
  assert.equal(r.failures('smoke').length, 1);
  assert.deepEqual(r.counts(), { PASS: 1, FAIL: 1, 'NOT RUN': 1, INFO: 0 });
  assert.throws(() => r.add('x', '9', 't', 'MAYBE'));
});

test('hook command extraction', () => {
  const after = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', shell: 'powershell', timeout: 5, command: CMD }] }], Other: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
  const found = extractHookCommands(after, ['SessionStart', 'Stop']);
  assert.deepEqual(Object.keys(found), ['Stop']);
  assert.equal(found.Stop.shell, 'powershell');
  assert.equal(spoolFromCommand(found.Stop.command), 'C:\\Some One\\spool\\win');
  assert.equal(exeFromCommand(CMD), 'C:\\Some One\\Mini-Summa.exe');
  assert.ok(!stripWriteOutput(CMD).includes('Write-Output'));
  assert.equal(stripWriteOutput('no pipe here'), 'no pipe here');
  assert.equal(Buffer.from(encodePsCommand('ab'), 'base64').toString('utf16le'), 'ab');
});

test('samePath, deepDiff, manifest, field detection', () => {
  assert.ok(samePath('C:\\A\\B\\', 'c:/a/b'));
  assert.ok(!samePath('C:\\A', 'C:\\B'));
  assert.deepEqual(deepDiff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), []);
  assert.deepEqual(deepDiff({ a: { c: 1 } }, { a: { c: 2 } }), ['a.c: 1 -> 2']);
  assert.equal(deepDiff({ a: 1 }, {}).length, 1);
  assert.equal(manifestExecutionLevel(Buffer.from('<requestedExecutionLevel level="asInvoker" uiAccess="false"/>')), 'asInvoker');
  assert.equal(manifestExecutionLevel(Buffer.from('nothing')), null);
  assert.ok(hasChatgptUrlField('perProject: { chatgptUrl: x }'));
  assert.ok(!hasChatgptUrlField('cloudUrl only'));
});

test('file search helpers and pollUntil', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wci-helpers-'));
  try {
    fs.mkdirSync(path.join(dir, 'a', 'done'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'done', 'x.json'), '{"session_id":"marker-1"}');
    fs.writeFileSync(path.join(dir, 'a', 'OpenConsole.exe'), '');
    assert.equal(findFilesContaining([dir], 'marker-1').length, 1);
    assert.equal(findFilesContaining([dir], 'marker-2').length, 0);
    assert.equal(findByName(dir, ['openconsole.exe']).length, 1);
    let n = 0;
    assert.equal(await pollUntil(() => ++n >= 3 && 'ok', { timeoutMs: 2000, intervalMs: 5 }), 'ok');
    assert.equal(await pollUntil(() => false, { timeoutMs: 20, intervalMs: 5 }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('report states what is not proven and lists failures', () => {
  const r = new Results();
  r.add('smoke', '2.1', 'x', STATUS.FAIL, ['boom | pipe']);
  r.add('smoke', '2.2', 'y', STATUS.NOT_RUN, ['no claude']);
  const md = renderReport({ results: r, meta: { commit: 'abc' } });
  assert.match(md, /What this does NOT prove/);
  assert.match(md, /SmartScreen/);
  assert.match(md, /Failures in detail/);
  assert.match(md, /1 check\(s\) FAILED/);
  assert.ok(!md.includes('\u2014'));
});
