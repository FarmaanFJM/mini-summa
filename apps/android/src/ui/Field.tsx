import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { colors, mono, radius, space, touch } from '../theme.ts';
import { Text } from './Text.tsx';

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  monospace?: boolean;
  minHeight?: number;
}

/** A filled input (no outline box). Focus is a quiet neutral 1px ring, not the emerald accent. */
export function Field({ label, monospace, minHeight, onFocus, onBlur, ...rest }: FieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <Text variant="heading">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.text3}
        selectionColor={colors.text2}
        cursorColor={colors.text}
        {...rest}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        style={[styles.input, monospace && { fontFamily: mono, fontSize: 14 }, minHeight ? { minHeight, textAlignVertical: 'top' } : null, focused && styles.focused]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.s2 },
  input: {
    minHeight: touch.min, backgroundColor: colors.s2, borderRadius: radius.md, color: colors.text, fontSize: 16,
    paddingHorizontal: space.s4, paddingVertical: space.s3, borderWidth: 1, borderColor: 'transparent',
  },
  focused: { borderColor: colors.focus },
});
