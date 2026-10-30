import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, S1 } from './helpers.mjs';
import { REPORT_INSTRUCTION } from '../src/lib/protocol.mjs';
import { redactDeep } from '../src/lib/redact.mjs';

// The hook ships as ONE file (`npm run build:hook` -> dist/capture.mjs) that the desktop app copies next to the user's
// Claude settings and that Claude Code starts for every hook event, on a machine that has no node_modules for it. This
// builds it exactly like the script does (same flags, read from package.json), into a temp directory outside the
// repository, and runs the result as a child process.

let esbuild;
try { esbuild = await import('esbuild'); } catch (e) {
  throw new Error(`esbuild is needed to build the hook bundle (a root devDependency): run "npm install" at the repository root. ${e.message}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-summa-bundle-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

// `esbuild <entry> --bundle --platform=node ...` from package.json, as esbuild API options. A flag this does not know
// fails loudly, so the test cannot silently build something different from what the script builds.
function optionsFromScript(script, outfile) {
  const tokens = script.trim().split(/\s+/);
  assert.equal(tokens[0], 'esbuild', `build:hook should be an esbuild command line, got: ${script}`);
  const options = { entryPoints: [], absWorkingDir: root, logLevel: 'silent' };
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('--')) { options.entryPoints.push(token); continue; }
    const [key, ...rest] = token.slice(2).split('=');
    if (!['bundle', 'platform', 'format', 'target', 'outfile'].includes(key)) throw new Error(`bundle test cannot map the esbuild flag ${token}`);
    options[key] = rest.length ? rest.join('=') : true;
  }
  options.outfile = outfile;
  return options;
}
const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['build:hook'];
const bundleFile = path.join(work, 'dist', 'capture.mjs');
const built = esbuild.buildSync(optionsFromScript(script, bundleFile));

// The environment variables the hook reads must not leak in from whoever runs the tests.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_REMOTE', 'MINI_SUMMA_SPOOL', 'MINI_SUMMA_REGISTRY', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  return env;
}
const ENV = process.platform === 'win32' ? 'win' : 'posix';
function runHook(file, { spool, registry, event, input, env = ENV }) {
  const args = [file];
  if (spool) args.push('--spool', spool);
  if (registry) args.push('--registry', registry);
  args.push('--env', env, '--handler', 'h1');
  if (event) args.push(event);
  return spawnSync(process.execPath, args, { input, encoding: 'utf8', env: cleanEnv(), cwd: work });
}
const spoolFiles = (spool) => (fs.existsSync(spool) ? fs.readdirSync(spool).sort() : []);
const readRecord = (spool, name) => JSON.parse(fs.readFileSync(path.join(spool, name), 'utf8'));
let counter = 0;
const fresh = (name) => { const d = path.join(work, `${name}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sessionStart = (cwd) => ({ session_id: S1, transcript_path: 'synthetic', cwd, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-x' });

test('build:hook produces one ESM file with a shebang whose only imports are node: built-ins', () => {
  assert.equal(built.errors.length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(bundleFile)), ['capture.mjs'], 'a single output file');
  const text = fs.readFileSync(bundleFile, 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'), 'the shebang of capture.mjs is kept');
  const specifiers = [
    ...text.matchAll(/^\s*(?:import|export)\b[^'"\n;]*?\bfrom\s*["']([^"']+)["']/gm),
    ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
  assert.ok(specifiers.length >= 3, `expected the bundle to import node built-ins, found ${JSON.stringify(specifiers)}`);
  for (const s of specifiers) assert.match(s, /^node:/, `runtime import of "${s}" would need node_modules`);
  assert.ok(!/\bimport\.meta\b/.test(text), 'nothing resolves files relative to the source tree');
  assert.ok(!text.includes(root), 'no absolute path of this checkout is baked in');
});

test('SessionStart through the bundle: exit 0, one <mono>-<uuid>.json spool file, payload unchanged, silent without a registry', () => {
  const spool = path.join(fresh('plain'), 'spool');
  const payload = sessionStart(work);
  const r = runHook(bundleFile, { spool, event: 'SessionStart', input: JSON.stringify(payload) });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  const files = spoolFiles(spool);
  assert.equal(files.length, 1);
  const m = /^(\d{20})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(files[0]);
  assert.ok(m, `unexpected spool file name ${files[0]}`);
  const rec = readRecord(spool, files[0]);
  assert.equal(rec.schema, 'mini-summa.spool/1');
  assert.deepEqual(rec.payload, payload, 'nothing in this payload needs redaction, so it is stored unchanged');
  assert.equal(rec.transport.transport_id, m[2]);
  assert.equal(m[1], rec.transport.monotonic_ns.padStart(20, '0'));
  assert.equal(rec.transport.hook_arg, 'SessionStart'); assert.equal(rec.transport.handler_id, 'h1'); assert.equal(rec.transport.env_id, ENV);
  assert.equal(rec.transport.redactions, 0); assert.equal(rec.transport.parse_error, null);
  assert.equal(rec.transport.capture_version, 1); assert.equal(rec.transport.pid > 0, true);
  assert.ok(!fs.readdirSync(spool).some((f) => f.startsWith('.tmp-')), 'no temp residue');
});

test('the bundle redacts exactly like the library: credentials never reach the spool, everything else is unchanged', () => {
  const spool = path.join(fresh('redact'), 'spool');
  const payload = { session_id: S1, cwd: work, hook_event_name: 'PreToolUse', tool_use_id: 't1', tool_name: 'Bash', prompt_id: 'p1',
    tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" https://example.invalid', env: { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETSECRET' } }, context_tokens: 91234 };
  const r = runHook(bundleFile, { spool, event: 'PreToolUse', input: JSON.stringify(payload) });
  assert.equal(r.status, 0);
  const [name] = spoolFiles(spool);
  const text = fs.readFileSync(path.join(spool, name), 'utf8');
  assert.ok(!/SECRETSECRET|abcdefghijklmnopqrstuv/.test(text));
  const rec = JSON.parse(text);
  assert.deepEqual(rec.payload, redactDeep(payload));
  assert.ok(rec.transport.redactions >= 2);
  assert.equal(rec.payload.context_tokens, 91234, 'numeric counters are not credentials');
});

test('with --registry the bundle prints the documented hookSpecificOutput.additionalContext for a registered project, and nothing otherwise', () => {
  const d = fresh('registry');
  const repo = path.join(d, 'repo'); const elsewhere = path.join(d, 'elsewhere');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(elsewhere);
  const registry = path.join(d, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ defaultEnv: ENV, projects: [{ id: 'p-repo', name: 'Repo', roots: [repo] }] }));

  const yes = runHook(bundleFile, { spool: path.join(d, 's1'), registry, event: 'SessionStart', input: JSON.stringify(sessionStart(path.join(repo, 'src'))) });
  assert.equal(yes.status, 0, yes.stderr); assert.equal(yes.stderr, '');
  assert.deepEqual(JSON.parse(yes.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: REPORT_INSTRUCTION } });
  assert.equal(yes.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: REPORT_INSTRUCTION } }), 'only that JSON, no decision fields, no newline');

  const no = runHook(bundleFile, { spool: path.join(d, 's2'), registry, event: 'SessionStart', input: JSON.stringify(sessionStart(elsewhere)) });
  assert.equal(no.status, 0); assert.equal(no.stdout, ''); assert.equal(no.stderr, '');

  const sibling = runHook(bundleFile, { spool: path.join(d, 's3'), registry, event: 'SessionStart', input: JSON.stringify(sessionStart(`${repo}-old`)) });
  assert.equal(sibling.stdout, '', 'a directory that merely shares a string prefix is not the project');

  const stop = runHook(bundleFile, { spool: path.join(d, 's4'), registry, event: 'Stop', input: JSON.stringify({ session_id: S1, cwd: repo, hook_event_name: 'Stop', last_assistant_message: 'x' }) });
  assert.equal(stop.status, 0); assert.equal(stop.stdout, '', 'only SessionStart ever prints');

  const missing = runHook(bundleFile, { spool: path.join(d, 's5'), registry: path.join(d, 'nope.json'), event: 'SessionStart', input: JSON.stringify(sessionStart(repo)) });
  assert.equal(missing.status, 0); assert.equal(missing.stdout, '', 'an unreadable registry never breaks the hook');

  for (const s of ['s1', 's2', 's3', 's4', 's5']) assert.equal(spoolFiles(path.join(d, s)).filter((f) => f.endsWith('.json')).length, 1, `${s}: the event is captured whether or not context is injected`);
});

test('the bundle always exits 0 and stays silent: malformed or empty stdin, an unusable spool, no spool at all', () => {
  const d = fresh('bad');
  const malformed = runHook(bundleFile, { spool: path.join(d, 'spool'), event: 'Stop', input: '{not json' });
  assert.equal(malformed.status, 0); assert.equal(malformed.stdout, '');
  const [name] = spoolFiles(path.join(d, 'spool'));
  const rec = readRecord(path.join(d, 'spool'), name);
  assert.ok(rec.transport.parse_error); assert.deepEqual(Object.keys(rec.payload), ['unparsed_stdin_prefix']);

  assert.equal(runHook(bundleFile, { spool: path.join(d, 'spool2'), event: 'Stop', input: '' }).status, 0);
  fs.writeFileSync(path.join(d, 'spoolfile'), 'x'); // the spool path is a regular file
  const blocked = runHook(bundleFile, { spool: path.join(d, 'spoolfile'), event: 'Stop', input: JSON.stringify({ session_id: S1, hook_event_name: 'Stop' }) });
  assert.equal(blocked.status, 0); assert.equal(blocked.stdout, ''); assert.equal(blocked.stderr, '');
  assert.ok(fs.existsSync(path.join(d, 'capture-errors.log')), 'the error is logged beside the spool, not shown to Claude');
  const none = runHook(bundleFile, { event: 'Stop', input: '{}' });
  assert.equal(none.status, 0); assert.equal(none.stdout, ''); assert.equal(none.stderr, '');
});

test('the bundle behaves like the source script: same record shape, same payload, same stdout', () => {
  const d = fresh('same');
  const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
  const registry = path.join(d, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ defaultEnv: ENV, projects: [{ id: 'p', name: 'P', roots: [repo] }] }));
  const source = path.join(root, 'src', 'hook', 'capture.mjs');
  const payloads = [sessionStart(repo), { session_id: S1, cwd: repo, hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: 'ünïcödé ✓\r\n\ttabs', background_tasks: [], session_crons: [] },
    { session_id: S1, cwd: repo, hook_event_name: 'PostToolUse', tool_use_id: 't', tool_response: { content: 'y'.repeat(9000) } }];
  for (const payload of payloads) {
    const out = {};
    for (const [label, file] of [['bundle', bundleFile], ['source', source]]) {
      const spool = path.join(d, `${label}-${payload.hook_event_name}`);
      const r = runHook(file, { spool, registry, event: payload.hook_event_name, input: JSON.stringify(payload) });
      assert.equal(r.status, 0, r.stderr);
      const [name] = spoolFiles(spool);
      out[label] = { stdout: r.stdout, rec: readRecord(spool, name) };
    }
    assert.equal(out.bundle.stdout, out.source.stdout, payload.hook_event_name);
    assert.deepEqual(out.bundle.rec.payload, out.source.rec.payload, payload.hook_event_name);
    assert.deepEqual(Object.keys(out.bundle.rec.transport), Object.keys(out.source.rec.transport));
    for (const k of ['capture_version', 'hook_arg', 'handler_id', 'env_id', 'clock_domain', 'redactions', 'truncations', 'truncated_chars', 'parse_error']) {
      assert.deepEqual(out.bundle.rec.transport[k], out.source.rec.transport[k], `${payload.hook_event_name}: transport.${k}`);
    }
  }
});
