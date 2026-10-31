import { AppState } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { SessionProvider, useSession } from '../src/session/SessionProvider';
import { ConnectionManager } from '../src/connection/ConnectionManager';
import type { CredentialStore, Credentials } from '../src/connection/credentials';
import { createFakeCore } from './helpers/fakeCore';
import type { FakeCore } from './helpers/fakeCore';
import { flush } from './helpers/render';
import { Text } from 'react-native';

const creds: Credentials = { baseUrl: 'https://pc.tail1234.ts.net', token: 'tok-secret', deviceId: 'dev_1', serverName: "Farmaan's PC" };

function memoryStore(initial: Credentials | null): CredentialStore & { current: () => Credentials | null } {
  let c = initial;
  return {
    load: jest.fn(async () => c),
    save: jest.fn(async (x: Credentials) => { c = x; }),
    clear: jest.fn(async () => { c = null; }),
    current: () => c,
  };
}

function Probe() {
  const s = useSession();
  return <Text testID="probe">{`${s.phase}|${s.notice ?? ''}`}</Text>;
}

const factory = (core: FakeCore) => (c: Credentials, onRevoked: () => void) =>
  new ConnectionManager({ credentials: c, fetch: core.fetch, WebSocket: core.WebSocket, onRevoked });

describe('session provider', () => {
  it('starts unpaired when nothing is stored', async () => {
    const core = createFakeCore();
    await render(<SessionProvider store={memoryStore(null)} createManager={factory(core)}><Probe /></SessionProvider>);
    await flush();
    expect(screen.getByTestId('probe').props.children).toBe('unpaired|');
    expect(core.sockets).toHaveLength(0);
  });

  it('connects with the stored pairing', async () => {
    const core = createFakeCore();
    await render(<SessionProvider store={memoryStore(creds)} createManager={factory(core)}><Probe /></SessionProvider>);
    await flush();
    expect(screen.getByTestId('probe').props.children).toBe('paired|');
    expect(core.sockets).toHaveLength(1);
    expect(core.sockets[0].url).toBe('wss://pc.tail1234.ts.net/ws');
  });

  it('wipes the token and says "This phone was removed in Mini-Summa. Pair again." when the desktop refuses it', async () => {
    const core = createFakeCore();
    core.on('GET /state', () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Authentication required.' } } }));
    const store = memoryStore(creds);
    await render(<SessionProvider store={store} createManager={factory(core)}><Probe /></SessionProvider>);
    await flush();
    await act(async () => { core.connect(); });
    await flush();
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.current()).toBeNull();
    expect(screen.getByTestId('probe').props.children).toBe('unpaired|This phone was removed in Mini-Summa. Pair again.');
    expect(core.lastSocket().readyState).toBe(3);
  });

  it('wipes the token when the live connection is closed with code 4003', async () => {
    const core = createFakeCore();
    const store = memoryStore(creds);
    await render(<SessionProvider store={store} createManager={factory(core)}><Probe /></SessionProvider>);
    await flush();
    await act(async () => { core.connect(); });
    await flush();
    expect(screen.getByTestId('probe').props.children).toBe('paired|');
    await act(async () => { core.lastSocket().serverClose(4003, 'device revoked'); });
    await flush();
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('probe').props.children).toContain('unpaired|This phone was removed');
  });

  it('closes the stream when the app goes to the background and reopens it in the foreground', async () => {
    let onChange: (s: string) => void = () => undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, cb: (s: string) => void) => { onChange = cb; return { remove: jest.fn() }; }) as never);
    const core = createFakeCore();
    await render(<SessionProvider store={memoryStore(creds)} createManager={factory(core)}><Probe /></SessionProvider>);
    await flush();
    await act(async () => { core.connect(); });
    await flush();
    const first = core.lastSocket();

    await act(async () => { onChange('background'); });
    expect(first.readyState).toBe(3);

    await act(async () => { onChange('active'); });
    expect(core.sockets).toHaveLength(2);
    expect(core.lastSocket()).not.toBe(first);
  });

  it('saving a pairing and unpairing go through secure storage', async () => {
    const core = createFakeCore();
    const store = memoryStore(null);
    let session!: ReturnType<typeof useSession>;
    function Grab() { session = useSession(); return null; }
    await render(<SessionProvider store={store} createManager={factory(core)}><Grab /></SessionProvider>);
    await flush();
    await act(async () => { await session.completePairing(creds); });
    expect(store.save).toHaveBeenCalledWith(creds);
    expect(session.phase).toBe('paired');
    await act(async () => { await session.unpair(); });
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(session.phase).toBe('unpaired');
  });
});
