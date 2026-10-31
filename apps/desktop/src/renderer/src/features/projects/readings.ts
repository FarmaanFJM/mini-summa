// What a person typed or picked, read in words. Pure: the dialogs show these readings as the person types and send only what a
// reading approves. Nothing here keeps a draft; there is no state to lose.
import { normalizeGithubRepo, normalizeRootInput, parseChatGptProjectLink, titleFromProjectScope } from '@minisumma/shared';
import type { EnvId } from '@minisumma/shared';

export type HostPlatform = 'win32' | 'linux' | 'darwin';
export const isHostPlatform = (v: unknown): v is HostPlatform => v === 'win32' || v === 'linux' || v === 'darwin';

// ---------------------------------------------------------------------------------------------------------------
// Name

export const NAME_MAX = 120;

export type NameCheck = { ok: true; value: string } | { ok: false; message: string };

export function checkName(text: string): NameCheck {
  const value = text.trim();
  if (value === '') return { ok: false, message: 'Give the project a name.' };
  if (value.length > NAME_MAX) return { ok: false, message: `Use ${NAME_MAX} characters or fewer.` };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------------------------
// ChatGPT Project address

export type AddressReading =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  /** An address in the form Mini-Summa recognises: the project page, and the words in the address as its title. */
  | { kind: 'project'; url: string; title: string; named: boolean; fromConversation: boolean }
  /** An address on chatgpt.com in a form that is not recognised. It is kept and opened exactly as pasted. */
  | { kind: 'as-pasted'; url: string };

export function readChatGptAddress(text: string): AddressReading {
  if (text.trim() === '') return { kind: 'empty' };
  const parsed = parseChatGptProjectLink(text);
  if (!parsed.ok) return { kind: 'invalid', message: parsed.message };
  const { link } = parsed;
  if (link.scopeId === null) return { kind: 'as-pasted', url: link.url };
  return { kind: 'project', url: link.url, title: link.title, named: titleFromProjectScope(link.scopeId) !== null, fromConversation: link.derivedFromConversation };
}

/** Said under the address field. Only the address is stored; this sentence prevents the assumption that more is. */
export const ADDRESS_ONLY_NOTE = 'Only the address is saved. Nothing in the project is imported or synced.';

/** The title a link gets by itself from its address, so that a changed address can tell a typed title from an automatic one. */
export function automaticTitleOf(url: string): string | null {
  const parsed = parseChatGptProjectLink(url);
  return parsed.ok ? parsed.link.title : null;
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub repository

export type RepoReading =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; value: string; changed: boolean };

export function readGithub(text: string): RepoReading {
  const read = normalizeGithubRepo(text);
  if (!read.ok) return { kind: 'invalid', message: read.message };
  return read.value === null ? { kind: 'empty' } : { kind: 'ok', value: read.value, changed: read.changed };
}

/** What a repository is called when the person has not said: the part after the slash. */
export const repoName = (value: string): string => value.split('/')[1] ?? '';

// ---------------------------------------------------------------------------------------------------------------
// Folder

export type FolderReading =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  /** A Linux path on Windows: it names no folder until the person says which WSL distribution it is in. */
  | { kind: 'needs-distro'; message: string }
  | { kind: 'ok'; env: EnvId; path: string; note: string | null };

export function readFolder(text: string, hostPlatform: HostPlatform, distro: EnvId | null): FolderReading {
  if (text.trim() === '') return { kind: 'empty' };
  const first = normalizeRootInput(text, { hostPlatform });
  const read = !first.ok && first.needsEnv && distro ? normalizeRootInput(text, { hostPlatform, env: distro }) : first;
  if (read.ok) return { kind: 'ok', env: read.env, path: read.path, note: read.note };
  return read.needsEnv ? { kind: 'needs-distro', message: read.message } : { kind: 'invalid', message: read.message };
}

/** Said when a path is left in a folder field that cannot take it yet. */
export const NEEDS_DISTRO_NOTE = 'Choose which WSL distribution this folder is in, or clear the folder field.';

/** What a folder is called when the person has not said: its last segment. A drive on its own has no name worth using. */
export function folderName(path: string): string {
  const last = path.split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
  return /^[A-Za-z]:$/.test(last) ? '' : last;
}

// ---------------------------------------------------------------------------------------------------------------
// New project: the four ways it starts, and the one call that creates it

export type SourceId = 'chatgpt' | 'github' | 'folder' | 'empty';

export const SOURCES: readonly { id: SourceId; label: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT Project' },
  { id: 'github', label: 'GitHub repository' },
  { id: 'folder', label: 'Local folder' },
  { id: 'empty', label: 'Empty project' },
];

export interface NewProjectInput {
  source: SourceId;
  address: string;
  repo: string;
  folder: string;
  hostPlatform: HostPlatform;
  distro: EnvId | null;
  name: string;
}

export type CreateBody = {
  name: string;
  chatgptProject?: { url: string };
  githubRepo?: string;
  roots?: { path: string; env: EnvId }[];
};

export interface CreateErrors { name?: string; source?: string }

export type CreatePlan = { ok: true; body: CreateBody } | { ok: false; errors: CreateErrors };

/** The name offered until the person types their own: the ChatGPT Project's title, the repository's name or the folder's name. */
export function suggestName(input: Pick<NewProjectInput, 'source' | 'address' | 'repo' | 'folder' | 'hostPlatform' | 'distro'>): string {
  switch (input.source) {
    case 'chatgpt': {
      const read = readChatGptAddress(input.address);
      // "ChatGPT Project" is what an address with no words in it is called: not a name worth offering.
      return read.kind === 'project' && read.named ? read.title : '';
    }
    case 'github': {
      const read = readGithub(input.repo);
      return read.kind === 'ok' ? repoName(read.value) : '';
    }
    case 'folder': {
      const read = readFolder(input.folder, input.hostPlatform, input.distro);
      return read.kind === 'ok' ? folderName(read.path) : '';
    }
    default: return '';
  }
}

const sourceError = (input: NewProjectInput): string | null => {
  switch (input.source) {
    case 'chatgpt': {
      const read = readChatGptAddress(input.address);
      if (read.kind === 'empty') return 'Paste the address of the ChatGPT Project.';
      return read.kind === 'invalid' ? read.message : null;
    }
    case 'github': {
      const read = readGithub(input.repo);
      if (read.kind === 'empty') return 'Enter the repository as owner/repo.';
      return read.kind === 'invalid' ? read.message : null;
    }
    case 'folder': {
      const read = readFolder(input.folder, input.hostPlatform, input.distro);
      if (read.kind === 'empty') return 'Enter the folder that holds the project.';
      if (read.kind === 'needs-distro') return NEEDS_DISTRO_NOTE;
      return read.kind === 'invalid' ? read.message : null;
    }
    default: return null;
  }
};

/** The body of the one `projects.create` call, or what is wrong. Only what the chosen source needs is looked at. */
export function planCreate(input: NewProjectInput): CreatePlan {
  const errors: CreateErrors = {};
  const name = checkName(input.name);
  if (!name.ok) errors.name = name.message;
  const problem = sourceError(input);
  if (problem) errors.source = problem;
  if (!name.ok || problem) return { ok: false, errors };

  // sourceError said the reading is usable, so the guards below only narrow the types.
  switch (input.source) {
    case 'chatgpt': return { ok: true, body: { name: name.value, chatgptProject: { url: input.address.trim() } } };
    case 'github': {
      const read = readGithub(input.repo);
      return read.kind === 'ok' ? { ok: true, body: { name: name.value, githubRepo: read.value } } : { ok: false, errors };
    }
    case 'folder': {
      const read = readFolder(input.folder, input.hostPlatform, input.distro);
      return read.kind === 'ok' ? { ok: true, body: { name: name.value, roots: [{ path: read.path, env: read.env }] } } : { ok: false, errors };
    }
    default: return { ok: true, body: { name: name.value } };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Where a failure of the core belongs

export type FailureField = 'name' | 'source' | 'general';

/**
 * The core's own words say what is wrong; this only decides which field they go beside. A refusal about the folder belongs beside
 * the folder, one about the address beside the address, and anything else (the core cannot be reached) is said once for the dialog.
 */
export function failureField(error: { code?: string; details?: unknown }): FailureField {
  const code = error.code ?? '';
  const field = (error.details as { field?: unknown } | null | undefined)?.field;
  if (field === 'name' || code === 'invalid_name') return 'name';
  if (field === 'path' || field === 'githubRepo' || field === 'chatgptProject') return 'source';
  if (/^(root_|invalid_root|needs_env|invalid_repo|invalid_chatgpt_project|invalid_conversation_url|conversation_)/.test(code)) return 'source';
  return 'general';
}
