import { Stack } from 'expo-router';

/** Sets the native header title of the stack screen this is rendered in. */
export function ScreenTitle({ title }: { title: string }) {
  return <Stack.Screen options={{ title }} />;
}
