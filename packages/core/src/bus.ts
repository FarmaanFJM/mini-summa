import { topicOf } from '@minisumma/shared';
import type { ServerEvent, Topic } from '@minisumma/shared';
import type { EventBus } from './contracts.ts';

/** In-process event bus with numbered events and a bounded replay buffer for reconnecting clients. */
export function createEventBus(capacity = 2000): EventBus {
  let seq = 0;
  const ring: { seq: number; event: ServerEvent }[] = [];
  const subs = new Set<(seq: number, event: ServerEvent, topic: Topic) => void>();
  return {
    emit(event) {
      seq += 1;
      ring.push({ seq, event });
      if (ring.length > capacity) ring.shift();
      const topic = topicOf(event);
      for (const fn of [...subs]) {
        try { fn(seq, event, topic); } catch { /* one bad subscriber must not stop the others */ }
      }
      return seq;
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
