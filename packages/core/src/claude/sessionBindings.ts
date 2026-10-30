// session_bindings: which project (and optionally which ChatGPT conversation) a session belongs to.
//
// One row per session. source 'managed' rows are written by the managed-session manager when it starts a terminal; the
// Claude observer only ever writes 'manual' rows (the user attached an external or unregistered session to a project) and
// never touches a managed row. Attribution precedence everywhere: managed, then manual, then the registry match on cwd.
import type { SessionKey } from '@minisumma/shared';
import type { Db } from '@minisumma/storage';

export interface BindingRow {
  sessionKey: SessionKey;
  projectId: string | null;
  conversationId: string | null;
  source: 'managed' | 'manual';
}

interface Row { session_key: string; project_id: string | null; conversation_id: string | null; source: 'managed' | 'manual' }

const toBinding = (r: Row): BindingRow => ({ sessionKey: r.session_key as SessionKey, projectId: r.project_id, conversationId: r.conversation_id, source: r.source });

export function readBindings(db: Db): Map<string, BindingRow> {
  const map = new Map<string, BindingRow>();
  for (const r of db.all<Row>('SELECT session_key, project_id, conversation_id, source FROM session_bindings')) map.set(r.session_key, toBinding(r));
  return map;
}

export function bindingOf(db: Db, key: SessionKey): BindingRow | null {
  const r = db.get<Row>('SELECT session_key, project_id, conversation_id, source FROM session_bindings WHERE session_key = ?', [key]);
  return r ? toBinding(r) : null;
}

/** Attaches the session to a project. A managed row is never overwritten (the WHERE clause), and a chosen conversation is kept. */
export function setManualBinding(db: Db, key: SessionKey, projectId: string, at: string): void {
  db.run(
    `INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at)
     VALUES (?, ?, NULL, 'manual', ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at
     WHERE session_bindings.source = 'manual'`,
    [key, projectId, at, at],
  );
}

/** Removes the manual attribution. The row goes away unless it also carries a conversation choice. */
export function clearManualBinding(db: Db, key: SessionKey, at: string): void {
  db.tx(() => {
    db.run("UPDATE session_bindings SET project_id = NULL, updated_at = ? WHERE session_key = ? AND source = 'manual'", [at, key]);
    db.run("DELETE FROM session_bindings WHERE session_key = ? AND source = 'manual' AND conversation_id IS NULL", [key]);
  });
}

export function conversationOf(db: Db, key: SessionKey): string | null {
  return db.get<{ conversation_id: string | null }>('SELECT conversation_id FROM session_bindings WHERE session_key = ?', [key])?.conversation_id ?? null;
}
