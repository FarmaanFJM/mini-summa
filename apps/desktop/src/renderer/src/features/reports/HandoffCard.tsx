import type { Delivery, DeliveryPartInfo, Report } from '@minisumma/shared';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useApi, useRoute, useUi } from '../../app/runtime';
import { Button, Icon } from '../../ui';
import { DestinationDialog } from './DestinationDialog';
import { useDeliveryEvents, useProjectConversations } from './hooks';
import {
  actorWords, characters, COPYABLE, describeDestination, describeEvent, formatWhen, handoffPlan,
} from './model';
import type { HandoffButton, HandoffActionId } from './model';
import { useHandoffActions, usePrepareParts } from './useHandoffActions';

export interface HandoffCardProps {
  report: Pick<Report, 'id' | 'projectId' | 'sessionKey' | 'taskTitle'>;
  /** The report's latest delivery, or null when none exists yet. */
  delivery: Delivery | null;
  /** Called with a delivery created from here, so the screen can show it before the store has heard about it. */
  onCreated?: (delivery: Delivery) => void;
}

/**
 * The handoff of one report to one ChatGPT conversation. It shows exactly where the report goes and what state the
 * handoff is in, and offers only the actions the core accepts in that state. Nothing here says "sent" before the person
 * has pressed I sent it: copying and opening are not delivery.
 */
export function HandoffCard({ report, delivery, onCreated }: HandoffCardProps) {
  const api = useApi();
  const route = useRoute();
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const projectId = delivery?.projectId ?? report.projectId;
  const conversations = useProjectConversations(projectId);
  const [chooser, setChooser] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const { detail } = useDeliveryEvents(delivery);
  // The steps themselves (copy and open, I sent it, ...) are shared with the handoff strip in the workspace.
  const actions = useHandoffActions(delivery);
  const { runner, opened, copied, failure } = actions;
  usePrepareParts(delivery);

  if (!delivery) {
    return (
      <section className="ms-rep-card" aria-label="Handoff to ChatGPT">
        <h2 className="ms-rep-card__title">Handoff to ChatGPT</h2>
        <p className="ms-x-note">No handoff has been prepared for this report yet.</p>
        {runner.error ? <p className="ms-x-error" role="alert">{runner.error}</p> : null}
        <div className="ms-x-actions">
          <Button
            variant="primary"
            loading={runner.busy === 'create'}
            onClick={() => { void runner.run('create', async () => { onCreated?.(await api.call('deliveries.create', { params: { id: report.id }, body: {} })); }); }}
          >
            Prepare handoff
          </Button>
        </div>
      </section>
    );
  }

  const plan = handoffPlan(delivery, { conversationCount: conversations.length, hasProject: projectId !== null });
  const destination = delivery.destination;
  const facts = destination ? describeDestination(destination, conversations.find((c) => c.id === destination.conversationId), formatWhen) : null;
  const busy = runner.busy;

  const act = (button: HandoffButton): void => {
    const table: Record<HandoffActionId, () => unknown> = {
      handoff: () => actions.handoff(button.part),
      open: actions.openConversation,
      copyAgain: () => actions.copyPart(),
      confirmSent: actions.confirmSent,
      markUncertain: actions.markUncertain,
      discard: actions.discard,
      reopen: actions.reopen,
      chooseDestination: () => setChooser(true),
      addConversation: () => { if (projectId) openProjectDialog({ mode: 'edit', projectId }); },
      prepare: () => undefined,
      openSession: () => route.go({ view: 'workspace', projectId: projectId ?? undefined, sessionKey: report.sessionKey }),
    };
    void table[button.id]();
  };

  const busyKey = (id: HandoffActionId): string => (id === 'copyAgain' ? 'copy' : id === 'markUncertain' ? 'uncertain' : id);
  const renderButton = (button: HandoffButton, variant: 'primary' | 'secondary' | 'ghost'): ReactNode => (
    <Button
      key={`${button.id}-${button.label}`}
      variant={variant}
      loading={busy === busyKey(button.id)}
      disabled={busy !== null && busy !== busyKey(button.id)}
      onClick={() => act(button)}
    >
      {button.label}
    </Button>
  );

  const closed = delivery.state === 'user_confirmed_sent' || delivery.state === 'user_discarded';
  const sentAt = delivery.state === 'user_confirmed_sent' ? formatWhen(delivery.stateChangedAt) : null;
  const resolvedReason = detail?.events.find((e) => e.type === 'destination_resolved')?.detail.reason;
  const history = detail?.events ?? [];

  return (
    <section className="ms-rep-card" aria-label="Handoff to ChatGPT">
      <h2 className="ms-rep-card__title">Handoff to ChatGPT</h2>

      {facts && destination ? (
        <div className="ms-rep-dest" aria-label="Destination">
          <span className="ms-x-label">Goes to</span>
          <p className="ms-rep-dest__title">{facts.title}</p>
          <p className="ms-rep-dest__url ms-mono ms-break">{facts.url}</p>
          <p className="ms-rep-dest__line">{facts.verification}</p>
          <p className="ms-rep-dest__line">{facts.resolved}</p>
          <p className="ms-rep-dest__fixed">{facts.frozen}</p>
          {facts.drift ? <p className="ms-rep-dest__fixed">{facts.drift}</p> : null}
          {plan.changeDestination ? (
            <div className="ms-x-actions">
              <Button size="sm" variant="ghost" icon="pencil" disabled={busy !== null} onClick={() => setChooser(true)}>Change destination</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="ms-rep-state">
        <h3 className="ms-rep-state__headline">{plan.headline}{sentAt ? <span className="ms-rep-state__when"> on {sentAt}</span> : null}</h3>
        {plan.body.map((line) => <p key={line} className="ms-rep-state__body">{line}</p>)}
        {delivery.state === 'destination_missing' && typeof resolvedReason === 'string' ? <p className="ms-rep-state__body">{resolvedReason}</p> : null}
        {delivery.lastError && !closed ? <p className="ms-x-error">Last problem: {delivery.lastError}</p> : null}
      </div>

      {opened || copied ? (
        <div className="ms-x-result" data-tone={opened?.tone ?? 'ok'} role="status">
          {copied ? <p>{copied.text}</p> : null}
          {opened ? <p>{opened.text}</p> : null}
        </div>
      ) : null}
      {failure ? (
        <div className="ms-x-result" data-tone="error" role="alert">
          <p>
            Mini-Summa could not put the text on your clipboard ({failure.reason}). The handoff is recorded as copied, but your clipboard does not have it.
            Select the text below and copy it yourself, or press Copy again.
          </p>
          {failure.text ? <textarea className="sm-input ms-textarea ms-mono ms-rep-fallback" readOnly aria-label="Text to copy by hand" value={failure.text} onFocus={(e) => e.currentTarget.select()} /> : null}
        </div>
      ) : null}
      {runner.error ? <p className="ms-x-error" role="alert">{runner.error}</p> : null}

      {plan.primary || plan.secondary.length > 0 || plan.quiet.length > 0 ? (
        <div className="ms-rep-buttons">
          {plan.primary ? renderButton(plan.primary, 'primary') : null}
          {plan.secondary.length > 0 ? <div className="ms-x-actions">{plan.secondary.map((b) => renderButton(b, 'secondary'))}</div> : null}
          {plan.quiet.length > 0 ? <div className="ms-x-actions">{plan.quiet.map((b) => renderButton(b, 'ghost'))}</div> : null}
        </div>
      ) : null}

      {plan.partCount > 1 && COPYABLE.includes(delivery.state) ? (
        <PartList parts={delivery.parts} busy={busy} onCopy={(part) => { void actions.copyPart(part); }} />
      ) : null}

      {plan.alternatives.wholeMessage || plan.alternatives.sentAnotherWay ? (
        <div className="ms-rep-more">
          <button type="button" className="ms-x-toggle" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}>
            <Icon name={showMore ? 'chevron-down' : 'chevron-right'} size={14} />
            <span>Other ways to hand it over</span>
          </button>
          {showMore ? (
            <div className="ms-x-actions">
              {plan.alternatives.wholeMessage ? <Button size="sm" icon="copy" disabled={busy !== null && busy !== 'whole'} loading={busy === 'whole'} onClick={() => { void actions.wholeMessage(); }}>Copy the whole message</Button> : null}
              {plan.alternatives.sentAnotherWay ? (
                <Button size="sm" disabled={busy !== null && busy !== 'confirmSent'} loading={busy === 'confirmSent'} onClick={() => act({ id: 'confirmSent', label: 'I sent it another way' })}>I sent it another way</Button>
              ) : null}
              {plan.alternatives.sentAnotherWay ? <p className="ms-x-note">Press I sent it another way only after you pasted or attached the message in ChatGPT and sent it yourself.</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="ms-rep-more">
        <button type="button" className="ms-x-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
          <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} size={14} />
          <span>History{history.length > 0 ? ` (${history.length})` : ''}</span>
        </button>
        {showHistory ? (
          <ol className="ms-rep-history" aria-label="History of this handoff">
            {history.length === 0 ? <li className="ms-x-note">Nothing recorded yet.</li> : null}
            {history.map((e) => (
              <li key={e.id} className="ms-rep-history__item">
                <span className="ms-rep-history__text">{describeEvent(e)}</span>
                <span className="ms-rep-history__meta">{actorWords(e)}, {formatWhen(e.at)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      <DestinationDialog open={chooser} delivery={delivery} conversations={conversations} onClose={() => setChooser(false)} />
    </section>
  );
}

function PartList({ parts, busy, onCopy }: { parts: DeliveryPartInfo[]; busy: string | null; onCopy: (part: number) => void }) {
  const total = parts.length;
  return (
    <ul className="ms-rep-parts" aria-label="Parts of the message">
      {parts.map((p) => (
        <li key={p.index} className="ms-rep-part" data-copied={p.copiedAt !== null || undefined}>
          <span className="ms-rep-part__tick" role="img" aria-label={p.copiedAt ? 'Copied' : 'Not copied yet'}>
            <Icon name={p.copiedAt ? 'circle-check' : 'circle'} />
          </span>
          <span className="ms-rep-part__text">
            <span>Part {p.index} of {total}</span>
            <span className="ms-rep-part__meta">{characters(p.chars)}{p.copiedAt ? `, copied ${formatWhen(p.copiedAt)}` : ''}</span>
          </span>
          <Button size="sm" variant="ghost" icon="copy" disabled={busy !== null && busy !== `copy-${p.index}`} loading={busy === `copy-${p.index}`} onClick={() => onCopy(p.index)}>
            Copy part {p.index} of {total}
          </Button>
        </li>
      ))}
    </ul>
  );
}
