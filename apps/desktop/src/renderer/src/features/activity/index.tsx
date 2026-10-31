// Activity: what happened, across every project, and what waits for the person.
//   Feed            chronological, grouped by day, filterable, with unread state that survives a restart
//   Needs you       requests waiting for approval, and entries that still ask something of the person
//   Notifications   every notification Mini-Summa considered and what became of it
import '../reports/shared.css';
import './activity.css';
import { useState } from 'react';
import { useApi, useApp, useRoute } from '../../app/runtime';
import { Button, Section, Tabs, tabPanelProps, toast } from '../../ui';
import { errorText } from '../reports/support';
import { PendingActionsInbox } from '../reports/PendingActions';
import { Feed, NO_FILTERS } from './Feed';
import type { FeedFilters } from './Feed';
import { NotificationList } from './Notifications';

type TabId = 'feed' | 'needs-you' | 'notifications';
const TABS: readonly TabId[] = ['feed', 'needs-you', 'notifications'];

export default function ActivityView() {
  const api = useApi();
  const route = useRoute();
  const counts = useApp((s) => s.counts);
  const projects = useApp((s) => s.projects);
  const [filters, setFilters] = useState<FeedFilters>(NO_FILTERS);
  const [marking, setMarking] = useState(false);

  const tab: TabId = (TABS as readonly string[]).includes(route.section ?? '') ? (route.section as TabId) : 'feed';
  const needs = Math.max(counts.actionsNeeded, counts.pendingActions);
  const scoped = filters.projectId !== 'all' ? projects.find((p) => p.id === filters.projectId) : undefined;

  const markAllRead = async () => {
    setMarking(true);
    try {
      await api.call('activity.markRead', { body: scoped ? { projectId: scoped.id } : { all: true } });
    } catch (err) {
      toast({ title: 'Could not mark activity as read', body: errorText(err), kind: 'error' });
    } finally {
      setMarking(false);
    }
  };

  return (
    <section className="ms-view ms-act-view" aria-label="Activity">
      <header className="ms-view__head">
        <h1 className="ms-view__title">Activity</h1>
        <Tabs
          label="Activity"
          idPrefix="activity"
          value={tab}
          onChange={(id) => route.go({ section: id })}
          items={[
            { id: 'feed', label: 'Feed' },
            { id: 'needs-you', label: needs > 0 ? `Needs you (${needs})` : 'Needs you' },
            { id: 'notifications', label: 'Notifications' },
          ]}
        />
        <div className="ms-x-head-actions">
          {tab === 'feed' ? (
            <Button variant="ghost" icon="check" loading={marking} disabled={counts.unreadActivity === 0} onClick={() => { void markAllRead(); }}>
              {scoped ? `Mark all in ${scoped.name} read` : 'Mark all read'}
            </Button>
          ) : null}
        </div>
      </header>
      <div className="ms-view__body ms-act-body" {...tabPanelProps('activity', tab)}>
        {tab === 'feed' ? (
          <Feed filters={filters} onFilters={setFilters} label="Activity feed" emptyText="Nothing has happened yet. Events from your Claude sessions appear here." />
        ) : null}
        {tab === 'needs-you' ? (
          <div className="ms-x-stack">
            <PendingActionsInbox />
            <Section title="Needs your attention">
              <Feed filters={NO_FILTERS} onlyOpen label="Entries that need you" emptyText="Nothing needs you right now." />
            </Section>
          </div>
        ) : null}
        {tab === 'notifications' ? <NotificationList /> : null}
      </div>
    </section>
  );
}
