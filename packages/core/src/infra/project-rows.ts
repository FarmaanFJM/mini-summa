// Database rows of the projects, project_roots and conversations tables, and their mapping to the shared entities.
import { defaultNotificationPrefs } from '@minisumma/shared';
import type { ChatGptUrlKind, Conversation, ConversationVerification, EnvId, Project, ProjectNotificationPrefs, ProjectRoot, SessionKey } from '@minisumma/shared';
import { fromJson } from '@minisumma/storage';

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  github_repo: string | null;
  default_env: string;
  preferred_conversation_id: string | null;
  default_session_key: string | null;
  notification_prefs_json: string;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RootRow {
  id: string;
  project_id: string;
  env: string;
  path: string;
  label: string | null;
  position: number;
  root_key: string;
}

export interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  url: string;
  original_url: string;
  kind: string;
  chatgpt_conversation_id: string | null;
  verification: string;
  verified_at: string | null;
  verified_title: string | null;
  note: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export const NOTIFICATION_PREF_KEYS = Object.keys(defaultNotificationPrefs()) as (keyof ProjectNotificationPrefs)[];

/** Stored prefs over the defaults: a key missing from an older row is defaulted, anything that is not a boolean is ignored. */
export function parsePrefs(json: string): ProjectNotificationPrefs {
  const stored = fromJson<Record<string, unknown>>(json, {});
  const out = defaultNotificationPrefs();
  for (const k of NOTIFICATION_PREF_KEYS) if (typeof stored[k] === 'boolean') out[k] = stored[k];
  return out;
}

export const rootOf = (r: RootRow): ProjectRoot => ({
  id: r.id, projectId: r.project_id, env: r.env as EnvId, path: r.path, label: r.label, position: r.position,
});

export const conversationOf = (r: ConversationRow): Conversation => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  url: r.url,
  originalUrl: r.original_url,
  kind: r.kind as ChatGptUrlKind,
  chatgptConversationId: r.chatgpt_conversation_id,
  verification: r.verification as ConversationVerification,
  verifiedAt: r.verified_at,
  verifiedTitle: r.verified_title,
  note: r.note,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const projectOf = (p: ProjectRow, roots: RootRow[]): Project => ({
  id: p.id,
  name: p.name,
  description: p.description,
  githubRepo: p.github_repo,
  roots: roots.map(rootOf),
  defaultEnv: p.default_env as EnvId,
  preferredConversationId: p.preferred_conversation_id,
  defaultSessionKey: p.default_session_key as SessionKey | null,
  notificationPrefs: parsePrefs(p.notification_prefs_json),
  sortOrder: p.sort_order,
  archivedAt: p.archived_at,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});
