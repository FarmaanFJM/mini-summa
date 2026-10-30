import type { ReportSummary } from '@minisumma/shared';
import { useMemo, useState } from 'react';
import { activeProjects, isAwaitingHandoff } from '../../app/selectors';
import { useApi, useApp, useRuntime } from '../../app/runtime';
import { Button, EmptyState, Select, Tabs, Tag, tabPanelProps } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { CandidateList, useCandidates } from './Candidates';
import { DECLARED_TEXT, declaredPhrase, queueDeliveryLabel } from './model';
import { errorText } from './support';

export type QueueMode = 'reports' | 'other';

export interface ReportQueueProps {
  mode: QueueMode;
  onMode: (mode: QueueMode) => void;
  selectedReportId: string | null;
  onSelectReport: (id: string) => void;
  selectedCandidateId: string | null;
  onSelectCandidate: (id: string) => void;
}

/** The label a screen reader gets for a row: everything the row shows, in the order it matters. */
export function rowLabel(r: ReportSummary): string {
  return [r.taskTitle, r.projectName ?? 'No project', DECLARED_TEXT[r.declaredStatus], formatRelative(r.capturedAt), queueDeliveryLabel(r.delivery), r.read ? '' : 'Unread'].filter(Boolean).join(', ');
}

const PAGE = 50;

/** Reports across all projects, newest first, with the project that owns each. Lives in the replaced sidebar. */
export function ReportQueue({ mode, onMode, selectedReportId, onSelectReport, selectedCandidateId, onSelectCandidate }: ReportQueueProps) {
  const api = useApi();
  const { loader } = useRuntime();
  const reports = useApp((s) => s.reports);
  const projects = useApp((s) => s.projects);
  const status = useApp((s) => s.listStatus.reports);
  const listError = useApp((s) => s.listErrors.reports);
  const candidates = useCandidates(true);
  const unmarked = candidates.items ? candidates.items.length : null;

  const [projectId, setProjectId] = useState<string>('all');
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [older, setOlder] = useState<{ items: ReportSummary[]; next: string | null; asked: boolean }>({ items: [], next: null, asked: false });
  const [olderError, setOlderError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const all = useMemo(() => {
    const seen = new Set(reports.map((r) => r.id));
    return [...reports, ...older.items.filter((r) => !seen.has(r.id))].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id));
  }, [reports, older.items]);
  const visible = useMemo(
    () => all.filter((r) => (projectId === 'all' || r.projectId === projectId) && (!waitingOnly || isAwaitingHandoff(r))),
    [all, projectId, waitingOnly],
  );
  const waiting = useMemo(() => all.filter(isAwaitingHandoff).length, [all]);
  const filtered = projectId !== 'all' || waitingOnly;
  const choices = useMemo(() => activeProjects(projects), [projects]);

  // The store holds the newest page. More can exist when it is full; the cursor comes from asking for that page once.
  const mayHaveMore = reports.length >= 200 && (!older.asked || older.next !== null);
  const loadOlder = async () => {
    setLoadingOlder(true);
    setOlderError(null);
    try {
      let cursor = older.next;
      if (!older.asked) cursor = (await api.call('reports.list', { query: { limit: 200 } })).nextBefore;
      if (cursor === null) { setOlder((o) => ({ ...o, asked: true, next: null })); return; }
      const page = await api.call('reports.list', { query: { limit: PAGE, before: cursor } });
      setOlder((o) => ({ items: [...o.items, ...page.items], next: page.nextBefore, asked: true }));
    } catch (err) {
      setOlderError(errorText(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const tabs = [
    { id: 'reports', label: 'Reports' },
    { id: 'other', label: unmarked ? `Other messages (${unmarked})` : 'Other messages' },
  ];

  return (
    <div className="ms-rep-queue">
      <Tabs items={tabs} value={mode} onChange={(id) => onMode(id as QueueMode)} label="Kind of message" idPrefix="reports-kind" className="ms-rep-tabs" />
      <div {...tabPanelProps('reports-kind', mode)} className="ms-rep-queue__panel">
        {mode === 'other' ? (
          <CandidateList items={candidates.items} error={candidates.error} selectedId={selectedCandidateId} onSelect={onSelectCandidate} onRetry={() => { void candidates.reload(); }} />
        ) : (
          <>
            <div className="ms-rep-filters">
              <Select
                quiet
                aria-label="Project"
                value={projectId}
                onChange={setProjectId}
                options={[{ value: 'all', label: 'All projects' }, ...choices.map((p) => ({ value: p.id, label: p.name }))]}
              />
              <Tag onClick={() => setWaitingOnly((v) => !v)} selected={waitingOnly} icon="clock">{`Waiting for handoff (${waiting})`}</Tag>
            </div>
            {status === 'idle' || status === 'loading' ? (
              <div className="ms-skeleton-list" aria-busy="true" aria-label="Loading reports">{[0, 1, 2, 3].map((i) => <div key={i} className="ms-skeleton-row ms-rep-skeleton" />)}</div>
            ) : status === 'error' && reports.length === 0 ? (
              <EmptyState tone="error" action={<Button size="sm" onClick={() => { void loader.reloadList('reports'); }}>Try again</Button>}>Reports could not be loaded. {listError}</EmptyState>
            ) : visible.length === 0 ? (
              filtered ? (
                <EmptyState action={<Button size="sm" onClick={() => { setProjectId('all'); setWaitingOnly(false); }}>Clear filters</Button>}>No reports match these filters.</EmptyState>
              ) : (
                <EmptyState>No reports yet. A report appears when Claude ends a task with the report marker.</EmptyState>
              )
            ) : (
              <ul className="ms-rep-list" aria-label="Reports">
                {visible.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="ms-rep-row" aria-current={r.id === selectedReportId ? 'true' : undefined} aria-label={rowLabel(r)} onClick={() => onSelectReport(r.id)}>
                      <span className="ms-rep-row__title" data-unread={!r.read || undefined}>
                        {!r.read ? <span className="ms-dot ms-rep-row__dot" data-tone="unread" aria-hidden="true" /> : null}
                        <span className="ms-rep-row__text">{r.taskTitle}</span>
                      </span>
                      <span className="ms-rep-row__meta">{r.projectName ?? 'No project'}, {declaredPhrase(r.declaredStatus)}, {formatRelative(r.capturedAt)}</span>
                      <span className="ms-rep-row__state">{queueDeliveryLabel(r.delivery)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {olderError ? <p className="ms-x-error" role="alert">{olderError}</p> : null}
            {mayHaveMore ? <div className="ms-rep-more-row"><Button size="sm" loading={loadingOlder} onClick={() => { void loadOlder(); }}>Show older reports</Button></div> : null}
          </>
        )}
      </div>
    </div>
  );
}
