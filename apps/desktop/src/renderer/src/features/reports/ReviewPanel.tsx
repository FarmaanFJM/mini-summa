import type { Delivery, ReviewState } from '@minisumma/shared';
import { useState } from 'react';
import { useApi } from '../../app/runtime';
import { Button, Icon } from '../../ui';
import { FollowUp } from './FollowUp';
import type { SendOutcome } from './FollowUp';
import { REVIEW_STEPS, reviewControls, reviewProgress } from './model';
import { useRunner } from './support';

export interface ReviewPanelProps {
  delivery: Delivery;
  reportId: string;
  reportSessionKey: Delivery['sessionKey'];
  reportGeneration: number;
}

/** True when a delivery has anything to say about a review: it was sent, or it kept a review state. */
export const hasReview = (delivery: Pick<Delivery, 'state' | 'review'>): boolean => delivery.state === 'user_confirmed_sent' || delivery.review !== 'none';

/**
 * Where the review stands. Mini-Summa cannot see ChatGPT, so every step after "sent" is something the person says, and
 * nothing moves by itself: there are no timers and no automatic transitions.
 */
export function ReviewPanel({ delivery, reportId, reportSessionKey, reportGeneration }: ReviewPanelProps) {
  const api = useApi();
  const runner = useRunner();
  const [writing, setWriting] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const progress = reviewProgress(delivery);
  const controls = reviewControls(delivery);
  const composing = controls.writeFollowUp && (writing || delivery.review === 'follow_up_drafted');

  const setReview = (review: ReviewState) => runner.run(`review-${review}`, async () => {
    await api.call('deliveries.setReview', { params: { id: delivery.id }, body: { review } });
    if (review !== 'follow_up_drafted') setWriting(false);
  });

  return (
    <section className="ms-rep-card" aria-label="Review">
      <h2 className="ms-rep-card__title">Review</h2>
      <p className="ms-x-note">Mini-Summa cannot see ChatGPT. These steps are what you tell it, and nothing moves on its own.</p>

      <ol className="ms-rep-steps" aria-label="Review progress">
        {REVIEW_STEPS.map((label, i) => {
          const status = i < progress.done ? 'done' : i === progress.current ? 'current' : 'todo';
          return (
            <li key={label} className="ms-rep-step" data-status={status} aria-current={status === 'current' ? 'step' : undefined}>
              <span className="ms-rep-step__mark" aria-hidden="true"><Icon name={status === 'done' ? 'circle-check' : status === 'current' ? 'circle-dot' : 'circle'} /></span>
              <span>{label}</span>
              <span className="sm-sr-only">{status === 'done' ? ', done' : status === 'current' ? ', current step' : ', not reached'}</span>
            </li>
          );
        })}
      </ol>
      {progress.closed ? <p className="ms-x-note">You closed this review.</p> : null}
      {controls.note ? <p className="ms-x-note">{controls.note}</p> : null}
      {runner.error ? <p className="ms-x-error" role="alert">{runner.error}</p> : null}
      {outcome ? <p className="ms-x-result" data-tone={outcome.tone} role={outcome.tone === 'error' ? 'alert' : 'status'}>{outcome.text}</p> : null}
      {delivery.review === 'follow_up_sent' ? (
        <div className="ms-rep-inspect">
          <p className="ms-x-note">{outcome ? 'What was typed:' : 'The follow-up was typed into the Claude session you chose. What was typed:'}</p>
          <pre className="ms-rep-inspect__text ms-mono">{delivery.followUpDraft}</pre>
        </div>
      ) : null}

      {composing ? (
        <FollowUp key={delivery.id} delivery={delivery} reportId={reportId} reportSessionKey={reportSessionKey} reportGeneration={reportGeneration} onOutcome={setOutcome} />
      ) : null}

      <div className="ms-rep-buttons">
        {controls.markRead ? <Button variant="primary" loading={runner.busy === 'review-received'} disabled={runner.busy !== null} onClick={() => { void setReview('received'); }}>I have read the review</Button> : null}
        {controls.writeFollowUp && !composing ? (
          <Button variant={delivery.review === 'received' ? 'primary' : 'secondary'} disabled={runner.busy !== null} onClick={() => setWriting(true)}>Write a follow-up for Claude</Button>
        ) : null}
        <div className="ms-x-actions">
          {controls.close ? <Button variant="ghost" loading={runner.busy === 'review-closed'} disabled={runner.busy !== null} onClick={() => { void setReview('closed'); }}>Close review</Button> : null}
          {controls.reopen ? <Button variant="secondary" loading={runner.busy === 'review-received'} disabled={runner.busy !== null} onClick={() => { void setReview('received'); }}>Reopen review</Button> : null}
        </div>
      </div>
    </section>
  );
}
