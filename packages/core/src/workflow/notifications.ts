// NotificationsService: decides whether a feed entry becomes a desktop notification and/or a phone push, and keeps a
// record of what happened so unread state survives quiet mode.
//
// Order of decisions in consider():
//   1. preferences: kind 'info' is never notified; the project's master switch and the flag for the kind turn the whole
//      notification off (nothing is written, the feed entry stays). The global `notifications.native` setting turns off
//      the desktop channel only; push follows the project's `push` flag and the provider.
//   2. dedupe: a dedupe key that already has a record returns null and does nothing else (also across concurrent calls).
//   3. quiet mode (manual, or the daily window in LOCAL time, which may cross midnight): both channels are suppressed
//      but the record is still written.
//   4. native and push, then one NotificationRecord and one `notification.added` event. A kind in SUPPRESSIBLE (today only
//      turnEnded) asks the host to skip the toast when the person is already looking at that session; the host answers
//      `suppressed: 'viewing'` and the record says so, for the desktop and for the phone.
//
// Push payloads are minimal on purpose: the project name, a fixed sentence per kind and ids. No report text, task text,
// tool input or path ever goes into a push, whatever the activity entry contains.
//
// Contract notes:
//  * Channel results: native is 'suppressed_disabled' (global switch), 'suppressed_quiet', 'suppressed_viewing' (the person
//    was looking at that session), 'sent', 'unavailable' (the host cannot show notifications) or 'failed'. Push is
//    'suppressed_project', 'not_applicable' (no provider configured, or no phone registered), 'suppressed_quiet',
//    'suppressed_viewing' (same reason as the desktop's), 'sent' (at least one device took it) or 'failed'.
//  * Deps are typed as the narrow Picks they use (a full SettingsService / ProjectsService still fits).
import type { ActivityEvent, LinkTarget, NativeBridge, NotificationChannelResult, NotificationRecord, ProjectNotificationPrefs, QuietMode } from '@minisumma/shared';
import { fromJson, newId, toJson } from '@minisumma/storage';
import type { CoreBase, DevicesService, NotificationsService, NotifyHint, ProjectsService, PushPayload, PushProvider, SettingsService } from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { clampInt, isUniqueViolation } from './util.ts';

export interface NotificationsServiceDeps {
  base: CoreBase;
  settings: Pick<SettingsService, 'get'>;
  projects: Pick<ProjectsService, 'get'>;
  devices: Pick<DevicesService, 'pushTargets' | 'clearPushToken'>;
  native: NativeBridge;
  push: PushProvider | null;
}

interface NotificationRow {
  id: string;
  activity_id: string;
  project_id: string | null;
  at: string;
  title: string;
  body: string;
  native: NotificationChannelResult;
  push: NotificationChannelResult;
  read_at: string | null;
  target_json: string;
}

type Notifiable = Exclude<NotifyHint['kind'], 'info'>;

const PREF_FLAG: Record<Notifiable, keyof ProjectNotificationPrefs> = {
  permission: 'permission', input: 'input', error: 'error', report: 'report', turnEnded: 'turnEnded', sessionEnded: 'sessionEnded', presenceLost: 'presenceLost',
};

const TITLE_PHRASE: Record<Notifiable, string> = {
  permission: 'needs permission', input: 'needs your input', error: 'error', report: 'report ready', turnEnded: 'Claude finished',
  sessionEnded: 'session ended', presenceLost: 'session no longer visible',
};

/** The only sentences a push ever carries. */
export const PUSH_BODY: Record<Notifiable, string> = {
  permission: 'Claude is waiting for permission',
  input: 'Claude needs your input',
  error: 'A Claude session hit an error',
  report: 'A report is ready',
  turnEnded: 'Claude finished and is waiting for you',
  presenceLost: 'A Claude session is no longer visible',
  sessionEnded: 'A Claude session ended',
};

export const TEST_PUSH: PushPayload = {
  title: 'Mini-Summa test',
  body: 'This is a test notification from Mini-Summa. Nothing needs your attention.',
  data: { kind: 'info', projectId: null, activityId: 'test' },
};

/**
 * Kinds that can be about something the person is already looking at: a turn that ended in the session on screen. Only the host
 * knows whether its window is in front, so the core asks and the host decides. A permission request, a question, an error, a
 * report or an end is never in this set: those are worth interrupting for even when the window is open.
 */
const SUPPRESSIBLE: ReadonlySet<Notifiable> = new Set<Notifiable>(['turnEnded']);

/**
 * How long the phone waits for the desktop to say "the person is looking at it". The host answers that at once (no system call is
 * involved), whereas a toast is only confirmed later, so a slower answer means "shown" and the phone must not wait for it.
 */
const VIEWING_ANSWER_MS = 250;

/** The value of `work` if it settles within `ms`, else null. Never rejects and leaves no timer behind. */
function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

function parseClock(value: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

/**
 * Why notifications are quiet right now, or null. The daily window uses the local clock of this machine, starts
 * inclusively and ends exclusively, and may cross midnight (22:00 to 08:00). From equal to To is an empty window, and
 * an unreadable time disables the schedule instead of silencing everything.
 */
export function quietReason(quiet: QuietMode, now: Date): 'manual' | 'schedule' | null {
  if (quiet.enabled) {
    const until = quiet.until === null ? Number.NaN : Date.parse(quiet.until);
    // An end that is missing or unreadable means "until I turn it off".
    if (quiet.until === null || Number.isNaN(until) || until > now.getTime()) return 'manual';
  }
  const schedule = quiet.schedule;
  if (schedule?.enabled) {
    const from = parseClock(schedule.from);
    const to = parseClock(schedule.to);
    if (from !== null && to !== null && from !== to) {
      const t = now.getHours() * 60 + now.getMinutes();
      const inside = from < to ? t >= from && t < to : t >= from || t < to;
      if (inside) return 'schedule';
    }
  }
  return null;
}

export function createNotificationsService(deps: NotificationsServiceDeps): NotificationsService {
  const { db, bus, clock, log } = deps.base;
  const inFlight = new Set<string>();

  /** Sends one payload and clears tokens the provider says are dead. */
  async function pushTo(provider: PushProvider, targets: { deviceId: string; token: string }[], payload: PushPayload): Promise<{ sent: number; failed: number }> {
    let results: Awaited<ReturnType<PushProvider['send']>>;
    try {
      results = await provider.send(targets.map((t) => ({ deviceId: t.deviceId, token: t.token })), payload);
    } catch (err) {
      log.warn('push send failed', { error: String(err) });
      return { sent: 0, failed: targets.length };
    }
    let sent = 0;
    let failed = 0;
    for (const r of results) {
      if (r.result === 'sent') sent++; else failed++;
      if (r.result === 'invalid_token') deps.devices.clearPushToken(r.deviceId);
    }
    return { sent, failed };
  }

  function rowToRecord(r: NotificationRow): NotificationRecord {
    return {
      id: r.id, activityId: r.activity_id, projectId: r.project_id, at: r.at, title: r.title, body: r.body,
      native: r.native, push: r.push, readAt: r.read_at,
      target: fromJson<NotificationRecord['target']>(r.target_json, { view: 'activity' }),
    };
  }

  function pushPayloadFor(activity: ActivityEvent, hint: NotifyHint & { kind: Notifiable }, projectLabel: string): PushPayload {
    const data: PushPayload['data'] = { kind: hint.kind, projectId: hint.projectId, activityId: activity.id };
    const sessionKey = hint.sessionKey ?? activity.sessionKey;
    if (sessionKey) data.sessionKey = sessionKey;
    const reportLink = activity.links.find((l): l is Extract<LinkTarget, { kind: 'report' }> => l.kind === 'report');
    const reportId = hint.target.reportId ?? reportLink?.id;
    if (reportId) data.reportId = reportId;
    return { title: projectLabel, body: PUSH_BODY[hint.kind], data };
  }

  return {
    async consider(activity, hint) {
      if (hint.kind === 'info') return null;
      const settings = deps.settings.get();
      const project = hint.projectId ? deps.projects.get(hint.projectId) : null;
      const prefs = project?.notificationPrefs ?? settings.notifications.defaults;
      if (!prefs.enabled || !prefs[PREF_FLAG[hint.kind]]) return null;

      const key = hint.dedupeKey;
      if (inFlight.has(key) || db.get('SELECT 1 AS found FROM notifications WHERE dedupe_key = ?', [key])) return null;
      inFlight.add(key);
      try {
        const at = nowIso(clock);
        const quiet = quietReason(settings.notifications.quiet, clock.now()) !== null;
        const projectLabel = project?.name ?? activity.projectName ?? 'Mini-Summa';
        const title = `${projectLabel}: ${TITLE_PHRASE[hint.kind]}`;
        const body = activity.title; // local only; pushes never carry it
        const notifiable = hint as NotifyHint & { kind: Notifiable };
        const suppressible = SUPPRESSIBLE.has(notifiable.kind);

        const sendNative = async (): Promise<NotificationChannelResult> => {
          if (!settings.notifications.native) return 'suppressed_disabled';
          if (quiet) return 'suppressed_quiet';
          try {
            const r = await deps.native.notify({
              title, body, tag: key, target: hint.target, urgency: hint.urgency, silent: false, ...(suppressible ? { suppressIfViewing: true } : {}),
            });
            if (r.shown) return 'sent';
            if (suppressible && r.suppressed === 'viewing') return 'suppressed_viewing';
            return r.reason === undefined || /unavailable|unsupported|not supported/i.test(r.reason) ? 'unavailable' : 'failed';
          } catch (err) {
            log.warn('native notification failed', { error: String(err) });
            return 'failed';
          }
        };

        const nativeResult = sendNative();

        const sendPush = async (): Promise<NotificationChannelResult> => {
          if (!prefs.push) return 'suppressed_project';
          try {
            const provider = deps.push;
            if (!provider || !provider.configured()) return 'not_applicable';
            const targets = deps.devices.pushTargets();
            if (targets.length === 0) return 'not_applicable';
            if (quiet) return 'suppressed_quiet';
            // The phone is for when the person is away from the desktop, and "Claude finished" happens after every prompt: a buzz in the
            // pocket for what they are watching on screen would only be noise, so the push follows the desktop's "looking at it".
            if (suppressible && (await settledWithin(nativeResult, VIEWING_ANSWER_MS)) === 'suppressed_viewing') return 'suppressed_viewing';
            const { sent } = await pushTo(provider, targets, pushPayloadFor(activity, notifiable, projectLabel));
            return sent > 0 ? 'sent' : 'failed';
          } catch (err) {
            // One channel breaking must not stop the record from being written: the desktop may already have shown it.
            log.warn('push notification failed', { error: String(err) });
            return 'failed';
          }
        };

        const [native, push] = await Promise.all([nativeResult, sendPush()]);
        const record: NotificationRecord = {
          id: newId('ntf'), activityId: activity.id, projectId: hint.projectId ?? activity.projectId, at, title, body, native, push, readAt: null, target: hint.target,
        };
        try {
          db.run(
            `INSERT INTO notifications (id, activity_id, project_id, at, title, body, native, push, read_at, target_json, dedupe_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [record.id, record.activityId, record.projectId, at, title, body, native, push, toJson(record.target), key],
          );
        } catch (err) {
          if (isUniqueViolation(err)) return null; // another writer recorded this key first
          throw err;
        }
        bus.emit({ type: 'notification.added', notification: record });
        return record;
      } finally {
        inFlight.delete(key);
      }
    },

    list(limit) {
      return db.all<NotificationRow>('SELECT * FROM notifications ORDER BY at DESC, rowid DESC LIMIT ?', [clampInt(limit, 1, 200, 50)]).map(rowToRecord);
    },

    async sendTest() {
      const provider = deps.push;
      if (!provider || !provider.configured()) return { sent: 0, failed: 0, skipped: 'Push is not set up yet. Add your Firebase service account in Settings first.' };
      const targets = deps.devices.pushTargets();
      if (targets.length === 0) return { sent: 0, failed: 0, skipped: 'No phone has registered for push yet. Open the Android app and allow notifications.' };
      const { sent, failed } = await pushTo(provider, targets, TEST_PUSH);
      return { sent, failed, skipped: null };
    },

    prune(olderThanIso) {
      return db.run('DELETE FROM notifications WHERE at < ?', [olderThanIso]).changes;
    },
  };
}
