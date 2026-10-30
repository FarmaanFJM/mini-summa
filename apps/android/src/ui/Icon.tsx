// Icons come only from the curated Summa-UI catalog (Lucide, ISC license, see assets/icons/LICENSE). They are white
// PNGs tinted at runtime, so color always follows the surrounding text and carries meaning only when a caller says so.
import { Image } from 'react-native';
import type { ColorValue } from 'react-native';
import { colors } from '../theme.ts';

/* eslint-disable @typescript-eslint/no-require-imports -- Metro needs static require() for assets */
const SOURCES = {
  home: require('../../assets/icons/home.png'),
  activity: require('../../assets/icons/activity.png'),
  inbox: require('../../assets/icons/inbox.png'),
  'file-text': require('../../assets/icons/file-text.png'),
  settings: require('../../assets/icons/settings.png'),
  'chevron-right': require('../../assets/icons/chevron-right.png'),
  filter: require('../../assets/icons/filter.png'),
  'more-v': require('../../assets/icons/more-v.png'),
  x: require('../../assets/icons/x.png'),
  copy: require('../../assets/icons/copy.png'),
  share: require('../../assets/icons/share.png'),
  external: require('../../assets/icons/external.png'),
  check: require('../../assets/icons/check.png'),
  send: require('../../assets/icons/send.png'),
  refresh: require('../../assets/icons/refresh.png'),
  'circle-alert': require('../../assets/icons/circle-alert.png'),
  'circle-check': require('../../assets/icons/circle-check.png'),
  'triangle-alert': require('../../assets/icons/triangle-alert.png'),
  info: require('../../assets/icons/info.png'),
  wifi: require('../../assets/icons/wifi.png'),
  smartphone: require('../../assets/icons/smartphone.png'),
  key: require('../../assets/icons/key.png'),
  bell: require('../../assets/icons/bell.png'),
  terminal: require('../../assets/icons/terminal.png'),
  lock: require('../../assets/icons/lock.png'),
  'log-out': require('../../assets/icons/log-out.png'),
} as const;

export type IconName = keyof typeof SOURCES;

export function Icon({ name, size = 20, color = colors.text2 }: { name: IconName; size?: 16 | 18 | 20 | 24; color?: ColorValue }) {
  return (
    <Image
      source={SOURCES[name]}
      style={{ width: size, height: size, tintColor: color }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
