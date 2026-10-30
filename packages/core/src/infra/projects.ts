// ProjectsService: projects, their folders (roots), the ChatGPT conversations mapped to them, and the project registry
// that tells the rest of the system which project a working directory belongs to.
//
// Rules worth knowing before reading the code:
// * A root is stored as (env, path, root_key). root_key is the canonical spelling from @minisumma/shared rootKey(), so
//   `C:\Dev\App` and `/mnt/c/Dev/App` (inside WSL) are the same folder, while the same POSIX path in two WSL
//   distributions is two folders. A folder may belong to one project only; nested folders across projects are fine.
// * The registry is the verified PoC matcher (createRegistry). It is rebuilt lazily after anything that changes what it
//   would answer: roots, archive/restore, rename, create, delete. `onRootsChanged` fires on the same occasions.
// * Events are emitted after the transaction committed, conversation events before the project event they imply.
import { createRegistry, detectEnv } from '@minisumma/claude-integration';
import type { FolderCheck } from './folders.ts';
import {
  isEnvId, isSessionKey, isWslEnv, normalizeRootInput, parseChatGptProjectLink, parseChatGptUrl, rootKey, suggestConversationTitle,
} from '@minisumma/shared';
import type { ChatGptUrlInfo, Conversation, ConversationVerification, EnvId, Project, ProjectNotificationPrefs, SessionKey } from '@minisumma/shared';
import { newId } from '@minisumma/storage';
import type { SqlValue } from '@minisumma/storage';
import type { CoreBase, ProjectCreateInput, ProjectRegistry, ProjectsService, SettingsService } from '../contracts.ts';
import { CoreError, badRequest, conflict } from '../errors.ts';
import { NOTIFICATION_PREF_KEYS, conversationOf, parsePrefs, projectOf } from './project-rows.ts';
import type { ConversationRow, ProjectRow, RootRow } from './project-rows.ts';

export interface ProjectsDeps {
  base: Pick<CoreBase, 'db' | 'bus' | 'clock' | 'log'>;
  /** New projects start from `settings.notifications.defaults`. */
  settings: Pick<SettingsService, 'get'>;
  /** Platform of the machine running Mini-Summa. Decides how a Linux-style path is read. Default: process.platform. */
  hostPlatform?: 'win32' | 'linux' | 'darwin';
  /** Environment of the machine running Mini-Summa (CoreOptions.overrides.hostEnv). Default: detected from the process. */
  hostEnv?: EnvId;
  /** Refuses a folder that cannot be a project folder (it does not exist, it is a file). Absent: any readable path is accepted. */
  folderCheck?: FolderCheck;
}

const VERIFICATIONS: readonly ConversationVerification[] = ['unverified', 'verified', 'mismatch', 'unreachable', 'login_required'];
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const projectNotFound = () => new CoreError(404, 'not_found', 'That project was not found. It may have been deleted, so reload the project list.');
const conversationNotFound = () => new CoreError(404, 'not_found', 'That conversation was not found. It may have been removed, so reload the project.');

function toHostPlatform(p: NodeJS.Platform): 'win32' | 'linux' | 'darwin' {
  return p === 'win32' || p === 'darwin' ? p : 'linux';
}

function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === '') throw badRequest('A project needs a name. Enter a name and save again.', { field: 'name' }, 'invalid_name');
  if (s.length > 120) throw badRequest('The project name is too long (at most 120 characters). Shorten it and save again.', { field: 'name' }, 'invalid_name');
  return s;
}

function cleanText(v: unknown, max: number, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw badRequest(`The ${field} must be text. Enter text and save again.`, { field }, 'invalid_text');
  const s = v.trim();
  if (s.length > max) throw badRequest(`The ${field} is too long (at most ${max} characters). Shorten it and save again.`, { field }, 'invalid_text');
  return s === '' ? null : s;
}

function cleanRepo(v: unknown): string | null {
  const s = cleanText(v, 200, 'GitHub repository');
  if (s !== null && !GITHUB_REPO.test(s)) throw badRequest('The GitHub repository must look like owner/repo. Fix it and save again.', { field: 'githubRepo' }, 'invalid_repo');
  return s;
}

interface ChatGptProjectColumns { url: string; scope: string | null; title: string }

/** The three columns for a linked ChatGPT Project, from what the person pasted (a project page, or a conversation inside the project). */
function cleanChatGptProject(v: unknown): ChatGptProjectColumns | null {
  if (v === null || v === undefined) return null;
  const input = typeof v === 'object' ? (v as { url?: unknown; title?: unknown }) : null;
  if (!input || typeof input.url !== 'string') {
    throw badRequest('The ChatGPT Project needs an address. Paste the address of the project from ChatGPT.', { field: 'chatgptProject' }, 'invalid_chatgpt_project');
  }
  const parsed = parseChatGptProjectLink(input.url);
  if (!parsed.ok) throw badRequest(parsed.message, { field: 'chatgptProject' }, 'invalid_chatgpt_project');
  const title = cleanText(input.title, 120, 'ChatGPT Project title') ?? parsed.link.title;
  return { url: parsed.link.url, scope: parsed.link.scopeId, title };
}

function cleanEnv(v: unknown): EnvId {
  if (!isEnvId(v)) throw badRequest('That environment is not valid. Use win, posix or wsl:<Distro>.', { field: 'env' }, 'invalid_env');
  return v;
}

export function createProjectsService(deps: ProjectsDeps): ProjectsService {
  const { db, bus, clock, log } = deps.base;
  const hostPlatform = deps.hostPlatform ?? toHostPlatform(process.platform);
  const hostEnv: EnvId = deps.hostEnv ?? detectEnv();
  const nowIso = (): string => clock.now().toISOString();

  // -------------------------------------------------------------------------------------------------------------
  // Reads

  const projectRow = (id: string) => db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
  const requireRow = (id: string): ProjectRow => projectRow(id) ?? (() => { throw projectNotFound(); })();
  const rootRows = (projectId: string) => db.all<RootRow>('SELECT * FROM project_roots WHERE project_id = ? ORDER BY position, id', [projectId]);
  const build = (row: ProjectRow): Project => projectOf(row, rootRows(row.id));
  const conversationRow = (id: string) => db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]);
  const requireConversationRow = (id: string): ConversationRow => conversationRow(id) ?? (() => { throw conversationNotFound(); })();

  function list(opts?: { includeArchived?: boolean }): Project[] {
    const rows = db.all<ProjectRow>(
      `SELECT * FROM projects ${opts?.includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY sort_order, created_at, id`,
    );
    const byProject = new Map<string, RootRow[]>();
    for (const r of db.all<RootRow>('SELECT * FROM project_roots ORDER BY position, id')) {
      const bucket = byProject.get(r.project_id);
      if (bucket) bucket.push(r); else byProject.set(r.project_id, [r]);
    }
    return rows.map((row) => projectOf(row, byProject.get(row.id) ?? []));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Registry and root-change notification

  let registryCache: ProjectRegistry | null = null;
  const rootListeners = new Set<() => void>();

  function registryFileContents() {
    return {
      defaultEnv: hostEnv,
      projects: list({ includeArchived: false }).map((p) => ({
        id: p.id,
        name: p.name,
        roots: p.roots.map((r) => ({ path: r.path, env: r.env })),
      })),
    };
  }

  /** Drops the cached matcher. Call right after a commit that changed what the matcher would answer. */
  const invalidateRegistry = (): void => { registryCache = null; };

  function fireRootsChanged(): void {
    for (const fn of [...rootListeners]) {
      try { fn(); } catch (err) {
        log.warn('A roots-changed listener failed.', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Events

  const emitProject = (id: string): void => {
    const row = projectRow(id);
    if (row) bus.emit({ type: 'project.upserted', project: build(row) });
  };
  const emitConversation = (conversation: Conversation): void => { bus.emit({ type: 'conversation.upserted', conversation }); };

  // -------------------------------------------------------------------------------------------------------------
  // Roots

  interface PreparedRoot { env: EnvId; path: string; label: string | null; key: string }

  function prepareRoot(input: { path: string; env?: EnvId; label?: string | null }): PreparedRoot {
    // Inside WSL a POSIX path means "in this distribution", not the generic 'posix' namespace, unless the user said otherwise.
    const posixLooking = typeof input.path === 'string' && input.path.trim().startsWith('/');
    const env = input.env !== undefined ? cleanEnv(input.env) : isWslEnv(hostEnv) && posixLooking ? hostEnv : undefined;
    const r = normalizeRootInput(input.path, { hostPlatform, env });
    if (!r.ok) {
      throw r.needsEnv
        ? badRequest(r.message, { needsEnv: true }, 'needs_env')
        : badRequest(r.message, undefined, 'invalid_root');
    }
    const problem = deps.folderCheck?.(r.env, r.path);
    if (problem) throw badRequest(problem.message, { field: 'path' }, problem.code);
    return { env: r.env, path: r.path, label: cleanText(input.label, 120, 'folder label'), key: rootKey(r.env, r.path) };
  }

  /** 409 when the folder already belongs to another project, or to this one. `projectId` null = a project not yet created. */
  function assertRootFree(projectId: string | null, key: string): void {
    const holders = db.all<{ project_id: string; name: string; archived_at: string | null }>(
      `SELECT pr.project_id, p.name, p.archived_at FROM project_roots pr JOIN projects p ON p.id = pr.project_id WHERE pr.root_key = ?`,
      [key],
    );
    const other = holders.find((h) => h.project_id !== projectId);
    if (other) {
      throw conflict(
        `This folder already belongs to the project "${other.name}"${other.archived_at ? ' (archived)' : ''}. A folder can belong to one project only, so remove it there first or choose a different folder.`,
        'root_in_use',
        { projectId: other.project_id, projectName: other.name },
      );
    }
    if (holders.length > 0) throw conflict('This folder is already a root of this project. Choose a different folder.', 'root_exists');
  }

  function insertRoot(projectId: string, r: PreparedRoot, position: number): void {
    db.run(
      'INSERT INTO project_roots (id, project_id, env, path, label, position, root_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId('rot'), projectId, r.env, r.path, r.label, position, r.key],
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // Project writes

  function create(input: ProjectCreateInput): Project {
    const name = cleanName(input.name);
    const description = cleanText(input.description, 2000, 'description');
    const githubRepo = cleanRepo(input.githubRepo);
    const chatgpt = cleanChatGptProject(input.chatgptProject);
    const roots = (input.roots ?? []).map(prepareRoot);
    const seen = new Set<string>();
    for (const r of roots) {
      if (seen.has(r.key)) throw conflict('The same folder is listed twice. Remove the duplicate and save again.', 'root_exists');
      seen.add(r.key);
    }
    const defaultEnv = input.defaultEnv !== undefined ? cleanEnv(input.defaultEnv) : roots[0]?.env ?? hostEnv;
    const id = newId('prj');
    const at = nowIso();
    const prefs = JSON.stringify(deps.settings.get().notifications.defaults);

    db.tx(() => {
      for (const r of roots) assertRootFree(null, r.key);
      const order = db.get<{ n: number | null }>('SELECT MAX(sort_order) AS n FROM projects')?.n;
      db.run(
        `INSERT INTO projects (id, name, description, github_repo, chatgpt_project_url, chatgpt_project_scope, chatgpt_project_title,
                               default_env, preferred_conversation_id, default_session_key,
                               notification_prefs_json, sort_order, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`,
        [id, name, description, githubRepo, chatgpt?.url ?? null, chatgpt?.scope ?? null, chatgpt?.title ?? null, defaultEnv, prefs, (order ?? -1) + 1, at, at],
      );
      roots.forEach((r, i) => insertRoot(id, r, i));
    });

    invalidateRegistry();
    emitProject(id);
    fireRootsChanged();
    return build(requireRow(id));
  }

  function mergePrefs(base: ProjectNotificationPrefs, patch: Partial<ProjectNotificationPrefs>): ProjectNotificationPrefs {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !(NOTIFICATION_PREF_KEYS as string[]).includes(k)) continue;
      if (typeof v !== 'boolean') throw badRequest(`The notification setting "${k}" must be true or false. Send true or false.`, { field: k }, 'invalid_prefs');
      out[k as keyof ProjectNotificationPrefs] = v;
    }
    return out;
  }

  function update(id: string, patch: Parameters<ProjectsService['update']>[1]): Project {
    const row = requireRow(id);
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const set = (col: string, v: SqlValue): void => { sets.push(`${col} = ?`); params.push(v); };
    let registryAffected = false;

    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      if (name !== row.name) { set('name', name); registryAffected = true; }
    }
    if (patch.description !== undefined) {
      const d = cleanText(patch.description, 2000, 'description');
      if (d !== row.description) set('description', d);
    }
    if (patch.githubRepo !== undefined) {
      const g = cleanRepo(patch.githubRepo);
      if (g !== row.github_repo) set('github_repo', g);
    }
    if (patch.chatgptProject !== undefined) {
      const c = cleanChatGptProject(patch.chatgptProject);
      if ((c?.url ?? null) !== row.chatgpt_project_url) set('chatgpt_project_url', c?.url ?? null);
      if ((c?.scope ?? null) !== row.chatgpt_project_scope) set('chatgpt_project_scope', c?.scope ?? null);
      if ((c?.title ?? null) !== row.chatgpt_project_title) set('chatgpt_project_title', c?.title ?? null);
    }
    if (patch.defaultEnv !== undefined) {
      const e = cleanEnv(patch.defaultEnv);
      if (e !== row.default_env) set('default_env', e);
    }
    if (patch.notificationPrefs !== undefined) {
      const before = parsePrefs(row.notification_prefs_json);
      const after = JSON.stringify(mergePrefs(before, patch.notificationPrefs));
      if (after !== JSON.stringify(before)) set('notification_prefs_json', after);
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== 'boolean') throw badRequest('"archived" must be true or false. Send true to archive or false to restore.', { field: 'archived' }, 'invalid_archived');
      if (patch.archived !== (row.archived_at !== null)) { set('archived_at', patch.archived ? nowIso() : null); registryAffected = true; }
    }
    if (sets.length === 0) return build(row);

    set('updated_at', nowIso());
    db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

    if (registryAffected) invalidateRegistry();
    emitProject(id);
    if (registryAffected) fireRootsChanged();
    return build(requireRow(id));
  }

  function deleteProject(id: string): void {
    requireRow(id);
    let sessionKeys: string[] = [];
    // One transaction: either everything attached to the project goes, or nothing does. Several of these tables only
    // reference the project with ON DELETE SET NULL (or not at all), so they are removed explicitly.
    db.tx(() => {
      db.run('DELETE FROM deliveries WHERE project_id = ?', [id]); // delivery_events cascade
      db.run('DELETE FROM reports WHERE project_id = ?', [id]); // any remaining deliveries of these reports cascade
      db.run('DELETE FROM report_candidates WHERE project_id = ?', [id]);
      db.run('DELETE FROM activity WHERE project_id = ?', [id]);
      db.run('DELETE FROM notifications WHERE project_id = ?', [id]);
      db.run('DELETE FROM pending_actions WHERE project_id = ?', [id]);
      db.run('DELETE FROM session_bindings WHERE project_id = ?', [id]);
      db.run('DELETE FROM managed_sessions WHERE project_id = ?', [id]);
      sessionKeys = db.all<{ session_key: string }>('SELECT session_key FROM sessions_projection WHERE project_id = ?', [id]).map((r) => r.session_key);
      db.run('DELETE FROM sessions_projection WHERE project_id = ?', [id]);
      db.run('DELETE FROM projects WHERE id = ?', [id]); // project_roots and conversations cascade
    });

    invalidateRegistry();
    for (const key of sessionKeys) bus.emit({ type: 'session.removed', key: key as SessionKey });
    bus.emit({ type: 'project.removed', id });
    fireRootsChanged();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Conversations

  function parseUrl(raw: string): ChatGptUrlInfo {
    const r = parseChatGptUrl(raw);
    if (!r.ok) throw badRequest(r.message, { reason: r.reason }, 'invalid_conversation_url');
    return r.info;
  }

  function assertUrlFree(projectId: string, url: string, exceptId: string | null): void {
    const dup = db.get<{ id: string; title: string }>(
      'SELECT id, title FROM conversations WHERE project_id = ? AND url = ? AND id <> ?',
      [projectId, url, exceptId ?? ''],
    );
    if (dup) {
      throw conflict(
        `This conversation is already in the project as "${dup.title}". Use that one, or remove it first.`,
        'conversation_exists',
        { conversationId: dup.id },
      );
    }
  }

  const cleanTitle = (v: unknown): string | null => cleanText(v, 200, 'conversation title');

  const conversations: ProjectsService['conversations'] = {
    list(projectId) {
      return db.all<ConversationRow>('SELECT * FROM conversations WHERE project_id = ? ORDER BY position, created_at, id', [projectId]).map(conversationOf);
    },

    get(id) {
      const row = conversationRow(id);
      return row ? conversationOf(row) : null;
    },

    require(id) {
      return conversationOf(requireConversationRow(id));
    },

    add(projectId, input) {
      const project = requireRow(projectId);
      const info = parseUrl(input.url);
      const title = cleanTitle(input.title) ?? suggestConversationTitle(info);
      const note = cleanText(input.note, 1000, 'note');
      const id = newId('cnv');
      const at = nowIso();
      let preferenceChanged = false;

      db.tx(() => {
        assertUrlFree(projectId, info.url, null);
        const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?', [projectId])?.n ?? 0;
        const position = (db.get<{ n: number | null }>('SELECT MAX(position) AS n FROM conversations WHERE project_id = ?', [projectId])?.n ?? -1) + 1;
        db.run(
          `INSERT INTO conversations (id, project_id, title, url, original_url, kind, chatgpt_conversation_id, verification,
                                      verified_at, verified_title, note, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', NULL, NULL, ?, ?, ?, ?)`,
          [id, projectId, title, info.url, info.originalUrl, info.kind, info.chatgptConversationId, note, position, at, at],
        );
        // The first conversation of a project is its preferred one; later ones only when asked.
        if ((input.makePreferred === true || count === 0) && project.preferred_conversation_id !== id) {
          db.run('UPDATE projects SET preferred_conversation_id = ?, updated_at = ? WHERE id = ?', [id, at, projectId]);
          preferenceChanged = true;
        }
      });

      emitConversation(conversationOf(requireConversationRow(id)));
      if (preferenceChanged) emitProject(projectId);
      return conversationOf(requireConversationRow(id));
    },

    update(id, patch) {
      const row = requireConversationRow(id);
      const sets: string[] = [];
      const params: SqlValue[] = [];
      const set = (col: string, v: SqlValue): void => { sets.push(`${col} = ?`); params.push(v); };
      let kind = row.kind;
      let conversationUuid = row.chatgpt_conversation_id;
      let titleFromUrlChange: string | null = null;

      if (patch.url !== undefined) {
        const info = parseUrl(patch.url);
        if (info.url !== row.url) {
          assertUrlFree(row.project_id, info.url, row.id);
          // A title that was only the automatic suggestion for the old address would be wrong for the new one.
          const oldSuggestion = suggestConversationTitle({ kind: row.kind as ChatGptUrlInfo['kind'], chatgptConversationId: row.chatgpt_conversation_id });
          if (row.title === oldSuggestion) titleFromUrlChange = suggestConversationTitle(info);
          set('url', info.url);
          set('original_url', info.originalUrl);
          set('kind', info.kind);
          set('chatgpt_conversation_id', info.chatgptConversationId);
          // The old check says nothing about the new address.
          set('verification', 'unverified');
          set('verified_at', null);
          set('verified_title', null);
          kind = info.kind;
          conversationUuid = info.chatgptConversationId;
        }
      }
      if (patch.title !== undefined) {
        const t = cleanTitle(patch.title) ?? suggestConversationTitle({ kind: kind as ChatGptUrlInfo['kind'], chatgptConversationId: conversationUuid });
        if (t !== row.title) set('title', t);
      } else if (titleFromUrlChange !== null) set('title', titleFromUrlChange);
      if (patch.note !== undefined) {
        const n = cleanText(patch.note, 1000, 'note');
        if (n !== row.note) set('note', n);
      }
      if (sets.length === 0) return conversationOf(row);

      set('updated_at', nowIso());
      db.run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      const updated = conversationOf(requireConversationRow(id));
      emitConversation(updated);
      return updated;
    },

    remove(id) {
      const row = requireConversationRow(id);
      let preferenceCleared = false;
      db.tx(() => {
        db.run('DELETE FROM conversations WHERE id = ?', [id]);
        // Never pick another conversation on the user's behalf: with no preferred one, routing says so plainly.
        const cleared = db.run('UPDATE projects SET preferred_conversation_id = NULL, updated_at = ? WHERE id = ? AND preferred_conversation_id = ?', [nowIso(), row.project_id, id]);
        preferenceCleared = cleared.changes > 0;
      });
      bus.emit({ type: 'conversation.removed', id, projectId: row.project_id });
      if (preferenceCleared) emitProject(row.project_id);
    },

    setPreferred(projectId, conversationId) {
      const project = requireRow(projectId);
      if (conversationId !== null) {
        const c = requireConversationRow(conversationId);
        if (c.project_id !== projectId) throw badRequest('That conversation belongs to another project. Choose one of this project\'s conversations.', undefined, 'conversation_wrong_project');
      }
      if (project.preferred_conversation_id === conversationId) return build(project);
      db.run('UPDATE projects SET preferred_conversation_id = ?, updated_at = ? WHERE id = ?', [conversationId, nowIso(), projectId]);
      emitProject(projectId);
      return build(requireRow(projectId));
    },

    setVerification(id, result) {
      requireConversationRow(id);
      if (!VERIFICATIONS.includes(result.verification)) {
        throw badRequest(`The verification result must be one of: ${VERIFICATIONS.join(', ')}.`, undefined, 'invalid_verification');
      }
      const at = nowIso();
      const checked = result.verification !== 'unverified';
      db.run(
        'UPDATE conversations SET verification = ?, verified_at = ?, verified_title = ?, updated_at = ? WHERE id = ?',
        [result.verification, checked ? at : null, checked ? cleanText(result.title, 300, 'page title') : null, at, id],
      );
      const updated = conversationOf(requireConversationRow(id));
      emitConversation(updated);
      return updated;
    },
  };

  // -------------------------------------------------------------------------------------------------------------

  return {
    list,
    get: (id) => { const row = projectRow(id); return row ? build(row) : null; },
    require: (id) => build(requireRow(id)),
    create,
    update,

    remove(id, mode) {
      if (mode === 'archive') { update(id, { archived: true }); return; }
      if (mode === 'delete') { deleteProject(id); return; }
      throw badRequest('Choose "archive" to hide the project and keep its history, or "delete" to remove it for good.', undefined, 'invalid_mode');
    },

    reorder(ids) {
      const rows = [...new Set(ids)].map(projectRow).filter((r): r is ProjectRow => r !== undefined);
      if (rows.length < 2) return;
      // The listed projects trade places among the sort positions they already hold, so projects that are not in the
      // list (archived ones, or created a moment ago) keep theirs.
      const slots = rows.map((r) => r.sort_order).sort((a, b) => a - b);
      for (let i = 1; i < slots.length; i++) slots[i] = Math.max(slots[i], slots[i - 1] + 1);
      const changed: string[] = [];
      const at = nowIso();
      db.tx(() => {
        rows.forEach((r, i) => {
          if (r.sort_order === slots[i]) return;
          db.run('UPDATE projects SET sort_order = ?, updated_at = ? WHERE id = ?', [slots[i], at, r.id]);
          changed.push(r.id);
        });
      });
      for (const id of changed) emitProject(id);
    },

    addRoot(projectId, input) {
      requireRow(projectId);
      const root = prepareRoot(input);
      db.tx(() => {
        assertRootFree(projectId, root.key);
        const position = (db.get<{ n: number | null }>('SELECT MAX(position) AS n FROM project_roots WHERE project_id = ?', [projectId])?.n ?? -1) + 1;
        insertRoot(projectId, root, position);
        db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [nowIso(), projectId]);
      });
      invalidateRegistry();
      emitProject(projectId);
      fireRootsChanged();
      return build(requireRow(projectId));
    },

    removeRoot(projectId, rootId) {
      requireRow(projectId);
      const root = db.get<RootRow>('SELECT * FROM project_roots WHERE id = ? AND project_id = ?', [rootId, projectId]);
      if (!root) throw new CoreError(404, 'not_found', 'That folder is not a root of this project. Reload the project and try again.');
      db.tx(() => {
        db.run('DELETE FROM project_roots WHERE id = ?', [rootId]);
        db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [nowIso(), projectId]);
      });
      invalidateRegistry();
      emitProject(projectId);
      fireRootsChanged();
      return build(requireRow(projectId));
    },

    setDefaultSession(projectId, key) {
      const row = requireRow(projectId);
      if (key !== null && !isSessionKey(key)) throw badRequest('That is not a session key. A session key looks like win|<session id>.', undefined, 'invalid_session_key');
      if (row.default_session_key === key) return build(row);
      db.run('UPDATE projects SET default_session_key = ?, updated_at = ? WHERE id = ?', [key, nowIso(), projectId]);
      emitProject(projectId);
      return build(requireRow(projectId));
    },

    conversations,

    registry(): ProjectRegistry {
      registryCache ??= createRegistry(registryFileContents(), { real: false });
      return registryCache;
    },

    registryFileContents,

    onRootsChanged(fn) {
      rootListeners.add(fn);
      return () => { rootListeners.delete(fn); };
    },
  };
}
