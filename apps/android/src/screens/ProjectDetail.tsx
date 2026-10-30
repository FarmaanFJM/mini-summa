import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { sessionsOfProject } from '@minisumma/shared';
import { useClientState } from '../connection/context.tsx';
import { declaredStatusText, sessionMeta, sessionTitle, terminationLine } from '../lib/format.ts';
import { openChatGpt } from '../lib/links.ts';
import { go, useNav } from '../nav.ts';
import { conversationsOf, findProject, reportsOfProject, sortSessions } from '../state/selectors.ts';
import { colors } from '../theme.ts';
import { Icon } from '../ui/Icon.tsx';
import { EmptyState, Group, Row, Screen, Section } from '../ui/layout.tsx';
import { Text } from '../ui/Text.tsx';
import { ScreenTitle } from '../ui/ScreenTitle.tsx';

const REPORT_PREVIEW = 8;

export function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useClientState();
  const nav = useNav();
  const [linkError, setLinkError] = useState<string | null>(null);
  const project = findProject(state, id);

  if (!project) {
    return (
      <Screen>
        <ScreenTitle title="Project" />
        <EmptyState text={state.loaded ? 'This project is no longer on your PC.' : 'Loading the project.'} />
      </Screen>
    );
  }

  const sessions = sortSessions(sessionsOfProject(state, project.id));
  const reports = reportsOfProject(state, project.id);
  const conversations = conversationsOf(state, project.id);

  const open = async (url: string) => {
    setLinkError(null);
    const result = await openChatGpt(url);
    if (!result.ok) setLinkError(result.message);
  };

  return (
    <Screen>
      <ScreenTitle title={project.name} />
      <Text variant="title" accessibilityRole="header">{project.name}</Text>

      <Section title="Sessions">
        {sessions.length ? (
          <Group>
            {sessions.map((s) => (
              <Row
                key={s.key}
                title={sessionTitle(s)}
                subtitle={sessionMeta(s)}
                detail={terminationLine(s)}
                marker={s.attention && s.attention.kind !== 'report' ? 'attention' : null}
                onPress={() => nav.push(go.session(s.key))}
              />
            ))}
          </Group>
        ) : <EmptyState text="No sessions yet for this project." />}
      </Section>

      <Section title="Reports">
        {reports.length ? (
          <Group>
            {reports.slice(0, REPORT_PREVIEW).map((r) => (
              <Row
                key={r.id}
                title={r.taskTitle}
                subtitle={declaredStatusText[r.declaredStatus]}
                marker={r.read ? null : 'unread'}
                onPress={() => nav.push(go.report(r.id))}
              />
            ))}
          </Group>
        ) : <EmptyState text="No reports for this project yet." />}
      </Section>

      <Section title="ChatGPT conversations">
        {conversations.length ? (
          <Group>
            {conversations.map((c) => (
              <Row
                key={c.id}
                title={c.title}
                subtitle={c.id === project.preferredConversationId ? 'Preferred for this project' : null}
                accessibilityHint="Opens the conversation in ChatGPT"
                trailing={<Icon name="external" size={18} color={colors.text3} />}
                onPress={() => { void open(c.url); }}
              />
            ))}
          </Group>
        ) : <EmptyState text="No ChatGPT conversation is set for this project. Add one in Mini-Summa on your PC." />}
        {linkError ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{linkError}</Text> : null}
      </Section>
    </Screen>
  );
}
