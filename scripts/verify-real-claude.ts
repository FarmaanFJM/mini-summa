// Real Claude Code confirmation: the Mini-Summa core launches the REAL `claude` CLI as a managed session and the
// whole chain is checked end to end: PTY launch in the project directory, per-session hook file, state from real hooks,
// report capture from a real final message, frozen ChatGPT destination, permission approval keystrokes, /clear inside the
// terminal (the terminal must stay the managed terminal under the new session id), resume, restart.
//
//   npm run verify:claude                                   uses `claude` from PATH and your normal Claude login
//   npm run verify:claude -- --claude-bin /path/to/claude   a specific executable (or a wrapper script)
//   npm run verify:claude -- --keep                          keep the temporary data directory and repository
//
// It talks to a headless core on a temporary data directory and a temporary git repository. It never opens ChatGPT and
// never touches your Mini-Summa data. It costs two short model replies. Claude must already be logged in; a fresh
// CLAUDE_CONFIG_DIR starts logged out and the run stops with a clear message instead of guessing.
//
// Results are reported per check as PASS / FAIL / NOT TESTED. A check that was not executed is never shown as PASS.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MiniSummaClient } from '@minisumma/shared';
import type { Project, SessionKey, SessionView, WebSocketCtor } from '@minisumma/shared';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  process.stdout.write('usage: npm run verify:claude -- [--claude-bin <path>] [--keep] [--step-timeout <seconds>] [--skip-permission]\n');
  process.exit(0);
}
const claudeBin = option('--claude-bin') ?? 'claude';
const keep = flag('--keep');
const stepMs = (Number(option('--step-timeout')) || 120) * 1000;
const skipPermission = flag('--skip-permission');

type Outcome = { name: string; result: 'PASS' | 'FAIL' | 'NOT TESTED'; detail?: string };
const outcomes: Outcome[] = [];
const say = (line: string) => process.stdout.write(`${line}\n`);

/** Thrown by a check that could not be exercised in this session; reported as NOT TESTED, never as PASS or FAIL. */
class NotExercised extends Error {}

async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn();
    outcomes.push({ name, result: 'PASS', detail: detail || undefined });
    say(`PASS        ${name}${detail ? `  (${detail})` : ''}`);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof NotExercised) {
      outcomes.push({ name, result: 'NOT TESTED', detail });
      say(`NOT TESTED  ${name}\n            ${detail}`);
      return false;
    }
    outcomes.push({ name, result: 'FAIL', detail });
    say(`FAIL        ${name}\n            ${detail.split('\n').join('\n            ')}`);
    return false;
  }
}
function notTested(name: string, why: string): void {
  outcomes.push({ name, result: 'NOT TESTED', detail: why });
  say(`NOT TESTED  ${name}\n            ${why}`);
}
function expect(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = stepMs): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Core process

interface CoreProcess { baseUrl: string; desktopToken: string; child: ChildProcess; log: () => string }

async function startCore(dataDir: string): Promise<CoreProcess> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TSX_TSCONFIG_PATH;
  const args = ['--import', 'tsx', 'packages/core/src/cli.ts', '--data-dir', dataDir, '--port', '0', '--print-connection'];
  if (option('--claude-bin')) args.push('--claude-bin', claudeBin);
  // One node process, no wrapper: signalling it stops the core, on every platform.
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const first = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`the core did not print its address in time.\n${err}`)), 60_000);
    child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); const nl = out.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); res(out.slice(0, nl)); } });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`the core exited with ${code}.\n${err}`)); });
  });
  const conn = JSON.parse(first) as { baseUrl: string; desktopToken: string };
  return { ...conn, child, log: () => err };
}

async function stopCore(core: CoreProcess): Promise<void> {
  if (core.child.exitCode !== null) return;
  const exited = new Promise<void>((r) => core.child.once('exit', () => r()));
  core.child.kill('SIGTERM');
  await Promise.race([exited, sleep(15_000)]);
  if (core.child.exitCode === null) core.child.kill('SIGKILL');
}

// ---------------------------------------------------------------------------------------------------------------
// Terminal driver: answers the first-run dialogs the way a person would, and nothing else.

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;
const stripAnsi = (s: string) => s.replace(ANSI, '');

class TerminalWatcher {
  text = '';
  /** Characters received since attach (the text above is trimmed; this only grows). */
  received = 0;
  exited: { code: number | null; reason: string } | null = null;
  loginRequired = false;
  answered: string[] = [];
  private handle: ReturnType<MiniSummaClient['terminal']['attach']> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAction = 0;
  constructor(private readonly client: MiniSummaClient) {}

  attach(key: SessionKey): void {
    this.handle = this.client.terminal.attach(key, { cols: 120, rows: 40 }, {
      onAttached: (i) => { this.text = stripAnsi(i.replay).slice(-20_000); this.received += i.replay.length; },
      onData: (d) => { this.text = (this.text + stripAnsi(d)).slice(-20_000); this.received += d.length; },
      onExit: (i) => { this.exited = { code: i.code, reason: i.reason }; },
      onError: () => { /* surfaced through the state checks */ },
    });
  }
  input(data: string): void { this.handle?.input(data); }
  /** Starts answering first-run dialogs: theme, "press Enter", and the folder trust question (Down, Enter = "Yes"). */
  startAnswering(): void {
    this.timer = setInterval(() => {
      const flat = this.text.replace(/\s+/g, '');
      if (/Selectloginmethod|Pastecodehere|Browserdidn'topen|Pleaserunclaudeandlogin|Invalidapikey/i.test(flat)) this.loginRequired = true;
      if (Date.now() - this.lastAction < 1500) return;
      const act = (what: string, keys: () => void, keepText = false) => { if (this.answered[this.answered.length - 1] !== what) this.answered.push(what); keys(); this.lastAction = Date.now(); if (!keepText) this.text = ''; };
      // The trust question starts on "No, exit" and an Enter that arrives too early is ignored, so the keys are decided from what
      // the screen shows NOW: Enter only while "Yes, I trust this folder" is the highlighted option, one Down while "No, exit" is.
      // The screen text is kept, so a key that was swallowed is simply sent again 1.5 s later; it is never sent blind.
      const tail = flat.slice(-700);
      if (/trustthisfolder|Doyoutrust|Yes,Itrust/i.test(tail)) {
        const choice = [...tail.matchAll(/❯(No,exit|Yes,Itrust)/g)].at(-1)?.[1];
        if (choice === 'Yes,Itrust') act('trust', () => this.input('\r'), true);
        else if (choice === 'No,exit') act('select-yes', () => this.input('\x1b[B'), true);
      }
      else if (/PressEntertocontinue|Entertoconfirm/i.test(flat)) act('enter', () => this.input('\r'));
      else if (/Choosethetextstyle|Syntaxtheme/i.test(flat)) act('theme', () => this.input('\r'));
    }, 400);
  }
  stopAnswering(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  detach(): void { this.stopAnswering(); this.handle?.detach(); this.handle = null; }
}

// ---------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const version = spawnSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (version.error || version.status !== 0) {
    say(`Claude Code was not found or did not start: ${claudeBin}\n${version.error?.message ?? version.stderr}`);
    say('Install Claude Code and log in once with "claude", or pass --claude-bin <path>.');
    process.exit(2);
  }
  say(`claude: ${version.stdout.trim()}   (${claudeBin})`);

  const workDir = mkdtempSync(join(tmpdir(), 'minisumma-realclaude-'));
  const dataDir = join(workDir, 'data');
  const repoDir = realpathSync(mkdirSync(join(workDir, 'repo'), { recursive: true }) ?? join(workDir, 'repo'));
  writeFileSync(join(repoDir, 'README.md'), '# Verification repository\n');
  spawnSync('git', ['init', '-q'], { cwd: repoDir });
  const filesBefore = readdirSync(repoDir).sort();
  say(`work dir: ${workDir}`);

  let core = await startCore(dataDir);
  let client = new MiniSummaClient({ baseUrl: core.baseUrl, token: core.desktopToken, clientName: 'verify-real-claude', WebSocket: WebSocket as unknown as WebSocketCtor });
  client.events.connect();
  const watcher = new TerminalWatcher(client);
  let project!: Project;
  let conversationId = '';
  let conversationUrl = '';
  let key!: SessionKey;
  let view!: SessionView;
  let pid: number | null = null;

  try {
    await check('core: starts headless and answers /health', async () => {
      const h = await client.call('system.health');
      expect(h.ok && h.name === 'mini-summa-core', 'unexpected health answer');
      return `api v${h.apiVersion}`;
    });

    await check('project: registered with the repository directory and one mapped ChatGPT conversation', async () => {
      project = await client.call('projects.create', { body: { name: 'Real Claude check', roots: [{ path: repoDir }] } });
      conversationUrl = `https://chatgpt.com/c/${randomUUID()}`;
      const conv = await client.call('conversations.add', { params: { id: project.id }, body: { url: conversationUrl, title: 'Verification conversation', makePreferred: true } });
      conversationId = conv.id;
      project = await client.call('projects.get', { params: { id: project.id } });
      expect(project.roots.length === 1, 'the project has no root');
      expect(project.preferredConversationId === conversationId, 'the conversation is not the preferred one');
    });

    const started = await check('session: the real Claude CLI starts as a managed session in the project directory', async () => {
      view = await client.call('sessions.start', { params: { id: project.id }, body: { mode: 'new', name: 'Real Claude check', cols: 120, rows: 40 } });
      key = view.key;
      expect(view.origin === 'managed', `origin is ${view.origin}`);
      expect(view.projectId === project.id, 'the session is not attributed to the project');
      expect(view.state === 'unknown', `expected "Starting" (no hook yet), got ${view.state}`);
      watcher.attach(key);
      watcher.startAnswering();
      return key;
    });

    const live = started && await check('hooks: the first real hook arrives and the session leaves "Starting" with its evidence', async () => {
      const v = await until('the first hook from the real CLI', async () => {
        if (watcher.loginRequired) throw new Error('Claude asked to log in. Log in once with "claude" using the same CLAUDE_CONFIG_DIR, then run this again.');
        if (watcher.exited) throw new Error(`the terminal exited (${watcher.exited.reason}) before any hook arrived. Screen:\n${watcher.text.slice(-800)}`);
        const s = await client.call('sessions.get', { params: { key } });
        return s.state !== 'unknown' ? s : null;
      });
      watcher.stopAnswering();
      view = v;
      pid = v.pid;
      expect(v.stateEvidence.startsWith('hook:'), `state evidence is "${v.stateEvidence}", not a hook`);
      expect(v.cwd !== null && realpathSync(v.cwd) === repoDir, `cwd is ${v.cwd}`);
      return `state ${v.state}, evidence ${v.stateEvidence}, answered: ${watcher.answered.join(',') || 'nothing needed'}`;
    });

    const sendLine = async (text: string) => { watcher.input(text); await sleep(600); watcher.input('\r'); };
    const MARKER = '<!-- mini-summa:report status=complete task="Real Claude verification" -->';

    let reportId = '';
    if (live) {
      await sendLine(`Do not use any tools. Reply with a short "## Implementation Report" section saying that nothing was changed, and make the very last line of your reply exactly: ${MARKER}`);

      await check('report: the real final message is captured, attributed to the project and session, and is only a declaration', async () => {
        const r = await until('a captured report', async () => (await client.call('reports.list', { query: { projectId: project.id } })).items[0]);
        const full = await client.call('reports.get', { params: { id: r.id } });
        reportId = full.id;
        expect(full.projectId === project.id, `report project is ${full.projectId}`);
        expect(full.sessionKey === key, `report session is ${full.sessionKey}`);
        expect(full.declaredStatus === 'complete', `declared status is ${full.declaredStatus}`);
        expect(full.verified === false, 'a report must never claim to be verified');
        expect(full.body.includes('Implementation Report'), 'the stored body is not the model\'s message');
        return `${full.chars} chars, "${full.taskTitle}"`;
      });

      await check('delivery: the destination is the mapped conversation, frozen at capture, and nothing was sent anywhere', async () => {
        const d = await until('a delivery for the report', async () => (await client.call('deliveries.list', { query: { reportId } }))[0]);
        expect(d.destination !== null, `delivery state is ${d.state}`);
        expect(d.destination.conversationId === conversationId, 'the destination is not the mapped conversation');
        expect(d.destination.url === conversationUrl, `destination url is ${d.destination.url}`);
        expect(['ready_for_handoff', 'destination_unverified'].includes(d.state), `unexpected delivery state ${d.state}`);
        return `${d.state}, resolved from ${d.destination.resolvedFrom}`;
      });

      await check('feed and notifications: the real events reached the activity feed and a notification record exists', async () => {
        const page = await client.call('activity.list', { query: { projectId: project.id, limit: 50 } });
        const types = new Set(page.items.map((e) => e.type));
        expect(types.has('report_ready'), `feed has ${[...types].join(', ')}`);
        const notes = await client.call('notifications.list', { query: { limit: 20 } });
        expect(notes.some((n) => n.projectId === project.id), 'no notification record for the project');
        return [...types].join(', ');
      });
    } else {
      notTested('report, delivery, feed', 'the session never produced a hook, so no prompt was sent');
    }

    if (live && !skipPermission) {
      await until('the session to be ready for the next prompt', async () => {
        const s = await client.call('sessions.get', { params: { key } });
        return ['turn_ended', 'idle', 'report_ready', 'waiting_for_you'].includes(s.state) ? s : null;
      });
      await sendLine(`Create a file named hello.txt in the current directory containing the single word hi. Then make the very last line of your reply exactly: ${MARKER}`);

      // Claude may be in a permission mode that never asks (auto, acceptEdits, bypass). That is a property of the session,
      // not a defect: the dialog and the approve keystroke are then NOT TESTED rather than failed.
      let actionId = '';
      let sawDialog = false;
      await check('permission: the real permission dialog is detected and a pending action describes it', async () => {
        const found = await until('a permission dialog or the created file', async () => {
          const a = (await client.call('actions.list', { query: { status: 'pending' } })).find((x) => x.kind === 'permission' && x.sessionKey === key);
          if (a) return { action: a } as const;
          return existsSync(join(repoDir, 'hello.txt')) ? { created: true } as const : null;
        });
        if ('created' in found) throw new NotExercised('Claude created the file without asking (its permission mode does not prompt for edits here). Run in default permission mode to exercise this.');
        actionId = found.action.id;
        sawDialog = true;
        const s = await client.call('sessions.get', { params: { key } });
        expect(s.state === 'needs_permission', `session state is ${s.state}`);
        return found.action.summary;
      });
      if (sawDialog) {
        await check('permission: approving from the core sends the approve keystroke and Claude carries on (file is created)', async () => {
          await client.call('actions.approve', { params: { id: actionId } });
          await until('hello.txt', () => existsSync(join(repoDir, 'hello.txt')));
        });
      }
      await check('report: the second real final message is captured under the same project and session', async () => {
        const done = await until('a second report', async () => {
          const items = (await client.call('reports.list', { query: { projectId: project.id } })).items;
          return items.length >= 2 ? items : null;
        });
        expect(done.every((r) => r.projectId === project.id && r.sessionKey === key), 'a report was attributed to the wrong place');
        return `${done.length} reports under the project`;
      });

      if (sawDialog) {
        // Reject path: Escape closes the dialog and Claude fires no hook for it, so the file must not appear and the
        // session must still take the next prompt.
        await until('the session to be ready for the next prompt', async () => {
          const s = await client.call('sessions.get', { params: { key } });
          return ['turn_ended', 'idle', 'report_ready', 'waiting_for_you'].includes(s.state) ? s : null;
        });
        const known = new Set((await client.call('actions.list', { query: { status: 'all' } })).map((a) => a.id));
        await sendLine('Create a file named nope.txt in the current directory containing the word no.');
        await check('permission: rejecting from the core sends the reject keystroke, nothing is created, and the item is closed', async () => {
          const a = await until('a new pending permission action', async () => (await client.call('actions.list', { query: { status: 'pending' } })).find((x) => x.kind === 'permission' && x.sessionKey === key && !known.has(x.id)));
          await client.call('actions.reject', { params: { id: a.id }, body: {} });
          await sleep(5000);
          expect(!existsSync(join(repoDir, 'nope.txt')), 'the file was created although the request was rejected');
          const closed = (await client.call('actions.list', { query: { status: 'all' } })).find((x) => x.id === a.id);
          expect(closed && closed.status !== 'pending', `the item is still ${closed?.status}`);
          const s = await client.call('sessions.get', { params: { key } });
          return `item ${closed!.status}; session state afterwards: ${s.state} (${s.stateEvidence})`;
        });
        await check('permission: after a reject the session still takes the next prompt and answers it', async () => {
          const before = (await client.call('candidates.list', { query: { projectId: project.id } })).length;
          await sendLine('Reply with the single word ok.');
          // The answer proves the prompt was submitted and processed; a state label alone could be stale.
          const answer = await until('Claude\'s answer after the rejected dialog', async () => {
            const all = await client.call('candidates.list', { query: { projectId: project.id } });
            return all.length > before ? all.find((c) => /\bok\b/i.test(c.body) && c.sessionKey === key) : null;
          });
          const s = await client.call('sessions.get', { params: { key } });
          expect(s.state !== 'needs_permission', `the session still shows ${s.state}`);
          return `answer "${answer.body.trim().slice(0, 20)}", state ${s.state} (${s.stateEvidence})`;
        });
      }
    } else if (live) {
      notTested('permission dialog and approval keystroke', 'skipped with --skip-permission');
    }

    if (live) {
      // A phone's prompt: queued by a paired device, typed only after the desktop approves exactly that text.
      await check('phone prompt: a paired phone queues text, the desktop approves it, and the real Claude answers that text', async () => {
        await until('the session to be ready for a prompt', async () => {
          const s = await client.call('sessions.get', { params: { key } });
          return ['turn_ended', 'idle', 'report_ready', 'waiting_for_you'].includes(s.state) ? s : null;
        });
        const offer = await client.call('pairing.createOffer', { body: { scopes: ['read', 'prompt'], kind: 'phone' } });
        const paired = await client.call('pairing.redeem', { body: { offerId: offer.id, code: offer.code, deviceName: 'Verification phone', platform: 'android' } });
        const phone = new MiniSummaClient({ baseUrl: core.baseUrl, token: paired.token, clientName: 'verify-phone' });
        const queued = await phone.call('actions.create', { body: { sessionKey: key, text: 'Reply with exactly this one word and nothing else: PHONEOK' } });
        expect(queued.status === 'pending', `the prompt is ${queued.status} before anyone approved it`);
        await sleep(3000);
        const still = await client.call('candidates.list', { query: { projectId: project.id } });
        expect(!still.some((c) => c.body.includes('PHONEOK')), 'Claude answered before the desktop approved');
        await client.call('actions.approve', { params: { id: queued.id } });
        const answer = await until('Claude\'s answer to the phone prompt', async () => (await client.call('candidates.list', { query: { projectId: project.id } })).find((c) => c.body.includes('PHONEOK')));
        expect(answer.sessionKey === key, 'the answer belongs to another session');
        return `answer "${answer.body.trim().slice(0, 40)}"`;
      });
    }

    // /clear inside the managed terminal. Claude Code keeps running in the SAME process under a NEW session id; the terminal must
    // stay the managed terminal, now bound to the new id (it used to "end" while an observed stranger appeared next to it).
    if (live) {
      const originalKey = key;
      const cleared = await check('clear: /clear in the real terminal keeps it managed and live under the NEW session id; the old id becomes history; no phantom session', async () => {
        const ids = (v: SessionView) => v.sessionId.slice(0, 8);
        const ready = ['turn_ended', 'idle', 'report_ready', 'waiting_for_you'];
        const before = await until('the session to be ready for /clear', async () => {
          const s = await client.call('sessions.get', { params: { key } });
          return ready.includes(s.state) ? s : null;
        });
        const receivedBefore = watcher.received;
        const sentAt = Date.now();
        await sendLine('/clear');
        // The new id must become the managed, live session of the project (limit 60 s).
        let found: SessionView | null = null;
        try {
          found = await until('the NEW session id to be managed and live', async () => {
            const all = await client.call('sessions.list', { query: { projectId: project.id, includeEnded: true } });
            return all.find((x) => x.origin === 'managed' && x.availability === 'live' && x.key !== key) ?? null;
          }, 60_000);
        } catch (err) {
          // Honest: a Claude Code that has no /clear answers with an error line and nothing else happens. That is NOT TESTED, not PASS.
          const old = await client.call('sessions.get', { params: { key } });
          if (old.availability === 'live' && old.state !== 'ended' && /unknown (slash )?command|not a (valid |recognized )?command|isn'?t a command|command not found/i.test(watcher.text.slice(-3000))) {
            throw new NotExercised('this Claude Code does not know /clear (it answered with an unknown-command message), so the behaviour could not be exercised');
          }
          throw new Error(`${err instanceof Error ? err.message : String(err)}. The old session ${ids(before)} is ${old.availability}/${old.state} (${old.stateLabel}). Terminal tail:\n${watcher.text.slice(-600)}`);
        }
        const adoptedMs = Date.now() - sentAt;
        expect(found.sessionId !== before.sessionId, 'the new key has the old session id');
        expect(found.pid === before.pid, `the new session runs in process ${found.pid}, the old one in ${before.pid}: that is not the same terminal`);
        expect(found.projectId === project.id && found.projectResolution === 'managed', `the new session is attributed to ${found.projectId} (${found.projectResolution})`);
        expect(found.name === before.name, `the name changed from "${before.name}" to "${found.name}"`);
        expect(found.terminal !== null && !found.terminal.exited, 'the new session has no live terminal');
        const old = await client.call('sessions.get', { params: { key } });
        expect(old.origin === 'managed' && old.availability !== 'live', `the old session is ${old.origin}/${old.availability}`);
        expect(old.termination !== null && /\/clear/.test(old.termination.reason), `the old session does not say what happened: ${JSON.stringify(old.termination)}`);
        expect(old.attention === null, `the old session raised ${old.attention?.kind}: a /clear is not an alarm`);
        // the terminal that was attached to the old key keeps receiving what the same process prints
        await until('output from the same terminal after /clear', () => watcher.received > receivedBefore);

        // A plain task in the new session: its report is captured under the NEW managed key.
        const next = new TerminalWatcher(client);
        next.attach(found.key);
        await sleep(800);
        const reportsBefore = (await client.call('reports.list', { query: { projectId: project.id } })).items.length;
        const task = 'Real Claude after clear';
        const marker = `<!-- mini-summa:report status=complete task="${task}" -->`;
        next.input(`Do not use any tools. Reply with a short "## Implementation Report" section saying that nothing was changed, and make the very last line of your reply exactly: ${marker}`);
        await sleep(600);
        next.input('\r');
        const report = await until('a report captured under the new managed key', async () =>
          (await client.call('reports.list', { query: { projectId: project.id } })).items.find((r) => r.sessionKey === found!.key) ?? null);
        expect(report.projectId === project.id, `the report is attributed to ${report.projectId}`);
        expect((await client.call('reports.list', { query: { projectId: project.id } })).items.length > reportsBefore, 'no new report');
        next.detach();

        // Nothing is left behind: the project has the old (history) and the new (live) session of this terminal and nothing else.
        const all = await client.call('sessions.list', { query: { projectId: project.id, includeEnded: true } });
        const strangers = all.filter((x) => x.origin !== 'managed');
        expect(strangers.length === 0, `observed sessions appeared next to the managed ones: ${strangers.map((x) => `${ids(x)} ${x.origin}/${x.availability}`).join(', ')}`);
        const liveNow = all.filter((x) => x.availability === 'live');
        expect(liveNow.length === 1 && liveNow[0].key === found!.key, `live sessions: ${liveNow.map((x) => ids(x)).join(', ')}`);
        const everything = await client.call('sessions.list', { query: { includeEnded: true } });
        expect(everything.every((x) => x.origin === 'managed'), 'a session outside the project is observed');
        // The rest of the run (stop, restart, resume) follows the terminal, which is now the new session.
        key = found.key;
        view = found;
        pid = found.pid;
        return `${ids(before)} -> ${ids(found)} in ${(adoptedMs / 1000).toFixed(1)} s, same process ${found.pid}; report "${report.taskTitle}" under the new key`;
      });
      if (!cleared) say('            (the steps that follow keep using the original session)');

      // And back: /resume of the older id inside the same terminal. The terminal follows again (a record exists for that id already).
      if (cleared) {
        await check('resume in the terminal: /resume <older id> makes the older session the managed, live one again; the cleared one becomes history', async () => {
          const ids = (v: SessionView) => v.sessionId.slice(0, 8);
          const ready = ['turn_ended', 'idle', 'report_ready', 'waiting_for_you'];
          const current = await until('the cleared session to be ready for /resume', async () => {
            const x = await client.call('sessions.get', { params: { key } });
            return ready.includes(x.state) ? x : null;
          });
          const olderId = originalKey.slice(originalKey.indexOf('|') + 1);
          const sentAt = Date.now();
          await sendLine(`/resume ${olderId}`);
          let back: SessionView;
          try {
            back = await until('the older session to be managed and live again', async () => {
              const x = await client.call('sessions.get', { params: { key: originalKey } });
              return x.origin === 'managed' && x.availability === 'live' ? x : null;
            }, 60_000);
          } catch (err) {
            const now = await client.call('sessions.get', { params: { key } });
            if (now.availability === 'live' && /unknown (slash )?command|not a (valid |recognized )?command|isn'?t a command|command not found/i.test(watcher.text.slice(-3000))) {
              throw new NotExercised('this Claude Code does not know /resume <id> (unknown-command message), so the behaviour could not be exercised');
            }
            throw new Error(`${err instanceof Error ? err.message : String(err)}. The cleared session ${ids(current)} is ${now.availability}/${now.state} (${now.stateLabel}). Terminal tail:\n${watcher.text.slice(-600)}`);
          }
          expect(back.pid === current.pid, `the older session runs in process ${back.pid}, the cleared one in ${current.pid}`);
          const left = await client.call('sessions.get', { params: { key } });
          expect(left.origin === 'managed' && left.availability !== 'live', `the cleared session is ${left.origin}/${left.availability}`);
          expect(left.termination !== null && /\/resume/.test(left.termination.reason), `the cleared session does not say what happened: ${JSON.stringify(left.termination)}`);
          const all = await client.call('sessions.list', { query: { includeEnded: true } });
          const liveNow = all.filter((x) => x.availability === 'live');
          expect(liveNow.length === 1 && liveNow[0].key === originalKey, `live sessions: ${liveNow.map((x) => ids(x)).join(', ')}`);
          expect(all.every((x) => x.origin === 'managed'), `an observed session appeared: ${all.filter((x) => x.origin !== 'managed').map((x) => `${ids(x)} ${x.origin}`).join(', ')}`);
          key = originalKey;
          view = back;
          pid = back.pid;
          return `${ids(current)} -> ${ids(back)} in ${((Date.now() - sentAt) / 1000).toFixed(1)} s, same process ${back.pid}`;
        });
      }
    }

    // Resume: the same session id comes back as a managed session in a new generation.
    if (live) {
      await check('stop: the managed session ends and the Claude process is gone', async () => {
        await client.call('sessions.stop', { params: { key }, body: {} });
        await until('the terminal to exit', () => watcher.exited);
        if (pid) await until('the process to disappear', () => { try { process.kill(pid!, 0); return false; } catch { return true; } }, 15_000);
        const s = await client.call('sessions.get', { params: { key } });
        expect(s.availability !== 'live', `availability is still ${s.availability}`);
        return `availability ${s.availability}, resumable ${s.resumable}`;
      });
      watcher.detach();

      await check('restart: reports, deliveries and activity survive a core restart without re-notifying', async () => {
        const beforeReports = (await client.call('reports.list', { query: { projectId: project.id } })).items.map((r) => r.id).sort();
        const beforeNotes = (await client.call('notifications.list', { query: { limit: 200 } })).length;
        const beforeActivity = (await client.call('activity.list', { query: { projectId: project.id, limit: 200 } })).items.length;
        client.close();
        await stopCore(core);
        core = await startCore(dataDir);
        client = new MiniSummaClient({ baseUrl: core.baseUrl, token: core.desktopToken, clientName: 'verify-real-claude', WebSocket: WebSocket as unknown as WebSocketCtor });
        const afterReports = (await client.call('reports.list', { query: { projectId: project.id } })).items.map((r) => r.id).sort();
        expect(JSON.stringify(afterReports) === JSON.stringify(beforeReports), 'the reports changed across the restart');
        const d = (await client.call('deliveries.list', { query: { projectId: project.id } }))[0];
        expect(d?.destination?.conversationId === conversationId, 'the delivery lost its frozen destination');
        await sleep(2000);
        const afterNotes = (await client.call('notifications.list', { query: { limit: 200 } })).length;
        const afterActivity = (await client.call('activity.list', { query: { projectId: project.id, limit: 200 } })).items.length;
        expect(afterNotes === beforeNotes, `notifications went from ${beforeNotes} to ${afterNotes}`);
        expect(afterActivity >= beforeActivity, 'activity shrank');
        const s = await client.call('sessions.get', { params: { key } });
        expect(s.availability !== 'live', `the old session shows as ${s.availability} after a restart`);
        return `${afterReports.length} reports, ${afterNotes} notifications, session ${s.availability}`;
      });

      client.events.connect();
      const resumeWatcher = new TerminalWatcher(client);
      await check('resume: `claude --resume` brings the same session back as managed, in a new generation', async () => {
        const before = await client.call('sessions.get', { params: { key } });
        const r = await client.call('sessions.start', { params: { id: project.id }, body: { mode: 'resume', resumeKey: key, cols: 120, rows: 40 } });
        expect(r.key === key, `resume produced ${r.key}`);
        resumeWatcher.attach(key);
        resumeWatcher.startAnswering();
        const s = await until('the resumed session to report a hook', async () => {
          if (resumeWatcher.exited) throw new Error(`the resumed terminal exited (${resumeWatcher.exited.reason}). Screen:\n${resumeWatcher.text.slice(-800)}`);
          const x = await client.call('sessions.get', { params: { key } });
          return x.origin === 'managed' && x.availability === 'live' && x.state !== 'unknown' && x.generation > before.generation ? x : null;
        });
        resumeWatcher.stopAnswering();
        return `generation ${before.generation} -> ${s.generation}, state ${s.state}`;
      });
      await client.call('sessions.stop', { params: { key }, body: {} }).catch(() => undefined);
      await sleep(1500);
      resumeWatcher.detach();
    }

    await check('repository: Mini-Summa wrote nothing into the project directory', async () => {
      const after = readdirSync(repoDir).sort().filter((f) => f !== 'hello.txt');
      expect(JSON.stringify(after) === JSON.stringify(filesBefore), `before: ${filesBefore.join(', ')}  after: ${after.join(', ')}`);
    });
  } finally {
    watcher.detach();
    client.close();
    await stopCore(core);
    if (keep) say(`kept: ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }

  const count = (r: Outcome['result']) => outcomes.filter((o) => o.result === r).length;
  say(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('NOT TESTED')} not tested`);
  if (count('FAIL') > 0) process.exitCode = 1;
}

main().catch((err) => { say(`verify-real-claude: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); process.exit(1); });
