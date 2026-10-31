import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { space } from '../theme.ts';
import { Text } from './Text.tsx';

/** One quiet line. Nothing is shown for the first 200 ms, so a fast load never flashes (Summa-UI loading preset). */
export function LoadingLine({ text = 'Loading' }: { text?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 200);
    return () => clearTimeout(t);
  }, []);
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={text} style={{ minHeight: space.s7 }}>
      {show ? <Text variant="secondary">{text}</Text> : null}
    </View>
  );
}
