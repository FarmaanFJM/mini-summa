// The renderer's copy of the core's state: the shared ClientState plus what only this window knows (is the stream live,
// did a list load). Mutation goes through the shared reducers so desktop and phone agree on what an event means.
import { createInitialState } from '@minisumma/shared';
import type { ClientState } from '@minisumma/shared';
import { createStore } from 'zustand';
import type { StoreApi } from 'zustand';

/**
 * connecting    first connection, nothing loaded yet
 * syncing       the stream is open again and the snapshot is being reloaded
 * live          connected and loaded: what is on screen is current
 * reconnecting  the stream dropped; what is on screen is the last known state
 * closed        the stream was closed on purpose or by a fatal error
 */
export type ConnectionState = 'connecting' | 'syncing' | 'live' | 'reconnecting' | 'closed';

export type ListName = 'reports' | 'deliveries' | 'actions' | 'activity' | 'notifications' | 'devices' | 'hooks';
export type ListStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AppMeta {
  connection: ConnectionState;
  /** Why the last snapshot load failed, if it did. Cleared by the next successful load. */
  loadError: string | null;
  listStatus: Record<ListName, ListStatus>;
  listErrors: Partial<Record<ListName, string>>;
  /** Date.now() when the last complete load finished. */
  syncedAt: number | null;
}

export type AppState = ClientState & AppMeta;
export type AppStore = StoreApi<AppState>;

export const LIST_NAMES: ListName[] = ['reports', 'deliveries', 'actions', 'activity', 'notifications', 'devices', 'hooks'];

const idleLists = (): Record<ListName, ListStatus> => ({
  reports: 'idle', deliveries: 'idle', actions: 'idle', activity: 'idle', notifications: 'idle', devices: 'idle', hooks: 'idle',
});

export function createAppStore(): AppStore {
  return createStore<AppState>(() => ({
    ...createInitialState(),
    connection: 'connecting',
    loadError: null,
    listStatus: idleLists(),
    listErrors: {},
    syncedAt: null,
  }));
}

/** True while what is on screen may be out of date. Live-looking UI (state dots, counts) should dim when this is true. */
export const isStale = (s: Pick<AppState, 'connection'>): boolean => s.connection !== 'live';
