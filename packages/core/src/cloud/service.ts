// Cloud sessions through the person's own, unmodified Claude Code: `claude --cloud "<task>"`, run in a terminal Mini-Summa owns.
//
// What is verified on Claude Code 2.1.316 (details and dates in docs/CLOUD_SESSIONS.md) and shapes everything here:
//  * Creating a session needs a terminal. `--print` cannot be combined with `--cloud`; without a terminal the CLI refuses to start one.
//    So a dispatch is a short-lived PTY, never a pipe, and it may stop at questions (theme, folder trust, sign in) that only the
//    person can answer. Those show as "waiting for input" and the person answers them with a few keys.
//  * Nothing documented says the CLI exits, prints JSON, or reports completion. The only success Mini-Summa accepts is a validated
//    claude.ai/code session link in the CLI's output. A process that ends without one is "unknown", never "created".
//  * A follow-up to an existing session is non-interactive: `claude -p "<message>" --cloud <session id> --output-format json`.
//
// What it never does: read cookies or tokens, call an endpoint of claude.ai, type into the website, shorten a prompt, put a prompt in a
// URL, in the database or in a log, or say a cloud session is running, finished or waiting.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { claudeCodeUrl, MAX_PROMPT_CHARS, parseClaudeCodeUrl } from '@minisumma/shared';
import type {
  CloudDispatch, CloudDispatchInput, CloudFollowUpResult, CloudPhase, CloudPreflight, CloudSessionRecord, LocalRepoState,
  NativeBridge, Project, PromptDeliveryPlan,
} from '@minisumma/shared';
import type { CoreBase, EnvironmentsService } from '../contracts.ts';
import { CoreError, notFound, unprocessable } from '../errors.ts';
import { buildLaunchPlan, createNodePtySpawner } from '../claude/ptyHost.ts';
import type { ClaudeCommand, PtyProcess, PtySpawner } from '../claude/ptyHost.ts';
import { scrubEnvironment } from '../claude/managed.ts';
import type { CommandRunner } from '../claude/commandRunner.ts';
import type { GitFn } from '../git/git.ts';
import { inspectLocalRepo } from '../git/inspect.ts';
import type { WorkspacesService } from '../workspaces/service.ts';
import { probeCli } from './cliCapability.ts';
import { findBareSessionId, findFailure, findQuestion, findSessionLink, parseFollowUpOutput, stripAnsi, tailLines } from './output.ts';
import { planPromptDelivery } from './promptDelivery.ts';

/** The keys a person may send to a dispatch's terminal. A fixed set: a dispatch is not a general terminal. */
export const DISPATCH_KEYS = { enter: '\r', escape: '\x1b', up: '\x1b[A', down: '\x1b[B', y: 'y', n: 'n', '1': '1', '2': '2', '3': '3' } as const;
export type DispatchKey = keyof typeof DISPATCH_KEYS;

export interface CloudDeps {
  base: CoreBase;
  projects: { require(id: string): Project };
  environments: EnvironmentsService;
  workspaces: WorkspacesService;
  native: Pick<NativeBridge, 'clipboard' | 'openExternal' | 'capabilities'>;
  run: CommandRunner;
  git: GitFn;
  spawner?: PtySpawner;
  platform?: NodeJS.Platform;
  processEnv?: Record<string, string | undefined>;
  /** Without output for this long, a dispatch that has no link and no question is "unknown". */
  quietMs?: number;
  /** A dispatch that is still running after this long is stopped and reported as "unknown". */
  maxMs?: number;
}

export interface CloudService {
  init(): void;
  preflight(projectId: string, rootId?: string | null): Promise<CloudPreflight>;
  plan(prompt: string): Promise<PromptDeliveryPlan>;
  dispatch(input: CloudDispatchInput): Promise<CloudDispatch>;
  getDispatch(id: string): CloudDispatch | null;
  listDispatches(projectId: string): CloudDispatch[];
  sendKey(id: string, key: DispatchKey): CloudDispatch;
  cancel(id: string): CloudDispatch;
  sessions(projectId: string): CloudSessionRecord[];
  recordLink(projectId: string, url: string, title: string | null): CloudSessionRecord;
  followUp(recordId: string, message: string): Promise<CloudFollowUpResult>;
  forget(recordId: string): void;
  /** Names of running dispatches whose terminal works inside `dir` (a workspace must not be removed under them). */
  busyIn(dir: string): string[];
  shutdown(): void;
}

interface LiveDispatch {
  d: CloudDispatch;
  pty: PtyProcess | null;
  buffer: string;
  /** Characters received so far, and how many had arrived when the person last answered a question: only newer output can ask again. */
  total: number;
  answeredAt: number;
  prompt: string;
  title: string | null;
  repo: string | null;
  sourceRef: string | null;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  workspaceDir: string | null;
}

interface SessionRow {
  id: string; project_id: string; repo: string | null; source_ref: string | null; session_id: string; url: string; title: string | null;
  created_at: string; method: CloudSessionRecord['method']; last_at: string; last_outcome: CloudSessionRecord['lastResult']['outcome']; last_note: string | null;
}

const BUFFER_CAP = 200_000;
const KV_KEY = 'cloud.dispatches';
const FINAL: CloudPhase[] = ['created', 'failed', 'unknown'];

export function createCloudService(deps: CloudDeps): CloudService {
  const { base, environments, workspaces, native, run, git } = deps;
  const { db, log } = base;
  const platform = deps.platform ?? process.platform;
  const quietMs = deps.quietMs ?? 90_000;
  const maxMs = deps.maxMs ?? 15 * 60_000;
  const spawner = deps.spawner ?? createNodePtySpawner();
  const lives = new Map<string, LiveDispatch>();
  const now = (): string => base.clock.now().toISOString();

  const toRecord = (r: SessionRow): CloudSessionRecord => ({
    id: r.id, projectId: r.project_id, repo: r.repo, sourceRef: r.source_ref, sessionId: r.session_id, url: r.url, title: r.title, createdAt: r.created_at,
    method: r.method, lastResult: { at: r.last_at, outcome: r.last_outcome, note: r.last_note },
  });
  const rowOf = (id: string): SessionRow | null => db.get<SessionRow>('SELECT * FROM cloud_sessions WHERE id = ?', [id]) ?? null;

  // The journal holds no prompt and no output: ids, project, phase and times, so a restart can say what it does not know.
  function journal(): void {
    const items = [...lives.values()].map((l) => ({ id: l.d.id, projectId: l.d.projectId, phase: l.d.phase, startedAt: l.d.startedAt, updatedAt: l.d.updatedAt, detail: l.d.detail, method: l.d.method, sessionId: l.d.sessionId, sessionUrl: l.d.sessionUrl }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
    db.run('INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      [KV_KEY, JSON.stringify(items), now()]);
  }

  function setPhase(l: LiveDispatch, phase: CloudPhase, detail: string): void {
    l.d = { ...l.d, phase, detail, updatedAt: now(), running: l.pty !== null && l.d.running };
    journal();
  }

  async function command(): Promise<ClaudeCommand | null> { return environments.claudeCommand(environments.hostEnv()); }

  function cwdOf(project: Project, rootId: string | null | undefined): { path: string } | { error: string } {
    const hostEnv = environments.hostEnv();
    const pick = rootId ? project.roots.find((r) => r.id === rootId) : project.roots.find((r) => r.env === hostEnv);
    if (rootId && !pick) return { error: 'That folder does not belong to this project.' };
    if (!pick) return { error: 'none' };
    if (pick.env !== hostEnv) return { error: `That folder is in ${pick.env}. Cloud sessions are started from a folder on this computer's own system.` };
    return { path: pick.path };
  }

  async function preflight(projectId: string, rootId?: string | null): Promise<CloudPreflight> {
    const project = deps.projects.require(projectId);
    const cmd = await command();
    const probe = await probeCli(run, cmd);
    const out: CloudPreflight = {
      checkedAt: now(), cli: { found: probe.found, version: probe.version, cloudFlag: probe.cloudFlag, problem: probe.problem },
      auth: probe.auth, githubRepo: project.githubRepo, local: null, branches: [], warnings: [], blockers: [],
    };
    if (probe.problem) out.blockers.push(probe.problem);
    if (!project.githubRepo) out.blockers.push('This project has no GitHub repository. Cloud sessions run on a repository from GitHub. Add one in the project settings.');
    if (probe.found && probe.auth.state === 'logged_out') out.blockers.push('Claude Code is not signed in. Run claude in a terminal and use /login, then try again.');
    if (probe.auth.state === 'unknown' && probe.found) out.warnings.push('Mini-Summa could not tell whether Claude Code is signed in. The CLI will say if it is not.');
    if (probe.auth.note && probe.auth.state === 'logged_in') out.blockers.push(probe.auth.note);

    const where = cwdOf(project, rootId);
    if ('path' in where) {
      const local = await inspectLocalRepo(git, where.path, project.githubRepo);
      out.local = local;
      if (!local.isRepo) out.blockers.push(`${where.path} is not a Git repository.`);
      else if (!local.remoteRepo) out.blockers.push(`The folder ${where.path} has no GitHub remote named origin, so Mini-Summa cannot tell which repository the cloud session would use.`);
      else if (!local.remoteMatchesProject) out.blockers.push(`The folder's remote is ${local.remoteRepo}, but this project is linked to ${project.githubRepo ?? 'no repository'}. Mini-Summa will not start a cloud session against a different repository.`);
      if (local.isRepo) {
        if (local.detached) out.warnings.push('The folder is on a detached HEAD, not on a branch.');
        if (local.unpushed !== null && local.unpushed > 0) out.warnings.push(`${local.unpushed} local commit${local.unpushed === 1 ? ' is' : 's are'} not on GitHub. A cloud session works from GitHub and will not see ${local.unpushed === 1 ? 'it' : 'them'}. Push first, or the task will run without that work.`);
        if (local.upstream === null && local.branch) out.warnings.push(`The branch ${local.branch} has no upstream on GitHub, so it may not exist there yet.`);
        if (local.dirty || local.untracked > 0) out.warnings.push('The folder has uncommitted changes. They are not part of a cloud session either.');
        if (local.branch) out.branches = [local.branch];
      }
    } else if (where.error === 'none') {
      out.warnings.push('This project has no folder on this computer. Mini-Summa will prepare a small checkout of the repository so the CLI has a repository to run in.');
    } else {
      out.blockers.push(where.error);
    }
    out.warnings.push('Claude runs the task on Anthropic\'s servers from the repository on GitHub. It does not use your local working tree.');
    out.warnings.push('Claude Code can upload parts of a local repository when GitHub access is not set up. Mini-Summa cannot see whether it will, so the CLI runs only after you agree.');
    return out;
  }

  async function plan(prompt: string): Promise<PromptDeliveryPlan> {
    const cmd = await command();
    return planPromptDelivery(prompt, { platform, claudeFile: cmd?.file ?? 'claude', wsl: Boolean(cmd?.wslDistro) });
  }

  function save(l: LiveDispatch, sessionId: string, url: string, method: CloudSessionRecord['method']): CloudSessionRecord {
    const existing = db.get<SessionRow>('SELECT * FROM cloud_sessions WHERE project_id = ? AND session_id = ?', [l.d.projectId, sessionId]);
    const at = now();
    if (existing) {
      db.run('UPDATE cloud_sessions SET last_at = ?, last_outcome = ?, last_note = ? WHERE id = ?', [at, 'created', 'The CLI printed this session link again.', existing.id]);
      return toRecord(rowOf(existing.id)!);
    }
    const id = `cs_${randomBytes(8).toString('hex')}`;
    db.run(
      `INSERT INTO cloud_sessions (id, project_id, repo, source_ref, session_id, url, title, created_at, method, last_at, last_outcome, last_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
      [id, l.d.projectId, l.repo, l.sourceRef, sessionId, url, l.title, at, method, at, method === 'cli_cloud' ? 'The CLI printed this session link after the task was submitted.' : 'Recorded from a link you pasted.'],
    );
    return toRecord(rowOf(id)!);
  }

  function armQuiet(l: LiveDispatch): void {
    if (l.quietTimer) clearTimeout(l.quietTimer);
    l.quietTimer = setTimeout(() => {
      if (FINAL.includes(l.d.phase) || l.d.phase === 'waiting_for_input') return;
      setPhase(l, 'unknown', 'The CLI has been quiet and printed no session link. The session may or may not exist. Check claude.ai/code before sending the task again.');
    }, quietMs);
    l.quietTimer.unref?.();
  }

  function onData(l: LiveDispatch, data: string, final = false): void {
    l.buffer = (l.buffer + data).slice(-BUFFER_CAP);
    l.total += data.length;
    l.d = { ...l.d, tail: tailLines(l.buffer, l.prompt), updatedAt: now() };
    if (l.d.phase === 'created') return;
    const link = findSessionLink(l.buffer, { final });
    if (link) {
      const rec = save(l, link.sessionId, link.url, 'cli_cloud');
      l.d = { ...l.d, sessionId: rec.sessionId, sessionUrl: rec.url };
      if (l.quietTimer) clearTimeout(l.quietTimer);
      setPhase(l, 'created', 'The CLI printed a session link and Mini-Summa validated it. This shows the session exists, not that Claude has finished or is working.');
      return;
    }
    // Only the end of the output is read for questions: an old question that was answered must not hold the dispatch.
    const fresh = Math.min(1500, l.total - l.answeredAt);
    const question = fresh > 0 ? findQuestion(l.buffer.slice(-fresh)) : null;
    if (question) { if (l.quietTimer) clearTimeout(l.quietTimer); setPhase(l, 'waiting_for_input', `${question} Answer it below.`); return; }
    if (l.d.phase === 'waiting_for_input' || l.d.phase === 'preparing') setPhase(l, 'submitting', 'The task was handed to Claude Code. Waiting for it to print a session link.');
    armQuiet(l);
  }

  function onExit(l: LiveDispatch, code: number | null): void {
    if (l.quietTimer) clearTimeout(l.quietTimer);
    if (l.maxTimer) clearTimeout(l.maxTimer);
    l.pty = null;
    l.d = { ...l.d, running: false };
    if (l.d.phase === 'created') { journal(); return; }
    const link = findSessionLink(l.buffer, { final: true });
    if (link) { onData(l, '', true); return; }
    const failure = findFailure(l.buffer);
    if (failure) setPhase(l, 'failed', `Claude Code reported: ${failure.replace(l.prompt, '[prompt hidden]')}`);
    else if (l.d.phase === 'waiting_for_input') setPhase(l, 'failed', 'Claude Code stopped at a question and was closed before it was answered. Nothing was submitted.');
    else setPhase(l, 'unknown', `Claude Code ended${code === null ? '' : ` (exit code ${code})`} without printing a session link and without an error. The session may or may not exist. Check claude.ai/code before sending the task again.`);
    const bare = findBareSessionId(l.buffer);
    if (bare && l.d.phase === 'unknown') l.d = { ...l.d, detail: `${l.d.detail} The output mentioned ${bare}, but a bare id is not a verified link.` };
  }

  async function dispatch(input: CloudDispatchInput): Promise<CloudDispatch> {
    const project = deps.projects.require(input.projectId);
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') throw unprocessable('Write the task first.', 'prompt_empty');
    if (input.prompt.length > MAX_PROMPT_CHARS) throw unprocessable(`The prompt is longer than ${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters. Mini-Summa will not shorten it. Split it into two tasks.`, 'prompt_too_long');
    if (!project.githubRepo) throw unprocessable('This project has no GitHub repository.', 'no_repo');
    if (!input.acknowledgedLocalContent) throw unprocessable('Read and accept the note about local content before sending.', 'ack_required');

    const delivery = await plan(input.prompt);
    const id = `cd_${randomBytes(6).toString('hex')}`;
    const at = now();
    const dBase: CloudDispatch = { id, projectId: project.id, phase: 'preparing', startedAt: at, updatedAt: at, detail: 'Checking Claude Code and the repository.', method: delivery.method, tail: [], sessionId: null, sessionUrl: null, running: false };
    const l: LiveDispatch = { d: dBase, pty: null, buffer: '', total: 0, answeredAt: 0, prompt: input.prompt, title: input.title?.trim() || null, repo: project.githubRepo, sourceRef: null, quietTimer: null, maxTimer: null, workspaceDir: null };

    // The browser route: the text on the clipboard, the page opened with the repository chosen. The text is not put in the address.
    if (delivery.method === 'clipboard_browser') {
      if (!input.useBrowserFallback) throw unprocessable(`${delivery.reason ?? 'This prompt cannot be passed to the CLI.'} Use the browser route, or shorten the prompt yourself.`, 'prompt_needs_browser', { plan: delivery });
      try { await native.clipboard.writeText(input.prompt); } catch (e) { throw unprocessable(`The prompt could not be copied: ${e instanceof Error ? e.message : String(e)}`, 'clipboard_failed'); }
      await native.openExternal(claudeCodeUrl({ repo: project.githubRepo }));
      l.d = { ...dBase, phase: 'unknown', method: 'clipboard_browser', detail: 'The full prompt is on your clipboard and claude.ai/code is open with the repository chosen. Paste it there and submit. Mini-Summa cannot see whether you did. Paste the session link here afterwards to keep it with this project.' };
      lives.set(id, l);
      journal();
      return l.d;
    }

    const pre = await preflight(project.id, input.rootId);
    if (pre.blockers.length > 0) throw unprocessable(pre.blockers[0], 'cloud_blocked', { blockers: pre.blockers });
    const cmd = await command();
    if (!cmd) throw unprocessable('Claude Code was not found.', 'claude_missing');

    let cwd: string;
    const where = cwdOf(project, input.rootId);
    if ('path' in where) {
      cwd = where.path;
      l.sourceRef = pre.local?.branch ?? null;
    } else {
      // No folder of the project: a shallow checkout Mini-Summa makes only so the CLI has a repository to run in.
      const existing = workspaces.list(project.id).find((w) => w.purpose === 'dispatch' && w.status === 'ready');
      let wsId = existing?.id;
      if (!wsId) {
        const made = await workspaces.create({ projectId: project.id, confirmed: true, shallow: true, purpose: 'dispatch' });
        wsId = made.id;
        for (let i = 0; i < 600; i++) {
          const w = workspaces.require(wsId);
          if (w.status === 'ready') break;
          if (w.status !== 'cloning') throw unprocessable(w.error ?? 'The repository could not be prepared.', 'dispatch_checkout_failed');
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      cwd = await workspaces.resolveForSession(wsId, project.id);
      l.workspaceDir = cwd;
      l.sourceRef = workspaces.require(wsId).branch;
    }

    lives.set(id, l);
    setPhase(l, 'submitting', 'The task was handed to Claude Code. Waiting for it to print a session link.');
    const launch = buildLaunchPlan({ claude: cmd, claudeArgs: ['--cloud', input.prompt], cwd, hostCwd: base.dataDir, platform });
    try {
      const pty = spawner.spawn({ file: launch.file, args: launch.args, cwd: launch.cwd, env: scrubEnvironment(deps.processEnv ?? process.env), cols: 110, rows: 30 });
      l.pty = pty;
      l.d = { ...l.d, running: true };
      pty.onData((data) => onData(l, data));
      pty.onExit((info) => onExit(l, info.exitCode));
      l.maxTimer = setTimeout(() => {
        if (l.pty && !FINAL.includes(l.d.phase) && l.d.phase !== 'waiting_for_input') { try { l.pty.kill(); } catch { /* gone */ } }
      }, maxMs);
      l.maxTimer.unref?.();
      armQuiet(l);
    } catch (e) {
      setPhase(l, 'failed', `Claude Code could not be started: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Never the prompt: only that a dispatch started, for which project, and how the text travels.
    log.info('cloud dispatch started', { id, project: project.id, method: delivery.method, chars: delivery.chars });
    return l.d;
  }

  return {
    init() {
      const row = db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', [KV_KEY]);
      if (!row) return;
      try {
        for (const item of JSON.parse(row.value_json) as CloudDispatch[]) {
          const wasOpen = !FINAL.includes(item.phase) && item.method === 'argv';
          const d: CloudDispatch = {
            ...item, tail: [], running: false,
            phase: wasOpen ? 'unknown' : item.phase,
            detail: wasOpen ? 'Mini-Summa closed before the CLI reported a result. The session may or may not exist. Check claude.ai/code before sending the task again.' : item.detail,
          };
          lives.set(d.id, { d, pty: null, buffer: '', total: 0, answeredAt: 0, prompt: '', title: null, repo: null, sourceRef: null, quietTimer: null, maxTimer: null, workspaceDir: null });
        }
      } catch { /* an unreadable journal is dropped */ }
    },

    preflight,
    plan,
    dispatch,
    getDispatch: (id) => lives.get(id)?.d ?? null,
    listDispatches: (projectId) => [...lives.values()].map((l) => l.d).filter((d) => d.projectId === projectId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),

    sendKey(id, key) {
      const l = lives.get(id);
      if (!l) throw notFound('Dispatch');
      if (!l.pty) throw unprocessable('The Claude Code terminal of this dispatch has ended.', 'dispatch_ended');
      if (!(key in DISPATCH_KEYS)) throw unprocessable('That key is not allowed here.', 'bad_key');
      l.pty.write(DISPATCH_KEYS[key]);
      l.answeredAt = l.total;
      return l.d;
    },

    cancel(id) {
      const l = lives.get(id);
      if (!l) throw notFound('Dispatch');
      if (l.pty) { try { l.pty.kill(); } catch { /* gone */ } }
      return l.d;
    },

    sessions: (projectId) => db.all<SessionRow>('SELECT * FROM cloud_sessions WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(toRecord),

    recordLink(projectId, url, title) {
      const project = deps.projects.require(projectId);
      const read = parseClaudeCodeUrl(url);
      if (!read.ok) throw unprocessable(read.message, 'bad_link');
      if (read.info.kind !== 'session' || !read.info.sessionId) throw unprocessable('That is a page of Claude Code on the web, but not a session. Open the session and copy its address.', 'not_a_session');
      const l: LiveDispatch = { d: { id: 'manual', projectId, phase: 'created', startedAt: now(), updatedAt: now(), detail: '', method: 'clipboard_browser', tail: [], sessionId: null, sessionUrl: null, running: false },
        pty: null, buffer: '', total: 0, answeredAt: 0, prompt: '', title: title?.trim() || null, repo: project.githubRepo, sourceRef: null, quietTimer: null, maxTimer: null, workspaceDir: null };
      return save(l, read.info.sessionId, read.info.url, 'recorded_link');
    },

    async followUp(recordId, message) {
      const r = rowOf(recordId);
      if (!r) throw notFound('Cloud session');
      if (message.trim() === '') throw unprocessable('Write the message first.', 'message_empty');
      if (message.length > MAX_PROMPT_CHARS) throw unprocessable('The message is too long. Mini-Summa will not shorten it.', 'message_too_long');
      const cmd = await command();
      if (!cmd) throw unprocessable('Claude Code was not found.', 'claude_missing');
      const delivery = planPromptDelivery(message, { platform, claudeFile: cmd.file, wsl: Boolean(cmd.wslDistro) });
      if (delivery.method !== 'argv') {
        throw unprocessable(`${delivery.reason ?? 'This message cannot be passed to the CLI.'} Send it on claude.ai/code instead; Mini-Summa will not shorten it.`, 'message_needs_browser', { plan: delivery });
      }
      const res = await run(cmd.file, [...cmd.prefixArgs, '-p', message, '--cloud', r.session_id, '--output-format', 'json'], { timeoutMs: 90_000, env: scrubEnvironment(deps.processEnv ?? process.env) });
      let result: CloudFollowUpResult;
      if (res.code === null) result = { outcome: 'unknown', note: 'The CLI did not finish in time. The message may or may not have been sent.' };
      else {
        const parsed = parseFollowUpOutput(res.stdout);
        result = parsed.outcome === 'unknown' && res.code !== 0 ? { outcome: 'rejected', note: stripAnsi(res.stderr).trim().split('\n')[0]?.replace(message, '[message hidden]').slice(0, 300) || parsed.note } : parsed;
      }
      db.run('UPDATE cloud_sessions SET last_at = ?, last_outcome = ?, last_note = ? WHERE id = ?', [now(), result.outcome, result.note, recordId]);
      log.info('cloud follow-up', { record: recordId, outcome: result.outcome, chars: message.length });
      return result;
    },

    forget(recordId) {
      if (!rowOf(recordId)) throw notFound('Cloud session');
      db.run('DELETE FROM cloud_sessions WHERE id = ?', [recordId]);
    },

    busyIn(dir) {
      const inside = (p: string): boolean => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
      return [...lives.values()].filter((l) => l.pty !== null && l.workspaceDir !== null && inside(l.workspaceDir)).map(() => 'a cloud dispatch');
    },

    shutdown() {
      for (const l of lives.values()) {
        if (l.quietTimer) clearTimeout(l.quietTimer);
        if (l.maxTimer) clearTimeout(l.maxTimer);
        if (l.pty) { try { l.pty.kill(); } catch { /* gone */ } }
      }
    },
  };
}

export type { LocalRepoState };
export { CoreError };
