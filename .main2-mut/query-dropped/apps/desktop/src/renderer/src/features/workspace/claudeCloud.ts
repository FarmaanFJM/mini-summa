// Claude in the cloud, as the workspace shows it: which pages the Cloud tab opens, what the "+" menu and an empty Claude pane can
// offer for a project (local needs a folder, cloud needs a GitHub repository, and one is never swapped for the other), and what
// the embedded page's state means in words. Pure, so the rules are tested without React.
//
// Mini-Summa shows the page of Claude Code on the web and nothing more. It cannot see whether a cloud session is working, done or
// waiting (Anthropic documents no way to list them or to follow one), so it never notifies about one.
import { claudeCodeUrl, parseClaudeCodeUrl } from '@minisumma/shared';
import type { ClaudeWebViewState, Project } from '@minisumma/shared';

/** The id of the Cloud tab among the session tabs. A session key is `<env>|<id>`, so it can never be this. */
export const CLOUD_TAB_ID = 'cloud';

// ---------------------------------------------------------------------------------------------------------------
// What can be started

export interface StartChoice {
  available: boolean;
  /** Why it is not available, in words that name what is missing; null when it is. */
  reason: string | null;
}

export interface ClaudeStart {
  local: StartChoice;
  cloud: StartChoice;
  /** The one thing to add that makes the missing choice possible, as the label of the way into the project settings; null when nothing is missing. */
  fix: string | null;
  /** The main action of an empty pane: Local when there is a folder, else Cloud when there is a repository, else none. */
  primary: 'local' | 'cloud' | null;
}

export const LOCAL_NEEDS_FOLDER = 'Local sessions need a folder on this computer.';
export const CLOUD_NEEDS_REPOSITORY = 'Cloud sessions need a GitHub repository.';

export function claudeStart(project: Pick<Project, 'roots' | 'githubRepo'>): ClaudeStart {
  const folder = project.roots.length > 0;
  const repo = Boolean(project.githubRepo);
  return {
    local: { available: folder, reason: folder ? null : LOCAL_NEEDS_FOLDER },
    cloud: { available: repo, reason: repo ? null : CLOUD_NEEDS_REPOSITORY },
    fix: folder && repo ? null : folder ? 'Add a GitHub repository' : repo ? 'Add a folder' : 'Add a folder or a GitHub repository',
    primary: folder ? 'local' : repo ? 'cloud' : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The pages of the Cloud tab

/** The Cloud tab exists when the project has a GitHub repository, or when a page of Claude Code on the web is remembered for it. */
export const hasCloudTab = (project: Pick<Project, 'githubRepo'>, remembered: string | undefined): boolean =>
  Boolean(project.githubRepo) || remembered !== undefined;

/** The page that starts a new cloud session, the project's repository preselected. Nothing starts until the person submits on the page. */
export const cloudStartUrl = (project: Pick<Project, 'githubRepo'>): string => claudeCodeUrl({ repo: project.githubRepo });

/**
 * The page the Cloud tab opens: where the person was last (a session, or any other page of Claude Code on the web), and the start
 * page of a new session when there is none. The remembered start page is stored without its query, so it is opened as the start
 * page of the project's repository again, never as a bare one that would start in the repository another project last used.
 */
export function cloudTarget(project: Pick<Project, 'githubRepo'>, remembered: string | undefined): string {
  const read = remembered === undefined ? null : parseClaudeCodeUrl(remembered);
  if (read?.ok && (read.info.kind === 'session' || read.info.kind === 'other')) return read.info.url;
  return cloudStartUrl(project);
}

const repositoriesOf = (url: string): string => {
  try {
    const params = new URL(url).searchParams;
    return (params.get('repositories') ?? params.get('repo') ?? '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean).sort().join(',');
  } catch { return ''; }
};

/**
 * Do these two addresses show the same page of Claude Code on the web? A session is its address. The start page is also the
 * repositories it has preselected, because starting in the wrong repository is the one mistake that matters here.
 */
export function sameCloudPage(a: string | null, b: string): boolean {
  if (a === null) return false;
  const x = parseClaudeCodeUrl(a);
  const y = parseClaudeCodeUrl(b);
  if (!x.ok || !y.ok || x.info.url !== y.info.url) return false;
  return x.info.kind === 'session' || x.info.kind === 'other' || repositoriesOf(a) === repositoriesOf(b);
}

/** The address as it is read in the toolbar: the host and path, without the scheme or the query. */
export function cloudAddress(url: string | null): string | null {
  if (!url) return null;
  const read = parseClaudeCodeUrl(url);
  return read.ok ? read.info.url.replace(/^https:\/\//, '') : null;
}

/** The id of the cloud session the page shows, when it is a session page. */
export function cloudSessionId(url: string | null): string | null {
  if (!url) return null;
  const read = parseClaudeCodeUrl(url);
  return read.ok ? read.info.sessionId : null;
}

// ---------------------------------------------------------------------------------------------------------------
// What the page's state means

export interface CloudNotice { tone: 'attention' | 'error'; text: string }

const LEAD = {
  login_required: 'Claude Code on the web is asking you to sign in.',
  blocked: 'Claude Code on the web could not be shown in this tab.',
  error: 'Claude Code on the web could not be loaded.',
} as const;

const FIX = {
  login_required: 'Sign in on the page. If Google sign in is refused here, use Open in your browser.',
  blocked: 'Use Open in your browser.',
  error: 'Check your connection, then reload.',
} as const;

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** null when there is nothing worth saying (ready, loading, or nothing loaded yet). The host's own reason comes first because it knows why. */
export function describeCloudView(state: ClaudeWebViewState | null): CloudNotice | null {
  if (!state) return null;
  switch (state.status) {
    case 'login_required': return { tone: 'attention', text: `${state.note ? sentence(state.note) : LEAD.login_required} ${FIX.login_required}` };
    case 'blocked': return { tone: 'error', text: `${state.note ? sentence(state.note) : LEAD.blocked} ${FIX.blocked}` };
    case 'error': return { tone: 'error', text: `${state.note ? sentence(state.note) : LEAD.error} ${FIX.error}` };
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The one permanent line

/** What Mini-Summa does and does not do with a cloud session, in one sentence. It is a fact that changes what the person waits for. */
export const CLOUD_LINE = 'Mini-Summa shows Claude Code on the web but cannot see whether a cloud session is working, done or waiting, so it sends no notifications for cloud sessions.';
/** The same, where the page cannot be shown inside Mini-Summa. */
export const CLOUD_LINE_BROWSER = 'Mini-Summa cannot see whether a cloud session is working, done or waiting, so it sends no notifications for cloud sessions.';

/** Why the page is not embedded, for the host that cannot do it. */
export function notEmbeddedReason(hostKind: 'electron' | 'browser'): string {
  return hostKind === 'browser'
    ? 'This window runs in a browser, which cannot embed Claude Code on the web. The desktop app can.'
    : 'This build of the desktop app cannot embed Claude Code on the web yet.';
}
