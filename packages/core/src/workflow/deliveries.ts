// DeliveriesService: the honest handoff of one report to one ChatGPT conversation.
//
// Rules this module exists to keep:
//  * Nothing here submits anything to ChatGPT, and nothing here ever advances a state by itself. There are no timers;
//    a state changes only inside a method a person's action called. Whether a message was sent is the user's statement.
//  * The destination is resolved from explicit mappings only (session binding, project preferred, project's only
//    conversation) and FROZEN into destination_json. Changing the project's preferred conversation, or editing or
//    deleting the conversation row, never moves an existing delivery. Only setDestination (a user action) re-points it.
//  * Every change appends a delivery_events row and emits `delivery.upserted` after the transaction commits.
//
// Contract notes:
//  * Refusals are CoreError 409 with one of: `delivery_closed` (confirmed or discarded and the operation is not allowed
//    from there), `destination_missing` (the operation needs a destination and there is none), `invalid_state`
//    (anything else). Bad part numbers are 400 `part_out_of_range`, a missing follow-up text is 400
//    `follow_up_draft_required`, a forbidden review change is 409 `invalid_review_transition`, a clipboard that cannot
//    be written is 502 `clipboard_failed`, a file that cannot be written is 502 `save_failed`.
//  * copy and handoff are refused from delivery_uncertain (reopen it first); open is allowed there and from
//    user_confirmed_sent (to go and read the answer) without changing the state. open moves copied or
//    awaiting_user_send to awaiting_user_send and never claims success when the host reports it could not open.
//  * prepare on a closed delivery returns the stored message and never rewrites it, so the record of what was sent stays
//    intact. Parts are always split from the stored message with the current maxPartChars; copiedAt of a part survives
//    a new preparation only when the message hash and that part's own hash are unchanged.
//  * reopen and setDestination clear the copied marks (a retry starts again from part 1).
//  * list returns deliveries oldest first, so the last element is the latest one.
//  * Message and parts are written together with the copy that depends on them, and a failed clipboard write changes
//    nothing at all (not even the stored message).
import type {
  ActorRef, ChatGptOpenResult, Conversation, ConversationVerification, Delivery, DeliveryDetail, DeliveryEvent, DeliveryEventType,
  DeliveryPartInfo, DeliveryPrepared, DeliveryResolution, DeliveryState, FrozenDestination, MessagePart, NativeBridge, Report, ReportSummary,
  ReviewState, SessionKey,
} from '@minisumma/shared';
import { buildReportMessage, envLabel, shortSessionId, splitMessage } from '@minisumma/shared';
import type { SqlValue } from '@minisumma/storage';
import { bool, fromJson, int, newId, toJson } from '@minisumma/storage';
import type { CoreBase, DeliveriesService, ProjectsService, ReportsService, SessionsService, SettingsService } from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { badRequest, conflict, CoreError, notFound } from '../errors.ts';
import { existingProjectId, packText, sha256, unpackText } from './util.ts';

export interface DeliveriesServiceDeps {
  base: CoreBase;
  settings: Pick<SettingsService, 'get'>;
  projects: Pick<ProjectsService, 'get' | 'conversations'>;
  reports: Pick<ReportsService, 'require'>;
  sessions: Pick<SessionsService, 'get' | 'conversationBinding'>;
  native: NativeBridge;
}

interface DeliveryRow {
  id: string;
  report_id: string;
  project_id: string | null;
  project_name: string | null;
  session_key: SessionKey;
  task_title: string;
  state: DeliveryState;
  destination_json: string | null;
  review: ReviewState;
  include_review_request: number;
  message_sha256: string | null;
  message_chars: number | null;
  parts_json: string;
  follow_up_draft: string | null;
  attempts: number;
  last_error: string | null;
  auto_key: string | null;
  state_changed_at: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  delivery_id: string;
  at: string;
  type: DeliveryEventType;
  from_state: DeliveryState | null;
  to_state: DeliveryState | null;
  actor_json: string;
  detail_json: string;
}

/** Every column except the (large) message text, which is read only when needed. */
const COLUMNS = `id, report_id, project_id, project_name, session_key, task_title, state, destination_json, review, include_review_request,
  message_sha256, message_chars, parts_json, follow_up_draft, attempts, last_error, auto_key, state_changed_at, created_at, updated_at`;

const SYSTEM: ActorRef = { kind: 'system' };

const ALL_STATES: readonly DeliveryState[] = [
  'report_captured', 'destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send',
  'user_confirmed_sent', 'delivery_uncertain', 'user_discarded',
];
const CLOSED: readonly DeliveryState[] = ['user_confirmed_sent', 'user_discarded'];
const COPY_FROM: readonly DeliveryState[] = ['destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send'];
const OPEN_FROM: readonly DeliveryState[] = [...COPY_FROM, 'delivery_uncertain', 'user_confirmed_sent'];
const CONFIRM_FROM: readonly DeliveryState[] = [...COPY_FROM, 'delivery_uncertain'];
const UNCERTAIN_FROM: readonly DeliveryState[] = ['copied', 'awaiting_user_send', 'user_confirmed_sent'];
const REOPEN_FROM: readonly DeliveryState[] = ['user_discarded', 'delivery_uncertain'];
const DISCARD_FROM: readonly DeliveryState[] = ALL_STATES.filter((s) => !CLOSED.includes(s));
const DESTINATION_CHANGE_FROM: readonly DeliveryState[] = [
  'destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain',
];

const STATE_PHRASE: Record<DeliveryState, string> = {
  report_captured: 'still being set up',
  destination_missing: 'missing a destination',
  destination_unverified: 'waiting with a destination that is not verified',
  ready_for_handoff: 'ready to hand off',
  copied: 'copied',
  awaiting_user_send: 'waiting for you to send it',
  user_confirmed_sent: 'marked as sent',
  delivery_uncertain: 'marked as uncertain',
  user_discarded: 'discarded',
};

const STATE_HINT: Partial<Record<DeliveryState, string>> = {
  delivery_uncertain: ' Reopen it to try again, or confirm that it was sent.',
  destination_missing: ' Choose a conversation for it first.',
};

/** Review changes a person may state. 'none' to 'requested' only happens through confirmSent, 'follow_up_sent' only through markFollowUpSent. */
const REVIEW_ALLOWED: Record<ReviewState, readonly ReviewState[]> = {
  none: ['closed'],
  requested: ['received', 'follow_up_drafted', 'closed'],
  received: ['follow_up_drafted', 'closed'],
  follow_up_drafted: ['follow_up_drafted', 'closed'],
  follow_up_sent: ['closed'],
  closed: ['received', 'closed'],
};

type Patch = Partial<{
  state: DeliveryState;
  destination_json: string | null;
  review: ReviewState;
  message: string | Uint8Array | null;
  message_sha256: string | null;
  message_chars: number | null;
  parts_json: string;
  follow_up_draft: string | null;
  attempts: number;
  last_error: string | null;
}>;

interface EventSpec {
  type: DeliveryEventType;
  actor: ActorRef;
  detail?: Record<string, unknown>;
  /** This event is the one that carries the state change of the whole update. */
  transition?: boolean;
}

interface Resolution {
  destination: FrozenDestination | null;
  /** Why there is no destination (plain words), or null. */
  reason: string | null;
  skipped: string[];
}

interface Built {
  message: string;
  sha: string;
  parts: MessagePart[];
  infos: DeliveryPartInfo[];
  reviewRequestIncluded: boolean | null;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const stateForVerification = (v: ConversationVerification): DeliveryState => (v === 'verified' ? 'ready_for_handoff' : 'destination_unverified');

function closedError(state: DeliveryState, verb: string): CoreError {
  const why = state === 'user_discarded'
    ? `This handoff was discarded, so it cannot be ${verb}. Reopen it first if you want to continue.`
    : `This handoff is already marked as sent, so it cannot be ${verb}.`;
  return conflict(why, 'delivery_closed', { state });
}

const missingDestination = (): CoreError =>
  conflict('This report has no ChatGPT conversation to go to yet. Choose a conversation for it first.', 'destination_missing');

const partRange = (index: number, total: number): CoreError =>
  badRequest(`There is no part ${index}. This message has ${total} part${total === 1 ? '' : 's'}.`, { part: index, partCount: total }, 'part_out_of_range');

function slug(text: string): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s === '' ? 'report' : s;
}

export function createDeliveriesService(deps: DeliveriesServiceDeps): DeliveriesService {
  const { db, bus, clock, log } = deps.base;
  const { native } = deps;

  // ---- rows ----------------------------------------------------------------------------------------------------
  const rowOf = (id: string): DeliveryRow | undefined => db.get<DeliveryRow>(`SELECT ${COLUMNS} FROM deliveries WHERE id = ?`, [id]);

  function rowOrThrow(id: string): DeliveryRow {
    const row = rowOf(id);
    if (!row) throw notFound('Delivery');
    return row;
  }

  function messageOf(id: string): string | null {
    const r = db.get<{ message: string | Uint8Array | null }>('SELECT message FROM deliveries WHERE id = ?', [id]);
    return r && r.message !== null ? unpackText(r.message) : null;
  }

  const parseParts = (row: DeliveryRow): DeliveryPartInfo[] => fromJson<DeliveryPartInfo[]>(row.parts_json, []);
  const destinationOf = (row: DeliveryRow): FrozenDestination | null => fromJson<FrozenDestination | null>(row.destination_json, null);

  function toDelivery(r: DeliveryRow): Delivery {
    return {
      id: r.id, reportId: r.report_id, projectId: r.project_id, projectName: r.project_name, sessionKey: r.session_key, taskTitle: r.task_title,
      state: r.state, destination: destinationOf(r), review: r.review, includeReviewRequest: bool(r.include_review_request),
      messageSha256: r.message_sha256, messageChars: r.message_chars, parts: parseParts(r), followUpDraft: r.follow_up_draft,
      attempts: r.attempts, lastError: r.last_error, stateChangedAt: r.state_changed_at, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  function toEvent(r: EventRow): DeliveryEvent {
    return {
      id: r.id, deliveryId: r.delivery_id, at: r.at, type: r.type, from: r.from_state, to: r.to_state,
      actor: fromJson<ActorRef>(r.actor_json, SYSTEM), detail: fromJson<Record<string, unknown>>(r.detail_json, {}),
    };
  }

  function insertEvent(deliveryId: string, at: string, e: { type: DeliveryEventType; from: DeliveryState | null; to: DeliveryState | null; actor: ActorRef; detail: Record<string, unknown> }): void {
    db.run(
      'INSERT INTO delivery_events (id, delivery_id, at, type, from_state, to_state, actor_json, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId('evt'), deliveryId, at, e.type, e.from, e.to, toJson(e.actor), toJson(e.detail)],
    );
  }

  /** The one place a delivery row changes: update, audit events, and (after commit) the bus event. */
  function mutate(id: string, patch: Patch, events: EventSpec[]): Delivery {
    const row = db.tx(() => {
      const current = rowOrThrow(id);
      const at = nowIso(clock);
      const sets = ['updated_at = ?'];
      const values: SqlValue[] = [at];
      if (patch.state !== undefined && patch.state !== current.state) { sets.push('state_changed_at = ?'); values.push(at); }
      for (const [column, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value as SqlValue);
      }
      db.run(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
      const next = patch.state ?? current.state;
      let running = current.state;
      for (const e of events) {
        const to = e.transition ? next : running;
        insertEvent(id, at, { type: e.type, from: running, to, actor: e.actor, detail: e.detail ?? {} });
        running = to;
      }
      return rowOrThrow(id);
    });
    const delivery = toDelivery(row);
    bus.emit({ type: 'delivery.upserted', delivery });
    return delivery;
  }

  /** Refuses with the right 409 when `row` may not take part in an operation. */
  function guard(row: DeliveryRow, op: { verb: string; allowed: readonly DeliveryState[]; needsDestination?: boolean }): void {
    if (op.allowed.includes(row.state)) {
      if (op.needsDestination && row.destination_json === null) throw missingDestination();
      return;
    }
    if (CLOSED.includes(row.state)) throw closedError(row.state, op.verb);
    if (op.needsDestination && row.destination_json === null) throw missingDestination();
    throw conflict(`This handoff is ${STATE_PHRASE[row.state]}, so it cannot be ${op.verb} now.${STATE_HINT[row.state] ?? ''}`, 'invalid_state', { state: row.state });
  }

  // ---- destinations --------------------------------------------------------------------------------------------
  function freeze(conversation: Conversation, resolvedFrom: DeliveryResolution): FrozenDestination {
    return {
      conversationId: conversation.id, url: conversation.url, title: conversation.title, chatgptConversationId: conversation.chatgptConversationId,
      resolvedFrom, verificationAtFreeze: conversation.verification, frozenAt: nowIso(clock),
    };
  }

  const describe = (d: FrozenDestination | null): Record<string, unknown> | null =>
    d && { conversationId: d.conversationId, title: d.title, url: d.url, resolvedFrom: d.resolvedFrom, verificationAtFreeze: d.verificationAtFreeze };

  /** Session binding, then the project's preferred conversation, then its only conversation. Never the focused tab. */
  function resolveAutomatic(report: { projectId: string | null; sessionKey: SessionKey }): Resolution {
    if (!report.projectId) {
      return { destination: null, reason: 'This session is not assigned to a project, so there is no conversation to send to.', skipped: [] };
    }
    const project = deps.projects.get(report.projectId);
    if (!project) return { destination: null, reason: 'The project this report belongs to no longer exists.', skipped: [] };
    const skipped: string[] = [];
    const usable = (id: string | null, source: string): Conversation | null => {
      if (!id) return null;
      const conversation = deps.projects.conversations.get(id);
      if (!conversation) { skipped.push(`${source}: the conversation no longer exists`); return null; }
      if (conversation.projectId !== project.id) { skipped.push(`${source}: the conversation belongs to another project`); return null; }
      return conversation;
    };
    const bound = usable(deps.sessions.conversationBinding(report.sessionKey), 'session_binding');
    if (bound) return { destination: freeze(bound, 'session_binding'), reason: null, skipped };
    const preferred = usable(project.preferredConversationId, 'project_preferred');
    if (preferred) return { destination: freeze(preferred, 'project_preferred'), reason: null, skipped };
    const all = deps.projects.conversations.list(project.id);
    if (all.length === 1) return { destination: freeze(all[0], 'only_conversation'), reason: null, skipped };
    const reason = all.length === 0
      ? 'No ChatGPT conversation is mapped to this project yet.'
      : `This project has ${all.length} conversations and none is the preferred one, so Mini-Summa will not guess.`;
    return { destination: null, reason, skipped };
  }

  /** What the conversation's verification is now, as long as the stored conversation still has the frozen address. */
  function currentVerification(d: FrozenDestination): ConversationVerification {
    const conversation = deps.projects.conversations.get(d.conversationId);
    return conversation && conversation.url === d.url ? conversation.verification : d.verificationAtFreeze;
  }

  function insertDelivery(args: {
    report: { id: string; projectId: string | null; projectName: string | null; sessionKey: SessionKey; taskTitle: string };
    resolution: Resolution;
    actor: ActorRef;
    autoKey: string | null;
    includeReviewRequest: boolean;
  }): Delivery {
    const { report, resolution, actor } = args;
    const id = newId('dlv');
    const at = nowIso(clock);
    const state: DeliveryState = resolution.destination ? stateForVerification(resolution.destination.verificationAtFreeze) : 'destination_missing';
    const row = db.tx(() => {
      db.run(
        `INSERT INTO deliveries (id, report_id, project_id, project_name, session_key, task_title, state, destination_json, review, include_review_request,
                                 parts_json, attempts, auto_key, state_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'report_captured', NULL, 'none', ?, '[]', 0, ?, ?, ?, ?)`,
        [id, report.id, existingProjectId(db, report.projectId), report.projectName ?? (report.projectId ? deps.projects.get(report.projectId)?.name ?? null : null),
          report.sessionKey, report.taskTitle, int(args.includeReviewRequest), args.autoKey, at, at, at],
      );
      insertEvent(id, at, { type: 'created', from: null, to: 'report_captured', actor, detail: { reportId: report.id, automatic: args.autoKey !== null, includeReviewRequest: args.includeReviewRequest } });
      db.run('UPDATE deliveries SET state = ?, destination_json = ? WHERE id = ?', [state, resolution.destination ? toJson(resolution.destination) : null, id]);
      insertEvent(id, at, {
        type: 'destination_resolved', from: 'report_captured', to: state, actor,
        detail: { destination: describe(resolution.destination), reason: resolution.reason, skipped: resolution.skipped },
      });
      return rowOrThrow(id);
    });
    const delivery = toDelivery(row);
    bus.emit({ type: 'delivery.upserted', delivery });
    return delivery;
  }

  const wantsReviewRequest = (flag: boolean): boolean => flag && deps.settings.get().review.requestTemplate.trim() !== '';

  // ---- the message ---------------------------------------------------------------------------------------------
  const maxPartChars = (): number => {
    const n = deps.settings.get().review.maxPartChars;
    return Number.isFinite(n) ? n : 12_000;
  };

  function sessionRef(row: DeliveryRow, report: Report): string {
    const view = deps.sessions.get(row.session_key);
    return [shortSessionId(row.session_key), view?.origin ?? 'origin unknown', envLabel(view?.env ?? report.env), `generation ${report.generation}`].join(', ');
  }

  /** Pure: builds the message and its parts without writing anything. */
  function build(row: DeliveryRow, reuseStored: boolean): Built {
    const stored = reuseStored ? messageOf(row.id) : null;
    let message: string;
    let reviewRequestIncluded: boolean | null = null;
    if (stored !== null) {
      message = stored;
    } else {
      const s = deps.settings.get();
      const report = deps.reports.require(row.report_id);
      reviewRequestIncluded = bool(row.include_review_request) && s.review.requestTemplate.trim() !== '';
      message = buildReportMessage({
        reportId: report.id, projectName: row.project_name ?? 'No project', taskTitle: row.task_title, sessionRef: sessionRef(row, report),
        declaredStatus: report.declaredStatus, capturedAt: report.capturedAt, body: report.body,
        reviewRequest: reviewRequestIncluded ? s.review.requestTemplate : null, includeSessionRef: s.review.includeSessionRef,
      });
    }
    const sha = sha256(message);
    const parts = splitMessage(message, row.report_id, maxPartChars());
    const old = parseParts(row);
    const sameMessage = sha === row.message_sha256;
    const infos = parts.map((p): DeliveryPartInfo => {
      const hash = sha256(p.text);
      const before = sameMessage ? old.find((o) => o.index === p.index && o.total === p.total && o.sha256 === hash) : undefined;
      return { index: p.index, total: p.total, chars: p.text.length, sha256: hash, copiedAt: before?.copiedAt ?? null };
    });
    return { message, sha, parts, infos, reviewRequestIncluded };
  }

  /** Does storing `built` change what is stored? (Copy marks follow from the hashes, so they are not compared.) */
  function differsFromStored(row: DeliveryRow, built: Built): boolean {
    const old = parseParts(row);
    return built.sha !== row.message_sha256 || old.length !== built.infos.length
      || built.infos.some((p, i) => p.index !== old[i].index || p.total !== old[i].total || p.sha256 !== old[i].sha256);
  }

  const messagePatch = (built: Built): Patch => ({
    message: packText(built.message), message_sha256: built.sha, message_chars: built.message.length, parts_json: toJson(built.infos),
  });

  const preparedEvent = (row: DeliveryRow, built: Built, actor: ActorRef): EventSpec => ({
    type: 'prepared', actor,
    detail: { sha256: built.sha, chars: built.message.length, partCount: built.parts.length, reviewRequestIncluded: built.reviewRequestIncluded, replacedEarlierMessage: row.message_sha256 !== null },
  });

  // ---- public methods ------------------------------------------------------------------------------------------
  function onReportCaptured(report: ReportSummary): Delivery {
    const existing = db.get<DeliveryRow>(`SELECT ${COLUMNS} FROM deliveries WHERE auto_key = ?`, [report.id]);
    if (existing) return toDelivery(existing);
    let resolution: Resolution;
    try {
      resolution = resolveAutomatic(report);
    } catch (err) {
      // A broken lookup must not lose the delivery: it is created without a destination and the person can choose one.
      log.error('could not resolve the destination of a new report', { report: report.id, error: reasonOf(err) });
      resolution = { destination: null, reason: 'Mini-Summa could not look up the destination. Choose a conversation for this report.', skipped: [] };
    }
    return insertDelivery({ report, resolution, actor: SYSTEM, autoKey: report.id, includeReviewRequest: wantsReviewRequest(true) });
  }

  function create(reportId: string, req: { conversationId?: string; includeReviewRequest?: boolean }, actor: ActorRef): Delivery {
    const report = deps.reports.require(reportId);
    let resolution: Resolution;
    if (req.conversationId) {
      const conversation = deps.projects.conversations.get(req.conversationId);
      if (!conversation) throw notFound('Conversation');
      resolution = { destination: freeze(conversation, 'user_selected'), reason: null, skipped: [] };
    } else {
      resolution = resolveAutomatic(report);
    }
    return insertDelivery({ report, resolution, actor, autoKey: null, includeReviewRequest: wantsReviewRequest(req.includeReviewRequest ?? true) });
  }

  function list(q: { projectId?: string; reportId?: string; open?: boolean }): Delivery[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
    if (q.reportId) { where.push('report_id = ?'); params.push(q.reportId); }
    if (q.open === true) where.push(`state NOT IN ('user_confirmed_sent', 'user_discarded')`);
    if (q.open === false) where.push(`state IN ('user_confirmed_sent', 'user_discarded')`);
    return db.all<DeliveryRow>(`SELECT ${COLUMNS} FROM deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, rowid ASC`, params).map(toDelivery);
  }

  function get(id: string): DeliveryDetail | null {
    const row = rowOf(id);
    if (!row) return null;
    const events = db.all<EventRow>('SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY at ASC, rowid ASC', [id]).map(toEvent);
    return { ...toDelivery(row), events };
  }

  function prepare(id: string, actor: ActorRef): DeliveryPrepared {
    const row = rowOrThrow(id);
    if (CLOSED.includes(row.state)) {
      const stored = messageOf(id);
      if (stored === null) throw closedError(row.state, 'prepared');
      return { delivery: toDelivery(row), message: stored, partCount: parseParts(row).length };
    }
    const built = build(row, false);
    if (!differsFromStored(row, built)) return { delivery: toDelivery(row), message: built.message, partCount: built.parts.length };
    const delivery = mutate(id, messagePatch(built), [preparedEvent(row, built, actor)]);
    return { delivery, message: built.message, partCount: built.parts.length };
  }

  function part(id: string, index: number): { index: number; total: number; text: string; sha256: string } {
    const row = rowOrThrow(id);
    const stored = messageOf(id);
    if (stored === null && CLOSED.includes(row.state)) throw closedError(row.state, 'prepared');
    // A request for a part that does not exist is refused before anything is written, even on a delivery never prepared.
    const message = stored ?? build(row, false).message;
    const parts = splitMessage(message, row.report_id, maxPartChars());
    if (!Number.isInteger(index) || index < 1 || index > parts.length) throw partRange(index, parts.length);
    if (stored === null) prepare(id, SYSTEM);
    const p = parts[index - 1];
    return { index: p.index, total: p.total, text: p.text, sha256: sha256(p.text) };
  }

  async function copy(id: string, requested: number | undefined, actor: ActorRef): Promise<{ delivery: Delivery; part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null }> {
    const first = rowOrThrow(id);
    guard(first, { verb: 'copied', allowed: COPY_FROM, needsDestination: true });
    const reuse = parseParts(first).some((p) => p.copiedAt !== null) && messageOf(id) !== null;
    const built = build(first, reuse);
    const total = built.parts.length;
    const index = requested ?? built.infos.find((p) => p.copiedAt === null)?.index ?? 1;
    if (!Number.isInteger(index) || index < 1 || index > total) throw partRange(index, total);
    const text = built.parts[index - 1].text;

    let clipboard: 'native' | 'client' = 'client';
    if (native.capabilities().clipboard) {
      try {
        await native.clipboard.writeText(text);
        clipboard = 'native';
      } catch (err) {
        throw new CoreError(502, 'clipboard_failed', `Mini-Summa could not write to the clipboard (${reasonOf(err)}). Nothing was changed, so you can try again.`);
      }
    }

    // The clipboard call is asynchronous: look at the delivery again before recording anything.
    const row = rowOrThrow(id);
    guard(row, { verb: 'copied', allowed: COPY_FROM, needsDestination: true });
    const fresh = build(row, parseParts(row).some((p) => p.copiedAt !== null) && messageOf(id) !== null);
    if (fresh.infos[index - 1]?.sha256 !== sha256(text)) {
      throw conflict('The message changed while it was being copied. Nothing was recorded. Copy it again.', 'message_changed');
    }
    const at = nowIso(clock);
    const wasCopiedAt = fresh.infos[index - 1].copiedAt;
    const infos = fresh.infos.map((p) => (p.index === index ? { ...p, copiedAt: at } : p));
    const patch: Patch = { parts_json: toJson(infos), state: 'copied', attempts: index === 1 ? row.attempts + 1 : row.attempts };
    const events: EventSpec[] = [];
    if (differsFromStored(row, fresh)) {
      Object.assign(patch, messagePatch(fresh), { parts_json: toJson(infos) });
      events.push(preparedEvent(row, fresh, actor));
    }
    events.push({
      type: 'part_copied', actor, transition: true,
      detail: { part: index, partCount: total, sha256: fresh.infos[index - 1].sha256, chars: text.length, clipboard, copiedBefore: wasCopiedAt },
    });
    const delivery = mutate(id, patch, events);
    return { delivery, part: index, partCount: total, clipboard, text: clipboard === 'client' ? text : null };
  }

  async function open(id: string, actor: ActorRef): Promise<{ delivery: Delivery; open: ChatGptOpenResult }> {
    const first = rowOrThrow(id);
    guard(first, { verb: 'opened', allowed: OPEN_FROM, needsDestination: true });
    const destination = destinationOf(first)!;
    let result: ChatGptOpenResult;
    try {
      result = await native.chatgpt.open(destination.url, { focus: true, reason: 'handoff' });
    } catch (err) {
      result = { ok: false, mode: 'none', opened: false, focused: false, verified: null, finalUrl: null, title: null, note: `ChatGPT could not be opened (${reasonOf(err)}).` };
    }

    const row = rowOrThrow(id);
    // If the delivery was closed or discarded while the page was loading, report what happened but record nothing on it.
    if (!OPEN_FROM.includes(row.state)) return { delivery: toDelivery(row), open: result };

    // Only what the host actually observed is passed on to the conversation's verification.
    let verification: ConversationVerification | null = null;
    if (result.verified === true) verification = 'verified';
    else if (result.verified === false) verification = /log ?in|sign ?in|authenticat/i.test(result.note ?? '') ? 'login_required' : 'mismatch';
    if (verification) {
      try {
        deps.projects.conversations.setVerification(destination.conversationId, verification === 'verified' ? { verification, title: result.title } : { verification });
      } catch (err) {
        log.warn('could not record the verification result', { conversation: destination.conversationId, error: reasonOf(err) });
      }
    }

    const next: DeliveryState = result.ok && (row.state === 'copied' || row.state === 'awaiting_user_send') ? 'awaiting_user_send' : row.state;
    let lastError: string | null = null;
    if (!result.ok) lastError = result.note ?? 'ChatGPT could not be opened.';
    else if (verification === 'login_required') lastError = result.note ?? 'ChatGPT is asking you to sign in.';
    else if (verification === 'mismatch') lastError = result.note ?? 'The page that opened may not be the conversation this report is meant for.';

    const events: EventSpec[] = [];
    if (result.ok) events.push({ type: 'destination_opened', actor, transition: next !== row.state, detail: { result, verification } });
    else events.push({ type: 'note', actor, detail: { action: 'open_failed', result } });
    if (verification === 'verified') events.push({ type: 'destination_verified', actor, detail: { conversationId: destination.conversationId, title: result.title } });
    const delivery = mutate(id, { state: next, last_error: lastError }, events);
    return { delivery, open: result };
  }

  async function handoff(id: string, requested: number | undefined, actor: ActorRef) {
    const copied = await copy(id, requested, actor); // a failed copy throws here, so nothing is opened
    const opened = await open(id, actor);
    return { delivery: opened.delivery, part: copied.part, partCount: copied.partCount, clipboard: copied.clipboard, text: copied.text, open: opened.open };
  }

  function confirmSent(id: string, note: string | undefined, actor: ActorRef): Delivery {
    const row = rowOrThrow(id);
    guard(row, { verb: 'marked as sent', allowed: CONFIRM_FROM, needsDestination: true });
    const parts = parseParts(row);
    return mutate(id, { state: 'user_confirmed_sent', review: bool(row.include_review_request) ? 'requested' : 'none' }, [{
      type: 'confirmed_sent', actor, transition: true,
      detail: { note: note ?? null, previousState: row.state, partsCopied: parts.filter((p) => p.copiedAt !== null).length, partCount: parts.length },
    }]);
  }

  function markUncertain(id: string, note: string | undefined, actor: ActorRef): Delivery {
    const row = rowOrThrow(id);
    guard(row, { verb: 'marked as uncertain', allowed: UNCERTAIN_FROM });
    return mutate(id, { state: 'delivery_uncertain', review: 'none' }, [{
      type: 'marked_uncertain', actor, transition: true, detail: { note: note ?? null, previousState: row.state, previousReview: row.review },
    }]);
  }

  function discard(id: string, note: string | undefined, actor: ActorRef): Delivery {
    const row = rowOrThrow(id);
    guard(row, { verb: 'discarded', allowed: DISCARD_FROM });
    return mutate(id, { state: 'user_discarded' }, [{ type: 'discarded', actor, transition: true, detail: { note: note ?? null, previousState: row.state } }]);
  }

  function reopen(id: string, note: string | undefined, actor: ActorRef): Delivery {
    const row = rowOrThrow(id);
    guard(row, { verb: 'reopened', allowed: REOPEN_FROM });
    const destination = destinationOf(row);
    const state: DeliveryState = destination ? stateForVerification(currentVerification(destination)) : 'destination_missing';
    const parts = parseParts(row).map((p) => ({ ...p, copiedAt: null }));
    return mutate(id, { state, attempts: row.attempts + 1, last_error: null, parts_json: toJson(parts) }, [{
      type: 'reopened', actor, transition: true, detail: { note: note ?? null, previousState: row.state },
    }]);
  }

  function setDestination(id: string, conversationId: string, actor: ActorRef): Delivery {
    const row = rowOrThrow(id);
    guard(row, { verb: 'pointed at another conversation', allowed: DESTINATION_CHANGE_FROM });
    const conversation = deps.projects.conversations.get(conversationId);
    if (!conversation) throw notFound('Conversation');
    const destination = freeze(conversation, 'user_selected');
    const parts = parseParts(row).map((p) => ({ ...p, copiedAt: null }));
    return mutate(id, {
      state: stateForVerification(destination.verificationAtFreeze), destination_json: toJson(destination), parts_json: toJson(parts), last_error: null,
    }, [{
      type: 'destination_changed', actor, transition: true,
      detail: { from: describe(destinationOf(row)), to: describe(destination), previousState: row.state, otherProject: conversation.projectId !== row.project_id },
    }]);
  }

  function setReview(id: string, review: ReviewState, followUpDraft: string | null | undefined, actor: ActorRef): Delivery {
    const row = rowOrThrow(id);
    if (!REVIEW_ALLOWED[row.review].includes(review)) {
      throw conflict(
        review === 'requested' ? 'The review is requested when you confirm the message was sent, not here.'
          : review === 'follow_up_sent' ? 'A follow-up counts as sent only when it has been typed into Claude from Mini-Summa.'
            : `The review cannot change from "${row.review}" to "${review}".`,
        'invalid_review_transition', { from: row.review, to: review },
      );
    }
    if (review === 'closed' && row.review === 'closed') return toDelivery(row); // already closed: nothing to record
    if (review === 'follow_up_drafted') {
      if (typeof followUpDraft !== 'string' || followUpDraft.trim() === '') {
        throw badRequest('Write the follow-up text before saving it as a draft.', undefined, 'follow_up_draft_required');
      }
      return mutate(id, { review, follow_up_draft: followUpDraft }, [{
        type: 'follow_up_drafted', actor, detail: { from: row.review, to: review, chars: followUpDraft.length, sha256: sha256(followUpDraft) },
      }]);
    }
    return mutate(id, { review }, [{ type: 'review_changed', actor, detail: { from: row.review, to: review } }]);
  }

  function markFollowUpSent(deliveryId: string, actionId: string): Delivery | null {
    const row = rowOf(deliveryId);
    if (!row) return null;
    if (row.review !== 'follow_up_drafted') {
      if (row.review === 'follow_up_sent') return toDelivery(row);
      // A prompt linked to this delivery was typed, but no follow-up draft was waiting: note it, change nothing else.
      return mutate(deliveryId, {}, [{ type: 'note', actor: SYSTEM, detail: { action: 'prompt_typed', actionId, review: row.review } }]);
    }
    return mutate(deliveryId, { review: 'follow_up_sent' }, [{ type: 'review_changed', actor: SYSTEM, detail: { from: row.review, to: 'follow_up_sent', actionId } }]);
  }

  async function saveFile(id: string, actor: ActorRef): Promise<{ delivery: Delivery; path: string | null }> {
    const row = rowOrThrow(id);
    let message = messageOf(id);
    if (message === null) {
      if (CLOSED.includes(row.state)) {
        message = build(row, false).message; // for the file only; a closed delivery's record is not rewritten
      } else {
        message = prepare(id, actor).message;
      }
    }
    const short = row.report_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8);
    let saved: { path: string | null };
    try {
      saved = await native.saveTextFile({ suggestedName: `report-${slug(row.task_title)}-${short}.md`, text: message });
    } catch (err) {
      throw new CoreError(502, 'save_failed', `Mini-Summa could not save the file (${reasonOf(err)}).`);
    }
    if (saved.path === null) return { delivery: toDelivery(rowOrThrow(id)), path: null };
    return { delivery: mutate(id, {}, [{ type: 'note', actor, detail: { action: 'saved_file', path: saved.path } }]), path: saved.path };
  }

  function recoverAfterRestart(): void {
    const at = nowIso(clock);
    const rows = db.all<{ id: string; state: DeliveryState }>(`SELECT id, state FROM deliveries WHERE state IN ('copied', 'awaiting_user_send')`);
    // Only a note: the delivery is left exactly where the person left it (no state, timestamp or event emission changes).
    for (const r of rows) {
      insertEvent(r.id, at, { type: 'note', from: r.state, to: r.state, actor: SYSTEM, detail: { note: 'Mini-Summa restarted while this was waiting' } });
    }
  }

  function prune(olderThanIso: string): number {
    return db.run(`DELETE FROM deliveries WHERE state IN ('user_confirmed_sent', 'user_discarded') AND updated_at < ?`, [olderThanIso]).changes;
  }

  return {
    onReportCaptured, list, get, create, prepare, part, copy, open, handoff, confirmSent, markUncertain, discard, reopen,
    setDestination, setReview, saveFile, markFollowUpSent, recoverAfterRestart, prune,
  };
}
