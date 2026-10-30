// The five real workflow services on one database, wired the way the composition root wires them, with fakes only for
// what lies outside this directory (sessions, projects, the host, push). This is where a disagreement between two
// services about a shared table would show up.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ActorRef, Delivery } from '@minisumma/shared';
import type { CapturedReport, DeliveriesService } from '../../src/contracts.ts';
import { createActionsService } from '../../src/workflow/actions.ts';
import { createActivityService } from '../../src/workflow/activity.ts';
import { createDeliveriesService } from '../../src/workflow/deliveries.ts';
import { createNotificationsService } from '../../src/workflow/notifications.ts';
import { createReportsService } from '../../src/workflow/reports.ts';
import { FakeDevices, FakeProjects, FakePush, FakeSessions, KEY_A, fakeNative, fakeSettings, flush, makeEnv } from './helpers.ts';

const D: ActorRef = { kind: 'desktop' };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const BODY = '## Implementation Report\n\nFixed the redirect.\n\n<!-- mini-summa:report status=complete task="Fix login" -->';

function system() {
  const env = makeEnv('2026-10-30T10:00:00.000Z');
  const settings = fakeSettings();
  const projects = new FakeProjects(env.db, env.clock);
  const sessions = new FakeSessions();
  const native = fakeNative();
  const push = new FakePush();
  const devices = new FakeDevices();
  devices.addDevice({ id: 'dev_phone' });
  devices.addPushTarget('dev_phone');

  const activity = createActivityService({ base: env.base, fullCounts: () => ({ unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 0 }) });
  const notifications = createNotificationsService({ base: env.base, settings, projects, devices, native, push });
  const pendingNotifications: Promise<unknown>[] = [];
  // eslint-disable-next-line prefer-const
  let deliveries!: DeliveriesService;
  const reports = createReportsService({
    base: env.base,
    onCreated: (report) => {
      const delivery = deliveries.onReportCaptured(report);
      const { activity: entry, created } = activity.record({
        id: `rep_${report.id}`, at: report.capturedAt, projectId: report.projectId, projectName: report.projectName, source: 'claude', sessionKey: report.sessionKey,
        type: 'report_ready', severity: 'attention', title: `Report ready: ${report.taskTitle}`, requiresAction: true,
        links: [{ kind: 'report', id: report.id }, { kind: 'delivery', id: delivery.id }],
      });
      if (created) {
        pendingNotifications.push(notifications.consider(entry, {
          kind: 'report', projectId: report.projectId, sessionKey: report.sessionKey, urgency: 'normal', dedupeKey: `rep_${report.id}`,
          target: { view: 'reports', projectId: report.projectId ?? undefined, reportId: report.id, deliveryId: delivery.id },
        }));
      }
    },
  });
  deliveries = createDeliveriesService({ base: env.base, settings, projects, reports, sessions, native });
  const actions = createActionsService({ base: env.base, settings, sessions, activity, devices, deliveries });

  const gm = projects.addProject({ id: 'prj_gm', name: 'GitManager' });
  const chat = projects.addConversation(gm.id, { id: 'cnv_gm', title: 'GitManager review', verification: 'verified' });
  projects.setPreferred(gm.id, chat.id);
  sessions.add({ key: KEY_A, projectId: gm.id, projectName: gm.name, state: 'idle' });

  const captured = (over: Partial<CapturedReport> = {}): CapturedReport => ({
    reportId: 'aaaabbbbccccdddd', sessionKey: KEY_A, env: 'win', sessionId: 'a1b2c3d4-1111-4111-8111-111111111111', generation: 1, projectId: gm.id,
    projectName: gm.name, cwd: 'C:\\dev\\gm', promptId: 'p1', taskId: `${KEY_A}:p1`, taskTitle: 'Fix login', declaredStatus: 'complete', body: BODY, bodySha256: sha256(BODY),
    stopHookActive: false, late: false, capturedSeq: 1, note: 'The marker is a declaration written by the model, not evidence that the work or its tests succeeded.',
    capturedAt: '2026-10-30T09:59:00.000Z', redactions: 2, ...over,
  });
  return { env, settings, projects, sessions, native, push, devices, activity, notifications, reports, deliveries, actions, gm, chat, captured, settle: async () => { await Promise.all(pendingNotifications); } };
}

describe('workflow services together', () => {
  it('a captured report becomes a delivery, a feed entry and one notification, and a replay adds nothing', async () => {
    const s = system();
    const { report, created } = s.reports.capture(s.captured());
    await s.settle();
    expect(created).toBe(true);
    const deliveries = s.deliveries.list({ reportId: report.id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ state: 'ready_for_handoff', destination: { conversationId: 'cnv_gm', resolvedFrom: 'project_preferred' } });
    expect(s.activity.get(`rep_${report.id}`)).toMatchObject({ requiresAction: true, title: 'Report ready: Fix login' });
    expect(s.notifications.list()).toHaveLength(1);
    expect(s.native.notifications.map((n) => n.title)).toEqual(['GitManager: report ready']);
    expect(s.push.sent[0].payload).toEqual({ title: 'GitManager', body: 'A report is ready', data: { kind: 'report', projectId: 'prj_gm', activityId: `rep_${report.id}`, sessionKey: KEY_A, reportId: report.id } });
    expect(s.reports.require(report.id)).toMatchObject({ redactions: 2, deliveries: [{ id: deliveries[0].id, state: 'ready_for_handoff', destinationTitle: 'GitManager review' }] });
    expect(s.reports.list({}).items[0].delivery).toMatchObject({ id: deliveries[0].id, state: 'ready_for_handoff' });

    const eventCount = s.env.events.length;
    for (let i = 0; i < 3; i++) s.reports.capture(s.captured());
    await s.settle();
    expect(s.env.events.length).toBe(eventCount);
    expect(s.deliveries.list({})).toHaveLength(1);
    expect(s.native.notifications).toHaveLength(1);
    expect(s.push.sent).toHaveLength(1);
    expect(s.env.log.errors()).toEqual([]);
  });

  it('carries a report all the way: hand off, confirm, review, follow-up typed into Claude and marked sent', async () => {
    const s = system();
    const { report } = s.reports.capture(s.captured());
    const d = s.deliveries.list({ reportId: report.id })[0];

    const handoff = await s.deliveries.handoff(d.id, undefined, D);
    expect(handoff.delivery.state).toBe('awaiting_user_send');
    expect(s.native.clipboardWrites[0]).toContain(BODY);
    s.deliveries.confirmSent(d.id, undefined, D);
    s.deliveries.setReview(d.id, 'received', null, D);
    const draft = 'Please add a test for the logout redirect.';
    s.deliveries.setReview(d.id, 'follow_up_drafted', draft, D);

    const sent = await s.actions.createPrompt({ sessionKey: KEY_A, text: draft, deliveryId: d.id, reportId: report.id, actor: D });
    expect(sent.status).toBe('executed');
    expect(s.sessions.typed).toEqual([{ key: KEY_A, text: draft, submit: true }]);
    const after = s.deliveries.get(d.id)!;
    expect(after.review).toBe('follow_up_sent');
    expect(after.followUpDraft).toBe(draft);
    expect(s.reports.require(report.id).deliveries[0]).toMatchObject({ state: 'user_confirmed_sent', review: 'follow_up_sent' });
    expect(s.activity.get(`actres_${sent.id}`)).toMatchObject({ title: 'Prompt sent to GitManager / a1b2c3d4', links: expect.arrayContaining([{ kind: 'delivery', id: d.id }, { kind: 'report', id: report.id }]) });
    expect(s.env.log.errors()).toEqual([]);
  });

  it('counts what needs a person and clears it as it is handled', async () => {
    const s = system();
    s.reports.capture(s.captured());
    s.reports.capture(s.captured({ reportId: 'eeeeffff00001111', taskTitle: 'Second task' }));
    await s.settle();
    expect(s.activity.counts()).toEqual({ unreadActivity: 2, actionsNeeded: 2 });
    const d = s.deliveries.list({})[0];
    s.activity.resolve({ link: { kind: 'delivery', id: d.id } });
    s.activity.markRead({ all: true });
    expect(s.activity.counts()).toEqual({ unreadActivity: 0, actionsNeeded: 1 });
  });

  it('keeps everything readable after its project is deleted', async () => {
    const s = system();
    const { report } = s.reports.capture(s.captured());
    const d = s.deliveries.list({})[0];
    await s.deliveries.copy(d.id, undefined, D);
    s.projects.removeProject('prj_gm');
    expect(s.reports.require(report.id)).toMatchObject({ projectId: null, projectName: 'GitManager' });
    const kept = s.deliveries.get(d.id)!;
    expect(kept).toMatchObject({ projectId: null, projectName: 'GitManager', state: 'copied' });
    expect(kept.destination!.conversationId).toBe('cnv_gm'); // frozen: the project and its conversation rows are gone, the delivery is not
    expect((await s.deliveries.open(d.id, D)).open.ok).toBe(true);
    expect(s.deliveries.confirmSent(d.id, undefined, D).state).toBe('user_confirmed_sent');
  });

  it('prunes by age across the services without breaking a foreign key', async () => {
    const s = system();
    s.reports.capture(s.captured());
    s.reports.captureCandidate({ candidateId: 'cand0000000000001', sessionKey: KEY_A, env: 'win', sessionId: 's', generation: 1, projectId: 'prj_gm', projectName: 'GitManager',
      promptId: null, reason: 'no marker', declaredStatus: null, taskTitle: null, body: 'chat', bodySha256: sha256('chat'), late: false, capturedAt: '2026-10-30T09:00:00.000Z' });
    await s.settle();
    const d = s.deliveries.list({})[0];
    await s.deliveries.copy(d.id, undefined, D);
    s.deliveries.discard(d.id, undefined, D);
    s.env.clock.set('2027-10-30T10:00:00.000Z');
    const cutoff = '2027-01-01T00:00:00.000Z';
    expect(s.deliveries.prune(cutoff)).toBe(1);
    expect(s.reports.prune(cutoff)).toBe(1);
    s.activity.markRead({ all: true });
    expect(s.activity.prune(cutoff)).toBe(0); // the report entry still needs action
    expect(s.notifications.prune(cutoff)).toBe(1);
    expect(s.reports.listCandidates({ includePromoted: true })).toEqual([]);
    expect(s.env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM delivery_events')!.n).toBe(0);
    await flush();
  });
});
