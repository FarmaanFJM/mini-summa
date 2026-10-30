import { ConnectionManager } from '../src/connection/ConnectionManager';
import type { ConnectionStatus } from '../src/connection/ConnectionManager';
import type { Credentials } from '../src/connection/credentials';
import { makeAction, makeDevice, makeSession, makeSummary, SESSION_KEY } from './helpers/data';
import { createFakeCore, settle } from './helpers/fakeCore';

const creds: Credentials = { baseUrl: 'https://pc.tail1234.ts.net', token: 'tok-secret', deviceId: 'dev_1', serverName: "Farmaan's PC" };

function setup(seed: Parameters<typeof createFakeCore>[0] = {}, extra: Partial<ConstructorParameters<typeof ConnectionManager>[0]> = {}) {
  const core = createFakeCore(seed);
  const onRevoked = jest.fn();
  const manager = new ConnectionManager({ credentials: creds, fetch: core.fetch, WebSocket: core.WebSocket, onRevoked, ...extra });
  return { core, manager, onRevoked };
}

const statuses = (m: ConnectionManager): ConnectionStatus[] => {
  const seen: ConnectionStatus[] = [m.getSnapshot().status];
  m.subscribe(() => { const s = m.getSnapshot().status; if (seen[seen.length - 1] !== s) seen.push(s); });
  return seen;
};

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 9, 30, 14, 0, 0)); });
afterEach(() => { jest.useRealTimers(); });

describe('connecting and reloading snapshots', () => {
  it('is connecting with no data until the desktop says ready, then loads everything in order', async () => {
    const { core, manager } = setup();
    const seen = statuses(manager);
    manager.start();
    expect(manager.getSnapshot().status).toBe('connecting');
    expect(manager.getSnapshot().state.loaded).toBe(false);

    core.connect();
    await settle();

    const snap = manager.getSnapshot();
    expect(snap.status).toBe('connected');
    expect(snap.state.loaded).toBe(true);
    expect(snap.state.reports).toHaveLength(1);
    expect(snap.state.activity).toHaveLength(1);
    expect(snap.state.actions).toHaveLength(1);
    expect(snap.state.deliveries).toHaveLength(1);
    expect(snap.device?.name).toBe('Pixel 8');
    expect(snap.scopes).toEqual(['read', 'notify', 'prompt', 'approve']);
    expect(seen).toEqual(['idle', 'connecting', 'connected']);

    // system.state first (it carries the sequence number), then reports, activity, actions, deliveries.
    expect(core.requests.map((r) => `${r.method} ${r.path}`).slice(0, 5)).toEqual([
      'GET /state', 'GET /reports', 'GET /activity', 'GET /actions', 'GET /deliveries',
    ]);
    // Every request carries the bearer token; the socket hello does too.
    expect(core.requests.every((r) => r.headers.authorization === 'Bearer tok-secret')).toBe(true);
    expect(core.lastSocket().sent[0]).toMatchObject({ t: 'hello', token: 'tok-secret' });
    expect(core.lastSocket().url).toBe('wss://pc.tail1234.ts.net/ws');
  });

  it('applies live events on top of the snapshot with the shared reducer', async () => {
    const { core, manager } = setup();
    manager.start(); core.connect(); await settle();
    core.emit(11, { type: 'session.upserted', session: makeSession({ state: 'working', stateLabel: 'Working' }) });
    expect(manager.getSnapshot().state.sessions[0].state).toBe('working');
    // An event at or below the snapshot sequence is ignored.
    core.emit(11, { type: 'session.upserted', session: makeSession({ state: 'idle' }) });
    expect(manager.getSnapshot().state.sessions[0].state).toBe('working');
  });

  it('keeps events that arrive while the snapshots are loading', async () => {
    const { core, manager } = setup();
    // The reports request is slow; an event with a newer sequence arrives in the meantime.
    core.on('GET /reports', async () => {
      core.emit(11, { type: 'session.upserted', session: makeSession({ state: 'needs_permission', stateLabel: 'Waiting for your permission' }) });
      return { body: { items: core.data.reports, nextBefore: null } };
    });
    manager.start(); core.connect(); await settle();
    expect(manager.getSnapshot().state.sessions[0].state).toBe('needs_permission');
    expect(manager.getSnapshot().state.seq).toBe(11);
  });
});

describe('dropped connection', () => {
  it('goes reconnecting, then desktop_unreachable, and says when the desktop was last heard from', async () => {
    const { core, manager } = setup();
    const seen = statuses(manager);
    manager.start(); core.connect(); await settle();
    const heardAt = manager.getSnapshot().lastHeardAt;
    expect(heardAt).not.toBeNull();

    jest.setSystemTime(new Date(2026, 9, 30, 14, 5, 0));
    core.setOffline(true);
    core.lastSocket().serverClose(1006);
    await settle();
    expect(manager.getSnapshot().status).toBe('reconnecting');
    // The data is still there, but the snapshot says it is not live and keeps the old time.
    expect(manager.getSnapshot().state.loaded).toBe(true);
    expect(manager.getSnapshot().lastHeardAt).toBe(heardAt);

    await jest.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(manager.getSnapshot().status).toBe('desktop_unreachable');
    expect(manager.getSnapshot().cause).toBe('no_answer');
    expect(manager.getSnapshot().lastHeardAt).toBe(heardAt);
    expect(seen).toEqual(['idle', 'connecting', 'connected', 'reconnecting', 'desktop_unreachable']);
  });

  it('reloads every snapshot when the stream comes back, including after a resync', async () => {
    const { core, manager } = setup();
    manager.start(); core.connect(); await settle();
    expect(core.calls('GET /state')).toHaveLength(1);

    // The desktop is gone for a while, comes back and reports that events were missed.
    core.setOffline(true);
    core.lastSocket().serverClose(1006);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(manager.getSnapshot().status).toBe('desktop_unreachable');
    core.setOffline(false);
    core.data.reports = [makeSummary({ id: 'rep_2', taskTitle: 'Written while the phone was away' }), ...core.data.reports];
    await jest.advanceTimersByTimeAsync(15_000); // the stream retries and opens a new socket
    core.connect({ resync: true, seq: 40 });
    await settle();

    expect(manager.getSnapshot().status).toBe('connected');
    expect(core.calls('GET /state')).toHaveLength(2);
    expect(core.calls('GET /reports')).toHaveLength(2);
    expect(manager.getSnapshot().state.reports.map((r) => r.id)).toEqual(['rep_2', 'rep_1']);
  });

  it('says the desktop answered with an error when only the live connection fails and the proxy returns 502', async () => {
    const { core, manager } = setup();
    core.on('GET /health', () => ({ status: 502, body: { error: { code: 'bad_gateway', message: 'upstream closed' } } }));
    manager.start();
    core.lastSocket().serverFailToOpen();
    await jest.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(manager.getSnapshot().status).toBe('desktop_unreachable');
    expect(manager.getSnapshot().cause).toBe('server_error');
  });

  it('notices when plain requests work but the live connection cannot open', async () => {
    const { core, manager } = setup();
    manager.start();
    core.lastSocket().serverFailToOpen();
    await jest.advanceTimersByTimeAsync(15_000);
    await settle();
    const snap = manager.getSnapshot();
    expect(snap.status).toBe('desktop_unreachable');
    expect(snap.cause).toBe('stream_blocked');
    // The refresh that followed still gives the person current data, honestly marked as not live.
    expect(snap.state.loaded).toBe(true);
  });

  it('is unreachable straight away when the first snapshot request cannot be made', async () => {
    const { core, manager } = setup();
    manager.start();
    core.setOffline(true);
    core.connect();
    await settle();
    expect(manager.getSnapshot().status).toBe('desktop_unreachable');
    expect(manager.getSnapshot().state.loaded).toBe(false);
  });
});

describe('app foreground and background', () => {
  it('closes the stream in the background and reopens it, reloading, in the foreground', async () => {
    const { core, manager } = setup();
    manager.start(); core.connect(); await settle();
    const first = core.lastSocket();

    manager.stop();
    expect(manager.getSnapshot().status).toBe('idle');
    expect(first.readyState).toBe(3);
    expect(manager.getSnapshot().state.loaded).toBe(true); // data is kept, just not live

    manager.start();
    expect(manager.getSnapshot().status).toBe('reconnecting');
    expect(core.sockets).toHaveLength(2);
    core.connect(); await settle();
    expect(manager.getSnapshot().status).toBe('connected');
    expect(core.calls('GET /state')).toHaveLength(2);
  });

  it('start() on a connection that is already open does nothing, so coming back to the app does not drop it', async () => {
    const { core, manager } = setup();
    manager.start(); core.connect(); await settle();
    const socket = core.lastSocket();
    manager.start();
    manager.start();
    expect(core.sockets).toHaveLength(1);
    expect(socket.readyState).toBe(1);
    expect(manager.getSnapshot().status).toBe('connected');
    expect(core.calls('GET /state')).toHaveLength(1);
  });

  it('does not let a stale timer from before the background mark a resumed connection unreachable', async () => {
    const { core, manager } = setup();
    manager.start(); core.connect(); await settle();
    core.lastSocket().serverClose(1006); // starts the unreachable timer
    manager.stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(manager.getSnapshot().status).toBe('idle');
  });
});

describe('a phone that the desktop removed', () => {
  it('is revoked by a 401 on the first snapshot, closes the stream and tells the app to wipe the token', async () => {
    const { core, manager, onRevoked } = setup();
    core.on('GET /state', () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Authentication required.' } } }));
    manager.start(); core.connect(); await settle();
    expect(manager.getSnapshot().status).toBe('revoked');
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(core.lastSocket().readyState).toBe(3);
    // No reconnect storm afterwards.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(core.sockets).toHaveLength(1);
  });

  it('is revoked by a 403 on a read-scope call, which every paired phone may make', async () => {
    const { core, manager, onRevoked } = setup();
    core.on('GET /reports', () => ({ status: 403, body: { error: { code: 'forbidden', message: 'This action is not allowed for this client.' } } }));
    manager.start(); core.connect(); await settle();
    expect(manager.getSnapshot().status).toBe('revoked');
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('is revoked by WebSocket close code 4003 while connected, without reconnecting', async () => {
    const { core, manager, onRevoked } = setup();
    manager.start(); core.connect(); await settle();
    expect(manager.getSnapshot().status).toBe('connected');
    core.lastSocket().serverClose(4003, 'device revoked');
    await settle();
    expect(manager.getSnapshot().status).toBe('revoked');
    expect(onRevoked).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(core.sockets).toHaveLength(1);
  });

  it('is revoked when the desktop no longer accepts the token at hello (error unauthorized, then close 4401)', async () => {
    const { core, manager, onRevoked } = setup();
    manager.start();
    const socket = core.lastSocket();
    socket.serverOpen();
    // This is what the real core sends for an unknown or revoked token.
    socket.serverSend({ t: 'error', code: 'unauthorized', message: 'The token was not accepted. Pair this device again or ask the owner for a new token.', fatal: true });
    socket.serverClose(4401, 'unauthorized');
    await settle();
    expect(manager.getSnapshot().status).toBe('revoked');
    expect(onRevoked).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(core.sockets).toHaveLength(1);
  });

  it('is revoked by close 4401 alone, in case the error message was lost', async () => {
    const { core, manager, onRevoked } = setup();
    manager.start();
    core.lastSocket().serverOpen();
    core.lastSocket().serverClose(4401, 'unauthorized');
    await settle();
    expect(manager.getSnapshot().status).toBe('revoked');
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('treats a 403 on an action as a missing permission, not a removal, when the device record is still readable', async () => {
    const { core, manager, onRevoked } = setup();
    core.on('POST /actions/:id/approve', () => ({ status: 403, body: { error: { code: 'forbidden', message: 'This action is not allowed for this client.' } } }));
    manager.start(); core.connect(); await settle();
    const before = core.calls('GET /devices/self').length;
    await expect(manager.call('actions.approve', { params: { id: 'act_1' } })).rejects.toMatchObject({ status: 403 });
    await settle();
    expect(core.calls('GET /devices/self').length).toBe(before + 1); // double checked
    expect(manager.getSnapshot().status).toBe('connected');
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('is revoked when a 403 is followed by a device check that is refused too', async () => {
    const { core, manager, onRevoked } = setup();
    manager.start(); core.connect(); await settle();
    core.on('POST /actions/:id/approve', () => ({ status: 403, body: { error: { code: 'forbidden', message: 'No.' } } }));
    core.on('GET /devices/self', () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Authentication required.' } } }));
    await expect(manager.call('actions.approve', { params: { id: 'act_1' } })).rejects.toMatchObject({ status: 403 });
    await settle();
    expect(manager.getSnapshot().status).toBe('revoked');
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });
});

describe('refresh and paging', () => {
  it('pull to refresh reloads the snapshots', async () => {
    const { core, manager } = setup();
    manager.start(); core.connect(); await settle();
    core.data.actions = [makeAction({ id: 'act_2' }), makeAction({ id: 'act_1' })];
    await manager.refresh();
    expect(manager.getSnapshot().state.actions).toHaveLength(2);
    expect(manager.getSnapshot().refreshing).toBe(false);
  });

  it('loads older reports with the cursor and does not duplicate', async () => {
    const { core, manager } = setup();
    core.on('GET /reports', (req) => (req.query.before
      ? { body: { items: [makeSummary({ id: 'rep_0', taskTitle: 'Older' }), makeSummary({ id: 'rep_1' })], nextBefore: null } }
      : { body: { items: [makeSummary({ id: 'rep_1' })], nextBefore: 'cursor-1' } }));
    manager.start(); core.connect(); await settle();
    expect(manager.getSnapshot().reportsNext).toBe('cursor-1');
    await manager.loadMoreReports();
    expect(manager.getSnapshot().state.reports.map((r) => r.id)).toEqual(['rep_1', 'rep_0']);
    expect(manager.getSnapshot().reportsNext).toBeNull();
  });

  it('puts a created action into state at once', async () => {
    const { core, manager } = setup({ device: makeDevice() });
    manager.start(); core.connect(); await settle();
    manager.upsertAction(makeAction({ id: 'act_9', sessionKey: SESSION_KEY }));
    expect(manager.getSnapshot().state.actions[0].id).toBe('act_9');
  });
});

describe('subscribers', () => {
  it('returns the same snapshot object until something changes (useSyncExternalStore contract)', async () => {
    const { core, manager } = setup();
    manager.start(); core.connect(); await settle();
    expect(manager.getSnapshot()).toBe(manager.getSnapshot());
  });
});
