import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { root, S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 7 (docs/CHANGES-FROM-POC.md): the package manifest exposes where the hook is, so the desktop app can find the file it
// has to copy next to the user's Claude settings without reaching into the package's folders. The proof of concept had no
// package and no such need. "." is unchanged.

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const NAME = pkg.name;

test('CHANGE 7: exports keeps "." exactly as it was and adds ./hook, ./hook-source and ./package.json', () => {
  assert.deepEqual(pkg.exports, {
    '.': { types: './src/index.d.ts', default: './src/index.js' },
    './hook': './dist/capture.mjs',
    './hook-source': './src/hook/capture.mjs',
    './package.json': './package.json',
  });
  assert.equal(pkg.main, './src/index.js'); assert.equal(pkg.types, './src/index.d.ts');
});

test('CHANGE 7: ./hook is the file `npm run build:hook` writes, and ./hook-source is the script it bundles', () => {
  const script = pkg.scripts['build:hook'];
  const outfile = /--outfile=(\S+)/.exec(script)[1];
  const entry = script.split(/\s+/)[1];
  assert.equal(`./${outfile}`, pkg.exports['./hook']);
  assert.equal(`./${entry}`, pkg.exports['./hook-source']);
  assert.ok(fs.existsSync(path.join(root, entry)), 'the source exists');
});

test('CHANGE 7: the subpaths resolve through the package name, and nothing else inside the package does', () => {
  assert.equal(fs.realpathSync(require.resolve(`${NAME}/package.json`)), fs.realpathSync(path.join(root, 'package.json')));
  assert.equal(fs.realpathSync(require.resolve(`${NAME}/hook-source`)), fs.realpathSync(path.join(root, 'src', 'hook', 'capture.mjs')));
  assert.equal(fs.realpathSync(require.resolve(NAME)), fs.realpathSync(path.join(root, 'src', 'index.js')));
  // ./hook points into dist/, which only exists after a build: when it is there it resolves to it, when it is not the error is
  // "not found", never "not exported"
  if (fs.existsSync(path.join(root, 'dist', 'capture.mjs'))) {
    assert.equal(fs.realpathSync(require.resolve(`${NAME}/hook`)), fs.realpathSync(path.join(root, 'dist', 'capture.mjs')));
  } else {
    assert.throws(() => require.resolve(`${NAME}/hook`), (e) => e.code === 'MODULE_NOT_FOUND');
  }
  // the package's inside stays private
  for (const inside of ['src/lib/store.mjs', 'src/hook/capture.mjs', 'dist/capture.mjs', 'test/helpers.mjs', 'src/index.js']) {
    assert.throws(() => require.resolve(`${NAME}/${inside}`), (e) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', inside);
  }
  // and the same through an ES module import.meta.resolve
  assert.equal(fileURLToPath(import.meta.resolve(`${NAME}/hook-source`)), fs.realpathSync(path.join(root, 'src', 'hook', 'capture.mjs')));
});

test('CHANGE 7: the file ./hook-source names is the working hook (what a consumer would copy or run)', (t) => {
  const d = tmpDir(t, 'exports-hook'); const spool = path.join(d, 'spool');
  const hook = require.resolve(`${NAME}/hook-source`);
  const env = { ...process.env }; for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'MINI_SUMMA_SPOOL', 'MINI_SUMMA_REGISTRY']) delete env[k];
  const r = spawnSync(process.execPath, [hook, '--spool', spool, '--env', 'posix', '--handler', 'h1', 'Stop'],
    { input: JSON.stringify({ session_id: S1, hook_event_name: 'Stop' }), encoding: 'utf8', env });
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.equal(fs.readdirSync(spool).filter((f) => f.endsWith('.json')).length, 1);
});
