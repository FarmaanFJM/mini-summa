import fs from 'node:fs';
import path from 'node:path';
import type { RetentionSettings } from '@minisumma/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataService } from '../../src/infra/data.ts';
import type { DataDeps } from '../../src/infra/data.ts';
import { createSettingsService } from '../../src/infra/settings.ts';
import { cleanupTempDirs, makeBase, tempDir } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';

let base: TestBase;
afterEach(() => { base?.close(); cleanupTempDirs(); });

const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(base.clock.now().getTime() - n * DAY).toISOString();

function setup(retention: Partial<RetentionSettings> = {}, hooks: Partial<Pick<DataDeps, 'activity' | 'notifications' | 'reports' | 'deliveries'>> = {}, file?: string) {
  base = makeBase({ dataDir: '/data/mini-summa', file });
  const settings = createSettingsService({ base });
  settings.update({ retention: { rawEventsDays: 0, activityDays: 0, notificationsDays: 0, reportsDays: 0, ...retention } });
  const data = createDataService({ base, settings, ...hooks });
  return { data, settings };
}

let counter = 0;
const next = (): string => `${++counter}`;

const addRaw = (at: string): void => {
  base.db.run("INSERT INTO raw_events (transport_id, kind, env_id, ingested_at, entry_json) VALUES (?, 'hook', 'win', ?, '{}')", [`t${next()}`, at]);
};
const addActivity = (id: string, at: string, o: { read?: boolean; requiresAction?: boolean; resolved?: boolean } = {}): void => {
  base.db.run(
    `INSERT INTO activity (id, at, source, type, severity, title, requires_action, resolved_at, read_at) VALUES (?, ?, 'claude', 'report_ready', 'info', 'x', ?, ?, ?)`,
    [id, at, o.requiresAction ? 1 : 0, o.resolved ? at : null, o.read === false ? null : at],
  );
};
const addNotification = (id: string, at: string, read = false): void => {
  base.db.run(
    "INSERT INTO notifications (id, activity_id, at, title, body, native, push, read_at, target_json, dedupe_key) VALUES (?, 'act', ?, 't', 'b', 'sent', 'sent', ?, '{}', ?)",
    [id, at, read ? at : null, `k-${id}`],
  );
};
const addReport = (id: string, capturedAt: string): void => {
  base.db.run(
    `INSERT INTO reports (id, session_key, env, session_id, generation, task_id, task_title, declared_status, source, body, body_sha256, note, captured_at)
     VALUES (?, 'win|s', 'win', 's', 1, 't', 'T', 'complete', 'marker', 'body', 'sha', 'n', ?)`,
    [id, capturedAt],
  );
};
const addDelivery = (id: string, reportId: string, state: string, updatedAt: string): void => {
  base.db.run(
    `INSERT INTO deliveries (id, report_id, session_key, task_title, state, state_changed_at, created_at, updated_at) VALUES (?, ?, 'win|s', 'T', ?, ?, ?, ?)`,
    [id, reportId, state, updatedAt, updatedAt, updatedAt],
  );
  base.db.run("INSERT INTO delivery_events (id, delivery_id, at, type, actor_json) VALUES (?, ?, ?, 'created', '{}')", [`ev-${id}`, id, updatedAt]);
};
const ids = (table: string, col = 'id'): string[] => base.db.all<Record<string, string>>(`SELECT ${col} AS v FROM ${table} ORDER BY ${col}`).map((r) => r.v);

describe('usage', () => {
  it('reports an empty database as zeros', () => {
    const { data } = setup();
    expect(data.usage()).toEqual({ dataDir: '/data/mini-summa', databaseBytes: 0, rawEvents: 0, activity: 0, reports: 0, deliveries: 0, notifications: 0, oldestRawEventAt: null });
  });

  it('counts each kind of record and finds the oldest raw event', () => {
    const { data } = setup();
    addRaw(daysAgo(3)); addRaw(daysAgo(40)); addRaw(daysAgo(10));
    addActivity('a1', daysAgo(1)); addActivity('a2', daysAgo(2));
    addNotification('n1', daysAgo(1));
    addReport('r1', daysAgo(5)); addReport('r2', daysAgo(6));
    addDelivery('d1', 'r1', 'copied', daysAgo(5)); addDelivery('d2', 'r1', 'user_discarded', daysAgo(5)); addDelivery('d3', 'r2', 'ready_for_handoff', daysAgo(6));
    expect(data.usage()).toMatchObject({ rawEvents: 3, activity: 2, notifications: 1, reports: 2, deliveries: 3, oldestRawEventAt: daysAgo(40) });
  });

  it('reports the size of the database file on disk', () => {
    const file = path.join(tempDir(), 'mini-summa.db');
    const { data } = setup({}, {}, file);
    addRaw(daysAgo(1));
    base.db.checkpoint();
    const bytes = data.usage().databaseBytes;
    expect(bytes).toBeGreaterThan(4096);
    expect(bytes).toBe(fs.statSync(file).size);
  });
});

describe('prune: what is deleted', () => {
  it('keeps everything when every retention is 0 (the default for reports), however old', () => {
    const { data } = setup();
    addRaw(daysAgo(5000)); addActivity('a', daysAgo(5000)); addNotification('n', daysAgo(5000)); addReport('r', daysAgo(5000)); addDelivery('d', 'r', 'user_discarded', daysAgo(5000));
    const result = data.prune({});
    expect(result).toEqual({ dryRun: false, removed: { rawEvents: 0, activity: 0, notifications: 0, reports: 0, deliveries: 0 } });
    expect(data.usage()).toMatchObject({ rawEvents: 1, activity: 1, notifications: 1, reports: 1, deliveries: 1 });
  });

  it('removes raw events older than the cutoff and keeps the one exactly at it and everything newer', () => {
    const { data } = setup({ rawEventsDays: 90 });
    addRaw(daysAgo(200));
    addRaw(new Date(Date.parse(daysAgo(90)) - 1).toISOString());
    addRaw(daysAgo(90));
    addRaw(daysAgo(89));
    addRaw(daysAgo(0));
    expect(data.prune({}).removed.rawEvents).toBe(2);
    expect(base.db.all<{ ingested_at: string }>('SELECT ingested_at FROM raw_events ORDER BY ingested_at').map((r) => r.ingested_at)).toEqual([daysAgo(90), daysAgo(89), daysAgo(0)]);
    expect(data.usage().oldestRawEventAt).toBe(daysAgo(90));
  });

  it('removes old activity only when it was read and no longer needs the user', () => {
    const { data } = setup({ activityDays: 180 });
    addActivity('old-read', daysAgo(300), { read: true });
    addActivity('old-read-resolved-action', daysAgo(300), { read: true, requiresAction: true, resolved: true });
    addActivity('old-unread', daysAgo(300), { read: false });
    addActivity('old-read-needs-action', daysAgo(300), { read: true, requiresAction: true });
    addActivity('old-unread-needs-action', daysAgo(300), { read: false, requiresAction: true });
    addActivity('old-unread-resolved', daysAgo(300), { read: false, requiresAction: true, resolved: true });
    addActivity('recent-read', daysAgo(179), { read: true });
    expect(data.prune({}).removed.activity).toBe(2);
    expect(ids('activity')).toEqual(['old-read-needs-action', 'old-unread', 'old-unread-needs-action', 'old-unread-resolved', 'recent-read']);
  });

  it('removes old notifications whether or not they were read', () => {
    const { data } = setup({ notificationsDays: 30 });
    addNotification('old-read', daysAgo(31), true); addNotification('old-unread', daysAgo(31), false);
    addNotification('new-read', daysAgo(29), true); addNotification('new-unread', daysAgo(1), false);
    expect(data.prune({}).removed.notifications).toBe(2);
    expect(ids('notifications')).toEqual(['new-read', 'new-unread']);
  });

  describe('reports and their deliveries', () => {
    it('removes an old report together with its deliveries and their events', () => {
      const { data } = setup({ reportsDays: 60 });
      addReport('old', daysAgo(100));
      addDelivery('d-sent', 'old', 'user_confirmed_sent', daysAgo(90));
      addDelivery('d-discarded', 'old', 'user_discarded', daysAgo(90));
      addReport('new', daysAgo(10));
      addDelivery('d-new', 'new', 'user_confirmed_sent', daysAgo(10));
      expect(data.prune({}).removed).toEqual({ rawEvents: 0, activity: 0, notifications: 0, reports: 1, deliveries: 2 });
      expect(ids('reports')).toEqual(['new']);
      expect(ids('deliveries')).toEqual(['d-new']);
      expect(ids('delivery_events')).toEqual(['ev-d-new']);
    });

    it('removes an old report that never had a delivery', () => {
      const { data } = setup({ reportsDays: 60 });
      addReport('lonely', daysAgo(100));
      expect(data.prune({}).removed).toMatchObject({ reports: 1, deliveries: 0 });
    });

    it('keeps an old report while any of its deliveries is open, whatever open state it is in', () => {
      const open = ['report_captured', 'destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain'];
      const { data } = setup({ reportsDays: 60 });
      for (const state of open) { addReport(`r-${state}`, daysAgo(100)); addDelivery(`d-${state}`, `r-${state}`, state, daysAgo(100)); }
      // one closed delivery next to an open one does not release the report
      addReport('mixed', daysAgo(100));
      addDelivery('d-mixed-closed', 'mixed', 'user_confirmed_sent', daysAgo(100));
      addDelivery('d-mixed-open', 'mixed', 'copied', daysAgo(100));
      expect(data.prune({}).removed).toMatchObject({ reports: 0, deliveries: 0 });
      expect(ids('reports')).toHaveLength(open.length + 1);
      expect(ids('deliveries')).toHaveLength(open.length + 2);
    });

    it('keeps an old report whose delivery was touched after the cutoff', () => {
      const { data } = setup({ reportsDays: 60 });
      addReport('old', daysAgo(100));
      addDelivery('recent-delivery', 'old', 'user_confirmed_sent', daysAgo(59));
      addReport('older', daysAgo(100));
      addDelivery('old-delivery', 'older', 'user_confirmed_sent', daysAgo(61));
      expect(data.prune({}).removed).toMatchObject({ reports: 1, deliveries: 1 });
      expect(ids('reports')).toEqual(['old']);
      expect(ids('deliveries')).toEqual(['recent-delivery']);
    });

    it('never removes a report captured after the cutoff, even when its delivery is closed', () => {
      const { data } = setup({ reportsDays: 60 });
      addReport('fresh', daysAgo(59));
      addDelivery('d', 'fresh', 'user_discarded', daysAgo(59));
      expect(data.prune({}).removed).toMatchObject({ reports: 0, deliveries: 0 });
    });
  });

  it('applies each retention setting to its own table only', () => {
    const { data } = setup({ rawEventsDays: 10, activityDays: 0, notificationsDays: 0, reportsDays: 0 });
    addRaw(daysAgo(100)); addActivity('a', daysAgo(100)); addNotification('n', daysAgo(100)); addReport('r', daysAgo(100));
    expect(data.prune({}).removed).toEqual({ rawEvents: 1, activity: 0, notifications: 0, reports: 0, deliveries: 0 });
    expect(data.usage()).toMatchObject({ rawEvents: 0, activity: 1, notifications: 1, reports: 1 });
  });

  it('reads the retention settings at the moment it runs', () => {
    const { data, settings } = setup({ notificationsDays: 0 });
    addNotification('n', daysAgo(40));
    expect(data.prune({}).removed.notifications).toBe(0);
    settings.update({ retention: { notificationsDays: 30 } });
    expect(data.prune({}).removed.notifications).toBe(1);
  });

  it('is finished after one pass: a second pass removes nothing', () => {
    const { data } = setup({ rawEventsDays: 10, activityDays: 10, notificationsDays: 10, reportsDays: 10 });
    addRaw(daysAgo(50)); addActivity('a', daysAgo(50)); addNotification('n', daysAgo(50)); addReport('r', daysAgo(50)); addDelivery('d', 'r', 'user_discarded', daysAgo(50));
    expect(data.prune({}).removed).toEqual({ rawEvents: 1, activity: 1, notifications: 1, reports: 1, deliveries: 1 });
    expect(data.prune({}).removed).toEqual({ rawEvents: 0, activity: 0, notifications: 0, reports: 0, deliveries: 0 });
    expect(base.log.lines.filter((l) => l.level === 'info' && /Retention cleanup/.test(l.msg))).toHaveLength(1);
  });

  it('never removes a record younger than its cutoff, for any retention, in a sweep over ages', () => {
    for (const days of [1, 7, 30, 90, 365]) {
      base?.close();
      const { data } = setup({ rawEventsDays: days, activityDays: days, notificationsDays: days, reportsDays: days });
      const ages = [0, 1, 6, 7, 29, 30, 31, 89, 90, 91, 364, 365, 366, 1000];
      for (const age of ages) {
        addRaw(daysAgo(age));
        addActivity(`a${age}`, daysAgo(age), { read: true });
        addNotification(`n${age}`, daysAgo(age), true);
        addReport(`r${age}`, daysAgo(age));
        addDelivery(`d${age}`, `r${age}`, 'user_confirmed_sent', daysAgo(age));
      }
      data.prune({});
      const cutoff = days;
      expect(ids('notifications').map((id) => Number(id.slice(1))).sort((a, b) => a - b), `notifications at ${days}d`).toEqual(ages.filter((a) => a <= cutoff));
      expect(ids('activity').map((id) => Number(id.slice(1))).sort((a, b) => a - b), `activity at ${days}d`).toEqual(ages.filter((a) => a <= cutoff));
      expect(ids('reports').map((id) => Number(id.slice(1))).sort((a, b) => a - b), `reports at ${days}d`).toEqual(ages.filter((a) => a <= cutoff));
      expect(ids('deliveries').length, `deliveries at ${days}d`).toBe(ages.filter((a) => a <= cutoff).length);
      expect(base.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM raw_events')?.n, `raw events at ${days}d`).toBe(ages.filter((a) => a <= cutoff).length);
    }
  });
});

describe('prune: dry run', () => {
  function seedMixed() {
    addRaw(daysAgo(200)); addRaw(daysAgo(1));
    addActivity('old', daysAgo(400), { read: true }); addActivity('keep', daysAgo(400), { read: false });
    addNotification('n-old', daysAgo(200)); addNotification('n-new', daysAgo(1));
    addReport('r-old', daysAgo(400)); addDelivery('d-old', 'r-old', 'user_discarded', daysAgo(400));
    addReport('r-open', daysAgo(400)); addDelivery('d-open', 'r-open', 'copied', daysAgo(400));
    addReport('r-new', daysAgo(2));
  }

  it('counts exactly what a real run then removes, and deletes nothing', () => {
    const { data } = setup({ rawEventsDays: 90, activityDays: 180, notificationsDays: 90, reportsDays: 90 });
    seedMixed();
    const before = data.usage();
    const dry = data.prune({ dryRun: true });
    expect(dry).toEqual({ dryRun: true, removed: { rawEvents: 1, activity: 1, notifications: 1, reports: 1, deliveries: 1 } });
    expect(data.usage()).toEqual(before);
    const real = data.prune({ dryRun: false });
    expect(real).toEqual({ dryRun: false, removed: dry.removed });
    expect(data.usage()).toMatchObject({ rawEvents: 1, activity: 1, notifications: 1, reports: 2, deliveries: 1 });
  });

  it('deletes unless dryRun is true: an empty option and dryRun false are real runs', () => {
    const { data } = setup({ rawEventsDays: 1 });
    addRaw(daysAgo(5));
    expect(data.prune({ dryRun: true }).dryRun).toBe(true);
    expect(data.usage().rawEvents).toBe(1);
    expect(data.prune({}).dryRun).toBe(false);
    expect(data.usage().rawEvents).toBe(0);
  });
});

describe('prune: workflow services do their own deleting', () => {
  const fakeHook = (result: number) => ({ prune: vi.fn((_olderThanIso: string) => result) });

  it('hands each service the cutoff it must apply and reports what they say they removed', () => {
    const activity = fakeHook(11); const notifications = fakeHook(22); const reports = fakeHook(33); const deliveries = fakeHook(44);
    const { data } = setup({ rawEventsDays: 90, activityDays: 180, notificationsDays: 30, reportsDays: 365 }, { activity, notifications, reports, deliveries });
    addActivity('a', daysAgo(400), { read: true }); addNotification('n', daysAgo(400)); addReport('r', daysAgo(1000));
    const result = data.prune({});

    expect(activity.prune).toHaveBeenCalledExactlyOnceWith(daysAgo(180));
    expect(notifications.prune).toHaveBeenCalledExactlyOnceWith(daysAgo(30));
    expect(reports.prune).toHaveBeenCalledExactlyOnceWith(daysAgo(365));
    expect(deliveries.prune).toHaveBeenCalledExactlyOnceWith(daysAgo(365));
    expect(result.removed).toMatchObject({ activity: 11, notifications: 22, reports: 33 });
    // their tables were left to them: the SQL fallback did not run
    expect(data.usage()).toMatchObject({ activity: 1, notifications: 1, reports: 1 });
  });

  it('counts deliveries by what actually disappeared, whoever removed them', () => {
    const deliveries = { prune: vi.fn(() => { base.db.run("DELETE FROM deliveries WHERE id = 'd1'"); return 1; }) };
    const reports = { prune: vi.fn(() => { base.db.run("DELETE FROM reports WHERE id = 'r1'"); return 1; }) };
    const { data } = setup({ reportsDays: 30 }, { reports, deliveries });
    addReport('r1', daysAgo(100));
    addDelivery('d1', 'r1', 'user_discarded', daysAgo(100));
    addDelivery('d2', 'r1', 'user_discarded', daysAgo(100));
    addDelivery('d3', 'r1', 'user_confirmed_sent', daysAgo(100));
    expect(data.prune({}).removed).toMatchObject({ reports: 1, deliveries: 3 }); // d1 by the deliveries service, d2 and d3 with the report
  });

  it('uses SQL for the tables whose service was not handed in', () => {
    const activity = fakeHook(5);
    const { data } = setup({ activityDays: 10, notificationsDays: 10, reportsDays: 10 }, { activity });
    addNotification('n', daysAgo(50)); addReport('r', daysAgo(50)); addDelivery('d', 'r', 'user_discarded', daysAgo(50));
    expect(data.prune({}).removed).toEqual({ rawEvents: 0, activity: 5, notifications: 1, reports: 1, deliveries: 1 });
  });

  it('never calls them for a dry run, and never for a retention of 0', () => {
    const activity = fakeHook(1); const notifications = fakeHook(1); const reports = fakeHook(1); const deliveries = fakeHook(1);
    const { data } = setup({ activityDays: 10, notificationsDays: 0, reportsDays: 10 }, { activity, notifications, reports, deliveries });
    addActivity('a', daysAgo(50), { read: true }); addReport('r', daysAgo(50));
    expect(data.prune({ dryRun: true }).removed).toMatchObject({ activity: 1, reports: 1 });
    expect(activity.prune).not.toHaveBeenCalled();
    expect(reports.prune).not.toHaveBeenCalled();
    data.prune({});
    expect(notifications.prune).not.toHaveBeenCalled();
    expect(activity.prune).toHaveBeenCalledTimes(1);
  });
});

describe('prune on a database file', () => {
  it('works with the write-ahead log and hands its space back', () => {
    const file = path.join(tempDir(), 'mini-summa.db');
    const { data } = setup({ rawEventsDays: 1 }, {}, file);
    for (let i = 0; i < 200; i++) addRaw(daysAgo(50));
    addRaw(daysAgo(0));
    expect(data.prune({}).removed.rawEvents).toBe(200);
    expect(data.usage().rawEvents).toBe(1);
    expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
  });
});
