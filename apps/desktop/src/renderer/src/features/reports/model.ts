// What the handoff screens say and offer, as plain functions. Nothing here touches React or the network, so the rules
// that matter (which actions are valid in which state, what may be claimed before the person says "I sent it", who may
// receive a follow-up) are tested directly.
//
// The state machine itself lives in the core and refuses what is invalid; this file mirrors it so the screen never
// offers a button the core would turn down. docs/HANDOFF.md is the source for the wording.
import { envLabel, shortSessionId } from '@minisumma/shared';
import type {
  ChatGptOpenResult, Conversation, ConversationVerification, DeclaredStatus, Delivery, DeliveryEvent, DeliveryResolution, DeliveryState, FrozenDestination,
  PendingAction, ReportSummary, ReviewState, SessionView,
} from '@minisumma/shared';

// ---------------------------------------------------------------------------------------------------------------
// Words for facts

/** "Declared complete by Claude": the marker is a declaration by the model, never "completed". */
export const DECLARED_TEXT: Record<DeclaredStatus, string> = {
  complete: 'Declared complete by Claude',
  partial: 'Declared partial by Claude',
  blocked: 'Declared blocked by Claude',
};

/** Where a delivery stands, short enough for the queue. Matches the table in docs/HANDOFF.md. */
export const STATE_LABEL: Record<DeliveryState, string> = {
  report_captured: 'Setting up the handoff',
  destination_missing: 'No conversation chosen',
  destination_unverified: 'Ready, conversation not verified',
  ready_for_handoff: 'Ready for handoff',
  copied: 'Copied, not sent yet',
  awaiting_user_send: 'Awaiting your send',
  user_confirmed_sent: 'You confirmed it was sent',
  delivery_uncertain: 'Delivery uncertain',
  user_discarded: 'Discarded',
};

export const REVIEW_LABEL: Record<ReviewState, string> = {
  none: 'No review requested',
  requested: 'Review awaiting you',
  received: 'Review noted',
  follow_up_drafted: 'Follow-up prepared',
  follow_up_sent: 'Follow-up sent to Claude',
  closed: 'Review closed',
};

/** The delivery line of a queue row. After "sent" the review state matters more than the fact that it was sent. */
export function queueDeliveryLabel(delivery: ReportSummary['delivery']): string {
  if (!delivery) return 'No handoff prepared';
  if (delivery.state === 'user_confirmed_sent' && delivery.review !== 'none') return REVIEW_LABEL[delivery.review];
  return STATE_LABEL[delivery.state];
}

export const RESOLUTION_TEXT: Record<DeliveryResolution, string> = {
  session_binding: 'Chosen because it is bound to this session.',
  project_preferred: 'Chosen because it is the project\'s preferred conversation.',
  only_conversation: 'Chosen because it is the project\'s only conversation.',
  user_selected: 'Chosen by you.',
};

export function verificationWords(state: ConversationVerification, title?: string | null): string {
  switch (state) {
    case 'unverified': return 'Not verified yet';
    case 'verified': return title ? `Verified: ${title}` : 'Verified';
    case 'mismatch': return 'The page that opened did not match this conversation';
    case 'unreachable': return 'ChatGPT could not be reached';
    case 'login_required': return 'ChatGPT asked for a sign-in';
  }
}

export interface DestinationFacts {
  title: string;
  url: string;
  verification: string;
  resolved: string;
  /** Plain statement that the destination was fixed and does not follow focus. */
  frozen: string;
  /** Set when the project's conversation changed or went away after the destination was fixed. */
  drift: string | null;
}

/**
 * What the handoff card says about where the report goes. It reads the frozen destination and only looks at the
 * project's conversation to report on it (verification, and whether it was edited or removed since).
 */
export function describeDestination(destination: FrozenDestination, current: Conversation | undefined, when: (iso: string) => string): DestinationFacts {
  const same = current !== undefined && current.url === destination.url;
  const verification = same ? verificationWords(current.verification, current.verifiedTitle) : verificationWords(destination.verificationAtFreeze);
  const by = destination.resolvedFrom === 'user_selected' ? 'You fixed this destination' : 'This destination was fixed when the report was captured';
  let drift: string | null = null;
  if (!current) drift = 'This conversation was removed from the project after the destination was fixed. The report still goes to the address above.';
  else if (current.url !== destination.url) drift = 'The project\'s conversation now has a different address. The report still goes to the address above.';
  return {
    title: destination.title,
    url: destination.url,
    verification,
    resolved: RESOLUTION_TEXT[destination.resolvedFrom],
    frozen: `${by} on ${when(destination.frozenAt)}. It does not follow the open tab, the selected project or later changes to the project's preferred conversation.`,
    drift,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Which actions are valid in which state

export type HandoffActionId =
  | 'handoff' | 'open' | 'copyAgain' | 'confirmSent' | 'markUncertain' | 'discard' | 'reopen' | 'chooseDestination' | 'addConversation' | 'prepare' | 'openSession';

export interface HandoffButton { id: HandoffActionId; label: string; part?: number }

export interface HandoffPlan {
  /** The state in words, as a heading. */
  headline: string;
  /** Sentences under it. */
  body: string[];
  /** The single main action, or null when the state offers none. */
  primary: HandoffButton | null;
  secondary: HandoffButton[];
  /** Low-emphasis decisions. */
  quiet: HandoffButton[];
  /** "Copy the whole message" and, where valid, "I sent it another way". ("Save as file" sits with the report's own actions.) */
  alternatives: { wholeMessage: boolean; sentAnotherWay: boolean };
  /** "Change destination" is offered next to the destination. */
  changeDestination: boolean;
  /** The next uncopied part, when the message has several. */
  nextPart: number | null;
  partCount: number;
}

export interface HandoffContext {
  /** Conversations mapped to the report's project. */
  conversationCount: number;
  /** The report's session belongs to a project at all. */
  hasProject: boolean;
}

export const COPYABLE: readonly DeliveryState[] = ['destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send'];
const CLOSED: readonly DeliveryState[] = ['user_confirmed_sent', 'user_discarded'];
const DESTINATION_CHANGE: readonly DeliveryState[] = ['destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain'];

export const isClosed = (state: DeliveryState): boolean => CLOSED.includes(state);
export const canDiscard = (state: DeliveryState): boolean => !CLOSED.includes(state);

const splitNote = (total: number): string[] => (total > 1
  ? [`This message is long, so it has ${total} parts. Copy and open copies part 1 first. Paste and send each part in order; the parts tell ChatGPT not to answer until the last one.`]
  : []);

const handoffLabel = (part: number, total: number): string => (total > 1 ? `Copy part ${part} of ${total} and open` : 'Copy and open');

export function handoffPlan(delivery: Delivery, ctx: HandoffContext): HandoffPlan {
  const total = delivery.parts.length;
  const nextPart = total > 1 ? delivery.parts.find((p) => p.copiedAt === null)?.index ?? null : null;
  const hasDestination = delivery.destination !== null;
  const copyButton: HandoffButton = { id: 'handoff', label: handoffLabel(nextPart ?? 1, total), part: total > 1 ? nextPart ?? 1 : undefined };
  const base = {
    secondary: [] as HandoffButton[], quiet: [] as HandoffButton[], nextPart, partCount: total,
    changeDestination: DESTINATION_CHANGE.includes(delivery.state) && hasDestination,
  };
  const alternatives = (sentAnotherWay: boolean) => ({ wholeMessage: hasDestination, sentAnotherWay });
  const discard: HandoffButton = { id: 'discard', label: 'Discard' };

  switch (delivery.state) {
    case 'report_captured':
      return { ...base, headline: STATE_LABEL.report_captured, body: ['Mini-Summa is still setting this handoff up.'], primary: null, quiet: [discard], alternatives: { wholeMessage: false, sentAnotherWay: false } };

    case 'destination_missing': {
      const choose: HandoffButton = { id: 'chooseDestination', label: 'Choose a conversation' };
      const add: HandoffButton = { id: 'addConversation', label: ctx.conversationCount > 0 ? 'Add a conversation' : 'Add a ChatGPT conversation' };
      const body = ['No ChatGPT conversation is set for this report, so there is nowhere to hand it to yet.'];
      if (!ctx.hasProject) {
        return { ...base, headline: STATE_LABEL.destination_missing, body: [...body, 'The session that wrote it is not assigned to a project. Assign it to a project first.'], primary: { id: 'openSession', label: 'Open the session' }, quiet: [discard], alternatives: alternatives(false) };
      }
      return {
        ...base, headline: STATE_LABEL.destination_missing, body,
        primary: ctx.conversationCount > 0 ? choose : add, secondary: ctx.conversationCount > 0 ? [add] : [], quiet: [discard], alternatives: alternatives(false),
      };
    }

    case 'destination_unverified':
      return {
        ...base, headline: STATE_LABEL.destination_unverified,
        body: ['Mini-Summa has not confirmed that this address opens the conversation you mean. Open it first to check, or copy and open anyway.', ...splitNote(total)],
        primary: copyButton, secondary: [{ id: 'open', label: 'Open to check it first' }], quiet: [discard], alternatives: alternatives(true),
      };

    case 'ready_for_handoff':
      return {
        ...base, headline: STATE_LABEL.ready_for_handoff,
        body: ['Copy and open puts the message on your clipboard and opens the conversation. You paste it and press Send in ChatGPT yourself.', ...splitNote(total)],
        primary: copyButton, secondary: [{ id: 'open', label: 'Open to check it first' }], quiet: [discard], alternatives: alternatives(true),
      };

    case 'copied':
    case 'awaiting_user_send': {
      const awaiting = delivery.state === 'awaiting_user_send';
      const body = awaiting
        ? ['The message was copied and the conversation was opened. It is not marked as sent yet. Paste it into ChatGPT, press Send there, then come back and press I sent it.']
        : ['The message is copied. Copying does not send it, and neither does opening the conversation. Paste it into ChatGPT, press Send there, then press I sent it.'];
      const moreParts = nextPart !== null;
      if (moreParts) body.push(`This message has ${total} parts. Part ${nextPart} is next. I sent it appears when every part has been copied.`);
      return {
        ...base, headline: STATE_LABEL[delivery.state], body,
        primary: moreParts ? copyButton : { id: 'confirmSent', label: 'I sent it' },
        secondary: [{ id: 'open', label: 'Open conversation' }, ...(total > 1 ? [] : [{ id: 'copyAgain', label: 'Copy again' } as HandoffButton])],
        quiet: [{ id: 'markUncertain', label: 'Not sure' }, discard], alternatives: alternatives(moreParts),
      };
    }

    case 'user_confirmed_sent':
      return {
        ...base, headline: 'You confirmed it was sent',
        body: ['Mini-Summa cannot see ChatGPT, so this is your statement. Everything after it is also what you tell Mini-Summa.'],
        primary: null, secondary: [{ id: 'open', label: 'Open conversation' }], quiet: [{ id: 'markUncertain', label: 'I am not sure it was sent' }], alternatives: alternatives(false),
      };

    case 'delivery_uncertain':
      return {
        ...base, headline: STATE_LABEL.delivery_uncertain,
        body: ['You were not sure this went through, or something went wrong. Nothing is retried for you. Reopen it to try again, or press I sent it if you know it arrived.'],
        primary: { id: 'reopen', label: 'Reopen' },
        secondary: [{ id: 'confirmSent', label: 'I sent it' }, { id: 'open', label: 'Open conversation' }], quiet: [discard], alternatives: alternatives(false),
      };

    case 'user_discarded':
      return {
        ...base, headline: STATE_LABEL.user_discarded, body: ['You discarded this handoff. It is not recorded as sent.'],
        primary: null, secondary: [{ id: 'reopen', label: 'Reopen' }], alternatives: { wholeMessage: false, sentAnotherWay: false },
      };
  }
}

/** A flat list of the labels a plan offers, for tests and for the accessible summary. */
export function offeredLabels(plan: HandoffPlan): string[] {
  const labels = [plan.primary, ...plan.secondary, ...plan.quiet].filter((b): b is HandoffButton => b !== null).map((b) => b.label);
  if (plan.changeDestination) labels.push('Change destination');
  if (plan.alternatives.wholeMessage) labels.push('Copy the whole message');
  if (plan.alternatives.sentAnotherWay) labels.push('I sent it another way');
  return labels;
}

// ---------------------------------------------------------------------------------------------------------------
// Opening the conversation: what happened, without claiming more than the host observed

export interface OpenReport { tone: 'ok' | 'warning' | 'error'; text: string }

export function describeOpen(result: ChatGptOpenResult): OpenReport {
  if (!result.ok) {
    return { tone: 'error', text: `Mini-Summa could not open ChatGPT.${result.note ? ` ${sentence(result.note)}` : ''}` };
  }
  const parts: string[] = [];
  if (!result.opened && !result.focused) parts.push('Mini-Summa asked for the conversation to be shown but could not confirm that it was.');
  else if (result.mode === 'embedded') parts.push('Opened in the ChatGPT view inside Mini-Summa.');
  else if (result.mode === 'extension') parts.push(result.focused ? 'Brought your existing browser tab to the front.' : 'Opened the conversation in your browser through the extension.');
  else if (result.mode === 'external') parts.push('Opened your default browser.');
  else parts.push('Asked for the conversation to be shown.');
  if (result.mode === 'external') parts.push('Mini-Summa cannot see the browser window.');
  else if (result.opened || result.focused) parts.push(result.focused ? 'It was brought to the front.' : 'Mini-Summa could not confirm that it came to the front.');
  let tone: OpenReport['tone'] = 'ok';
  if (result.verified === true) parts.push('The page was confirmed to be this conversation.');
  else if (result.verified === false) { parts.push('The page that loaded may not be this conversation.'); tone = 'warning'; }
  else parts.push('Mini-Summa could not check which page loaded.');
  if (result.note) parts.push(sentence(result.note));
  return { tone, text: parts.join(' ') };
}

const sentence = (text: string): string => { const t = text.trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };

// ---------------------------------------------------------------------------------------------------------------
// The history of a delivery in plain language

export function actorWords(e: DeliveryEvent): string {
  if (e.actor.kind === 'desktop') return 'You';
  if (e.actor.kind === 'device') return e.actor.name;
  return 'Mini-Summa';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const title = (v: unknown): string | null => (v && typeof v === 'object' ? str((v as { title?: unknown }).title) : null);

export function describeEvent(e: DeliveryEvent): string {
  const d = e.detail;
  switch (e.type) {
    case 'created': return 'Handoff created';
    case 'destination_resolved': {
      const to = title(d.destination);
      return to ? `Destination fixed: ${to}` : `No destination yet.${str(d.reason) ? ` ${str(d.reason)}` : ''}`;
    }
    case 'destination_changed': return `Destination changed${title(d.from) ? ` from ${title(d.from)}` : ''} to ${title(d.to) ?? 'another conversation'}`;
    case 'destination_verified': return 'The conversation was verified';
    case 'prepared': {
      const parts = num(d.partCount);
      return `Message prepared${parts !== null ? `, ${parts === 1 ? '1 part' : `${parts} parts`}` : ''}${num(d.chars) !== null ? `, ${num(d.chars)!.toLocaleString('en-US')} characters` : ''}`;
    }
    case 'part_copied': {
      const part = num(d.part); const total = num(d.partCount);
      return total !== null && total > 1 && part !== null ? `Part ${part} of ${total} copied` : 'Message copied';
    }
    case 'destination_opened': return 'The conversation was opened';
    case 'confirmed_sent': return 'You confirmed it was sent';
    case 'marked_uncertain': return 'Marked as uncertain';
    case 'discarded': return 'Discarded';
    case 'reopened': return 'Reopened';
    case 'review_changed': {
      const to = str(d.to) as ReviewState | null;
      return to ? `Review: ${REVIEW_LABEL[to].toLowerCase()}` : 'Review changed';
    }
    case 'follow_up_drafted': return 'Follow-up draft saved';
    case 'note': {
      if (d.action === 'open_failed') return `ChatGPT could not be opened${str(d.note) ? `. ${sentence(str(d.note)!)}` : ''}`;
      if (d.action === 'saved_file') return `Saved as a file${str(d.path) ? `: ${str(d.path)}` : ''}`;
      if (d.action === 'prompt_typed') return 'A prompt was typed into a Claude session from this handoff';
      return str(d.note) ?? 'Note';
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The review, step by step. Everything after "sent" is a statement by the person.

export const REVIEW_STEPS = ['Report ready', 'Sent by you', 'Review awaiting you', 'Review noted', 'Follow-up prepared', 'Sent to Claude'] as const;

export interface ReviewProgress {
  /** How many steps are complete. */
  done: number;
  /** The step the person is on, or null when nothing is pending. */
  current: number | null;
  closed: boolean;
}

export function reviewProgress(delivery: Pick<Delivery, 'state' | 'review'>): ReviewProgress {
  const sent = delivery.state === 'user_confirmed_sent';
  switch (delivery.review) {
    case 'none': return sent ? { done: 2, current: null, closed: false } : { done: 1, current: 1, closed: false };
    case 'requested': return { done: 2, current: 2, closed: false };
    case 'received': return { done: 4, current: 4, closed: false };
    case 'follow_up_drafted': return { done: 5, current: 5, closed: false };
    case 'follow_up_sent': return { done: 6, current: null, closed: false };
    case 'closed': return { done: 2, current: null, closed: true };
  }
}

/** The controls the person has at each review stage. Mirrors what the core allows (REVIEW_ALLOWED). */
export interface ReviewControls { markRead: boolean; writeFollowUp: boolean; close: boolean; reopen: boolean; note: string | null }

export function reviewControls(delivery: Pick<Delivery, 'state' | 'review'>): ReviewControls {
  const sent = delivery.state === 'user_confirmed_sent';
  if (!sent && delivery.review === 'none') return { markRead: false, writeFollowUp: false, close: false, reopen: false, note: null };
  switch (delivery.review) {
    case 'none': return { markRead: false, writeFollowUp: false, close: false, reopen: false, note: 'No review was requested with this message, so there is nothing to track.' };
    case 'requested': return { markRead: true, writeFollowUp: true, close: true, reopen: false, note: null };
    case 'received': return { markRead: false, writeFollowUp: true, close: true, reopen: false, note: null };
    case 'follow_up_drafted': return { markRead: false, writeFollowUp: true, close: true, reopen: false, note: null };
    case 'follow_up_sent': return { markRead: false, writeFollowUp: false, close: true, reopen: false, note: null };
    case 'closed': return { markRead: false, writeFollowUp: false, close: false, reopen: true, note: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Who may receive a follow-up

const ACCEPTS_INPUT: ReadonlySet<SessionView['state']> = new Set(['idle', 'waiting_for_you', 'turn_ended', 'report_ready']);

export type Eligibility = { ok: true } | { ok: false; kind: 'observed' | 'not_running' | 'not_ready'; reason: string };

/** Mirrors the checks the core repeats at the moment of typing: managed, live, in a state that accepts input. */
export function targetEligibility(session: SessionView): Eligibility {
  if (session.origin !== 'managed') {
    return {
      ok: false, kind: 'observed',
      reason: 'Observed session: Mini-Summa only watches sessions it did not start, so it cannot type into them. You can continue it from the Claude app with Remote Control.',
    };
  }
  if (session.availability === 'disconnected') {
    return { ok: false, kind: 'not_running', reason: `Disconnected: Mini-Summa lost this terminal, for example after a restart. ${session.resumable ? 'Resume the session in its project first.' : 'It cannot be resumed.'}` };
  }
  if (session.availability === 'ended' || session.availability === 'resumable') {
    return { ok: false, kind: 'not_running', reason: `Ended: this session is not running. ${session.resumable ? 'Resume it in its project first.' : 'It cannot be resumed.'}` };
  }
  if (!ACCEPTS_INPUT.has(session.state)) {
    const why: Partial<Record<SessionView['state'], string>> = {
      working: 'Claude is working. Wait until it is waiting for you.',
      needs_permission: 'Claude is waiting for permission. Answer that first.',
      needs_input: 'Claude is asking you a question. Answer that first.',
      background_wait: 'Claude is running background work.',
      error: 'Claude reported an error.',
    };
    return { ok: false, kind: 'not_ready', reason: `Not ready: ${why[session.state] ?? `the session is ${session.stateLabel.toLowerCase()}.`}` };
  }
  return { ok: true };
}

/** "GitManager, session a1b2c3d4 (managed, Windows)": the name of a target wherever it is shown. */
export function targetName(session: Pick<SessionView, 'key' | 'origin' | 'env' | 'projectName'>): string {
  return `${session.projectName ?? 'No project'}, session ${shortSessionId(session.key)} (${session.origin === 'managed' ? 'managed' : 'observed'}, ${envLabel(session.env)})`;
}

export const confirmTitle = (session: Pick<SessionView, 'key' | 'origin' | 'env' | 'projectName'>): string => `Send to ${targetName(session)}?`;

// ---------------------------------------------------------------------------------------------------------------
// Pending actions

export function actorName(actor: PendingAction['createdBy']): string {
  if (actor.kind === 'device') return actor.name;
  if (actor.kind === 'desktop') return 'You, on this PC';
  return 'Mini-Summa (the permission prompt in the terminal)';
}

export function actionOutcome(action: PendingAction): { tone: 'ok' | 'error' | 'info'; text: string } | null {
  const permission = action.kind === 'permission';
  switch (action.status) {
    case 'executed': return { tone: 'ok', text: permission ? 'Approved. Mini-Summa answered yes in the terminal.' : 'Approved. The text was typed into the terminal and sent with Enter.' };
    case 'rejected': return { tone: 'info', text: permission ? 'Rejected. Mini-Summa answers no in the terminal if the session is still asking.' : 'Rejected. Nothing was typed.' };
    case 'failed': return { tone: 'error', text: `Not carried out: ${sentence(action.failure ?? 'it did not work')} Nothing is retried for you.` };
    case 'expired': return { tone: 'info', text: 'Expired. Nothing was typed.' };
    case 'superseded': return { tone: 'info', text: 'The session moved on, so this request no longer applies. Nothing was typed.' };
    case 'approved': return { tone: 'info', text: 'Approved. Waiting for the terminal.' };
    case 'pending': return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Report text: plain text with fenced code blocks. Never HTML.

export type TextSegment = { kind: 'text'; text: string } | { kind: 'code'; info: string; text: string };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/;

/**
 * Splits a report into prose and fenced code blocks. The text is untrusted: segments are rendered as text nodes only.
 * A fence opened by n backticks (or tildes) closes at a line of at least n of the same character; one that never closes
 * runs to the end, as in Markdown.
 */
export function parseReportText(text: string): TextSegment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: TextSegment[] = [];
  let prose: string[] = [];
  let code: string[] = [];
  let fence: { char: string; size: number; info: string } | null = null;
  const flushProse = () => {
    if (prose.length) out.push({ kind: 'text', text: prose.join('\n') });
    prose = [];
  };
  for (const line of lines) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.size},}[ \\t]*$`);
      if (close.test(line)) {
        out.push({ kind: 'code', info: fence.info, text: code.join('\n') });
        code = [];
        fence = null;
      } else code.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      flushProse();
      fence = { char: open[1][0], size: open[1].length, info: open[2].trim() };
      continue;
    }
    prose.push(line);
  }
  if (fence) out.push({ kind: 'code', info: fence.info, text: code.join('\n') });
  else flushProse();
  // The blank line that separates prose from a code block is spacing, not content: drop it at the seams only.
  const seams = out.map((seg, i) => {
    if (seg.kind === 'code') return seg;
    let t = seg.text;
    if (out[i - 1]?.kind === 'code') t = t.replace(/^(?:[ \t]*\n)+/, '');
    if (out[i + 1]?.kind === 'code') t = t.replace(/(?:\n[ \t]*)+$/, '');
    return { kind: 'text' as const, text: t };
  });
  return seams.filter((seg) => seg.kind === 'code' || seg.text.trim() !== '' || seams.length === 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Time

const SHORT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : SHORT.format(new Date(t));
}

/** "55 min" until something expires, "less than a minute" near the end, null when it already has. */
export function untilWords(iso: string, now: number = Date.now()): string | null {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms) || ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'less than a minute';
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** The text of a count: "1 character", "12,480 characters". */
export const characters = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'character' : 'characters'}`;
