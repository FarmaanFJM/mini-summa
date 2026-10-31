import type { ChatGptOpenResult, Delivery, DeliveryEvent, DeliveryState, ReviewState, SessionView } from '@minisumma/shared';
import { describe, expect, it } from 'vitest';
import {
  actionOutcome, confirmTitle, describeDestination, describeEvent, describeOpen, handoffPlan, offeredLabels, parseReportText, queueDeliveryLabel,
  reviewControls, reviewProgress, REVIEW_STEPS, STATE_LABEL, targetEligibility, untilWords,
} from '../../src/renderer/src/features/reports/model';

const STATES = Object.keys(STATE_LABEL) as DeliveryState[];

function delivery(state: DeliveryState, over: Partial<Delivery> = {}): Delivery {
  const noDestination = state === 'destination_missing' && !('destination' in over);
  return {
    id: 'dlv_1', reportId: 'rpt_1', projectId: 'prj_1', projectName: 'GitManager', sessionKey: 'win|a1b2c3d4-0000-4000-8000-000000000000', taskTitle: 'Task', state,
    destination: { conversationId: 'cnv_1', url: 'https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', title: 'Release planning', chatgptConversationId: null, resolvedFrom: 'project_preferred', verificationAtFreeze: 'verified', frozenAt: '2026-10-30T14:00:00.000Z' },
    review: 'none', includeReviewRequest: true, messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null,
    stateChangedAt: '2026-10-30T14:00:00.000Z', createdAt: '2026-10-30T14:00:00.000Z', updatedAt: '2026-10-30T14:00:00.000Z', ...over,
    ...(noDestination ? { destination: null } : {}),
  };
}

function parts(total: number, copied: number[] = []): Delivery['parts'] {
  return Array.from({ length: total }, (_, i) => ({ index: i + 1, total, chars: 11_000, sha256: `${i}`.padEnd(64, '0'), copiedAt: copied.includes(i + 1) ? '2026-10-30T14:05:00.000Z' : null }));
}

const ctx = { conversationCount: 2, hasProject: true };

// What the core accepts, written down again here from the contract notes of the deliveries service, independently of model.ts.
const CORE: Record<string, DeliveryState[]> = {
  copy: ['destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send'],
  open: ['destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain', 'user_confirmed_sent'],
  confirm: ['destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain'],
  uncertain: ['copied', 'awaiting_user_send', 'user_confirmed_sent'],
  reopen: ['user_discarded', 'delivery_uncertain'],
  discard: ['report_captured', 'destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain'],
  destination: ['destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain'],
};
const ACTION_RULE: Partial<Record<string, string>> = {
  handoff: 'copy', copyAgain: 'copy', open: 'open', confirmSent: 'confirm', markUncertain: 'uncertain', reopen: 'reopen', discard: 'discard', chooseDestination: 'destination',
};

describe('the actions each delivery state offers', () => {
  it('offers exactly these buttons in each state', () => {
    const expected: Record<DeliveryState, string[]> = {
      report_captured: ['Discard'],
      destination_missing: ['Choose a conversation', 'Add a conversation', 'Discard'],
      destination_unverified: ['Copy and open', 'Open to check it first', 'Discard', 'Change destination', 'Copy the whole message', 'I sent it another way'],
      ready_for_handoff: ['Copy and open', 'Open to check it first', 'Discard', 'Change destination', 'Copy the whole message', 'I sent it another way'],
      copied: ['I sent it', 'Open conversation', 'Copy again', 'Not sure', 'Discard', 'Change destination', 'Copy the whole message'],
      awaiting_user_send: ['I sent it', 'Open conversation', 'Copy again', 'Not sure', 'Discard', 'Change destination', 'Copy the whole message'],
      user_confirmed_sent: ['Open conversation', 'I am not sure it was sent', 'Copy the whole message'],
      delivery_uncertain: ['Reopen', 'I sent it', 'Open conversation', 'Discard', 'Change destination', 'Copy the whole message'],
      user_discarded: ['Reopen'],
    };
    for (const state of STATES) expect(offeredLabels(handoffPlan(delivery(state), ctx)), state).toEqual(expected[state]);
  });

  it('never offers an action the core would refuse in that state', () => {
    for (const state of STATES) {
      const plan = handoffPlan(delivery(state), ctx);
      const buttons = [plan.primary, ...plan.secondary, ...plan.quiet].filter((b) => b !== null);
      for (const b of buttons) {
        const rule = ACTION_RULE[b.id];
        if (rule) expect(CORE[rule], `${b.label} in ${state}`).toContain(state);
      }
      if (plan.changeDestination) expect(CORE.destination, `Change destination in ${state}`).toContain(state);
      if (plan.alternatives.sentAnotherWay) expect(CORE.confirm, `I sent it another way in ${state}`).toContain(state);
    }
  });

  it('has exactly one main action, or none where the state offers no next step', () => {
    for (const state of STATES) {
      const plan = handoffPlan(delivery(state), ctx);
      const mains = [plan.primary].filter(Boolean);
      expect(mains.length, state).toBeLessThanOrEqual(1);
    }
    expect(handoffPlan(delivery('user_confirmed_sent'), ctx).primary).toBeNull();
    expect(handoffPlan(delivery('user_discarded'), ctx).primary).toBeNull();
  });

  it('makes I sent it the main action once the message was copied and the conversation opened', () => {
    expect(handoffPlan(delivery('awaiting_user_send'), ctx).primary?.label).toBe('I sent it');
    expect(handoffPlan(delivery('copied'), ctx).primary?.label).toBe('I sent it');
    expect(handoffPlan(delivery('delivery_uncertain'), ctx).primary?.label).toBe('Reopen');
    expect(handoffPlan(delivery('ready_for_handoff'), ctx).primary?.label).toBe('Copy and open');
    expect(handoffPlan(delivery('destination_unverified'), ctx).primary?.label).toBe('Copy and open');
  });

  it('asks for a conversation, or for one to be added, when there is no destination', () => {
    const none = { ...delivery('destination_missing'), destination: null };
    expect(handoffPlan(none, { conversationCount: 3, hasProject: true }).primary?.label).toBe('Choose a conversation');
    expect(handoffPlan(none, { conversationCount: 0, hasProject: true }).primary?.label).toBe('Add a ChatGPT conversation');
    expect(handoffPlan(none, { conversationCount: 0, hasProject: true }).secondary).toEqual([]);
    expect(handoffPlan(none, { conversationCount: 1, hasProject: false }).primary?.id).toBe('openSession');
    // With no destination there is nothing to change and nothing to copy by another route.
    const plan = handoffPlan(none, ctx);
    expect(plan.changeDestination).toBe(false);
    expect(plan.alternatives.wholeMessage).toBe(false);
  });
});

describe('what may be claimed before the person says I sent it', () => {
  // Phrases that mention sending without claiming it. Everything else with "sent", "delivered" or "submitted" is a claim.
  const ALLOWED = [/I sent it another way/gi, /I sent it/gi, /not marked as sent yet/gi, /not sent yet/gi, /Copied, not sent/gi, /not recorded as sent/gi, /I am not sure it was sent/gi];
  const claims = (text: string) => ALLOWED.reduce((t, re) => t.replace(re, ''), text).match(/\b(sent|delivered|submitted)\b/gi) ?? [];

  it('says nothing about sending, delivery or submission in a state before the confirmation', () => {
    const before: DeliveryState[] = ['report_captured', 'destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain', 'user_discarded'];
    for (const state of before) {
      const plan = handoffPlan(delivery(state, { parts: state === 'ready_for_handoff' ? parts(3) : [] }), ctx);
      const text = [plan.headline, ...plan.body, ...offeredLabels(plan), queueDeliveryLabel({ id: 'd', state, review: 'none', destinationTitle: null, updatedAt: '' })].join(' | ');
      expect(claims(text), `${state}: ${text}`).toEqual([]);
    }
  });

  it('only the confirmed state speaks of the message as sent, and says whose statement that is', () => {
    const plan = handoffPlan(delivery('user_confirmed_sent'), ctx);
    expect(plan.headline).toBe('You confirmed it was sent');
    expect(plan.body.join(' ')).toContain('your statement');
  });

  it('keeps "copied" and "opened" apart from "sent"', () => {
    expect(STATE_LABEL.copied).toBe('Copied, not sent yet');
    const body = handoffPlan(delivery('copied'), ctx).body.join(' ');
    expect(body).toContain('Copying does not send it');
    expect(body).toContain('neither does opening the conversation');
    expect(handoffPlan(delivery('awaiting_user_send'), ctx).body.join(' ')).toContain('not marked as sent yet');
  });
});

describe('parts', () => {
  it('names the next uncopied part on the main button', () => {
    expect(handoffPlan(delivery('ready_for_handoff', { parts: parts(4) }), ctx).primary).toMatchObject({ id: 'handoff', label: 'Copy part 1 of 4 and open', part: 1 });
    expect(handoffPlan(delivery('awaiting_user_send', { parts: parts(4, [1]) }), ctx).primary).toMatchObject({ id: 'handoff', label: 'Copy part 2 of 4 and open', part: 2 });
    expect(handoffPlan(delivery('awaiting_user_send', { parts: parts(4, [1, 2, 4]) }), ctx).primary).toMatchObject({ label: 'Copy part 3 of 4 and open', part: 3 });
  });

  it('offers I sent it as the main action only when every part was copied', () => {
    const some = handoffPlan(delivery('awaiting_user_send', { parts: parts(3, [1]) }), ctx);
    expect(some.primary?.label).toBe('Copy part 2 of 3 and open');
    expect([...some.secondary, ...some.quiet].map((b) => b.label)).not.toContain('I sent it');
    expect(some.alternatives.sentAnotherWay).toBe(true);
    const all = handoffPlan(delivery('awaiting_user_send', { parts: parts(3, [1, 2, 3]) }), ctx);
    expect(all.primary?.label).toBe('I sent it');
    expect(all.alternatives.sentAnotherWay).toBe(false);
  });

  it('keeps the single-part wording for one part', () => {
    expect(handoffPlan(delivery('ready_for_handoff', { parts: parts(1) }), ctx).primary?.label).toBe('Copy and open');
  });
});

describe('opening the conversation', () => {
  const base: ChatGptOpenResult = { ok: true, mode: 'embedded', opened: true, focused: true, verified: null, finalUrl: null, title: null, note: null };

  it('claims only what the host observed', () => {
    expect(describeOpen(base).text).toBe('Opened in the ChatGPT view inside Mini-Summa. It was brought to the front. Mini-Summa could not check which page loaded.');
    expect(describeOpen({ ...base, verified: true }).text).toContain('The page was confirmed to be this conversation.');
    const wrong = describeOpen({ ...base, verified: false, note: 'ChatGPT showed a sign-in page' });
    expect(wrong.tone).toBe('warning');
    expect(wrong.text).toContain('may not be this conversation');
    expect(wrong.text).toContain('ChatGPT showed a sign-in page.');
  });

  it('says plainly that a default browser cannot be observed', () => {
    const text = describeOpen({ ...base, mode: 'external', focused: false }).text;
    expect(text).toContain('Opened your default browser.');
    expect(text).toContain('cannot see the browser window');
  });

  it('reports a failure as a failure, with the host\'s reason', () => {
    const failed = describeOpen({ ...base, ok: false, opened: false, focused: false, mode: 'none', note: 'No browser host is available.' });
    expect(failed.tone).toBe('error');
    expect(failed.text).toBe('Mini-Summa could not open ChatGPT. No browser host is available.');
  });

  it('does not say a tab came to the front through the extension unless it did', () => {
    expect(describeOpen({ ...base, mode: 'extension', focused: true }).text).toContain('Brought your existing browser tab to the front.');
    expect(describeOpen({ ...base, mode: 'extension', focused: false }).text).toContain('could not confirm that it came to the front');
  });
});

describe('destination facts', () => {
  const frozen = delivery('ready_for_handoff').destination!;
  const when = () => 'Oct 30, 14:00';
  const conversation = { id: 'cnv_1', projectId: 'prj_1', title: 'Renamed later', url: frozen.url, originalUrl: frozen.url, kind: 'chat', chatgptConversationId: null, verification: 'verified', verifiedAt: null, verifiedTitle: 'Release planning for GitManager', note: null, position: 0, createdAt: '', updatedAt: '' } as const;

  it('reads the frozen destination and states that it does not follow focus or later changes', () => {
    const facts = describeDestination(frozen, { ...conversation }, when);
    expect(facts.title).toBe('Release planning');
    expect(facts.url).toBe(frozen.url);
    expect(facts.resolved).toBe('Chosen because it is the project\'s preferred conversation.');
    expect(facts.frozen).toBe('This destination was fixed when the report was captured on Oct 30, 14:00. It does not follow the open tab, the selected project or later changes to the project\'s preferred conversation.');
    expect(facts.verification).toBe('Verified: Release planning for GitManager');
    expect(facts.drift).toBeNull();
  });

  it('words how it was resolved in all four ways', () => {
    const words = (resolvedFrom: typeof frozen.resolvedFrom) => describeDestination({ ...frozen, resolvedFrom }, conversation, when).resolved;
    expect(words('session_binding')).toContain('bound to this session');
    expect(words('project_preferred')).toContain('the project\'s preferred conversation');
    expect(words('only_conversation')).toContain('the project\'s only conversation');
    expect(words('user_selected')).toBe('Chosen by you.');
    expect(describeDestination({ ...frozen, resolvedFrom: 'user_selected' }, conversation, when).frozen).toMatch(/^You fixed this destination on/);
  });

  it('reports a conversation that was edited or removed after the destination was fixed', () => {
    expect(describeDestination(frozen, undefined, when).drift).toContain('removed from the project');
    expect(describeDestination(frozen, { ...conversation, url: 'https://chatgpt.com/c/other' }, when).drift).toContain('different address');
  });
});

describe('the review', () => {
  // The core's transition table (REVIEW_ALLOWED), written down again from its source.
  const ALLOWED: Record<ReviewState, ReviewState[]> = {
    none: ['closed'], requested: ['received', 'follow_up_drafted', 'closed'], received: ['follow_up_drafted', 'closed'],
    follow_up_drafted: ['follow_up_drafted', 'closed'], follow_up_sent: ['closed'], closed: ['received', 'closed'],
  };

  it('has the six steps in order', () => {
    expect([...REVIEW_STEPS]).toEqual(['Report ready', 'Sent by you', 'Review awaiting you', 'Review noted', 'Follow-up prepared', 'Sent to Claude']);
  });

  it('follows delivery.review and nothing else', () => {
    expect(reviewProgress({ state: 'ready_for_handoff', review: 'none' })).toEqual({ done: 1, current: 1, closed: false });
    expect(reviewProgress({ state: 'user_confirmed_sent', review: 'none' })).toEqual({ done: 2, current: null, closed: false });
    expect(reviewProgress({ state: 'user_confirmed_sent', review: 'requested' })).toEqual({ done: 2, current: 2, closed: false });
    expect(reviewProgress({ state: 'user_confirmed_sent', review: 'received' })).toEqual({ done: 4, current: 4, closed: false });
    expect(reviewProgress({ state: 'user_confirmed_sent', review: 'follow_up_drafted' })).toEqual({ done: 5, current: 5, closed: false });
    expect(reviewProgress({ state: 'user_confirmed_sent', review: 'follow_up_sent' })).toEqual({ done: 6, current: null, closed: false });
    expect(reviewProgress({ state: 'user_confirmed_sent', review: 'closed' }).closed).toBe(true);
  });

  it('offers only transitions the core allows', () => {
    const reviews: ReviewState[] = ['none', 'requested', 'received', 'follow_up_drafted', 'follow_up_sent', 'closed'];
    for (const review of reviews) {
      const c = reviewControls({ state: 'user_confirmed_sent', review });
      if (c.markRead) expect(ALLOWED[review]).toContain('received');
      if (c.writeFollowUp) expect(ALLOWED[review]).toContain('follow_up_drafted');
      if (c.close) expect(ALLOWED[review]).toContain('closed');
      if (c.reopen) expect(ALLOWED[review]).toContain('received');
    }
    expect(reviewControls({ state: 'user_confirmed_sent', review: 'requested' })).toMatchObject({ markRead: true, writeFollowUp: true, close: true, reopen: false });
    expect(reviewControls({ state: 'user_confirmed_sent', review: 'closed' })).toMatchObject({ markRead: false, writeFollowUp: false, close: false, reopen: true });
    expect(reviewControls({ state: 'user_confirmed_sent', review: 'none' }).note).toContain('No review was requested');
  });

  it('shows queue rows by review once sent', () => {
    expect(queueDeliveryLabel({ id: 'd', state: 'user_confirmed_sent', review: 'requested', destinationTitle: null, updatedAt: '' })).toBe('Review awaiting you');
    expect(queueDeliveryLabel({ id: 'd', state: 'user_confirmed_sent', review: 'none', destinationTitle: null, updatedAt: '' })).toBe('You confirmed it was sent');
    expect(queueDeliveryLabel(null)).toBe('No handoff prepared');
  });
});

describe('who may receive a follow-up', () => {
  function session(over: Partial<SessionView>): SessionView {
    return {
      key: 'win|a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617', env: 'win', sessionId: 'a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617', origin: 'managed', availability: 'live', termination: null, resumable: false,
      projectId: 'prj_1', projectName: 'GitManager', projectResolution: 'managed', cwd: null, name: null, state: 'waiting_for_you', stateLabel: 'Waiting for you', stateEvidence: 'x', generation: 1,
      pid: 1, startedAt: null, lastActivityAt: null, attention: null, unresolvedOrdering: 0, terminal: null, isProjectDefault: false, remoteControl: { state: 'unknown', hint: '' }, ...over,
    };
  }

  it('accepts a managed, live session that is waiting for the person', () => {
    for (const state of ['idle', 'waiting_for_you', 'turn_ended', 'report_ready'] as const) expect(targetEligibility(session({ state })), state).toEqual({ ok: true });
  });

  it('refuses an observed session and says Remote Control is the way', () => {
    for (const origin of ['external', 'background'] as const) {
      const result = targetEligibility(session({ origin }));
      expect(result).toMatchObject({ ok: false, kind: 'observed' });
      expect((result as { reason: string }).reason).toContain('cannot type into them');
      expect((result as { reason: string }).reason).toContain('Remote Control');
    }
  });

  it('refuses ended and disconnected sessions and says they can be resumed first', () => {
    const ended = targetEligibility(session({ availability: 'resumable', resumable: true, state: 'turn_ended' })) as { ok: false; reason: string };
    expect(ended.reason).toBe('Ended: this session is not running. Resume it in its project first.');
    const lost = targetEligibility(session({ availability: 'disconnected', resumable: true })) as { ok: false; reason: string };
    expect(lost.reason).toContain('Disconnected');
    expect(lost.reason).toContain('Resume the session in its project first');
    expect((targetEligibility(session({ availability: 'ended', resumable: false })) as { reason: string }).reason).toContain('cannot be resumed');
  });

  it('refuses a live session that is working or waiting for permission, with the reason', () => {
    expect((targetEligibility(session({ state: 'working' })) as { reason: string }).reason).toBe('Not ready: Claude is working. Wait until it is waiting for you.');
    expect((targetEligibility(session({ state: 'needs_permission' })) as { reason: string }).reason).toContain('waiting for permission');
    expect((targetEligibility(session({ state: 'needs_input' })) as { reason: string }).reason).toContain('asking you a question');
    expect(targetEligibility(session({ state: 'error' }))).toMatchObject({ ok: false, kind: 'not_ready' });
  });

  it('names the target as project, session, origin and environment', () => {
    expect(confirmTitle(session({}))).toBe('Send to GitManager, session a1b2c3d4 (managed, Windows)?');
    expect(confirmTitle(session({ origin: 'external', env: 'wsl:Ubuntu', projectName: null }))).toBe('Send to No project, session a1b2c3d4 (observed, WSL (Ubuntu))?');
  });
});

describe('report text', () => {
  it('keeps prose exactly and turns fenced blocks into code with their language', () => {
    const text = ['Intro line', '   indented stays', '', '```ts', 'const a = 1;', '', '  const b = 2;', '```', '', 'After.'].join('\n');
    expect(parseReportText(text)).toEqual([
      { kind: 'text', text: 'Intro line\n   indented stays' },
      { kind: 'code', info: 'ts', text: 'const a = 1;\n\n  const b = 2;' },
      { kind: 'text', text: 'After.' },
    ]);
  });

  it('closes a fence only on a line of at least as many of the same character', () => {
    const text = ['````md', '```js', 'inner', '```', '````', 'tail'].join('\n');
    expect(parseReportText(text)).toEqual([{ kind: 'code', info: 'md', text: '```js\ninner\n```' }, { kind: 'text', text: 'tail' }]);
    expect(parseReportText(['~~~', 'a', '```', '~~~'].join('\n'))).toEqual([{ kind: 'code', info: '', text: 'a\n```' }]);
  });

  it('runs an unterminated fence to the end, as Markdown does', () => {
    expect(parseReportText('before\n```\nnever closed\nstill code')).toEqual([{ kind: 'text', text: 'before' }, { kind: 'code', info: '', text: 'never closed\nstill code' }]);
  });

  it('does not take a line with backticks in its info string for a fence', () => {
    const text = '```not a fence``` here\nnext';
    expect(parseReportText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('treats markup as plain text and never as structure', () => {
    const text = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n&amp; **bold** [link](javascript:alert(3))';
    expect(parseReportText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('handles Windows line endings and an empty report', () => {
    expect(parseReportText('a\r\nb')).toEqual([{ kind: 'text', text: 'a\nb' }]);
    expect(parseReportText('')).toEqual([{ kind: 'text', text: '' }]);
  });
});

describe('history in plain language', () => {
  const event = (type: DeliveryEvent['type'], detail: Record<string, unknown> = {}): DeliveryEvent => ({ id: 'e', deliveryId: 'd', at: '2026-10-30T14:00:00.000Z', type, from: null, to: null, actor: { kind: 'desktop' }, detail });

  it('describes every kind of event', () => {
    const kinds: DeliveryEvent['type'][] = ['created', 'destination_resolved', 'destination_changed', 'destination_verified', 'prepared', 'part_copied', 'destination_opened', 'confirmed_sent', 'marked_uncertain', 'discarded', 'reopened', 'review_changed', 'follow_up_drafted', 'note'];
    for (const type of kinds) expect(describeEvent(event(type)).length, type).toBeGreaterThan(3);
  });

  it('puts the specifics in', () => {
    expect(describeEvent(event('part_copied', { part: 2, partCount: 4 }))).toBe('Part 2 of 4 copied');
    expect(describeEvent(event('part_copied', { part: 1, partCount: 1 }))).toBe('Message copied');
    expect(describeEvent(event('destination_changed', { from: { title: 'A' }, to: { title: 'B' } }))).toBe('Destination changed from A to B');
    expect(describeEvent(event('prepared', { partCount: 3, chars: 30_400 }))).toBe('Message prepared, 3 parts, 30,400 characters');
    expect(describeEvent(event('review_changed', { to: 'received' }))).toBe('Review: review noted');
    expect(describeEvent(event('destination_resolved', { destination: null, reason: 'No ChatGPT conversation is mapped to this project yet.' }))).toBe('No destination yet. No ChatGPT conversation is mapped to this project yet.');
  });
});

describe('pending actions', () => {
  const base = { id: 'a', kind: 'claude_prompt', status: 'pending', failure: null } as never;
  it('states the true outcome in plain words', () => {
    expect(actionOutcome({ ...(base as object), status: 'executed' } as never)?.text).toBe('Approved. The text was typed into the terminal and sent with Enter.');
    expect(actionOutcome({ ...(base as object), kind: 'permission', status: 'executed' } as never)?.text).toBe('Approved. Mini-Summa answered yes in the terminal.');
    expect(actionOutcome({ ...(base as object), status: 'rejected' } as never)?.text).toBe('Rejected. Nothing was typed.');
    expect(actionOutcome({ ...(base as object), status: 'failed', failure: 'This session is not running right now' } as never)).toMatchObject({ tone: 'error', text: 'Not carried out: This session is not running right now. Nothing is retried for you.' });
    expect(actionOutcome(base)).toBeNull();
  });

  it('counts down to expiry', () => {
    const now = Date.parse('2026-10-30T14:00:00.000Z');
    expect(untilWords('2026-10-30T14:55:00.000Z', now)).toBe('55 min');
    expect(untilWords('2026-10-30T14:00:20.000Z', now)).toBe('less than a minute');
    expect(untilWords('2026-10-30T13:59:00.000Z', now)).toBeNull();
    expect(untilWords('2026-10-30T18:00:00.000Z', now)).toBe('4 h');
  });
});
