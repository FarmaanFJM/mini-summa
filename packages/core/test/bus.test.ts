import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@minisumma/shared';
import { createEventBus } from '../src/bus.ts';

// topicOf only looks at `type`, so small stand-ins are enough for what the bus does.
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra }) as unknown as ServerEvent;
const delivery = (state: string) => ev('delivery.upserted', { delivery: { id: 'd1', state } });
const report = () => ev('report.upserted', { report: { id: 'r1' } });
const counts = () => ev('counts', { counts: { unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 0 } });

const label = (seq: number, event: ServerEvent) => `${seq}:${event.type}${'delivery' in event ? `:${(event as { delivery: { state: string } }).delivery.state}` : ''}`;

describe('event bus: numbering and replay', () => {
  it('numbers events from one, returns the number, and keeps it in `seq`', () => {
    const bus = createEventBus();
    expect(bus.seq).toBe(0);
    expect(bus.emit(counts())).toBe(1);
    expect(bus.emit(counts())).toBe(2);
    expect(bus.seq).toBe(2);
  });

  it('replays what a reconnecting client missed, and says when it cannot', () => {
    const bus = createEventBus(3);
    for (let i = 0; i < 5; i += 1) bus.emit(counts());
    expect(bus.since(5)).toEqual([]);
    expect(bus.since(4)?.map((e) => e.seq)).toEqual([5]);
    expect(bus.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(bus.since(1)).toBeNull();   // the buffer starts at 3: events 2 are gone
    expect(bus.since(9)).toBeNull();   // the client is ahead of this process: it must resync
  });
});

describe('event bus: events emitted while another event is being delivered', () => {
  it('hands every subscriber the outer event first, each event under its own number', () => {
    const bus = createEventBus();
    const innerSeq: number[] = [];
    // The orchestrator: reacts to a delivery change by emitting a report change.
    bus.subscribe((_s, e) => { if (e.type === 'delivery.upserted') innerSeq.push(bus.emit(report())); });
    const hubSeen: string[] = [];
    bus.subscribe((s, e) => { hubSeen.push(label(s, e)); });   // the WebSocket hub, registered after it
    const outer = bus.emit(delivery('awaiting_user_send'));
    expect(outer).toBe(1);
    expect(innerSeq).toEqual([2]);
    expect(hubSeen).toEqual(['1:delivery.upserted:awaiting_user_send', '2:report.upserted']);
  });

  it('delivers the nested event before the outer emit returns', () => {
    const bus = createEventBus();
    bus.subscribe((_s, e) => { if (e.type === 'delivery.upserted') bus.emit(counts()); });
    const seen: string[] = [];
    bus.subscribe((s, e) => { seen.push(label(s, e)); });
    bus.emit(delivery('copied'));
    expect(seen).toEqual(['1:delivery.upserted:copied', '2:counts']);
  });

  it('keeps a chain of nested events in order', () => {
    const bus = createEventBus();
    bus.subscribe((_s, e) => {
      if (e.type === 'delivery.upserted') bus.emit(report());
      else if (e.type === 'report.upserted') bus.emit(counts());
    });
    const seen: string[] = [];
    bus.subscribe((s, e) => { seen.push(label(s, e)); });
    bus.emit(delivery('copied'));
    expect(seen).toEqual(['1:delivery.upserted:copied', '2:report.upserted', '3:counts']);
    expect(bus.since(0)?.map((e) => `${e.seq}:${e.event.type}`)).toEqual(['1:delivery.upserted', '2:report.upserted', '3:counts']);
  });

  it('delivers several events emitted by one subscriber in the order it emitted them, after the current one', () => {
    const bus = createEventBus();
    bus.subscribe((_s, e) => { if (e.type === 'delivery.upserted') { bus.emit(report()); bus.emit(counts()); } });
    const seen: string[] = [];
    bus.subscribe((s, e) => { seen.push(label(s, e)); });
    bus.emit(delivery('copied'));
    expect(seen).toEqual(['1:delivery.upserted:copied', '2:report.upserted', '3:counts']);
  });

  it('gives every subscriber a strictly increasing run of numbers whatever the nesting', () => {
    const bus = createEventBus();
    let budget = 60;
    const kinds = [delivery('copied'), report(), counts()];
    for (let i = 0; i < 3; i += 1) {
      bus.subscribe((_s, e) => {
        // Pseudo-random but deterministic: a few subscribers each add events while handling others.
        if (budget > 0 && (e.type.length + i) % 2 === 0) { budget -= 1; bus.emit(kinds[(budget + i) % kinds.length]); }
      });
    }
    const runs: number[][] = [[], []];
    runs.forEach((run) => bus.subscribe((s) => { run.push(s); }));
    for (let i = 0; i < 12; i += 1) bus.emit(kinds[i % kinds.length]);
    for (const run of runs) {
      expect(run.length).toBe(bus.seq);
      expect(run).toEqual(Array.from({ length: bus.seq }, (_v, i) => i + 1));
    }
  });
});

describe('event bus: subscribers that misbehave', () => {
  it('one that throws does not stop the others or leave the bus stuck', () => {
    const bus = createEventBus();
    bus.subscribe(() => { throw new Error('bad subscriber'); });
    const seen: string[] = [];
    bus.subscribe((s, e) => { seen.push(label(s, e)); });
    bus.emit(counts());
    bus.emit(counts());
    expect(seen).toEqual(['1:counts', '2:counts']);
  });

  it('one that throws after emitting still lets the nested event through', () => {
    const bus = createEventBus();
    bus.subscribe((_s, e) => { if (e.type === 'delivery.upserted') { bus.emit(counts()); throw new Error('after emitting'); } });
    const seen: string[] = [];
    bus.subscribe((s, e) => { seen.push(label(s, e)); });
    bus.emit(delivery('copied'));
    expect(seen).toEqual(['1:delivery.upserted:copied', '2:counts']);
  });

  it('one that unsubscribes while an event is delivered still receives that event, and nothing after', () => {
    const bus = createEventBus();
    const seen: number[] = [];
    const off = bus.subscribe((s) => { seen.push(s); off(); });
    bus.emit(counts());
    bus.emit(counts());
    expect(seen).toEqual([1]);
  });
});
