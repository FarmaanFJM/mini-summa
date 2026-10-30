// A client that follows the WebSocket must end up with what the API reports. The orchestrator reacts to one event by
// emitting another, and the bus once handed later subscribers the first event under the second one's number, so the
// client's "ignore anything not newer" rule threw it away: the report list was right and the handoff card stayed stale.
// Component tests with a fake stream cannot see this; it needs the real bus, the real WebSocket hub and the orchestrator.
import { afterEach, describe, expect, it } from 'vitest';
import { applyEvent, applySnapshot, createInitialState } from '@minisumma/shared';
import type { ClientState } from '@minisumma/shared';
import { directive } from '../../src/testing/fake-claude/index.ts';
import { cleanup, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const CONV = 'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let h: Harness;
afterEach(async () => { if (h) { await h.stop().catch(() => {}); cleanup(h); } });

describe('the event stream a client follows', () => {
  it('lets a client learn every delivery state through the handoff, in the order the core produced them', async () => {
    h = await startHarness();
    const A = await h.project('GitManager', { conversations: [CONV] });

    // Follow the stream the way a client does: a snapshot first, then each event, applying only what is newer.
    let state: ClientState = applySnapshot(createInitialState(), await h.client.call('system.state'));
    const seqs: number[] = [];
    h.client.events.onEvent((seq, event) => { seqs.push(seq); state = applyEvent(state, seq, event); });

    const s = await h.start(A.project.id);
    await h.type(s.key, `Finish the storage system ${directive.report({ task: 'GitManager Storage System' })}`);
    const delivery = await h.waitFor('a delivery for the report', async () => (await h.client.call('deliveries.list', { query: { projectId: A.project.id } }))[0]);

    const know = (id: string) => state.deliveries.find((d) => d.id === id)?.state;
    await h.waitFor('the client to see the delivery', () => know(delivery.id) !== undefined);

    for (const [step, expected] of [
      [() => h.client.call('deliveries.handoff', { params: { id: delivery.id }, body: {} }), 'awaiting_user_send'],
      [() => h.client.call('deliveries.confirmSent', { params: { id: delivery.id }, body: {} }), 'user_confirmed_sent'],
    ] as const) {
      await step();
      expect((await h.client.call('deliveries.get', { params: { id: delivery.id } })).state).toBe(expected);
      await h.waitFor(`the client to learn "${expected}"`, () => know(delivery.id) === expected, 5_000);
    }

    // The report's own row (which carries a delivery summary) and the delivery list agree, and the numbers only go up.
    const row = state.reports.find((r) => r.delivery?.id === delivery.id);
    expect(row?.delivery?.state).toBe('user_confirmed_sent');
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
