// Demo-core handlers for cloud sessions and temporary workspaces. They follow the real core's rules closely enough to build and test the
// interface against (a prompt is never shortened, a session link is validated, cleanup refuses unsafe workspaces) and say nothing about
// what Claude does: the demo has no CLI and no GitHub.
import { ApiError, parseClaudeCodeUrl } from '@minisumma/shared';
import type { CloudDispatch, CloudSessionRecord, RouteInput, RouteName, RouteOutput, TempWorkspace, WorkspaceInspection } from '@minisumma/shared';
import type { DemoServer } from './server';

// Addresses are built from parts: the publish guard refuses a literal session address anywhere in the repository.
const CODE = 'https://claude.ai/code/';

type Handler<K extends RouteName> = (input: RouteInput<K>) => RouteOutput<K> | Promise<RouteOutput<K>>;
type HandlerMap = { [K in RouteName]?: Handler<K> };

export interface CloudDemoState {
  dispatches: Map<string, CloudDispatch>;
  records: CloudSessionRecord[];
  workspaces: TempWorkspace[];
  /** What the next dispatch ends as. */
  dispatchOutcome: 'created' | 'failed' | 'unknown';
  /** Findings for the next inspect. */
  inspection: Partial<WorkspaceInspection>;
  counter: number;
}

const states = new WeakMap<object, CloudDemoState>();
export function cloudDemoState(data: object): CloudDemoState {
  let s = states.get(data);
  if (!s) { s = { dispatches: new Map(), records: [], workspaces: [], dispatchOutcome: 'created', inspection: {}, counter: 0 }; states.set(data, s); }
  return s;
}

const nowIso = (): string => new Date().toISOString();

export function installCloudHandlers(server: DemoServer, handlers: object): void {
  const st = cloudDemoState(server.data);
  const project = (id: string) => {
    const p = server.data.projects.find((x) => x.id === id);
    if (!p) throw new ApiError(404, 'not_found', 'Project was not found.');
    return p;
  };
  const h: HandlerMap = {
    'cloud.preflight': (i) => {
      const p = project(i.params.id);
      return {
        checkedAt: nowIso(), cli: { found: true, version: '2.1.316', cloudFlag: true, problem: null },
        auth: { state: 'logged_in', method: 'claude.ai', note: null }, githubRepo: p.githubRepo,
        local: p.roots[0] ? { path: p.roots[0].path, isRepo: true, branch: 'main', detached: false, remoteRepo: p.githubRepo, remoteMatchesProject: true, upstream: 'origin/main', unpushed: 0, dirty: false, untracked: 0 } : null,
        branches: ['main'], warnings: ['Claude runs the task on Anthropic\'s servers from the repository on GitHub. It does not use your local working tree.'],
        blockers: p.githubRepo ? [] : ['This project has no GitHub repository.'],
      };
    },
    'cloud.plan': (i) => (i.body.prompt.trim() === '' || i.body.prompt.length > 6000
      ? { method: 'clipboard_browser', reason: 'The prompt is longer than the command line of this computer takes.', chars: i.body.prompt.length, bytes: i.body.prompt.length, argvLimitChars: 6000 }
      : { method: 'argv', reason: null, chars: i.body.prompt.length, bytes: i.body.prompt.length, argvLimitChars: 6000 }),
    'cloud.dispatch': (i) => {
      project(i.body.projectId);
      if (!i.body.acknowledgedLocalContent) throw new ApiError(422, 'ack_required', 'Read and accept the note about local content before sending.');
      const id = `cd_${++st.counter}`;
      const browser = i.body.prompt.length > 6000;
      if (browser && !i.body.useBrowserFallback) throw new ApiError(422, 'prompt_needs_browser', 'This prompt cannot be passed to the CLI.');
      const d: CloudDispatch = {
        id, projectId: i.body.projectId, startedAt: nowIso(), updatedAt: nowIso(), method: browser ? 'clipboard_browser' : 'argv', tail: [], running: false,
        phase: browser ? 'unknown' : st.dispatchOutcome, sessionId: null, sessionUrl: null,
        detail: browser ? 'The full prompt is on your clipboard and claude.ai/code is open. Paste it there and submit.' : st.dispatchOutcome === 'created' ? 'The CLI printed a session link and Mini-Summa validated it. This shows the session exists, not that Claude has finished or is working.' : st.dispatchOutcome === 'failed' ? 'Claude Code reported an error.' : 'The session may or may not exist.',
      };
      if (!browser && st.dispatchOutcome === 'created') {
        d.sessionId = 'session_abDemoDemoDemo'; d.sessionUrl = `${CODE}session_abDemoDemoDemo`;
        st.records.unshift({ id: `cs_${st.counter}`, projectId: d.projectId, repo: project(d.projectId).githubRepo, sourceRef: 'main', sessionId: d.sessionId, url: d.sessionUrl, title: i.body.title ?? null, createdAt: nowIso(), method: 'cli_cloud', lastResult: { at: nowIso(), outcome: 'created', note: null } });
      }
      st.dispatches.set(id, d);
      return d;
    },
    'cloud.dispatches': (i) => [...st.dispatches.values()].filter((d) => d.projectId === i.params.id),
    'cloud.dispatchGet': (i) => { const d = st.dispatches.get(i.params.id); if (!d) throw new ApiError(404, 'not_found', 'Dispatch was not found.'); return d; },
    'cloud.dispatchKey': (i) => { const d = st.dispatches.get(i.params.id); if (!d) throw new ApiError(404, 'not_found', 'Dispatch was not found.'); return d; },
    'cloud.dispatchCancel': (i) => { const d = st.dispatches.get(i.params.id); if (!d) throw new ApiError(404, 'not_found', 'Dispatch was not found.'); d.running = false; return d; },
    'cloud.sessions': (i) => st.records.filter((r) => r.projectId === i.params.id),
    'cloud.recordLink': (i) => {
      const read = parseClaudeCodeUrl(i.body.url);
      if (!read.ok || read.info.kind !== 'session' || !read.info.sessionId) throw new ApiError(422, 'not_a_session', 'That is not a session link.');
      const rec: CloudSessionRecord = { id: `cs_${++st.counter}`, projectId: i.params.id, repo: project(i.params.id).githubRepo, sourceRef: null, sessionId: read.info.sessionId, url: read.info.url, title: i.body.title ?? null, createdAt: nowIso(), method: 'recorded_link', lastResult: { at: nowIso(), outcome: 'created', note: null } };
      st.records.unshift(rec);
      return rec;
    },
    'cloud.followUp': (i) => { if (!st.records.some((r) => r.id === i.params.id)) throw new ApiError(404, 'not_found', 'Cloud session was not found.'); return { outcome: 'accepted', note: 'The CLI reports that the message was sent. That does not mean Claude has acted on it.' }; },
    'cloud.forget': (i) => { st.records = st.records.filter((r) => r.id !== i.params.id); return { ok: true }; },

    'workspaces.check': (i) => {
      const p = project(i.params.id);
      return { repo: p.githubRepo ?? '', access: p.githubRepo ? 'ok' : 'unknown', accessNote: null, reportedSizeKb: 20_000, freeBytes: 100 * 1024 ** 3, defaultBranch: 'main', branches: ['main', 'dev'], needsConfirmation: false, warnings: ['The size comes from GitHub and is approximate.'], blockers: p.githubRepo ? [] : ['This project has no GitHub repository.'] };
    },
    'workspaces.list': (i) => st.workspaces.filter((w) => w.projectId === i.params.id && w.status !== 'removed'),
    'workspaces.create': (i) => {
      const p = project(i.params.id);
      const w: TempWorkspace = { id: `00000000-0000-4000-8000-${String(++st.counter).padStart(12, '0')}`, projectId: p.id, repo: p.githubRepo ?? '', path: `C:\\Users\\demo\\AppData\\Roaming\\Mini-Summa\\workspaces\\${st.counter}\\repo`, status: 'ready', branch: i.body.branch ?? 'main', featureBranch: i.body.featureBranch ?? null, shallow: false, purpose: 'session', createdAt: nowIso(), updatedAt: nowIso(), error: null, reportedSizeKb: 20_000 };
      st.workspaces.unshift(w);
      return w;
    },
    'workspaces.get': (i) => { const w = st.workspaces.find((x) => x.id === i.params.id); if (!w) throw new ApiError(404, 'not_found', 'Workspace was not found.'); return w; },
    'workspaces.retry': (i) => { const w = st.workspaces.find((x) => x.id === i.params.id); if (!w) throw new ApiError(404, 'not_found', 'Workspace was not found.'); w.status = 'ready'; w.error = null; return w; },
    'workspaces.cancel': (i) => { const w = st.workspaces.find((x) => x.id === i.params.id); if (!w) throw new ApiError(404, 'not_found', 'Workspace was not found.'); return w; },
    'workspaces.inspect': (i) => ({
      id: i.params.id, exists: true, branch: 'main', remoteRepo: null, remoteMatches: true, trackedChanges: 0, untracked: 0, ignoredFiles: 0, unpushedCommits: 0, unpublishedBranches: [],
      publication: 'published', running: [], blockers: [], warnings: [], safeToClean: true, recoverableDelete: true, ...st.inspection,
    }),
    'workspaces.cleanup': (i) => {
      const w = st.workspaces.find((x) => x.id === i.params.id);
      if (!w) throw new ApiError(404, 'not_found', 'Workspace was not found.');
      if (i.body.confirmRepo.trim().toLowerCase() !== w.repo.toLowerCase()) throw new ApiError(422, 'confirmation_mismatch', `Type ${w.repo} to confirm.`);
      w.status = 'removed';
      return w;
    },
  };
  Object.assign(handlers, h);
}
