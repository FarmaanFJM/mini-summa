#!/usr/bin/env node
// Writes docs/ACCEPTANCE.md from what the acceptance suite recorded, and from nothing else.
//
//   npm run e2e:report                 (from apps/desktop) rebuilds the report from the last run in e2e/results/
//
// Inputs, all written by the run itself:
//   e2e/results/vitest-results.json   one entry per test: status, duration, failure, and `meta` with the evidence lines and the
//                                     NOT TESTED reason that the test recorded (see e2e/helpers/evidence.ts)
//   e2e/results/meta.json             platform, display server, Electron version, source commit (global setup)
//   e2e/results/run.json              wall-clock time of the whole `npm run e2e`, including the build (e2e/run.mjs)
//   e2e/results/runs.jsonl            one line per earlier run, for the "recent runs" table (e2e/run.mjs)
//   e2e/behaviours.json               the 25 behaviours and the critical scenario, in order, and the extra checks
//
// Statuses, and only these:
//   PASS         every test of the behaviour was executed and every assertion held
//   FAIL         a test was executed and an assertion did not hold (the row says what; it is a product defect or a test defect)
//   PARTIAL      some of it was executed and held, and some of it is NOT TESTED (the row says which, and why)
//   NOT TESTED   not executed: the test said why, or it did not run, or no test exists. Never shown as PASS.
// A behaviour with no test in the results is NOT TESTED. Nothing is ever PASS by default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(E2E_DIR, '..');
const REPO_ROOT = path.resolve(APP_DIR, '../..');
const RESULTS_DIR = path.join(E2E_DIR, 'results');
const FILES = {
  results: path.join(RESULTS_DIR, 'vitest-results.json'),
  meta: path.join(RESULTS_DIR, 'meta.json'),
  run: path.join(RESULTS_DIR, 'run.json'),
  history: path.join(RESULTS_DIR, 'runs.jsonl'),
  behaviours: path.join(E2E_DIR, 'behaviours.json'),
  doc: path.join(REPO_ROOT, 'docs', 'ACCEPTANCE.md'),
  partial: path.join(RESULTS_DIR, 'ACCEPTANCE.partial.md'),
};

const STATUS = { pass: 'PASS', fail: 'FAIL', partial: 'PARTIAL', notTested: 'NOT TESTED' };
const ID = /^\[([A-Z]+\d*)\]\s*/;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonIfThere = (file) => { try { return readJson(file); } catch { return null; } };

// ---------------------------------------------------------------------------------------------------------------
// Results -> rows

/** Every test in the results file as { id, text, status, reason, evidence, failure, durationMs }. */
export function testsOf(results) {
  const tests = [];
  for (const file of results.testResults ?? []) {
    const name = path.basename(file.name ?? 'unknown file');
    for (const a of file.assertionResults ?? []) {
      const meta = a.meta ?? {};
      tests.push({
        id: ID.exec(a.title)?.[1] ?? null,
        text: a.title.replace(ID, ''),
        file: name,
        status: a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : 'notTested',
        reason: typeof meta.notTested === 'string' ? meta.notTested : null,
        evidence: Array.isArray(meta.evidence) ? meta.evidence : [],
        failure: (a.failureMessages ?? [])[0] ?? null,
        durationMs: a.duration ?? 0,
      });
    }
    // A test file that could not even be loaded has no tests, only a message. That is a failure, not an absence.
    if ((file.assertionResults ?? []).length === 0 && file.status === 'failed') {
      tests.push({ id: null, text: `${name} could not be run`, file: name, status: 'fail', reason: null, evidence: [], failure: file.message || 'The test file failed to load.', durationMs: 0 });
    }
  }
  return tests;
}

export function statusOf(tests) {
  if (tests.length === 0) return 'notTested';
  if (tests.some((t) => t.status === 'fail')) return 'fail';
  if (tests.every((t) => t.status === 'pass')) return 'pass';
  if (tests.every((t) => t.status === 'notTested')) return 'notTested';
  return 'partial';
}

const NOT_RUN = 'Not run in this invocation: the test was filtered out or skipped without a recorded reason.';
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const firstLine = (text) => clip(oneLine(String(text ?? '').split('\n').find((l) => l.trim()) ?? ''), 400);

function noteOf(status, tests) {
  const several = tests.length > 1;
  const label = (t, body) => (several ? `${t.text}: ${body}` : body);
  const reasons = tests.filter((t) => t.status === 'notTested').map((t) => label(t, t.reason ?? NOT_RUN));
  switch (status) {
    case 'pass': return '';
    case 'fail': return tests.filter((t) => t.status === 'fail').map((t) => label(t, firstLine(t.failure))).join(' | ');
    case 'notTested': return tests.length === 0 ? 'No test for this behaviour appears in the results.' : reasons.join(' | ');
    default: {
      const done = tests.filter((t) => t.status === 'pass').map((t) => t.text).join('; ');
      return `Executed and asserted: ${done}. NOT TESTED: ${reasons.join(' | ')}`;
    }
  }
}

/** The whole picture: one row per behaviour and per extra check, the tests that match no id, and the counts. */
export function buildModel(results, behaviours) {
  const tests = testsOf(results);
  const row = (entry, kind) => {
    const mine = tests.filter((t) => t.id === entry.id);
    const status = statusOf(mine);
    return { ...entry, kind, tests: mine, status, note: noteOf(status, mine) };
  };
  const rows = behaviours.behaviours.map((b) => row(b, 'behaviour'));
  const extras = behaviours.extras.map((x) => row(x, 'extra'));
  const known = new Set([...rows, ...extras].map((r) => r.id));
  // Tests whose id is not listed are shown too: nothing the suite ran may disappear from the report.
  const others = tests.filter((t) => !known.has(t.id)).map((t) => ({ id: t.id ?? '—', title: t.text, kind: 'other', tests: [t], status: statusOf([t]), note: noteOf(statusOf([t]), [t]), why: null }));
  const count = (list) => Object.fromEntries(Object.keys(STATUS).map((k) => [k, list.filter((r) => r.status === k).length]));
  const unexplained = tests.filter((t) => t.status === 'notTested' && !t.reason);
  return {
    rows, extras, others,
    behaviourCounts: count(rows),
    extraCounts: count([...extras, ...others]),
    tests: { total: tests.length, passed: tests.filter((t) => t.status === 'pass').length, failed: tests.filter((t) => t.status === 'fail').length, notTested: tests.filter((t) => t.status === 'notTested').length },
    // Complete = every behaviour has a test and nothing was left unexplained (a filtered run is not complete).
    complete: rows.every((r) => r.tests.length > 0) && extras.every((r) => r.tests.length > 0) && unexplained.length === 0,
    testsMs: tests.reduce((sum, t) => sum + t.durationMs, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

const cell = (text) => oneLine(text).replace(/\|/g, '\\|');
const minutes = (ms) => {
  const total = Math.round(ms / 1000);
  return total >= 60 ? `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s` : `${total} s`;
};
const utc = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'unknown');
const countsLine = (c) => `${c.pass} PASS, ${c.fail} FAIL, ${c.partial} PARTIAL, ${c.notTested} NOT TESTED`;
const statusCell = (s) => (s === 'pass' ? STATUS.pass : `**${STATUS[s]}**`);

function platformLine(meta) {
  if (!meta) return 'unknown (no meta.json: the run did not get as far as writing it)';
  const os = meta.platform === 'linux' ? `Linux ${meta.release ?? ''} ${meta.arch ?? ''}`.trim() : `${meta.platform} ${meta.release ?? ''} ${meta.arch ?? ''}`.trim();
  const display = meta.displayServer ? ` under ${meta.displayServer}` : '';
  const root = meta.runningAsRoot ? ', as root (Electron is started with --no-sandbox, which Playwright adds for root)' : '';
  return `${os}${display}${root}`;
}

function sourceLine(meta) {
  const s = meta?.source;
  if (!s || !s.commit) return 'unknown (not a git checkout, or git was not available)';
  return `commit ${s.commit}${s.uncommittedChanges ? ' plus uncommitted changes (the run tested the working tree, not the commit alone)' : ''}`;
}

function evidenceSection(model) {
  const lines = [];
  for (const r of [...model.rows, ...model.extras, ...model.others]) {
    lines.push(`### ${r.id}. ${r.title} (${STATUS[r.status]})`, '');
    if (r.why) lines.push(`*Why this check exists:* ${r.why}`, '');
    if (r.tests.length === 0) { lines.push('- No test for this behaviour appears in the results.', ''); continue; }
    for (const t of r.tests) {
      const prefix = r.tests.length > 1 ? `*${t.text}*: ` : '';
      if (t.status === 'fail') {
        lines.push(`- ${prefix}**FAILED.** ${firstLine(t.failure)}`);
        const detail = String(t.failure ?? '').split('\n').slice(0, 14).join('\n');
        lines.push('', '  ```text', ...detail.split('\n').map((l) => `  ${l}`), '  ```');
      }
      if (t.status === 'notTested') lines.push(`- ${prefix}**NOT TESTED.** ${t.reason ?? NOT_RUN}`);
      for (const e of t.evidence) lines.push(`- ${prefix}${e}`);
      if (t.status === 'pass' && t.evidence.length === 0) lines.push(`- ${prefix}Passed; the test recorded no evidence line.`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function historySection(history, currentStartedAt) {
  const runs = history.filter((h) => h.complete).slice(-6);
  if (runs.length < 2) return '';
  const rows = runs.map((h) => `| ${utc(h.startedAt)} | ${minutes(h.durationMs)} | ${countsLine(h.behaviours)} | ${countsLine(h.extras)} | ${h.exitCode} |${h.startedAt === currentStartedAt ? ' this report |' : ' |'}`);
  return [
    '## Recent complete runs on the machine that produced this report', '',
    'One line per `npm run e2e` that ran every test. Runs are recorded by `e2e/run.mjs` in `apps/desktop/e2e/results/runs.jsonl` (not committed).', '',
    '| Started | Duration (build included) | Behaviours (25 + CRIT) | Extra checks | Exit code | |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows, '',
  ].join('\n');
}

export function render(model, { meta, run, history = [] }) {
  const behaviourTotal = model.rows.length;
  const started = run?.startedAt ?? meta?.startedAt ?? null;
  const duration = run ? `${minutes(run.durationMs)} for the whole run (build, tests, clean-up); the tests themselves took ${minutes(model.testsMs)} added together` : `${minutes(model.testsMs)} (tests added together; the build is not included)`;
  const notTested = [...model.rows, ...model.extras, ...model.others].filter((r) => r.tests.some((t) => t.status === 'notTested'));
  const failing = [...model.rows, ...model.extras, ...model.others].filter((r) => r.status === 'fail');

  const out = [];
  out.push('# Acceptance results: Mini-Summa desktop, end to end', '');
  out.push('> Generated by `npm run e2e:report` (in `apps/desktop`) from the results of `npm run e2e`. Do not edit by hand: the next run replaces this file.', '');
  out.push('**Windows and WSL2 were not exercised.** Everything below ran on Linux under a virtual X display. How Mini-Summa behaves on Windows (ConPTY terminals, Windows toast notifications and their AppUserModelID, the installer, tray, window frame, WSL2 path translation, Claude Code inside WSL2) is NOT TESTED by this suite; [WINDOWS_VERIFICATION.md](./WINDOWS_VERIFICATION.md) lists the checks that only a Windows PC can do, and [VERIFICATION.md](./VERIFICATION.md) keeps the results of the other layers apart from this one.', '');
  if (!model.complete) {
    out.push('**This report comes from an INCOMPLETE run**: some behaviours have no test result or were filtered out, so the rows below say NOT TESTED for them. It is not an acceptance result.', '');
  }
  if (failing.length > 0) {
    out.push(`**${failing.length} check${failing.length === 1 ? '' : 's'} failed in this run: ${failing.map((r) => r.id).join(', ')}.** The rows and the evidence below say what was executed and what did not hold.`, '');
  }

  out.push('## The run', '');
  out.push('| | |', '| --- | --- |');
  out.push(`| Date | ${utc(started)} |`);
  out.push(`| Platform | ${cell(platformLine(meta))} |`);
  out.push(`| Electron | ${meta?.electron ?? 'unknown'} (Chromium inside it; Node ${meta?.node ?? 'unknown'} runs the tests; Playwright ${meta?.playwright ?? 'unknown'} drives the window) |`);
  out.push(`| Source | ${cell(sourceLine(meta))} |`);
  out.push(`| App build | ${cell(meta?.appBuild ?? 'unknown')}: \`electron-vite build\` into a private temporary directory, plus the hook bundle; the run launches that build, never \`apps/desktop/out\` |`);
  out.push(`| Duration | ${cell(duration)} |`);
  out.push(`| Behaviours (${behaviourTotal}: A01 to A25 and the critical scenario) | **${countsLine(model.behaviourCounts)}** |`);
  out.push(`| Extra checks (not among the 25) | ${countsLine(model.extraCounts)} |`);
  out.push(`| Tests executed | ${model.tests.total} in all: ${model.tests.passed} passed, ${model.tests.failed} failed, ${model.tests.notTested} not tested |`);
  out.push('');

  out.push('## Results', '');
  out.push('| ID | Behaviour | Status | NOT TESTED reason, or what failed |', '| --- | --- | --- | --- |');
  for (const r of model.rows) out.push(`| ${r.id} | ${cell(r.title)} | ${statusCell(r.status)} | ${cell(r.note) || '—'} |`);
  out.push('');
  out.push('PASS means executed and asserted. FAIL means executed and an assertion did not hold (a product defect or a test defect; the evidence says which). PARTIAL means part of the behaviour was executed and held and part is NOT TESTED. NOT TESTED means it was not executed, with the reason. There is no status for "assumed to work".', '');

  out.push('## Extra checks', '');
  out.push('Not among the 25 behaviours. Each guards a defect that this suite found in the product, so that it stays fixed.', '');
  out.push('| ID | Check | Status | NOT TESTED reason, or what failed |', '| --- | --- | --- | --- |');
  for (const r of [...model.extras, ...model.others]) out.push(`| ${r.id} | ${cell(r.title)} | ${statusCell(r.status)} | ${cell(r.note) || '—'} |`);
  out.push('');

  out.push('## What was observed', '');
  out.push('One entry per test, written by the test itself from what it saw. Nothing here is copied from a design document or a unit test.', '');
  out.push(evidenceSection(model));

  if (notTested.length > 0) {
    out.push('## Not tested', '');
    for (const r of notTested) {
      for (const t of r.tests.filter((x) => x.status === 'notTested')) out.push(`- **${r.id}** (${t.text}): ${t.reason ?? NOT_RUN}`);
    }
    out.push('');
  }

  out.push('## Not covered by this suite at all', '');
  out.push(
    '- **Windows and WSL2**, as said above.',
    '- **The real Claude Code CLI.** Claude is the fake in `packages/core/src/testing/fake-claude`, which speaks the same terminal and hook contract. The real `claude` is never started: a decoy `claude` sits first on `PATH`, and every test fails if it was ever launched. (The real CLI is exercised by a separate check; see VERIFICATION.md.)',
    '- **The real ChatGPT site.** `chatgpt.com` is a local HTTPS stand-in reached through Chromium host rules; ChatGPT\'s own page, login, rate limits and its composer were not involved. What the suite proves is where Mini-Summa sent the embedded view and what it put on the clipboard.',
    '- **An operating-system view of the clipboard.** The clipboard is read back with Electron\'s `clipboard.readText()` in the app\'s main process; no second X client is installed here to read it as another application would.',
    '- **A window manager, other screen sizes and densities, multiple monitors, touch and a real pointer.** The display is Xvfb alone at a fixed size; pointer and keyboard events are injected through Playwright.',
    '- **GPU rendering.** Chromium falls back to software and the terminal uses xterm\'s DOM renderer, because WebGL is blocklisted under Xvfb.',
    '',
  );

  out.push('## How the suite is built', '');
  out.push(
    '- **Real:** the built Electron app, its embedded core, a real SQLite database, real pseudo-terminals, the real hook command that Claude runs (the built hook bundle, run by Electron in node mode), the real hook installer writing into a temporary `HOME` (A24), the real clipboard API, Chromium and xterm.',
    '- **Faked on purpose:** Claude (see above) and `chatgpt.com` (see above).',
    '- **Fail closed:** Chromium is told to resolve `chatgpt.com` to the stand-in and every other host name to "not found", proxies are disabled, and the stand-in records every request. X04 proves from inside the app, on every run, that other names do not resolve. After every test the suite asserts that no request for any other host arrived, that nothing but GET ever reached the stand-in (Mini-Summa must never submit text to ChatGPT), that the decoy `claude` never started, and that the window had no uncaught exception. Host rules cover host names: an address typed as a raw IP number is not stopped by them, and no test uses one.',
    '- **Isolated:** each test launches its own Electron on a fresh temporary data directory, with `HOME` and the `XDG_*` directories inside that test\'s temporary sandbox and a minimal environment. Four tests (A22, A23, X02, X03) quit the app and start it again on the same data directory on purpose. Every process a test started is killed and its sandbox deleted; a process that survives SIGKILL fails the test; and the suite waits for the core\'s preferred port 47811 to be free again, so that the next launch has the same address.',
    '- **Driven like a person:** the window is operated by accessible role and name (`getByRole`, `getByLabel`); no test ids were added to the product. What cannot be reached that way: the terminal\'s screen text (xterm\'s rows are plain `div`s without roles, read through CSS), the native ChatGPT view (its address and bounds come from the main process, `webContents.getAllWebContents()`), and the operating system\'s folder picker and quit question (answered by replacing `dialog.showOpenDialog` and `dialog.showMessageBox` in the main process, with the question recorded and asserted).',
    '- **No retries.** A test either passes in one go or fails. Each test has a finite timeout (120 s, a few 150 s).',
    '',
  );

  out.push('## Running it', '');
  out.push(
    'From `apps/desktop`, on Linux with `xvfb` installed (`xvfb-run`), Node 22, dependencies installed at the repository root, and port 47811 free:', '',
    '```bash',
    'npm run e2e                  # the whole suite, then this file. Starts its own Xvfb (1280x1024x24) when DISPLAY is not set',
    'npm run e2e -- e2e/tests/a22-a23-restart.e2e.ts      # one file (or add -t "[A22]"): the report goes to e2e/results/ACCEPTANCE.partial.md, not here',
    'npm run e2e:report           # rebuild this file from the last run\'s results',
    '```', '',
    'A failed test keeps a screenshot, the app\'s output and its logs under `apps/desktop/e2e/results/artifacts/`. `e2e/results/` is not committed.', '',
  );

  const recent = historySection(history, run?.startedAt ?? null);
  if (recent) out.push(recent);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points

export function generate({ record = false, out = null } = {}) {
  if (!fs.existsSync(FILES.results)) {
    throw new Error(`There are no results to report (${path.relative(process.cwd(), FILES.results)} is missing). Run  npm run e2e  first; if it stopped before the tests started, its output says why.`);
  }
  const results = readJson(FILES.results);
  const behaviours = readJson(FILES.behaviours);
  const meta = readJsonIfThere(FILES.meta);
  const run = readJsonIfThere(FILES.run);
  const model = buildModel(results, behaviours);
  if (model.tests.total === 0) throw new Error('The results file holds no tests. Nothing was reported.');

  if (record && run) {
    const entry = { startedAt: run.startedAt, durationMs: run.durationMs, exitCode: run.exitCode, complete: model.complete, behaviours: model.behaviourCounts, extras: model.extraCounts, tests: model.tests, source: meta?.source ?? null };
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.appendFileSync(FILES.history, `${JSON.stringify(entry)}\n`);
  }
  const history = fs.existsSync(FILES.history) ? fs.readFileSync(FILES.history, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const markdown = render(model, { meta, run, history });

  // A partial run must never overwrite the committed report.
  const target = out ?? (model.complete ? FILES.doc : FILES.partial);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown);
  return { target, model };
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const { target, model } = generate({ out: outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : null });
  const where = path.relative(process.cwd(), target) || target;
  console.log(`Behaviours: ${countsLine(model.behaviourCounts)}. Extra checks: ${countsLine(model.extraCounts)}.`);
  console.log(model.complete ? `Report written to ${where}.` : `This run was incomplete, so the report went to ${where} and docs/ACCEPTANCE.md was left alone.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`e2e:report: ${error.message}`); process.exitCode = 1; }
}
