// What a push notification may tell the app. The desktop sends ids only (kind, projectId, sessionKey, reportId,
// activityId). Report text, tool input and paths never travel by push, so this module neither reads nor returns any:
// everything else in the payload is dropped, and the target screen loads its content from the desktop over the API.
import { isSessionKey } from '@minisumma/shared';
import type { SessionKey } from '@minisumma/shared';
import { go } from '../routes.ts';
import type { AppHref } from '../routes.ts';

export type PushKind = 'permission' | 'input' | 'error' | 'report' | 'sessionEnded' | 'presenceLost' | 'info';

export interface NotificationTarget {
  kind: PushKind;
  projectId: string | null;
  sessionKey: SessionKey | null;
  reportId: string | null;
  activityId: string | null;
}

const KINDS: readonly PushKind[] = ['permission', 'input', 'error', 'report', 'sessionEnded', 'presenceLost', 'info'];
const ID_RE = /^[A-Za-z0-9_.:|@-]{1,160}$/;

/** FCM data values are strings; an absent value may arrive as missing, empty or the text "null". */
function idOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v === 'null' || v === 'undefined') return null;
  return ID_RE.test(v) ? v : null;
}

export function parseNotificationData(data: unknown): NotificationTarget | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const kind = typeof d.kind === 'string' && (KINDS as readonly string[]).includes(d.kind) ? (d.kind as PushKind) : 'info';
  const sessionKeyRaw = idOf(d.sessionKey);
  const target: NotificationTarget = {
    kind,
    projectId: idOf(d.projectId),
    sessionKey: sessionKeyRaw && isSessionKey(sessionKeyRaw) ? sessionKeyRaw : null,
    reportId: idOf(d.reportId),
    activityId: idOf(d.activityId),
  };
  const hasAnyId = target.projectId || target.sessionKey || target.reportId || target.activityId;
  return hasAnyId || d.kind ? target : null;
}

/** Where a tapped notification opens. Only ids decide this. */
export function hrefForTarget(t: NotificationTarget): AppHref {
  if (t.reportId) return go.report(t.reportId);
  // A permission request is answered in the inbox; a question is easiest to understand next to its session.
  if (t.kind === 'permission') return go.inbox;
  if (t.sessionKey) return go.session(t.sessionKey);
  if (t.projectId) return go.project(t.projectId);
  if (t.activityId) return go.activityFocus(t.activityId);
  return go.activity;
}

export function routeNotification(data: unknown): AppHref | null {
  const t = parseNotificationData(data);
  return t ? hrefForTarget(t) : null;
}

/** Permission, question and error notifications are the ones that need you; the rest are quiet updates. */
export const needsYouKind = (kind: PushKind): boolean => kind === 'permission' || kind === 'input' || kind === 'error';
