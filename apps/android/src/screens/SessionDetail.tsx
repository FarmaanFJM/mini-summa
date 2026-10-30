import { useLocalSearchParams } from 'expo-router';
import { shortSessionId } from '@minisumma/shared';
import { View } from 'react-native';
import { sendGuard } from '../actions/send.ts';
import { useConnection } from '../connection/context.tsx';
import {
  attentionText, availabilityLabel, declaredStatusText, envName, formatWhen, originLabel, sessionTitle, stateLabel, terminationLine,
} from '../lib/format.ts';
import { go, useNav } from '../nav.ts';
import { findSession } from '../state/selectors.ts';
import { space } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState, Fact, Group, Row, Screen, Section } from '../ui/layout.tsx';
import { ScreenTitle } from '../ui/ScreenTitle.tsx';
import { Text } from '../ui/Text.tsx';

/** Says exactly which project and which session this is, then what can be done with it. */
export function SessionDetailScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const snap = useConnection();
  const nav = useNav();
  const { state } = snap;
  const session = findSession(state, key);

  if (!session) {
    return (
      <Screen>
        <ScreenTitle title="Session" />
        <EmptyState text={state.loaded ? 'This session is no longer listed on your PC.' : 'Loading the session.'} />
      </Screen>
    );
  }

  const guard = sendGuard(session, snap.scopes);
  const ended = terminationLine(session);
  const reports = state.reports.filter((r) => r.sessionKey === session.key).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 5);
  const short = shortSessionId(session.key);

  return (
    <Screen>
      <ScreenTitle title={`Session ${short}`} />
      <View style={{ gap: 4 }}>
        <Text variant="caption">Project</Text>
        <Text variant="title" accessibilityRole="header">{session.projectName ?? 'No project'}</Text>
        <Text variant="body" tone="muted">{session.name?.trim() ? `${sessionTitle(session)} (${short})` : sessionTitle(session)}</Text>
      </View>

      <Group>
        <Fact label="Session">{short}{session.name ? `, ${session.name}` : ''}</Fact>
        <Fact label="Environment">{envName(session.env)}</Fact>
        <Fact label="Origin">{originLabel[session.origin]}</Fact>
        <Fact label="Availability">{availabilityLabel[session.availability]}</Fact>
        <Fact label="State">{stateLabel(session)}</Fact>
        <Fact label="Generation">{String(session.generation)}</Fact>
        {session.lastActivityAt ? <Fact label="Last activity">{formatWhen(session.lastActivityAt)}</Fact> : null}
      </Group>
      <Text variant="caption" selectable>{session.key}</Text>

      {session.attention && session.attention.kind !== 'report' ? (
        <Text variant="body" tone="warn">{attentionText[session.attention.kind]}</Text>
      ) : null}
      {ended ? <Text variant="body" tone="muted">{ended}</Text> : null}

      <Section title="Send text to this session">
        {guard.allowed ? (
          <Button label="Send to Claude" variant="primary" icon="send" onPress={() => nav.push(go.send(session.key))} />
        ) : (
          <View style={{ gap: space.s3 }}>
            <Text variant="body" tone="muted">{guard.reason}</Text>
            {guard.offerRemoteControl ? (
              <Button label="Continue with Remote Control" variant="secondary" onPress={() => nav.push(go.remoteControl(session.key))} />
            ) : null}
          </View>
        )}
      </Section>

      {reports.length ? (
        <Section title="Reports from this session">
          <Group>
            {reports.map((r) => (
              <Row key={r.id} title={r.taskTitle} subtitle={declaredStatusText[r.declaredStatus]} marker={r.read ? null : 'unread'} onPress={() => nav.push(go.report(r.id))} />
            ))}
          </Group>
        </Section>
      ) : null}
    </Screen>
  );
}
