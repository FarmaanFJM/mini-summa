// Extension point: the second UI worker replaces this placeholder with the report list, the handoff steps and the review
// states. The shell renders it for the 'reports' route (route.reportId / route.deliveryId say what to open).
import type { DeliveryState } from '@minisumma/shared';
import { useApp } from '../../app/runtime';
import { EmptyState } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';

const DELIVERY_TEXT: Record<DeliveryState, string> = {
  report_captured: 'Captured',
  destination_missing: 'No conversation mapped',
  destination_unverified: 'Conversation not verified',
  ready_for_handoff: 'Ready for handoff',
  copied: 'Copied, not sent',
  awaiting_user_send: 'Waiting for you to send it',
  user_confirmed_sent: 'You said it was sent',
  delivery_uncertain: 'Uncertain',
  user_discarded: 'Discarded',
};

export default function ReportsView() {
  const reports = useApp((s) => s.reports);
  const status = useApp((s) => s.listStatus.reports);
  return (
    <section className="ms-view" aria-label="Reports">
      <header className="ms-view__head"><h1 className="ms-view__title">Reports</h1></header>
      <div className="ms-view__body">
        {status === 'loading' || status === 'idle' ? (
          <div className="ms-skeleton-list" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="ms-skeleton-row" />)}</div>
        ) : reports.length === 0 ? (
          <EmptyState>No reports yet. A report appears when Claude ends a task with the report marker.</EmptyState>
        ) : (
          <ul className="ms-list">
            {reports.map((r) => (
              <li key={r.id} className="ms-list__row ms-list__row--static">
                <span className="ms-list__title">{r.taskTitle}</span>
                <span className="ms-list__meta">{r.projectName ?? ''}</span>
                <span className="ms-list__meta">{r.delivery ? DELIVERY_TEXT[r.delivery.state] : 'No delivery'}</span>
                <span className="ms-list__meta">{formatRelative(r.capturedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
