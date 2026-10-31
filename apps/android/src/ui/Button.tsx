import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { colors, radius, space, touch } from '../theme.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Text } from './Text.tsx';

/**
 * primary    the one emerald action of a view
 * secondary  neutral fill
 * quiet      text only, for low emphasis
 * danger     solid destructive button (never translucent, never primary)
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  /** Shows a spinner, keeps the label and ignores repeat presses. */
  busy?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const FILL: Record<ButtonVariant, { rest: string; pressed: string; ink: string }> = {
  primary: { rest: colors.accent, pressed: colors.accentHover, ink: colors.accentInk },
  secondary: { rest: colors.s3, pressed: colors.s4, ink: colors.text },
  quiet: { rest: 'transparent', pressed: colors.select, ink: colors.text },
  danger: { rest: colors.dangerSolid, pressed: colors.dangerSolidHover, ink: colors.dangerInk },
};

export function Button({ label, onPress, variant = 'secondary', icon, disabled, busy, accessibilityHint, style, testID }: ButtonProps) {
  const [focused, setFocused] = useState(false);
  const inactive = Boolean(disabled || busy);
  const fill = FILL[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: pressed ? fill.pressed : fill.rest, opacity: disabled ? 0.45 : 1 },
        // Neutral 1.5px focus ring (principle 15 and 17), never emerald.
        focused && styles.focus,
        style,
      ]}
    >
      <View style={styles.content}>
        {busy ? <ActivityIndicator size="small" color={fill.ink} /> : icon ? <Icon name={icon} size={18} color={fill.ink} /> : null}
        <Text variant="body" style={{ color: fill.ink, fontWeight: '600' }}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: touch.min, borderRadius: radius.md, paddingHorizontal: space.s4, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: 'transparent' },
  focus: { borderColor: colors.focus },
  content: { flexDirection: 'row', alignItems: 'center', gap: space.s2 },
});
