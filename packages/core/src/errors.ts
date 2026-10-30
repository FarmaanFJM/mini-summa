/** An error that carries the HTTP status and a stable machine-readable code. The HTTP layer renders it as
 *  `{ "error": { "code", "message", "details" } }`; anything else becomes a 500 without leaking internals. */
export class CoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CoreError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown, code = 'bad_request') => new CoreError(400, code, message, details);
export const unauthorized = (message = 'Authentication required.') => new CoreError(401, 'unauthorized', message);
export const forbidden = (message = 'This action is not allowed for this client.', code = 'forbidden') => new CoreError(403, code, message);
export const notFound = (what: string) => new CoreError(404, 'not_found', `${what} was not found.`);
export const conflict = (message: string, code = 'conflict', details?: unknown) => new CoreError(409, code, message, details);
export const unprocessable = (message: string, code = 'unprocessable', details?: unknown) => new CoreError(422, code, message, details);
export const unavailable = (message: string, code = 'unavailable') => new CoreError(503, code, message);
