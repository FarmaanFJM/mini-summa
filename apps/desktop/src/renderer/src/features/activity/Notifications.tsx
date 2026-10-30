import { useMemo } from 'react';
import { useApp, useRoute, useRuntime } from '../../app/runtime';
import { Button, EmptyState } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { groupByDay, notificationOutcome, spoken } from './model';

/**
 * Every notification Mini-Summa considered, with what became of it on this PC and on the phone: shown, held back by quiet
 * mode, off for the project, a duplicate, or not possible. A notification that was not shown is listed too, so the person
 * can see why nothing popped up.
 */
export function NotificationList() {
  const items = useApp((s) => s.notifications);
  const status = useApp((s) => s.listStatus.notifications);
  const error = useApp((s) => s.listErrors.notifications);
  const route = useRoute();
  const { loader } = useRuntime();
  const groups = useMemo(() => groupByDay(items), [items]);

  if (status === 'idle' || status === 'loading') {
    return <div className="ms-skeleton-list ms-skeleton-list--wide" aria-busy="true" aria-label="Loading notifications">{[0, 1, 2, 3].map((i) => <div key={i} className="ms-skeleton-row" />)}</div>;
  }
  if (status === 'error' && items.length === 0) {
    return <EmptyState tone="error" action={<Button onClick={() => { void loader.reloadList('notifications'); }}>Try again</Button>}>Notifications could not be loaded. {error}</EmptyState>;
  }
  if (items.length === 0) return <EmptyState>No notifications yet. Each one is listed here, including the ones that were not shown.</EmptyState>;

  return (
    <div className="ms-act-groups">
      {groups.map((g) => (
        <section key={g.key} className="ms-act-day" aria-label={g.label}>
          <h2 className="ms-act-day__title">{g.label}</h2>
          <ul className="ms-act-list" aria-label={`Notifications, ${g.label}`}>
            {g.items.map((n) => {
              const outcome = notificationOutcome(n);
              return (
                <li key={n.id} className="ms-act">
                  <button type="button" className="ms-act__main" aria-label={spoken([n.title, n.body, ...outcome, formatRelative(n.at)])} onClick={() => route.go(n.target)}>
                    <span className="ms-act__marker" aria-hidden="true" />
                    <span className="ms-act__body">
                      <span className="ms-act__title">{n.title}</span>
                      <span className="ms-act__desc">{n.body}</span>
                      <span className="ms-act__meta">{outcome.join('. ')}</span>
                    </span>
                    <time className="ms-act__time" dateTime={n.at}>{formatRelative(n.at)}</time>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
