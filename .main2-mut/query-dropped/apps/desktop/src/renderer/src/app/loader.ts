// Keeps the store in step with the core.
//
// Ordering rules (this is the part that is easy to get subtly wrong):
//  1. On every `ready` (first connect, reconnect, resync) the snapshot is fetched again. Events that arrive while it is in
//     flight are held back, because applying them to a state that is about to be replaced proves nothing.
//  2. The snapshot is applied, then the held events newer than snapshot.seq are applied in order. Older ones are already
//     inside the snapshot.
//  3. The list endpoints (reports, deliveries, ...) carry no sequence number. While they load, every live event is also
//     remembered; when a list arrives it is set, and the events seen since the requests started are re-applied to that
//     list only, so a change that happened mid-request is never overwritten by an older response.
import { applyEvent, applySnapshot } from '@minisumma/shared';
import type { ClientState, ServerEvent, StreamStatus } from '@minisumma/shared';
import type { ApiClient } from './api';
import type { AppState, AppStore, ConnectionState, ListName } from './store';

interface Held { seq: number; event: ServerEvent }

interface ListJob {
  name: ListName;
  /** Needs the desktop scope; a failure is expected (and ignored) for a token without it. */
  desktopOnly?: boolean;
  load(api: ApiClient): Promise<Partial<ClientState>>;
  handles(event: ServerEvent): boolean;
}

const JOBS: ListJob[] = [
  { name: 'reports', load: async (api) => ({ reports: (await api.call('reports.list', { query: { limit: 200 } })).items }), handles: (e) => e.type === 'report.upserted' },
  { name: 'deliveries', load: async (api) => ({ deliveries: await api.call('deliveries.list') }), handles: (e) => e.type === 'delivery.upserted' },
  { name: 'actions', load: async (api) => ({ actions: await api.call('actions.list', { query: { status: 'open' } }) }), handles: (e) => e.type === 'action.upserted' },
  { name: 'activity', load: async (api) => ({ activity: (await api.call('activity.list', { query: { limit: 200 } })).items }), handles: (e) => e.type === 'activity.added' || e.type === 'activity.updated' || e.type === 'activity.read' },
  { name: 'notifications', load: async (api) => ({ notifications: await api.call('notifications.list', { query: { limit: 100 } }) }), handles: (e) => e.type === 'notification.added' },
  { name: 'devices', desktopOnly: true, load: async (api) => ({ devices: await api.call('devices.list') }), handles: (e) => e.type === 'device.upserted' || e.type === 'device.removed' },
  { name: 'hooks', desktopOnly: true, load: async (api) => ({ hooks: await api.call('hooks.list') }), handles: (e) => e.type === 'hooks.changed' },
];

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The one place the shared reducer is called, plus the clean-up a deleted project needs that the reducer leaves to clients. */
function reduce(state: AppState, seq: number, event: ServerEvent): AppState {
  const next = applyEvent(state, seq, event) as AppState;
  if (next === state || event.type !== 'project.removed') return next;
  const gone = event.id;
  return {
    ...next,
    reports: next.reports.filter((r) => r.projectId !== gone),
    deliveries: next.deliveries.filter((d) => d.projectId !== gone),
    actions: next.actions.filter((a) => a.projectId !== gone),
    activity: next.activity.filter((a) => a.projectId !== gone),
  };
}

/** Re-apply one event, bypassing the sequence guard, but keep only the list it belongs to (each list lives under its own name). */
function reapplyToList(state: AppState, job: ListJob, held: Held): AppState {
  const next = applyEvent({ ...state, seq: held.seq - 1 }, held.seq, held.event) as AppState;
  const key = job.name as keyof ClientState;
  return { ...state, [key]: next[key] } as AppState;
}

export interface LoaderOptions {
  api: ApiClient;
  store: AppStore;
  /** Skip the desktop-only lists (devices, hooks) for a token that cannot read them. Default: load them. */
  desktopScope?: boolean;
  /** First retry delay after a failed snapshot, doubling up to 15 s. Default 1000. */
  retryBaseMs?: number;
}

export interface Loader {
  start(): void;
  stop(): void;
  /** Fetch everything again now (the "Try again" button). */
  reload(): Promise<void>;
  reloadList(name: ListName): Promise<void>;
}

export function createLoader({ api, store, desktopScope = true, retryBaseMs = 1000 }: LoaderOptions): Loader {
  const events = api.events;
  let generation = 0;
  let holding = false;
  let held: Held[] = [];
  let trailing = false;
  let trail: Held[] = [];
  let started = false;
  let stopped = false;
  let phase: 'idle' | 'loading' | 'live' = 'idle';
  let streamStatus: StreamStatus = events.status;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = retryBaseMs;
  const unsubscribers: (() => void)[] = [];

  const jobs = JOBS.filter((j) => desktopScope || !j.desktopOnly);

  const deriveConnection = (): ConnectionState => {
    const everLoaded = store.getState().loaded;
    switch (streamStatus) {
      case 'closed': return 'closed';
      case 'open': return phase === 'live' ? 'live' : everLoaded ? 'syncing' : 'connecting';
      case 'reconnecting': return 'reconnecting';
      default: return everLoaded ? 'reconnecting' : 'connecting';
    }
  };
  const publishConnection = () => {
    const connection = deriveConnection();
    if (store.getState().connection !== connection) store.setState({ connection });
  };

  const applyLive = (seq: number, event: ServerEvent) => store.setState((s) => reduce(s, seq, event));

  const onEvent = (seq: number, event: ServerEvent) => {
    if (holding) { held.push({ seq, event }); return; }
    if (trailing) trail.push({ seq, event });
    applyLive(seq, event);
  };

  async function runList(job: ListJob, myGeneration: number, startSeq: number): Promise<void> {
    store.setState((s) => ({ listStatus: { ...s.listStatus, [job.name]: 'loading' } }));
    try {
      const patch = await job.load(api);
      if (myGeneration !== generation || stopped) return;
      store.setState((s) => {
        let next = { ...s, ...patch } as AppState;
        for (const h of trail) if (h.seq > startSeq && job.handles(h.event)) next = reapplyToList(next, job, h);
        const { [job.name]: _cleared, ...errors } = next.listErrors;
        return { ...next, listErrors: errors, listStatus: { ...next.listStatus, [job.name]: 'ready' } };
      });
    } catch (err) {
      if (myGeneration !== generation || stopped) return;
      store.setState((s) => ({
        listStatus: { ...s.listStatus, [job.name]: 'error' },
        listErrors: { ...s.listErrors, [job.name]: message(err) },
      }));
    }
  }

  async function load(): Promise<void> {
    const mine = ++generation;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    phase = 'loading';
    holding = true;
    held = [];
    trailing = false;
    trail = [];
    publishConnection();

    let snapshot;
    try {
      snapshot = await api.call('system.state');
    } catch (err) {
      if (mine !== generation || stopped) return;
      holding = false;
      held = [];
      store.setState({ loadError: message(err) });
      retryTimer = setTimeout(() => { retryTimer = null; if (!stopped && streamStatus === 'open') void load(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
      return;
    }
    if (mine !== generation || stopped) return;

    // Snapshot first, then only the events it does not already contain.
    store.setState((s) => ({ ...applySnapshot(s, snapshot), loadError: null }) as AppState);
    const pending = held;
    holding = false;
    held = [];
    for (const h of pending) if (h.seq > snapshot.seq) applyLive(h.seq, h.event);
    retryDelay = retryBaseMs;

    trailing = true;
    trail = [];
    const startSeq = store.getState().seq;
    await Promise.allSettled(jobs.map((job) => runList(job, mine, startSeq)));
    if (mine !== generation || stopped) return;
    trailing = false;
    trail = [];
    phase = 'live';
    store.setState({ syncedAt: Date.now() });
    publishConnection();
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      unsubscribers.push(
        events.onEvent(onEvent),
        events.onStatus((status) => {
          streamStatus = status;
          if (status !== 'open') phase = 'idle';
          publishConnection();
        }),
        events.onReady(() => { void load(); }),
      );
      events.connect();
      streamStatus = events.status;
      publishConnection();
    },
    stop() {
      stopped = true;
      started = false;
      generation += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      for (const off of unsubscribers.splice(0)) off();
      events.close();
    },
    reload: () => load(),
    async reloadList(name) {
      const job = jobs.find((j) => j.name === name);
      if (!job) return;
      trailing = true;
      trail = [];
      const startSeq = store.getState().seq;
      await runList(job, generation, startSeq);
      trailing = false;
      trail = [];
    },
  };
}

