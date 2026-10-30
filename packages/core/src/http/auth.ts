// Who is calling, and from where.
//
// Three independent checks guard every request and every WebSocket upgrade:
//  1. Host header: only this machine's own names and the Tailscale Serve name (defence against DNS rebinding).
//  2. Origin header: a browser page may only call us from our own origin. chrome-extension:// is allowed, but the
//     caller must then turn out to hold the `extension` scope (decided after authentication).
//  3. Bearer token: authenticated by the DevicesService, then checked against the route's minimum scope.
// Tokens are never logged and never echoed.
import type { Scope } from '@minisumma/shared';
import { scopeAllows } from '@minisumma/shared';
import type { DevicesService, Principal } from '../contracts.ts';
import { CoreError, unauthorized } from '../errors.ts';

export interface HostPolicy {
  /** The port the server is really listening on (differs from the requested one when that was 0). */
  port(): number;
  /** The Tailscale Serve URL, when remote access is on. */
  publicUrl(): string | null;
}

export type OriginKind = 'absent' | 'same' | 'extension' | 'foreign';

/** Everything the guards learned about one request, computed once. */
export interface RequestSecurity {
  host: string;
  originKind: OriginKind;
  via: Principal['via'];
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** `host[:port]` of the Tailscale URL, lower case, as a browser would send it in the Host header. */
export function tailscaleHost(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try { return new URL(publicUrl).host.toLowerCase(); } catch { return null; }
}

export function hostAllowed(hostHeader: string | undefined, policy: HostPolicy): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const port = policy.port();
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`) return true;
  const ts = tailscaleHost(policy.publicUrl());
  return ts !== null && host === ts;
}

export function classifyOrigin(origin: string | undefined, hostHeader: string): OriginKind {
  if (origin === undefined) return 'absent';
  const value = origin.trim();
  if (value === '' || value === 'null') return 'foreign';
  if (/^chrome-extension:\/\/[a-z0-9]+$/i.test(value)) return 'extension';
  try {
    const u = new URL(value);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === hostHeader.trim().toLowerCase()) return 'same';
  } catch { /* falls through to foreign */ }
  return 'foreign';
}

/**
 * How the request reached us. Everything arrives from a loopback peer (we bind 127.0.0.1 only): either a program on
 * this computer, or `tailscale serve` forwarding a tailnet client. Serve adds `Tailscale-User-Login` and
 * `X-Forwarded-For`, so a request carrying either is `tailscale`, whatever Host it names: a tailnet client can put any
 * Host header on its request, and `tailscale` is the stricter class (the DevicesService refuses the desktop token
 * there). Only a loopback request without those headers is `localhost`.
 */
export function viaOf(input: { peerLoopback: boolean; headers: { has(name: string): boolean } }): Principal['via'] {
  if (!input.peerLoopback) return 'unknown';
  if (input.headers.has('tailscale-user-login') || input.headers.has('x-forwarded-for')) return 'tailscale';
  return 'localhost';
}

export function describeSecurity(input: {
  hostHeader: string; origin: string | undefined; peerAddress: string | undefined;
  headers: { has(name: string): boolean }; policy: HostPolicy;
}): RequestSecurity {
  return {
    host: input.hostHeader,
    originKind: classifyOrigin(input.origin, input.hostHeader),
    via: viaOf({ peerLoopback: isLoopbackAddress(input.peerAddress), headers: input.headers }),
  };
}

const MAX_TOKEN_LENGTH = 512;

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!m || m[1].length > MAX_TOKEN_LENGTH) return null;
  return m[1];
}

export function anonymousPrincipal(via: Principal['via']): Principal {
  return { kind: 'device', deviceId: null, name: 'anonymous', scopes: [], trusted: false, via };
}

export function missingToken(): CoreError {
  return unauthorized('This request needs a device token. Send it as "Authorization: Bearer <token>". If the token was lost or revoked, pair the device again.');
}

/**
 * Authenticates a bearer token and checks the route's minimum scope.
 * Wrong, revoked and missing tokens give the same 401 so the answer reveals nothing about which tokens exist.
 */
export function authenticateBearer(devices: DevicesService, header: string | null | undefined, via: Principal['via'], needed: Scope | 'public'): Principal {
  const token = bearerToken(header);
  if (token === null) throw missingToken();
  const principal = devices.authenticate(token, via);
  if (principal === null) throw missingToken();
  if (!scopeAllows(principal.scopes, needed)) {
    throw new CoreError(403, 'insufficient_scope',
      `This device is not allowed to do that. It needs the "${String(needed)}" permission. Ask the owner to grant it in Settings, Devices.`,
      { needed });
  }
  return principal;
}

/** The extension scope counts only when it was granted itself; `desktop` does not stand in for it. */
export const hasExtensionScope = (principal: Pick<Principal, 'scopes'>): boolean => principal.scopes.includes('extension');
export const hasDesktopScope = (principal: Pick<Principal, 'scopes'>): boolean => principal.scopes.includes('desktop');

export function originNotAllowed(): CoreError {
  return new CoreError(403, 'origin_not_allowed',
    'This request came from a web page that is not Mini-Summa. Only Mini-Summa itself and its browser extension may call this API.');
}

export function hostNotAllowed(): CoreError {
  return new CoreError(403, 'host_not_allowed',
    'This address is not one Mini-Summa answers on. Use http://127.0.0.1 with the right port, or the Tailscale address shown in Settings.');
}
