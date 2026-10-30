import { envLabel, parseSessionKey, shortSessionId } from '@minisumma/shared';
import type { PendingAction, SessionView } from '@minisumma/shared';
import { useMemo, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { Button, Section } from '../../ui';
import { actionOutcome, actorName, untilWords } from './model';
import { errorText, useNow } from './support';

export interface PendingActionsProps {
  /** Show only one project's requests. */
  projectId?: string;
  /** Heading level; the inbox is a section of a bigger page. */
  title?: string;
}

function sessionLine(action: PendingAction, sessions: SessionView[]): string {
  const view = sessions.find((s) => s.key === action.sessionKey);
  const parsed = parseSessionKey(action.sessionKey);
  const how = view ? `${view.origin === 'managed' ? 'managed' : 'observed'}, ${envLabel(view.env)}` : parsed ? envLabel(parsed.env) : '';
  return `${action.projectName ?? 'No project'}, session ${shortSessionId(action.sessionKey)}${how ? ` (${how})` : ''}, generation ${action.generation}`;
}

/**
 * Requests that wait for the person: a prompt a phone wants typed into a session, and a permission question a managed
 * session is asking. Each shows the exact text or the tool, who asked and where it would go. Nothing is typed until
 * Approve is pressed, and a request whose target no longer qualifies cannot be approved.
 */
export function PendingActionsInbox({ projectId, title = 'Waiting for your approval' }: PendingActionsProps) {
  const api = useApi();
  const all = useApp((s) => s.actions);
  const sessions = useApp((s) => s.sessions);
  const [results, setResults] = useState<Record<string, PendingAction>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const now = useNow(15_000);

  const rows = useMemo(() => {
    const live = all.filter((a) => a.status === 'pending' && (!projectId || a.projectId === projectId) && !results[a.id]);
    const decided = Object.values(results).filter((a) => !projectId || a.projectId === projectId);
    return [...live, ...decided].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [all, results, projectId]);
  const waiting = rows.filter((a) => a.status === 'pending').length;

  const decide = async (action: PendingAction, verb: 'approve' | 'reject') => {
    setBusy(`${verb}-${action.id}`);
    setErrors(({ [action.id]: _gone, ...rest }) => rest);
    try {
      const done = verb === 'approve'
        ? await api.call('actions.approve', { params: { id: action.id } })
        : await api.call('actions.reject', { params: { id: action.id }, body: {} });
      setResults((r) => ({ ...r, [action.id]: done }));
    } catch (err) {
      setErrors((e) => ({ ...e, [action.id]: errorText(err) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={waiting > 0 ? `${title} (${waiting})` : title}>
      {rows.length === 0 ? <p className="ms-x-note">Nothing is waiting for your approval.</p> : (
        <ul className="ms-pa-list" aria-label={title}>
          {rows.map((action) => {
            const outcome = actionOutcome(action);
            const pending = action.status === 'pending';
            const permission = action.kind === 'permission';
            const left = untilWords(action.expiresAt, now);
            return (
              <li key={action.id} className="ms-pa" data-kind={action.kind}>
                <div className="ms-pa__head">
                  <h3 className="ms-pa__title">{permission ? 'Permission request' : `Prompt from ${actorName(action.createdBy)}`}</h3>
                  {pending ? <span className="ms-pa__expires">{left ? `Expires in ${left}` : 'Expired'}</span> : null}
                </div>
                <p className="ms-pa__target">{sessionLine(action, sessions)}</p>
                <p className="ms-pa__who">Asked by {actorName(action.createdBy)}</p>
                <pre className="ms-pa__text ms-mono" aria-label={permission ? 'Tool and input' : 'Exact text'}>{permission ? action.summary : action.text ?? action.summary}</pre>
                {pending ? (
                  <>
                    <p className="ms-x-note">
                      {permission ? 'Approve answers yes in the terminal. Reject answers no.' : 'Approve types this text into the terminal and presses Enter. Reject types nothing.'}
                    </p>
                    {action.target.problem ? <p className="ms-x-error">It cannot be carried out now: {action.target.problem}</p> : null}
                    {errors[action.id] ? <p className="ms-x-error" role="alert">{errors[action.id]}</p> : null}
                    <div className="ms-x-actions">
                      <Button loading={busy === `approve-${action.id}`} disabled={busy !== null || action.target.problem !== null || left === null} onClick={() => { void decide(action, 'approve'); }}>Approve</Button>
                      <Button variant="ghost" loading={busy === `reject-${action.id}`} disabled={busy !== null} onClick={() => { void decide(action, 'reject'); }}>Reject</Button>
                    </div>
                  </>
                ) : outcome ? (
                  <div className="ms-x-actions">
                    <p className="ms-x-result" data-tone={outcome.tone} role={outcome.tone === 'error' ? 'alert' : 'status'}>{outcome.text}</p>
                    <Button size="sm" variant="ghost" onClick={() => setResults(({ [action.id]: _gone, ...rest }) => rest)}>Dismiss</Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
