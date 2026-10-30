// The activity feed. Filters live in a sheet (secondary controls stay out of the way); the feed itself shows plain
// rows. Tapping a row marks it read and opens the thing it is about.
import { useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useConnection, useConnectionApi } from '../connection/context.tsx';
import { describeApiError } from '../lib/errors.ts';
import { formatWhen } from '../lib/format.ts';
import { useNav } from '../nav.ts';
import { activityTarget, filterActivity, NO_ACTIVITY_FILTER } from '../state/selectors.ts';
import type { ActivityFilter } from '../state/selectors.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState, Group, IconButton, Row, Screen, TabHeader } from '../ui/layout.tsx';
import { LoadingLine } from '../ui/LoadingLine.tsx';
import { Sheet, SheetOption } from '../ui/overlays.tsx';
import { Text } from '../ui/Text.tsx';

type Show = 'all' | 'needs_action' | 'unread';

export function describeFilter(f: ActivityFilter, projectName: string | null): string | null {
  const parts: string[] = [];
  if (f.needsAction) parts.push('Needs action');
  if (f.unread) parts.push('Unread');
  if (f.projectId) parts.push(projectName ?? 'One project');
  return parts.length ? parts.join(', ') : null;
}

export function ActivityScreen() {
  const api = useConnectionApi();
  const snap = useConnection();
  const nav = useNav();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const { state } = snap;
  const [filter, setFilter] = useState<ActivityFilter>(NO_ACTIVITY_FILTER);
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const rows = useMemo(() => filterActivity(state.activity, filter), [state.activity, filter]);
  const show: Show = filter.needsAction ? 'needs_action' : filter.unread ? 'unread' : 'all';
  const projectName = state.projects.find((p) => p.id === filter.projectId)?.name ?? null;
  const filterText = describeFilter(filter, projectName);
  const unreadCount = state.activity.filter((a) => !a.read).length;

  const setShow = (next: Show) => setFilter((f) => ({ ...f, needsAction: next === 'needs_action', unread: next === 'unread' }));

  const markRead = async (body: { ids?: string[]; all?: boolean; projectId?: string }) => {
    try { await api.call('activity.markRead', { body }); setError(null); } catch (err) { setError(describeApiError(err)); }
  };

  const open = (id: string) => {
    const a = state.activity.find((x) => x.id === id);
    if (!a) return;
    if (!a.read) void markRead({ ids: [a.id] });
    const target = activityTarget(a, state);
    if (target) nav.push(target);
  };

  const more = async () => {
    setLoadingMore(true);
    try { await api.loadMoreActivity(); } catch (err) { setError(describeApiError(err)); } finally { setLoadingMore(false); }
  };

  return (
    <Screen topInset onRefresh={() => api.refresh()}>
      <TabHeader title="Activity" right={<IconButton icon="filter" label="Filter activity" onPress={() => setSheet(true)} testID="activity-filter" />} />
      {filterText ? <Text variant="secondary" testID="activity-filter-text">{`Showing: ${filterText}`}</Text> : null}

      {!state.loaded ? <LoadingLine /> : rows.length ? (
        <Group>
          {rows.map((a) => (
            <Row
              key={a.id}
              title={a.title}
              subtitle={a.description}
              meta={`${a.projectName ?? 'No project'} · ${formatWhen(a.at)}`}
              marker={a.requiresAction && a.resolvedAt === null ? 'attention' : a.read ? null : 'unread'}
              selected={focus === a.id}
              onPress={() => open(a.id)}
            />
          ))}
        </Group>
      ) : (
        <EmptyState
          text={filterText ? 'Nothing matches these filters.' : 'No activity yet.'}
          action={filterText ? <Button label="Clear filters" onPress={() => setFilter(NO_ACTIVITY_FILTER)} /> : undefined}
        />
      )}

      {snap.activityNext ? <Button label="Load older activity" onPress={() => { void more(); }} busy={loadingMore} /> : null}
      {error ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{error}</Text> : null}

      <Sheet visible={sheet} title="Filter activity" onClose={() => setSheet(false)}>
        <SheetOption label="Everything" selected={show === 'all'} onPress={() => setShow('all')} />
        <SheetOption label="Needs action" selected={show === 'needs_action'} onPress={() => setShow('needs_action')} />
        <SheetOption label="Unread" selected={show === 'unread'} onPress={() => setShow('unread')} />
        <Text variant="heading" style={{ paddingHorizontal: 8, paddingTop: 12 }}>Project</Text>
        <SheetOption label="All projects" selected={!filter.projectId} onPress={() => setFilter((f) => ({ ...f, projectId: null }))} />
        {state.projects.filter((p) => p.archivedAt === null).map((p) => (
          <SheetOption key={p.id} label={p.name} selected={filter.projectId === p.id} onPress={() => setFilter((f) => ({ ...f, projectId: p.id }))} />
        ))}
        <Text variant="heading" style={{ paddingHorizontal: 8, paddingTop: 12 }}>Read state</Text>
        <SheetOption
          label={unreadCount ? `Mark all as read (${unreadCount})` : 'Mark all as read'}
          icon="check"
          onPress={() => { setSheet(false); void markRead({ all: true, projectId: filter.projectId ?? undefined }); }}
        />
      </Sheet>
    </Screen>
  );
}

