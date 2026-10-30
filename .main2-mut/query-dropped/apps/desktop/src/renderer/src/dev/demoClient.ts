// A complete in-memory Mini-Summa for `?demo=1`, tests and screenshots. It is the real SDK (EventStream, TerminalClient)
// talking to a fake core over an in-memory socket, so everything above it behaves exactly as it does against the real core.
import { EventStream, TerminalClient } from '@minisumma/shared';
import type { ApiClient } from '../app/api';
import { createEmptySeed, createSeed } from './demo/seed';
import type { DemoData } from './demo/seed';
import { DemoServer } from './demo/server';

export type DemoScenario = 'normal' | 'empty' | 'loading' | 'error' | 'offline';

export interface DemoClientOptions {
  scenario?: DemoScenario;
  /** Artificial delay per call (ms). */
  latencyMs?: number;
  seed?: DemoData;
}

export interface DemoControls {
  server: DemoServer;
  /** Close every connection, as a network failure would. The client reconnects by itself. */
  drop(): void;
  /** While true, new connections fail at once and the client stays in "reconnecting". */
  setOffline(offline: boolean): void;
}

export type DemoClient = ApiClient & { demo: DemoControls };

export function parseScenario(value: string | null | undefined): DemoScenario {
  return value === 'empty' || value === 'loading' || value === 'error' || value === 'offline' ? value : 'normal';
}

export function createDemoClient(options: DemoClientOptions = {}): DemoClient {
  const scenario = options.scenario ?? 'normal';
  const server = new DemoServer({ seed: options.seed ?? (scenario === 'empty' ? createEmptySeed() : createSeed()), latencyMs: options.latencyMs });
  if (scenario === 'loading') server.stallSnapshot = true;
  if (scenario === 'error') server.failSnapshot = 'The demo core could not read its database.';
  if (scenario === 'offline') server.transport.setOffline(true);

  const events = new EventStream({ baseUrl: 'http://demo.invalid', token: 'demo-token', clientName: 'demo', WebSocket: server.transport.WebSocket });
  const terminal = new TerminalClient(events);
  return {
    call: server.call,
    events,
    terminal,
    demo: { server, drop: () => server.transport.drop(), setOffline: (offline) => server.transport.setOffline(offline) },
  };
}
