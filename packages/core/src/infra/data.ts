// DataService: what the database holds, and retention (`settings.retention`, 0 = keep).
//
// What prune may delete, and what it never touches:
//   raw_events      older than rawEventsDays, by ingested_at.
//   activity        older than activityDays, but only read items that no longer need the user (an item that requires
//                   action stays until it is resolved, an unread item stays until it is read).
//   notifications   older than notificationsDays.
//   deliveries      closed ones (confirmed sent, or discarded) not touched since the reportsDays cutoff. A delivery that
//                   is still open, or was touched after the cutoff, is never deleted.
//   reports         captured before the reportsDays cutoff AND with no delivery that is open or was touched after it.
//                   Because deliveries are pruned first, "all its deliveries are closed and old" is what lets a report go.
//                   Report candidates (final messages that missed the report protocol) older than the cutoff go with
//                   them. Candidates are not part of the returned counts.
// Anything newer than a cutoff is never deleted. A dry run counts with the same predicates and deletes nothing.
//
// The workflow services own caches of their tables, so when they are handed in (`activity`, `notifications`,
// `reports`, `deliveries`) their prune(olderThanIso) does the deleting, deliveries before reports. Their rules are the
// ones above, and the SQL here is the same rule for when a service is not handed in. A dry run always counts with SQL
// because those hooks have no dry-run mode.
import type { DataUsage } from '@minisumma/shared';
import type { CoreBase, DataService, SettingsService } from '../contracts.ts';

export interface PruneTarget { prune(olderThanIso: string): number }

export interface DataDeps {
  base: Pick<CoreBase, 'db' | 'dataDir' | 'clock' | 'log'>;
  settings: Pick<SettingsService, 'get'>;
  activity?: PruneTarget;
  notifications?: PruneTarget;
  reports?: PruneTarget;
  deliveries?: PruneTarget;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Delivery states in which the user has nothing left to do. Every other state counts as open. */
const CLOSED_DELIVERY_STATES = "('user_confirmed_sent', 'user_discarded')";

/** Deliveries that may be pruned: closed, and not touched since the cutoff. */
const PRUNABLE_DELIVERIES = `FROM deliveries WHERE state IN ${CLOSED_DELIVERY_STATES} AND updated_at < ?`;

/** Reports that may be pruned: old enough, and no delivery of theirs is open or was touched since the cutoff. */
const PRUNABLE_REPORTS = `
  FROM reports r
  WHERE r.captured_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM deliveries d
      WHERE d.report_id = r.id AND (d.state NOT IN ${CLOSED_DELIVERY_STATES} OR d.updated_at >= ?)
    )`;

const PRUNABLE_ACTIVITY = 'FROM activity WHERE at < ? AND read_at IS NOT NULL AND (requires_action = 0 OR resolved_at IS NOT NULL)';

export function createDataService(deps: DataDeps): DataService {
  const { db, dataDir, clock, log } = deps.base;

  const count = (sql: string, params: (string | number)[] = []): number => db.get<{ n: number }>(`SELECT COUNT(*) AS n ${sql}`, params)?.n ?? 0;
  const cutoff = (days: number): string => new Date(clock.now().getTime() - days * DAY_MS).toISOString();

  function usage(): DataUsage {
    return {
      dataDir,
      databaseBytes: db.fileBytes(),
      rawEvents: count('FROM raw_events'),
      activity: count('FROM activity'),
      reports: count('FROM reports'),
      deliveries: count('FROM deliveries'),
      notifications: count('FROM notifications'),
      oldestRawEventAt: db.get<{ t: string | null }>('SELECT MIN(ingested_at) AS t FROM raw_events')?.t ?? null,
    };
  }

  function prune(opts: { dryRun?: boolean }) {
    const dryRun = opts?.dryRun === true;
    const r = deps.settings.get().retention;
    const removed = { rawEvents: 0, activity: 0, notifications: 0, reports: 0, deliveries: 0 };

    if (r.rawEventsDays > 0) {
      const at = cutoff(r.rawEventsDays);
      removed.rawEvents = dryRun
        ? count('FROM raw_events WHERE ingested_at < ?', [at])
        : db.run('DELETE FROM raw_events WHERE ingested_at < ?', [at]).changes;
    }

    if (r.activityDays > 0) {
      const at = cutoff(r.activityDays);
      if (dryRun) removed.activity = count(PRUNABLE_ACTIVITY, [at]);
      else if (deps.activity) removed.activity = deps.activity.prune(at);
      else removed.activity = db.run(`DELETE ${PRUNABLE_ACTIVITY}`, [at]).changes;
    }

    if (r.notificationsDays > 0) {
      const at = cutoff(r.notificationsDays);
      if (dryRun) removed.notifications = count('FROM notifications WHERE at < ?', [at]);
      else if (deps.notifications) removed.notifications = deps.notifications.prune(at);
      else removed.notifications = db.run('DELETE FROM notifications WHERE at < ?', [at]).changes;
    }

    if (r.reportsDays > 0) {
      const at = cutoff(r.reportsDays);
      if (dryRun) {
        removed.reports = count(PRUNABLE_REPORTS, [at, at]);
        // A report only goes when all its deliveries are closed and old, which the first step already removed, so the
        // deliveries of pruned reports add nothing to the closed-and-old ones counted here.
        removed.deliveries = count(PRUNABLE_DELIVERIES, [at]);
      } else {
        // One unit: closed deliveries first, then the reports that nothing holds any more. The number of deliveries
        // that disappeared is measured, not predicted, so it is right whichever side did the deleting.
        db.tx(() => {
          const deliveriesBefore = count('FROM deliveries');
          if (deps.deliveries) deps.deliveries.prune(at);
          else db.run(`DELETE ${PRUNABLE_DELIVERIES}`, [at]);
          if (deps.reports) removed.reports = deps.reports.prune(at);
          else {
            removed.reports = db.run(`DELETE FROM reports WHERE id IN (SELECT r.id ${PRUNABLE_REPORTS})`, [at, at]).changes;
            db.run('DELETE FROM report_candidates WHERE captured_at < ?', [at]);
          }
          removed.deliveries = Math.max(0, deliveriesBefore - count('FROM deliveries'));
        });
      }
    }

    if (!dryRun) {
      const total = removed.rawEvents + removed.activity + removed.notifications + removed.reports + removed.deliveries;
      if (total > 0) {
        log.info('Retention cleanup removed old records.', removed);
        // Give the write-ahead log back to the file system; freed pages inside the database are reused by new rows.
        try { db.checkpoint(); } catch (err) { log.debug('Checkpoint after cleanup was skipped.', { error: err instanceof Error ? err.message : String(err) }); }
      }
    }
    return { dryRun, removed };
  }

  return { usage, prune };
}
