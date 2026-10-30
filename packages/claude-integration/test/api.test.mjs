import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as api from '../src/index.js';
import { root } from './helpers.mjs';

// The public API is src/index.js plus the hand-written src/index.d.ts that TypeScript consumers see. These tests fail when
// one of them is changed without the other, which is the one way a hand-written declaration file can silently rot.

const EXPECTED = [
  'Reducer', 'replay', 'LABELS',
  'Store', 'ingestSpoolFiles', 'pendingSpoolFiles',
  'createRegistry', 'canonicalize', 'detectEnv', 'loadRegistry', 'normPath',
  'parseMarker', 'REPORT_INSTRUCTION', 'PROTOCOL_VERSION',
  'takeSnapshot', 'tidOfSpoolName',
  'runAgentsJson', 'normalizeAgents', 'validateAgents', 'pidAlive', 'claudeBin', 'evaluateSeparateDiscovery', 'DOCUMENTED',
  'hookCommand', 'buildSettings', 'layout', 'isNormalConfigDir', 'EVENTS',
  'clockDomain', 'bootKey', 'markerOf', 'compareMarkers',
  'redactDeep', 'redactString', 'limitStrings',
];
const dts = fs.readFileSync(path.join(root, 'src', 'index.d.ts'), 'utf8');
const kindOf = (v) => (typeof v === 'function' ? (/^class[\s{]/.test(Function.prototype.toString.call(v)) ? 'class' : 'function') : 'const');

test('src/index.js exports exactly the public API, by name, and nothing else (no default export, no hook script)', () => {
  assert.deepEqual(Object.keys(api).sort(), [...EXPECTED].sort());
  assert.equal('default' in api, false);
  assert.equal(EXPECTED.length, new Set(EXPECTED).size);
});

test('index.d.ts declares every runtime export, with the right kind, and declares no value that does not exist', () => {
  const declared = new Map([...dts.matchAll(/^export (function|class|const) ([A-Za-z_$][\w$]*)/gm)].map((m) => [m[2], m[1]]));
  assert.deepEqual([...declared.keys()].sort(), [...EXPECTED].sort());
  for (const name of EXPECTED) assert.equal(declared.get(name), kindOf(api[name]), `${name} is declared as ${declared.get(name)} but is a ${kindOf(api[name])}`);
});

test('re-exports are the module bindings themselves, and importing the package runs no hook', async () => {
  const lib = (f) => import(`../src/lib/${f}.mjs`);
  assert.equal(api.Reducer, (await lib('reducer')).Reducer);
  assert.equal(api.Store, (await lib('store')).Store);
  assert.equal(api.ingestSpoolFiles, (await lib('spool')).ingestSpoolFiles);
  assert.equal(api.takeSnapshot, (await lib('snapshot')).takeSnapshot);
  assert.equal(api.hookCommand, (await lib('setup')).hookCommand);
  assert.equal(api.parseMarker, (await lib('marker')).parseMarker);
  assert.equal(api.compareMarkers, (await lib('clock')).compareMarkers);
  assert.equal(api.createRegistry, (await lib('registry')).createRegistry);
  assert.equal(api.redactDeep, (await lib('redact')).redactDeep);
  assert.equal(api.REPORT_INSTRUCTION, (await lib('protocol')).REPORT_INSTRUCTION);
  assert.equal(api.runAgentsJson, (await lib('discovery')).runAgentsJson);
});

test('the literal unions in index.d.ts match the runtime: session states, hook events, protocol version', () => {
  const literals = (src) => [...src.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const stateBlock = /export type SessionState =([\s\S]*?);/.exec(dts)[1];
  assert.deepEqual(literals(stateBlock).sort(), ['unknown', ...Object.keys(api.LABELS)].sort(), 'SessionState = unknown + every key of LABELS');
  const eventsBlock = /export const EVENTS: readonly \[([\s\S]*?)\];/.exec(dts)[1];
  assert.deepEqual(literals(eventsBlock), [...api.EVENTS], 'EVENTS tuple, in order');
  assert.match(dts, new RegExp(`export const PROTOCOL_VERSION: ${api.PROTOCOL_VERSION};`));
  assert.deepEqual(Object.keys(api.DOCUMENTED).sort(), ['always', 'background_only', 'conditional', 'while_alive']);
  for (const k of ['always', 'background_only', 'conditional', 'while_alive']) assert.match(dts, new RegExp(`readonly ${k}: readonly string\\[\\];`));
});

test('package.json points at files that exist and keeps its name and scripts; build output is git-ignored', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@minisumma/claude-integration');
  assert.equal(pkg.type, 'module');
  for (const f of [pkg.main, pkg.types, pkg.exports['.'].default, pkg.exports['.'].types]) assert.ok(fs.existsSync(path.join(root, f)), `${f} exists`);
  assert.equal(pkg.types, './src/index.d.ts'); assert.equal(pkg.main, './src/index.js');
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
  assert.match(pkg.scripts['build:hook'], /^esbuild src\/hook\/capture\.mjs .*--outfile=dist\/capture\.mjs$/);
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json');
  assert.equal(pkg.dependencies, undefined, 'zero runtime dependencies: the hook and the library run on plain Node');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('dist/'), 'dist/ is build output');
});

test('docs/CHANGES-FROM-POC.md has one section per divergence, and each has regression tests titled "CHANGE n"', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'CHANGES-FROM-POC.md'), 'utf8');
  const sources = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs'))
    .map((f) => fs.readFileSync(path.join(root, 'test', f), 'utf8')).join('\n');
  assert.equal([...doc.matchAll(/^## \d+\. /gm)].length, 8, 'eight numbered sections');
  for (let n = 1; n <= 8; n++) {
    assert.match(doc, new RegExp(`^## ${n}\\. `, 'm'), `section ${n}`);
    assert.ok(new RegExp(`test\\('CHANGE ${n}[: ]`).test(sources), `a test titled "CHANGE ${n}"`);
  }
});
