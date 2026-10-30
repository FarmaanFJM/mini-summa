import { useState } from 'react';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { declaredStatusText, deliveryText, formatWhen } from '../lib/format.ts';
import { describeApiError } from '../lib/errors.ts';
import { go, useNav } from '../nav.ts';
import { sortedReports } from '../state/selectors.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState, Group, Row, Screen, TabHeader } from '../ui/layout.tsx';
import { LoadingLine } from '../ui/LoadingLine.tsx';
import { Text } from '../ui/Text.tsx';

export function ReportsScreen() {
  const api = useConnectionApi();
  const snap = useConnection();
  const nav = useNav();
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const reports = sortedReports(snap.state);

  const more = async () => {
    setLoadingMore(true);
    setMoreError(null);
    try { await api.loadMoreReports(); } catch (err) { setMoreError(describeApiError(err)); } finally { setLoadingMore(false); }
  };

  return (
    <Screen topInset onRefresh={() => api.refresh()}>
      <TabHeader title="Reports" />
      {!snap.state.loaded ? <LoadingLine /> : reports.length ? (
        <Group>
          {reports.map((r) => (
            <Row
              key={r.id}
              title={r.taskTitle}
              subtitle={declaredStatusText[r.declaredStatus]}
              meta={`${r.projectName ?? 'No project'} · ${formatWhen(r.capturedAt)} · ${deliveryText(r.delivery)}`}
              marker={r.read ? null : 'unread'}
              onPress={() => nav.push(go.report(r.id))}
            />
          ))}
        </Group>
      ) : (
        <EmptyState text="No reports yet. They appear here when a Claude session declares one." />
      )}
      {snap.reportsNext ? <Button label="Load older reports" onPress={() => { void more(); }} busy={loadingMore} /> : null}
      {moreError ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{moreError}</Text> : null}
    </Screen>
  );
}
