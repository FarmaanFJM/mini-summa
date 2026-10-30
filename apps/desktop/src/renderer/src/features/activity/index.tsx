// Extension point: the second UI worker replaces this placeholder with the real activity feed. The shell renders it for
// the 'activity' route. Until then it lists what the core has recorded, as plain rows.
import { useApp, useRoute } from '../../app/runtime';
import { EmptyState } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';

export default function ActivityView() {
  const activity = useApp((s) => s.activity);
  const status = useApp((s) => s.listStatus.activity);
  const route = useRoute();
  return (
    <section className="ms-view" aria-label="Activity">
      <header className="ms-view__head"><h1 className="ms-view__title">Activity</h1></header>
      <div className="ms-view__body">
        {status === 'loading' || status === 'idle' ? (
          <div className="ms-skeleton-list" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="ms-skeleton-row" />)}</div>
        ) : activity.length === 0 ? (
          <EmptyState>Nothing has happened yet. Events from your Claude sessions appear here.</EmptyState>
        ) : (
          <ul className="ms-list">
            {activity.map((a) => (
              <li key={a.id}>
                <button type="button" className="ms-list__row" onClick={() => route.go({ view: 'workspace', projectId: a.projectId ?? undefined, sessionKey: a.sessionKey ?? undefined })}>
                  <span className="ms-list__title" data-unread={!a.read || undefined}>{a.title}</span>
                  <span className="ms-list__meta">{a.projectName ?? ''}</span>
                  <span className="ms-list__meta">{formatRelative(a.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
