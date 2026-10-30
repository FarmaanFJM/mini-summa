import * as Notifications from 'expo-notifications';
import { act } from '@testing-library/react-native';
import { ensureChannels, NEEDS_YOU_CHANNEL, UPDATES_CHANNEL } from '../src/notifications/channels';
import { handleForegroundNotification, NotificationBridge } from '../src/notifications/NotificationBridge';
import { hrefForTarget, needsYouKind, parseNotificationData, routeNotification } from '../src/notifications/payload';
import { NEEDS_FIREBASE_MESSAGE, registerPush, sendLocalTestNotification } from '../src/notifications/push';
import { pushStatusStore } from '../src/notifications/pushStatus';
import { router } from './mocks/expo-router';
import { SESSION_KEY } from './helpers/data';
import { createFakeCore } from './helpers/fakeCore';
import { flush, mount } from './helpers/render';
import { ApiError } from '@minisumma/shared';

const SECRET = 'SECRET REPORT BODY: the migration drops the users table';

describe('notification payload: ids only', () => {
  it('keeps the five ids and nothing else, even if the sender put text in the payload', () => {
    const target = parseNotificationData({
      kind: 'report', projectId: 'prj_1', sessionKey: SESSION_KEY, reportId: 'rep_1', activityId: 'rep_rep_1',
      body: SECRET, text: SECRET, title: SECRET, reportBody: SECRET, toolInput: 'rm -rf /', cwd: 'C:\\secret',
    });
    expect(target).toEqual({ kind: 'report', projectId: 'prj_1', sessionKey: SESSION_KEY, reportId: 'rep_1', activityId: 'rep_rep_1' });
    expect(Object.keys(target!).sort()).toEqual(['activityId', 'kind', 'projectId', 'reportId', 'sessionKey']);
    expect(JSON.stringify(target)).not.toContain('SECRET');
    expect(JSON.stringify(routeNotification({ kind: 'report', reportId: 'rep_1', body: SECRET }))).not.toContain('SECRET');
  });

  it('treats missing, empty and "null" values as absent and drops malformed ids', () => {
    expect(parseNotificationData({ kind: 'input', projectId: 'null', sessionKey: 'not-a-session-key', reportId: '', activityId: '../etc/passwd' }))
      .toEqual({ kind: 'input', projectId: null, sessionKey: null, reportId: null, activityId: null });
  });

  it('rejects things that are not a payload', () => {
    expect(parseNotificationData(null)).toBeNull();
    expect(parseNotificationData('report')).toBeNull();
    expect(parseNotificationData({})).toBeNull();
    expect(routeNotification(undefined)).toBeNull();
  });
});

describe('where a tap goes', () => {
  const t = (over: Parameters<typeof hrefForTarget>[0]) => hrefForTarget(over);
  const base = { kind: 'info' as const, projectId: null, sessionKey: null, reportId: null, activityId: null };

  it('opens the report for a report notification', () => {
    expect(t({ ...base, kind: 'report', reportId: 'rep_9', sessionKey: SESSION_KEY })).toEqual({ pathname: '/report', params: { id: 'rep_9' } });
  });
  it('opens the inbox for a permission request, where it can be answered', () => {
    expect(t({ ...base, kind: 'permission', sessionKey: SESSION_KEY })).toBe('/inbox');
  });
  it('opens the session for a question, an error or a lost session', () => {
    for (const kind of ['input', 'error', 'sessionEnded', 'presenceLost'] as const) {
      expect(t({ ...base, kind, sessionKey: SESSION_KEY })).toEqual({ pathname: '/session', params: { key: SESSION_KEY } });
    }
  });
  it('falls back to the project, then the activity entry, then the feed', () => {
    expect(t({ ...base, kind: 'error', projectId: 'prj_1' })).toEqual({ pathname: '/project', params: { id: 'prj_1' } });
    expect(t({ ...base, activityId: 'drv_1' })).toEqual({ pathname: '/activity', params: { focus: 'drv_1' } });
    expect(t(base)).toBe('/activity');
  });
  it('knows which kinds make a sound', () => {
    expect(['permission', 'input', 'error'].every((k) => needsYouKind(k as never))).toBe(true);
    expect(['report', 'sessionEnded', 'presenceLost', 'info'].some((k) => needsYouKind(k as never))).toBe(false);
  });
});

describe('NotificationBridge', () => {
  const response = (data: unknown, actionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER) =>
    ({ actionIdentifier, notification: { request: { content: { data } } } }) as unknown as Notifications.NotificationResponse;

  it('opens the target of the tap that launched the app', async () => {
    (Notifications.getLastNotificationResponse as jest.Mock).mockReturnValueOnce(response({ kind: 'report', reportId: 'rep_1', body: SECRET }));
    await mount(<NotificationBridge />);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/report', params: { id: 'rep_1' } });
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalled();
    expect(JSON.stringify((router.push as jest.Mock).mock.calls)).not.toContain('SECRET');
  });

  it('opens the target of a tap while the app runs, and ignores other actions', async () => {
    await mount(<NotificationBridge />);
    const listener = (Notifications.addNotificationResponseReceivedListener as jest.Mock).mock.calls[0][0];
    await act(async () => { listener(response({ kind: 'permission', sessionKey: SESSION_KEY })); });
    expect(router.push).toHaveBeenCalledWith('/inbox');
    router.push.mockClear();
    await act(async () => { listener(response({ kind: 'permission' }, 'dismissed')); });
    expect(router.push).not.toHaveBeenCalled();
  });

  it('creates the two channels, sets a foreground handler and registers for push once connected', async () => {
    const core = createFakeCore();
    await mount(<NotificationBridge />, { core });
    await flush();
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(NEEDS_YOU_CHANNEL, expect.objectContaining({ importance: 6 }));
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(UPDATES_CHANNEL, expect.objectContaining({ importance: 5 }));
    expect(core.calls('POST /devices/self/push-token')).toHaveLength(1);
    expect(core.calls('POST /devices/self/push-token')[0].body).toEqual({ provider: 'fcm', token: 'fcm-token-0123456789' });
    expect(pushStatusStore.get()).toEqual({ state: 'registered' });
  });
});

describe('notifications that arrive while the app is open', () => {
  const n = (data: unknown) => ({ request: { content: { data } } }) as unknown as Notifications.Notification;
  it('shows them, and only the ones that need you make a sound', async () => {
    expect(await handleForegroundNotification(n({ kind: 'permission' }))).toMatchObject({ shouldShowBanner: true, shouldPlaySound: true });
    expect(await handleForegroundNotification(n({ kind: 'report', reportId: 'r' }))).toMatchObject({ shouldShowBanner: true, shouldPlaySound: false });
    expect(await handleForegroundNotification(n(undefined))).toMatchObject({ shouldShowBanner: true, shouldPlaySound: false });
  });
});

describe('push registration without Firebase', () => {
  const call = jest.fn();
  beforeEach(() => { call.mockReset(); pushStatusStore.reset(); });

  it('reports that Firebase is needed instead of crashing, and registers nothing', async () => {
    (Notifications.getDevicePushTokenAsync as jest.Mock).mockRejectedValueOnce(new Error('Default FirebaseApp is not initialized in this process app.minisumma.companion. Make sure to call FirebaseApp.initializeApp(Context) first.'));
    const status = await registerPush(call, true);
    expect(status).toEqual({ state: 'needs_firebase', message: 'Push notifications need your own Firebase project. See docs/ANDROID.md' });
    expect(NEEDS_FIREBASE_MESSAGE).toBe('Push notifications need your own Firebase project. See docs/ANDROID.md');
    expect(call).not.toHaveBeenCalled();
  });

  it('reports a denied notification permission in words', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    const status = await registerPush(call, true);
    expect(status.state).toBe('permission_denied');
    expect((status as { message: string }).message).toContain('Turn them on in Android settings');
  });

  it('does nothing when the phone has no notify permission', async () => {
    expect((await registerPush(call, false)).state).toBe('no_scope');
    expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
  });

  it('reports a desktop failure while registering the token', async () => {
    call.mockRejectedValueOnce(new ApiError(0, 'network', 'Could not reach the Mini-Summa core: Network request failed'));
    const status = await registerPush(call, true);
    expect(status.state).toBe('failed');
  });

  it('a local test notification works without Firebase and says what it proves', async () => {
    expect(await sendLocalTestNotification()).toEqual({ ok: true });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ body: expect.stringContaining('does not test push from your PC') }),
      trigger: { channelId: UPDATES_CHANNEL },
    }));
  });
});

describe('channels', () => {
  it('has one high-importance channel for needs-you and one default channel', async () => {
    await ensureChannels();
    const calls = (Notifications.setNotificationChannelAsync as jest.Mock).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['needs-you', 'updates']);
    expect(calls[0][1].importance).toBe(6);
    expect(calls[1][1].importance).toBe(5);
  });
});

