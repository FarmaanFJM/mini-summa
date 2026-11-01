// Cloud sessions started through the official `claude --cloud`, and temporary local workspaces. Types only: the rules live in
// packages/core/src/cloud and packages/core/src/workspaces, and docs/CLOUD_SESSIONS.md and docs/TEMP_WORKSPACES.md say what is
// documented by Anthropic and what is Mini-Summa's own behaviour.

/** Largest prompt Mini-Summa accepts in the composer: below the 1 MB request limit of the local API, with room for JSON escaping. */
export const MAX_PROMPT_CHARS = 250_000;

// ---------------------------------------------------------------------------------------------------------------
// Cloud

/**
 * Where a dispatch stands. None of these says the task is done: Mini-Summa has no signal for that.
 *  preparing          checking the CLI, the repository and the prompt; nothing was sent
 *  waiting_for_input  the CLI stopped at a question (sign in, trust a folder, a confirmation) that only the person can answer
 *  submitting         the prompt was handed to `claude --cloud` and no session link has been seen yet
 *  created            the CLI printed a claude.ai/code session link and Mini-Summa validated it
 *  failed             the CLI said it could not create the session, or could not start
 *  unknown            the CLI ended or went quiet without a link and without an error: the session may or may not exist
 */
export type CloudPhase = 'preparing' | 'waiting_for_input' | 'submitting' | 'created' | 'failed' | 'unknown';

/** How the full prompt reaches the CLI. `argv` is the only mechanism of `claude --cloud "<task>"` that `claude --help` documents. */
export type PromptDeliveryMethod = 'argv' | 'clipboard_browser';

export interface PromptDeliveryPlan {
  method: PromptDeliveryMethod;
  /** Why argv cannot be used (null when it can). Names the limit that was hit. */
  reason: string | null;
  chars: number;
  bytes: number;
  /** The most that the argv route accepts on this computer for this launcher, in characters. */
  argvLimitChars: number;
}

export interface LocalRepoState {
  path: string;
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  /** `owner/repo` of the `origin` remote when it is a github.com remote. */
  remoteRepo: string | null;
  remoteMatchesProject: boolean;
  upstream: string | null;
  /** Commits on the local branch that the remote branch does not have; null when it cannot be told (no upstream, never fetched). */
  unpushed: number | null;
  dirty: boolean;
  untracked: number;
}

export interface CloudPreflight {
  checkedAt: string;
  cli: { found: boolean; version: string | null; cloudFlag: boolean; problem: string | null };
  auth: { state: 'logged_in' | 'logged_out' | 'unknown'; method: string | null; note: string | null };
  githubRepo: string | null;
  /** The folder the CLI would run in, and what git says about it. null when the project has no usable local folder. */
  local: LocalRepoState | null;
  /** The branch the person can choose in the composer. The CLI chooses the branch itself; this is shown as the branch the cloud session is expected to start from. */
  branches: string[];
  /** Things that must be read before sending: unpushed commits, a folder that is not the project's repository, local content the CLI may upload. */
  warnings: string[];
  /** Why dispatch cannot start at all. Empty when it can. */
  blockers: string[];
}

export interface CloudDispatchInput {
  projectId: string;
  prompt: string;
  /** A folder of the project to run the CLI in. Omitted: a minimal checkout of the repository is prepared. */
  rootId?: string | null;
  title?: string | null;
  /** The person read the disclosure that `claude --cloud` runs from a local repository and may send local content. Required. */
  acknowledgedLocalContent: boolean;
  /** The person accepted the clipboard and browser route for a prompt that cannot go through the CLI. */
  useBrowserFallback?: boolean;
}

export interface CloudDispatch {
  id: string;
  projectId: string;
  phase: CloudPhase;
  startedAt: string;
  updatedAt: string;
  /** Plain words for the phase. */
  detail: string;
  method: PromptDeliveryMethod;
  /** The last lines the CLI printed, ANSI removed, with the prompt blanked out. */
  tail: string[];
  sessionId: string | null;
  sessionUrl: string | null;
  /** The process is still running. */
  running: boolean;
}

export type CloudDispatchMethod = 'cli_cloud' | 'browser_fallback' | 'recorded_link';
export type CloudFollowUpOutcome = 'accepted' | 'rejected' | 'unknown';

export interface CloudSessionRecord {
  id: string;
  projectId: string;
  repo: string | null;
  /** The branch of the folder the CLI ran in, as git reported it before dispatch. Not a statement about the cloud session's branch. */
  sourceRef: string | null;
  sessionId: string;
  /** Validated: https, claude.ai, /code/session_...; never anything else. */
  url: string;
  title: string | null;
  createdAt: string;
  method: CloudDispatchMethod;
  /** What the last dispatch or follow-up attempt returned. "accepted" means the CLI took the message, not that Claude did the work. */
  lastResult: { at: string; outcome: 'created' | CloudFollowUpOutcome; note: string | null };
}

export interface CloudFollowUpInput { message: string }
export interface CloudFollowUpResult { outcome: CloudFollowUpOutcome; note: string }

// ---------------------------------------------------------------------------------------------------------------
// Temporary workspaces

export type WorkspaceStatus = 'cloning' | 'ready' | 'clone_failed' | 'cancelled' | 'removed';

export interface TempWorkspace {
  /** Stable. The directory is named after it, never after the repository. */
  id: string;
  projectId: string;
  repo: string;
  /** Absolute path of the checkout. */
  path: string;
  status: WorkspaceStatus;
  branch: string | null;
  /** The feature branch Mini-Summa created, when asked to. */
  featureBranch: string | null;
  shallow: boolean;
  purpose: 'session' | 'dispatch';
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** Approximate size GitHub reported, in KiB; a hint, not a promise. */
  reportedSizeKb: number | null;
}

export interface CloneCheck {
  repo: string;
  /** `git ls-remote` reached the repository with the person's own Git credentials. */
  access: 'ok' | 'denied' | 'not_found' | 'unreachable' | 'unknown';
  accessNote: string | null;
  /** GitHub's `size` field, KiB. null when it could not be read (private repository, rate limit, offline). */
  reportedSizeKb: number | null;
  freeBytes: number | null;
  defaultBranch: string | null;
  branches: string[];
  /** Must be confirmed before cloning. */
  needsConfirmation: boolean;
  warnings: string[];
  blockers: string[];
}

export interface WorkspaceCreateInput {
  projectId: string;
  /** The person confirmed the warnings of the check (large or unknown size). */
  confirmed: boolean;
  branch?: string | null;
  /** Create this new branch from the starting branch after cloning. */
  featureBranch?: string | null;
  shallow?: boolean;
  purpose?: 'session' | 'dispatch';
}

export interface WorkspaceInspection {
  id: string;
  exists: boolean;
  branch: string | null;
  remoteRepo: string | null;
  remoteMatches: boolean;
  trackedChanges: number;
  untracked: number;
  ignoredFiles: number;
  unpushedCommits: number | null;
  /** Local branches whose tip the remote does not have. */
  unpublishedBranches: string[];
  /** `published`: the tip of the checked-out branch is on the remote. `unpublished`: it is not. `unknown`: it cannot be told. */
  publication: 'published' | 'unpublished' | 'unknown';
  running: string[];
  /** Reasons cleanup must not be offered. */
  blockers: string[];
  /** Things the person should know would be lost. */
  warnings: string[];
  safeToClean: boolean;
  /** What happens to the files: the Recycle Bin or Trash when the host can, else nothing is offered without a separate decision. */
  recoverableDelete: boolean;
}

export interface WorkspaceCleanupInput {
  /** Typed confirmation: the repository name. */
  confirmRepo: string;
  /** Only honoured when the host has no Recycle Bin or Trash, and only with this exact wording of intent. */
  permanent?: boolean;
}
