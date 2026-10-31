import { Text as RNText } from 'react-native';
import type { TextProps as RNTextProps } from 'react-native';
import { colors, mono, type as fs } from '../theme.ts';

export type TextVariant = 'title' | 'heading' | 'body' | 'secondary' | 'caption' | 'code';
export type TextTone = 'default' | 'muted' | 'faint' | 'danger' | 'warn' | 'accent';

const VARIANT = {
  title: { fontSize: fs.xl, lineHeight: 28, fontWeight: '600' as const },
  heading: { fontSize: fs.sm, lineHeight: 18, fontWeight: '600' as const },
  body: { fontSize: fs.base, lineHeight: 23, fontWeight: '400' as const },
  secondary: { fontSize: fs.sm, lineHeight: 20, fontWeight: '400' as const },
  caption: { fontSize: fs.xs, lineHeight: 16, fontWeight: '400' as const },
  code: { fontSize: fs.sm, lineHeight: 20, fontWeight: '400' as const, fontFamily: mono },
};

const TONE = {
  default: colors.text, muted: colors.text2, faint: colors.text3, danger: colors.danger, warn: colors.warn, accent: colors.accentText,
};

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
}

/** Headings are muted rather than indented (Summa-UI principle 11): hierarchy comes from size, weight and color. */
export function Text({ variant = 'body', tone, style, ...rest }: TextProps) {
  const resolvedTone = tone ?? (variant === 'heading' ? 'muted' : variant === 'secondary' ? 'muted' : variant === 'caption' ? 'faint' : 'default');
  return <RNText {...rest} style={[VARIANT[variant], { color: TONE[resolvedTone] }, style]} />;
}
