import { StatusBar, View } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '../src/session/SessionProvider.tsx';
import { NotificationBridge } from '../src/notifications/NotificationBridge.tsx';
import { colors } from '../src/theme.ts';
import { ToastProvider } from '../src/ui/overlays.tsx';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SessionProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const { phase } = useSession();
  // Reading the stored pairing is quick; until it is known show only the page color, never a wrong screen.
  if (phase === 'loading') return <View style={{ flex: 1, backgroundColor: colors.s0 }} />;
  const paired = phase === 'paired';
  return (
    <>
      {paired ? <NotificationBridge /> : null}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.s0 },
          headerTintColor: colors.text,
          headerTitleStyle: { fontSize: 17, fontWeight: '600' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.s0 },
        }}
      >
        {/* Screens that need a paired phone are not mounted at all until it is paired. */}
        <Stack.Protected guard={paired}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="project" options={{ title: 'Project' }} />
          <Stack.Screen name="report" options={{ title: 'Report' }} />
          <Stack.Screen name="session/index" options={{ title: 'Session' }} />
          <Stack.Screen name="session/send" options={{ title: 'Send to Claude' }} />
          <Stack.Screen name="session/remote-control" options={{ title: 'Remote Control' }} />
        </Stack.Protected>
        <Stack.Protected guard={!paired}>
          <Stack.Screen name="pair" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
