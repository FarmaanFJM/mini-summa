// Does the REAL Claude Code finish ordinary tasks with the report marker when nobody asks it to?
//
//   npm run verify:protocol                                  your `claude` and your normal login
//   npm run verify:protocol -- --claude-bin /path/to/claude  a specific executable (or a wrapper script)
//   npm run verify:protocol -- --runs 6 --keep
//
// Mini-Summa gives a managed Claude session the report protocol through its start hook (only in a folder that belongs to a
// registered project). The marker at the end of a final message is a DECLARATION by the model, so whether it appears is a
// property of the model and its version, not something Mini-Summa can guarantee. This script measures it: it starts a headless
// core on a temporary data directory, launches the real `claude` in a temporary git repository, gives it a few ordinary
// tasks in plain words (the prompts never mention the report or the marker), approves any permission dialogs through the
// core, and counts how many tasks ended in a captured report and how many in "another final message" (kept, never lost).
// It prints a result per task and sends nothing anywhere. It costs a few short model turns per task.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MiniSummaClient } from '@minisumma/shared';
import type { SessionKey, WebSocketCtor } from '@minisumma/shared';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const argv = process.argv.slice(2);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('usage: npm run verify:protocol -- [--claude-bin <path>] [--runs <1-6>] [--questions <0-2>] [--keep] [--task-timeout <seconds>]\n');
  process.exit(0);
}
const claudeBin = option('--claude-bin') ?? 'claude';
const keep = argv.includes('--keep');
const taskMs = (Number(option('--task-timeout')) || 150) * 1000;
const say = (line: string) => process.stdout.write(`${line}\n`);

// Plain requests of the kind a person makes. None mentions a report, a marker or Mini-Summa.
const TASKS = [
  'Create a file named notes.txt in this folder that contains the single word hello.',
  'Add a small function add(a, b) in a new file math.js and check that it works by running it with node.',
  'Change the first heading in README.md to "# Demo project" and tell me what you changed.',
  'Create a file named todo.md with three bullet points about things to test in this project.',
  'Rename the file notes.txt to hello.txt.',
  'Add a short "Usage" section to README.md that says to run node math.js.',
];
const runs = Math.max(1, Math.min(TASKS.length, Number(option('--runs')) || 3));
// Plain questions: nothing to do, so the protocol says NO marker. A report here would be a false alarm.
const QUESTIONS = [
  'What does the README in this folder say? Answer in one sentence.',
  'In JavaScript, what is the difference between let and const? Keep it to two sentences.',
];
const questions = Math.max(0, Math.min(QUESTIONS.length, option('--questions') === undefined ? 2 : Number(option('--questions'))));

interface CoreProcess { baseUrl: string; desktopToken: string; child: ChildProcess }

async function startCore(dataDir: string): Promise<CoreProcess> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TSX_TSCONFIG_PATH;
  const args = ['--import', 'tsx', 'packages/core/src/cli.ts', '--data-dir', dataDir, '--port', '0', '--print-connection'];
  if (option('--claude-bin')) args.push('--claude-bin', claudeBin);
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const first = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`the core did not print its address in time.\n${err}`)), 60_000);
    child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); const nl = out.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); res(out.slice(0, nl)); } });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`the core exited with ${code}.\n${err}`)); });
  });
  return { ...(JSON.parse(first) as { baseUrl: string; desktopToken: string }), child };
}

async function stopCore(core: CoreProcess): Promise<void> {
  if (core.child.exitCode !== null) return;
  const exited = new Promise<void>((r) => core.child.once('exit', () => r()));
  core.child.kill('SIGTERM');
  await Promise.race([exited, sleep(15_000)]);
  if (core.child.exitCode === null) core.child.kill('SIGKILL');
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;

/** Plays the person at the first-run dialogs only (theme, "press Enter", folder trust: Down, Enter = "Yes"). */
class FirstRunDriver {
  text = '';
  exited = false;
  loginRequired = false;
  private handle: ReturnType<MiniSummaClient['terminal']['attach']> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAction = 0;
  constructor(private readonly client: MiniSummaClient) {}
  attach(key: SessionKey): void {
    this.handle = this.client.terminal.attach(key, { cols: 120, rows: 40 }, {
      onAttached: (i) => { this.text = i.replay.replace(ANSI, '').slice(-20_000); },
      onData: (d) => { this.text = (this.text + d.replace(ANSI, '')).slice(-20_000); },
      onExit: () => { this.exited = true; },
      onError: () => { /* seen through the session state */ },
    });
    this.timer = setInterval(() => {
      const flat = this.text.replace(/\s+/g, '');
      if (/Selectloginmethod|Pastecodehere|Browserdidn'topen|Pleaserunclaudeandlogin|Invalidapikey/i.test(flat)) this.loginRequired = true;
      if (Date.now() - this.lastAction < 1500) return;
      const act = (keys: () => void, quiet = 0) => { keys(); this.lastAction = Date.now() + quiet; this.text = ''; };
      if (/trustthisfolder|Doyoutrust|Yes,Itrust/i.test(flat)) act(() => { setTimeout(() => this.input('\x1b[B'), 900); setTimeout(() => this.input('\r'), 1800); }, 3000);
      else if (/PressEntertocontinue|Entertoconfirm/i.test(flat)) act(() => this.input('\r'));
      else if (/Choosethetextstyle|Syntaxtheme/i.test(flat)) act(() => this.input('\r'));
    }, 400);
  }
  input(data: string): void { this.handle?.input(data); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.handle?.detach(); this.handle = null; }
}

async function main(): Promise<void> {
  const version = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32' });
  if (version.error || version.status !== 0) {
    say(`Claude Code was not found or did not start: ${claudeBin}\n${version.error?.message ?? version.stderr}`);
    process.exit(2);
  }
  say(`claude: ${version.stdout.trim()}   (${claudeBin})`);
  const workDir = mkdtempSync(join(tmpdir(), 'minisumma-protocol-'));
  const dataDir = join(workDir, 'data');
  const repoDir = realpathSync(mkdirSync(join(workDir, 'repo'), { recursive: true }) ?? join(workDir, 'repo'));
  writeFileSync(join(repoDir, 'README.md'), '# Verification repository\n\nA tiny folder used to try Mini-Summa.\n');
  spawnSync('git', ['init', '-q'], { cwd: repoDir });

  const core = await startCore(dataDir);
  const client = new MiniSummaClient({ baseUrl: core.baseUrl, token: core.desktopToken, clientName: 'verify-report-protocol', WebSocket: WebSocket as unknown as WebSocketCtor });
  client.events.connect();
  const driver = new FirstRunDriver(client);
  const results: { task: string; isQuestion: boolean; outcome: 'report' | 'other final message' | 'nothing captured'; last: string }[] = [];
  try {
    const project = await client.call('projects.create', { body: { name: 'Protocol check', roots: [{ path: repoDir }] } });
    await client.call('conversations.add', { params: { id: project.id }, body: { url: `https://chatgpt.com/c/${randomUUID()}`, makePreferred: true } });
    const started = await client.call('sessions.start', { params: { id: project.id }, body: { mode: 'new', name: 'Protocol check', cols: 120, rows: 40 } });
    const key = started.key;
    driver.attach(key);
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (driver.loginRequired) throw new Error('Claude asked to log in. Log in once with "claude" in the same configuration, then run this again.');
      if (driver.exited) throw new Error(`the terminal exited before Claude was ready:\n${driver.text.slice(-600)}`);
      if ((await client.call('sessions.get', { params: { key } })).state !== 'unknown') break;
      if (Date.now() > deadline) throw new Error('Claude did not start in time');
      await sleep(300);
    }

    const approveWaiting = async (): Promise<void> => {
      const pending = (await client.call('actions.list', { query: { status: 'pending' } })).filter((a) => a.kind === 'permission' && a.sessionKey === key);
      for (const a of pending) await client.call('actions.approve', { params: { id: a.id } }).catch(() => undefined);
    };
    const READY = new Set(['turn_ended', 'idle', 'report_ready', 'waiting_for_you']);

    const plan = [...TASKS.slice(0, runs).map((task) => ({ task, isQuestion: false })), ...QUESTIONS.slice(0, questions).map((task) => ({ task, isQuestion: true }))];
    for (const { task, isQuestion } of plan) {
      const before = {
        reports: (await client.call('reports.list', { query: { projectId: project.id } })).items.length,
        candidates: (await client.call('candidates.list', { query: { projectId: project.id } })).length,
      };
      driver.input(task);
      await sleep(600);
      driver.input('\r');
      let outcome: 'report' | 'other final message' | 'nothing captured' = 'nothing captured';
      let last = '';
      const end = Date.now() + taskMs;
      while (Date.now() < end) {
        await approveWaiting();
        const reports = (await client.call('reports.list', { query: { projectId: project.id } })).items;
        const candidates = await client.call('candidates.list', { query: { projectId: project.id } });
        if (reports.length > before.reports) {
          const full = await client.call('reports.get', { params: { id: reports[0].id } });
          outcome = 'report'; last = full.body.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
          break;
        }
        if (candidates.length > before.candidates) {
          const c = candidates.find((x) => !x.promoted) ?? candidates[0];
          outcome = 'other final message'; last = `${c.reason}: ${c.body.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''}`;
          break;
        }
        await sleep(1000);
      }
      results.push({ task, isQuestion, outcome, last: last.slice(0, 110) });
      const tag = isQuestion ? (outcome === 'report' ? 'FALSE ALARM' : 'no report (right)') : outcome === 'report' ? 'REPORT' : outcome === 'other final message' ? 'NO MARK' : 'NONE';
      say(`${tag.padEnd(16)} ${isQuestion ? '[question] ' : ''}${task}\n                 last line: ${last.slice(0, 110)}`);
      // Let the turn settle before the next task.
      const settle = Date.now() + 60_000;
      while (Date.now() < settle) {
        await approveWaiting();
        if (READY.has((await client.call('sessions.get', { params: { key } })).state)) break;
        await sleep(800);
      }
    }
  } finally {
    driver.stop();
    client.close();
    await stopCore(core);
    if (keep) say(`kept: ${workDir}`); else rmSync(workDir, { recursive: true, force: true });
  }
  const tasks = results.filter((r) => !r.isQuestion);
  const qs = results.filter((r) => r.isQuestion);
  say(`\n${tasks.filter((r) => r.outcome === 'report').length} of ${tasks.length} ordinary tasks ended with a captured report; ${tasks.filter((r) => r.outcome === 'other final message').length} ended with a final message without the marker (kept under "Other messages"); ${tasks.filter((r) => r.outcome === 'nothing captured').length} captured nothing.`);
  if (qs.length) say(`${qs.filter((r) => r.outcome === 'report').length} of ${qs.length} plain questions were wrongly turned into a report (false alarms).`);
  say('The marker is a declaration by the model, so this is a measurement of this Claude version and model, not a guarantee.');
}

main().catch((err) => { say(`verify-report-protocol: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); process.exit(1); });
