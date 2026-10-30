// The OTHER way Mini-Summa sees Claude: a session you start yourself in an ordinary terminal, reported through hooks you
// installed with Settings, Claude hooks. This drives the REAL `claude` that way and checks what Mini-Summa shows and refuses.
//
//   npm run verify:claude-external -- --config-dir /path/to/a/claude/config   a configuration directory used only for this test
//   npm run verify:claude-external -- --claude-bin /path/to/claude --claude-args "--model haiku"
//
// What it does: starts a headless core on a temporary data directory with CLAUDE_CONFIG_DIR pointing at a configuration
// directory it owns (a temporary one by default; it holds a settings.json with a hook and a permission of the "user", which must
// survive), registers a temporary git repository as a project, installs the hooks through the core exactly as the window does
// (plan, exact diff, consent by plan hash, apply), starts the real Claude in its own pseudo-terminal OUTSIDE Mini-Summa, plays the
// person in that terminal (first-run dialogs, the permission answer), and checks: the session appears as observed and attributed
// to the project, Mini-Summa refuses to type into it, the permission request is announced but not offered for approval, the
// final message becomes a report under the project, the end is observed, and removing the hooks gives the user's file back.
//
// Your own ~/.claude is never touched unless you point --config-dir at it. A temporary configuration directory starts logged
// out on a normal machine; log in once with `CLAUDE_CONFIG_DIR=<dir> claude`, or pass the directory you logged in with.
// Results are PASS / FAIL / NOT TESTED per check; nothing unexecuted is shown as PASS.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MiniSummaClient } from '@minisumma/shared';
import type { HookPlan, WebSocketCtor } from '@minisumma/shared';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const argv = process.argv.slice(2);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('usage: npm run verify:claude-external -- [--claude-bin <path>] [--claude-args "<args>"] [--config-dir <dir>] [--keep] [--step-timeout <seconds>]\n');
  process.exit(0);
}
const claudeBin = option('--claude-bin') ?? 'claude';
const claudeArgs = (option('--claude-args') ?? '').split(/\s+/).filter(Boolean);
const stepMs = (Number(option('--step-timeout')) || 120) * 1000;
const keep = argv.includes('--keep');
const say = (line: string) => process.stdout.write(`${line}\n`);

type Outcome = { name: string; result: 'PASS' | 'FAIL' | 'NOT TESTED'; detail?: string };
const outcomes: Outcome[] = [];
class NotExercised extends Error {}
async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn();
    outcomes.push({ name, result: 'PASS', detail: detail || undefined });
    say(`PASS        ${name}${detail ? `  (${detail})` : ''}`);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const nt = err instanceof NotExercised;
    outcomes.push({ name, result: nt ? 'NOT TESTED' : 'FAIL', detail });
    say(`${nt ? 'NOT TESTED ' : 'FAIL       '} ${name}\n            ${detail.split('\n').join('\n            ')}`);
    return false;
  }
}
function expect(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
async function until<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = stepMs): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await sleep(400);
  }
}

// ---- the core -----------------------------------------------------------------------------------------------------------
interface CoreProcess { baseUrl: string; desktopToken: string; child: ChildProcess }
async function startCore(dataDir: string, configDir: string): Promise<CoreProcess> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
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

// ---- the person's own terminal: a pseudo-terminal that Mini-Summa does not own ---------------------------------------------
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;
const HARNESS_VARS = /^(CLAUDECODE|CLAUDE_PID|SESSION_INGRESS_URL|CLAUDE_CODE_.*|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_ADDITIONAL_DIRECTORIES|CLAUDE_AUTO.*|CLAUDE_EFFORT|CLAUDE_ENABLE_STREAM_WATCHDOG)$/;
type NodePty = typeof import('@lydell/node-pty');

class OwnTerminal {
  text = '';
  exited = false;
  loginRequired = false;
  private pty: ReturnType<NodePty['spawn']> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAction = 0;
  start(cwd: string, configDir: string): void {
    const nodePty = createRequire(import.meta.url)('@lydell/node-pty') as NodePty;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HARNESS_VARS.test(k)) env[k] = v;
    env.CLAUDE_CONFIG_DIR = configDir;
    this.pty = nodePty.spawn(claudeBin, claudeArgs, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env });
    this.pty.onData((d) => { this.text = (this.text + d.replace(ANSI, '')).slice(-20_000); });
    this.pty.onExit(() => { this.exited = true; });
    this.timer = setInterval(() => {
      const flat = this.text.replace(/\s+/g, '');
      if (/Selectloginmethod|Pastecodehere|Browserdidn'topen|Pleaserunclaudeandlogin|Invalidapikey/i.test(flat)) this.loginRequired = true;
      if (Date.now() - this.lastAction < 1500) return;
      const act = (keys: () => void) => { keys(); this.lastAction = Date.now(); this.text = ''; };
      if (/trustthisfolder|Doyoutrust|Yes,Itrust/i.test(flat)) act(() => { this.write('\x1b[B'); setTimeout(() => this.write('\r'), 500); });
      else if (/PressEntertocontinue|Entertoconfirm/i.test(flat)) act(() => this.write('\r'));
      else if (/Choosethetextstyle|Syntaxtheme/i.test(flat)) act(() => this.write('\r'));
    }, 400);
  }
  write(data: string): void { try { this.pty?.write(data); } catch { /* gone */ } }
  async type(line: string): Promise<void> { this.write(line); await sleep(600); this.write('\r'); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; try { this.pty?.kill(); } catch { /* gone */ } this.pty = null; }
}

const normalized = (text: string): unknown => JSON.parse(text);

async function main(): Promise<void> {
  const version = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (version.error || version.status !== 0) {
    say(`Claude Code was not found or did not start: ${claudeBin}\n${version.error?.message ?? version.stderr}`);
    process.exit(2);
  }
  say(`claude: ${version.stdout.trim()}   (${claudeBin} ${claudeArgs.join(' ')})`);

  const workDir = mkdtempSync(join(tmpdir(), 'minisumma-external-'));
  const dataDir = join(workDir, 'data');
  const configDir = resolve(option('--config-dir') ?? join(workDir, 'claude-config'));
  mkdirSync(configDir, { recursive: true });
  const repoDir = realpathSync(mkdirSync(join(workDir, 'repo'), { recursive: true }) ?? join(workDir, 'repo'));
  writeFileSync(join(repoDir, 'README.md'), '# Verification repository\n');
  spawnSync('git', ['init', '-q'], { cwd: repoDir });
  const settingsPath = join(configDir, 'settings.json');
  // Something of the "user's" that the install must keep and the removal must give back.
  const userSettings = { permissions: { allow: ['Bash(git status)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop-hook' }] }] } };
  const hadSettings = existsSync(settingsPath);
  const original = hadSettings ? readFileSync(settingsPath, 'utf8') : `${JSON.stringify(userSettings, null, 2)}\n`;
  if (!hadSettings) writeFileSync(settingsPath, original);
  say(`work dir: ${workDir}\nconfig dir: ${configDir}${hadSettings ? ' (existing settings.json kept as the user\'s file)' : ''}`);

  const core = await startCore(dataDir, configDir);
  const client = new MiniSummaClient({ baseUrl: core.baseUrl, token: core.desktopToken, clientName: 'verify-external', WebSocket: WebSocket as unknown as WebSocketCtor });
  const own = new OwnTerminal();
  const filesBefore = readdirSync(repoDir).sort();
  try {
    const project = await client.call('projects.create', { body: { name: 'External check', roots: [{ path: repoDir }] } });
    const conv = await client.call('conversations.add', { params: { id: project.id }, body: { url: `https://chatgpt.com/c/${randomUUID()}`, makePreferred: true } });

    let plan!: HookPlan;
    const planned = await check('hooks: the plan shows the exact change and writes nothing; the user\'s own settings are kept in it', async () => {
      const status = (await client.call('hooks.list')).find((h) => h.env === 'posix' || h.env === 'win');
      expect(status, 'the core reports no hook status for this environment');
      plan = await client.call('hooks.plan', { body: { env: status.env, action: 'install' } });
      expect(plan.action === 'install', `plan action is ${plan.action}`);
      expect(readFileSync(settingsPath, 'utf8') === original, 'planning changed the settings file');
      const after = normalized(plan.after) as typeof userSettings & { hooks: Record<string, unknown[]> };
      expect(JSON.stringify(after.permissions) === JSON.stringify(userSettings.permissions), 'the user\'s permissions are not in the plan unchanged');
      expect(JSON.stringify(after.hooks.Stop).includes('user-stop-hook'), 'the user\'s own Stop hook is missing from the plan');
      expect(Object.keys(after.hooks).length >= 5, `only ${Object.keys(after.hooks).length} hook events planned`);
      return `settings ${plan.settingsPath}, ${Object.keys(after.hooks).length} events`;
    });

    const applied = planned && await check('hooks: a wrong plan hash is refused, the right one installs, a backup exists, nothing of the user\'s is lost', async () => {
      let refused = false;
      try { await client.call('hooks.apply', { body: { env: plan.env, action: 'install', planHash: 'f'.repeat(32) } }); } catch { refused = true; }
      expect(refused, 'a wrong plan hash was accepted');
      expect(readFileSync(settingsPath, 'utf8') === original, 'a refused apply changed the file');
      const status = await client.call('hooks.apply', { body: { env: plan.env, action: 'install', planHash: plan.planHash } });
      expect(status.installed, `not installed: ${status.issues.join('; ')}`);
      const now = normalized(readFileSync(settingsPath, 'utf8')) as typeof userSettings & { hooks: Record<string, unknown[]> };
      expect(JSON.stringify(now.hooks.Stop).includes('user-stop-hook'), 'the user\'s Stop hook was lost');
      expect(JSON.stringify(now.permissions) === JSON.stringify(userSettings.permissions), 'the user\'s permissions changed');
      const backups = existsSync(join(dataDir, 'backups')) ? readdirSync(join(dataDir, 'backups')) : [];
      expect(backups.length >= 1, 'no backup of the settings file was kept');
      return `${status.events.length} events, ${backups.length} backup`;
    });

    let key = '';
    const seen = applied && await check('external session: Claude started in an ordinary terminal appears as observed and is attributed to the project', async () => {
      own.start(repoDir, configDir);
      const v = await until('the session to appear', async () => {
        if (own.loginRequired) throw new NotExercised('Claude asked to log in with this configuration directory. Log in once with `CLAUDE_CONFIG_DIR=<dir> claude`, then run this again.');
        if (own.exited) throw new Error(`Claude exited before any hook arrived:\n${own.text.slice(-600)}`);
        const list = await client.call('sessions.list', { query: { projectId: project.id } });
        return list.find((s) => s.origin === 'external' && s.state !== 'unknown') ?? null;
      });
      key = v.key;
      expect(v.projectId === project.id, `attributed to ${v.projectName ?? 'no project'}`);
      expect(v.availability === 'live', `availability ${v.availability}`);
      return `${v.origin}, state ${v.state}, evidence ${v.stateEvidence}`;
    });

    if (seen) {
      await check('external session: Mini-Summa refuses to type into it and says why', async () => {
        let message = '';
        try { await client.call('actions.create', { body: { sessionKey: key as never, text: 'hello' } }); } catch (err) { message = String((err as Error).message); }
        expect(message !== '', 'a prompt for an observed session was accepted');
        expect(/observ/i.test(message), `the refusal does not say the session is only observed: ${message}`);
        return message.slice(0, 90);
      });

      await own.type('Create a file named external.txt in this folder containing the single word external.');
      await check('external session: the permission request is announced in the feed and a notification, and is NOT offered for approval from Mini-Summa', async () => {
        const v = await until('the permission state', async () => {
          const s = await client.call('sessions.get', { params: { key: key as never } });
          return s.state === 'needs_permission' ? s : null;
        });
        expect(v.attention?.kind === 'permission', `attention is ${v.attention?.kind}`);
        const feed = await client.call('activity.list', { query: { projectId: project.id, limit: 50 } });
        expect(feed.items.some((e) => e.type === 'needs_permission'), 'no "needs permission" entry in the feed');
        const notes = await client.call('notifications.list', { query: { limit: 20 } });
        expect(notes.some((n) => n.projectId === project.id), 'no notification record for the project');
        const pending = (await client.call('actions.list', { query: { status: 'pending' } })).filter((a) => a.sessionKey === key);
        expect(pending.length === 0, `${pending.length} approval item(s) were offered for a session Mini-Summa does not own`);
        return 'announced, not actionable';
      });
      own.write('\r'); // the person answers in their own terminal

      await check('external session: the final message becomes a report under the project, with the destination frozen', async () => {
        const r = await until('a report', async () => (await client.call('reports.list', { query: { projectId: project.id } })).items[0]).catch(async (err: Error) => {
          const cands = await client.call('candidates.list', { query: { projectId: project.id } });
          const s = await client.call('sessions.get', { params: { key: key as never } });
          throw new Error(`${err.message}\nsession state ${s.state} (${s.stateEvidence}); other final messages: ${cands.length}${cands[0] ? `, last: ${cands[0].reason}: ${cands[0].body.trim().slice(-120)}` : ''}\nterminal tail: ${own.text.slice(-300).replace(/\s+/g, ' ')}`);
        });
        const full = await client.call('reports.get', { params: { id: r.id } });
        expect(full.sessionKey === key, `report belongs to ${full.sessionKey}`);
        expect(full.projectId === project.id, 'report is under another project');
        expect(full.verified === false, 'a report claims to be verified');
        const d = await until('a delivery', async () => (await client.call('deliveries.list', { query: { reportId: full.id } }))[0]);
        expect(d.destination?.conversationId === conv.id, 'the destination is not the mapped conversation');
        return `"${full.taskTitle}", ${d.state}`;
      });

      await check('external session: leaving Claude is observed as an end, not guessed', async () => {
        await own.type('/exit');
        const v = await until('the end', async () => {
          const s = await client.call('sessions.get', { params: { key: key as never } });
          return s.state === 'ended' || s.availability !== 'live' ? s : null;
        }, 60_000);
        expect(v.termination === null || v.termination.kind === 'observed', `termination is ${v.termination?.kind}`);
        return `${v.state}, ${v.termination?.kind ?? 'no termination record'}`;
      });
    } else if (applied) {
      outcomes.push({ name: 'external session checks', result: 'NOT TESTED', detail: 'the session never appeared' });
    }

    if (planned && applied) {
      await check('hooks: removal gives the user\'s settings back and keeps their own hooks', async () => {
        const un = await client.call('hooks.plan', { body: { env: plan.env, action: 'uninstall' } });
        expect(un.action === 'uninstall', `plan action ${un.action}`);
        await client.call('hooks.apply', { body: { env: plan.env, action: 'uninstall', planHash: un.planHash } });
        const back = readFileSync(settingsPath, 'utf8');
        const now = normalized(back) as { permissions: unknown; hooks?: Record<string, unknown[]> };
        const wasObj = normalized(original) as { permissions: unknown; hooks?: Record<string, unknown[]> };
        const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));
        // Claude Code writes to this file too (for example the theme it asks about on first run), so what must hold is that
        // everything that was the user's is back exactly, and that nothing Claude added in the meantime was dropped.
        const wasRecord = wasObj as Record<string, unknown>;
        const nowRecord = now as Record<string, unknown>;
        for (const k of Object.keys(wasRecord)) expect(canon(nowRecord[k]) === canon(wasRecord[k]), `"${k}" is not as the user had it.\nbefore: ${canon(wasRecord[k])}\nafter:  ${canon(nowRecord[k])}`);
        expect(!/ms-user|capture\.mjs/.test(back), 'a Mini-Summa hook entry is still in the file');
        const added = Object.keys(nowRecord).filter((k) => !(k in wasRecord));
        return `the user's keys are exactly as before${added.length ? `; kept what Claude added meanwhile: ${added.join(', ')}` : ''}`;
      });
    }

    await check('repository: Mini-Summa wrote nothing into the project directory', async () => {
      const after = readdirSync(repoDir).sort().filter((f) => f !== 'external.txt');
      expect(JSON.stringify(after) === JSON.stringify(filesBefore), `before: ${filesBefore.join(', ')}  after: ${after.join(', ')}`);
    });
  } finally {
    own.stop();
    client.close();
    await stopCore(core);
    if (keep) say(`kept: ${workDir}`); else rmSync(workDir, { recursive: true, force: true });
  }
  const count = (r: Outcome['result']) => outcomes.filter((o) => o.result === r).length;
  say(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('NOT TESTED')} not tested`);
  if (count('FAIL') > 0) process.exitCode = 1;
}

main().catch((err) => { say(`verify-real-claude-external: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); process.exit(1); });
