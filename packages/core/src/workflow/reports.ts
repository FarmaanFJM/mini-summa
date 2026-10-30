// ReportsService: Claude's final messages, stored once and untouched.
//
// A report body is stored byte for byte (after the secret redaction done at capture; how many strings were replaced is
// kept in `redactions`/`truncations` and shown to the reader). Text containing NUL is stored as a BLOB because node:sqlite
// would cut a TEXT value there (see util.ts). Capturing the same report id again is a no-op that emits nothing.
//
// Contract notes:
//  * list: newest first by captured_at (ties by insertion order). The cursor `before` is "<capturedAt>|<rowid>", opaque
//    to callers. A promoted candidate keeps the capture time of the original message.
//  * excerpt: the body with whitespace collapsed to single spaces, trimmed, cut at 240 characters (never mid-pair).
//  * onCreated runs after the row is committed and the event is emitted. Its errors are logged, not thrown: the report
//    is stored either way, and DeliveriesService.onReportCaptured is idempotent so the glue can repair it later.
//  * promote: a candidate with no declared status becomes 'partial' (the schema needs one) and the note says so; a
//    candidate with no task title gets the first line of its text. Promoting twice returns the same report.
//  * prune keeps a report while any of its deliveries is open or was touched after the cutoff; it also drops candidates
//    older than the cutoff. The returned number counts reports only.
//  * listCandidates returns the newest 200.
import type { DeclaredStatus, DeliveryState, DeliverySummary, EnvId, Report, ReportCandidate, ReportSummary, ReviewState, SessionKey } from '@minisumma/shared';
import type { SqlValue } from '@minisumma/storage';
import { bool, fromJson, int } from '@minisumma/storage';
import type { CapturedCandidate, CapturedReport, CoreBase, ReportsService } from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { badRequest, notFound } from '../errors.ts';
import { clampInt, cutText, existingProjectId, firstLine, oneLine, packText, unpackText } from './util.ts';

export interface ReportsServiceDeps {
  base: CoreBase;
  /** Called once per newly created report (never for a repeat), after the row is stored and `report.upserted` emitted. */
  onCreated?: (report: ReportSummary, ctx: { via: 'capture' | 'promote' }) => void;
}

interface ReportRow {
  rid: number;
  id: string;
  session_key: SessionKey;
  env: EnvId;
  session_id: string;
  generation: number;
  project_id: string | null;
  project_name: string | null;
  prompt_id: string | null;
  task_id: string;
  task_title: string;
  declared_status: DeclaredStatus;
  source: 'marker' | 'user_promoted';
  body: string | Uint8Array;
  body_sha256: string;
  cwd: string | null;
  late: number;
  stop_hook_active: number;
  captured_seq: number | null;
  note: string;
  captured_at: string;
  read_at: string | null;
  redactions: number;
  truncations: number;
}

interface CandidateRow {
  id: string;
  session_key: SessionKey;
  env: EnvId;
  session_id: string;
  generation: number;
  project_id: string | null;
  project_name: string | null;
  prompt_id: string | null;
  reason: string;
  declared_status: DeclaredStatus | null;
  task_title: string | null;
  body: string | Uint8Array;
  body_sha256: string;
  late: number;
  captured_at: string;
  promoted_report_id: string | null;
  redactions: number;
  truncations: number;
}

interface DeliverySummaryRow {
  id: string;
  state: DeliveryState;
  review: ReviewState;
  destination_json: string | null;
  updated_at: string;
}

const EXCERPT_CHARS = 240;
const DECLARATION_NOTE = 'The status is a declaration by Claude, not evidence that the work was done or tested.';

export function makeExcerpt(body: string, max = EXCERPT_CHARS): string {
  return cutText(oneLine(body), max);
}

/** Keeps whatever the capture said and makes sure the reader is told the status is only a declaration. */
function composeNote(stored: string): string {
  const note = stored.trim();
  if (/declaration/i.test(note)) return note;
  return note === '' ? DECLARATION_NOTE : `${note} ${DECLARATION_NOTE}`;
}

const count = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

function parseCursor(cursor: string): { at: string; rid: number } {
  const i = cursor.lastIndexOf('|');
  const rid = cursor.slice(i + 1);
  if (i <= 0 || !/^\d{1,15}$/.test(rid)) throw badRequest('That page marker is not valid.', { before: cursor }, 'invalid_cursor');
  return { at: cursor.slice(0, i), rid: Number(rid) };
}

function titleFromBody(body: string): string {
  const line = firstLine(body.replace(/^[\s#>*-]+/, ''), 80);
  return line === '' ? 'Final message promoted to a report' : line;
}

export function createReportsService(deps: ReportsServiceDeps): ReportsService {
  const { db, bus, clock, log } = deps.base;

  function deliveriesOf(reportId: string): DeliverySummary[] {
    return db.all<DeliverySummaryRow>(
      'SELECT id, state, review, destination_json, updated_at FROM deliveries WHERE report_id = ? ORDER BY created_at ASC, rowid ASC',
      [reportId],
    ).map((d) => ({
      id: d.id, state: d.state, review: d.review, updatedAt: d.updated_at,
      destinationTitle: fromJson<{ title?: string } | null>(d.destination_json, null)?.title ?? null,
    }));
  }

  function toSummary(r: ReportRow, body: string, deliveries: DeliverySummary[]): ReportSummary {
    return {
      id: r.id, projectId: r.project_id, projectName: r.project_name, sessionKey: r.session_key, env: r.env, sessionId: r.session_id,
      generation: r.generation, taskTitle: r.task_title, declaredStatus: r.declared_status, source: r.source, capturedAt: r.captured_at,
      late: bool(r.late), read: r.read_at !== null, chars: body.length, excerpt: makeExcerpt(body), delivery: deliveries[deliveries.length - 1] ?? null,
    };
  }

  const rowOf = (id: string): ReportRow | undefined => db.get<ReportRow>('SELECT rowid AS rid, * FROM reports WHERE id = ?', [id]);

  function summary(id: string): ReportSummary | null {
    const row = rowOf(id);
    return row ? toSummary(row, unpackText(row.body), deliveriesOf(id)) : null;
  }

  function get(id: string): Report | null {
    const row = rowOf(id);
    if (!row) return null;
    const body = unpackText(row.body);
    const deliveries = deliveriesOf(id);
    return {
      ...toSummary(row, body, deliveries),
      promptId: row.prompt_id, taskId: row.task_id, cwd: row.cwd, body, bodySha256: row.body_sha256,
      stopHookActive: bool(row.stop_hook_active), verified: false, note: composeNote(row.note), redactions: row.redactions, deliveries,
    };
  }

  function announce(report: ReportSummary, via: 'capture' | 'promote'): void {
    bus.emit({ type: 'report.upserted', report });
    try {
      deps.onCreated?.(report, { via });
    } catch (err) {
      log.error('a report was stored but the follow-up step failed', { report: report.id, via, error: String(err) });
    }
  }

  function toCandidate(r: CandidateRow): ReportCandidate {
    return {
      id: r.id, projectId: r.project_id, projectName: r.project_name, sessionKey: r.session_key, env: r.env, sessionId: r.session_id,
      generation: r.generation, promptId: r.prompt_id, reason: r.reason, declaredStatus: r.declared_status, taskTitle: r.task_title,
      body: unpackText(r.body), bodySha256: r.body_sha256, capturedAt: r.captured_at, late: bool(r.late),
      promoted: r.promoted_report_id !== null, redactions: r.redactions,
    };
  }

  return {
    capture(r) {
      const res = db.run(
        `INSERT OR IGNORE INTO reports (id, session_key, env, session_id, generation, project_id, project_name, prompt_id, task_id, task_title,
                                        declared_status, source, body, body_sha256, cwd, late, stop_hook_active, captured_seq, note,
                                        captured_at, read_at, redactions, truncations)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'marker', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [r.reportId, r.sessionKey, r.env, r.sessionId, r.generation, existingProjectId(db, r.projectId), r.projectName, r.promptId, r.taskId,
          r.taskTitle, r.declaredStatus, packText(r.body), r.bodySha256, r.cwd, int(r.late), int(r.stopHookActive), r.capturedSeq, r.note,
          r.capturedAt, count(r.redactions), count(r.truncations)],
      );
      const created = res.changes === 1;
      const report = summary(r.reportId)!;
      if (created) announce(report, 'capture');
      return { report, created };
    },

    captureCandidate(c) {
      const res = db.run(
        `INSERT OR IGNORE INTO report_candidates (id, session_key, env, session_id, generation, project_id, project_name, prompt_id, reason,
                                                  declared_status, task_title, body, body_sha256, late, captured_at, promoted_report_id,
                                                  promoted_at, redactions, truncations)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [c.candidateId, c.sessionKey, c.env, c.sessionId, c.generation, existingProjectId(db, c.projectId), c.projectName, c.promptId, c.reason,
          c.declaredStatus, c.taskTitle, packText(c.body), c.bodySha256, int(c.late), c.capturedAt, count(c.redactions), count(c.truncations)],
      );
      return { created: res.changes === 1 };
    },

    list(q) {
      const limit = clampInt(q.limit, 1, 200, 50);
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
      if (q.unread === true) where.push('read_at IS NULL');
      if (q.before !== undefined && q.before !== '') {
        const cursor = parseCursor(q.before);
        where.push('(captured_at < ? OR (captured_at = ? AND rowid < ?))');
        params.push(cursor.at, cursor.at, cursor.rid);
      }
      const rows = db.all<ReportRow>(
        `SELECT rowid AS rid, * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY captured_at DESC, rowid DESC LIMIT ?`,
        [...params, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => toSummary(row, unpackText(row.body), deliveriesOf(row.id))),
        nextBefore: rows.length > limit ? `${last.captured_at}|${last.rid}` : null,
      };
    },

    get,

    require(id) {
      const report = get(id);
      if (!report) throw notFound('Report');
      return report;
    },

    summary,

    markRead(id) {
      const res = db.run('UPDATE reports SET read_at = ? WHERE id = ? AND read_at IS NULL', [nowIso(clock), id]);
      const report = summary(id);
      if (!report) throw notFound('Report');
      if (res.changes === 1) bus.emit({ type: 'report.upserted', report });
      return report;
    },

    listCandidates(q) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
      if (!q.includePromoted) where.push('promoted_report_id IS NULL');
      return db.all<CandidateRow>(
        `SELECT * FROM report_candidates ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY captured_at DESC, rowid DESC LIMIT 200`,
        params,
      ).map(toCandidate);
    },

    promote(candidateId) {
      const cand = db.get<CandidateRow>('SELECT * FROM report_candidates WHERE id = ?', [candidateId]);
      if (!cand) throw notFound('Report candidate');
      const body = unpackText(cand.body);
      const note = [
        `Promoted by you from a final message that did not follow the report protocol (${cand.reason}).`,
        cand.declared_status === null ? 'Claude declared no status, so "partial" stands in for it.' : '',
        DECLARATION_NOTE,
      ].filter((s) => s !== '').join(' ');
      let created = false;
      db.tx(() => {
        const res = db.run(
          `INSERT OR IGNORE INTO reports (id, session_key, env, session_id, generation, project_id, project_name, prompt_id, task_id, task_title,
                                          declared_status, source, body, body_sha256, cwd, late, stop_hook_active, captured_seq, note,
                                          captured_at, read_at, redactions, truncations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_promoted', ?, ?, NULL, ?, 0, NULL, ?, ?, NULL, ?, ?)`,
          [candidateId, cand.session_key, cand.env, cand.session_id, cand.generation, existingProjectId(db, cand.project_id), cand.project_name,
            cand.prompt_id, candidateId, cand.task_title?.trim() || titleFromBody(body), cand.declared_status ?? 'partial', packText(body),
            cand.body_sha256, cand.late, note, cand.captured_at, cand.redactions, cand.truncations],
        );
        created = res.changes === 1;
        db.run('UPDATE report_candidates SET promoted_report_id = ?, promoted_at = COALESCE(promoted_at, ?) WHERE id = ?', [candidateId, nowIso(clock), candidateId]);
      });
      // Events and onCreated get the summary only; the full body never rides on the bus.
      if (created) announce(summary(candidateId)!, 'promote');
      return get(candidateId)!;
    },

    prune(olderThanIso) {
      return db.tx(() => {
        const removed = db.run(
          `DELETE FROM reports WHERE captured_at < ?
             AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.report_id = reports.id
                               AND (d.state NOT IN ('user_confirmed_sent', 'user_discarded') OR d.updated_at >= ?))`,
          [olderThanIso, olderThanIso],
        ).changes;
        db.run('DELETE FROM report_candidates WHERE captured_at < ?', [olderThanIso]);
        return removed;
      });
    },
  };
}
