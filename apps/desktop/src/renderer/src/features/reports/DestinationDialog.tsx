import type { Conversation, Delivery } from '@minisumma/shared';
import { useEffect, useState } from 'react';
import { useApi } from '../../app/runtime';
import { Button, Dialog, Radio } from '../../ui';
import { verificationWords } from './model';
import { errorText } from './support';

export interface DestinationDialogProps {
  open: boolean;
  delivery: Delivery;
  /** The conversations mapped to the report's project. Nothing else can be chosen here. */
  conversations: Conversation[];
  onClose: () => void;
}

/** An explicit choice among the project's conversations. Changing it is recorded in the history of the handoff. */
export function DestinationDialog({ open, delivery, conversations, onClose }: DestinationDialogProps) {
  const api = useApi();
  const current = delivery.destination?.conversationId ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setPicked(null); setError(null); } }, [open]);

  const copied = delivery.parts.filter((p) => p.copiedAt !== null).length;
  const changing = current !== null;
  const apply = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api.call('deliveries.setDestination', { params: { id: delivery.id }, body: { conversationId: picked } });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={changing ? 'Change where this report goes?' : 'Choose a conversation'}
      description={changing
        ? 'Only this handoff changes. The project\'s preferred conversation stays as it is, and the change is written to the history of this handoff.'
        : 'Choose the ChatGPT conversation this report goes to. The choice is fixed for this handoff.'}
      busy={busy}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!picked || picked === current} onClick={() => { void apply(); }}>
            {changing ? 'Change destination' : 'Use this conversation'}
          </Button>
        </>
      )}
    >
      <div role="radiogroup" aria-label="Conversations of this project" className="ms-rows">
        {conversations.map((c) => {
          const isCurrent = c.id === current;
          return (
            <div key={c.id} className="ms-row-item ms-rep-choice" data-current={isCurrent || undefined} onClick={() => { if (!isCurrent) setPicked(c.id); }}>
              <Radio
                name="destination"
                checked={(picked ?? current) === c.id}
                disabled={isCurrent}
                onChange={() => setPicked(c.id)}
                aria-label={`${c.title}${isCurrent ? ', current destination' : ''}`}
              />
              <span className="ms-row-item__main">
                <span className="ms-truncate">{c.title}{isCurrent ? ' (current destination)' : ''}</span>
                <span className="ms-row-item__sub ms-mono ms-break">{c.url}</span>
                <span className="ms-row-item__sub">{verificationWords(c.verification, c.verifiedTitle)}</span>
              </span>
            </div>
          );
        })}
      </div>
      {copied > 0 ? <p className="ms-x-note">Parts you already copied are cleared, so the next copy starts again from the beginning.</p> : null}
      {error ? <p className="ms-dialog__error" role="alert">{error}</p> : null}
    </Dialog>
  );
}
