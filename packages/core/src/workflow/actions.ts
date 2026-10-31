// ActionsService: the human approval boundary for typing into Claude.
//
// Text reaches a Claude session only through a PendingAction whose target is re-verified at the moment of execution:
// a managed session, live, the same generation, in a state that accepts input. A click on the desktop is itself the
// approval. A prompt from another device waits for approval unless that device is trusted. Execution is attempted once;
// a failure is recorded as `failed` and never retried by Mini-Summa.
//
// Contract notes:
//  * Feed entries recorded here: `action_result` (id actres_<id>) when an action ends (sent, failed, rejected, expired),
//    linked to project, session, report and delivery but deliberately NOT to the action itself, because the glue resolves
//    everything linked to an action as soon as it leaves "pending" and a failure must stay open. For permission requests
//    `raisePermission` records an `action_pending` entry (id act_<id>) unless `recordPermissionActivity` is false; the
//    orchestrator already records a needs_permission entry for the same moment, so pass false to avoid two lines.
//    The "prompt waiting for approval" entry of a device prompt is the glue's (it uses the same id scheme), not recorded here.
//  * A failed action's entry has requiresAction and stays open until the person reads it: ActivityService.markRead
//    acknowledges open `error` and `action_result` entries.
//  * reject() is synchronous in the contract. For a permission request it also answers "no" in the terminal through
//    sessions.answerPermission, in the background and only if the session is still waiting for permission; if that
//    fails an error entry is recorded. Rejecting a prompt types nothing.
//  * Prompts from a device are always submitted (`submit: false` is a desktop-only option and is refused for devices),
//    because a waiting action has nowhere to remember it.
//  * A system actor can neither create nor decide anything (403 actor_not_allowed): only a person may authorize typing.
//  * Approve what you see: only the newest permission request of a session can be answered. Raising a request
//    supersedes every other open one of that session; approve and reject check `sessions.currentPermission` first and,
//    if the request is not the open one, mark it `superseded` and refuse with 409 `permission_changed`. The request's
//    key is passed to `answerPermission` as `expectRequestKey`, so the session layer refuses it too.
//  * Links: a prompt from a non-desktop actor never keeps a report or delivery id (they are dropped). For the desktop the
//    ids must exist (404) and the delivery must belong to the target session's project (422 `delivery_project_mismatch`).
//    A delivery's follow-up counts as sent only when the typed text equals its stored draft exactly and the target is
//    the delivery's own session. Without the `deliveries` / `reports` deps ids cannot be checked and are dropped.
//  * A removed or revoked device (bus `device.upserted` with revokedAt, or `device.removed`) loses its pending prompts:
//    they are rejected with "The device that asked was removed." and approving one refuses with 409 `device_revoked`.
//  * Non-desktop actors cannot send text that starts with ! or / (422 `command_not_allowed`), also after invisible
//    characters: that is a Claude Code command, not a prompt.
//  * list defaults to status 'open' (pending or approved but not finished) and returns at most 500 rows.
import type { ActorRef, LinkTarget, PendingAction, PendingActionKind, PendingActionStatus, ServerEvent, SessionKey, SessionState, TargetCheck } from '@minisumma/shared';
import { shortSessionId } from '@minisumma/shared';
import type { SqlValue } from '@minisumma/storage';
import { fromJson, newId, toJson } from '@minisumma/storage';
import type {
  ActionsService, ActivityInput, ActivityService, CoreBase, DeliveriesService, DevicesService, ReportsService, SessionsService, SettingsService, TypeIntoResult,
} from '../contracts.ts';
import { nowIso } from '../contracts.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { addMinutes, clampInt, existingProjectId, firstLine, isUniqueViolation, placeholders } from './util.ts';

export interface ActionsServiceDeps {
  base: CoreBase;
  settings: Pick<SettingsService, 'get'>;
  sessions: Pick<SessionsService, 'get' | 'targetCheck' | 'typeInto' | 'answerPermission' | 'currentPermission'>;
  activity: Pick<ActivityService, 'record' | 'resolve'>;
  /** To know whether a device is trusted, and whether the device that asked is still there. Without it no device is trusted. */
  devices?: Pick<DevicesService, 'get'>;
  /** To check a delivery a desktop prompt names, and to mark its follow-up as sent. */
  deliveries?: Pick<DeliveriesService, 'get' | 'markFollowUpSent'>;
  /** To check a report a desktop prompt names. */
  reports?: Pick<ReportsService, 'summary'>;
  /** Record an `action_pending` feed entry for each permission request. Default true. */
  recordPermissionActivity?: boolean;
}

interface ActionRow {
  id: string;
  kind: PendingActionKind;
  status: PendingActionStatus;
  project_id: string | null;
  session_key: SessionKey;
  generation: number;
  text: string | null;
  summary: string;
  report_id: string | null;
  delivery_id: string | null;
  created_at: string;
  created_by_json: string;
  approvable_by: PendingAction['approvableBy'];
  decided_at: string | null;
  decided_by_json: string | null;
  executed_at: string | null;
  failure: string | null;
  expires_at: string;
  correlation_key: string | null;
}

const SYSTEM: ActorRef = { kind: 'system' };
const ACCEPTS_INPUT: SessionState[] = ['idle', 'waiting_for_you', 'turn_ended', 'report_ready'];
const SWEEP_MS = 30_000;
const LIST_CAP = 500;

const EXTERNAL_HINT = 'Mini-Summa only observes sessions it did not start, so it never types into them. Remote Control can control this session from the Claude app.';
const COMMAND_NOT_ALLOWED = 'Text that starts with ! or / is a Claude Code command, not a prompt, and cannot be sent from a phone.';
const PERMISSION_CHANGED = 'That request is no longer the one that is open. Look at the terminal.';
const DEVICE_REMOVED = 'The device that asked was removed.';

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sentence = (text: string): string => text.trim().replace(/[.!?]*$/, '.');

// Characters that show nothing in front of the first real one: whitespace, control and format characters (byte order
// mark, zero-width space and joiners, bidi marks, soft hyphen, tag characters) and other separators.
const INVISIBLE_PREFIX = /^[\s\p{Cc}\p{Cf}\p{Z}]+/u;

/** Would Claude Code read this text as a slash command or as a shell command (`!`) rather than as a prompt? */
function startsLikeCommand(text: string): boolean {
  const first = text.replace(INVISIBLE_PREFIX, '').charAt(0);
  return first === '!' || first === '/';
}

function targetProblem(check: TargetCheck): { code: string; message: string } | null {
  if (!check.managed) {
    const problem = check.problem?.trim() ?? '';
    const message = problem === '' ? `This session was not started by Mini-Summa. ${EXTERNAL_HINT}`
      : /remote control/i.test(problem) ? problem : `${sentence(problem)} ${EXTERNAL_HINT}`;
    return { code: 'target_not_managed', message };
  }
  if (!check.live) return { code: 'target_not_live', message: check.problem ?? 'This session is not running right now, so nothing can be typed into it.' };
  if (!check.generationMatches) return { code: 'target_generation_changed', message: check.problem ?? 'This session was restarted since the request was made, so nothing was typed.' };
  if (check.problem) return { code: 'target_unavailable', message: check.problem };
  return null;
}

export function createActionsService(deps: ActionsServiceDeps): ActionsService {
  const { db, bus, clock, log } = deps.base;
  const { sessions } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  // ---- rows and views ------------------------------------------------------------------------------------------
  const rowOf = (id: string): ActionRow | undefined => db.get<ActionRow>('SELECT * FROM pending_actions WHERE id = ?', [id]);

  function rowOrThrow(id: string): ActionRow {
    const row = rowOf(id);
    if (!row) throw notFound('Action');
    return row;
  }

  function checkOf(key: SessionKey, generation: number | null): TargetCheck {
    try {
      return sessions.targetCheck(key, generation);
    } catch (err) {
      return { managed: false, live: false, generation: null, generationMatches: false, state: null, problem: `Mini-Summa could not check this session (${reasonOf(err)}).` };
    }
  }

  const projectNameOf = (id: string | null): string | null => (id ? db.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', [id])?.name ?? null : null);

  function toAction(r: ActionRow): PendingAction {
    return {
      id: r.id, kind: r.kind, status: r.status, projectId: r.project_id, projectName: projectNameOf(r.project_id), sessionKey: r.session_key,
      generation: r.generation, text: r.text, summary: r.summary, reportId: r.report_id, deliveryId: r.delivery_id, createdAt: r.created_at,
      createdBy: fromJson<ActorRef>(r.created_by_json, SYSTEM), approvableBy: r.approvable_by, decidedAt: r.decided_at,
      decidedBy: fromJson<ActorRef | null>(r.decided_by_json, null), executedAt: r.executed_at, failure: r.failure, expiresAt: r.expires_at,
      target: checkOf(r.session_key, r.generation),
    };
  }

  const announce = (row: ActionRow): PendingAction => {
    const action = toAction(row);
    bus.emit({ type: 'action.upserted', action });
    return action;
  };

  /** Moves an action from one of `from` to `to` in a single guarded UPDATE; null when it was not in such a state. */
  function move(id: string, from: PendingActionStatus[], to: PendingActionStatus, fields: { decidedAt?: string; decidedBy?: ActorRef; executedAt?: string; failure?: string } = {}): ActionRow | null {
    const sets = ['status = ?'];
    const values: SqlValue[] = [to];
    if (fields.decidedAt !== undefined) { sets.push('decided_at = ?'); values.push(fields.decidedAt); }
    if (fields.decidedBy !== undefined) { sets.push('decided_by_json = ?'); values.push(toJson(fields.decidedBy)); }
    if (fields.executedAt !== undefined) { sets.push('executed_at = ?'); values.push(fields.executedAt); }
    if (fields.failure !== undefined) { sets.push('failure = ?'); values.push(fields.failure); }
    const res = db.run(`UPDATE pending_actions SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(from.length)})`, [...values, id, ...from]);
    return res.changes === 1 ? rowOrThrow(id) : null;
  }

  // ---- feed ----------------------------------------------------------------------------------------------------
  function safely(what: string, fn: () => void): void {
    try { fn(); } catch (err) { log.error(`could not ${what}`, { error: reasonOf(err) }); }
  }

  const labelOf = (r: ActionRow): string => `${projectNameOf(r.project_id) ?? 'No project'} / ${shortSessionId(r.session_key)}`;

  function linksOf(r: ActionRow, withAction: boolean): LinkTarget[] {
    const links: LinkTarget[] = [];
    if (r.project_id) links.push({ kind: 'project', id: r.project_id });
    links.push({ kind: 'session', key: r.session_key });
    if (r.report_id) links.push({ kind: 'report', id: r.report_id });
    if (r.delivery_id) links.push({ kind: 'delivery', id: r.delivery_id });
    if (withAction) links.push({ kind: 'action', id: r.id });
    return links;
  }

  function record(input: ActivityInput): void {
    safely('record an activity entry', () => { deps.activity.record(input); });
  }

  function recordResult(r: ActionRow, outcome: 'executed' | 'failed' | 'rejected' | 'expired', note?: string): void {
    const label = labelOf(r);
    const permission = r.kind === 'permission';
    const base = { id: `actres_${r.id}`, at: nowIso(clock), projectId: r.project_id, projectName: projectNameOf(r.project_id), source: 'action' as const, sessionKey: r.session_key, type: 'action_result' as const, links: linksOf(r, false) };
    switch (outcome) {
      case 'executed':
        record({ ...base, severity: 'info', title: permission ? `Permission approved in ${label}` : `Prompt sent to ${label}`,
          description: permission ? 'Mini-Summa answered the permission prompt in the Claude terminal.' : 'Mini-Summa typed the prompt into the Claude terminal.' });
        break;
      case 'failed':
        record({ ...base, severity: 'error', requiresAction: true, title: permission ? `Could not answer the permission prompt in ${label}` : `Could not send the prompt to ${label}`,
          description: `${sentence(note ?? 'It did not work.')} Mini-Summa does not retry on its own. ${permission ? 'Answer it in the terminal.' : 'You can send it again.'}` });
        break;
      case 'rejected':
        record({ ...base, severity: 'info', title: permission ? `Permission rejected in ${label}` : `Prompt to ${label} was rejected`,
          description: `${note ? sentence(note) : 'Rejected.'} ${permission ? 'Mini-Summa is answering no in the terminal.' : 'Nothing was typed.'}` });
        break;
      case 'expired':
        record({ ...base, severity: 'attention', title: permission ? `Permission request in ${label} expired` : `Prompt to ${label} expired without approval`,
          description: permission ? 'Nobody answered it in Mini-Summa in time. It may still be waiting in the terminal.' : 'Nobody approved it in time, so nothing was typed.' });
        break;
    }
  }

  const resolveEntry = (id: string): void => safely('resolve an activity entry', () => { deps.activity.resolve({ ids: [`act_${id}`] }); });

  // ---- execution -----------------------------------------------------------------------------------------------
  function succeed(id: string): PendingAction {
    const row = move(id, ['approved'], 'executed', { executedAt: nowIso(clock) });
    if (!row) return toAction(rowOrThrow(id));
    const action = announce(row);
    recordResult(row, 'executed');
    const deliveries = deps.deliveries;
    if (row.kind === 'claude_prompt' && row.delivery_id && row.text !== null && deliveries) {
      safely('mark the follow-up as sent', () => {
        const delivery = deliveries.get(row.delivery_id!);
        // Only the exact text that was drafted, typed into the very session the report came from, is "the follow-up sent".
        // A prompt that merely names a delivery proves nothing about its review.
        if (delivery && delivery.followUpDraft !== null && delivery.followUpDraft === row.text && delivery.sessionKey === row.session_key) {
          deliveries.markFollowUpSent(delivery.id, row.id);
        }
      });
    }
    return action;
  }

  function fail(id: string, why: string): PendingAction {
    const row = move(id, ['approved'], 'failed', { failure: why });
    if (!row) return toAction(rowOrThrow(id));
    const action = announce(row);
    recordResult(row, 'failed', why);
    return action;
  }

  async function executePrompt(id: string, submit: boolean): Promise<PendingAction> {
    const row = rowOrThrow(id);
    const problem = targetProblem(checkOf(row.session_key, row.generation));
    if (problem) return fail(id, problem.message);
    let result: TypeIntoResult;
    try {
      result = await sessions.typeInto(row.session_key, { text: row.text ?? '', submit, expectGeneration: row.generation, allowedStates: [...ACCEPTS_INPUT] });
    } catch (err) {
      return fail(id, `Typing failed unexpectedly (${reasonOf(err)}). Look at the terminal to see whether anything arrived.`);
    }
    return result.ok ? succeed(id) : fail(id, result.problem);
  }

  async function executePermission(id: string): Promise<PendingAction> {
    const row = rowOrThrow(id);
    const check = checkOf(row.session_key, row.generation);
    const problem = targetProblem(check);
    if (problem) return fail(id, problem.message);
    if (check.state !== null && check.state !== 'needs_permission') {
      // The question is gone (answered at the terminal, or Claude moved on): nothing to answer.
      const moved = move(id, ['approved'], 'superseded', { decidedAt: nowIso(clock), decidedBy: SYSTEM });
      if (!moved) return toAction(rowOrThrow(id));
      resolveEntry(id);
      return announce(moved);
    }
    let result: TypeIntoResult;
    try {
      // The request key travels with the answer: the session layer refuses it if another dialog is open by now.
      result = await sessions.answerPermission(row.session_key, 'approve', row.generation, row.correlation_key ?? undefined);
    } catch (err) {
      return fail(id, `Answering failed unexpectedly (${reasonOf(err)}). Look at the terminal.`);
    }
    return result.ok ? succeed(id) : fail(id, result.problem);
  }

  /**
   * Approve what you see: only the request that is open right now may be answered. If this action is not that one,
   * it becomes `superseded` and the call is refused, so a click on an old item can never answer a newer dialog.
   */
  function requireOpenRequest(row: ActionRow): void {
    let current: { correlationKey: string } | null = null;
    try {
      current = sessions.currentPermission(row.session_key);
    } catch (err) {
      log.warn('could not read the open permission request; treating it as changed', { session: row.session_key, error: reasonOf(err) });
    }
    if (current !== null && current.correlationKey === row.correlation_key) return;
    const moved = move(row.id, ['pending'], 'superseded', { decidedAt: nowIso(clock), decidedBy: SYSTEM });
    if (moved) {
      announce(moved);
      resolveEntry(row.id);
    }
    throw conflict(PERMISSION_CHANGED, 'permission_changed');
  }

  /** The person said no to a permission request: tell Claude so, in the background, only if it is still asking. */
  function denyInTerminal(row: ActionRow): void {
    const failed = (why: string): void => {
      record({
        id: `actdeny_${row.id}`, at: nowIso(clock), projectId: row.project_id, projectName: projectNameOf(row.project_id), source: 'action',
        sessionKey: row.session_key, type: 'action_result', severity: 'error', requiresAction: true,
        title: `Could not answer no in ${labelOf(row)}`, description: `${sentence(why)} Answer the permission prompt in the terminal yourself.`, links: linksOf(row, false),
      });
    };
    void (async () => {
      try {
        const check = checkOf(row.session_key, row.generation);
        if (targetProblem(check) || (check.state !== null && check.state !== 'needs_permission')) return;
        const result = await sessions.answerPermission(row.session_key, 'reject', row.generation, row.correlation_key ?? undefined);
        if (!result.ok) failed(result.problem);
      } catch (err) {
        failed(`Answering failed unexpectedly (${reasonOf(err)}).`);
      }
    })();
  }

  // ---- who may do what -----------------------------------------------------------------------------------------
  function isTrusted(actor: ActorRef): boolean {
    if (actor.kind !== 'device' || !deps.devices) return false;
    const device = deps.devices.get(actor.deviceId);
    return Boolean(device && device.trusted && !device.revokedAt);
  }

  function refuseSystem(actor: ActorRef): void {
    if (actor.kind === 'system') throw forbidden('Only a person can decide whether text is typed into Claude.', 'actor_not_allowed');
  }

  const ttlMinutes = (): number => clampInt(deps.settings.get().mobile.promptActionTtlMinutes, 1, 1440, 60);

  /**
   * The report and delivery a prompt may be linked to. Anyone but the desktop cannot link anything: their ids are dropped,
   * so an unrelated prompt can never touch someone else's review. The desktop's ids must exist, and the delivery must
   * belong to the target session's project.
   */
  function checkedLinks(input: Parameters<ActionsService['createPrompt']>[0], projectId: string | null): { reportId: string | null; deliveryId: string | null } {
    const none = { reportId: null, deliveryId: null };
    if (input.actor.kind !== 'desktop') return none;
    let deliveryId: string | null = null;
    let reportId: string | null = null;
    if (input.deliveryId !== undefined) {
      if (!deps.deliveries) {
        log.warn('a delivery id was dropped because deliveries cannot be checked here', { delivery: input.deliveryId });
      } else {
        const delivery = deps.deliveries.get(input.deliveryId);
        if (!delivery) throw notFound('Delivery');
        // A delivery of a project-less report may only be linked to the very session it came from.
        if (delivery.projectId !== projectId || (projectId === null && delivery.sessionKey !== input.sessionKey)) {
          throw unprocessable('That handoff belongs to another project, so it cannot be linked to a prompt for this session.', 'delivery_project_mismatch');
        }
        deliveryId = delivery.id;
      }
    }
    if (input.reportId !== undefined) {
      if (!deps.reports) {
        log.warn('a report id was dropped because reports cannot be checked here', { report: input.reportId });
      } else {
        if (!deps.reports.summary(input.reportId)) throw notFound('Report');
        reportId = input.reportId;
      }
    }
    return { reportId, deliveryId };
  }

  // ---- public methods ------------------------------------------------------------------------------------------
  async function createPrompt(input: Parameters<ActionsService['createPrompt']>[0]): Promise<PendingAction> {
    const { actor, sessionKey } = input;
    refuseSystem(actor);
    if (typeof input.text !== 'string' || input.text.trim() === '') throw badRequest('Write something to send first.', undefined, 'empty_prompt');
    if (actor.kind !== 'desktop' && startsLikeCommand(input.text)) throw unprocessable(COMMAND_NOT_ALLOWED, 'command_not_allowed');
    if (actor.kind === 'device' && input.submit === false) {
      throw badRequest('A prompt from another device is always submitted. Typing without pressing Enter is only available on the desktop.', undefined, 'submit_not_allowed');
    }

    const view = sessions.get(sessionKey);
    const expected = input.expectGeneration ?? view?.generation ?? null;
    const check = checkOf(sessionKey, expected);
    const problem = targetProblem(check);
    if (problem) throw unprocessable(problem.message, problem.code, { target: check });
    const generation = expected ?? check.generation ?? view?.generation ?? 0;
    const links = checkedLinks(input, view?.projectId ?? null);

    const now = nowIso(clock);
    const immediate = actor.kind === 'desktop' || isTrusted(actor);
    const id = newId('act');
    db.run(
      `INSERT INTO pending_actions (id, kind, status, project_id, session_key, generation, text, summary, report_id, delivery_id, created_at,
                                    created_by_json, approvable_by, decided_at, decided_by_json, executed_at, failure, expires_at, correlation_key)
       VALUES (?, 'claude_prompt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      [id, immediate ? 'approved' : 'pending', existingProjectId(db, view?.projectId), sessionKey, generation, input.text, firstLine(input.text, 160),
        links.reportId, links.deliveryId, now, toJson(actor), actor.kind === 'desktop' ? 'desktop' : 'desktop_or_other_device',
        immediate ? now : null, immediate ? toJson(actor) : null, addMinutes(now, ttlMinutes())],
    );
    const created = announce(rowOrThrow(id));
    return immediate ? executePrompt(id, input.submit ?? true) : created;
  }

  function raisePermission(input: Parameters<ActionsService['raisePermission']>[0]): PendingAction | null {
    const known = db.get<ActionRow>('SELECT * FROM pending_actions WHERE correlation_key = ?', [input.correlationKey]);
    if (known) return toAction(known);
    const check = checkOf(input.sessionKey, input.generation);
    if (!check.managed || !check.live || !check.generationMatches) return null;

    const now = nowIso(clock);
    const id = newId('act');
    const projectId = existingProjectId(db, input.projectId ?? sessions.get(input.sessionKey)?.projectId);
    const older: ActionRow[] = [];
    try {
      db.tx(() => {
        // Only the newest request of a session is the one on screen. Every other open one stops being answerable now,
        // in the same step that makes the new one exist.
        const open = db.all<ActionRow>(
          `SELECT * FROM pending_actions WHERE session_key = ? AND kind = 'permission' AND status = 'pending' AND correlation_key IS NOT ?
           ORDER BY created_at, rowid`,
          [input.sessionKey, input.correlationKey],
        );
        for (const o of open) {
          const moved = move(o.id, ['pending'], 'superseded', { decidedAt: now, decidedBy: SYSTEM });
          if (moved) older.push(moved);
        }
        db.run(
          `INSERT INTO pending_actions (id, kind, status, project_id, session_key, generation, text, summary, report_id, delivery_id, created_at,
                                        created_by_json, approvable_by, decided_at, decided_by_json, executed_at, failure, expires_at, correlation_key)
           VALUES (?, 'permission', 'pending', ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, 'any_approver', NULL, NULL, NULL, NULL, ?, ?)`,
          [id, projectId, input.sessionKey, input.generation, input.summary.trim() === '' ? 'Permission requested' : input.summary.trim(), now,
            toJson(SYSTEM), addMinutes(now, ttlMinutes()), input.correlationKey],
        );
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = db.get<ActionRow>('SELECT * FROM pending_actions WHERE correlation_key = ?', [input.correlationKey]);
      if (raced) return toAction(raced);
      throw err;
    }
    for (const o of older) {
      announce(o);
      resolveEntry(o.id);
    }
    const row = rowOrThrow(id);
    const action = announce(row);
    if (deps.recordPermissionActivity !== false) {
      record({
        id: `act_${id}`, at: now, projectId, projectName: projectNameOf(projectId), source: 'action', sessionKey: input.sessionKey, type: 'action_pending',
        severity: 'attention', requiresAction: true, title: `Permission needed in ${labelOf(row)}`, description: row.summary, links: linksOf(row, true),
      });
    }
    return action;
  }

  function supersedeOpenFor(sessionKey: SessionKey, _reason: string): void {
    const open = db.all<ActionRow>(`SELECT * FROM pending_actions WHERE session_key = ? AND kind = 'permission' AND status = 'pending' ORDER BY created_at, rowid`, [sessionKey]);
    for (const row of open) {
      const moved = move(row.id, ['pending'], 'superseded', { decidedAt: nowIso(clock), decidedBy: SYSTEM });
      if (!moved) continue;
      announce(moved);
      resolveEntry(row.id);
    }
  }

  async function approve(id: string, actor: ActorRef): Promise<PendingAction> {
    const row = rowOrThrow(id);
    refuseSystem(actor);
    if (row.status !== 'pending') throw conflict(`This request is already ${row.status}, so it cannot be approved.`, 'action_not_pending', { status: row.status });
    if (row.approvable_by === 'desktop' && actor.kind !== 'desktop') throw forbidden('Only the desktop can approve this.', 'desktop_only');
    if (row.kind === 'claude_prompt' && actor.kind === 'device') {
      const creator = fromJson<ActorRef>(row.created_by_json, SYSTEM);
      if (creator.kind === 'device' && creator.deviceId === actor.deviceId && !isTrusted(actor)) {
        throw forbidden('A device cannot approve its own prompt. Approve it on the desktop or from another device.', 'self_approval');
      }
    }
    if (creatorRemoved(row)) {
      rejectRemoved(row);
      throw conflict('The device that asked was removed, so nothing was typed.', 'device_revoked');
    }
    if (row.expires_at <= nowIso(clock)) {
      expireRow(row);
      throw conflict('This request has expired, so nothing was typed. Send it again if you still want it.', 'action_expired');
    }
    if (row.kind === 'permission') requireOpenRequest(row);
    const claimed = move(id, ['pending'], 'approved', { decidedAt: nowIso(clock), decidedBy: actor });
    if (!claimed) throw conflict('This request was just decided by someone else.', 'action_not_pending');
    announce(claimed);
    resolveEntry(id);
    return claimed.kind === 'permission' ? executePermission(id) : executePrompt(id, true);
  }

  function reject(id: string, actor: ActorRef, reason?: string): PendingAction {
    const row = rowOrThrow(id);
    refuseSystem(actor);
    if (row.status !== 'pending') throw conflict(`This request is already ${row.status}, so it cannot be rejected.`, 'action_not_pending', { status: row.status });
    if (row.approvable_by === 'desktop' && actor.kind !== 'desktop') throw forbidden('Only the desktop can reject this.', 'desktop_only');
    if (row.kind === 'permission') requireOpenRequest(row); // "no" is an answer too: it must go to the dialog the person saw
    const moved = move(id, ['pending'], 'rejected', { decidedAt: nowIso(clock), decidedBy: actor });
    if (!moved) throw conflict('This request was just decided by someone else.', 'action_not_pending');
    const action = announce(moved);
    resolveEntry(id);
    recordResult(moved, 'rejected', reason?.trim() || undefined);
    if (moved.kind === 'permission') denyInTerminal(moved);
    return action;
  }

  function expireRow(row: ActionRow): boolean {
    const moved = move(row.id, ['pending'], 'expired');
    if (!moved) return false;
    announce(moved);
    resolveEntry(row.id);
    recordResult(moved, 'expired');
    return true;
  }

  // ---- devices that go away ------------------------------------------------------------------------------------
  /** Was this action asked for by a device that is revoked, or no longer known? Without a device list nothing can be said. */
  function creatorRemoved(row: ActionRow): boolean {
    if (!deps.devices) return false;
    const creator = fromJson<ActorRef>(row.created_by_json, SYSTEM);
    if (creator.kind !== 'device') return false;
    const device = deps.devices.get(creator.deviceId);
    return !device || Boolean(device.revokedAt);
  }

  function rejectRemoved(row: ActionRow): boolean {
    const moved = move(row.id, ['pending'], 'rejected', { decidedAt: nowIso(clock), decidedBy: SYSTEM, failure: DEVICE_REMOVED });
    if (!moved) return false;
    announce(moved);
    resolveEntry(row.id);
    recordResult(moved, 'rejected', DEVICE_REMOVED);
    return true;
  }

  /** Everything a removed device was still waiting to get approved is rejected: nobody is left to stand behind it. */
  function dropPendingOf(deviceId: string): number {
    const rows = db.all<ActionRow>(
      `SELECT * FROM pending_actions WHERE status = 'pending' AND json_extract(created_by_json, '$.kind') = 'device' AND json_extract(created_by_json, '$.deviceId') = ?
       ORDER BY created_at, rowid`,
      [deviceId],
    );
    let dropped = 0;
    for (const row of rows) if (rejectRemoved(row)) dropped++;
    return dropped;
  }

  const onBusEvent = (_seq: number, event: ServerEvent): void => {
    if (event.type === 'device.upserted' && event.device.revokedAt) safely('drop the prompts of a revoked device', () => { dropPendingOf(event.device.id); });
    else if (event.type === 'device.removed') safely('drop the prompts of a removed device', () => { dropPendingOf(event.id); });
  };
  let unsubscribe: (() => void) | null = bus.subscribe(onBusEvent);

  function expireDue(): number {
    const due = db.all<ActionRow>(`SELECT * FROM pending_actions WHERE status = 'pending' AND expires_at <= ?`, [nowIso(clock)]);
    let expired = 0;
    for (const row of due) if (expireRow(row)) expired++;
    return expired;
  }

  /** An action left "approved" by a previous run was interrupted: nobody will finish it, and nothing is retried. */
  function settleInterrupted(): void {
    for (const row of db.all<ActionRow>(`SELECT * FROM pending_actions WHERE status = 'approved'`)) {
      fail(row.id, 'Mini-Summa stopped before this finished. Look at the terminal to see whether it arrived.');
    }
  }

  function list(q: { status?: 'pending' | 'open' | 'all'; projectId?: string }): PendingAction[] {
    const status = q.status ?? 'open';
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (status === 'pending') where.push(`status = 'pending'`);
    else if (status === 'open') where.push(`status IN ('pending', 'approved')`);
    if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
    return db.all<ActionRow>(
      `SELECT * FROM pending_actions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ${LIST_CAP}`, params,
    ).map(toAction);
  }

  return {
    createPrompt,
    raisePermission,
    supersedeOpenFor,
    approve,
    reject,
    list,
    get: (id) => { const row = rowOf(id); return row ? toAction(row) : null; },
    expireDue,
    init() {
      if (!unsubscribe) unsubscribe = bus.subscribe(onBusEvent); // after a shutdown
      if (timer) return;
      safely('settle interrupted actions', settleInterrupted);
      safely('expire overdue actions', () => { expireDue(); });
      timer = setInterval(() => { safely('expire overdue actions', () => { expireDue(); }); }, SWEEP_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    shutdown() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
