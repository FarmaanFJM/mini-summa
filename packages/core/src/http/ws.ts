// WebSocket /ws: numbered events, terminal multiplexing and the extension bridge on one socket per client.
//
// Protocol: shared/events.ts. Close codes used here (all application codes in the 4000 range):
//   4001 no valid `hello` (late, missing, malformed or garbage before hello)
//   4003 revoked device, or an `Origin: chrome-extension://` socket whose principal has no `extension` scope
//   4401 the hello token was not accepted
// Local decisions (also listed in the worker report):
//  * `ready.seq` is the sequence number after which this connection will deliver events. For a fresh connection and for
//    `resync: true` that is the head of the bus. For a resumed connection (`hello.since` the buffer still reaches) it is
//    `since`, because the shared EventStream ignores events whose seq is <= ready.seq and the missed events follow.
//  * Events need the `read` scope (the same bar as `system.state`). `hooks.changed` and `tailscale.changed` need `desktop`,
//    like the REST routes that expose the same data. 'devices' and 'settings' topics are desktop only.
//  * A slow client (unsent data above the limit) is terminated, not closed politely: its close frame would queue behind
//    the data it is not reading.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { z } from 'zod';
import { ALL_TOPICS, API_VERSION, DESKTOP_ONLY_TOPICS, isSessionKey, scopeAllows, topicOf } from '@minisumma/shared';
import type { Device, ServerEvent, ServerMessage, SessionKey, Topic } from '@minisumma/shared';
import type { CoreBase, DevicesService, ExtensionBridge, Principal, SessionsService, TerminalAttachment, TerminalSink } from '../contracts.ts';
import { hasDesktopScope, hasExtensionScope } from './auth.ts';
import type { OriginKind } from './auth.ts';
import { createBridgeHub } from './bridge.ts';
import type { BridgePeer } from './bridge.ts';
import { describeIssues } from './responses.ts';

const sessionKeySchema = z.string().refine((v) => isSessionKey(v), 'Not a valid session key') as unknown as z.ZodType<SessionKey>;
const size = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) };
const topicList = z.array(z.string().max(40)).max(64);

const clientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().min(1).max(512), client: z.string().max(200).default('client'), since: z.number().int().min(0).optional(), topics: topicList.optional() }),
  z.object({ t: z.literal('subscribe'), topics: topicList }),
  z.object({ t: z.literal('unsubscribe'), topics: topicList }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('term.attach'), key: sessionKeySchema, ...size }),
  z.object({ t: z.literal('term.input'), key: sessionKeySchema, data: z.string().max(262_144) }),
  z.object({ t: z.literal('term.resize'), key: sessionKeySchema, ...size }),
  z.object({ t: z.literal('term.detach'), key: sessionKeySchema }),
  z.object({ t: z.literal('bridge.result'), requestId: z.string().min(1).max(100), ok: z.boolean(), data: z.unknown().optional(), error: z.string().max(2000).optional() }),
]);
type ClientMsg = z.infer<typeof clientMessage>;

const KNOWN_TYPES = new Set(['hello', 'subscribe', 'unsubscribe', 'ping', 'term.attach', 'term.input', 'term.resize', 'term.detach', 'bridge.result']);
const TOPIC_SET = new Set<string>(ALL_TOPICS);
const isTopic = (t: string): t is Topic => TOPIC_SET.has(t);
const MAX_PAYLOAD = 1024 * 1024;
const HEARTBEAT_MS = 30_000;

interface Attachment { handle: TerminalAttachment | null; ready: boolean; queue: ServerMessage[] }

interface Conn {
  ws: WebSocket;
  via: Principal['via'];
  origin: OriginKind;
  principal: Principal | null;
  client: string;
  topics: Set<Topic>;
  attachments: Map<SessionKey, Attachment>;
  helloTimer: NodeJS.Timeout | null;
  alive: boolean;
  peer: BridgePeer;
}

export interface WsHubDeps {
  base: CoreBase;
  devices: DevicesService;
  sessions: SessionsService;
  tuning: { helloTimeoutMs: number; bridgeTimeoutMs: number; maxBufferedBytes: number };
}

export interface WsHub {
  bridge: ExtensionBridge;
  /** Completes the handshake of an upgrade request that already passed the Host and Origin checks. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: { via: Principal['via']; origin: OriginKind }): void;
  start(): void;
  stop(): Promise<void>;
}

const text = (data: RawData): string =>
  Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');

export function createWsHub(deps: WsHubDeps): WsHub {
  const { base, devices, sessions, tuning } = deps;
  const log = base.log;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  const bridgeHub = createBridgeHub({ timeoutMs: tuning.bridgeTimeoutMs });
  const conns = new Set<Conn>();
  let unsubscribeBus: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  // ---- sending ----------------------------------------------------------------------------------------------

  function drop(conn: Conn, why: string): void {
    log.warn('ws.dropped', { reason: why, deviceId: conn.principal?.deviceId ?? null });
    conn.ws.terminate();
  }

  function send(conn: Conn, msg: ServerMessage): boolean {
    const ws = conn.ws;
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg), () => { /* a failed write shows up as close/error on the socket */ });
    if (ws.bufferedAmount > tuning.maxBufferedBytes) { drop(conn, 'slow client'); return false; }
    return true;
  }

  function closeWith(conn: Conn, code: number, reason: string): void {
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) conn.ws.close(code, reason);
  }

  function fatal(conn: Conn, code: string, message: string, closeCode: number, reason: string): void {
    send(conn, { t: 'error', code, message, fatal: true });
    closeWith(conn, closeCode, reason);
  }

  /** Garbage before hello ends the connection; afterwards it only earns an error message. */
  function reject(conn: Conn, code: string, message: string): void {
    if (!conn.principal) fatal(conn, code, message, 4001, 'hello required');
    else send(conn, { t: 'error', code, message });
  }

  // ---- events -------------------------------------------------------------------------------------------------

  function visible(conn: Conn, topic: Topic, event: ServerEvent): boolean {
    const p = conn.principal;
    if (!p || !scopeAllows(p.scopes, 'read') || !conn.topics.has(topic)) return false;
    if (!hasDesktopScope(p)) {
      if (DESKTOP_ONLY_TOPICS.includes(topic)) return false;
      if (event.type === 'hooks.changed' || event.type === 'tailscale.changed') return false;
    }
    return true;
  }

  function deliver(conn: Conn, seq: number, topic: Topic, event: ServerEvent): void {
    if (visible(conn, topic, event)) send(conn, { t: 'event', seq, topic, event });
  }

  function closeDevice(deviceId: string): void {
    for (const conn of conns) {
      if (conn.principal?.deviceId !== deviceId) continue;
      closeWith(conn, 4003, 'revoked');
      // A client that ignores the close handshake must not keep a revoked token alive.
      setTimeout(() => { if (conn.ws.readyState !== WebSocket.CLOSED) conn.ws.terminate(); }, 2000).unref();
    }
  }

  function refreshDevice(device: Device): void {
    for (const conn of conns) {
      const p = conn.principal;
      if (!p || p.deviceId !== device.id) continue;
      conn.principal = { ...p, name: device.name, scopes: device.scopes, trusted: device.trusted };
      if (!hasExtensionScope(conn.principal)) bridgeHub.unregister(conn.peer);
      if (!hasDesktopScope(conn.principal)) detachAll(conn);
    }
  }

  function onBusEvent(seq: number, event: ServerEvent, topic: Topic): void {
    try {
      if (event.type === 'device.removed') closeDevice(event.id);
      else if (event.type === 'device.upserted') {
        if (event.device.revokedAt) closeDevice(event.device.id); else refreshDevice(event.device);
      }
    } catch (err) {
      log.error('ws.device_event_failed', { message: (err as Error).message });
    }
    for (const conn of [...conns]) if (conn.principal) deliver(conn, seq, topic, event);
  }

  // ---- terminals ----------------------------------------------------------------------------------------------

  function termError(conn: Conn, key: SessionKey, code: string, message: string): void {
    send(conn, { t: 'term.error', key, code, message });
  }

  function detachAll(conn: Conn): void {
    for (const [key, a] of conn.attachments) {
      try { a.handle?.detach(); } catch (err) { log.warn('ws.detach_failed', { key, message: (err as Error).message }); }
    }
    conn.attachments.clear();
  }

  function onTermAttach(conn: Conn, msg: Extract<ClientMsg, { t: 'term.attach' }>): void {
    if (!conn.principal || !hasDesktopScope(conn.principal)) {
      termError(conn, msg.key, 'forbidden', 'Terminals can only be opened from the desktop app.');
      return;
    }
    const previous = conn.attachments.get(msg.key);
    if (previous) {
      try { previous.handle?.detach(); } catch { /* replaced below */ }
      conn.attachments.delete(msg.key);
    }
    const state: Attachment = { handle: null, ready: false, queue: [] };
    conn.attachments.set(msg.key, state);
    const push = (m: ServerMessage): void => {
      if (conn.attachments.get(msg.key) !== state) return; // detached or replaced
      if (state.ready) send(conn, m); else state.queue.push(m);
    };
    const sink: TerminalSink = {
      data: (seq, data) => push({ t: 'term.data', key: msg.key, seq, data }),
      exit: (info) => push({ t: 'term.exit', key: msg.key, code: info.code, signal: info.signal, at: info.at, reason: info.reason }),
    };
    let result: TerminalAttachment | { error: string };
    try {
      result = sessions.terminal.attach(msg.key, { cols: msg.cols, rows: msg.rows }, sink);
    } catch (err) {
      log.error('ws.term_attach_failed', { message: (err as Error).message });
      result = { error: 'The terminal could not be opened. Try again.' };
    }
    if ('error' in result) {
      conn.attachments.delete(msg.key);
      termError(conn, msg.key, 'attach_failed', result.error);
      return;
    }
    state.handle = result;
    send(conn, { t: 'term.attached', key: msg.key, replay: result.replay, seq: result.seq, cols: result.cols, rows: result.rows });
    state.ready = true;
    // Output produced while attaching is delivered after `term.attached`; what the replay already contains is skipped.
    const queued = state.queue;
    state.queue = [];
    for (const m of queued) if (m.t !== 'term.data' || m.seq > result.seq) send(conn, m);
  }

  function attached(conn: Conn, key: SessionKey): Attachment | null {
    const a = conn.attachments.get(key);
    if (!a?.handle) { termError(conn, key, 'not_attached', 'This terminal is not open on this connection. Attach first.'); return null; }
    return a;
  }

  // ---- messages -----------------------------------------------------------------------------------------------

  function onHello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (conn.principal) { send(conn, { t: 'error', code: 'already_authenticated', message: 'This connection already said hello.' }); return; }
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    let principal: Principal | null;
    try { principal = devices.authenticate(msg.token, conn.via); } catch (err) {
      log.error('ws.authenticate_failed', { message: (err as Error).message });
      return fatal(conn, 'internal_error', 'Sign-in failed inside Mini-Summa. Try again.', 1011, 'internal error');
    }
    if (!principal) {
      return fatal(conn, 'unauthorized', 'The token was not accepted. Pair this device again or ask the owner for a new token.', 4401, 'unauthorized');
    }
    if (conn.origin === 'extension' && !hasExtensionScope(principal)) {
      return fatal(conn, 'origin_not_allowed', 'Only the Mini-Summa browser extension may connect from a browser extension.', 4003, 'origin not allowed');
    }
    conn.principal = principal;
    conn.client = msg.client.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
    const requested = (msg.topics ?? ALL_TOPICS).filter(isTopic);
    conn.topics = new Set(requested);

    // Everything below is synchronous, so no bus event can slip between the replay and the live stream.
    let resync = false;
    let readySeq = base.bus.seq;
    let missed: { seq: number; event: ServerEvent }[] = [];
    if (msg.since !== undefined) {
      const since = base.bus.since(msg.since);
      if (since === null) resync = true; else { missed = since; readySeq = msg.since; }
    }
    send(conn, { t: 'ready', serverTime: base.clock.now().toISOString(), seq: readySeq, scopes: principal.scopes, deviceId: principal.deviceId, resync, apiVersion: API_VERSION });
    for (const m of missed) deliver(conn, m.seq, topicOf(m.event), m.event);
    if (hasExtensionScope(principal)) bridgeHub.register(conn.peer);
    log.debug('ws.hello', { client: conn.client, deviceId: principal.deviceId, via: conn.via, resync });
  }

  function onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (isBinary) return reject(conn, 'bad_message', 'Binary messages are not supported. Send JSON text.');
    let raw: unknown;
    try { raw = JSON.parse(text(data)); } catch { return reject(conn, 'bad_json', 'The message is not valid JSON.'); }
    const t = raw !== null && typeof raw === 'object' ? (raw as { t?: unknown }).t : undefined;
    if (typeof t !== 'string') return reject(conn, 'bad_message', 'Every message is a JSON object with a "t" field.');
    if (!KNOWN_TYPES.has(t)) return reject(conn, 'unknown_message', `Unknown message type "${t.slice(0, 40)}".`);
    if (!conn.principal && t !== 'hello') return fatal(conn, 'hello_required', 'The first message must be "hello" with your token.', 4001, 'hello required');
    const parsed = clientMessage.safeParse(raw);
    if (!parsed.success) return reject(conn, 'bad_message', `The "${t}" message is not valid: ${describeIssues(parsed.error.issues)}.`);
    const msg = parsed.data;
    switch (msg.t) {
      case 'hello': return onHello(conn, msg);
      case 'ping': send(conn, { t: 'pong' }); return;
      case 'subscribe': for (const topic of msg.topics) if (isTopic(topic)) conn.topics.add(topic); return;
      case 'unsubscribe': for (const topic of msg.topics) conn.topics.delete(topic as Topic); return;
      case 'term.attach': return onTermAttach(conn, msg);
      case 'term.input': {
        if (!hasDesktopScope(conn.principal!)) return termError(conn, msg.key, 'forbidden', 'Terminals can only be used from the desktop app.');
        if (!attached(conn, msg.key)) return;
        if (!sessions.terminal.input(msg.key, msg.data)) termError(conn, msg.key, 'not_writable', 'The terminal did not accept the input. The session may have ended.');
        return;
      }
      case 'term.resize': {
        if (!hasDesktopScope(conn.principal!)) return termError(conn, msg.key, 'forbidden', 'Terminals can only be used from the desktop app.');
        if (!attached(conn, msg.key)) return;
        sessions.terminal.resize(msg.key, msg.cols, msg.rows);
        return;
      }
      case 'term.detach': {
        const a = conn.attachments.get(msg.key);
        conn.attachments.delete(msg.key);
        try { a?.handle?.detach(); } catch (err) { log.warn('ws.detach_failed', { message: (err as Error).message }); }
        return;
      }
      case 'bridge.result': {
        if (!hasExtensionScope(conn.principal!)) {
          send(conn, { t: 'error', code: 'forbidden', message: 'Only the browser extension may send bridge results.' });
          return;
        }
        bridgeHub.onResult(conn.peer, { requestId: msg.requestId, ok: msg.ok, data: msg.data, error: msg.error });
        return;
      }
    }
  }

  function onClose(conn: Conn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    conns.delete(conn);
    detachAll(conn);
    bridgeHub.unregister(conn.peer);
  }

  function onConnection(ws: WebSocket, ctx: { via: Principal['via']; origin: OriginKind }): void {
    const conn: Conn = {
      ws, via: ctx.via, origin: ctx.origin, principal: null, client: '', topics: new Set(), attachments: new Map(),
      helloTimer: null, alive: true,
      peer: { send: (m) => send(conn, m), isOpen: () => ws.readyState === WebSocket.OPEN },
    };
    conns.add(conn);
    conn.helloTimer = setTimeout(() => {
      conn.helloTimer = null;
      fatal(conn, 'hello_timeout', 'No hello message arrived in time. The first message must be "hello" with your token.', 4001, 'hello required');
    }, tuning.helloTimeoutMs);
    ws.on('message', (data, isBinary) => {
      try { onMessage(conn, data, isBinary); } catch (err) {
        log.error('ws.message_failed', { message: (err as Error).message });
        send(conn, { t: 'error', code: 'internal_error', message: 'That message could not be handled. Try again.' });
      }
    });
    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', (err) => log.debug('ws.socket_error', { message: err.message }));
    ws.on('close', () => onClose(conn));
  }

  return {
    bridge: bridgeHub.bridge,
    accept(req, socket, head, ctx) {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ctx));
    },
    start() {
      if (unsubscribeBus) return;
      unsubscribeBus = base.bus.subscribe(onBusEvent);
      heartbeat = setInterval(() => {
        for (const conn of conns) {
          if (!conn.alive) { conn.ws.terminate(); continue; }
          conn.alive = false;
          try { conn.ws.ping(); } catch { /* socket is going away */ }
        }
      }, HEARTBEAT_MS);
      heartbeat.unref();
    },
    async stop() {
      unsubscribeBus?.();
      unsubscribeBus = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      const open = [...conns];
      await Promise.all(open.map((conn) => new Promise<void>((resolve) => {
        if (conn.ws.readyState === WebSocket.CLOSED) return resolve();
        conn.ws.once('close', () => resolve());
        closeWith(conn, 1001, 'server stopping');
        setTimeout(() => { conn.ws.terminate(); resolve(); }, 1000).unref();
      })));
    },
  };
}
