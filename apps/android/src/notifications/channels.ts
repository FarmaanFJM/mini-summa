// Android notification channels. One high-importance channel for things that need you, one default channel for the rest.
// The desktop's push sender sets no channel id, so Android files its pushes under the app's default FCM channel. That is
// NEEDS_YOU_CHANNEL (see app.config.ts), because everything the PC pushes is something that is waiting for the person.
// A sender that wants a quieter push can set `android.notification.channel_id` to UPDATES_CHANNEL.
import * as Notifications from 'expo-notifications';

export const NEEDS_YOU_CHANNEL = 'needs-you';
export const UPDATES_CHANNEL = 'updates';

export async function ensureChannels(): Promise<void> {
  await Notifications.setNotificationChannelAsync(NEEDS_YOU_CHANNEL, {
    name: 'Needs you',
    description: 'Permission requests, questions and errors that are waiting for you.',
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    vibrationPattern: [0, 200, 120, 200],
  });
  await Notifications.setNotificationChannelAsync(UPDATES_CHANNEL, {
    name: 'Updates',
    description: 'Reports and other activity.',
    importance: Notifications.AndroidImportance.DEFAULT,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}
