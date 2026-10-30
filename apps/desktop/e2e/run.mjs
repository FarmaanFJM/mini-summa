#!/usr/bin/env node
// `npm run e2e` (from apps/desktop): runs the Electron acceptance suite, then writes the report.
//
//   npm run e2e                                         the whole suite, then docs/ACCEPTANCE.md
//   npm run e2e -- e2e/tests/a22-a23-restart.e2e.ts     a part of it (any vitest arguments); the report of an incomplete run goes
//                                                       to e2e/results/ACCEPTANCE.partial.md and docs/ACCEPTANCE.md is left alone
//
// Electron needs a display. On Linux without one this script starts itself again under xvfb-run, on a virtual screen of
// 1280x1024x24. The exit code is vitest's: 0 only if every test passed or declared itself NOT TESTED.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const resultsDir = path.join(here, 'results');
const args = process.argv.slice(2);
const SCREEN = '-screen 0 1280x1024x24';

const onPath = (name) => (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
  try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
});

const exitCodeOf = (code, signal) => code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);

function vitestBin() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('vitest/package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.vitest;
  return path.join(path.dirname(manifestPath), bin);
}

/** Runs a command with this terminal, hands Ctrl-C and termination on to it, and resolves with its exit code. */
function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
    const relay = ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => { try { child.kill(signal); } catch { /* already gone */ } }]);
    for (const [signal, handler] of relay) process.on(signal, handler);
    const done = (code) => { for (const [signal, handler] of relay) process.off(signal, handler); resolve(code); };
    child.on('error', (error) => { console.error(`e2e: could not start ${command}: ${error.message}`); done(1); });
    child.on('exit', (code, signal) => done(exitCodeOf(code, signal)));
  });
}

async function main() {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    if (!onPath('xvfb-run')) {
      console.error('e2e: there is no display (DISPLAY is not set) and xvfb-run is not installed. Install Xvfb (for example `apt-get install xvfb`) or run this from a session that has a display.');
      return 2;
    }
    console.error(`e2e: no DISPLAY, so running under xvfb-run (${SCREEN}).`);
    return run('xvfb-run', ['-a', '-s', SCREEN, process.execPath, fileURLToPath(import.meta.url), ...args]);
  }

  const startedAt = new Date();
  const exitCode = await run(process.execPath, [vitestBin(), 'run', '--config', 'vitest.e2e.config.ts', ...args], { cwd: appDir });
  const finishedAt = new Date();

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'run.json'), `${JSON.stringify({ startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt - startedAt, exitCode, args }, null, 2)}\n`);
  try {
    const { target, model } = generate({ record: true });
    const where = path.relative(process.cwd(), target) || target;
    console.log(`\ne2e: behaviours ${model.behaviourCounts.pass} PASS, ${model.behaviourCounts.fail} FAIL, ${model.behaviourCounts.partial} PARTIAL, ${model.behaviourCounts.notTested} NOT TESTED; extra checks ${model.extraCounts.pass} PASS, ${model.extraCounts.fail} FAIL, ${model.extraCounts.notTested + model.extraCounts.partial} not fully tested.`);
    console.log(model.complete ? `e2e: report written to ${where}` : `e2e: this run was incomplete (a filtered run, or tests that did not run), so the report went to ${where}; docs/ACCEPTANCE.md was not touched.`);
  } catch (error) {
    console.error(`\ne2e: no report was written: ${error.message}`);
    return exitCode === 0 ? 1 : exitCode;
  }
  return exitCode;
}

process.exitCode = await main();
