// Android notification channels. One high-importance channel for things that need you, one default channel for the rest.
// The ids are part of the contract with the desktop's push sender: set `android.notification.channel_id` to
// NEEDS_YOU_CHANNEL for permission, input and error pushes. Anything else lands in the default channel.
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
