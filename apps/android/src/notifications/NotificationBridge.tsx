// Wires expo-notifications into the app: channels, foreground behaviour, taps (including the tap that launched the app),
// and push registration. Renders nothing. Tapping navigates using ids only; the target screen loads its own content.
import { useCallback, useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRootNavigationState } from 'expo-router';
import { scopeAllows } from '@minisumma/shared';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { useNav } from '../nav.ts';
import { ensureChannels } from './channels.ts';
import { needsYouKind, parseNotificationData, routeNotification } from './payload.ts';
import { registerPush } from './push.ts';
import { pushStatusStore } from './pushStatus.ts';

/** Shown while the app is open too (the user may be on another screen); only "needs you" items make a sound. */
export async function handleForegroundNotification(n: Pick<Notifications.Notification, 'request'>): Promise<Notifications.NotificationBehavior> {
  const t = parseNotificationData(n.request.content.data);
  return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: t ? needsYouKind(t.kind) : false, shouldSetBadge: false };
}

let handlerInstalled = false;

function installHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({ handleNotification: handleForegroundNotification });
}

export function NotificationBridge() {
  const nav = useNav();
  const api = useConnectionApi();
  const snap = useConnection();
  const rootReady = Boolean(useRootNavigationState()?.key);
  const registered = useRef(false);

  const handleResponse = useCallback((response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const href = routeNotification(response.notification.request.content.data);
    if (href) nav.push(href);
    Notifications.clearLastNotificationResponse();
  }, [nav]);

  useEffect(() => {
    installHandler();
    void ensureChannels().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!rootReady) return undefined;
    // The tap that started the app, then every tap while it runs.
    handleResponse(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => sub.remove();
  }, [rootReady, handleResponse]);

  const canNotify = scopeAllows(snap.scopes, 'notify');
  const connected = snap.status === 'connected';
  useEffect(() => {
    if (!connected || registered.current) return;
    registered.current = true;
    void registerPush(api.call, canNotify).then((status) => pushStatusStore.set(status));
  }, [connected, canNotify, api]);

  useEffect(() => {
    // FCM can rotate the token while the app is open: register the new one.
    const sub = Notifications.addPushTokenListener(() => {
      void registerPush(api.call, canNotify).then((status) => pushStatusStore.set(status));
    });
    return () => sub.remove();
  }, [api, canNotify]);

  return null;
}

/** Settings calls this to try registration again after the user fixes something. */
export async function retryPushRegistration(call: Parameters<typeof registerPush>[0], canNotify: boolean): Promise<void> {
  pushStatusStore.set(await registerPush(call, canNotify));
}
