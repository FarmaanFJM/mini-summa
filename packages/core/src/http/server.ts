// Hono + @hono/node-server on 127.0.0.1, the WebSocket upgrade, static UI and the guards in front of all of it.
//
// Every request passes, in this order: Funnel refusal (public-internet traffic is never served), Host check, Origin
// check (non-GET), authentication and scope, the pairing block (only while too many redemptions failed), query/body
// validation, the idempotency store, and only then the handler. Nothing here has behaviour of its own beyond that;
// services do the work (see handlers.ts).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createAdaptorServer } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { API_PREFIX, routeNames, routes } from '@minisumma/shared';
import type { RouteName, Scope } from '@minisumma/shared';
import type { Principal } from '../contracts.ts';
import { CoreError } from '../errors.ts';
import {
  FUNNEL_HEADER, anonymousPrincipal, authenticateBearer, describeSecurity, funnelNotAllowed, hasExtensionScope, hostAllowed, hostNotAllowed,
  isFunnelRequest, originNotAllowed,
} from './auth.ts';
import type { HostPolicy, RequestSecurity } from './auth.ts';
import { createConversationActions } from './conversations.ts';
import { createHandlers } from './handlers.ts';
import { IDEMPOTENCY_KEY_RE, createIdempotencyStore, requestFingerprint } from './idempotency.ts';
import type { StoredResponse } from './idempotency.ts';
import { createFailureLimiter } from './ratelimit.ts';
import { errorBody, jsonResponse, resultOfError, responseOf, validationFailed } from './responses.ts';
import { applySecurityHeaders } from './security.ts';
import { createStaticUi } from './static.ts';
import { DEFAULT_TUNING, HttpListenError } from './types.ts';
import type { HttpServer, HttpServerDeps, RequestContext } from './types.ts';
import { createWsHub } from './ws.ts';

export { HttpListenError } from './types.ts';
export type { HttpServer, HttpServerDeps, HttpServices, HttpTuning, RequestContext } from './types.ts';

type AppEnv = { Bindings: HttpBindings; Variables: { sec: RequestSecurity } };

interface RouteLike { method: string; path: string; scope: Scope | 'public'; body?: ZodType; query?: ZodType; idempotent?: boolean }

/** The request path exactly as sent, still percent-encoded: decoding happens once, where each part is used. */
const rawPath = (request: Request): string => {
  const url = request.url;
  const start = url.indexOf('/', url.indexOf(':') + 4);
  let end = url.length;
  for (let i = start; i < url.length; i++) {
    const ch = url.charCodeAt(i);
    if (ch === 63 || ch === 35) { end = i; break; }
  }
  return url.slice(start, end);
};

function listenError(err: NodeJS.ErrnoException, port: number): HttpListenError {
  const code = err.code ?? 'UNKNOWN';
  if (code === 'EADDRINUSE') {
    return new HttpListenError(`Port ${port} on 127.0.0.1 is already in use. Another program, or another copy of Mini-Summa, is using it. Close it, or start with port 0 to let the system pick a free port.`, code, port, err);
  }
  if (code === 'EACCES') {
    return new HttpListenError(`Mini-Summa is not allowed to listen on port ${port}. Choose a port above 1024, or use port 0.`, code, port, err);
  }
  return new HttpListenError(`Mini-Summa could not listen on 127.0.0.1:${port}: ${err.message}`, code, port, err);
}

function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify(errorBody(code, message));
  // Node removes its own error listener from an upgrading socket; without one a reset connection would crash the app.
  socket.on('error', () => undefined);
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\n\r\n${body}`);
}

export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const { base, services } = deps;
  const log = base.log;
  const tuning = { ...DEFAULT_TUNING, ...deps.tuning };

  let server: http.Server | null = null;
  let listening: { port: number; baseUrl: string } | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;

  const publicUrl = (): string | null => { try { return services.tailscale.publicUrl(); } catch { return null; } };
  const policy: HostPolicy = { port: () => listening?.port ?? 0, publicUrl };

  const idem = createIdempotencyStore({ db: base.db, clock: base.clock, log, ttlMs: tuning.idempotencyTtlMs });
  // Only failed redemptions are charged (see ratelimit.ts); the service still burns an offer after five wrong codes.
  const redeemFailures = createFailureLimiter({ max: tuning.redeemFailuresPerMinute, windowMs: 60_000, now: () => base.clock.now().getTime() });
  const hub = createWsHub({ base, devices: services.devices, sessions: services.sessions, tuning });
  const ui = createStaticUi(deps.uiDir);
  const handlers = createHandlers({
    base, services, counts: deps.counts, system: deps.system,
    conversations: createConversationActions({ native: deps.native, settings: services.settings, bridge: hub.bridge }),
  });

  async function readLimited(req: Request): Promise<Uint8Array> {
    const tooLarge = () => new CoreError(413, 'payload_too_large', `The request body is larger than ${Math.round(tuning.maxBodyBytes / 1024)} KB. Send less data.`);
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > tuning.maxBodyBytes) throw tooLarge();
    const stream = req.body;
    if (!stream) return new Uint8Array(0);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > tuning.maxBodyBytes) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async function parseBody(def: RouteLike, req: Request): Promise<unknown> {
    if (!def.body) return undefined;
    const raw = new TextDecoder().decode(await readLimited(req));
    let json: unknown = {};
    if (raw.trim() !== '') {
      try { json = JSON.parse(raw); } catch {
        throw new CoreError(400, 'invalid_json', 'The request body is not valid JSON. Send a JSON object with the documented fields.');
      }
    }
    const parsed = def.body.safeParse(json);
    if (!parsed.success) throw validationFailed(parsed.error.issues, 'body');
    return parsed.data;
  }

  function parseQuery(def: RouteLike, c: Context<AppEnv>): unknown {
    if (!def.query) return {};
    const parsed = def.query.safeParse(c.req.query());
    if (!parsed.success) throw validationFailed(parsed.error.issues, 'query');
    return parsed.data;
  }

  async function execute(name: RouteName, c: Context<AppEnv>): Promise<Response> {
    const def = routes[name] as unknown as RouteLike;
    const sec = c.get('sec');
    const method = c.req.method;
    const readOnly = method === 'GET' || method === 'HEAD';

    const principal: Principal = def.scope === 'public'
      ? anonymousPrincipal(sec.via)
      : authenticateBearer(services.devices, c.req.header('authorization'), sec.via, def.scope);

    // A browser extension may call us, but only as a principal that holds the extension scope. The one exception is
    // pairing itself: the extension has no token yet and the one-time code is what gates that call.
    if (sec.originKind === 'extension' && !readOnly) {
      const allowed = def.scope === 'public' ? name === 'pairing.redeem' : hasExtensionScope(principal);
      if (!allowed) throw originNotAllowed();
    }

    if (name === 'pairing.redeem') {
      const wait = redeemFailures.retryAfterSec();
      if (wait !== null) {
        return responseOf({
          status: 429, headers: { 'retry-after': String(wait) },
          body: errorBody('rate_limited', `Too many failed pairing attempts. Wait ${wait} seconds, then scan the code again.`),
        });
      }
    }

    const input = { params: c.req.param() as Record<string, string>, query: parseQuery(def, c), body: await parseBody(def, c.req.raw) };
    const ctx: RequestContext = {
      principal,
      actor: def.scope === 'public' ? { kind: 'system' } : services.devices.actorOf(principal),
      via: sec.via,
      baseUrl: listening?.baseUrl ?? '',
      publicUrl: publicUrl(),
    };

    const run = async (): Promise<StoredResponse> => {
      try {
        const handler = handlers[name] as unknown as (i: unknown, x: RequestContext) => unknown;
        return { status: 200, body: await handler(input, ctx) };
      } catch (err) {
        // Errors the service meant to send are answers and can be stored for a retry. Anything else is a 500 and is not.
        if (err instanceof CoreError) { const r = resultOfError(err, log, name); return { status: r.status, body: r.body }; }
        throw err;
      }
    };

    const key = def.idempotent ? c.req.header('idempotency-key') : undefined;
    if (key !== undefined) {
      if (!IDEMPOTENCY_KEY_RE.test(key)) {
        throw new CoreError(400, 'validation_failed', 'The Idempotency-Key header must be 1 to 200 visible characters without spaces. Use a random id such as a UUID.');
      }
      const { response, replayed } = await idem.run(
        { key, principal: principal.deviceId ?? principal.kind, route: name, fingerprint: requestFingerprint(method, c.req.path, input.body) }, run);
      return jsonResponse(response.status, response.body, replayed ? { 'idempotent-replay': 'true' } : {});
    }
    const out = await run();
    // A code or offer the service refused counts against the pairing budget. Success, an invalid body (thrown before the
    // handler) and a server fault (5xx) do not.
    if (name === 'pairing.redeem' && out.status >= 400 && out.status < 500) redeemFailures.record();
    return jsonResponse(out.status, out.body);
  }

  // ---- the Hono app -----------------------------------------------------------------------------------------

  const app = new Hono<AppEnv>({ getPath: rawPath });

  app.use('*', async (c, next) => {
    const incoming = c.env.incoming;
    const hostHeader = incoming.headers.host;
    const pathname = c.req.path;
    if (isFunnelRequest(c.req.raw.headers)) {
      return applySecurityHeaders(responseOf(resultOfError(funnelNotAllowed(), log, 'guard')), pathname);
    }
    if (!hostAllowed(hostHeader, policy)) {
      return applySecurityHeaders(responseOf(resultOfError(hostNotAllowed(), log, 'guard')), pathname);
    }
    const sec = describeSecurity({
      hostHeader: hostHeader as string, origin: incoming.headers.origin, peerAddress: incoming.socket.remoteAddress,
      headers: c.req.raw.headers, policy,
    });
    c.set('sec', sec);
    const readOnly = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!readOnly && sec.originKind === 'foreign') {
      return applySecurityHeaders(responseOf(resultOfError(originNotAllowed(), log, 'guard')), pathname);
    }
    await next();
    applySecurityHeaders(c.res, pathname);
    return undefined;
  });

  for (const name of routeNames) {
    const def = routes[name] as unknown as RouteLike;
    app.on(def.method, `${API_PREFIX}${def.path}`, async (c) => {
      try { return await execute(name, c); } catch (err) { return responseOf(resultOfError(err, log, name)); }
    });
  }

  const redirectToUi = () => new Response(null, { status: 302, headers: { location: '/ui/' } });
  app.get('/', redirectToUi);
  app.get('/ui', redirectToUi);
  app.get('/ui/*', (c) => ui.serve(c.req.path));
  app.notFound(() => responseOf({
    status: 404, body: errorBody('not_found', 'There is nothing at this address. The API lives under /api/v1 and the interface under /ui/.'),
  }));
  app.onError((err) => responseOf(resultOfError(err, log, 'hono')));

  // ---- WebSocket upgrade --------------------------------------------------------------------------------------

  function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (req.headers.upgrade?.toLowerCase() !== 'websocket') return rejectUpgrade(socket, 400, 'bad_request', 'Only WebSocket upgrades are supported here.');
      if (req.headers[FUNNEL_HEADER] !== undefined) {
        const e = funnelNotAllowed();
        return rejectUpgrade(socket, e.status, e.code, e.message);
      }
      const hostHeader = req.headers.host;
      if (!hostAllowed(hostHeader, policy)) {
        const e = hostNotAllowed();
        return rejectUpgrade(socket, e.status, e.code, e.message);
      }
      const pathname = (req.url ?? '').split('?')[0];
      if (pathname !== '/ws') return rejectUpgrade(socket, 404, 'not_found', 'The WebSocket endpoint is /ws.');
      const sec = describeSecurity({
        hostHeader: hostHeader as string, origin: req.headers.origin, peerAddress: req.socket.remoteAddress,
        headers: { has: (n) => req.headers[n.toLowerCase()] !== undefined }, policy,
      });
      // A chrome-extension origin is let through here: who is calling is only known after `hello`, which then closes
      // the socket (4003) unless the principal holds the extension scope.
      if (sec.originKind === 'foreign') {
        const e = originNotAllowed();
        return rejectUpgrade(socket, e.status, e.code, e.message);
      }
      hub.accept(req, socket, head, { via: sec.via, origin: sec.originKind });
    } catch (err) {
      log.error('http.upgrade_failed', { message: (err as Error).message });
      rejectUpgrade(socket, 500, 'internal_error', 'The connection could not be opened. Try again.');
    }
  }

  return {
    extensionBridge: hub.bridge,

    async start() {
      if (server) throw new Error('The HTTP server is already running.');
      idem.prune();
      const s = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as http.Server;
      s.headersTimeout = 15_000;
      s.requestTimeout = 120_000;
      s.on('upgrade', onUpgrade);
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          try { s.close(); } catch { /* it never started listening */ }
          reject(listenError(err, deps.port));
        };
        s.once('error', onError);
        s.listen(deps.port, '127.0.0.1', () => { s.off('error', onError); resolve(); });
      });
      s.on('error', (err) => log.error('http.server_error', { message: err.message }));
      const port = (s.address() as AddressInfo).port;
      server = s;
      listening = { port, baseUrl: `http://127.0.0.1:${port}` };
      hub.start();
      pruneTimer = setInterval(() => {
        try { idem.prune(); } catch (err) { log.warn('http.idempotency_prune_failed', { message: (err as Error).message }); }
      }, 60 * 60 * 1000);
      pruneTimer.unref();
      log.info('http.listening', { port });
      return { ...listening };
    },

    async stop() {
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = null;
      const s = server;
      server = null;
      await hub.stop();
      if (!s) { listening = null; return; }
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeIdleConnections();
        setTimeout(() => s.closeAllConnections(), 1000).unref();
      });
      // Kept until the server is closed: a request still in flight must not be refused as a foreign host meanwhile.
      listening = null;
    },
  };
}
