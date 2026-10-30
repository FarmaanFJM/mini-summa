import type { Delivery, DeliveryPartInfo, Report } from '@minisumma/shared';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp, useRoute, useUi } from '../../app/runtime';
import { Button, Icon, toast } from '../../ui';
import { DestinationDialog } from './DestinationDialog';
import { useDeliveryEvents, useProjectConversations } from './hooks';
import {
  actorWords, characters, COPYABLE, describeDestination, describeEvent, describeOpen, formatWhen, handoffPlan,
} from './model';
import type { HandoffButton, HandoffActionId, OpenReport } from './model';
import { errorText, useRunner, writeClipboard } from './support';

export interface HandoffCardProps {
  report: Pick<Report, 'id' | 'projectId' | 'sessionKey' | 'taskTitle'>;
  /** The report's latest delivery, or null when none exists yet. */
  delivery: Delivery | null;
  /** Called with a delivery created from here, so the screen can show it before the store has heard about it. */
  onCreated?: (delivery: Delivery) => void;
}

interface Copied { text: string }
interface ClipboardFailure { part: number; partCount: number; text: string; reason: string }

/**
 * The handoff of one report to one ChatGPT conversation. It shows exactly where the report goes and what state the
 * handoff is in, and offers only the actions the core accepts in that state. Nothing here says "sent" before the person
 * has pressed I sent it: copying and opening are not delivery.
 */
export function HandoffCard({ report, delivery, onCreated }: HandoffCardProps) {
  const api = useApi();
  const native = useNative();
  const route = useRoute();
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const runner = useRunner();
  const projectId = delivery?.projectId ?? report.projectId;
  const conversations = useProjectConversations(projectId);
  const reviewSettings = useApp((s) => s.settings?.review);
  const [opened, setOpened] = useState<OpenReport | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  const [failure, setFailure] = useState<ClipboardFailure | null>(null);
  const [chooser, setChooser] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const { detail } = useDeliveryEvents(delivery);

  // Another delivery, or a state the core moved to, makes earlier results obsolete.
  const deliveryId = delivery?.id ?? null;
  const deliveryState = delivery?.state ?? null;
  useEffect(() => { setOpened(null); setCopied(null); setFailure(null); }, [deliveryId]);
  useEffect(() => { if (deliveryState === 'user_confirmed_sent' || deliveryState === 'user_discarded') { setCopied(null); setFailure(null); } }, [deliveryState]);

  // Learn how many parts the message has before the person presses anything, so the main button can say which part it copies.
  // Preparing only stores the message on the handoff; nothing is copied, opened or sent.
  const needsPrepare = delivery !== null && COPYABLE.includes(delivery.state) && delivery.destination !== null;
  const noParts = (delivery?.parts.length ?? 0) === 0;
  const limits = `${reviewSettings?.maxPartChars}|${reviewSettings?.includeSessionRef}|${reviewSettings?.requestTemplate}`;
  useEffect(() => {
    if (!deliveryId || !needsPrepare) return;
    api.call('deliveries.prepare', { params: { id: deliveryId } }).catch(() => { /* the buttons still work; they just cannot name the part */ });
  }, [api, deliveryId, needsPrepare, noParts, limits]);

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

  // ----- what a result means -----

  const afterCopy = async (result: { part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null }) => {
    const label = result.partCount > 1 ? `Part ${result.part} of ${result.partCount}` : 'The message';
    setFailure(null);
    if (result.clipboard === 'client') {
      if (typeof result.text !== 'string') {
        setCopied(null);
        setFailure({ part: result.part, partCount: result.partCount, text: '', reason: 'Mini-Summa did not send the text to copy.' });
        return;
      }
      const written = await writeClipboard(native, result.text);
      if (!written.ok) {
        setCopied(null);
        setFailure({ part: result.part, partCount: result.partCount, text: result.text, reason: written.reason });
        return;
      }
    }
    setCopied({ text: `${label} is on your clipboard.` });
  };

  const handoff = (part?: number) => runner.run('handoff', async () => {
    setOpened(null);
    const result = await api.call('deliveries.handoff', { params: { id: delivery.id }, body: part ? { part } : {} });
    await afterCopy(result);
    setOpened(describeOpen(result.open));
  });

  const copyPart = (part?: number) => runner.run(part ? `copy-${part}` : 'copy', async () => {
    const result = await api.call('deliveries.copy', { params: { id: delivery.id }, body: part ? { part } : {} });
    await afterCopy(result);
  });

  const openConversation = () => runner.run('open', async () => {
    const result = await api.call('deliveries.open', { params: { id: delivery.id } });
    setOpened(describeOpen(result.open));
  });

  const wholeMessage = () => runner.run('whole', async () => {
    const prepared = await api.call('deliveries.prepare', { params: { id: delivery.id } });
    const written = await writeClipboard(native, prepared.message);
    if (!written.ok) { setCopied(null); setFailure({ part: 1, partCount: 1, text: prepared.message, reason: written.reason }); return; }
    setFailure(null);
    setCopied({ text: `The whole message (${characters(prepared.message.length)}) is on your clipboard. This is not recorded as a handoff step.` });
  });

  const simple = (key: string, call: () => Promise<unknown>, after?: () => void) => runner.run(key, async () => { await call(); after?.(); });

  const discard = () => simple('discard', async () => {
    await api.call('deliveries.discard', { params: { id: delivery.id }, body: {} });
    toast({
      title: 'Handoff discarded', body: 'It is not recorded as sent.',
      action: { label: 'Undo', onClick: () => { void api.call('deliveries.reopen', { params: { id: delivery.id }, body: {} }).catch((err: unknown) => toast({ title: 'Could not undo', body: errorText(err), kind: 'error' })); } },
    });
  });

  const act = (button: HandoffButton): void => {
    const table: Record<HandoffActionId, () => unknown> = {
      handoff: () => handoff(button.part),
      open: openConversation,
      copyAgain: () => copyPart(),
      confirmSent: () => simple('confirmSent', () => api.call('deliveries.confirmSent', { params: { id: delivery.id }, body: {} })),
      markUncertain: () => simple('uncertain', () => api.call('deliveries.markUncertain', { params: { id: delivery.id }, body: {} })),
      discard,
      reopen: () => simple('reopen', () => api.call('deliveries.reopen', { params: { id: delivery.id }, body: {} })),
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

      {opened ? <p className="ms-x-result" data-tone={opened.tone} role="status">{opened.text}</p> : null}
      {copied ? <p className="ms-x-result" data-tone="ok" role="status">{copied.text}</p> : null}
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
        <PartList parts={delivery.parts} busy={busy} onCopy={(part) => { void copyPart(part); }} />
      ) : null}

      {plan.alternatives.wholeMessage || plan.alternatives.sentAnotherWay ? (
        <div className="ms-rep-more">
          <button type="button" className="ms-x-toggle" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}>
            <Icon name={showMore ? 'chevron-down' : 'chevron-right'} size={14} />
            <span>Other ways to hand it over</span>
          </button>
          {showMore ? (
            <div className="ms-x-actions">
              {plan.alternatives.wholeMessage ? <Button size="sm" icon="copy" disabled={busy !== null && busy !== 'whole'} loading={busy === 'whole'} onClick={() => { void wholeMessage(); }}>Copy the whole message</Button> : null}
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
