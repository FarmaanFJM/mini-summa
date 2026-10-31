import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { scopeAllows } from '@minisumma/shared';
import type { ClientState, Scope } from '@minisumma/shared';
import type { ConnectionApi, ConnectionSnapshot } from './ConnectionManager.ts';

const Ctx = createContext<ConnectionApi | null>(null);

/** `api` is null while unpaired. The provider stays mounted either way so the app tree does not remount on pairing. */
export function ConnectionProvider({ api, children }: { api: ConnectionApi | null; children: ReactNode }) {
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** For chrome that may render before pairing (the banner). Screens use useConnectionApi. */
export const useOptionalConnectionApi = (): ConnectionApi | null => useContext(Ctx);

export function useConnectionApi(): ConnectionApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('ConnectionProvider is missing. Screens must be rendered inside a paired session.');
  return api;
}

/** The whole snapshot. Re-renders on every change, so screens that only need the data should use useClientState. */
export function useConnection(): ConnectionSnapshot {
  const api = useConnectionApi();
  return useSyncExternalStore(api.subscribe, api.getSnapshot, api.getSnapshot);
}

export function useClientState(): ClientState {
  return useConnection().state;
}

/** Does this phone's token carry the scope? `desktop` passes everything. Unknown scopes (before the first load) deny. */
export function useCan(scope: Scope): boolean {
  return scopeAllows(useConnection().scopes, scope);
}
