// In-memory status of push registration, shared between the notification bridge (which registers) and Settings (which
// shows the result and offers a retry). Nothing here is persisted.
import { useSyncExternalStore } from 'react';
import type { PushStatus } from './push.ts';

let current: PushStatus = { state: 'unknown' };
const listeners = new Set<() => void>();

export const pushStatusStore = {
  get: (): PushStatus => current,
  set(next: PushStatus): void {
    current = next;
    for (const l of [...listeners]) l();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  reset(): void { pushStatusStore.set({ state: 'unknown' }); },
};

export const usePushStatus = (): PushStatus => useSyncExternalStore(pushStatusStore.subscribe, pushStatusStore.get, pushStatusStore.get);
