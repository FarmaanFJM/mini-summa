// An in-memory stand-in for the core's WebSocket. It speaks the real protocol (hello, ready, numbered events, terminal
// messages), so the real EventStream and TerminalClient from @minisumma/shared run unchanged on top of it.
import { topicOf } from '@minisumma/shared';
import type { ClientMessage, ServerEvent, ServerMessage, SessionKey, Topic, WebSocketCtor, WebSocketLike } from '@minisumma/shared';

type TerminalMessage = Extract<ClientMessage, { t: 'term.attach' | 'term.input' | 'term.resize' | 'term.detach' }>;

export interface TransportHooks {
  /** Terminal traffic from one socket. `reply` sends only to that socket. */
  onTerminal(message: TerminalMessage, reply: (m: ServerMessage) => void, socket: MemorySocket): void;
}

const BUFFER = 500;

export class MemorySocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  authed = false;
  readonly attached = new Set<SessionKey>();

  constructor(readonly url: string, private readonly transport: MemoryTransport) {
    transport.sockets.add(this);
    setTimeout(() => {
      if (this.readyState === 3) return;
      if (transport.offline) { this.shutdown(); return; }
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    const message = JSON.parse(data) as ClientMessage;
    queueMicrotask(() => this.receive(message));
  }

  close(): void { this.shutdown(); }

  /** Close from the server side (network drop). The client sees onclose and reconnects. */
  shutdown(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.transport.sockets.delete(this);
    queueMicrotask(() => this.onclose?.({}));
  }

  deliver(message: ServerMessage): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  private receive(message: ClientMessage): void {
    if (this.readyState !== 1) return;
    switch (message.t) {
      case 'hello': {
        this.authed = true;
        const t = this.transport;
        const missed = message.since !== undefined && message.since !== t.seq;
        this.deliver({ t: 'ready', serverTime: new Date().toISOString(), seq: t.seq, scopes: ['desktop'], deviceId: null, resync: missed, apiVersion: 1 });
        break;
      }
      case 'ping': this.deliver({ t: 'pong' }); break;
      case 'term.attach': case 'term.input': case 'term.resize': case 'term.detach':
        if (this.authed) this.transport.hooks.onTerminal(message, (m) => this.deliver(m), this);
        break;
      default:
    }
  }
}

export class MemoryTransport {
  seq = 0;
  offline = false;
  readonly sockets = new Set<MemorySocket>();
  private readonly log: { seq: number; topic: Topic; event: ServerEvent }[] = [];
  readonly WebSocket: WebSocketCtor;

  constructor(readonly hooks: TransportHooks) {
    const transport = this;
    this.WebSocket = class extends MemorySocket {
      constructor(url: string) { super(url, transport); }
    };
  }

  /** Publish an event: it gets the next sequence number and goes to every connected client. */
  emit(event: ServerEvent): number {
    this.seq += 1;
    const topic = topicOf(event);
    this.log.push({ seq: this.seq, topic, event });
    if (this.log.length > BUFFER) this.log.shift();
    const message: ServerMessage = { t: 'event', seq: this.seq, topic, event };
    for (const s of this.sockets) if (s.authed) s.deliver(message);
    return this.seq;
  }

  /** Terminal output or an exit notice for every socket attached to the session. */
  sendToAttached(key: SessionKey, message: ServerMessage): void {
    for (const s of this.sockets) if (s.attached.has(key)) s.deliver(message);
  }

  /** Simulate a network failure: every socket closes; clients reconnect on their own. */
  drop(): void { for (const s of [...this.sockets]) s.shutdown(); }

  /** While offline every new connection fails at once, so a client stays in "reconnecting". */
  setOffline(offline: boolean): void {
    this.offline = offline;
    if (offline) this.drop();
  }
}
