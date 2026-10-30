import { useState } from 'react';
import { Linking, View } from 'react-native';
import Constants from 'expo-constants';
import { useSession } from '../session/SessionProvider.tsx';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { retryPushRegistration } from '../notifications/NotificationBridge.tsx';
import { sendLocalTestNotification } from '../notifications/push.ts';
import { usePushStatus } from '../notifications/pushStatus.ts';
import { formatWhen, scopeText } from '../lib/format.ts';
import { space } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { Fact, Group, Screen, Section, TabHeader } from '../ui/layout.tsx';
import { ConfirmDialog, useToast } from '../ui/overlays.tsx';
import { Text } from '../ui/Text.tsx';
import type { ConnectionStatus } from '../connection/ConnectionManager.ts';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connected: 'Live',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting, not live',
  desktop_unreachable: 'Cannot reach your PC, not live',
  revoked: 'Removed from Mini-Summa',
  idle: 'Paused, not live',
};

export function SettingsScreen() {
  const snap = useConnection();
  const api = useConnectionApi();
  const session = useSession();
  const push = usePushStatus();
  const toast = useToast();
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const { device, scopes, endpoint, state } = snap;
  const version = Constants.expoConfig?.version ?? 'unknown';
  const canNotify = scopes.includes('notify') || scopes.includes('desktop');

  const test = async () => {
    const r = await sendLocalTestNotification();
    toast.show(r.ok ? 'Test notification sent to this phone' : r.message, r.ok ? 'success' : 'error');
  };

  const unpair = async () => {
    setUnpairing(true);
    try { await session.unpair(); } finally { setUnpairing(false); setConfirmUnpair(false); }
  };

  return (
    <Screen topInset onRefresh={() => api.refresh()}>
      <TabHeader title="Settings" />

      <Section title="This phone">
        <Group>
          <Fact label="Name">{device?.name ?? 'Not loaded yet'}</Fact>
          <Fact label="Permissions">{scopes.length ? scopes.map((s) => scopeText[s]).join('\n') : 'Not loaded yet'}</Fact>
          <Fact label="Trusted">
            {device
              ? device.trusted
                ? 'Yes. Prompts sent from this phone run without a second approval on your PC.'
                : 'No. Prompts sent from this phone wait for your approval on your PC.'
              : 'Not loaded yet'}
          </Fact>
        </Group>
      </Section>

      <Section title="Connection">
        <Group>
          <Fact label="Desktop">{endpoint.serverName || 'Mini-Summa'}</Fact>
          <Fact label="Address" testID="settings-address">{endpoint.baseUrl}</Fact>
          <Fact label="Status">{STATUS_TEXT[snap.status]}</Fact>
          {snap.lastHeardAt ? <Fact label="Last updated">{formatWhen(snap.lastHeardAt)}</Fact> : null}
          {state.system ? <Fact label="Mini-Summa on your PC">{`Version ${state.system.version}, API ${state.system.apiVersion}, ${state.system.mode}`}</Fact> : null}
        </Group>
      </Section>

      <Section title="Notifications">
        <Group>
          <Fact label="Push from your PC" testID="push-status">{pushText(push)}</Fact>
        </Group>
        <View style={{ gap: space.s2 }}>
          {push.state === 'permission_denied' ? <Button label="Open Android settings" onPress={() => { void Linking.openSettings(); }} /> : null}
          {push.state === 'failed' || push.state === 'needs_firebase' || push.state === 'permission_denied' ? (
            <Button label="Try registering again" onPress={() => { void retryPushRegistration(api.call, canNotify); }} />
          ) : null}
          <Button label="Send a test notification" onPress={() => { void test(); }} />
        </View>
      </Section>

      <Section title="App">
        <Group>
          <Fact label="Version">{version}</Fact>
        </Group>
      </Section>

      <Button label="Unpair this phone" variant="danger" icon="log-out" onPress={() => setConfirmUnpair(true)} />
      <Text variant="caption">Unpairing clears the connection from this phone. The phone stays in the device list in Mini-Summa on your PC until you remove it there.</Text>

      <ConfirmDialog
        visible={confirmUnpair}
        title="Unpair this phone?"
        body={`This phone will forget its connection to ${endpoint.serverName || 'your PC'} and stop receiving updates.`}
        confirmLabel="Unpair phone"
        confirmVariant="danger"
        busy={unpairing}
        onConfirm={() => { void unpair(); }}
        onCancel={() => setConfirmUnpair(false)}
      />
    </Screen>
  );
}

function pushText(p: ReturnType<typeof usePushStatus>): string {
  switch (p.state) {
    case 'unknown': return 'Not registered yet. In-app updates work while the app is open.';
    case 'registered': return 'Registered. Your PC can send push notifications to this phone.';
    case 'needs_firebase': return `${p.message}\nLive updates inside the app keep working.`;
    default: return p.message;
  }
}
