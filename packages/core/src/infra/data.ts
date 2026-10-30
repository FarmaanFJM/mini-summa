// DataService: what the database holds, and retention (`settings.retention`, 0 = keep).
//
// What prune may delete, and what it never touches:
//   raw_events      older than rawEventsDays, by ingested_at.
//   activity        older than activityDays, but only read items that no longer need the user (an item that requires
//                   action stays until it is resolved, an unread item stays until it is read).
//   notifications   older than notificationsDays.
//   reports         captured before the cutoff (reportsDays) AND with no delivery that is still open (the user has
//                   something left to do) or was touched after the cutoff. Their deliveries go with them (FK cascade).
// Anything newer than a cutoff is never deleted. A dry run counts with the same predicates and deletes nothing.
//
// The workflow services own caches of their tables, so when they are handed in (`activity`, `notifications`,
// `reports`, `deliveries`) their prune(olderThanIso) does the deleting; their rules must match the ones above. A dry
// run always counts with SQL because those hooks have no dry-run mode. Without a hook the SQL here deletes directly.
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

/** Reports that may be pruned: old enough, and every delivery of theirs is closed and not touched since the cutoff. */
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
        removed.deliveries = count(`FROM deliveries WHERE report_id IN (SELECT r.id ${PRUNABLE_REPORTS})`, [at, at]);
      } else {
        // The number of deliveries that disappeared is measured, not predicted: a hook may remove some on its own and
        // the rest go with their report.
        const deliveriesBefore = count('FROM deliveries');
        if (deps.deliveries) deps.deliveries.prune(at);
        if (deps.reports) removed.reports = deps.reports.prune(at);
        else removed.reports = db.run(`DELETE FROM reports WHERE id IN (SELECT r.id ${PRUNABLE_REPORTS})`, [at, at]).changes;
        removed.deliveries = Math.max(0, deliveriesBefore - count('FROM deliveries'));
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
