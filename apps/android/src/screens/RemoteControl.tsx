import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useClientState } from '../connection/context.tsx';
import { openClaudeCode } from '../lib/links.ts';
import { findSession } from '../state/selectors.ts';
import { space } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { Screen, Section } from '../ui/layout.tsx';
import { ScreenTitle } from '../ui/ScreenTitle.tsx';
import { Text } from '../ui/Text.tsx';

/**
 * External sessions are observed only. Mini-Summa never types into them, so the way to continue one from a phone is
 * Anthropic's own Remote Control, started inside that Claude Code session.
 */
export function RemoteControlScreen() {
  const { key } = useLocalSearchParams<{ key?: string }>();
  const state = useClientState();
  const session = findSession(state, key);
  const [error, setError] = useState<string | null>(null);

  return (
    <Screen>
      <ScreenTitle title="Remote Control" />
      <Text variant="title" accessibilityRole="header">Continue this session in the Claude app</Text>
      <Text variant="body">Mini-Summa observes external sessions but cannot type into them.</Text>

      <Section title="How">
        <View style={{ gap: space.s3 }}>
          <Text variant="body">In that Claude Code session, type /remote-control. Or start Claude Code with claude --remote-control.</Text>
          <Text variant="body">Then continue the session from the Claude app on this phone.</Text>
        </View>
      </Section>

      {session ? (
        <Section title="What Mini-Summa sees">
          <Text variant="body" tone="muted">{session.remoteControl.hint || 'Mini-Summa could not tell whether Remote Control is on for this session.'}</Text>
        </Section>
      ) : null}

      <View style={{ gap: space.s3 }}>
        <Button
          label="Open claude.ai/code"
          variant="primary"
          icon="external"
          onPress={() => { void openClaudeCode().then((r) => setError(r.ok ? null : r.message)); }}
        />
        {error ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{error}</Text> : null}
      </View>
    </Screen>
  );
}
