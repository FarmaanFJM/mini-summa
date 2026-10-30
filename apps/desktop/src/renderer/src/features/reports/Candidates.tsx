import { envLabel, shortSessionId } from '@minisumma/shared';
import type { Report, ReportCandidate } from '@minisumma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { Button, ConfirmDialog, EmptyState, toast } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { DECLARED_TEXT, formatWhen } from './model';
import { ReportText } from './ReportText';
import { errorText } from './support';

/** Final messages that did not satisfy the report protocol. Kept, never discarded, and promotable by the person. */
export function useCandidates(active: boolean): { items: ReportCandidate[] | null; error: string | null; reload(): Promise<void> } {
  const api = useApi();
  const reportCount = useApp((s) => s.reports.length);
  const [items, setItems] = useState<ReportCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setItems(await api.call('candidates.list', { query: {} })); setError(null); } catch (err) { setError(errorText(err)); }
  }, [api]);
  useEffect(() => { if (active) void reload(); }, [active, reload, reportCount]);
  return { items, error, reload };
}

export const candidateTitle = (c: ReportCandidate): string => c.taskTitle?.trim() || c.body.replace(/^[\s#>*-]+/, '').split('\n')[0].slice(0, 90) || 'Final message';

export interface CandidateListProps {
  items: ReportCandidate[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}

export function CandidateList({ items, error, selectedId, onSelect, onRetry }: CandidateListProps) {
  if (error && !items) return <EmptyState tone="error" action={<Button size="sm" onClick={onRetry}>Try again</Button>}>Other final messages could not be loaded. {error}</EmptyState>;
  if (!items) return <div className="ms-skeleton-list" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="ms-skeleton-row" />)}</div>;
  if (items.length === 0) return <EmptyState>Every final message so far carried the report marker.</EmptyState>;
  return (
    <ul className="ms-rep-list" aria-label="Other final messages">
      {items.map((c) => (
        <li key={c.id}>
          <button type="button" className="ms-rep-row" aria-current={c.id === selectedId ? 'true' : undefined} onClick={() => onSelect(c.id)}>
            <span className="ms-rep-row__title">{candidateTitle(c)}</span>
            <span className="ms-rep-row__meta">{c.projectName ?? 'No project'}, {formatRelative(c.capturedAt)}</span>
            <span className="ms-rep-row__state">{c.reason}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface CandidateDetailProps {
  candidate: ReportCandidate | null;
  onPromoted: (report: Report) => void;
}

export function CandidateDetail({ candidate, onPromoted }: CandidateDetailProps) {
  const api = useApi();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setAsking(false); setError(null); }, [candidate?.id]);

  if (!candidate) {
    return (
      <section className="ms-view" aria-label="Final message">
        <header className="ms-view__head"><h1 className="ms-view__title">Other final messages</h1></header>
        <div className="ms-view__body"><EmptyState>Choose a message to read it. These are final messages that did not carry the report marker.</EmptyState></div>
      </section>
    );
  }

  const promote = async () => {
    setBusy(true);
    setError(null);
    try {
      const report = await api.call('candidates.promote', { params: { id: candidate.id } });
      setAsking(false);
      toast({ title: 'Made it a report', body: report.taskTitle, kind: 'success' });
      onPromoted(report);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ms-view ms-rep-detail" aria-label="Final message">
      <header className="ms-view__head">
        <h1 className="ms-view__title ms-truncate">{candidateTitle(candidate)}</h1>
        <div className="ms-x-head-actions">
          <Button variant="primary" icon="file-text" onClick={() => setAsking(true)}>Make this a report</Button>
        </div>
      </header>
      <div className="ms-view__body ms-rep-scroll">
        <div className="ms-rep-doc">
          <div className="ms-notice" data-tone="attention"><span className="ms-notice__text">Not a report: {candidate.reason} Mini-Summa kept the message, and you decide whether it counts as a report.</span></div>
          <dl className="ms-x-kv">
            <dt>Project</dt><dd>{candidate.projectName ?? 'No project'}</dd>
            <dt>Session</dt><dd><span className="ms-mono">{shortSessionId(candidate.sessionKey)}</span>, {envLabel(candidate.env)}, generation {candidate.generation}</dd>
            <dt>Captured</dt><dd>{formatWhen(candidate.capturedAt)}</dd>
            <dt>Declared status</dt><dd>{candidate.declaredStatus ? `${DECLARED_TEXT[candidate.declaredStatus]}. A declaration by the model, not proof.` : 'None. Claude declared no status.'}</dd>
          </dl>
          {candidate.redactions ? <p className="ms-x-note">{candidate.redactions === 1 ? '1 credential-like string was' : `${candidate.redactions} credential-like strings were`} hidden when this message was captured.</p> : null}
          <ReportText text={candidate.body} label="Full message text" />
        </div>
      </div>
      <ConfirmDialog
        open={asking}
        title="Make this message a report?"
        description={`It becomes a report like the ones Claude marks itself: it joins the queue and gets a handoff to ChatGPT. Claude did not mark this message as a report, so you are deciding that it is one. ${candidate.declaredStatus ? '' : 'Claude declared no status, so it is listed as partial.'}`.trim()}
        confirmLabel="Make it a report"
        busy={busy}
        error={error}
        onConfirm={promote}
        onCancel={() => setAsking(false)}
      />
    </section>
  );
}
