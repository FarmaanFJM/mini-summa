// The project dialog edits a draft. Nothing reaches the core until Save, and Save sends only what differs. All of the
// rules (exactly one preferred conversation, the first one becomes preferred, what a save has to send) live here, pure.
import { normalizeGithubRepo, suggestConversationTitle } from '@minisumma/shared';
import type { ChatGptUrlInfo, ChatGptUrlKind, Conversation, EnvId, Project, RepoResult } from '@minisumma/shared';

export interface DraftRoot { key: string; id: string | null; env: EnvId; path: string }
export interface DraftConversation { key: string; id: string | null; url: string; title: string; kind: ChatGptUrlKind }

export interface ProjectDraft {
  name: string;
  /** As typed. Normalised to owner/repo by `normalizeGithubRepo` when saving. */
  githubRepo: string;
  roots: DraftRoot[];
  conversations: DraftConversation[];
  /** Key of the preferred conversation. Null only while there are no conversations. */
  preferredKey: string | null;
  /** Environment for new sessions, chosen only when the roots span more than one. */
  defaultEnv: EnvId | null;
}

let sequence = 0;
const nextKey = (prefix: string): string => `${prefix}${(sequence += 1)}`;

export const emptyDraft = (): ProjectDraft => ({ name: '', githubRepo: '', roots: [], conversations: [], preferredKey: null, defaultEnv: null });

export function draftFromProject(project: Project, conversations: readonly Conversation[]): ProjectDraft {
  const items = conversations.filter((c) => c.projectId === project.id).sort((a, b) => a.position - b.position);
  const preferred = items.find((c) => c.id === project.preferredConversationId) ?? items[0] ?? null;
  const draft: ProjectDraft = {
    name: project.name,
    githubRepo: project.githubRepo ?? '',
    roots: project.roots.slice().sort((a, b) => a.position - b.position).map((r) => ({ key: r.id, id: r.id, env: r.env, path: r.path })),
    conversations: items.map((c) => ({ key: c.id, id: c.id, url: c.url, title: c.title, kind: c.kind })),
    preferredKey: preferred?.id ?? null,
    defaultEnv: project.defaultEnv,
  };
  return draft;
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub repository (the reading of what was pasted lives in @minisumma/shared, where the core and the cloud entry point use it too)

export { normalizeGithubRepo };
export type { RepoResult };

export function validateDraft(draft: ProjectDraft): { name?: string; githubRepo?: string } {
  const errors: { name?: string; githubRepo?: string } = {};
  const name = draft.name.trim();
  if (name === '') errors.name = 'Give the project a name.';
  else if (name.length > 120) errors.name = 'Use 120 characters or fewer.';
  const repo = normalizeGithubRepo(draft.githubRepo);
  if (!repo.ok) errors.githubRepo = repo.message;
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// Conversations: exactly one is preferred, and the first one added is preferred without asking.

/** Restores the invariant: no conversations means no preferred one; otherwise exactly one that exists. */
export function withPreferredRule(draft: ProjectDraft): ProjectDraft {
  if (draft.conversations.length === 0) return draft.preferredKey === null ? draft : { ...draft, preferredKey: null };
  if (draft.preferredKey !== null && draft.conversations.some((c) => c.key === draft.preferredKey)) return draft;
  return { ...draft, preferredKey: draft.conversations[0].key };
}

export type AddResult = { ok: true; draft: ProjectDraft; key: string } | { ok: false; message: string };

export function addConversation(draft: ProjectDraft, info: ChatGptUrlInfo, title?: string): AddResult {
  if (draft.conversations.some((c) => c.url === info.url)) return { ok: false, message: 'This conversation is already in the list.' };
  const key = nextKey('new-cnv-');
  const conversation: DraftConversation = { key, id: null, url: info.url, title: (title ?? '').trim() || suggestConversationTitle(info), kind: info.kind };
  return { ok: true, key, draft: withPreferredRule({ ...draft, conversations: [...draft.conversations, conversation] }) };
}

export function removeConversation(draft: ProjectDraft, key: string): ProjectDraft {
  return withPreferredRule({ ...draft, conversations: draft.conversations.filter((c) => c.key !== key) });
}

export function setPreferred(draft: ProjectDraft, key: string): ProjectDraft {
  return draft.conversations.some((c) => c.key === key) ? { ...draft, preferredKey: key } : draft;
}

export function renameConversation(draft: ProjectDraft, key: string, title: string): ProjectDraft {
  return { ...draft, conversations: draft.conversations.map((c) => (c.key === key ? { ...c, title } : c)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Roots

export function addRoot(draft: ProjectDraft, env: EnvId, path: string): { ok: true; draft: ProjectDraft } | { ok: false; message: string } {
  const same = (r: DraftRoot) => r.env === env && r.path.toLowerCase() === path.toLowerCase();
  if (draft.roots.some(same)) return { ok: false, message: 'This folder is already in the list.' };
  return { ok: true, draft: { ...draft, roots: [...draft.roots, { key: nextKey('new-root-'), id: null, env, path }] } };
}

export function removeRoot(draft: ProjectDraft, key: string): ProjectDraft {
  return { ...draft, roots: draft.roots.filter((r) => r.key !== key) };
}

export const distinctEnvs = (roots: readonly DraftRoot[]): EnvId[] => [...new Set(roots.map((r) => r.env))];

// ---------------------------------------------------------------------------------------------------------------
// What Save sends

export type SaveOp =
  | { kind: 'create'; name: string; githubRepo: string | null; defaultEnv: EnvId | null; roots: { key: string; path: string; env: EnvId }[] }
  | { kind: 'update'; patch: { name?: string; githubRepo?: string | null; defaultEnv?: EnvId } }
  | { kind: 'removeRoot'; rootId: string }
  | { kind: 'addRoot'; key: string; path: string; env: EnvId }
  | { kind: 'removeConversation'; id: string }
  | { kind: 'renameConversation'; id: string; title: string }
  | { kind: 'addConversation'; key: string; url: string; title: string; makePreferred: boolean }
  | { kind: 'setPreferred'; conversationId: string };

export interface SaveBase { project: Project; conversations: readonly Conversation[] }

/**
 * The calls a save needs, in order. `base` is the project as the core has it right now (null when creating), so a retry
 * after a partial failure sends only what is still missing.
 */
export function planSave(input: ProjectDraft, base: SaveBase | null): SaveOp[] {
  const draft = withPreferredRule(input);
  const name = draft.name.trim();
  const repo = normalizeGithubRepo(draft.githubRepo);
  const githubRepo = repo.ok ? repo.value : null;
  const multiEnv = distinctEnvs(draft.roots).length > 1;
  const wantedEnv = multiEnv ? draft.defaultEnv : null;
  const ops: SaveOp[] = [];

  if (!base) {
    ops.push({ kind: 'create', name, githubRepo, defaultEnv: wantedEnv, roots: draft.roots.map((r) => ({ key: r.key, path: r.path, env: r.env })) });
    for (const c of draft.conversations) {
      ops.push({ kind: 'addConversation', key: c.key, url: c.url, title: c.title.trim(), makePreferred: c.key === draft.preferredKey });
    }
    return ops;
  }

  const { project } = base;
  const patch: { name?: string; githubRepo?: string | null; defaultEnv?: EnvId } = {};
  if (name !== project.name) patch.name = name;
  if (githubRepo !== project.githubRepo) patch.githubRepo = githubRepo;
  if (wantedEnv && wantedEnv !== project.defaultEnv) patch.defaultEnv = wantedEnv;
  if (Object.keys(patch).length > 0) ops.push({ kind: 'update', patch });

  const keptRootIds = new Set(draft.roots.map((r) => r.id).filter((id): id is string => id !== null));
  for (const r of project.roots) if (!keptRootIds.has(r.id)) ops.push({ kind: 'removeRoot', rootId: r.id });
  for (const r of draft.roots) if (r.id === null) ops.push({ kind: 'addRoot', key: r.key, path: r.path, env: r.env });

  const keptConversationIds = new Set(draft.conversations.map((c) => c.id).filter((id): id is string => id !== null));
  const removed = base.conversations.filter((c) => c.projectId === project.id && !keptConversationIds.has(c.id));
  for (const c of removed) ops.push({ kind: 'removeConversation', id: c.id });
  for (const c of draft.conversations) {
    const existing = c.id ? base.conversations.find((x) => x.id === c.id) : undefined;
    if (existing && existing.title !== c.title.trim()) ops.push({ kind: 'renameConversation', id: existing.id, title: c.title.trim() });
  }
  for (const c of draft.conversations) {
    if (c.id === null) ops.push({ kind: 'addConversation', key: c.key, url: c.url, title: c.title.trim(), makePreferred: c.key === draft.preferredKey });
  }

  // An existing conversation that should be preferred is set explicitly. The core may also have moved the preference
  // when a conversation was removed, so that case is always restated.
  const preferred = draft.conversations.find((c) => c.key === draft.preferredKey);
  if (preferred?.id && (preferred.id !== project.preferredConversationId || removed.length > 0)) {
    ops.push({ kind: 'setPreferred', conversationId: preferred.id });
  }
  return ops;
}
