import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useOptionalConnectionApi } from '../connection/context.tsx';
import type { ConnectionApi } from '../connection/ConnectionManager.ts';
import { describeConnection } from '../connection/banner.ts';
import type { BannerModel } from '../connection/banner.ts';
import { colors, radius, space } from '../theme.ts';
import { Icon } from './Icon.tsx';
import { Text } from './Text.tsx';

/** Presentational part, so it can be tested with any model. Neutral surface; only the icon takes a semantic hue. */
export function BannerView({ model }: { model: BannerModel }) {
  if (!model.visible) return null;
  const hue = model.tone === 'danger' ? colors.danger : model.tone === 'warning' ? colors.warn : colors.text2;
  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="connection-banner">
      <Icon name={model.tone === 'danger' ? 'circle-alert' : model.tone === 'warning' ? 'triangle-alert' : 'wifi'} size={18} color={hue} />
      <View style={styles.text}>
        <Text variant="body" style={{ fontWeight: '600' }}>{model.title}</Text>
        {model.detail ? <Text variant="secondary">{model.detail}</Text> : null}
        {model.lastUpdated ? <Text variant="caption" testID="banner-last-updated">{model.lastUpdated}</Text> : null}
      </View>
    </View>
  );
}

function LiveBanner({ api }: { api: ConnectionApi }) {
  const snap = useSyncExternalStore(api.subscribe, api.getSnapshot, api.getSnapshot);
  return <BannerView model={describeConnection(snap)} />;
}

/** Shown on every screen whenever the data is not live. Hidden while connected, and before pairing. */
export function ConnectionBanner() {
  const api = useOptionalConnectionApi();
  return api ? <LiveBanner api={api} /> : null;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row', gap: space.s3, alignItems: 'flex-start', backgroundColor: colors.s3, borderRadius: radius.lg,
    paddingVertical: space.s3, paddingHorizontal: space.s4, marginHorizontal: space.s4, marginTop: space.s2,
  },
  text: { flex: 1, gap: 2 },
});
