// "Send to Claude" rules. Text only ever reaches a managed, live session, only after an explicit confirmation, and the
// request carries one idempotency key per compose attempt so a flaky network cannot send it twice. A failed send is
// shown as failed and is never retried automatically.
import { ApiError, randomId, scopeAllows } from '@minisumma/shared';
import type { PendingAction, Scope, SessionKey, SessionView } from '@minisumma/shared';
import type { ConnectionApi } from '../connection/ConnectionManager.ts';
import { describeApiError } from '../lib/errors.ts';

export const MAX_PROMPT_CHARS = 20_000;

export type SendGuard =
  | { allowed: true }
  | { allowed: false; code: 'missing' | 'not_managed' | 'not_live' | 'no_scope'; reason: string; offerRemoteControl: boolean };

export function sendGuard(session: SessionView | undefined, scopes: readonly Scope[]): SendGuard {
  if (!session) return { allowed: false, code: 'missing', reason: 'This session is no longer listed on your PC.', offerRemoteControl: false };
  if (session.origin !== 'managed') {
    const kind = session.origin === 'background' ? 'a background' : 'an external';
    return {
      allowed: false, code: 'not_managed', offerRemoteControl: true,
      reason: `This is ${kind} session. Mini-Summa observes it but cannot type into it.`,
    };
  }
  if (session.availability !== 'live') {
    const why = session.availability === 'resumable' ? 'This session is not running. Resume it in Mini-Summa on your PC first.'
      : session.availability === 'disconnected' ? 'Mini-Summa lost the terminal connection to this session, so it cannot send text to it.'
        : 'This session has ended.';
    return { allowed: false, code: 'not_live', reason: why, offerRemoteControl: false };
  }
  if (!scopeAllows(scopes, 'prompt')) {
    return {
      allowed: false, code: 'no_scope', offerRemoteControl: false,
      reason: 'This phone is not allowed to send prompts. Pair it again with that permission in Mini-Summa on your PC.',
    };
  }
  return { allowed: true };
}

/** One compose attempt: the idempotency key is created once and travels with exactly this text and target. */
export interface SendAttempt {
  key: string;
  sessionKey: SessionKey;
  text: string;
  generation: number;
}

/**
 * The key survives a retry of the same request. Any change to the text, the session or its generation is a different
 * request and gets a different key, so the desktop can never mistake an edited prompt for a repeat of the old one.
 */
export function nextAttempt(prev: SendAttempt | null, input: Omit<SendAttempt, 'key'>, makeKey: () => string = randomId): SendAttempt {
  if (prev && prev.sessionKey === input.sessionKey && prev.text === input.text && prev.generation === input.generation) return prev;
  return { key: makeKey(), ...input };
}

export type SendResult =
  /** The desktop answered and recorded an action. Its status says what happened. */
  | { kind: 'action'; action: PendingAction }
  /** The desktop answered with an error. Nothing was created. */
  | { kind: 'refused'; status: number; message: string }
  /** No answer, or an answer that does not settle it (408, 429, 5xx). The request may or may not have arrived. Retrying with the same key is safe. */
  | { kind: 'unconfirmed'; message: string };

export async function sendPrompt(call: ConnectionApi['call'], attempt: SendAttempt): Promise<SendResult> {
  try {
    const action = await call(
      'actions.create',
      { body: { sessionKey: attempt.sessionKey, text: attempt.text, expectGeneration: attempt.generation } },
      { idempotencyKey: attempt.key },
    );
    return { kind: 'action', action };
  } catch (err) {
    // No answer, or an answer the desktop does not remember (it stores 2xx and 4xx replies per key, not 408, 429 or 5xx):
    // the request may or may not have been applied, and repeating it with the same key is exactly what is safe.
    if (err instanceof ApiError && (err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500)) {
      return { kind: 'unconfirmed', message: describeApiError(err) };
    }
    if (err instanceof ApiError) return { kind: 'refused', status: err.status, message: describeApiError(err) };
    return { kind: 'unconfirmed', message: describeApiError(err) };
  }
}

export interface ActionOutcome {
  headline: string;
  detail: string | null;
  /** Nothing further will happen to this action. */
  final: boolean;
  tone: 'neutral' | 'success' | 'error';
}

/** A permission request is answered, not sent: the wording follows what was done to it. */
function describePermission(a: Pick<PendingAction, 'status' | 'failure'>): ActionOutcome {
  switch (a.status) {
    case 'pending': return { headline: 'Waiting for your answer', detail: null, final: false, tone: 'neutral' };
    case 'approved': return { headline: 'Approved. Answering Claude now.', detail: null, final: false, tone: 'neutral' };
    case 'executed': return { headline: 'Approved', detail: null, final: true, tone: 'success' };
    case 'failed': return { headline: `Could not answer: ${a.failure?.trim() || 'the session did not accept the answer'}`, detail: null, final: true, tone: 'error' };
    case 'rejected': return { headline: 'Rejected', detail: null, final: true, tone: 'neutral' };
    case 'expired': return { headline: 'Expired before it was answered', detail: null, final: true, tone: 'neutral' };
    case 'superseded': return { headline: 'No longer needed, the session moved on', detail: null, final: true, tone: 'neutral' };
  }
}

/** What a recorded action means for the person who sent it. Wording is fixed by the product spec. */
export function describeAction(a: Pick<PendingAction, 'status' | 'failure' | 'target'> & { kind?: PendingAction['kind'] }): ActionOutcome {
  if (a.kind === 'permission') return describePermission(a);
  switch (a.status) {
    case 'pending':
      return { headline: 'Waiting for approval on your PC', detail: a.target.problem, final: false, tone: 'neutral' };
    case 'approved':
      return { headline: 'Approved. Sending to Claude now.', detail: null, final: false, tone: 'neutral' };
    case 'executed':
      return { headline: 'Sent', detail: null, final: true, tone: 'success' };
    case 'failed':
      return { headline: `Could not send: ${a.failure?.trim() || 'the session did not accept the text'}`, detail: 'Nothing was typed again. You can edit the text and send it as a new request.', final: true, tone: 'error' };
    case 'rejected':
      return { headline: 'Rejected on your PC. Nothing was sent.', detail: null, final: true, tone: 'neutral' };
    case 'expired':
      return { headline: 'Expired before it was approved. Nothing was sent.', detail: null, final: true, tone: 'neutral' };
    case 'superseded':
      return { headline: 'Replaced because the session moved on. Nothing was sent.', detail: null, final: true, tone: 'neutral' };
  }
}
