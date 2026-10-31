import { nextAttempt, sendGuard, describeAction } from '../src/actions/send';
import { canDecide } from '../src/actions/approvals';
import { makeAction, makeSession, SESSION_KEY } from './helpers/data';

describe('sendGuard: who may receive typed text', () => {
  const all = ['read', 'notify', 'prompt', 'approve'] as const;

  it('allows only a managed, live session for a phone that may send prompts', () => {
    expect(sendGuard(makeSession(), [...all])).toEqual({ allowed: true });
    expect(sendGuard(makeSession(), ['desktop'])).toEqual({ allowed: true });
  });

  it.each(['external', 'background'] as const)('refuses a %s session, says it is observed only and offers Remote Control', (origin) => {
    const g = sendGuard(makeSession({ origin }), [...all]);
    expect(g).toMatchObject({ allowed: false, code: 'not_managed', offerRemoteControl: true });
    if (!g.allowed) {
      expect(g.reason).toContain(`${origin} session`);
      expect(g.reason).toContain('observes it but cannot type into it');
    }
  });

  it.each(['resumable', 'disconnected', 'ended'] as const)('refuses a managed session that is %s', (availability) => {
    const g = sendGuard(makeSession({ availability }), [...all]);
    expect(g).toMatchObject({ allowed: false, code: 'not_live', offerRemoteControl: false });
  });

  it('refuses a phone without the prompt permission', () => {
    expect(sendGuard(makeSession(), ['read', 'notify'])).toMatchObject({ allowed: false, code: 'no_scope' });
  });

  it('refuses when the session is not listed', () => {
    expect(sendGuard(undefined, [...all])).toMatchObject({ allowed: false, code: 'missing' });
  });
});

describe('nextAttempt: one idempotency key per compose attempt', () => {
  let n = 0;
  const makeKey = () => `key-${++n}`;
  const input = { sessionKey: SESSION_KEY, text: 'run the tests', generation: 2 };

  it('creates a key once and reuses it for the same request', () => {
    const a = nextAttempt(null, input, makeKey);
    const b = nextAttempt(a, { ...input }, makeKey);
    expect(b).toBe(a);
    expect(b.key).toBe(a.key);
  });

  it('starts a new attempt, with a new key, when the text, session or generation changes', () => {
    const a = nextAttempt(null, input, makeKey);
    const keys = new Set([a.key]);
    keys.add(nextAttempt(a, { ...input, text: 'run the tests again' }, makeKey).key);
    keys.add(nextAttempt(a, { ...input, generation: 3 }, makeKey).key);
    keys.add(nextAttempt(a, { ...input, sessionKey: 'win|other' }, makeKey).key);
    expect(keys.size).toBe(4);
  });
});

describe('describeAction: the true outcome in the product wording', () => {
  const base = makeAction({ kind: 'claude_prompt' });
  it('pending waits for approval on the PC', () => {
    expect(describeAction({ ...base, status: 'pending' })).toMatchObject({ headline: 'Waiting for approval on your PC', final: false });
  });
  it('executed is Sent', () => {
    expect(describeAction({ ...base, status: 'executed' })).toMatchObject({ headline: 'Sent', final: true, tone: 'success' });
  });
  it('failed says could not send and why', () => {
    const d = describeAction({ ...base, status: 'failed', failure: 'The session left the live state.' });
    expect(d.headline).toBe('Could not send: The session left the live state.');
    expect(d.tone).toBe('error');
  });
  it.each(['rejected', 'expired', 'superseded'] as const)('%s says nothing was sent', (status) => {
    expect(describeAction({ ...base, status }).headline).toContain('Nothing was sent.');
  });
});

describe('describeAction for a permission request', () => {
  const perm = makeAction({ kind: 'permission' });
  it('words the outcome as answered, not sent', () => {
    expect(describeAction({ ...perm, status: 'executed' }).headline).toBe('Approved');
    expect(describeAction({ ...perm, status: 'rejected' }).headline).toBe('Rejected');
    expect(describeAction({ ...perm, status: 'failed', failure: 'The dialog was gone.' }).headline).toBe('Could not answer: The dialog was gone.');
    expect(describeAction({ ...perm, status: 'superseded' }).headline).toContain('moved on');
    expect(describeAction({ ...perm, status: 'pending' }).final).toBe(false);
  });
});

describe('canDecide: who may approve', () => {
  const ctx = { scopes: ['read', 'approve'] as const, deviceId: 'dev_1' };
  it('allows a phone with the approve scope on a request from the system', () => {
    expect(canDecide(makeAction(), { ...ctx, scopes: [...ctx.scopes] })).toEqual({ can: true });
  });
  it('explains when the scope is missing', () => {
    const d = canDecide(makeAction(), { scopes: ['read'], deviceId: 'dev_1' });
    expect(d).toMatchObject({ can: false });
    if (!d.can) expect(d.reason).toContain('cannot approve or reject');
  });
  it('does not let a phone approve its own prompt unless the desktop allows any approver', () => {
    const mine = makeAction({ kind: 'claude_prompt', createdBy: { kind: 'device', deviceId: 'dev_1', name: 'Pixel 8' }, approvableBy: 'desktop_or_other_device' });
    expect(canDecide(mine, { scopes: ['approve'], deviceId: 'dev_1' })).toMatchObject({ can: false });
    expect(canDecide({ ...mine, approvableBy: 'any_approver' }, { scopes: ['approve'], deviceId: 'dev_1' })).toEqual({ can: true });
    expect(canDecide(mine, { scopes: ['approve'], deviceId: 'dev_2' })).toEqual({ can: true });
  });
  it('leaves a desktop-only request to the desktop', () => {
    expect(canDecide(makeAction({ approvableBy: 'desktop' }), { scopes: ['approve'], deviceId: 'dev_1' })).toMatchObject({ can: false });
  });
  it('offers nothing for a request that is decided or expired', () => {
    expect(canDecide(makeAction({ status: 'executed' }), { scopes: ['approve'], deviceId: 'd' })).toMatchObject({ can: false });
    expect(canDecide(makeAction({ expiresAt: '2000-01-01T00:00:00.000Z' }), { scopes: ['approve'], deviceId: 'd' })).toMatchObject({ can: false });
  });
});
