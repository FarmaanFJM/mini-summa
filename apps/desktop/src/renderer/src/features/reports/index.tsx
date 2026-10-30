// Reports: what Claude declared finished, and the honest handoff of each report to the ChatGPT conversation it belongs to.
// The queue replaces the sidebar (principle 14); the report, its handoff and its review fill the main area.
import './shared.css';
import './reports.css';
import { useMemo, useState } from 'react';
import { isAwaitingHandoff } from '../../app/selectors';
import { useApp, useRoute } from '../../app/runtime';
import { EmptyState } from '../../ui';
import { pluralize } from '../text';
import { SidebarContent } from '../shell/SidebarSlot';
import { CandidateDetail, useCandidates } from './Candidates';
import { ReportDetail } from './ReportDetail';
import { ReportQueue } from './ReportQueue';
import type { QueueMode } from './ReportQueue';

export { PendingActionsInbox } from './PendingActions';

export default function ReportsView() {
  const route = useRoute();
  const deliveries = useApp((s) => s.deliveries);
  const reports = useApp((s) => s.reports);
  const [mode, setMode] = useState<QueueMode>('reports');
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const candidates = useCandidates(mode === 'other');

  // A notification names a delivery, a click on a feed entry names a report: both lead to the same screen.
  const reportId = route.reportId ?? (route.deliveryId ? deliveries.find((d) => d.id === route.deliveryId)?.reportId ?? null : null);
  const candidate = candidates.items?.find((c) => c.id === candidateId) ?? null;
  const waiting = useMemo(() => reports.filter(isAwaitingHandoff).length, [reports]);

  return (
    <section className="ms-view ms-rep" aria-label="Reports">
      <SidebarContent title="Reports" onBack={() => route.back()}>
        <ReportQueue
          mode={mode}
          onMode={setMode}
          selectedReportId={reportId}
          onSelectReport={(id) => route.go({ reportId: id, deliveryId: undefined })}
          selectedCandidateId={candidateId}
          onSelectCandidate={setCandidateId}
        />
      </SidebarContent>
      {mode === 'other' ? (
        <CandidateDetail
          candidate={candidate}
          onPromoted={(report) => { setMode('reports'); setCandidateId(null); void candidates.reload(); route.go({ reportId: report.id }); }}
        />
      ) : reportId ? (
        <ReportDetail key={reportId} reportId={reportId} />
      ) : (
        <>
          <header className="ms-view__head"><h1 className="ms-view__title">Reports</h1></header>
          <div className="ms-view__body">
            <EmptyState>
              {waiting > 0
                ? `${pluralize(waiting, 'report')} ${waiting === 1 ? 'is' : 'are'} waiting for handoff. Choose one to read it and hand it to ChatGPT.`
                : 'Choose a report to read it. Nothing is waiting for handoff.'}
            </EmptyState>
          </div>
        </>
      )}
    </section>
  );
}
