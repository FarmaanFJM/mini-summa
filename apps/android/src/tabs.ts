import type { IconName } from './ui/Icon.tsx';

/** The five tabs, in order. Names are the file names under app/(tabs). */
export const TABS: readonly { name: string; title: string; icon: IconName }[] = [
  { name: 'index', title: 'Home', icon: 'home' },
  { name: 'activity', title: 'Activity', icon: 'activity' },
  { name: 'inbox', title: 'Inbox', icon: 'inbox' },
  { name: 'reports', title: 'Reports', icon: 'file-text' },
  { name: 'settings', title: 'Settings', icon: 'settings' },
];
