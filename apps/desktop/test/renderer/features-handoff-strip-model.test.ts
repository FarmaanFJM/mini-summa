// The handoff strip, as plain functions: which delivery waits, in which order, and what the strip says and offers about it.
import type { Delivery, DeliveryPartInfo, DeliveryState } from '@minisumma/shared';
import { describe, expect, it } from 'vitest';
import { describeStrip, isInProgress, STRIP_STATES, waitingDeliveries } from '../../src/renderer/src/features/reports/handoffStripModel';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';

const base = createSeed().deliveries[0];
const part = (index: number, total: number, copied: boolean): DeliveryPartInfo => ({ index, total, chars: 1000, sha256: `p${index}`.padEnd(64, '0'), copiedAt: copied ? '2026-10-30T10:00:00.000Z' : null });
const delivery = (over: Partial<Delivery> & { id: string; state: DeliveryState }): Delivery => ({
  ...base, projectId: IDS.gitManager, taskTitle: `Task ${over.id}`, stateChangedAt: '2026-10-30T10:00:00.000Z', createdAt: '2026-10-30T09:00:00.000Z', ...over,
});

describe('which deliveries wait in the strip', () => {
  it('are only those of the project, in a state the person can act on from here, with somewhere to go', () => {
    const all = [
      delivery({ id: 'ready', state: 'ready_for_handoff' }),
      delivery({ id: 'unverified', state: 'destination_unverified' }),
      delivery({ id: 'copied', state: 'copied' }),
      delivery({ id: 'awaiting', state: 'awaiting_user_send' }),
      delivery({ id: 'missing', state: 'destination_missing', destination: null }),
      delivery({ id: 'setup', state: 'report_captured', destination: null }),
      delivery({ id: 'sent', state: 'user_confirmed_sent' }),
      delivery({ id: 'uncertain', state: 'delivery_uncertain' }),
      delivery({ id: 'discarded', state: 'user_discarded' }),
      delivery({ id: 'other', state: 'ready_for_handoff', projectId: IDS.atlas }),
      delivery({ id: 'noDestination', state: 'ready_for_handoff', destination: null }),
    ];
    expect(waitingDeliveries(all, IDS.gitManager).map((d) => d.id).sort()).toEqual(['awaiting', 'copied', 'ready', 'unverified']);
    expect(waitingDeliveries(all, IDS.atlas).map((d) => d.id)).toEqual(['other']);
    expect(waitingDeliveries(all, 'prj_unknown')).toEqual([]);
    expect([...STRIP_STATES].sort()).toEqual(['awaiting_user_send', 'copied', 'destination_unverified', 'ready_for_handoff']);
  });

  it('put the one the person is in the middle of first, then the newest', () => {
    const all = [
      delivery({ id: 'old-ready', state: 'ready_for_handoff', stateChangedAt: '2026-10-30T08:00:00.000Z' }),
      delivery({ id: 'new-ready', state: 'ready_for_handoff', stateChangedAt: '2026-10-30T11:00:00.000Z' }),
      delivery({ id: 'started', state: 'awaiting_user_send', stateChangedAt: '2026-10-30T07:00:00.000Z' }),
      delivery({ id: 'started-later', state: 'copied', stateChangedAt: '2026-10-30T07:30:00.000Z' }),
    ];
    expect(waitingDeliveries(all, IDS.gitManager).map((d) => d.id)).toEqual(['started-later', 'started', 'new-ready', 'old-ready']);
    expect(isInProgress(all[2])).toBe(true);
    expect(isInProgress(all[0])).toBe(false);
  });

  it('are ordered the same way whatever order they arrive in', () => {
    const all = [
      delivery({ id: 'a', state: 'ready_for_handoff' }), delivery({ id: 'b', state: 'ready_for_handoff' }), delivery({ id: 'c', state: 'ready_for_handoff' }),
    ];
    const forward = waitingDeliveries(all, IDS.gitManager).map((d) => d.id);
    expect(waitingDeliveries([...all].reverse(), IDS.gitManager).map((d) => d.id)).toEqual(forward);
  });
});

describe('what the strip says', () => {
  it('names the report, and where it goes, when it is ready', () => {
    const view = describeStrip([delivery({ id: 'r', state: 'ready_for_handoff', taskTitle: 'Fix the retry test' })], IDS.gitManager, 2)!;
    expect(view.headline).toBe('Report ready: Fix the retry test');
    expect(view.detail).toBe(`Goes to ${base.destination!.title}.`);
    expect(view.waiting).toBe(false);
    expect(view.primary).toMatchObject({ id: 'handoff', label: 'Copy and open' });
    expect([view.secondary, view.quiet]).toEqual([[], []]);
    expect(view.more).toBe(0);
  });

  it('says that the conversation is not verified, without making it a reason to hold back', () => {
    const view = describeStrip([delivery({ id: 'u', state: 'destination_unverified' })], IDS.gitManager, 1)!;
    expect(view.detail).toBe(`Goes to ${base.destination!.title}, which is not verified yet.`);
    expect(view.primary).toMatchObject({ id: 'handoff', label: 'Copy and open' });
  });

  it('says it is waiting for the person, and that it is not marked as sent, once the message was copied', () => {
    for (const state of ['copied', 'awaiting_user_send'] as const) {
      const view = describeStrip([delivery({ id: 'w', state, taskTitle: 'Fix the retry test', parts: [part(1, 1, true)] })], IDS.gitManager, 1)!;
      expect(view.headline).toBe(`Waiting for you to send: Fix the retry test to ${base.destination!.title}.`);
      expect(view.detail).toBe('It is not marked as sent until you press I sent it.');
      expect(view.waiting).toBe(true);
      expect(view.primary).toMatchObject({ id: 'confirmSent', label: 'I sent it' });
      expect(view.secondary.map((b) => b.label)).toEqual(['Copy again', 'Open conversation']);
      expect(view.quiet.map((b) => b.label)).toEqual(['Not sure']);
    }
  });

  it('never says a message was sent before the person did: only the button and the one explanation use the word', () => {
    for (const state of STRIP_STATES) {
      const view = describeStrip([delivery({ id: 's', state, parts: [part(1, 1, true)] })], IDS.gitManager, 1)!;
      const text = [view.headline, view.detail, view.primary?.label, ...view.secondary.map((b) => b.label), ...view.quiet.map((b) => b.label)].join(' | ');
      const allowed = text.replace('It is not marked as sent until you press I sent it.', '').replace('I sent it', '').replace('Waiting for you to send', '');
      expect(allowed, state).not.toMatch(/\bsent\b|\bsending\b|\bdelivered\b|\bsubmitted\b/i);
    }
  });

  it('works through a long message part by part, the way the card does', () => {
    const parts = (copied: number) => Array.from({ length: 3 }, (_, i) => part(i + 1, 3, i < copied));
    const ready = describeStrip([delivery({ id: 'm', state: 'ready_for_handoff', parts: parts(0) })], IDS.gitManager, 1)!;
    expect(ready.primary).toMatchObject({ id: 'handoff', label: 'Copy part 1 of 3 and open', part: 1 });
    expect(ready.detail).toContain('3 parts');
    const afterOne = describeStrip([delivery({ id: 'm', state: 'awaiting_user_send', parts: parts(1) })], IDS.gitManager, 1)!;
    expect(afterOne.primary).toMatchObject({ id: 'handoff', label: 'Copy part 2 of 3 and open', part: 2 });
    expect(afterOne.detail).toBe('1 of 3 parts are copied. Part 2 is next. It is not marked as sent until you press I sent it.');
    expect(afterOne.secondary.map((b) => b.label)).toEqual(['Open conversation']); // copying the whole thing again is the card's business
    const afterAll = describeStrip([delivery({ id: 'm', state: 'awaiting_user_send', parts: parts(3) })], IDS.gitManager, 1)!;
    expect(afterAll.primary).toMatchObject({ id: 'confirmSent', label: 'I sent it' }); // only when every part is copied
    expect(afterAll.detail).toBe('It is not marked as sent until you press I sent it.');
  });

  it('counts the others that wait, and shows the one in progress rather than a newer report', () => {
    const view = describeStrip([
      delivery({ id: 'new', state: 'ready_for_handoff', taskTitle: 'Newer report', stateChangedAt: '2026-10-30T12:00:00.000Z' }),
      delivery({ id: 'started', state: 'awaiting_user_send', taskTitle: 'The one I am pasting', stateChangedAt: '2026-10-30T08:00:00.000Z' }),
      delivery({ id: 'newer', state: 'destination_unverified', stateChangedAt: '2026-10-30T13:00:00.000Z' }),
    ], IDS.gitManager, 1)!;
    expect(view.headline).toContain('The one I am pasting');
    expect(view.more).toBe(2);
  });

  it('says nothing for a project with nothing waiting, and nothing for a report that has nowhere to go', () => {
    expect(describeStrip([], IDS.gitManager, 1)).toBeNull();
    expect(describeStrip([delivery({ id: 'x', state: 'destination_missing', destination: null }), delivery({ id: 'y', state: 'user_confirmed_sent' })], IDS.gitManager, 0)).toBeNull();
  });

  it('keeps the whole title in the sentence, however long, for the tooltip and the accessible name to carry', () => {
    const title = 'Replace the legacy session store '.repeat(12).trim();
    const view = describeStrip([delivery({ id: 'long', state: 'ready_for_handoff', taskTitle: title })], IDS.gitManager, 1)!;
    expect(view.headline).toBe(`Report ready: ${title}`);
  });
});
