// The glue between the Claude layer and the workflow services.
//
// Everything that turns "something happened in a Claude session" into feed entries, notifications, reports, deliveries
// and approval items is decided here, in one place, so the product behaviour can be read top to bottom.
//
// Policies that matter:
//  * The feed stays readable: tool calls and plain working/idle flips are state, not events. Only moments a person
//    would care about become entries (permission, input, error, turn ended without a report, report ready, ended,
//    presence lost, delivery needs checking).
//  * Entry ids derive from the cause (the reducer's derived id), so replaying the log after a restart can never
//    create a second entry or send a second notification.
//  * "Turn ended" is worded as exactly that. Stop is not task completion; only a report marker (a declaration by the
//    model, never proof) produces "Report ready".
//  * Notifications are never produced for replayed history and only for entries that were newly created.
import { shortSessionId } from '@minisumma/shared';
import type { ActivityEvent, Delivery, LinkTarget, PendingAction, ReportSummary, SessionKey, SessionView } from '@minisumma/shared';
import type {
  ActionsService, ActivityService, CapturedCandidate, CapturedReport, ClaudeDerivedEvent, CoreBase, DeliveriesService,
  NotificationsService, NotifyHint, ReportsService, SessionsService, SettingsService,
} from './contracts.ts';

export interface OrchestratorDeps {
  base: CoreBase;
  settings: Pick<SettingsService, 'get'>;
  sessions: Pick<SessionsService, 'subscribe' | 'get'>;
  reports: Pick<ReportsService, 'capture' | 'captureCandidate' | 'list' | 'summary'>;
  deliveries: Pick<DeliveriesService, 'onReportCaptured' | 'list'>;
  activity: Pick<ActivityService, 'record' | 'resolve' | 'get'>;
  notifications: Pick<NotificationsService, 'consider'>;
  actions: Pick<ActionsService, 'raisePermission' | 'supersedeOpenFor'>;
}

export interface Orchestrator {
  /** Subscribe to the Claude layer and the bus. Returns the unsubscribe function. */
  start(): () => void;
  /** Called by ReportsService when a report row was newly created (capture or promotion). */
  onReportCreated(report: ReportSummary, ctx: { via: 'capture' | 'promote' }): void;
  /** Startup repair: every stored report has a delivery and a feed entry, even after a crash between the steps. */
  reconcile(): void;
}

const ATTENTION_STATES = ['needs_permission', 'needs_input', 'waiting_for_you'] as const;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { base, settings, sessions, reports, deliveries, activity, notifications, actions } = deps;
  const log = base.log;

  // History older than the feed's retention was pruned on purpose. Rebuilding state from the raw log (a restart
  // replay, or the startup repair) must not bring those entries back as new, unread items.
  const prunedByRetention = (iso: string | undefined): boolean => {
    const days = settings.get().retention.activityDays;
    return days > 0 && iso !== undefined && Date.parse(iso) < base.clock.now().getTime() - days * 86_400_000;
  };
  const lastDeliveryState = new Map<string, string>();
  const lastDeliverySignature = new Map<string, string>();

  const label = (view: Pick<SessionView, 'projectName' | 'key'>): string =>
    `${view.projectName ?? 'Unassigned session'} / ${shortSessionId(view.key)}`;

  const sessionLinks = (projectId: string | null, key: SessionKey | null): LinkTarget[] => {
    const links: LinkTarget[] = [];
    if (projectId) links.push({ kind: 'project', id: projectId });
    if (key) links.push({ kind: 'session', key });
    return links;
  };

  function notify(entry: ActivityEvent, hint: NotifyHint): void {
    notifications.consider(entry, hint).catch((err) => log.warn('notification failed', { error: String(err), activity: entry.id }));
  }

  // ---- reports -------------------------------------------------------------------------------------------------
  function describeReport(report: ReportSummary, delivery: Delivery): string {
    const status = `${report.declaredStatus}, declared by Claude and not verified`;
    if (delivery.state === 'destination_missing') return `${status}. No ChatGPT conversation is mapped to this project yet.`;
    if (delivery.destination) return `${status}. Destination: ${delivery.destination.title}.`;
    return status;
  }

  function recordReportEntry(report: ReportSummary, delivery: Delivery, canNotify: boolean): void {
    if (!canNotify && prunedByRetention(report.capturedAt)) return;
    const links: LinkTarget[] = [...sessionLinks(report.projectId, report.sessionKey), { kind: 'report', id: report.id }, { kind: 'delivery', id: delivery.id }];
    const { activity: entry, created } = activity.record({
      id: `rep_${report.id}`, at: report.capturedAt, projectId: report.projectId, projectName: report.projectName, source: 'claude',
      sessionKey: report.sessionKey, type: 'report_ready', severity: 'attention',
      title: `Report ready: ${report.taskTitle}`, description: describeReport(report, delivery), requiresAction: true, links,
    });
    if (created && canNotify) {
      notify(entry, {
        kind: 'report', projectId: report.projectId, sessionKey: report.sessionKey, urgency: 'normal', dedupeKey: `rep_${report.id}`,
        target: { view: 'reports', projectId: report.projectId ?? undefined, reportId: report.id, deliveryId: delivery.id },
      });
    }
  }

  function onReportCreated(report: ReportSummary): void {
    try {
      const delivery = deliveries.onReportCaptured(report);
      recordReportEntry(report, delivery, true);
    } catch (err) {
      log.error('could not process a new report', { error: String(err), report: report.id });
    }
  }

  function reconcile(): void {
    try {
      let before: string | undefined;
      for (let page = 0; page < 50; page++) {
        const { items, nextBefore } = reports.list({ before, limit: 100 });
        for (const report of items) {
          const existing = deliveries.list({ reportId: report.id });
          const delivery = existing.length ? existing[existing.length - 1] : deliveries.onReportCaptured(report);
          recordReportEntry(report, delivery, false);
        }
        if (!nextBefore) break;
        before = nextBefore;
      }
    } catch (err) {
      log.error('reconcile failed', { error: String(err) });
    }
  }

  // ---- Claude events -------------------------------------------------------------------------------------------
  function onDerived(event: ClaudeDerivedEvent, view: SessionView): void {
    if (event.replay && prunedByRetention(event.at)) return;
    try {
      if (event.kind === 'transition') onTransition(event, view);
      else if (event.kind === 'session_discovered' && view.origin !== 'managed') {
        activity.record({
          id: `drv_${event.derivedId}`, at: event.at, projectId: view.projectId, projectName: view.projectName, source: 'discovery',
          sessionKey: view.key, type: 'session_discovered', severity: 'info',
          title: `Found a running Claude session: ${label(view)}`,
          description: view.projectId ? 'Observed only. Mini-Summa does not type into sessions it did not start.' : 'It is not assigned to a project yet.',
          links: sessionLinks(view.projectId, view.key),
        });
      } else if (event.kind === 'generation') {
        activity.record({
          id: `drv_${event.derivedId}`, at: event.at, projectId: view.projectId, projectName: view.projectName, source: 'claude',
          sessionKey: view.key, type: 'session_resumed', severity: 'info', title: `Session resumed: ${label(view)}`,
          description: `A new process now serves this session (generation ${event.generation}).`, links: sessionLinks(view.projectId, view.key),
        });
      }
    } catch (err) {
      log.error('could not process a Claude event', { error: String(err), event: event.derivedId });
    }
  }

  function onTransition(event: ClaudeDerivedEvent, view: SessionView): void {
    const to = event.to ?? null;
    const from = event.from ?? null;
    const canNotify = !event.replay;
    const base2 = {
      id: `drv_${event.derivedId}`, at: event.at, projectId: view.projectId, projectName: view.projectName, source: 'claude' as const,
      sessionKey: view.key, links: sessionLinks(view.projectId, view.key),
    };
    const target = { view: 'workspace' as const, projectId: view.projectId ?? undefined, sessionKey: view.key };
    const hint = (kind: NotifyHint['kind'], urgency: NotifyHint['urgency']): NotifyHint =>
      ({ kind, projectId: view.projectId, sessionKey: view.key, urgency, target, dedupeKey: `drv_${event.derivedId}` });

    // The thing that needed the user is over: close its entries and any open approval items.
    if (from && (ATTENTION_STATES as readonly string[]).includes(from) && to !== from) {
      activity.resolve({ sessionKey: view.key, types: ['needs_permission', 'needs_input', 'waiting_for_you'] }, event.at);
      if (from === 'needs_permission') actions.supersedeOpenFor(view.key, 'The session moved on.');
    }

    switch (to) {
      case 'needs_permission': {
        const detail = event.permission?.toolName
          ? `${event.permission.toolName}${event.permission.inputExcerpt ? `: ${event.permission.inputExcerpt}` : ''}` : null;
        const { activity: entry, created } = activity.record({ ...base2, type: 'needs_permission', severity: 'attention', requiresAction: true,
          title: `Needs permission: ${label(view)}`, description: detail ?? 'Claude is waiting for you to allow an action.' });
        if (view.origin === 'managed' && !event.replay) {
          actions.raisePermission({ sessionKey: view.key, generation: event.generation, summary: detail ?? 'Permission requested', correlationKey: event.derivedId, projectId: view.projectId });
        }
        if (created && canNotify && event.notify) notify(entry, hint('permission', 'critical'));
        break;
      }
      case 'needs_input': {
        const { activity: entry, created } = activity.record({ ...base2, type: 'needs_input', severity: 'attention', requiresAction: true,
          title: `Needs your input: ${label(view)}`, description: event.text ?? 'Claude asked a question and is waiting for your answer.' });
        if (created && canNotify && event.notify) notify(entry, hint('input', 'critical'));
        break;
      }
      case 'error': {
        const { activity: entry, created } = activity.record({ ...base2, type: 'error', severity: 'error', requiresAction: true,
          title: `Error in ${label(view)}`, description: event.text ?? 'The turn ended with an error.' });
        if (created && canNotify && event.notify) notify(entry, hint('error', 'critical'));
        break;
      }
      case 'ended': {
        const abnormal = Boolean(event.abnormal);
        const { activity: entry, created } = activity.record({ ...base2, type: 'session_ended', severity: abnormal ? 'attention' : 'info',
          title: `Session ended: ${label(view)}`, description: event.text ?? null });
        if (created && canNotify && abnormal) notify(entry, hint('sessionEnded', 'normal'));
        actions.supersedeOpenFor(view.key, 'The session ended.');
        break;
      }
      case 'presence_lost': {
        const { activity: entry, created } = activity.record({ ...base2, type: 'presence_lost', severity: 'attention',
          title: `Session no longer visible: ${label(view)}`,
          description: 'Claude Code stopped listing it. It may have ended, or the connection may have dropped. This is not confirmed.' });
        if (created && canNotify && event.notify) notify(entry, hint('presenceLost', 'normal'));
        break;
      }
      case 'waiting_for_you':
        activity.record({ ...base2, type: 'waiting_for_you', severity: 'info', title: `Waiting for you: ${label(view)}`,
          description: 'Claude has been idle at the prompt. Inferred from an idle notification.' });
        break;
      case 'turn_ended':
      case 'background_wait':
        activity.record({ ...base2, type: 'turn_ended', severity: 'info', title: `Turn ended: ${label(view)}`,
          description: to === 'background_wait'
            ? 'Claude finished a turn but background work is still pending. No report was declared.'
            : 'No report was declared. A turn ending does not mean the task is complete.' });
        break;
      default:
        break; // working and idle are state, not feed entries
    }
  }

  // ---- deliveries and actions ----------------------------------------------------------------------------------
  function onDelivery(delivery: Delivery): void {
    // A report summary embeds its latest delivery (state, review, destination). Keep it fresh for clients that only
    // watch reports, instead of leaving them with the snapshot from the moment the report was created.
    const signature = `${delivery.state}|${delivery.review}|${delivery.destination?.conversationId ?? ''}`;
    if (lastDeliverySignature.get(delivery.id) !== signature) {
      lastDeliverySignature.set(delivery.id, signature);
      try {
        const fresh = reports.summary(delivery.reportId);
        if (fresh) base.bus.emit({ type: 'report.upserted', report: fresh });
      } catch (err) {
        log.warn('could not refresh a report summary', { error: String(err), report: delivery.reportId });
      }
    }
    const previous = lastDeliveryState.get(delivery.id);
    lastDeliveryState.set(delivery.id, delivery.state);
    if (previous === delivery.state) return;
    try {
      const links: LinkTarget[] = [...sessionLinks(delivery.projectId, delivery.sessionKey), { kind: 'report', id: delivery.reportId }, { kind: 'delivery', id: delivery.id }];
      const common = { at: delivery.stateChangedAt, projectId: delivery.projectId, projectName: delivery.projectName, source: 'delivery' as const,
        sessionKey: delivery.sessionKey, type: 'delivery_state' as const, links };
      if (delivery.state === 'user_confirmed_sent') {
        activity.record({ ...common, id: `dlv_${delivery.id}_sent_${delivery.attempts}`, severity: 'info',
          title: `Marked as sent to ChatGPT: ${delivery.taskTitle}`, description: 'You confirmed it. Mini-Summa cannot see ChatGPT, so this is your statement.' });
        activity.resolve({ link: { kind: 'delivery', id: delivery.id } }, delivery.stateChangedAt);
      } else if (delivery.state === 'user_discarded') {
        activity.record({ ...common, id: `dlv_${delivery.id}_discarded_${delivery.attempts}`, severity: 'info', title: `Handoff discarded: ${delivery.taskTitle}` });
        activity.resolve({ link: { kind: 'delivery', id: delivery.id } }, delivery.stateChangedAt);
      } else if (delivery.state === 'delivery_uncertain') {
        activity.record({ ...common, id: `dlv_${delivery.id}_uncertain_${delivery.attempts}`, severity: 'attention', requiresAction: true,
          title: `Check ChatGPT: not sure this was sent (${delivery.taskTitle})`, description: 'Open the conversation and look. Then confirm it was sent, or hand it off again.' });
      }
    } catch (err) {
      log.error('could not record a delivery change', { error: String(err), delivery: delivery.id });
    }
  }

  const seenActions = new Set<string>();
  function onAction(action: PendingAction): void {
    try {
      if (action.status === 'pending' && action.kind === 'claude_prompt' && !seenActions.has(action.id)) {
        seenActions.add(action.id);
        const view = sessions.get(action.sessionKey);
        const { activity: entry, created } = activity.record({
          id: `act_${action.id}`, at: action.createdAt, projectId: action.projectId, projectName: action.projectName, source: 'action',
          sessionKey: action.sessionKey, type: 'action_pending', severity: 'attention', requiresAction: true,
          title: `${action.createdBy.kind === 'device' ? action.createdBy.name : 'A client'} wants to send a prompt to ${action.projectName ?? 'a session'} / ${shortSessionId(action.sessionKey)}`,
          description: `Approve or reject it in Mini-Summa. Nothing is typed until you approve. Prompt starts: ${action.summary}`,
          links: [...sessionLinks(action.projectId, action.sessionKey), { kind: 'action', id: action.id }],
        });
        if (created) {
          notify(entry, { kind: 'input', projectId: action.projectId, sessionKey: action.sessionKey, urgency: 'normal', dedupeKey: `act_${action.id}`,
            target: { view: 'workspace', projectId: action.projectId ?? undefined, sessionKey: action.sessionKey } });
        }
        void view;
      } else if (action.status !== 'pending') {
        activity.resolve({ link: { kind: 'action', id: action.id } }, action.decidedAt ?? undefined);
        // Answering a permission dialog with Escape fires no hook in Claude Code, so the session would keep saying
        // "needs permission" until something else happens. The person has answered it: close the entry now.
        if (action.kind === 'permission' && (action.status === 'executed' || action.status === 'rejected')) {
          activity.resolve({ sessionKey: action.sessionKey, types: ['needs_permission'] }, action.decidedAt ?? undefined);
        }
      }
    } catch (err) {
      log.error('could not record an action change', { error: String(err), action: action.id });
    }
  }

  // ---- wiring --------------------------------------------------------------------------------------------------
  function start(): () => void {
    const offClaude = sessions.subscribe({
      onDerived,
      onReport(captured: CapturedReport) {
        try { reports.capture(captured); } catch (err) { log.error('could not store a report', { error: String(err), report: captured.reportId }); }
      },
      onCandidate(candidate: CapturedCandidate) {
        // Final messages without a report marker are kept for the Reports view but are not feed entries: every plain
        // answer would otherwise become one.
        try { reports.captureCandidate(candidate); } catch (err) { log.error('could not store a candidate', { error: String(err) }); }
      },
      onSession(view, previous) {
        try {
          if (view.origin === 'managed' && view.availability === 'live' && (!previous || previous.availability !== 'live' || previous.generation !== view.generation)) {
            activity.record({
              id: `start_${view.key}_${view.generation}`, projectId: view.projectId, projectName: view.projectName, source: 'claude', sessionKey: view.key,
              type: 'session_started', severity: 'info', title: `Claude session started: ${label(view)}`,
              description: `Managed by Mini-Summa in ${view.cwd ?? 'its project folder'}.`, links: sessionLinks(view.projectId, view.key),
            });
          }
        } catch (err) { log.error('could not record a session start', { error: String(err) }); }
      },
    });
    const offBus = base.bus.subscribe((_seq, event) => {
      if (event.type === 'delivery.upserted') onDelivery(event.delivery);
      else if (event.type === 'action.upserted') onAction(event.action);
    });
    return () => { offClaude(); offBus(); };
  }

  return { start, onReportCreated, reconcile };
}
