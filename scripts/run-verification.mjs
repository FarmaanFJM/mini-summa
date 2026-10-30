#!/usr/bin/env node
// Runs every verification layer that this machine can run, one after another, and prints an honest summary.
// Every layer ends as PASS, FAIL or NOT RUN (with the reason). A layer that did not execute is never shown as passed,
// and a layer that ran here says where it ran: Linux results say nothing about Windows or WSL2.
//
//   node scripts/run-verification.mjs                      all layers that can run here
//   node scripts/run-verification.mjs --only core,desktop  just these layers
//   node scripts/run-verification.mjs --skip e2e           everything except these
//   node scripts/run-verification.mjs --with-real-claude   also run the real Claude CLI check (costs two short replies)
//   node scripts/run-verification.mjs --json results.json  also write the machine-readable result
//
// Layers: typecheck shared storage claude-integration poc core desktop extension android android-core-check
//         extension-browser extension-core desktop-smoke e2e real-claude
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const list = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1].split(',') : null; };
const only = list('--only');
const skip = list('--skip') ?? [];
const withRealClaude = argv.includes('--with-real-claude');
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const have = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore', shell: isWin }).status === 0;
const xvfb = process.platform === 'linux' ? (have('xvfb-run', ['--help']) ? ['xvfb-run', '-a'] : null) : [];

// ---- parsers: each returns { tests, passed, failed, skipped } or null when the output has no counts ----------------------
const num = (s, re) => { const m = re.exec(s); return m ? Number(m[1]) : 0; };
const parsers = {
  vitest(out) {
    const line = out.split('\n').reverse().find((l) => /^\s*Tests\s+\d/.test(l));
    if (!line) return null;
    return { passed: num(line, /(\d+) passed/), failed: num(line, /(\d+) failed/), skipped: num(line, /(\d+) skipped/), tests: num(line, /\((\d+)\)\s*$/) };
  },
  nodetest(out) {
    if (!/^# tests /m.test(out)) return null;
    return { tests: num(out, /^# tests (\d+)/m), passed: num(out, /^# pass (\d+)/m), failed: num(out, /^# fail (\d+)/m), skipped: num(out, /^# skipped (\d+)/m) };
  },
  jest(out) {
    const line = out.split('\n').find((l) => /^Tests:\s/.test(l));
    if (!line) return null;
    return { tests: num(line, /(\d+) total/), passed: num(line, /(\d+) passed/), failed: num(line, /(\d+) failed/), skipped: num(line, /(\d+) skipped/) };
  },
  passfail(out) {
    const lines = out.split('\n').filter((l) => /^\s*(PASS|FAIL|NOT TESTED)\b/.test(l));
    if (!lines.length) return null;
    const c = (w) => lines.filter((l) => l.trim().startsWith(w)).length;
    return { tests: lines.length, passed: c('PASS'), failed: c('FAIL'), skipped: c('NOT TESTED') };
  },
};

const unit = (id, title, args, parser, cwd = root, needs = () => null) => ({ id, title, cmd: npm, args, cwd, parser, needs });
const layers = [
  unit('typecheck', 'Type check of every workspace', ['run', 'typecheck'], null),
  unit('shared', 'Unit: shared contracts, ChatGPT URL rules, client state', ['test', '-w', '@minisumma/shared'], 'vitest'),
  unit('storage', 'Unit: SQLite storage and migrations', ['test', '-w', '@minisumma/storage'], 'vitest'),
  unit('claude-integration', 'Unit: hook capture, reducer, discovery (ported library)', ['test', '-w', '@minisumma/claude-integration'], 'nodetest'),
  unit('poc', 'Unit: the immutable research record (PoC tests)', ['run', 'test:poc'], 'nodetest'),
  unit('core', 'Service and integration: core services, HTTP/WS, real core + PTY + fake Claude, four-project routing', ['test', '-w', '@minisumma/core'], 'vitest'),
  unit('desktop', 'Unit and component: Electron main process and React renderer', ['test', '-w', '@minisumma/desktop'], 'vitest'),
  unit('extension', 'Unit: browser extension', ['test', '-w', '@minisumma/browser-extension'], 'vitest'),
  unit('android', 'Unit: Android companion (jest)', ['test', '--', '--ci'], 'jest', join(root, 'apps/android'),
    () => (existsSync(join(root, 'apps/android/node_modules')) ? null : 'apps/android has its own install: run "npm install" there first')),
  unit('android-core-check', 'Integration: phone pairing, connection and send code against the real headless core', ['run', 'check:core'], 'passfail', join(root, 'apps/android'),
    () => (existsSync(join(root, 'apps/android/node_modules')) ? null : 'apps/android has its own install: run "npm install" there first')),
];

const xvfbLayer = (id, title, script, args, parser, preBuild = null) => ({
  id, title, parser,
  needs: () => (xvfb === null ? 'needs Linux with xvfb-run (and Chromium or Electron) installed' : null),
  run: () => {
    if (preBuild) { const b = spawnSync(preBuild[0], preBuild[1], { cwd: root, encoding: 'utf8', shell: isWin }); if (b.status !== 0) return { status: b.status ?? 1, out: `${b.stdout}\n${b.stderr}` }; }
    const cmd = [...(xvfb ?? []), script, ...args];
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: isWin });
    return { status: r.status ?? 1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  },
});
const desktopBuild = [npm, ['run', 'build', '-w', '@minisumma/desktop']];
layers.push(
  xvfbLayer('extension-browser', 'Browser integration: the extension in a real Chromium (tab focus, open, no duplicates)', 'node', ['apps/browser-extension/test/real-browser.mjs'], 'passfail', [npm, ['run', 'build:test', '-w', '@minisumma/browser-extension']]),
  xvfbLayer('extension-core', 'Browser integration: the extension in a real Chromium, paired with the real core', 'node', ['apps/browser-extension/test/with-real-core.mjs'], 'passfail', [npm, ['run', 'build:test', '-w', '@minisumma/browser-extension']]),
  xvfbLayer('desktop-smoke', 'Desktop: Electron starts with the real embedded core, serves the UI, quits cleanly', 'node', ['apps/desktop/scripts/smoke-real-core.mjs', '--dev'], 'passfail', desktopBuild),
  xvfbLayer('e2e', 'Desktop acceptance: the 25 behaviours and the four-project scenario in the real Electron app', npm, ['run', 'e2e', '-w', '@minisumma/desktop'], 'vitest', desktopBuild),
  {
    id: 'real-claude', title: 'Real Claude Code CLI through the core (managed launch, hooks, report, restart, resume)', parser: 'passfail',
    needs: () => (!withRealClaude ? 'not requested (add --with-real-claude; it sends two short prompts to Claude)' : !have('claude') ? 'the claude CLI is not on PATH' : null),
    run: () => { const r = spawnSync(npm, ['run', 'verify:claude'], { cwd: root, encoding: 'utf8', shell: isWin, maxBuffer: 16 * 1024 * 1024 }); return { status: r.status ?? 1, out: `${r.stdout}\n${r.stderr}` }; },
  },
);

// ---- run ----------------------------------------------------------------------------------------------------------------
const selected = layers.filter((l) => (only ? only.includes(l.id) : true) && !skip.includes(l.id));
const results = [];
for (const layer of selected) {
  const reason = layer.needs?.() ?? null;
  if (reason) { results.push({ id: layer.id, title: layer.title, status: 'NOT RUN', detail: reason }); console.log(`NOT RUN  ${layer.id}: ${reason}`); continue; }
  const t0 = Date.now();
  process.stdout.write(`RUNNING  ${layer.id} ...\n`);
  let status; let out;
  if (layer.run) ({ status, out } = layer.run());
  else { const r = spawnSync(layer.cmd, layer.args, { cwd: layer.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: isWin }); status = r.status ?? 1; out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`; }
  const counts = layer.parser ? parsers[layer.parser](out) : null;
  const failed = status !== 0 || (counts?.failed ?? 0) > 0;
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const result = { id: layer.id, title: layer.title, status: failed ? 'FAIL' : 'PASS', seconds, ...(counts ?? {}) };
  if (failed) result.detail = out.split('\n').filter((l) => /FAIL|Error|error TS|✗|×/.test(l)).slice(0, 12).join('\n');
  results.push(result);
  console.log(`${result.status.padEnd(8)} ${layer.id}${counts ? `  ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped of ${counts.tests}` : ''}  (${seconds}s)`);
  if (failed && result.detail) console.log(result.detail.split('\n').map((l) => `           ${l}`).join('\n'));
}

console.log(`\nPlatform: ${os.platform()} ${os.release()}, Node ${process.version}. Windows, WSL2, real devices and the real ChatGPT site are not covered by any layer here.`);
const bad = results.filter((r) => r.status === 'FAIL').length;
console.log(`${results.filter((r) => r.status === 'PASS').length} passed, ${bad} failed, ${results.filter((r) => r.status === 'NOT RUN').length} not run`);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ generatedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()}`, node: process.version, results }, null, 2)}\n`);
process.exitCode = bad > 0 ? 1 : 0;
