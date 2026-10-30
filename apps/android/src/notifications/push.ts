// Push registration with the user's own Firebase project. Without google-services.json the native token request fails;
// that is expected and reported in words, never as a crash. In-app live status over the WebSocket does not depend on it.
import * as Notifications from 'expo-notifications';
import { ApiError } from '@minisumma/shared';
import type { ConnectionApi } from '../connection/ConnectionManager.ts';
import { describeApiError } from '../lib/errors.ts';
import { NEEDS_YOU_CHANNEL, UPDATES_CHANNEL } from './channels.ts';

export type PushStatus =
  | { state: 'unknown' }
  | { state: 'registered' }
  | { state: 'needs_firebase'; message: string }
  | { state: 'permission_denied'; message: string }
  | { state: 'no_scope'; message: string }
  | { state: 'failed'; message: string };

export const NEEDS_FIREBASE_MESSAGE = 'Push notifications need your own Firebase project. See docs/ANDROID.md';

const FIREBASE_RE = /firebase|google-services|fcm|play.?services|sender|instance.?id|service_not_available|missing_instanceid/i;

export async function registerPush(call: ConnectionApi['call'], canNotify: boolean): Promise<PushStatus> {
  if (!canNotify) {
    return { state: 'no_scope', message: 'This phone was not given permission to receive notifications. Pair it again with that permission in Mini-Summa on your PC.' };
  }
  try {
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) {
      return { state: 'permission_denied', message: 'Notifications are turned off for Mini-Summa. Turn them on in Android settings to get alerts.' };
    }
    let token: string;
    try {
      const t = await Notifications.getDevicePushTokenAsync();
      token = typeof t.data === 'string' ? t.data : '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (FIREBASE_RE.test(message)) return { state: 'needs_firebase', message: NEEDS_FIREBASE_MESSAGE };
      return { state: 'failed', message: `Could not get a push token from Android: ${message}` };
    }
    if (!token) return { state: 'needs_firebase', message: NEEDS_FIREBASE_MESSAGE };
    await call('devices.registerPush', { body: { provider: 'fcm', token } });
    return { state: 'registered' };
  } catch (err) {
    if (err instanceof ApiError) return { state: 'failed', message: describeApiError(err) };
    return { state: 'failed', message: err instanceof Error ? err.message : 'Push registration failed.' };
  }
}

/** Local notification on this phone only. It proves permission and channel setup, not push from the PC. */
export async function sendLocalTestNotification(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return { ok: false, message: 'Notifications are turned off for Mini-Summa. Turn them on in Android settings.' };
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Mini-Summa test', body: 'This notification was made on this phone. It does not test push from your PC.', data: { kind: 'info' } },
      trigger: { channelId: UPDATES_CHANNEL },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not show a notification.' };
  }
}

export { NEEDS_YOU_CHANNEL, UPDATES_CHANNEL };
