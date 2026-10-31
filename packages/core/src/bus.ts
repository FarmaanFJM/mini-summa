import { topicOf } from '@minisumma/shared';
import type { ServerEvent, Topic } from '@minisumma/shared';
import type { EventBus } from './contracts.ts';

/**
 * In-process event bus with numbered events and a bounded replay buffer for reconnecting clients.
 *
 * Every subscriber sees every event in sequence order, each with its own number. An event that a subscriber emits while
 * another event is still being delivered (the orchestrator turns a delivery change into a report change, for example) is
 * numbered at once but handed to the subscribers only after the current event has reached all of them. Delivering it
 * straight away would let a later subscriber receive the outer event after the inner one, and clients drop any event that
 * is not newer than the last number they saw, so the outer event would be lost without a trace.
 */
export function createEventBus(capacity = 2000): EventBus {
  let seq = 0;
  const ring: { seq: number; event: ServerEvent }[] = [];
  const subs = new Set<(seq: number, event: ServerEvent, topic: Topic) => void>();
  const pending: { seq: number; event: ServerEvent }[] = [];
  let delivering = false;

  function deliver(item: { seq: number; event: ServerEvent }): void {
    let topic: Topic;
    try { topic = topicOf(item.event); } catch { return; }
    for (const fn of [...subs]) {
      try { fn(item.seq, item.event, topic); } catch { /* one bad subscriber must not stop the others */ }
    }
  }

  return {
    emit(event) {
      const mine = ++seq;
      ring.push({ seq: mine, event });
      if (ring.length > capacity) ring.shift();
      pending.push({ seq: mine, event });
      if (!delivering) {
        delivering = true;
        try {
          for (let item = pending.shift(); item; item = pending.shift()) deliver(item);
        } finally {
          delivering = false;
        }
      }
      return mine;
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    get seq() { return seq; },
    since(from) {
      if (from > seq) return null;                      // client is ahead of us: we restarted, it must resync
      if (from === seq) return [];
      if (ring.length === 0 || ring[0].seq > from + 1) return null;   // gap
      return ring.filter((e) => e.seq > from);
    },
  };
}
