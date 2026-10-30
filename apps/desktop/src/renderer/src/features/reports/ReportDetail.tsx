import { envLabel, shortSessionId } from '@minisumma/shared';
import type { Delivery, Report } from '@minisumma/shared';
import { useEffect, useRef, useState } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp, useRoute } from '../../app/runtime';
import { Button, CopyButton, EmptyState, Tabs, tabPanelProps, toast } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { HandoffCard } from './HandoffCard';
import { useDelivery, useReport } from './hooks';
import { DECLARED_TEXT, formatWhen } from './model';
import { ReportText } from './ReportText';
import { hasReview, ReviewPanel } from './ReviewPanel';
import { useRunner } from './support';

export function ReportDetail({ reportId }: { reportId: string }) {
  const api = useApi();
  const native = useNative();
  const route = useRoute();
  const loaded = useReport(reportId);
  const summary = useApp((s) => s.reports.find((r) => r.id === reportId) ?? null);
  const session = useApp((s) => {
    const key = summary?.sessionKey ?? (loaded.status === 'ready' ? loaded.value.sessionKey : null);
    return key ? s.sessions.find((x) => x.key === key) ?? null : null;
  });
  const saveAllowed = useApp((s) => s.system?.nativeCapabilities.saveFile !== false);
  const runner = useRunner();
  const [created, setCreated] = useState<Delivery | null>(null);
  const [tab, setTab] = useState<'report' | 'review' | null>(null);
  useEffect(() => { setCreated(null); setTab(null); }, [reportId]);

  const report: Report | null = loaded.status === 'ready' ? loaded.value : null;
  const deliveryId = summary?.delivery?.id ?? report?.delivery?.id ?? created?.id ?? null;
  const delivery = useDelivery(deliveryId) ?? (created && created.id === deliveryId ? created : null);

  // Once the message was sent the review is what needs the person, so it opens first; the report is one tab away. The
  // choice is made when the report opens, or when the person says "I sent it" in this view, and never changes under them.
  const reviewing = delivery !== null && hasReview(delivery);
  const opening = useRef<'report' | 'review' | null>(null);
  if (opening.current === null && delivery) opening.current = reviewing && delivery.review !== 'closed' && delivery.review !== 'follow_up_sent' ? 'review' : 'report';
  const wasReviewing = useRef(reviewing);
  useEffect(() => {
    if (reviewing && !wasReviewing.current && tab === null) setTab('review');
    wasReviewing.current = reviewing;
  }, [reviewing, tab]);
  const shown = reviewing ? tab ?? opening.current ?? 'report' : 'report';

  // Opening a report is reading it.
  const unread = summary !== null && !summary.read;
  useEffect(() => {
    if (!report || !unread) return;
    api.call('reports.markRead', { params: { id: reportId } }).catch(() => { /* reading it is not worth a message if the mark fails */ });
  }, [api, reportId, report, unread]);

  if (loaded.status === 'missing') {
    return (
      <section className="ms-view" aria-label="Report">
        <header className="ms-view__head"><h1 className="ms-view__title">Report not found</h1></header>
        <div className="ms-view__body"><EmptyState>This report no longer exists. It may have been removed by the retention rules in Settings.</EmptyState></div>
      </section>
    );
  }
  if (loaded.status === 'error') {
    return (
      <section className="ms-view" aria-label="Report">
        <header className="ms-view__head"><h1 className="ms-view__title">Report</h1></header>
        <div className="ms-view__body"><EmptyState tone="error" action={<Button onClick={loaded.reload}>Try again</Button>}>The report could not be loaded. {loaded.error}</EmptyState></div>
      </section>
    );
  }
  if (!report) {
    return (
      <section className="ms-view" aria-label="Report">
        <header className="ms-view__head"><h1 className="ms-view__title ms-truncate">{summary?.taskTitle ?? 'Report'}</h1></header>
        <div className="ms-view__body" aria-busy="true"><div className="ms-skeleton-list ms-skeleton-list--wide">{[0, 1, 2, 3].map((i) => <div key={i} className="ms-skeleton-row" />)}</div></div>
      </section>
    );
  }

  const saveFile = () => runner.run('save', async () => {
    if (!delivery) return;
    const result = await api.call('deliveries.saveFile', { params: { id: delivery.id } });
    if (result.path === null) return; // the save dialog was closed
    toast({ title: 'Saved as a file', body: result.path, kind: 'success' });
    await native.shell.showItemInFolder(result.path).catch(() => { /* a browser cannot reveal a file; the path is in the notice */ });
  });

  const openProject = () => { if (report.projectId) route.go({ view: 'workspace', projectId: report.projectId }); };
  const openSession = () => route.go({ view: 'workspace', projectId: report.projectId ?? undefined, sessionKey: report.sessionKey });
  const shortId = shortSessionId(report.sessionKey);
  const origin = session ? `${session.origin === 'managed' ? 'managed' : 'observed'}, ${envLabel(session.env)}` : envLabel(report.env);

  return (
    <section className="ms-view ms-rep-detail" aria-label="Report">
      <header className="ms-view__head">
        <h1 className="ms-view__title ms-truncate" title={report.taskTitle}>{report.taskTitle}</h1>
        <div className="ms-x-head-actions">
          <CopyButton text={report.body} variant="ghost">Copy full report text</CopyButton>
          {delivery ? (
            <Button variant="ghost" icon="download" loading={runner.busy === 'save'} disabled={!saveAllowed} title="Saves the whole message prepared for ChatGPT, with the review request" onClick={() => { void saveFile(); }}>Save as file</Button>
          ) : null}
        </div>
      </header>
      <div className="ms-view__body ms-rep-scroll">
        <div className="ms-rep-layout">
          <div className="ms-rep-doc">
            {runner.error ? <p className="ms-x-error" role="alert">{runner.error}</p> : null}
            <dl className="ms-x-kv" aria-label="About this report">
              <dt>Project</dt>
              <dd>{report.projectId ? <button type="button" className="ms-x-linkbtn" onClick={openProject}>{report.projectName ?? 'Open project'}</button> : 'No project'}</dd>
              <dt>Session</dt>
              <dd><button type="button" className="ms-x-linkbtn ms-mono" onClick={openSession} aria-label={`Open session ${shortId}`}>{shortId}</button>, {origin}, generation {report.generation}</dd>
              <dt>Captured</dt>
              <dd title={formatWhen(report.capturedAt)}>{formatRelative(report.capturedAt)}</dd>
              <dt>Status</dt>
              <dd>{DECLARED_TEXT[report.declaredStatus]}. This is a claim by the model, not proof that the work was done or tested.</dd>
              {report.source === 'user_promoted' ? (<><dt>Origin</dt><dd>A final message without a report marker. You made it a report.</dd></>) : null}
            </dl>
            {reviewing ? (
              <Tabs
                label="Report or review"
                idPrefix="report-view"
                value={shown}
                onChange={(id) => setTab(id as 'report' | 'review')}
                items={[{ id: 'report', label: 'Report' }, { id: 'review', label: 'Review' }]}
                className="ms-rep-doctabs"
              />
            ) : null}
            <div {...tabPanelProps('report-view', shown)} className="ms-rep-panel">
              {shown === 'review' && delivery ? (
                <ReviewPanel delivery={delivery} reportId={report.id} reportSessionKey={report.sessionKey} reportGeneration={report.generation} />
              ) : (
                <>
                  {report.late ? <div className="ms-notice" data-tone="attention"><span className="ms-notice__text">This message belongs to an earlier prompt or an earlier run of the session, so it may not describe the latest work.</span></div> : null}
                  {report.redactions && report.redactions > 0 ? (
                    <div className="ms-notice" data-tone="attention">
                      <span className="ms-notice__text">{report.redactions === 1 ? '1 credential-like string was' : `${report.redactions} credential-like strings were`} hidden when this report was captured.</span>
                    </div>
                  ) : null}
                  <ReportText text={report.body} />
                </>
              )}
            </div>
          </div>
          <aside className="ms-rep-side" aria-label="Handoff and review">
            <HandoffCard report={report} delivery={delivery} onCreated={setCreated} />
          </aside>
        </div>
      </div>
    </section>
  );
}
