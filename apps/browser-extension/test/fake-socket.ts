// A scripted WebSocket and an in-memory storage area for the connection and options tests.
import type { SocketCtor, SocketLike } from '../src/connection.ts';
import type { StorageAreaLike } from '../src/storage.ts';

export class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  openedAt: number;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string, now: () => number) { this.openedAt = now(); }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  /** The TCP and WebSocket handshake finished. */
  open(): void { this.readyState = 1; this.onopen?.({}); }
  /** A frame from the core. */
  receive(msg: unknown): void { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
  /** The core (or the network) ended the connection. */
  serverClose(code: number, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  /** Nothing is listening: the browser reports an error and a 1006 close without ever opening. */
  refuse(): void { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006, reason: '' }); }
  ready(extra: Record<string, unknown> = {}): void {
    this.receive({ t: 'ready', serverTime: '2026-10-30T12:00:00Z', seq: 0, scopes: ['extension'], deviceId: 'dev-1', resync: false, apiVersion: 1, ...extra });
  }
}

export function socketFactory(now: () => number): { Ctor: SocketCtor; sockets: FakeSocket[]; throwOnCreate: { error: Error | null } } {
  const sockets: FakeSocket[] = [];
  const throwOnCreate: { error: Error | null } = { error: null };
  class Ctor extends FakeSocket {
    constructor(url: string) {
      super(url, now);
      if (throwOnCreate.error) throw throwOnCreate.error;
      sockets.push(this);
    }
  }
  return { Ctor, sockets, throwOnCreate };
}

export class MemoryArea implements StorageAreaLike {
  data: Record<string, unknown> = {};
  /** Mirrors chrome.storage.onChanged: called after every single write. Synchronous on purpose: the worst case, a listener
   *  that reads the storage before the next write of the same logical update has happened. */
  onChange: (() => void) | null = null;
  private notify(): void { this.onChange?.(); }
  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.data) out[k] = this.data[k];
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> { Object.assign(this.data, structuredClone(items)); this.notify(); }
  async remove(keys: string[]): Promise<void> { for (const k of keys) delete this.data[k]; this.notify(); }
}
