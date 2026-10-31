// The steps of a handoff, as one set of actions for one delivery: copy and open, copy again, open the conversation, "I sent it",
// "Not sure", discard, reopen. The handoff card (Reports) and the handoff strip (workspace) both use it, so a button means the
// same thing in both places and nothing is worded or checked twice.
//
// Nothing here says a message was sent: copying and opening are not delivery, and "I sent it" is the person's statement.
import type { Delivery } from '@minisumma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp } from '../../app/runtime';
import { toast } from '../../ui';
import { characters, COPYABLE, describeOpen } from './model';
import type { OpenReport } from './model';
import { errorText, useRunner, writeClipboard } from './support';
import type { Runner } from './support';

export interface Copied { text: string }
export interface ClipboardFailure { part: number; partCount: number; text: string; reason: string }

/**
 * Learn how many parts the message has before the person presses anything, so the main button can say which part it copies.
 * Preparing only stores the message on the handoff; nothing is copied, opened or sent. Preparing again changes nothing unless
 * the text would be different (the core checks).
 */
export function usePrepareParts(delivery: Pick<Delivery, 'id' | 'state' | 'parts' | 'destination'> | null): void {
  const api = useApi();
  const reviewSettings = useApp((s) => s.settings?.review);
  const deliveryId = delivery?.id ?? null;
  const needsPrepare = delivery !== null && COPYABLE.includes(delivery.state) && delivery.destination !== null;
  const noParts = (delivery?.parts.length ?? 0) === 0;
  const limits = `${reviewSettings?.maxPartChars}|${reviewSettings?.includeSessionRef}|${reviewSettings?.requestTemplate}`;
  useEffect(() => {
    if (!deliveryId || !needsPrepare) return;
    api.call('deliveries.prepare', { params: { id: deliveryId } }).catch(() => { /* the buttons still work; they just cannot name the part */ });
  }, [api, deliveryId, needsPrepare, noParts, limits]);
}

export interface HandoffActions {
  runner: Runner;
  /** What the last copy put on the clipboard, in words. */
  copied: Copied | null;
  /** What opening the conversation did, in words, with a tone. */
  opened: OpenReport | null;
  /** Set when the text could not be put on the clipboard: the person has to copy it by hand. */
  failure: ClipboardFailure | null;
  /** Copy part `part` (or the next one) to the clipboard and open the frozen destination. */
  handoff(part?: number): Promise<void | undefined>;
  copyPart(part?: number): Promise<void | undefined>;
  openConversation(): Promise<void | undefined>;
  wholeMessage(): Promise<void | undefined>;
  confirmSent(): Promise<void | undefined>;
  markUncertain(): Promise<void | undefined>;
  discard(): Promise<void | undefined>;
  reopen(): Promise<void | undefined>;
}

export function useHandoffActions(delivery: Delivery | null): HandoffActions {
  const api = useApi();
  const native = useNative();
  const runner = useRunner();
  const [opened, setOpened] = useState<OpenReport | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  const [failure, setFailure] = useState<ClipboardFailure | null>(null);

  // Another delivery, or a state the core moved to, makes earlier results obsolete.
  const deliveryId = delivery?.id ?? null;
  const deliveryState = delivery?.state ?? null;
  useEffect(() => { setOpened(null); setCopied(null); setFailure(null); }, [deliveryId]);
  useEffect(() => { if (deliveryState === 'user_confirmed_sent' || deliveryState === 'user_discarded') { setCopied(null); setFailure(null); } }, [deliveryState]);

  const afterCopy = useCallback(async (result: { part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null }) => {
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
  }, [native]);

  const handoff = useCallback((part?: number) => runner.run('handoff', async () => {
    if (!delivery) return;
    setOpened(null);
    const result = await api.call('deliveries.handoff', { params: { id: delivery.id }, body: part ? { part } : {} });
    await afterCopy(result);
    setOpened(describeOpen(result.open));
  }), [api, afterCopy, delivery, runner]);

  const copyPart = useCallback((part?: number) => runner.run(part ? `copy-${part}` : 'copy', async () => {
    if (!delivery) return;
    const result = await api.call('deliveries.copy', { params: { id: delivery.id }, body: part ? { part } : {} });
    await afterCopy(result);
  }), [api, afterCopy, delivery, runner]);

  const openConversation = useCallback(() => runner.run('open', async () => {
    if (!delivery) return;
    const result = await api.call('deliveries.open', { params: { id: delivery.id } });
    setOpened(describeOpen(result.open));
  }), [api, delivery, runner]);

  const wholeMessage = useCallback(() => runner.run('whole', async () => {
    if (!delivery) return;
    const prepared = await api.call('deliveries.prepare', { params: { id: delivery.id } });
    const written = await writeClipboard(native, prepared.message);
    if (!written.ok) { setCopied(null); setFailure({ part: 1, partCount: 1, text: prepared.message, reason: written.reason }); return; }
    setFailure(null);
    setCopied({ text: `The whole message (${characters(prepared.message.length)}) is on your clipboard. This is not recorded as a handoff step.` });
  }), [api, delivery, native, runner]);

  const confirmSent = useCallback(() => runner.run('confirmSent', async () => {
    if (!delivery) return;
    await api.call('deliveries.confirmSent', { params: { id: delivery.id }, body: {} });
  }), [api, delivery, runner]);

  const markUncertain = useCallback(() => runner.run('uncertain', async () => {
    if (!delivery) return;
    await api.call('deliveries.markUncertain', { params: { id: delivery.id }, body: {} });
  }), [api, delivery, runner]);

  const discard = useCallback(() => runner.run('discard', async () => {
    if (!delivery) return;
    const id = delivery.id;
    await api.call('deliveries.discard', { params: { id }, body: {} });
    toast({
      title: 'Handoff discarded', body: 'It is not recorded as sent.',
      action: { label: 'Undo', onClick: () => { void api.call('deliveries.reopen', { params: { id }, body: {} }).catch((err: unknown) => toast({ title: 'Could not undo', body: errorText(err), kind: 'error' })); } },
    });
  }), [api, delivery, runner]);

  const reopen = useCallback(() => runner.run('reopen', async () => {
    if (!delivery) return;
    await api.call('deliveries.reopen', { params: { id: delivery.id }, body: {} });
  }), [api, delivery, runner]);

  return { runner, copied, opened, failure, handoff, copyPart, openConversation, wholeMessage, confirmSent, markUncertain, discard, reopen };
}
