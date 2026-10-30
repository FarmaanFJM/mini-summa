// Turns SDK errors into sentences that say what went wrong and what to do. No stack traces, no codes in the copy.
import { ApiError } from '@minisumma/shared';

export const REVOKED_MESSAGE = 'This phone was removed in Mini-Summa. Pair again.';

export type NetworkKind = 'timeout' | 'tls' | 'cleartext' | 'no_answer';

const TLS_RE = /certificate|\bssl\b|\btls\b|trust anchor|handshake|cert_|x509|chain validation|hostname/i;

/** True for an address that Android will refuse to open over plain http in a release build. */
export function isCleartextRemote(url: string): boolean {
  const m = /^http:\/\/([^/:?#]+)/i.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return !(host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2');
}

/**
 * React Native reports most connection failures as the same generic error, so this is a best effort. It never
 * claims more than it knows: a failure that could be several things stays `no_answer`.
 */
export function classifyNetworkError(err: unknown, url: string): NetworkKind {
  const code = err instanceof ApiError ? err.code : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (code === 'timeout') return 'timeout';
  if (TLS_RE.test(message)) return 'tls';
  if (isCleartextRemote(url)) return 'cleartext';
  return 'no_answer';
}

export const UNREACHABLE_TEXT = 'Your PC may be asleep, offline, or not signed in to Tailscale on this phone.';
export const UNREACHABLE_HINT = 'Check that Tailscale is connected on both devices, then try again.';

export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      return err.code === 'timeout'
        ? 'Your PC did not answer in time. It may be asleep or the connection is poor. Try again.'
        : `Could not reach your PC. ${UNREACHABLE_TEXT} ${UNREACHABLE_HINT}`;
    }
    if (err.status === 401) return REVOKED_MESSAGE;
    if (err.status === 403) return 'This phone is not allowed to do that. Its permissions are set in Mini-Summa on your PC.';
    if (err.status === 404) return 'That item no longer exists on your PC.';
    if (err.status >= 500) return `Mini-Summa on your PC returned an error: ${err.message}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong. Try again.';
}

export const isNetworkError = (err: unknown): boolean => err instanceof ApiError && err.status === 0;
export const isAuthError = (err: unknown): boolean => err instanceof ApiError && err.status === 401;
