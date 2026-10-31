import { describe, expect, it, vi } from 'vitest';
import type { ActivityEvent, Delivery, PendingAction, ReportSummary, SessionView } from '@minisumma/shared';
import { createEventBus } from '../src/bus.ts';
import type { ActivityInput, ClaudeDerivedEvent, ClaudeEventHandlers, CoreBase, NotifyHint, PermissionRequestInfo } from '../src/contracts.ts';
import { createOrchestrator } from '../src/orchestrator.ts';

const KEY = 'win|11111111-1111-4111-8111-111111111111' as const;

const view = (over: Partial<SessionView> = {}): SessionView => ({
  key: KEY, env: 'win', sessionId: '11111111-1111-4111-8111-111111111111', origin: 'managed', availability: 'live', termination: null, resumable: false,
  projectId: 'p1', projectName: 'GitManager', projectResolution: 'managed', cwd: 'C:\\dev\\gm', name: null, state: 'idle', stateLabel: 'Idle',
  stateEvidence: 'hook', generation: 1, pid: 1, startedAt: null, lastActivityAt: null, attention: null, unresolvedOrdering: 0,
  terminal: { cols: 80, rows: 24, exited: false }, isProjectDefault: false, remoteControl: { state: 'unknown', hint: '' }, ...over,
});

const derived = (over: Partial<ClaudeDerivedEvent>): ClaudeDerivedEvent => ({
  derivedId: 'd1', kind: 'transition', sessionKey: KEY, generation: 1, from: 'working', to: 'idle', notify: false, requiresUser: false,
  rawSeq: 1, at: '2026-10-30T10:00:00.000Z', replay: false, ...over,
});

const request = (over: Partial<PermissionRequestInfo> = {}): PermissionRequestInfo => ({
  correlationKey: 'perm1', sessionKey: KEY, generation: 1, toolName: 'Bash', inputExcerpt: 'rm -rf build', rawSeq: 2,
  at: '2026-10-30T10:00:00.000Z', replay: false, ...over,
});

function harness() {
  const bus = createEventBus();
  const entries = new Map<string, ActivityEvent>();
  const resolved: unknown[] = [];
  const recorded: ActivityInput[] = [];
  const handlers: { current: ClaudeEventHandlers | null } = { current: null };
  const notified: { id: string; kind: string; target: unknown }[] = [];
  const hints: NotifyHint[] = [];
  const permission: unknown[] = [];
  const superseded: string[] = [];
  const captured: string[] = [];
  const deliveriesByReport = new Map<string, Delivery>();

  const delivery = (reportId: string, over: Partial<Delivery> = {}): Delivery => ({
    id: `dlv_${reportId}`, reportId, projectId: 'p1', projectName: 'GitManager', sessionKey: KEY, taskTitle: 'Fix login', state: 'ready_for_handoff',
    destination: { conversationId: 'c1', url: 'https://chatgpt.com/c/x', title: 'Main chat', chatgptConversationId: 'x', resolvedFrom: 'project_preferred', verificationAtFreeze: 'verified', frozenAt: 'x' },
    review: 'none', includeReviewRequest: true, messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null,
    stateChangedAt: '2026-10-30T10:00:00.000Z', createdAt: 'x', updatedAt: 'x', ...over,
  });

  const base = { bus, clock: { now: () => new Date('2026-10-30T12:00:00.000Z') }, log: { debug() {}, info() {}, warn() {}, error: vi.fn() } } as unknown as CoreBase;
  const retention = { activityDays: 0 };
  const settings = { get: () => ({ retention }) } as never;
  const orch = createOrchestrator({
    base, settings,
    sessions: { subscribe(h) { handlers.current = h; return () => { handlers.current = null; }; }, get: () => view() },
    reports: { capture: (r) => { captured.push(r.reportId); return { report: {} as ReportSummary, created: true }; }, captureCandidate: () => ({ created: true }), list: () => ({ items: [], nextBefore: null }), summary: (id) => summary(id) },
    deliveries: { onReportCaptured: (r) => { const d = deliveriesByReport.get(r.id) ?? delivery(r.id); deliveriesByReport.set(r.id, d); return d; }, list: ({ reportId }) => (reportId && deliveriesByReport.has(reportId) ? [deliveriesByReport.get(reportId)!] : []) },
    activity: {
      record(input) {
        recorded.push(input);
        const existing = entries.get(input.id);
        if (existing) return { activity: existing, created: false };
        const a: ActivityEvent = { id: input.id, at: input.at ?? 'now', projectId: input.projectId, projectName: input.projectName ?? null, source: input.source,
          sessionKey: input.sessionKey ?? null, type: input.type, severity: input.severity, title: input.title, description: input.description ?? null,
          requiresAction: input.requiresAction ?? false, resolvedAt: null, links: input.links ?? [], read: false };
        entries.set(a.id, a);
        return { activity: a, created: true };
      },
      resolve(match) { resolved.push(match); return 1; },
      get: (id) => entries.get(id) ?? null,
    },
    notifications: { consider: async (a, hint) => { notified.push({ id: a.id, kind: hint.kind, target: hint.target }); hints.push(hint); return null; } },
    actions: { raisePermission: (i) => { permission.push(i); return null; }, supersedeOpenFor: (k) => { superseded.push(k); } },
  });
  const stop = orch.start();
  return { orch, retention, handlers: () => handlers.current!, entries, resolved, recorded, notified, hints, permission, superseded, captured, bus, stop, deliveriesByReport, delivery };
}

const summary = (id: string, over: Partial<ReportSummary> = {}): ReportSummary => ({
  id, projectId: 'p1', projectName: 'GitManager', sessionKey: KEY, env: 'win', sessionId: 's', generation: 1, taskTitle: 'Fix login', declaredStatus: 'complete',
  source: 'marker', capturedAt: '2026-10-30T10:00:00.000Z', late: false, read: false, chars: 10, excerpt: 'x', delivery: null, ...over,
});

describe('orchestrator: Claude events', () => {
  it('turns a permission prompt into one entry and one notification, and the request into its own approval item', () => {
    const h = harness();
    const ev = derived({ derivedId: 'perm1', from: 'working', to: 'needs_permission', notify: true, requiresUser: true, permission: { toolName: 'Bash', inputExcerpt: 'rm -rf build' } });
    h.handlers().onDerived!(ev, view({ state: 'needs_permission' }));
    h.handlers().onPermissionRequest!(request(), view({ state: 'needs_permission' }));
    expect([...h.entries.values()].map((a) => [a.type, a.requiresAction, a.title])).toEqual([['needs_permission', true, 'Needs permission: GitManager / 11111111']]);
    expect(h.entries.get('drv_perm1')!.description).toBe('Bash: rm -rf build');
    expect(h.permission).toEqual([{ sessionKey: KEY, generation: 1, summary: 'Bash: rm -rf build', correlationKey: 'perm1', projectId: 'p1' }]);
    expect(h.notified).toEqual([{ id: 'drv_perm1', kind: 'permission', target: { view: 'workspace', projectId: 'p1', sessionKey: KEY } }]);
  });

  it('raises an item for every request, so a second dialog replaces the first and the approval names the one on screen', () => {
    const h = harness();
    h.handlers().onPermissionRequest!(request({ correlationKey: 'first', inputExcerpt: 'ls' }), view({ state: 'needs_permission' }));
    // A second PermissionRequest while the session already waits changes no state, so there is no derived event for it.
    h.handlers().onPermissionRequest!(request({ correlationKey: 'second', inputExcerpt: 'rm -rf build', rawSeq: 3 }), view({ state: 'needs_permission' }));
    expect(h.permission).toEqual([
      { sessionKey: KEY, generation: 1, summary: 'Bash: ls', correlationKey: 'first', projectId: 'p1' },
      { sessionKey: KEY, generation: 1, summary: 'Bash: rm -rf build', correlationKey: 'second', projectId: 'p1' },
    ]);
    expect(h.notified).toEqual([]);
  });

  it('words an unnamed tool request plainly instead of inventing detail', () => {
    const h = harness();
    h.handlers().onPermissionRequest!(request({ toolName: null, inputExcerpt: null }), view({ state: 'needs_permission' }));
    expect(h.permission).toMatchObject([{ summary: 'Permission requested' }]);
  });

  it('never notifies or raises approvals for replayed history, and a second delivery of the same event is silent', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'old', to: 'needs_permission', notify: true, replay: true }), view());
    h.handlers().onPermissionRequest!(request({ correlationKey: 'old', replay: true }), view());
    expect(h.notified).toEqual([]);
    expect(h.permission).toEqual([]);
    h.handlers().onDerived!(derived({ derivedId: 'live', to: 'needs_input', notify: true }), view());
    h.handlers().onDerived!(derived({ derivedId: 'live', to: 'needs_input', notify: true }), view());
    expect(h.notified).toHaveLength(1);
  });

  it('does not raise a typing approval for a session Mini-Summa does not own', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ to: 'needs_permission', notify: true }), view({ origin: 'external' }));
    h.handlers().onPermissionRequest!(request(), view({ origin: 'external' }));
    expect(h.permission).toEqual([]);
    expect(h.notified).toHaveLength(1);
  });

  it('closes attention entries and approval items when the session moves on', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'x', from: 'needs_permission', to: 'working' }), view());
    expect(h.resolved).toEqual([{ sessionKey: KEY, types: ['needs_permission', 'needs_input', 'waiting_for_you'] }]);
    expect(h.superseded).toEqual([KEY]);
  });

  it('keeps the feed readable: working and idle flips are not entries', () => {
    const h = harness();
    for (const to of ['working', 'idle'] as const) h.handlers().onDerived!(derived({ derivedId: to, from: null, to }), view());
    expect(h.entries.size).toBe(0);
  });

  it('words a plain turn end as exactly that, not as completion, and still tells the person Claude finished', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 't', to: 'turn_ended' }), view());
    const e = h.entries.get('drv_t')!;
    expect(e.type).toBe('turn_ended');
    expect(e.severity).toBe('info');
    expect(e.requiresAction).toBe(false);
    expect(e.description).toMatch(/does not mean the task is complete/);
    expect(h.notified).toEqual([{ id: 'drv_t', kind: 'turnEnded', target: { view: 'workspace', projectId: 'p1', sessionKey: KEY } }]);
  });

  it('presence loss is described as unconfirmed, abnormal end notifies, normal end does not', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'pl', to: 'presence_lost', notify: true }), view({ origin: 'external' }));
    expect(h.entries.get('drv_pl')!.description).toMatch(/not confirmed/);
    h.handlers().onDerived!(derived({ derivedId: 'e1', to: 'ended', abnormal: true, text: 'Session ended while working' }), view());
    h.handlers().onDerived!(derived({ derivedId: 'e2', to: 'ended', text: 'Session ended (clear)' }), view({ key: 'win|22222222-2222-4222-8222-222222222222' }));
    expect(h.notified.map((n) => [n.id, n.kind])).toEqual([['drv_pl', 'presenceLost'], ['drv_e1', 'sessionEnded']]);
  });

  it('records a managed session start once per generation', () => {
    const h = harness();
    h.handlers().onSession!(view(), null);
    h.handlers().onSession!(view({ state: 'working' }), view());
    h.handlers().onSession!(view({ generation: 2 }), view());
    expect([...h.entries.keys()]).toEqual([`start_${KEY}_1`, `start_${KEY}_2`]);
  });
});

describe('orchestrator: Claude finished (turnEnded)', () => {
  it('notifies once per turn end, with normal urgency (it is not an emergency), and a second delivery of the same event is silent', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'a', to: 'turn_ended' }), view());
    h.handlers().onDerived!(derived({ derivedId: 'a', to: 'turn_ended' }), view());
    expect(h.notified.map((n) => n.id)).toEqual(['drv_a']);
    expect(h.hints[0]).toMatchObject({ kind: 'turnEnded', urgency: 'normal', projectId: 'p1', sessionKey: KEY, dedupeKey: 'drv_a' });
  });

  it('sends the same target as the other session notifications, so a click opens the project and the session', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'perm', to: 'needs_permission', notify: true }), view());
    h.handlers().onDerived!(derived({ derivedId: 'fin', from: 'working', to: 'turn_ended' }), view());
    const targets = h.notified.map((n) => n.target);
    expect(targets[1]).toEqual(targets[0]);
    expect(targets[1]).toEqual({ view: 'workspace', projectId: 'p1', sessionKey: KEY });
  });

  it('does not notify a session that is not attached to a project: hooks run for every Claude Code session on this computer', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'free', to: 'turn_ended' }), view({ projectId: null, projectName: null, origin: 'external' }));
    expect(h.entries.get('drv_free')).toMatchObject({ type: 'turn_ended', projectId: null }); // the feed still has it
    expect(h.notified).toEqual([]);
  });

  it('notifies for a session Mini-Summa did not start, as long as it belongs to a project', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'ext', to: 'turn_ended' }), view({ origin: 'external' }));
    expect(h.notified).toHaveLength(1);
  });

  it('never notifies for replayed history (a restart replays the log), but the feed entry is still made', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'old', to: 'turn_ended', replay: true }), view());
    expect(h.entries.has('drv_old')).toBe(true);
    expect(h.notified).toEqual([]);
  });

  it('does not notify again for a turn end whose feed entry already exists (restart, rebuild, duplicate delivery)', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'dup', to: 'turn_ended', replay: true }), view());
    h.handlers().onDerived!(derived({ derivedId: 'dup', to: 'turn_ended', replay: false }), view());
    expect(h.notified).toEqual([]);
  });

  it('does not notify for background_wait: Claude has work pending and goes on by itself, so "finished" would be untrue', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'bg', from: 'working', to: 'background_wait' }), view());
    const e = h.entries.get('drv_bg')!;
    expect(e).toMatchObject({ type: 'turn_ended', severity: 'info' });
    expect(e.description).toMatch(/background work is still pending/);
    expect(h.notified).toEqual([]);
  });

  it('notifies when the work that was pending is over and the turn ends for good', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'bg1', from: 'working', to: 'background_wait' }), view());
    h.handlers().onDerived!(derived({ derivedId: 'bg2', from: 'working', to: 'turn_ended' }), view());
    expect(h.notified.map((n) => [n.id, n.kind])).toEqual([['drv_bg2', 'turnEnded']]);
  });

  it('the idle observation after a turn ("waiting for you") and an interrupted turn ("idle") are feed entries or state, never a second notification', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'fin', from: 'working', to: 'turn_ended' }), view());
    h.handlers().onDerived!(derived({ derivedId: 'wait', from: 'turn_ended', to: 'waiting_for_you' }), view());
    h.handlers().onDerived!(derived({ derivedId: 'esc', from: 'working', to: 'idle' }), view());
    expect(h.notified.map((n) => n.id)).toEqual(['drv_fin']);
  });

  describe('a turn that ends with a report notifies as the report only', () => {
    it('the report path never produces a turn_ended transition, so one Stop cannot notify twice', () => {
      const h = harness();
      // What the reducer emits for a Stop with a valid marker: a report_ready event (no transition) and, via ReportsService, a report.
      h.handlers().onDerived!(derived({ derivedId: 'rdy', kind: 'report_ready', to: 'report_ready', notify: true, reportId: 'r1' }), view());
      h.orch.onReportCreated(summary('r1'), { via: 'capture' });
      expect(h.notified.map((n) => [n.id, n.kind])).toEqual([['rep_r1', 'report']]);
      expect([...h.entries.values()].some((e) => e.type === 'turn_ended')).toBe(false);
    });

    it('a second Stop with no work in between (from report_ready) is the same turn: no "Claude finished" after the report', () => {
      const h = harness();
      h.orch.onReportCreated(summary('r2'), { via: 'capture' });
      h.handlers().onDerived!(derived({ derivedId: 'again', from: 'report_ready', to: 'turn_ended' }), view({ state: 'report_ready' }));
      expect(h.entries.get('drv_again')).toBeDefined(); // the feed keeps it
      expect(h.notified.map((n) => n.kind)).toEqual(['report']);
    });

    it('but a new turn after a report (work in between) does notify when it ends without one', () => {
      const h = harness();
      h.orch.onReportCreated(summary('r3'), { via: 'capture' });
      h.handlers().onDerived!(derived({ derivedId: 'w', from: 'report_ready', to: 'working' }), view());
      h.handlers().onDerived!(derived({ derivedId: 'next', from: 'working', to: 'turn_ended' }), view());
      expect(h.notified.map((n) => n.kind)).toEqual(['report', 'turnEnded']);
    });
  });
});

describe('orchestrator: every notification about a session leads to that project and session', () => {
  it.each([
    ['needs_permission', 'permission'], ['needs_input', 'input'], ['error', 'error'], ['turn_ended', 'turnEnded'], ['presence_lost', 'presenceLost'],
  ] as const)('%s (kind %s) targets the workspace of the session\'s own project, not the selected one', (to, kind) => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: `t_${to}`, to, notify: true }), view({ projectId: 'p-other', projectName: 'Other' }));
    expect(h.notified).toEqual([{ id: `drv_t_${to}`, kind, target: { view: 'workspace', projectId: 'p-other', sessionKey: KEY } }]);
  });

  it('an abnormal end targets it too', () => {
    const h = harness();
    h.handlers().onDerived!(derived({ derivedId: 'end', to: 'ended', abnormal: true }), view({ projectId: 'p-other', projectName: 'Other' }));
    expect(h.notified).toEqual([{ id: 'drv_end', kind: 'sessionEnded', target: { view: 'workspace', projectId: 'p-other', sessionKey: KEY } }]);
  });
});

describe('orchestrator: retention', () => {
  it('does not resurrect entries that retention already pruned when history is replayed', () => {
    const h = harness();
    h.retention.activityDays = 30;
    const old = '2020-01-01T00:00:00.000Z';
    h.handlers().onDerived!(derived({ derivedId: 'old1', to: 'needs_input', at: old, replay: true }), view());
    expect(h.entries.size).toBe(0);
    // live events are never dropped, whatever their timestamp
    h.handlers().onDerived!(derived({ derivedId: 'live1', to: 'needs_input', at: old, replay: false }), view());
    expect(h.entries.size).toBe(1);
  });
});

describe('orchestrator: reports and deliveries', () => {
  it('a new report gets a delivery, a requires-action entry and one notification', () => {
    const h = harness();
    h.orch.onReportCreated(summary('r1'), { via: 'capture' });
    const e = h.entries.get('rep_r1')!;
    expect(e).toMatchObject({ type: 'report_ready', requiresAction: true, title: 'Report ready: Fix login' });
    expect(e.description).toMatch(/declared by Claude and not verified/);
    expect(e.description).toMatch(/Destination: Main chat/);
    expect(e.links).toContainEqual({ kind: 'delivery', id: 'dlv_r1' });
    expect(h.notified).toEqual([{ id: 'rep_r1', kind: 'report', target: { view: 'reports', projectId: 'p1', reportId: 'r1', deliveryId: 'dlv_r1' } }]);
  });

  it('says so when no conversation is mapped', () => {
    const h = harness();
    h.deliveriesByReport.set('r2', h.delivery('r2', { state: 'destination_missing', destination: null }));
    h.orch.onReportCreated(summary('r2'), { via: 'capture' });
    expect(h.entries.get('rep_r2')!.description).toMatch(/No ChatGPT conversation is mapped/);
  });

  it('a report created twice notifies once', () => {
    const h = harness();
    h.orch.onReportCreated(summary('r3'), { via: 'capture' });
    h.orch.onReportCreated(summary('r3'), { via: 'capture' });
    expect(h.notified).toHaveLength(1);
  });

  it('delivery states: sent and discarded resolve the report entry; copy clicks stay out of the feed; uncertain asks to check', () => {
    const h = harness();
    const emit = (d: Delivery) => h.bus.emit({ type: 'delivery.upserted', delivery: d });
    emit(h.delivery('r4', { state: 'copied', attempts: 1 }));
    expect(h.entries.size).toBe(0);
    emit(h.delivery('r4', { state: 'delivery_uncertain', attempts: 1 }));
    expect(h.entries.get('dlv_dlv_r4_uncertain_1')).toMatchObject({ requiresAction: true, severity: 'attention' });
    emit(h.delivery('r4', { state: 'user_confirmed_sent', attempts: 1 }));
    expect(h.entries.get('dlv_dlv_r4_sent_1')!.description).toMatch(/your statement/);
    expect(h.resolved).toContainEqual({ link: { kind: 'delivery', id: 'dlv_r4' } });
  });

  it('keeps the report summary current when its delivery changes', () => {
    const h = harness();
    const seen: string[] = [];
    h.bus.subscribe((_s, e) => { if (e.type === 'report.upserted') seen.push(e.report.id); });
    h.bus.emit({ type: 'delivery.upserted', delivery: h.delivery('r9', { state: 'ready_for_handoff' }) });
    h.bus.emit({ type: 'delivery.upserted', delivery: h.delivery('r9', { state: 'ready_for_handoff' }) }); // nothing changed
    h.bus.emit({ type: 'delivery.upserted', delivery: h.delivery('r9', { state: 'copied' }) });
    h.bus.emit({ type: 'delivery.upserted', delivery: h.delivery('r9', { state: 'copied', review: 'requested' }) });
    expect(seen).toEqual(['r9', 'r9', 'r9']);
  });

  it('reconcile repairs a report that has no delivery and notifies nothing', () => {
    const h = harness();
    const base = { bus: h.bus, clock: { now: () => new Date('2026-10-30T12:00:00.000Z') }, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as CoreBase;
    const missing = summary('r5');
    const created: string[] = [];
    const orch = createOrchestrator({
      base, settings: { get: () => ({ retention: { activityDays: 0 } }) } as never, sessions: { subscribe: () => () => {}, get: () => null },
      reports: { capture: () => ({ report: missing, created: false }), captureCandidate: () => ({ created: false }), list: () => ({ items: [missing], nextBefore: null }), summary: () => missing },
      deliveries: { onReportCaptured: (r) => { created.push(r.id); return h.delivery(r.id); }, list: () => [] },
      activity: { record: (i) => { h.recorded.push(i); return { activity: {} as ActivityEvent, created: true }; }, resolve: () => 0, get: () => null },
      notifications: { consider: async () => { throw new Error('must not notify during reconcile'); } },
      actions: { raisePermission: () => null, supersedeOpenFor: () => {} },
    });
    orch.reconcile();
    expect(created).toEqual(['r5']);
    expect(h.recorded.some((r) => r.id === 'rep_r5')).toBe(true);
  });
});

describe('orchestrator: permission answers', () => {
  it('closes the permission entry when the person answered, because Escape fires no hook', () => {
    const h = harness();
    const perm = { id: 'a9', kind: 'permission', status: 'executed', projectId: 'p1', projectName: 'GitManager', sessionKey: KEY, generation: 1, text: null,
      summary: 'Bash', reportId: null, deliveryId: null, createdAt: 'x', createdBy: { kind: 'system' }, approvableBy: 'any_approver',
      decidedAt: '2026-10-30T10:02:00.000Z', decidedBy: { kind: 'desktop' }, executedAt: null, failure: null, expiresAt: 'x',
      target: { managed: true, live: true, generation: 1, generationMatches: true, state: 'needs_permission', problem: null } } as unknown as PendingAction;
    h.bus.emit({ type: 'action.upserted', action: perm });
    expect(h.resolved).toContainEqual({ sessionKey: KEY, types: ['needs_permission'] });
  });
});

describe('orchestrator: pending actions', () => {
  const action = (over: Partial<PendingAction> = {}): PendingAction => ({
    id: 'a1', kind: 'claude_prompt', status: 'pending', projectId: 'p1', projectName: 'GitManager', sessionKey: KEY, generation: 1, text: 'Run the tests again', summary: 'Run the tests again',
    reportId: null, deliveryId: null, createdAt: '2026-10-30T10:00:00.000Z', createdBy: { kind: 'device', deviceId: 'd1', name: 'Pixel' }, approvableBy: 'desktop_or_other_device',
    decidedAt: null, decidedBy: null, executedAt: null, failure: null, expiresAt: 'x', target: { managed: true, live: true, generation: 1, generationMatches: true, state: 'idle', problem: null }, ...over,
  });

  it('a phone prompt waiting for approval is an entry that needs action and nothing is typed', () => {
    const h = harness();
    h.bus.emit({ type: 'action.upserted', action: action() });
    const e = h.entries.get('act_a1')!;
    expect(e).toMatchObject({ type: 'action_pending', requiresAction: true });
    expect(e.title).toMatch(/Pixel wants to send a prompt to GitManager/);
    expect(e.description).toMatch(/Nothing is typed until you approve/);
    expect(h.notified).toHaveLength(1);
    h.bus.emit({ type: 'action.upserted', action: action({ status: 'executed', decidedAt: '2026-10-30T10:01:00.000Z' }) });
    expect(h.resolved).toContainEqual({ link: { kind: 'action', id: 'a1' } });
  });
});
