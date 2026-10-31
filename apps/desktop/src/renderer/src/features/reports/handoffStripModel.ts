// The handoff strip: which delivery of the selected project is waiting for the person, and what the strip says and offers about it.
// Plain functions, no React. The words and the buttons come from the same plan as the handoff card (model.ts), so the strip never
// offers what the card would not, and never says a message was sent before the person has said so.
import type { Delivery, DeliveryState } from '@minisumma/shared';
import { handoffPlan } from './model';
import type { HandoffButton } from './model';

/**
 * The states in which a delivery waits for the person and can be handed over from here. Not `destination_missing` (there is
 * nowhere to hand it to, and a project without a conversation would show the strip for ever), not `delivery_uncertain` (the card
 * is where that is untangled), not `report_captured` (a moment while the core sets it up).
 */
export const STRIP_STATES: readonly DeliveryState[] = ['ready_for_handoff', 'destination_unverified', 'copied', 'awaiting_user_send'];

/** The person has started: the message is on the clipboard. These come before deliveries that have not been started. */
const IN_PROGRESS: readonly DeliveryState[] = ['copied', 'awaiting_user_send'];

export const isInProgress = (d: Pick<Delivery, 'state'>): boolean => IN_PROGRESS.includes(d.state);

/**
 * The deliveries of one project that wait for the person, most pressing first: the one the person is in the middle of (so a report
 * that arrives meanwhile never takes "I sent it" away), then the newest.
 */
export function waitingDeliveries(deliveries: readonly Delivery[], projectId: string): Delivery[] {
  return deliveries
    .filter((d) => d.projectId === projectId && STRIP_STATES.includes(d.state) && d.destination !== null)
    .sort((a, b) => Number(isInProgress(b)) - Number(isInProgress(a)) || b.stateChangedAt.localeCompare(a.stateChangedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export interface StripView {
  delivery: Delivery;
  /** Copied and waiting for the person to paste and send: the strip says "Waiting for you to send". */
  waiting: boolean;
  /** One sentence with the task: "Report ready: Fix the retry test" or "Waiting for you to send: Fix the retry test to Release planning." */
  headline: string;
  /** What to know before pressing: where it goes, or that it is not marked as sent. */
  detail: string;
  /** The single main action: Copy and open, Copy part 2 of 3 and open, or I sent it. */
  primary: HandoffButton | null;
  /** Copy again, Open conversation. */
  secondary: HandoffButton[];
  /** Not sure. */
  quiet: HandoffButton[];
  /** How many other deliveries of the project wait too. */
  more: number;
}

const partsCopied = (d: Delivery): number => d.parts.filter((p) => p.copiedAt !== null).length;

/** What the strip shows for a project, or null when nothing waits. */
export function describeStrip(deliveries: readonly Delivery[], projectId: string, conversationCount: number): StripView | null {
  const [delivery, ...rest] = waitingDeliveries(deliveries, projectId);
  if (!delivery || !delivery.destination) return null;
  const plan = handoffPlan(delivery, { conversationCount, hasProject: true });
  const waiting = isInProgress(delivery);
  const destination = delivery.destination.title;
  const total = plan.partCount;

  let headline: string;
  let detail: string;
  if (waiting) {
    headline = `Waiting for you to send: ${delivery.taskTitle} to ${destination}.`;
    const state = 'It is not marked as sent until you press I sent it.';
    detail = plan.nextPart !== null ? `${partsCopied(delivery)} of ${total} parts are copied. Part ${plan.nextPart} is next. ${state}` : state;
  } else {
    headline = `Report ready: ${delivery.taskTitle}`;
    const unverified = delivery.state === 'destination_unverified' ? ', which is not verified yet' : '';
    detail = `Goes to ${destination}${unverified}.${total > 1 ? ` The message is long, so it has ${total} parts.` : ''}`;
  }

  // The same buttons as the card, fewer of them: the rest (Discard, Open to check it first, the alternatives) stay in the card.
  const secondary: HandoffButton[] = [];
  if (waiting) {
    const copyAgain = plan.secondary.find((b) => b.id === 'copyAgain');
    const open = plan.secondary.find((b) => b.id === 'open');
    if (copyAgain) secondary.push(copyAgain);
    if (open) secondary.push(open);
  }
  const quiet = waiting ? plan.quiet.filter((b) => b.id === 'markUncertain') : [];
  return { delivery, waiting, headline, detail, primary: plan.primary, secondary, quiet, more: rest.length };
}
