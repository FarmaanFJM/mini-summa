import { envLabel, shortSessionId } from '@minisumma/shared';
import type { Delivery, PendingAction, SessionKey, SessionView } from '@minisumma/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { Button, Dialog, Field, Radio, TextArea } from '../../ui';
import { confirmTitle, formatWhen, targetEligibility, targetName } from './model';
import type { Eligibility } from './model';
import { errorText, useRunner } from './support';

export interface FollowUpProps {
  delivery: Delivery;
  reportId: string;
  reportSessionKey: SessionKey;
  reportGeneration: number;
  /** Told when the core answered a send, so the outcome stays visible after the composer goes away. */
  onOutcome?: (outcome: SendOutcome) => void;
}

export interface SendOutcome { tone: 'ok' | 'error'; text: string }

const AVAILABILITY: Record<SessionView['availability'], string> = { live: 'live', resumable: 'ended, can be resumed', disconnected: 'disconnected', ended: 'ended' };

/** What the core said happened to the prompt. It is stated as found: typed and submitted, or the reason it was not. */
export function describeSend(action: PendingAction, session: Pick<SessionView, 'key' | 'origin' | 'env' | 'projectName'>): SendOutcome {
  if (action.status === 'executed') {
    return { tone: 'ok', text: `Typed into ${targetName(session)} and sent with Enter at ${formatWhen(action.executedAt ?? action.decidedAt ?? action.createdAt)}.` };
  }
  if (action.status === 'failed') {
    return { tone: 'error', text: `Not sent: ${(action.failure ?? 'it did not work').replace(/\.$/, '')}. Nothing is retried for you, and your text is kept.` };
  }
  return { tone: 'error', text: `The request is ${action.status}, so nothing was typed.` };
}

/**
 * Feedback from the ChatGPT review, written for Claude. Sending needs a session that can take it, an inspection of the
 * exact text for that session, and a confirmation that names the destination. Nothing is sent automatically.
 */
export function FollowUp({ delivery, reportId, reportSessionKey, reportGeneration, onOutcome }: FollowUpProps) {
  const api = useApi();
  const sessions = useApp((s) => s.sessions);
  const saver = useRunner();
  const [text, setText] = useState(delivery.followUpDraft ?? '');
  const [choice, setChoice] = useState<SessionKey | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectedFor, setInspectedFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [saved, setSaved] = useState(delivery.followUpDraft);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const rows = useMemo(() => {
    const mine = sessions.filter((s) => (delivery.projectId !== null && s.projectId === delivery.projectId) || s.key === reportSessionKey);
    const rank = (s: SessionView) => (s.key === reportSessionKey ? 0 : s.origin === 'managed' && s.availability === 'live' ? 1 : s.origin === 'managed' ? 2 : 3);
    return mine.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key)).map((session) => ({ session, eligibility: targetEligibility(session) as Eligibility }));
  }, [sessions, delivery.projectId, reportSessionKey]);

  const defaultKey = rows.find((r) => r.session.key === reportSessionKey && r.eligibility.ok)?.session.key ?? null;
  const chosenKey = choice ?? defaultKey;
  const target = rows.find((r) => r.session.key === chosenKey) ?? null;
  const typed = text.trimEnd();
  const identity = target ? `${target.session.key}|${target.session.generation}\n${typed}` : null;

  // Looking at the exact text, for this session and these words, is what unlocks sending. Changing either locks it again.
  useEffect(() => { if (inspecting && identity) setInspectedFor(identity); }, [inspecting, identity]);

  const originRow = rows.find((r) => r.session.key === reportSessionKey);
  const canSend = target !== null && target.eligibility.ok && typed !== '' && inspectedFor === identity && !sending;
  const draftSaved = saved !== null && saved === text;

  const saveDraft = () => saver.run('save', async () => {
    const result = await api.call('deliveries.setReview', { params: { id: delivery.id }, body: { review: 'follow_up_drafted', followUpDraft: text } });
    setSaved(result.followUpDraft);
  });

  const send = async () => {
    if (!target || !target.eligibility.ok) return;
    setSending(true);
    setSendError(null);
    try {
      // The record keeps exactly what was typed: the draft is saved first, and a failure here stops before anything is typed.
      if (delivery.review !== 'follow_up_drafted' || delivery.followUpDraft !== typed) {
        await api.call('deliveries.setReview', { params: { id: delivery.id }, body: { review: 'follow_up_drafted', followUpDraft: typed } });
        setSaved(typed);
      }
      const action = await api.call('actions.create', {
        body: { sessionKey: target.session.key, text: typed, expectGeneration: target.session.generation, reportId, deliveryId: delivery.id },
      });
      setConfirming(false);
      onOutcome?.(describeSend(action, target.session));
    } catch (err) {
      setSendError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="ms-rep-followup">
      <h3 className="ms-rep-followup__title">Follow-up for Claude</h3>
      <Field label="Feedback for Claude">
        <TextArea value={text} rows={6} spellCheck onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="ms-x-actions ms-rep-followup__save">
        <Button size="sm" loading={saver.busy === 'save'} disabled={text.trim() === '' || draftSaved} onClick={() => { void saveDraft(); }}>Save draft</Button>
        <span className="ms-x-note" role="status">{text.trim() === '' ? '' : draftSaved ? 'Draft saved' : 'Not saved yet'}</span>
      </div>
      {saver.error ? <p className="ms-x-error" role="alert">{saver.error}</p> : null}

      <fieldset className="ms-rep-targets">
        <legend className="ms-x-label">Send it to</legend>
        {originRow && !originRow.eligibility.ok ? <p className="ms-x-note">The session that wrote the report cannot take it right now. Choose another one, or wait.</p> : null}
        {rows.length === 0 ? <p className="ms-x-note">This project has no Claude session to send to. Start one in the project first.</p> : null}
        <div className="ms-rows" role="radiogroup" aria-label="Claude session">
          {rows.map(({ session, eligibility }) => {
            const reasonId = `reason-${session.sessionId}`;
            const restarted = session.key === reportSessionKey && session.generation !== reportGeneration;
            return (
              <div key={session.key} className="ms-row-item ms-rep-target" data-disabled={!eligibility.ok || undefined} onClick={() => { if (eligibility.ok) setChoice(session.key); }}>
                <Radio
                  name="follow-up-target"
                  checked={chosenKey === session.key}
                  disabled={!eligibility.ok}
                  onChange={() => setChoice(session.key)}
                  aria-label={`${session.projectName ?? 'No project'}, session ${shortSessionId(session.key)}`}
                  aria-describedby={eligibility.ok ? undefined : reasonId}
                />
                <span className="ms-row-item__main">
                  <span className="ms-truncate">{session.projectName ?? 'No project'}, session <span className="ms-mono">{shortSessionId(session.key)}</span>{session.key === reportSessionKey ? ' (wrote this report)' : ''}</span>
                  <span className="ms-row-item__sub">
                    {session.origin === 'managed' ? 'managed' : 'observed'}, {envLabel(session.env)}, {AVAILABILITY[session.availability]}, {session.stateLabel}, generation {session.generation}
                  </span>
                  {restarted ? <span className="ms-row-item__sub">Restarted since the report: generation {reportGeneration} then, {session.generation} now.</span> : null}
                  {!eligibility.ok ? <span id={reasonId} className="ms-row-item__sub ms-rep-target__why">{eligibility.reason}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="ms-x-actions">
        <Button size="sm" icon={inspecting ? 'eye-off' : 'eye'} aria-expanded={inspecting} disabled={typed === '' || !target} onClick={() => setInspecting((v) => !v)}>
          {inspecting ? 'Hide exact text' : 'Inspect exact text'}
        </Button>
      </div>
      {inspecting && target ? (
        <div className="ms-rep-inspect" role="region" aria-label="Exact text that will be typed">
          <p className="ms-x-note">
            Mini-Summa will type this into {targetName(target.session)} and press Enter. {typed.length.toLocaleString('en-US')} characters, {typed.split('\n').length} {typed.split('\n').length === 1 ? 'line' : 'lines'}.
          </p>
          <pre className="ms-rep-inspect__text ms-mono">{typed}</pre>
        </div>
      ) : null}

      <div className="ms-rep-buttons">
        <Button variant="primary" disabled={!canSend} onClick={() => { setSendError(null); setConfirming(true); }}>Send to Claude</Button>
        {!canSend && typed !== '' ? (
          <p className="ms-x-note">
            {!target ? 'Choose a session to send it to.' : !target.eligibility.ok ? target.eligibility.reason : 'Inspect the exact text first. Nothing is sent until you confirm.'}
          </p>
        ) : null}
      </div>

      {target ? (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={confirmTitle(target.session)}
          description="Mini-Summa will type this text into that terminal and press Enter. Claude starts working on it right away."
          busy={sending}
          initialFocus={cancelRef}
          footer={(
            <>
              <Button ref={cancelRef} onClick={() => setConfirming(false)} disabled={sending}>Cancel</Button>
              <Button variant="primary" loading={sending} onClick={() => { void send(); }}>Send to Claude</Button>
            </>
          )}
        >
          <pre className="ms-rep-inspect__text ms-mono" aria-label="Text that will be typed">{typed}</pre>
          {sendError ? <p className="ms-dialog__error" role="alert">{sendError}</p> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
