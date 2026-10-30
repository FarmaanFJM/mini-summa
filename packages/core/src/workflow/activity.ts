// ActivityService: the feed of moments a person might care about. Ids derive from the cause, so recording the same
// cause twice (a replay, a restart) is a no-op and emits nothing.
//
// Contract notes:
//  * Title must not be empty (400 invalid_activity). Em dashes in title and description are rewritten to " - " rather
//    than rejected, so a task title that contains one cannot make the glue lose the entry. The title is kept to one line.
//  * list: only `unread: true` and `requiresAction: true` filter; false and undefined mean "no filter". requiresAction
//    means "still needs action" (flagged and not resolved), the same definition counts().actionsNeeded uses.
//  * resolve touches only entries that are flagged and still open, and several selectors narrow each other (AND).
//    No selector at all resolves nothing.
//  * prune removes entries that are read and no longer need action (not flagged, or flagged and resolved).
import type { ActivityEvent, ActivitySeverity, ActivitySource, ActivityType, Counts, LinkTarget, ListPage, SessionKey } from '@minisumma/shared';
import type { SqlValue } from '@minisumma/storage';
import { bool, fromJson, int, toJson } from '@minisumma/storage';
import type { ActivityService, CoreBase } from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { badRequest } from '../errors.ts';
import { clampInt, noEmDashes, oneLine, placeholders } from './util.ts';

export interface ActivityServiceDeps {
  base: CoreBase;
  /** The counts this service cannot compute itself (pending actions, reports awaiting handoff, live sessions). */
  fullCounts: () => Counts;
}

interface ActivityRow {
  seq: number;
  id: string;
  at: string;
  project_id: string | null;
  project_name: string | null;
  source: ActivitySource;
  session_key: SessionKey | null;
  type: ActivityType;
  severity: ActivitySeverity;
  title: string;
  description: string | null;
  requires_action: number;
  resolved_at: string | null;
  links_json: string;
  read_at: string | null;
}

const STILL_OPEN = 'requires_action = 1 AND resolved_at IS NULL';

const LINK_MATCH = `EXISTS (SELECT 1 FROM json_each(activity.links_json) AS j
  WHERE json_extract(j.value, '$.kind') = ?
    AND COALESCE(json_extract(j.value, '$.id'), json_extract(j.value, '$.key'), json_extract(j.value, '$.section')) = ?)`;

const linkValue = (link: LinkTarget): string => (link.kind === 'session' ? link.key : link.kind === 'settings' ? link.section : link.id);

function toActivity(r: ActivityRow): ActivityEvent {
  return {
    id: r.id, at: r.at, projectId: r.project_id, projectName: r.project_name, source: r.source, sessionKey: r.session_key,
    type: r.type, severity: r.severity, title: r.title, description: r.description, requiresAction: bool(r.requires_action),
    resolvedAt: r.resolved_at, links: fromJson<LinkTarget[]>(r.links_json, []), read: r.read_at !== null,
  };
}

function cleanTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? oneLine(noEmDashes(raw)) : '';
  if (title === '') throw badRequest('An activity entry needs a title.', undefined, 'invalid_activity');
  return title;
}

function cleanDescription(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = noEmDashes(raw).trim();
  return text === '' ? null : text;
}

function parseSeq(cursor: string): number {
  if (!/^\d{1,15}$/.test(cursor)) throw badRequest('That page marker is not valid.', { before: cursor }, 'invalid_cursor');
  return Number(cursor);
}

export function createActivityService(deps: ActivityServiceDeps): ActivityService {
  const { db, bus, clock } = deps.base;

  function counts(): Pick<Counts, 'unreadActivity' | 'actionsNeeded'> {
    const r = db.get<{ unread: number; open: number }>(
      `SELECT (SELECT COUNT(*) FROM activity WHERE read_at IS NULL) AS unread,
              (SELECT COUNT(*) FROM activity WHERE ${STILL_OPEN}) AS open`,
    )!;
    return { unreadActivity: r.unread, actionsNeeded: r.open };
  }

  return {
    record(input) {
      if (typeof input.id !== 'string' || input.id.trim() === '') throw badRequest('An activity entry needs an id.', undefined, 'invalid_activity');
      const title = cleanTitle(input.title);
      const description = cleanDescription(input.description);
      const res = db.run(
        `INSERT OR IGNORE INTO activity (id, at, project_id, project_name, source, session_key, type, severity, title, description,
                                         requires_action, resolved_at, links_json, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        [input.id, input.at ?? nowIso(clock), input.projectId, input.projectName ?? null, input.source, input.sessionKey ?? null,
          input.type, input.severity, title, description, int(input.requiresAction ?? false), toJson(input.links ?? [])],
      );
      const created = res.changes === 1;
      const activity = toActivity(db.get<ActivityRow>('SELECT * FROM activity WHERE id = ?', [input.id])!);
      if (created) bus.emit({ type: 'activity.added', activity });
      return { activity, created };
    },

    get(id) {
      const row = db.get<ActivityRow>('SELECT * FROM activity WHERE id = ?', [id]);
      return row ? toActivity(row) : null;
    },

    resolve(match, at) {
      const where: string[] = [STILL_OPEN];
      const params: SqlValue[] = [];
      let selectors = 0;
      if (match.ids) {
        if (match.ids.length === 0) return 0;
        selectors++;
        where.push(`id IN (${placeholders(match.ids.length)})`);
        params.push(...match.ids);
      }
      if (match.sessionKey) { selectors++; where.push('session_key = ?'); params.push(match.sessionKey); }
      if (match.link) { selectors++; where.push(LINK_MATCH); params.push(match.link.kind, linkValue(match.link)); }
      if (selectors === 0) return 0;
      if (match.types) {
        if (match.types.length === 0) return 0;
        where.push(`type IN (${placeholders(match.types.length)})`);
        params.push(...match.types);
      }
      const rows = db.all<ActivityRow>(`UPDATE activity SET resolved_at = ? WHERE ${where.join(' AND ')} RETURNING *`, [at ?? nowIso(clock), ...params]);
      rows.sort((a, b) => a.seq - b.seq);
      for (const row of rows) bus.emit({ type: 'activity.updated', activity: toActivity(row) });
      return rows.length;
    },

    list(q): ListPage<ActivityEvent> {
      const limit = clampInt(q.limit, 1, 200, 50);
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
      if (q.type) { where.push('type = ?'); params.push(q.type); }
      if (q.unread === true) where.push('read_at IS NULL');
      if (q.requiresAction === true) where.push(STILL_OPEN);
      if (q.before !== undefined && q.before !== '') { where.push('seq < ?'); params.push(parseSeq(q.before)); }
      const rows = db.all<ActivityRow>(
        `SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`,
        [...params, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page.map(toActivity), nextBefore: rows.length > limit ? String(page[page.length - 1].seq) : null };
    },

    markRead(req) {
      const where: string[] = ['read_at IS NULL'];
      const params: SqlValue[] = [];
      if (!req.all) {
        let selectors = 0;
        if (req.ids) {
          if (req.ids.length === 0) return counts();
          selectors++;
          where.push(`id IN (${placeholders(req.ids.length)})`);
          params.push(...req.ids);
        }
        if (req.projectId) { selectors++; where.push('project_id = ?'); params.push(req.projectId); }
        if (selectors === 0) return counts();
      }
      const rows = db.all<{ id: string; seq: number }>(`UPDATE activity SET read_at = ? WHERE ${where.join(' AND ')} RETURNING id, seq`, [nowIso(clock), ...params]);
      const current = counts();
      if (rows.length > 0) {
        rows.sort((a, b) => a.seq - b.seq);
        bus.emit({ type: 'activity.read', ids: rows.map((r) => r.id), counts: { ...deps.fullCounts(), ...current } });
      }
      return current;
    },

    counts,

    prune(olderThanIso) {
      return db.run(`DELETE FROM activity WHERE read_at IS NOT NULL AND at < ? AND NOT (${STILL_OPEN})`, [olderThanIso]).changes;
    },
  };
}
