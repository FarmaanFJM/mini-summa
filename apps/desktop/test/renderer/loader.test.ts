// The loader decides what is on screen after every (re)connect. These tests drive it with a hand-controlled stream and
// hand-resolved requests, so the order of arrival can be arranged to be exactly the awkward one.
import { EMPTY_COUNTS, topicOf } from '@minisumma/shared';
import type { ReportSummary, ServerEvent, StateSnapshot, StreamStatus } from '@minisumma/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/renderer/src/app/api';
import { createLoader } from '../../src/renderer/src/app/loader';
import { createAppStore } from '../../src/renderer/src/app/store';
import { createSeed } from '../../src/renderer/src/dev/demo/seed';
import { defaultSettings } from '@minisumma/shared';

const seed = createSeed(new Date('2026-10-30T10:00:00Z'));

class FakeEvents {
  status: StreamStatus = 'idle';
  lastSeq = 0;
  private readonly eventHandlers = new Set<(seq: number, event: ServerEvent, topic: string) => void>();
  private readonly statusHandlers = new Set<(s: StreamStatus) => void>();
  private readonly readyHandlers = new Set<(i: { seq: number; resync: boolean }) => void>();
  connect = vi.fn(() => { this.setStatus('connecting'); });
  close = vi.fn(() => { this.setStatus('closed'); });
  onEvent(h: (seq: number, event: ServerEvent, topic: string) => void) { this.eventHandlers.add(h); return () => { this.eventHandlers.delete(h); }; }
  onStatus(h: (s: StreamStatus) => void) { this.statusHandlers.add(h); return () => { this.statusHandlers.delete(h); }; }
  onReady(h: (i: { seq: number; resync: boolean }) => void) { this.readyHandlers.add(h); return () => { this.readyHandlers.delete(h); }; }
  setStatus(s: StreamStatus) { this.status = s; for (const h of [...this.statusHandlers]) h(s); }
  /** What the socket does when the core says ready: status open first, then the ready handlers. */
  ready(seq: number, resync = false) { this.setStatus('open'); this.lastSeq = seq; for (const h of [...this.readyHandlers]) h({ seq, resync }); }
  event(seq: number, event: ServerEvent) { this.lastSeq = seq; for (const h of [...this.eventHandlers]) h(seq, event, topicOf(event)); }
}

interface Pending { name: string; input: unknown; resolve(v: unknown): void; reject(e: unknown): void }

function setup(opts: { desktopScope?: boolean } = {}) {
  const events = new FakeEvents();
  const pending: Pending[] = [];
  const api = {
    events,
    terminal: {},
    call: vi.fn((name: string, input?: unknown) => new Promise((resolve, reject) => { pending.push({ name, input, resolve, reject }); })),
  } as unknown as ApiClient;
  const store = createAppStore();
  const loader = createLoader({ api, store, retryBaseMs: 1000, ...opts });
  /** Answer the oldest unanswered request with this name. */
  const answer = (name: string, value: unknown) => {
    const i = pending.findIndex((p) => p.name === name);
    if (i < 0) throw new Error(`no pending ${name}; pending: ${pending.map((p) => p.name).join(', ')}`);
    pending.splice(i, 1)[0].resolve(value);
  };
  const fail = (name: string, error: unknown) => {
    const i = pending.findIndex((p) => p.name === name);
    if (i < 0) throw new Error(`no pending ${name}`);
    pending.splice(i, 1)[0].reject(error);
  };
  const names = () => pending.map((p) => p.name);
  return { events, store, loader, pending, answer, fail, names, api, call: api.call as unknown as ReturnType<typeof vi.fn> };
}

const snapshot = (seq: number, mutate: (s: StateSnapshot) => void = () => {}): StateSnapshot => {
  const snap: StateSnapshot = {
    seq,
    system: { name: 'mini-summa-core', version: 't', apiVersion: 1, mode: 'embedded', platform: 'win32', startedAt: '2026-10-30T09:00:00Z', nativeCapabilities: { clipboard: true, chatgptEmbedded: true, extensionBridge: false, notifications: true, openExternal: true, saveFile: true } },
    projects: structuredClone(seed.projects), conversations: structuredClone(seed.conversations), sessions: structuredClone(seed.sessions),
    counts: { ...EMPTY_COUNTS }, settings: defaultSettings(),
  };
  mutate(snap);
  return snap;
};

const renamed = (id: string, name: string): ServerEvent => ({ type: 'project.upserted', project: { ...structuredClone(seed.projects.find((p) => p.id === id)!), name } });
const report = (id: string, read: boolean): ReportSummary => ({ ...(structuredClone(seed.reports[0]) as ReportSummary), id, read });

async function flush() { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }

const answerAllLists = (t: ReturnType<typeof setup>) => {
  t.answer('reports.list', { items: [], nextBefore: null });
  t.answer('deliveries.list', []);
  t.answer('actions.list', []);
  t.answer('activity.list', { items: [], nextBefore: null });
  t.answer('notifications.list', []);
  t.answer('devices.list', []);
  t.answer('hooks.list', []);
};

describe('loader: snapshot first', () => {
  it('connects the stream and fetches the snapshot on ready, not before', async () => {
    const t = setup();
    t.loader.start();
    expect(t.events.connect).toHaveBeenCalledTimes(1);
    expect(t.call).not.toHaveBeenCalled();
    t.events.ready(5);
    expect(t.names()).toEqual(['system.state']);
    expect(t.store.getState()).toMatchObject({ connection: 'connecting', loaded: false });
  });

  it('fetches the snapshot again on every ready, including a resync', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(5);
    t.answer('system.state', snapshot(5));
    await flush();
    answerAllLists(t);
    await flush();
    expect(t.store.getState().connection).toBe('live');

    t.events.setStatus('reconnecting');
    expect(t.store.getState().connection).toBe('reconnecting');
    t.events.ready(9, true);
    expect(t.names()).toEqual(['system.state']);
    expect(t.store.getState().connection).toBe('syncing');
    expect(t.call.mock.calls.filter((c) => c[0] === 'system.state')).toHaveLength(2);
  });

  it('holds events that arrive during the snapshot request and applies only the ones newer than the snapshot', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(10);
    // While the snapshot is in flight: one event the snapshot will already contain (seq 9) and one it will not (seq 11).
    t.events.event(9, renamed('prj_gitmanager', 'STALE name from before the snapshot'));
    t.events.event(11, renamed('prj_gitmanager', 'Newer than the snapshot'));
    expect(t.store.getState().projects).toHaveLength(0); // nothing is shown until the snapshot is applied

    t.answer('system.state', snapshot(10, (s) => { s.projects.find((p) => p.id === 'prj_gitmanager')!.name = 'Name in the snapshot'; }));
    await flush();
    expect(t.store.getState().projects.find((p) => p.id === 'prj_gitmanager')?.name).toBe('Newer than the snapshot');
    expect(t.store.getState().seq).toBe(11);
  });

  it('keeps the snapshot value when every held event is older than it', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(10);
    t.events.event(8, renamed('prj_gitmanager', 'old 8'));
    t.events.event(10, renamed('prj_gitmanager', 'old 10'));
    t.answer('system.state', snapshot(10, (s) => { s.projects.find((p) => p.id === 'prj_gitmanager')!.name = 'Snapshot name'; }));
    await flush();
    expect(t.store.getState().projects.find((p) => p.id === 'prj_gitmanager')?.name).toBe('Snapshot name');
    expect(t.store.getState().seq).toBe(10);
  });

  it('applies live events normally once the snapshot is in', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(1);
    t.answer('system.state', snapshot(1));
    await flush();
    t.events.event(2, renamed('prj_atlas', 'Atlas, renamed'));
    expect(t.store.getState().projects.find((p) => p.id === 'prj_atlas')?.name).toBe('Atlas, renamed');
  });

  it('ignores a snapshot that a newer ready has superseded', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(1);
    t.events.setStatus('reconnecting');
    t.events.ready(2); // second connect while the first snapshot is still in flight
    expect(t.names()).toEqual(['system.state', 'system.state']);
    t.answer('system.state', snapshot(1, (s) => { s.projects = []; })); // late answer to the first request
    await flush();
    expect(t.store.getState().loaded).toBe(false);
    t.answer('system.state', snapshot(2));
    await flush();
    expect(t.store.getState().loaded).toBe(true);
    expect(t.store.getState().projects).toHaveLength(4);
  });
});

describe('loader: lists', () => {
  async function loadedUpToLists() {
    const t = setup();
    t.loader.start();
    t.events.ready(10);
    t.answer('system.state', snapshot(10));
    await flush();
    return t;
  }

  it('requests every list in parallel after the snapshot', async () => {
    const t = await loadedUpToLists();
    expect(t.names().sort()).toEqual(['actions.list', 'activity.list', 'deliveries.list', 'devices.list', 'hooks.list', 'notifications.list', 'reports.list']);
    expect(t.store.getState().loaded).toBe(true);
    expect(t.store.getState().connection).not.toBe('live'); // still loading lists
  });

  it('skips the desktop-only lists for a token without the desktop scope', async () => {
    const t = setup({ desktopScope: false });
    t.loader.start();
    t.events.ready(1);
    t.answer('system.state', snapshot(1));
    await flush();
    expect(t.names()).not.toContain('devices.list');
    expect(t.names()).not.toContain('hooks.list');
  });

  it('is live once every list has answered', async () => {
    const t = await loadedUpToLists();
    answerAllLists(t);
    await flush();
    const s = t.store.getState();
    expect(s.connection).toBe('live');
    expect(s.listStatus.reports).toBe('ready');
    expect(s.syncedAt).not.toBeNull();
  });

  it('does not let an older list response overwrite a change that arrived while it was in flight', async () => {
    const t = await loadedUpToLists();
    // report r1 changed (read) after the list was computed but before its response arrived.
    t.events.event(11, { type: 'report.upserted', report: report('r1', true) });
    t.answer('reports.list', { items: [report('r1', false), report('r2', false)], nextBefore: null });
    await flush();
    const reports = t.store.getState().reports;
    expect(reports.find((r) => r.id === 'r1')?.read).toBe(true);
    expect(reports.find((r) => r.id === 'r2')?.read).toBe(false);
  });

  it('does not regress other state when it re-applies list events', async () => {
    const t = await loadedUpToLists();
    t.events.event(11, { type: 'activity.read', ids: [], counts: { ...EMPTY_COUNTS, unreadActivity: 5 } });
    t.events.event(12, { type: 'counts', counts: { ...EMPTY_COUNTS, unreadActivity: 2 } });
    t.answer('activity.list', { items: [], nextBefore: null });
    await flush();
    expect(t.store.getState().counts.unreadActivity).toBe(2);
  });

  it('records a failed list without failing the load', async () => {
    const t = await loadedUpToLists();
    t.fail('devices.list', new Error('forbidden'));
    t.answer('reports.list', { items: [], nextBefore: null });
    for (const n of ['deliveries.list', 'actions.list', 'hooks.list']) t.answer(n, []);
    t.answer('activity.list', { items: [], nextBefore: null });
    t.answer('notifications.list', []);
    await flush();
    const s = t.store.getState();
    expect(s.connection).toBe('live');
    expect(s.listStatus.devices).toBe('error');
    expect(s.listErrors.devices).toBe('forbidden');
    expect(s.listStatus.reports).toBe('ready');
  });

  it('removes a deleted project\'s reports, deliveries and history from view', async () => {
    const t = await loadedUpToLists();
    t.answer('reports.list', { items: seed.reports, nextBefore: null });
    t.answer('deliveries.list', seed.deliveries);
    t.answer('activity.list', { items: seed.activity, nextBefore: null });
    for (const n of ['actions.list', 'notifications.list', 'devices.list', 'hooks.list']) t.answer(n, []);
    await flush();
    expect(t.store.getState().reports.some((r) => r.projectId === 'prj_dashboard')).toBe(true);
    t.events.event(11, { type: 'project.removed', id: 'prj_dashboard' });
    const s = t.store.getState();
    expect(s.reports.some((r) => r.projectId === 'prj_dashboard')).toBe(false);
    expect(s.deliveries.some((d) => d.projectId === 'prj_dashboard')).toBe(false);
    expect(s.activity.some((a) => a.projectId === 'prj_dashboard')).toBe(false);
    expect(s.projects.some((p) => p.id === 'prj_dashboard')).toBe(false);
  });
});

describe('loader: failure and recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows why a snapshot failed and tries again, backing off', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(1);
    t.fail('system.state', new Error('database is locked'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.getState().loadError).toBe('database is locked');
    expect(t.store.getState().loaded).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.names()).toEqual(['system.state']);
    t.fail('system.state', new Error('still locked'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.names()).toEqual([]); // the second wait is 2 s, not yet over
    await vi.advanceTimersByTimeAsync(600);
    expect(t.names()).toEqual(['system.state']);
    t.answer('system.state', snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.getState().loadError).toBeNull();
    expect(t.store.getState().loaded).toBe(true);
  });

  it('reload() fetches everything again on request', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(1);
    t.answer('system.state', snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
    answerAllLists(t);
    await vi.advanceTimersByTimeAsync(0);
    void t.loader.reload();
    expect(t.names()).toEqual(['system.state']);
  });

  it('stop() closes the stream and ignores whatever was still in flight', async () => {
    const t = setup();
    t.loader.start();
    t.events.ready(1);
    t.loader.stop();
    expect(t.events.close).toHaveBeenCalled();
    t.answer('system.state', snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.getState().loaded).toBe(false);
  });
});

describe('connection state', () => {
  it('walks connecting, live, reconnecting, syncing, live', async () => {
    const t = setup();
    const seen: string[] = [];
    t.store.subscribe((s) => { if (seen.at(-1) !== s.connection) seen.push(s.connection); });
    t.loader.start();
    t.events.ready(1);
    t.answer('system.state', snapshot(1));
    await flush();
    answerAllLists(t);
    await flush();
    t.events.setStatus('reconnecting');
    t.events.ready(2);
    t.answer('system.state', snapshot(2));
    await flush();
    answerAllLists(t);
    await flush();
    expect(seen).toEqual(['connecting', 'live', 'reconnecting', 'syncing', 'live']);
  });

  it('reports closed when the stream is closed', () => {
    const t = setup();
    t.loader.start();
    t.events.setStatus('closed');
    expect(t.store.getState().connection).toBe('closed');
  });
});
