// App-level session: loads the stored pairing, owns the ConnectionManager for it, follows the app between foreground and
// background, and wipes the token when the desktop says this phone was removed.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { ConnectionManager } from '../connection/ConnectionManager.ts';
import { ConnectionProvider } from '../connection/context.tsx';
import { createSecureCredentialStore } from '../connection/credentials.ts';
import type { CredentialStore, Credentials } from '../connection/credentials.ts';
import { REVOKED_MESSAGE } from '../lib/errors.ts';

export type SessionPhase = 'loading' | 'unpaired' | 'paired';

export interface SessionValue {
  phase: SessionPhase;
  credentials: Credentials | null;
  /** Shown on the pairing screen, for example after the desktop removed this phone. */
  notice: string | null;
  completePairing(credentials: Credentials): Promise<void>;
  unpair(): Promise<void>;
}

const SessionCtx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('SessionProvider is missing.');
  return v;
}

export interface SessionProviderProps {
  children: ReactNode;
  store?: CredentialStore;
  /** Test seam: build the manager (for example with a fake fetch and WebSocket). */
  createManager?: (credentials: Credentials, onRevoked: () => void) => ConnectionManager;
}

export function SessionProvider({ children, store: injected, createManager }: SessionProviderProps) {
  const store = useMemo(() => injected ?? createSecureCredentialStore(), [injected]);
  const [phase, setPhase] = useState<SessionPhase>('loading');
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const managerRef = useRef<ConnectionManager | null>(null);

  useEffect(() => {
    let alive = true;
    void store.load().then((c) => {
      if (!alive) return;
      setCredentials(c);
      setPhase(c ? 'paired' : 'unpaired');
    });
    return () => { alive = false; };
  }, [store]);

  const manager = useMemo(() => {
    if (!credentials) return null;
    const onRevoked = () => {
      // Clear first: even if the UI is gone, the token must not stay on the phone.
      void store.clear().catch(() => undefined).finally(() => {
        setNotice(REVOKED_MESSAGE);
        setCredentials(null);
        setPhase('unpaired');
      });
    };
    return createManager ? createManager(credentials, onRevoked) : new ConnectionManager({ credentials, onRevoked });
  }, [credentials, store, createManager]);
  managerRef.current = manager;

  useEffect(() => {
    if (!manager) return undefined;
    // Connect unless the app was started in the background (a push can do that); it connects when it comes forward.
    if (AppState.currentState !== 'background') manager.start();
    // Background closes the stream, foreground reopens it and reloads every snapshot.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') manager.start();
      else if (next === 'background') manager.stop();
    });
    return () => { sub.remove(); manager.stop(); };
  }, [manager]);

  const completePairing = useCallback(async (c: Credentials) => {
    await store.save(c);
    setNotice(null);
    setCredentials(c);
    setPhase('paired');
  }, [store]);

  const unpair = useCallback(async () => {
    await store.clear();
    setNotice(null);
    setCredentials(null);
    setPhase('unpaired');
  }, [store]);

  const value = useMemo<SessionValue>(() => ({ phase, credentials, notice, completePairing, unpair }), [phase, credentials, notice, completePairing, unpair]);

  return (
    <SessionCtx.Provider value={value}>
      <ConnectionProvider api={manager}>{children}</ConnectionProvider>
    </SessionCtx.Provider>
  );
}
