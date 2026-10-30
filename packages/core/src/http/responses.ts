// JSON responses and the mapping from thrown errors to `{ error: { code, message, details } }`.
import type { Logger } from '../contracts.ts';
import { CoreError } from '../errors.ts';

export interface ErrorBody { error: { code: string; message: string; details?: unknown } }

export interface HttpResult { status: number; body: unknown; headers?: Record<string, string> }

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  // JSON.stringify(undefined) is undefined; a handler that returns nothing still answers with valid JSON.
  const text = JSON.stringify(body === undefined ? null : body);
  return new Response(text, { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

export interface IssueLike { path: PropertyKey[]; message: string }

/** "name: is required; githubRepo: Use the form owner/repo" for the first few problems. */
export function describeIssues(issues: readonly IssueLike[], max = 3): string {
  const parts = issues.slice(0, max).map((i) => {
    const where = i.path.length ? i.path.map(String).join('.') : 'request';
    const what = /received undefined$/.test(i.message) ? 'is required' : i.message;
    return `${where}: ${what}`;
  });
  if (issues.length > max) parts.push(`and ${issues.length - max} more`);
  return parts.join('; ');
}

export function validationFailed(issues: readonly IssueLike[], scope: 'body' | 'query' | 'path' = 'body'): CoreError {
  const where = scope === 'body' ? 'The request body' : scope === 'query' ? 'The query string' : 'The address';
  return new CoreError(400, 'validation_failed',
    `${where} is not valid. ${describeIssues(issues)}. Fix these and try again.`,
    { issues: issues.slice(0, 10).map((i) => ({ path: i.path.map(String), message: i.message })) });
}

/** CoreError keeps its own status and words. Anything else is a 500 that reveals nothing but the failure itself. */
export function resultOfError(err: unknown, log: Logger, route: string): HttpResult {
  if (err instanceof CoreError) {
    return { status: err.status, body: errorBody(err.code, err.message, err.details), headers: err.status === 401 ? { 'www-authenticate': 'Bearer realm="mini-summa"' } : undefined };
  }
  const e = err instanceof Error ? err : new Error(String(err));
  log.error('http.unhandled_error', { route, name: e.name, message: e.message.slice(0, 300), stack: e.stack?.split('\n').slice(0, 6).join('\n') });
  return {
    status: 500,
    body: errorBody('internal_error', 'Something went wrong inside Mini-Summa. Try again. If it keeps happening, check the Mini-Summa log.'),
  };
}

export const responseOf = (r: HttpResult): Response => jsonResponse(r.status, r.body, r.headers);
