// Layout primitives: page, grouped list with flat rows, section heading. Hierarchy comes from surface elevation,
// spacing and type, not from borders (Summa-UI principles 1, 2, 11, 12).
import { Children, isValidElement, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space, touch } from '../theme.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { Text } from './Text.tsx';

export const GUTTER = space.s4;

export interface ScreenProps {
  children: ReactNode;
  /** Tab screens draw their own top area; stack screens sit under the native header. */
  topInset?: boolean;
  bottomInset?: boolean;
  scroll?: boolean;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Screen({ children, topInset = false, bottomInset = true, scroll = true, onRefresh, refreshing, contentStyle, testID }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const pad = { paddingTop: space.s3, paddingBottom: (bottomInset ? insets.bottom : 0) + space.s6 };
  return (
    <View style={[styles.page, { paddingTop: topInset ? insets.top : 0 }]} testID={testID}>
      {/* Sticky: stays visible while the list scrolls, so stale data is never shown without saying so. */}
      <ConnectionBanner />
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scrollContent, pad, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <PullToRefresh onRefresh={onRefresh} refreshing={refreshing} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, styles.scrollContent, pad, contentStyle]}>{children}</View>
      )}
    </View>
  );
}

/** Pull to refresh. The spinner follows the actual promise; background refreshes are silent. */
export function PullToRefresh({ onRefresh, refreshing }: { onRefresh: () => void | Promise<void>; refreshing?: boolean }) {
  const [own, setOwn] = useState(false);
  return (
    <RefreshControl
      refreshing={refreshing ?? own}
      tintColor={colors.text2}
      colors={[colors.text2]}
      progressBackgroundColor={colors.s3}
      onRefresh={() => { setOwn(true); Promise.resolve(onRefresh()).finally(() => setOwn(false)); }}
    />
  );
}

export function TabHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.tabHeader}>
      <Text variant="title" accessibilityRole="header">{title}</Text>
      {right}
    </View>
  );
}

export function Section({ title, children, hint }: { title?: string; children: ReactNode; hint?: string }) {
  return (
    <View style={styles.section}>
      {title ? <Text variant="heading" style={styles.sectionTitle} accessibilityRole="header">{title}</Text> : null}
      {children}
      {hint ? <Text variant="caption" style={styles.sectionHint}>{hint}</Text> : null}
    </View>
  );
}

/** One surface per group, flat rows inside it, a single hairline between rows. */
export function Group({ children }: { children: ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={styles.group}>
      {items.map((child, i) => (
        <View key={child.key ?? i}>
          {i > 0 ? <View style={styles.divider} /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

export interface RowProps {
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  /** Third line, for example the state of a session. */
  detail?: string | null;
  onPress?: () => void;
  trailing?: ReactNode;
  /** A quiet fill, never a frame or an accent color. */
  selected?: boolean;
  /** attention: something needs you (amber). unread: not opened yet (neutral). */
  marker?: 'attention' | 'unread' | null;
  accessibilityHint?: string;
  testID?: string;
}

export function Row({ title, subtitle, meta, detail, onPress, trailing, selected, marker, accessibilityHint, testID }: RowProps) {
  const [focused, setFocused] = useState(false);
  const body = (
    <View style={styles.rowInner}>
      <View style={styles.rowText}>
        <Text variant="body" numberOfLines={2}>{title}</Text>
        {subtitle ? <Text variant="secondary" numberOfLines={2}>{subtitle}</Text> : null}
        {detail ? <Text variant="secondary" numberOfLines={3}>{detail}</Text> : null}
        {meta ? <Text variant="caption">{meta}</Text> : null}
      </View>
      {/* Right side, so the text edge stays aligned from row to row (principle 11). */}
      {marker === 'attention' ? <View style={styles.marker} accessibilityLabel="Needs you" /> : null}
      {marker === 'unread' ? <View style={[styles.marker, { backgroundColor: colors.text }]} accessibilityLabel="Unread" /> : null}
      {trailing ?? (onPress ? <Icon name="chevron-right" size={18} color={colors.text3} /> : null)}
    </View>
  );
  if (!onPress) return <View testID={testID} style={[styles.row, selected && styles.rowSelected]}>{body}</View>;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed, focused && styles.rowFocus]}
    >
      {body}
    </Pressable>
  );
}

/** A labelled value inside a Group: small muted label above the value. */
export function Fact({ label, children, testID }: { label: string; children: ReactNode; testID?: string }) {
  return (
    <View style={styles.fact} testID={testID}>
      <Text variant="caption">{label}</Text>
      <Text variant="body">{children}</Text>
    </View>
  );
}

/** A statement and at most one action. No illustration (Summa-UI empty state preset). */
export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <View style={styles.empty} accessibilityRole="text">
      <Text variant="secondary" style={styles.emptyText}>{text}</Text>
      {action}
    </View>
  );
}

export function IconButton({ icon, label, onPress, testID }: { icon: IconName; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.select }]}
    >
      <Icon name={icon} size={20} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.s0 },
  flex: { flex: 1 },
  scrollContent: { paddingHorizontal: GUTTER, gap: space.s5, flexGrow: 1 },
  tabHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: touch.min, marginBottom: space.s2 },
  section: { gap: space.s2 },
  sectionTitle: { marginBottom: space.s1 },
  sectionHint: { marginTop: space.s1 },
  group: { backgroundColor: colors.s1, borderRadius: radius.lg, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  row: { minHeight: touch.min + space.s2, paddingHorizontal: GUTTER, paddingVertical: space.s3, justifyContent: 'center', borderWidth: 1.5, borderColor: 'transparent' },
  rowPressed: { backgroundColor: colors.s2 },
  rowSelected: { backgroundColor: colors.select },
  rowFocus: { borderColor: colors.focus },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: space.s3 },
  rowText: { flex: 1, gap: 2 },
  marker: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.warn },
  fact: { paddingHorizontal: GUTTER, paddingVertical: space.s3, gap: 2 },
  empty: { paddingVertical: space.s5, gap: space.s3, alignItems: 'flex-start' },
  emptyText: { maxWidth: 340 },
  iconButton: { width: touch.min, height: touch.min, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});
