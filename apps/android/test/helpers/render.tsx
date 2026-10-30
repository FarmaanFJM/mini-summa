import type { ReactElement } from 'react';
import { act, render } from '@testing-library/react-native';
import { ConnectionManager } from '../../src/connection/ConnectionManager';
import { ConnectionProvider } from '../../src/connection/context';
import type { Credentials } from '../../src/connection/credentials';
import { ToastProvider } from '../../src/ui/overlays';
import { createFakeCore } from './fakeCore';
import type { CoreData, FakeCore } from './fakeCore';
import type { ServerEvent } from '@minisumma/shared';

export const creds: Credentials = { baseUrl: 'https://pc.tail1234.ts.net', token: 'tok-secret', deviceId: 'dev_1', serverName: "Farmaan's PC" };

const managers: ConnectionManager[] = [];
/** Stops every stream a test started, so no timer outlives the test. */
export function disposeAll(): void { while (managers.length) managers.pop()!.dispose(); }

/** Let promises and zero delay timers run, inside act, with real timers. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

export interface Mounted extends Awaited<ReturnType<typeof render>> {
  core: FakeCore;
  manager: ConnectionManager;
}

/** Renders a screen inside a paired, connected session backed by the fake core. */
export async function mount(ui: ReactElement, opts: { seed?: Partial<CoreData>; connect?: boolean; core?: FakeCore } = {}): Promise<Mounted> {
  const core = opts.core ?? createFakeCore(opts.seed);
  const manager = new ConnectionManager({ credentials: creds, fetch: core.fetch, WebSocket: core.WebSocket });
  managers.push(manager);
  manager.start();
  if (opts.connect !== false) { core.connect(); await flush(); }
  const utils = await render(
    <ToastProvider><ConnectionProvider api={manager}>{ui}</ConnectionProvider></ToastProvider>,
  );
  await flush(2);
  return Object.assign(utils, { core, manager });
}

/** A live event from the desktop, delivered inside act so React sees the update the way it would on a device. */
export async function emit(core: FakeCore, seq: number, event: ServerEvent): Promise<void> {
  await act(async () => { core.emit(seq, event); });
  await flush(2);
}
