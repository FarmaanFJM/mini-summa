import { useMemo } from 'react';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { plural, sessionMeta, sessionTarget } from '../lib/format.ts';
import { useNav, go } from '../nav.ts';
import { needsYouItems, projectCards, unassignedLiveSessions } from '../state/selectors.ts';
import { EmptyState, Group, Row, Screen, Section, TabHeader } from '../ui/layout.tsx';
import { LoadingLine } from '../ui/LoadingLine.tsx';

export function HomeScreen() {
  const api = useConnectionApi();
  const snap = useConnection();
  const nav = useNav();
  const { state } = snap;
  const needs = useMemo(() => needsYouItems(state), [state]);
  const cards = useMemo(() => projectCards(state), [state]);
  const loose = useMemo(() => unassignedLiveSessions(state), [state]);
  const live = snap.status === 'connected';

  return (
    <Screen topInset onRefresh={() => api.refresh()}>
      <TabHeader title="Mini-Summa" />
      {!state.loaded ? <LoadingLine /> : (
        <>
          <Section title="Needs you">
            {needs.length ? (
              <Group>
                {needs.map((item) => (
                  <Row key={item.id} title={item.title} subtitle={item.subtitle} marker="attention" onPress={() => nav.push(item.target)} />
                ))}
              </Group>
            ) : (
              <EmptyState text={live ? 'Nothing needs you right now.' : 'Nothing needed you at the last update.'} />
            )}
          </Section>

          <Section title="Projects">
            {cards.length ? (
              <Group>
                {cards.map(({ project, liveSessions, needsYou, unreadReports }) => (
                  <Row
                    key={project.id}
                    title={project.name}
                    subtitle={liveSessions ? plural(liveSessions, 'live session') : 'No live sessions'}
                    meta={unreadReports ? plural(unreadReports, 'unread report') : null}
                    marker={needsYou ? 'attention' : null}
                    onPress={() => nav.push(go.project(project.id))}
                  />
                ))}
              </Group>
            ) : (
              <EmptyState text="No projects yet. Add one in Mini-Summa on your PC." />
            )}
          </Section>

          {loose.length ? (
            <Section title="Not in a project">
              <Group>
                {loose.map((s) => (
                  <Row key={s.key} title={sessionTarget(s)} subtitle={sessionMeta(s)} onPress={() => nav.push(go.session(s.key))} />
                ))}
              </Group>
            </Section>
          ) : null}
        </>
      )}
    </Screen>
  );
}
