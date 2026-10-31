import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReportMessage, fenceBegin, fenceEnd, joinPayloads, splitMessage } from '@minisumma/shared';
import type { ActorRef, ChatGptOpenResult, Delivery, DeliveryState, NativeCapabilities, Report, ReviewState, SettingsPatch } from '@minisumma/shared';
import { createDeliveriesService } from '../../src/workflow/deliveries.ts';
import { createHash } from 'node:crypto';
import { FakeProjects, FakeReports, FakeSessions, KEY_A, KEY_B, KEY_C, fakeNative, fakeSettings, hasEmDash, makeEnv, okOpen } from './helpers.ts';

const D: ActorRef = { kind: 'desktop' };
const PHONE: ActorRef = { kind: 'device', deviceId: 'dev_phone', name: 'Pixel' };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function world(over: { settings?: SettingsPatch; caps?: Partial<NativeCapabilities> } = {}) {
  const env = makeEnv('2026-10-30T10:00:00.000Z');
  const settings = fakeSettings(over.settings);
  const projects = new FakeProjects(env.db, env.clock);
  const sessions = new FakeSessions();
  const native = fakeNative(over.caps);
  const reports = new FakeReports(env.db);
  const deps = { base: env.base, settings, projects, reports, sessions, native };
  const svc = createDeliveriesService(deps);
  const gm = projects.addProject({ id: 'prj_gm', name: 'GitManager' });
  const gmChat = projects.addConversation(gm.id, { id: 'cnv_gm', title: 'GitManager review', verification: 'verified' });
  projects.setPreferred(gm.id, gmChat.id);
  sessions.add({ key: KEY_A, projectId: gm.id, projectName: gm.name });
  const report = (o: Partial<Report> = {}) => reports.add({ projectId: gm.id, projectName: gm.name, sessionKey: KEY_A, ...o });
  const captured = (o: Partial<Report> = {}) => svc.onReportCaptured(report(o));
  return { env, settings, projects, sessions, native, reports, svc, deps, gm, gmChat, report, captured };
}
type World = ReturnType<typeof world>;

const eventsOf = (w: World, id: string) => w.svc.get(id)!.events;
const typesOf = (w: World, id: string) => eventsOf(w, id).map((e) => e.type);
const rowOf = (w: World, id: string) => w.env.db.get<Record<string, unknown>>('SELECT * FROM deliveries WHERE id = ?', [id])!;
const snapshot = (w: World, id: string) => ({
  row: rowOf(w, id),
  events: w.env.db.all('SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY rowid', [id]),
});
const failure = async (fn: () => unknown) => {
  try { await Promise.resolve().then(fn); } catch (err) { return err as { status: number; code: string; message: string }; }
  throw new Error('expected the call to be refused');
};

/** Bodies of about `bytes` characters made of numbered lines (so any reordering of parts would show). */
const bigBody = (bytes: number) => {
  let s = '## Big report\n\n';
  for (let i = 0; s.length < bytes; i++) s += `line ${String(i).padStart(5, '0')}: some words that are part of the report\n`;
  return s;
};

// ---------------------------------------------------------------------------------------------------------------
// One delivery in each state, reached through the public API (report_captured cannot be reached, so it is forced)

const MAKERS: Record<DeliveryState, (w: World) => Promise<string>> = {
  report_captured: async (w) => {
    const d = w.captured();
    w.env.db.run(`UPDATE deliveries SET state = 'report_captured', destination_json = NULL WHERE id = ?`, [d.id]);
    return d.id;
  },
  destination_missing: async (w) => w.svc.onReportCaptured(w.reports.add({ projectId: null, projectName: null })).id,
  destination_unverified: async (w) => { w.projects.editConversation('cnv_gm', { verification: 'unverified' }); return w.captured().id; },
  ready_for_handoff: async (w) => w.captured().id,
  copied: async (w) => { const d = w.captured(); await w.svc.copy(d.id, undefined, D); return d.id; },
  awaiting_user_send: async (w) => { const d = w.captured(); await w.svc.handoff(d.id, undefined, D); return d.id; },
  user_confirmed_sent: async (w) => { const d = w.captured(); w.svc.confirmSent(d.id, undefined, D); return d.id; },
  delivery_uncertain: async (w) => { const d = w.captured(); await w.svc.copy(d.id, undefined, D); w.svc.markUncertain(d.id, undefined, D); return d.id; },
  user_discarded: async (w) => { const d = w.captured(); w.svc.discard(d.id, undefined, D); return d.id; },
};
const STATES = Object.keys(MAKERS) as DeliveryState[];

type Expect = DeliveryState | { refuse: 'delivery_closed' | 'destination_missing' | 'invalid_state' };
interface OpSpec {
  name: string;
  event: string;
  run: (w: World, id: string) => unknown;
  expect: Record<DeliveryState, Expect>;
}
const closed = { refuse: 'delivery_closed' } as const;
const noDest = { refuse: 'destination_missing' } as const;
const wrong = { refuse: 'invalid_state' } as const;

// Written by hand from the product rules, independently of the implementation's own tables.
const OPS: OpSpec[] = [
  {
    name: 'copy', event: 'part_copied', run: (w, id) => w.svc.copy(id, undefined, D),
    expect: {
      report_captured: noDest, destination_missing: noDest, destination_unverified: 'copied', ready_for_handoff: 'copied', copied: 'copied',
      awaiting_user_send: 'copied', user_confirmed_sent: closed, delivery_uncertain: wrong, user_discarded: closed,
    },
  },
  {
    name: 'open', event: 'destination_opened', run: (w, id) => w.svc.open(id, D),
    expect: {
      report_captured: noDest, destination_missing: noDest, destination_unverified: 'destination_unverified', ready_for_handoff: 'ready_for_handoff',
      copied: 'awaiting_user_send', awaiting_user_send: 'awaiting_user_send', user_confirmed_sent: 'user_confirmed_sent', delivery_uncertain: 'delivery_uncertain',
      user_discarded: closed,
    },
  },
  {
    name: 'handoff', event: 'destination_opened', run: (w, id) => w.svc.handoff(id, undefined, D),
    expect: {
      report_captured: noDest, destination_missing: noDest, destination_unverified: 'awaiting_user_send', ready_for_handoff: 'awaiting_user_send', copied: 'awaiting_user_send',
      awaiting_user_send: 'awaiting_user_send', user_confirmed_sent: closed, delivery_uncertain: wrong, user_discarded: closed,
    },
  },
  {
    name: 'confirmSent', event: 'confirmed_sent', run: (w, id) => w.svc.confirmSent(id, 'I pasted it', D),
    expect: {
      report_captured: noDest, destination_missing: noDest, destination_unverified: 'user_confirmed_sent', ready_for_handoff: 'user_confirmed_sent',
      copied: 'user_confirmed_sent', awaiting_user_send: 'user_confirmed_sent', user_confirmed_sent: closed, delivery_uncertain: 'user_confirmed_sent', user_discarded: closed,
    },
  },
  {
    name: 'markUncertain', event: 'marked_uncertain', run: (w, id) => w.svc.markUncertain(id, 'not sure', D),
    expect: {
      report_captured: wrong, destination_missing: wrong, destination_unverified: wrong, ready_for_handoff: wrong, copied: 'delivery_uncertain',
      awaiting_user_send: 'delivery_uncertain', user_confirmed_sent: 'delivery_uncertain', delivery_uncertain: wrong, user_discarded: closed,
    },
  },
  {
    name: 'discard', event: 'discarded', run: (w, id) => w.svc.discard(id, 'not needed', D),
    expect: {
      report_captured: 'user_discarded', destination_missing: 'user_discarded', destination_unverified: 'user_discarded', ready_for_handoff: 'user_discarded',
      copied: 'user_discarded', awaiting_user_send: 'user_discarded', user_confirmed_sent: closed, delivery_uncertain: 'user_discarded', user_discarded: closed,
    },
  },
  {
    name: 'reopen', event: 'reopened', run: (w, id) => w.svc.reopen(id, 'try again', D),
    expect: {
      report_captured: wrong, destination_missing: wrong, destination_unverified: wrong, ready_for_handoff: wrong, copied: wrong, awaiting_user_send: wrong,
      user_confirmed_sent: closed, delivery_uncertain: 'ready_for_handoff', user_discarded: 'ready_for_handoff',
    },
  },
  {
    name: 'setDestination', event: 'destination_changed',
    run: (w, id) => {
      if (!w.projects.conversations.get('cnv_other')) w.projects.addConversation('prj_gm', { id: 'cnv_other', title: 'Second chat', verification: 'verified' });
      return w.svc.setDestination(id, 'cnv_other', D);
    },
    expect: {
      report_captured: wrong, destination_missing: 'ready_for_handoff', destination_unverified: 'ready_for_handoff', ready_for_handoff: 'ready_for_handoff',
      copied: 'ready_for_handoff', awaiting_user_send: 'ready_for_handoff', user_confirmed_sent: closed, delivery_uncertain: 'ready_for_handoff', user_discarded: closed,
    },
  },
];

afterEach(() => { vi.useRealTimers(); });

describe('deliveries: every transition, allowed and refused', () => {
  for (const op of OPS) {
    describe(op.name, () => {
      it.each(STATES)(`from %s`, async (from) => {
        const w = world();
        const id = await MAKERS[from](w);
        expect(w.svc.get(id)!.state).toBe(from);
        const before = snapshot(w, id);
        w.env.clearEvents();
        w.native.calls.length = 0;
        const want = op.expect[from];

        if (typeof want === 'object') {
          const err = await failure(() => op.run(w, id));
          expect(err).toMatchObject({ status: 409, code: want.refuse });
          expect(err.message).toMatch(/\S/);
          expect(hasEmDash(err.message)).toBe(false);
          // refused means untouched: no row change, no audit event, no bus event, nothing asked of the host
          expect(snapshot(w, id)).toEqual(before);
          expect(w.env.of('delivery.upserted')).toEqual([]);
          expect(w.native.calls.filter((c) => c !== 'capabilities')).toEqual([]);
        } else {
          w.env.clock.advance(60_000);
          await op.run(w, id);
          const after = w.svc.get(id)!;
          expect(after.state).toBe(want);
          const added = after.events.slice(before.events.length);
          expect(added.length).toBeGreaterThan(0);
          // the audit events form an unbroken chain from the state it was in to the state it is in
          expect(added[0].from).toBe(from);
          for (let i = 1; i < added.length; i++) expect(added[i].from).toBe(added[i - 1].to);
          expect(added.at(-1)!.to).toBe(want);
          const own = added.filter((e) => e.type === op.event).pop();
          expect(own).toBeDefined();
          expect(own!.actor).toEqual(D);
          // "state changed at" moves only when the state does; "updated at" moves on every change
          // (handoff from awaiting_user_send passes through "copied" on its way back, which the chain above shows)
          const passedThroughAnotherState = added.some((e) => e.from !== e.to);
          expect(after.updatedAt).toBe(w.env.clock.iso());
          expect(after.stateChangedAt).toBe(passedThroughAnotherState ? w.env.clock.iso() : before.row.state_changed_at);
          expect(passedThroughAnotherState).toBe(want !== from || op.name === 'handoff' && from === 'awaiting_user_send');
          expect(w.env.of('delivery.upserted').length).toBeGreaterThanOrEqual(1);
          expect(w.env.of('delivery.upserted').at(-1)!.delivery.state).toBe(want);
        }
      });
    });
  }

  it('uses the exact refusal wording a person can act on', async () => {
    const w = world();
    const missing = await MAKERS.destination_missing(w);
    expect((await failure(() => w.svc.copy(missing, undefined, D))).message).toBe('This report has no ChatGPT conversation to go to yet. Choose a conversation for it first.');
    const sent = await MAKERS.user_confirmed_sent(w);
    expect((await failure(() => w.svc.discard(sent, undefined, D))).message).toBe('This handoff is already marked as sent, so it cannot be discarded.');
    const gone = await MAKERS.user_discarded(w);
    expect((await failure(() => w.svc.copy(gone, undefined, D))).message).toMatch(/was discarded.*Reopen it first/);
    const unsure = await MAKERS.delivery_uncertain(w);
    expect((await failure(() => w.svc.copy(unsure, undefined, D))).message).toMatch(/marked as uncertain.*Reopen it to try again/);
  });

  it('answers 404 not_found for an unknown delivery, whatever is asked', async () => {
    const w = world();
    for (const call of [() => w.svc.copy('nope', undefined, D), () => w.svc.open('nope', D), () => w.svc.confirmSent('nope', undefined, D), () => w.svc.prepare('nope', D),
      () => w.svc.part('nope', 1), () => w.svc.setReview('nope', 'closed', null, D), () => w.svc.saveFile('nope', D)]) {
      expect(await failure(call)).toMatchObject({ status: 404, code: 'not_found' });
    }
    expect(w.svc.get('nope')).toBeNull();
    expect(w.svc.markFollowUpSent('nope', 'act_1')).toBeNull();
  });
});

describe('deliveries: onReportCaptured and the destination it freezes', () => {
  it('creates the delivery, freezes the preferred conversation and says why, with two audit events and one bus event', () => {
    const w = world();
    const report = w.report();
    const d = w.svc.onReportCaptured(report);
    expect(d).toMatchObject({
      reportId: report.id, projectId: 'prj_gm', projectName: 'GitManager', sessionKey: KEY_A, taskTitle: 'Fix login', state: 'ready_for_handoff', review: 'none',
      includeReviewRequest: true, messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null,
      createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z', stateChangedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(d.destination).toEqual({
      conversationId: 'cnv_gm', url: w.gmChat.url, title: 'GitManager review', chatgptConversationId: w.gmChat.chatgptConversationId, resolvedFrom: 'project_preferred',
      verificationAtFreeze: 'verified', frozenAt: '2026-10-30T10:00:00.000Z',
    });
    const events = eventsOf(w, d.id);
    expect(events.map((e) => [e.type, e.from, e.to, e.actor])).toEqual([
      ['created', null, 'report_captured', { kind: 'system' }],
      ['destination_resolved', 'report_captured', 'ready_for_handoff', { kind: 'system' }],
    ]);
    expect(events[1].detail).toMatchObject({ destination: { conversationId: 'cnv_gm', resolvedFrom: 'project_preferred' }, reason: null });
    expect(w.env.of('delivery.upserted')).toEqual([{ type: 'delivery.upserted', delivery: d }]);
  });

  it('resolves in this order: the session\'s own conversation, the preferred one, the only one, otherwise none', () => {
    const w = world();
    const second = w.projects.addConversation('prj_gm', { id: 'cnv_second', title: 'Session chat', verification: 'verified' });
    w.sessions.bindings.set(KEY_B, second.id);
    w.sessions.add({ key: KEY_B, projectId: 'prj_gm', projectName: 'GitManager' });
    const bound = w.captured({ sessionKey: KEY_B });
    expect(bound.destination).toMatchObject({ conversationId: 'cnv_second', resolvedFrom: 'session_binding' });
    expect(w.captured({ sessionKey: KEY_A }).destination).toMatchObject({ conversationId: 'cnv_gm', resolvedFrom: 'project_preferred' });

    const solo = w.projects.addProject({ id: 'prj_solo', name: 'Solo' });
    const only = w.projects.addConversation(solo.id, { id: 'cnv_solo', verification: 'verified' });
    expect(w.captured({ projectId: solo.id, projectName: 'Solo' }).destination).toMatchObject({ conversationId: only.id, resolvedFrom: 'only_conversation' });

    const many = w.projects.addProject({ id: 'prj_many', name: 'Many' });
    w.projects.addConversation(many.id, { verification: 'verified' });
    w.projects.addConversation(many.id, { verification: 'verified' });
    const none = w.captured({ projectId: many.id, projectName: 'Many' });
    expect(none).toMatchObject({ state: 'destination_missing', destination: null });
    expect(eventsOf(w, none.id)[1].detail.reason).toMatch(/2 conversations and none is the preferred one/);

    const empty = w.projects.addProject({ id: 'prj_empty', name: 'Empty' });
    const nothing = w.captured({ projectId: empty.id, projectName: 'Empty' });
    expect(nothing.state).toBe('destination_missing');
    expect(eventsOf(w, nothing.id)[1].detail.reason).toMatch(/No ChatGPT conversation is mapped/);
  });

  it.each([
    ['verified', 'ready_for_handoff'], ['unverified', 'destination_unverified'], ['mismatch', 'destination_unverified'],
    ['unreachable', 'destination_unverified'], ['login_required', 'destination_unverified'],
  ] as const)('a %s conversation gives %s', (verification, state) => {
    const w = world();
    w.projects.editConversation('cnv_gm', { verification });
    const d = w.captured();
    expect(d.state).toBe(state);
    expect(d.destination!.verificationAtFreeze).toBe(verification);
  });

  it('a report with no project has no destination, even when its session has a conversation bound', () => {
    const w = world();
    w.sessions.bindings.set(KEY_B, 'cnv_gm');
    const d = w.svc.onReportCaptured(w.reports.add({ projectId: null, projectName: null, sessionKey: KEY_B }));
    expect(d).toMatchObject({ state: 'destination_missing', destination: null, projectId: null, projectName: null });
    expect(eventsOf(w, d.id)[1].detail.reason).toMatch(/not assigned to a project/);
  });

  it('does not use a conversation that belongs to another project, or one that no longer exists, and says so', () => {
    const w = world();
    const other = w.projects.addProject({ id: 'prj_other', name: 'Other' });
    const foreign = w.projects.addConversation(other.id, { id: 'cnv_foreign', verification: 'verified' });
    w.sessions.bindings.set(KEY_A, foreign.id);
    const d = w.captured();
    expect(d.destination).toMatchObject({ conversationId: 'cnv_gm', resolvedFrom: 'project_preferred' });
    expect(eventsOf(w, d.id)[1].detail.skipped).toEqual([expect.stringMatching(/session_binding.*another project/)]);
    w.sessions.bindings.set(KEY_A, 'cnv_deleted');
    const e = w.captured();
    expect(e.destination!.conversationId).toBe('cnv_gm');
    expect(eventsOf(w, e.id)[1].detail.skipped).toEqual([expect.stringMatching(/no longer exists/)]);
  });

  it('is idempotent under replay: one delivery, two events, one bus event, whoever asks', () => {
    const w = world();
    const report = w.report();
    const first = w.svc.onReportCaptured(report);
    w.env.clearEvents();
    const again = [w.svc.onReportCaptured(report), w.svc.onReportCaptured(report), createDeliveriesService(w.deps).onReportCaptured(report)];
    for (const d of again) expect(d).toEqual(first);
    expect(w.svc.list({ reportId: report.id })).toHaveLength(1);
    expect(typesOf(w, first.id)).toEqual(['created', 'destination_resolved']);
    expect(w.env.events).toEqual([]);
    expect(rowOf(w, first.id).auto_key).toBe(report.id);
  });

  it('keeps a delivery even when the destination lookup itself breaks', () => {
    const w = world();
    const broken = { ...w.deps, projects: { get: () => { throw new Error('projects store is down'); }, conversations: w.projects.conversations } };
    const d = createDeliveriesService(broken).onReportCaptured(w.report());
    expect(d).toMatchObject({ state: 'destination_missing', destination: null });
    expect(w.env.log.errors()).toHaveLength(1);
    expect(eventsOf(w, d.id)[1].detail.reason).toMatch(/could not look up/);
  });

  it('asks for a review only when there is a review request to send', () => {
    expect(world().captured().includeReviewRequest).toBe(true);
    const w = world({ settings: { review: { requestTemplate: '   ' } } });
    expect(w.captured().includeReviewRequest).toBe(false);
  });
});

describe('deliveries: the destination stays frozen', () => {
  it('a report captured after the preferred conversation changed goes there; the earlier one does not move', () => {
    const w = world();
    const before = w.captured();
    const newer = w.projects.addConversation('prj_gm', { id: 'cnv_new', title: 'New thread', verification: 'verified' });
    w.projects.setPreferred('prj_gm', newer.id);
    const after = w.captured();
    expect(after.destination!.conversationId).toBe('cnv_new');
    expect(w.svc.get(before.id)!.destination).toEqual(before.destination);
    expect(w.svc.get(before.id)!.destination!.conversationId).toBe('cnv_gm');
    w.projects.setPreferred('prj_gm', null);
    expect(w.svc.get(before.id)!.destination!.conversationId).toBe('cnv_gm');
    expect(w.svc.get(after.id)!.destination!.conversationId).toBe('cnv_new');
  });

  it('editing or deleting the conversation afterwards changes nothing: copy and open use the frozen address', async () => {
    const w = world();
    const d = w.captured();
    const frozenUrl = d.destination!.url;
    w.projects.editConversation('cnv_gm', { url: 'https://chatgpt.com/c/ffffffff-ffff-4fff-8fff-ffffffffffff', title: 'Renamed', verification: 'mismatch' });
    expect(w.svc.get(d.id)!.destination).toEqual(d.destination);
    await w.svc.open(d.id, D);
    expect(w.native.opened.map((o) => o.url)).toEqual([frozenUrl]);
    w.projects.removeConversation('cnv_gm');
    const again = await w.svc.handoff(d.id, undefined, D);
    expect(w.native.opened.map((o) => o.url)).toEqual([frozenUrl, frozenUrl]);
    expect(again.delivery.destination).toEqual(d.destination);
    expect(again.delivery.state).toBe('awaiting_user_send');
  });

  it('a later change of the session\'s own conversation does not move an existing delivery', () => {
    const w = world();
    const d = w.captured();
    w.sessions.bindings.set(KEY_A, w.projects.addConversation('prj_gm', { id: 'cnv_x', verification: 'verified' }).id);
    expect(w.svc.get(d.id)!.destination!.conversationId).toBe('cnv_gm');
  });

  it('whatever tab is in front, the report goes to the mapped conversation', async () => {
    const w = world();
    const d = w.captured();
    const focused = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
    w.native.openImpl = (url) => okOpen(url, { finalUrl: focused });
    await w.svc.open(d.id, D);
    expect(w.native.opened[0].url).toBe(d.destination!.url);
    expect(w.svc.get(d.id)!.destination!.url).toBe(d.destination!.url);
  });

  it('only setDestination moves it, and records old and new', () => {
    const w = world();
    const d = w.captured();
    const other = w.projects.addConversation('prj_gm', { id: 'cnv_other', title: 'Elsewhere', verification: 'unverified' });
    w.env.clock.advance(60_000);
    const moved = w.svc.setDestination(d.id, other.id, D);
    expect(moved.destination).toEqual({
      conversationId: 'cnv_other', url: other.url, title: 'Elsewhere', chatgptConversationId: other.chatgptConversationId, resolvedFrom: 'user_selected',
      verificationAtFreeze: 'unverified', frozenAt: '2026-10-30T10:01:00.000Z',
    });
    expect(moved.state).toBe('destination_unverified');
    const event = eventsOf(w, d.id).at(-1)!;
    expect(event).toMatchObject({ type: 'destination_changed', from: 'ready_for_handoff', to: 'destination_unverified', actor: D });
    expect(event.detail).toMatchObject({
      from: { conversationId: 'cnv_gm', title: 'GitManager review', resolvedFrom: 'project_preferred' },
      to: { conversationId: 'cnv_other', title: 'Elsewhere', resolvedFrom: 'user_selected' }, previousState: 'ready_for_handoff', otherProject: false,
    });
    expect(moved.stateChangedAt).toBe('2026-10-30T10:01:00.000Z');
  });

  it('setDestination clears the copy marks and the old error, recomputes the state and refuses unknown conversations', async () => {
    const w = world({ settings: { review: { maxPartChars: 2000 } } });
    const d = w.captured({ body: bigBody(9000) });
    await w.svc.copy(d.id, 2, D);
    w.native.openImpl = () => okOpen('x', { ok: false, opened: false, verified: null, note: 'Offline.' });
    await w.svc.open(d.id, D);
    expect(w.svc.get(d.id)).toMatchObject({ state: 'copied', lastError: 'Offline.' });
    expect(w.svc.get(d.id)!.parts.some((p) => p.copiedAt !== null)).toBe(true);
    const other = w.projects.addConversation('prj_gm', { id: 'cnv_other', verification: 'verified' });
    const moved = w.svc.setDestination(d.id, other.id, D);
    expect(moved).toMatchObject({ state: 'ready_for_handoff', lastError: null });
    expect(moved.parts.every((p) => p.copiedAt === null)).toBe(true);
    expect(moved.parts.length).toBeGreaterThan(1);
    expect(await failure(() => w.svc.setDestination(d.id, 'cnv_nope', D))).toMatchObject({ status: 404, code: 'not_found' });
    expect(w.svc.get(d.id)!.destination!.conversationId).toBe('cnv_other');
  });

  it('can choose a conversation for a delivery that had none, and may point at another project\'s conversation on purpose', () => {
    const w = world();
    const d = w.svc.onReportCaptured(w.reports.add({ projectId: null, projectName: null }));
    expect(d.state).toBe('destination_missing');
    const fixed = w.svc.setDestination(d.id, 'cnv_gm', D);
    expect(fixed).toMatchObject({ state: 'ready_for_handoff' });
    expect(eventsOf(w, d.id).at(-1)).toMatchObject({ type: 'destination_changed', from: 'destination_missing', to: 'ready_for_handoff' });
    expect(eventsOf(w, d.id).at(-1)!.detail).toMatchObject({ from: null, otherProject: true });
  });
});

describe('deliveries: several projects at once', () => {
  it('two reports from two projects and sessions each go to their own conversation, even when handed off together', async () => {
    const w = world();
    const billing = w.projects.addProject({ id: 'prj_bill', name: 'Billing' });
    const billChat = w.projects.addConversation(billing.id, { id: 'cnv_bill', title: 'Billing chat', verification: 'verified' });
    w.projects.setPreferred(billing.id, billChat.id);
    w.sessions.add({ key: KEY_B, projectId: billing.id, projectName: 'Billing' });
    const gm = w.captured({ body: 'GitManager report body' });
    const bill = w.captured({ projectId: billing.id, projectName: 'Billing', sessionKey: KEY_B, taskTitle: 'Invoice rounding', body: 'Billing report body' });
    expect([gm.destination!.conversationId, bill.destination!.conversationId]).toEqual(['cnv_gm', 'cnv_bill']);
    await Promise.all([w.svc.handoff(gm.id, undefined, D), w.svc.handoff(bill.id, undefined, D)]);
    expect([...w.native.opened.map((o) => o.url)].sort()).toEqual([w.gmChat.url, billChat.url].sort());
    const written = w.native.clipboardWrites;
    expect(written.find((t) => t.includes('GitManager report body'))).toContain('Project: GitManager');
    expect(written.find((t) => t.includes('Billing report body'))).toContain('Project: Billing');
    expect(written.find((t) => t.includes('Billing report body'))).not.toContain('GitManager');
    expect(w.svc.get(gm.id)).toMatchObject({ state: 'awaiting_user_send', destination: { conversationId: 'cnv_gm' } });
    expect(w.svc.get(bill.id)).toMatchObject({ state: 'awaiting_user_send', destination: { conversationId: 'cnv_bill' } });
    expect(w.svc.list({ projectId: billing.id }).map((x) => x.id)).toEqual([bill.id]);
  });

  it('four projects with interleaved reports never cross', () => {
    const w = world();
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    const keys = [KEY_A, KEY_B, KEY_C, 'win|d4e5f6a7-5555-4555-8555-555555555555' as const];
    const setups = names.map((name, i) => {
      const p = w.projects.addProject({ name });
      const c = w.projects.addConversation(p.id, { title: `${name} chat`, verification: 'verified' });
      w.projects.setPreferred(p.id, c.id);
      w.sessions.add({ key: keys[i], projectId: p.id, projectName: name });
      return { p, c, key: keys[i] };
    });
    const order = [2, 0, 3, 1, 0, 2, 1, 3];
    const made = order.map((i) => ({ i, d: w.captured({ projectId: setups[i].p.id, projectName: names[i], sessionKey: setups[i].key }) }));
    for (const { i, d } of made) {
      expect(d.destination!.conversationId).toBe(setups[i].c.id);
      expect(d.projectId).toBe(setups[i].p.id);
    }
  });

  it('two sessions of one project can report to different conversations when one was bound', () => {
    const w = world();
    const special = w.projects.addConversation('prj_gm', { id: 'cnv_special', verification: 'verified' });
    w.sessions.add({ key: KEY_B, projectId: 'prj_gm', projectName: 'GitManager' });
    w.sessions.bindings.set(KEY_B, special.id);
    expect(w.captured({ sessionKey: KEY_A }).destination!.conversationId).toBe('cnv_gm');
    expect(w.captured({ sessionKey: KEY_B }).destination!.conversationId).toBe('cnv_special');
  });
});

describe('deliveries: create (an additional or redone delivery)', () => {
  it('makes a second delivery for the same report to a conversation the user picks', () => {
    const w = world();
    const report = w.report();
    const auto = w.svc.onReportCaptured(report);
    const other = w.projects.addConversation('prj_gm', { id: 'cnv_other', title: 'Other thread', verification: 'verified' });
    const manual = w.svc.create(report.id, { conversationId: other.id }, D);
    expect(manual.id).not.toBe(auto.id);
    expect(manual).toMatchObject({ reportId: report.id, state: 'ready_for_handoff', destination: { conversationId: 'cnv_other', resolvedFrom: 'user_selected' } });
    expect(rowOf(w, manual.id).auto_key).toBeNull();
    expect(w.svc.list({ reportId: report.id }).map((x) => x.id)).toEqual([auto.id, manual.id]);
    expect(eventsOf(w, manual.id).map((e) => [e.type, e.actor.kind])).toEqual([['created', 'desktop'], ['destination_resolved', 'desktop']]);
    expect(w.svc.create(report.id, { conversationId: other.id }, D).id).not.toBe(manual.id); // another click is another delivery
  });

  it('without a conversation it resolves again from the mappings (a redo)', () => {
    const w = world();
    const report = w.report();
    const auto = w.svc.onReportCaptured(report);
    w.svc.discard(auto.id, 'wrong', D);
    const redo = w.svc.create(report.id, {}, D);
    expect(redo).toMatchObject({ state: 'ready_for_handoff', destination: { conversationId: 'cnv_gm', resolvedFrom: 'project_preferred' } });
  });

  it('can leave out the review request, and works for a report that came from no project', () => {
    const w = world();
    const orphan = w.reports.add({ projectId: null, projectName: null });
    const d = w.svc.create(orphan.id, { conversationId: 'cnv_gm', includeReviewRequest: false }, PHONE);
    expect(d).toMatchObject({ projectId: null, includeReviewRequest: false, state: 'ready_for_handoff' });
    expect(eventsOf(w, d.id)[0].actor).toEqual(PHONE);
  });

  it('refuses an unknown report or conversation with 404 and creates nothing', async () => {
    const w = world();
    const report = w.report();
    expect(await failure(() => w.svc.create('nope', {}, D))).toMatchObject({ status: 404 });
    expect(await failure(() => w.svc.create(report.id, { conversationId: 'nope' }, D))).toMatchObject({ status: 404, code: 'not_found' });
    expect(w.svc.list({})).toEqual([]);
  });
});

describe('deliveries: the message', () => {
  it('carries project, task, session, id, time, declared status and the full body between fences, then the review request', () => {
    const w = world();
    const body = '## Report\n\n  indented  line\n\ttab\n--- END ---\n```ts\nconst x = 1;\n```\n<!-- mini-summa:report status=complete task="Fix login" -->';
    const report = w.report({ body, generation: 3 });
    const d = w.svc.onReportCaptured(report);
    const { message, partCount, delivery } = w.svc.prepare(d.id, D);
    const expected = buildReportMessage({
      reportId: report.id, projectName: 'GitManager', taskTitle: 'Fix login', sessionRef: 'a1b2c3d4, managed, Windows, generation 3', declaredStatus: 'complete',
      capturedAt: '2026-10-30T09:59:00.000Z', body, reviewRequest: w.settings.get().review.requestTemplate, includeSessionRef: true,
    });
    expect(message).toBe(expected);
    expect(message).toContain(`${fenceBegin(report.id)}\n${body}\n${fenceEnd(report.id)}`);
    expect(message).toContain('Claude session: a1b2c3d4, managed, Windows, generation 3');
    expect(message).toContain('Captured: 2026-10-30T09:59:00.000Z');
    expect(message).toContain('Status declared by Claude: complete');
    expect(message.endsWith(w.settings.get().review.requestTemplate.trim())).toBe(true);
    expect(partCount).toBe(1);
    expect(delivery).toMatchObject({ messageSha256: sha256(message), messageChars: message.length, parts: [{ index: 1, total: 1, chars: message.length, sha256: sha256(message), copiedAt: null }] });
    expect(w.svc.part(d.id, 1)).toEqual({ index: 1, total: 1, text: message, sha256: sha256(message) });
  });

  it('describes the session as it is: external, WSL, or no longer known', () => {
    const w = world();
    w.sessions.add({ key: KEY_B, origin: 'external', projectId: 'prj_gm', projectName: 'GitManager' });
    w.sessions.add({ key: KEY_C, env: 'wsl:Ubuntu', projectId: 'prj_gm', projectName: 'GitManager' });
    const ref = (key: typeof KEY_A, generation = 1) => {
      const d = w.captured({ sessionKey: key, env: key.startsWith('wsl') ? 'wsl:Ubuntu' : 'win', generation });
      return w.svc.prepare(d.id, D).message.match(/Claude session: (.*)/)![1];
    };
    expect(ref(KEY_B)).toBe('b2c3d4e5, external, Windows, generation 1');
    expect(ref(KEY_C, 2)).toBe('c3d4e5f6, managed, WSL (Ubuntu), generation 2');
    expect(ref('win|99999999-0000-4000-8000-000000000000' as typeof KEY_A)).toBe('99999999, origin unknown, Windows, generation 1');
  });

  it('leaves out the session line when the setting says so, and the review request when it is off or empty', () => {
    const w = world({ settings: { review: { includeSessionRef: false } } });
    const withoutRef = w.svc.prepare(w.captured().id, D).message;
    expect(withoutRef).not.toContain('Claude session:');
    const report = w.report();
    const bare = w.svc.create(report.id, { includeReviewRequest: false }, D);
    const text = w.svc.prepare(bare.id, D).message;
    expect(text.trimEnd().endsWith(fenceEnd(report.id))).toBe(true);
    const empty = world({ settings: { review: { requestTemplate: '' } } });
    expect(empty.svc.prepare(empty.captured().id, D).message.trimEnd().endsWith(fenceEnd(empty.reports.require(empty.svc.list({})[0].reportId).id))).toBe(true);
  });

  it('is prepared once: asking again changes nothing, records nothing and emits nothing', () => {
    const w = world();
    const d = w.captured();
    const first = w.svc.prepare(d.id, D);
    expect(typesOf(w, d.id)).toEqual(['created', 'destination_resolved', 'prepared']);
    const stamp = rowOf(w, d.id).updated_at;
    w.env.clock.advance(5000);
    w.env.clearEvents();
    expect(w.svc.prepare(d.id, D)).toEqual(first);
    expect(rowOf(w, d.id).updated_at).toBe(stamp);
    expect(typesOf(w, d.id)).toEqual(['created', 'destination_resolved', 'prepared']);
    expect(w.env.events).toEqual([]);
    expect(eventsOf(w, d.id)[2].detail).toMatchObject({ sha256: first.delivery.messageSha256, partCount: 1, reviewRequestIncluded: true, replacedEarlierMessage: false });
  });

  it('is prepared again when the settings changed, and says it replaced the earlier message', () => {
    const w = world();
    const d = w.captured();
    const first = w.svc.prepare(d.id, D);
    w.settings.set({ review: { requestTemplate: 'Please review. Be brief.' } });
    const second = w.svc.prepare(d.id, PHONE);
    expect(second.message).not.toBe(first.message);
    expect(second.message.endsWith('Please review. Be brief.')).toBe(true);
    expect(second.delivery.messageSha256).toBe(sha256(second.message));
    expect(eventsOf(w, d.id).at(-1)).toMatchObject({ type: 'prepared', actor: PHONE });
    expect(eventsOf(w, d.id).at(-1)!.detail).toMatchObject({ replacedEarlierMessage: true });
  });

  it('serves a part number that does not exist as 400 part_out_of_range', async () => {
    const w = world();
    const d = w.captured();
    for (const n of [0, 2, -1, 1.5, Number.NaN]) expect(await failure(() => w.svc.part(d.id, n))).toMatchObject({ status: 400, code: 'part_out_of_range' });
    expect(await failure(() => w.svc.copy(d.id, 2, D))).toMatchObject({ status: 400, code: 'part_out_of_range' });
    // refused means untouched: not even the message was prepared on the way
    expect(w.svc.get(d.id)!.parts).toEqual([]);
    expect(rowOf(w, d.id).message).toBeNull();
    expect(typesOf(w, d.id)).toEqual(['created', 'destination_resolved']);
  });

  it('prepares on demand when a part is asked for first', () => {
    const w = world();
    const d = w.captured();
    expect(rowOf(w, d.id).message).toBeNull();
    const part = w.svc.part(d.id, 1);
    expect(part.text).toContain('Project: GitManager');
    expect(w.svc.get(d.id)!.messageSha256).toBe(part.sha256);
    expect(eventsOf(w, d.id).at(-1)).toMatchObject({ type: 'prepared', actor: { kind: 'system' } });
  });

  it('keeps the record of what was sent: a closed delivery returns its stored message and is never rewritten', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.copy(d.id, undefined, D);
    w.svc.confirmSent(d.id, undefined, D);
    const stored = w.svc.get(d.id)!;
    w.settings.set({ review: { requestTemplate: 'A completely different request.' } });
    const again = w.svc.prepare(d.id, D);
    expect(again.message).toContain('Please review this implementation report');
    expect(again.message).not.toContain('A completely different request.');
    expect(w.svc.get(d.id)).toEqual(stored);
    expect(w.svc.part(d.id, 1).text).toBe(again.message);
    // never prepared and closed: nothing to show, and nothing is invented afterwards
    const lonely = await MAKERS.user_confirmed_sent(w);
    expect(await failure(() => w.svc.prepare(lonely, D))).toMatchObject({ status: 409, code: 'delivery_closed' });
    expect(await failure(() => w.svc.part(lonely, 1))).toMatchObject({ status: 409, code: 'delivery_closed' });
    expect(rowOf(w, lonely).message).toBeNull();
  });
});

describe('deliveries: long reports are split into parts, copied one by one', () => {
  const LIMIT = 2000;
  const setup = () => {
    const w = world({ settings: { review: { maxPartChars: LIMIT } } });
    const body = bigBody(40_000);
    const report = w.report({ body });
    const d = w.svc.onReportCaptured(report);
    return { w, body, report, d };
  };

  it('splits a 40 KB report at a 2 KB limit losslessly, with a hash and size for every part', () => {
    const { w, body, report, d } = setup();
    const { message, partCount, delivery } = w.svc.prepare(d.id, D);
    expect(message).toContain(body);
    expect(partCount).toBeGreaterThan(20);
    expect(delivery.parts).toHaveLength(partCount);
    const expected = splitMessage(message, report.id, LIMIT);
    expect(joinPayloads(expected)).toBe(message);
    const texts: string[] = [];
    for (let i = 1; i <= partCount; i++) {
      const part = w.svc.part(d.id, i);
      texts.push(part.text);
      expect(part.text).toBe(expected[i - 1].text);
      expect(part.text.length).toBeLessThanOrEqual(LIMIT);
      expect(part).toMatchObject({ index: i, total: partCount, sha256: sha256(part.text) });
      expect(delivery.parts[i - 1]).toEqual({ index: i, total: partCount, chars: part.text.length, sha256: part.sha256, copiedAt: null });
    }
    expect(texts[0]).toMatch(new RegExp(`^\\[Mini-Summa report ${report.id.slice(0, 8)}, part 1 of ${partCount}\\]`));
    expect(texts[partCount - 1]).toMatch(/That was the complete report/);
    expect(joinPayloads(expected.map((p, i) => ({ ...p, payload: p.payload, text: texts[i] })))).toBe(message);
  });

  it('copies part 2 first and then part 1: each is marked on its own, and the attempt count follows part 1', async () => {
    const { w, d } = setup();
    const total = w.svc.prepare(d.id, D).partCount;
    const second = await w.svc.copy(d.id, 2, D);
    expect(second).toMatchObject({ part: 2, partCount: total, clipboard: 'native', text: null });
    expect(w.native.clipboardWrites).toEqual([w.svc.part(d.id, 2).text]);
    let now = w.svc.get(d.id)!;
    expect(now.state).toBe('copied');
    expect(now.attempts).toBe(0);
    expect(now.parts.map((p) => p.copiedAt !== null)).toEqual(now.parts.map((_, i) => i === 1));
    expect(now.parts[1].copiedAt).toBe('2026-10-30T10:00:00.000Z');

    w.env.clock.advance(1000);
    const first = await w.svc.copy(d.id, 1, D);
    expect(first.part).toBe(1);
    now = w.svc.get(d.id)!;
    expect(now.attempts).toBe(1);
    expect(now.parts.map((p) => p.copiedAt !== null).slice(0, 3)).toEqual([true, true, false]);
    expect(now.parts[0].copiedAt).toBe('2026-10-30T10:00:01.000Z');
    expect(w.native.clipboardWrites).toEqual([w.svc.part(d.id, 2).text, w.svc.part(d.id, 1).text]);

    const copyEvents = eventsOf(w, d.id).filter((e) => e.type === 'part_copied');
    expect(copyEvents.map((e) => e.detail.part)).toEqual([2, 1]);
    expect(copyEvents.map((e) => e.detail.sha256)).toEqual([w.svc.part(d.id, 2).sha256, w.svc.part(d.id, 1).sha256]);
  });

  it('without a part number it copies the first part not yet copied, and starts over when all are', async () => {
    const { w, d } = setup();
    const total = w.svc.prepare(d.id, D).partCount;
    await w.svc.copy(d.id, 2, D);
    const order: number[] = [];
    for (let i = 0; i < total - 1; i++) order.push((await w.svc.copy(d.id, undefined, D)).part);
    expect(order).toEqual([1, ...Array.from({ length: total - 2 }, (_, i) => i + 3)]);
    expect(w.svc.get(d.id)!.parts.every((p) => p.copiedAt !== null)).toBe(true);
    expect((await w.svc.copy(d.id, undefined, D)).part).toBe(1);
    expect(w.svc.get(d.id)!.attempts).toBe(2);
    expect(w.native.clipboardWrites).toHaveLength(total + 1);
  });

  it('keeps a part\'s mark through another preparation of the same message, and drops it when the message or the split changes', async () => {
    const { w, d } = setup();
    await w.svc.copy(d.id, 1, D);
    const marked = w.svc.get(d.id)!.parts[0].copiedAt;
    const preparedEvents = () => typesOf(w, d.id).filter((t) => t === 'prepared').length;
    expect(preparedEvents()).toBe(1);
    w.svc.prepare(d.id, D);
    expect(w.svc.get(d.id)!.parts[0].copiedAt).toBe(marked);
    expect(preparedEvents()).toBe(1);

    w.settings.set({ review: { maxPartChars: 2500 } }); // same message, different split
    const resplit = w.svc.prepare(d.id, D);
    expect(resplit.delivery.messageSha256).toBe(w.svc.get(d.id)!.messageSha256);
    expect(resplit.delivery.parts[0].copiedAt).toBeNull();
    expect(resplit.delivery.parts.every((p) => p.copiedAt === null)).toBe(true);

    await w.svc.copy(d.id, 3, D);
    w.settings.set({ review: { requestTemplate: 'Different request.' } }); // different message
    const changed = w.svc.prepare(d.id, D);
    expect(changed.delivery.parts.every((p) => p.copiedAt === null)).toBe(true);
    expect(preparedEvents()).toBe(3);
  });

  it('copying keeps the message it started with: a settings change in the middle of a multi-part copy does not mix texts', async () => {
    const { w, d } = setup();
    await w.svc.copy(d.id, 1, D);
    const startedWith = w.svc.get(d.id)!.messageSha256;
    w.settings.set({ review: { requestTemplate: 'Changed my mind about the request.', includeSessionRef: false } });
    const next = await w.svc.copy(d.id, undefined, D);
    expect(next.part).toBe(2);
    expect(w.svc.get(d.id)!.messageSha256).toBe(startedWith);
    expect(w.native.clipboardWrites[1]).not.toContain('Changed my mind');
  });

  it('two copies at once both get recorded', async () => {
    const { w, d } = setup();
    await Promise.all([w.svc.copy(d.id, 1, D), w.svc.copy(d.id, 2, D)]);
    const parts = w.svc.get(d.id)!.parts;
    expect([parts[0].copiedAt !== null, parts[1].copiedAt !== null, parts[2].copiedAt !== null]).toEqual([true, true, false]);
    expect(w.svc.get(d.id)!.attempts).toBe(1);
  });

  it('survives a body with NUL characters: the stored message is exact and so is every copied part', async () => {
    const w = world({ settings: { review: { maxPartChars: LIMIT } } });
    const body = `start\u0000middle\r\n${bigBody(5000)}\u0000end`;
    const report = w.report({ body });
    const d = w.svc.onReportCaptured(report);
    await w.svc.copy(d.id, 1, D);
    const message = w.svc.prepare(d.id, D).message;
    expect(message).toContain(body);
    await w.svc.copy(d.id, 2, D); // goes through the stored (BLOB) message
    const expected = splitMessage(message, report.id, LIMIT);
    expect(w.native.clipboardWrites).toEqual([expected[0].text, expected[1].text]);
    expect(w.svc.get(d.id)!.messageSha256).toBe(sha256(message));
    expect(message).toBe(buildReportMessage({ reportId: report.id, projectName: 'GitManager', taskTitle: 'Fix login', sessionRef: 'a1b2c3d4, managed, Windows, generation 1',
      declaredStatus: 'complete', capturedAt: '2026-10-30T09:59:00.000Z', body, reviewRequest: w.settings.get().review.requestTemplate, includeSessionRef: true }));
  });
});

describe('deliveries: copy', () => {
  it('writes the exact part text to the clipboard, marks it, counts the attempt and records its hash', async () => {
    const w = world();
    const d = w.captured();
    const result = await w.svc.copy(d.id, undefined, D);
    const part = w.svc.part(d.id, 1);
    expect(w.native.clipboardWrites).toEqual([part.text]);
    expect(result).toMatchObject({ part: 1, partCount: 1, clipboard: 'native', text: null });
    expect(result.delivery).toMatchObject({ state: 'copied', attempts: 1, parts: [{ index: 1, total: 1, sha256: part.sha256, copiedAt: '2026-10-30T10:00:00.000Z' }] });
    expect(typesOf(w, d.id)).toEqual(['created', 'destination_resolved', 'prepared', 'part_copied']);
    expect(eventsOf(w, d.id).at(-1)).toMatchObject({ from: 'ready_for_handoff', to: 'copied', actor: D });
    expect(eventsOf(w, d.id).at(-1)!.detail).toMatchObject({ part: 1, partCount: 1, sha256: part.sha256, clipboard: 'native' });
    expect(w.env.of('delivery.upserted')).toHaveLength(2); // creation, then the copy (preparation and copy are one change)
    await w.svc.copy(d.id, 1, D);
    expect(w.svc.get(d.id)!.attempts).toBe(2);
  });

  it('hands the text to the client when the host has no clipboard', async () => {
    const w = world({ caps: { clipboard: false } });
    const d = w.captured();
    const result = await w.svc.copy(d.id, undefined, D);
    expect(w.native.calls).not.toContain('clipboard.writeText');
    expect(result).toMatchObject({ clipboard: 'client', part: 1, partCount: 1 });
    expect(result.text).toBe(w.svc.part(d.id, 1).text);
    expect(result.delivery.state).toBe('copied');
    expect(eventsOf(w, d.id).at(-1)!.detail).toMatchObject({ clipboard: 'client' });
  });

  it('a clipboard failure is a 502 and changes nothing at all', async () => {
    const w = world({ settings: { review: { maxPartChars: 2000 } } });
    const d = w.captured({ body: bigBody(7000) });
    const before = snapshot(w, d.id);
    w.env.clearEvents();
    w.native.clipboardError = new Error('The clipboard is locked by another application.');
    const err = await failure(() => w.svc.copy(d.id, 2, D));
    expect(err).toMatchObject({ status: 502, code: 'clipboard_failed' });
    expect(err.message).toMatch(/locked by another application/);
    expect(err.message).toMatch(/Nothing was changed/);
    expect(hasEmDash(err.message)).toBe(false);
    expect(snapshot(w, d.id)).toEqual(before);
    expect(rowOf(w, d.id).message).toBeNull(); // not even the prepared message
    expect(w.env.events).toEqual([]);
    // and the same after a successful copy: marks, attempts and message are exactly as they were
    w.native.clipboardError = null;
    await w.svc.copy(d.id, 1, D);
    const mid = snapshot(w, d.id);
    w.native.clipboardError = new Error('still locked');
    await failure(() => w.svc.copy(d.id, 2, D));
    expect(snapshot(w, d.id)).toEqual(mid);
    w.native.clipboardError = null;
    expect((await w.svc.copy(d.id, 2, D)).delivery.parts[1].copiedAt).not.toBeNull();
  });

  it('refuses to copy without a destination, in plain words, and touches nothing', async () => {
    const w = world();
    const id = await MAKERS.destination_missing(w);
    const err = await failure(() => w.svc.copy(id, undefined, D));
    expect(err).toMatchObject({ status: 409, code: 'destination_missing' });
    expect(err.message).toBe('This report has no ChatGPT conversation to go to yet. Choose a conversation for it first.');
    expect(w.native.clipboardWrites).toEqual([]);
    expect(rowOf(w, id).message).toBeNull();
  });
});

describe('deliveries: open', () => {
  it('opens the frozen address, records the host\'s full answer and confirms the conversation when the host saw it', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.copy(d.id, undefined, D);
    const answer = okOpen(d.destination!.url, { mode: 'extension', title: 'GitManager review - ChatGPT', finalUrl: d.destination!.url, note: 'Focused an open tab.' });
    w.native.openImpl = () => answer;
    const result = await w.svc.open(d.id, PHONE);
    expect(result.open).toEqual(answer);
    expect(w.native.opened).toEqual([{ url: d.destination!.url, focus: true, reason: 'handoff' }]);
    expect(result.delivery).toMatchObject({ state: 'awaiting_user_send', lastError: null });
    expect(w.projects.verifications).toEqual([{ id: 'cnv_gm', verification: 'verified', title: 'GitManager review - ChatGPT' }]);
    const events = eventsOf(w, d.id);
    expect(events.at(-2)).toMatchObject({ type: 'destination_opened', from: 'copied', to: 'awaiting_user_send', actor: PHONE });
    expect(events.at(-2)!.detail).toEqual({ result: answer, verification: 'verified' });
    expect(events.at(-1)).toMatchObject({ type: 'destination_verified', from: 'awaiting_user_send', to: 'awaiting_user_send' });
    expect(events.at(-1)!.detail).toEqual({ conversationId: 'cnv_gm', title: 'GitManager review - ChatGPT' });
  });

  it('passes on what the host saw when the page was not the conversation: a sign-in page or a different page', async () => {
    const w = world();
    const d = w.captured();
    w.native.openImpl = () => okOpen('x', { verified: false, note: 'ChatGPT asks you to log in first.' });
    const login = await w.svc.open(d.id, D);
    expect(w.projects.verifications.at(-1)).toEqual({ id: 'cnv_gm', verification: 'login_required', title: undefined });
    expect(login.delivery.lastError).toBe('ChatGPT asks you to log in first.');
    w.native.openImpl = () => okOpen('x', { verified: false, note: 'The page shows a different conversation.' });
    const wrongPage = await w.svc.open(d.id, D);
    expect(w.projects.verifications.at(-1)).toEqual({ id: 'cnv_gm', verification: 'mismatch', title: undefined });
    expect(wrongPage.delivery.lastError).toBe('The page shows a different conversation.');
    w.native.openImpl = () => okOpen('x', { verified: false, note: null });
    expect((await w.svc.open(d.id, D)).delivery.lastError).toMatch(/may not be the conversation/);
    expect(w.projects.verifications.at(-1)!.verification).toBe('mismatch');
  });

  it('records nothing about the conversation when the host could not tell', async () => {
    const w = world();
    const d = w.captured();
    w.native.openImpl = () => okOpen('x', { verified: null });
    await w.svc.open(d.id, D);
    expect(w.projects.verifications).toEqual([]);
    expect(typesOf(w, d.id)).not.toContain('destination_verified');
  });

  it('never claims success when the page did not open: the state stays, the error is kept, the answer is returned', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.copy(d.id, undefined, D);
    const answer = okOpen('x', { ok: false, opened: false, focused: false, verified: null, finalUrl: null, title: null, mode: 'none', note: 'The embedded view could not load ChatGPT.' });
    w.native.openImpl = () => answer;
    const result = await w.svc.open(d.id, D);
    expect(result.open).toEqual(answer);
    expect(result.delivery).toMatchObject({ state: 'copied', lastError: 'The embedded view could not load ChatGPT.' });
    const last = eventsOf(w, d.id).at(-1)!;
    expect(last).toMatchObject({ type: 'note', from: 'copied', to: 'copied' });
    expect(last.detail).toEqual({ action: 'open_failed', result: answer });
    expect(typesOf(w, d.id)).not.toContain('destination_opened');
    expect(w.projects.verifications).toEqual([]);
    // and the next successful open clears the error and advances
    w.native.openImpl = (url) => okOpen(url);
    expect((await w.svc.open(d.id, D)).delivery).toMatchObject({ state: 'awaiting_user_send', lastError: null });
  });

  it('treats a host that throws like a failure to open', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.copy(d.id, undefined, D);
    w.native.openImpl = () => { throw new Error('webContents destroyed'); };
    const result = await w.svc.open(d.id, D);
    expect(result.open).toMatchObject({ ok: false, opened: false, mode: 'none' });
    expect(result.open.note).toMatch(/webContents destroyed/);
    expect(result.delivery).toMatchObject({ state: 'copied', lastError: expect.stringMatching(/webContents destroyed/) });
  });

  it('survives the conversation having been removed while verification is recorded', async () => {
    const w = world();
    const d = w.captured();
    w.projects.failVerification = true;
    const result = await w.svc.open(d.id, D);
    expect(result.open.ok).toBe(true);
    expect(w.env.log.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('does not record on a delivery that was discarded while the page was loading', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.copy(d.id, undefined, D);
    w.native.openImpl = async (url) => { w.svc.discard(d.id, undefined, D); return okOpen(url); };
    const result = await w.svc.open(d.id, D);
    expect(result.open.ok).toBe(true);
    expect(result.delivery.state).toBe('user_discarded');
    expect(typesOf(w, d.id)).not.toContain('destination_opened');
  });
});

describe('deliveries: handoff (copy, then open)', () => {
  it('does both and returns both results', async () => {
    const w = world();
    const d = w.captured();
    const result = await w.svc.handoff(d.id, undefined, D);
    expect(w.native.calls.filter((c) => c !== 'capabilities')).toEqual(['clipboard.writeText', 'chatgpt.open']);
    expect(result).toMatchObject({ part: 1, partCount: 1, clipboard: 'native', text: null, open: { ok: true, verified: true }, delivery: { state: 'awaiting_user_send', attempts: 1 } });
    expect(w.env.of('delivery.upserted').map((e) => e.delivery.state)).toEqual(['ready_for_handoff', 'copied', 'awaiting_user_send']);
  });

  it('does not open anything when the copy failed', async () => {
    const w = world();
    const d = w.captured();
    w.native.clipboardError = new Error('locked');
    expect(await failure(() => w.svc.handoff(d.id, undefined, D))).toMatchObject({ status: 502, code: 'clipboard_failed' });
    expect(w.native.opened).toEqual([]);
    expect(w.svc.get(d.id)!.state).toBe('ready_for_handoff');
  });

  it('keeps the copy and reports the failed open honestly', async () => {
    const w = world();
    const d = w.captured();
    w.native.openImpl = () => okOpen('x', { ok: false, opened: false, verified: null, note: 'Offline.' });
    const result = await w.svc.handoff(d.id, undefined, D);
    expect(result.open.ok).toBe(false);
    expect(result.delivery).toMatchObject({ state: 'copied', lastError: 'Offline.' });
  });

  it('with no clipboard on the host, returns the text so the client can copy it, and still opens', async () => {
    const w = world({ caps: { clipboard: false } });
    const d = w.captured();
    const result = await w.svc.handoff(d.id, undefined, D);
    expect(result).toMatchObject({ clipboard: 'client', open: { ok: true } });
    expect(result.text).toBe(w.svc.part(d.id, 1).text);
  });

  it('copies the part asked for', async () => {
    const w = world({ settings: { review: { maxPartChars: 2000 } } });
    const d = w.captured({ body: bigBody(6000) });
    const result = await w.svc.handoff(d.id, 3, D);
    expect(result.part).toBe(3);
    expect(w.native.clipboardWrites).toEqual([w.svc.part(d.id, 3).text]);
  });
});

describe('deliveries: what the person says', () => {
  it('confirmSent asks for a review when the request was part of the message, and not otherwise', () => {
    const w = world();
    const a = w.captured();
    expect(w.svc.confirmSent(a.id, 'Pasted and sent', D)).toMatchObject({ state: 'user_confirmed_sent', review: 'requested' });
    const noRequest = w.svc.create(w.report().id, { includeReviewRequest: false }, D);
    expect(w.svc.confirmSent(noRequest.id, undefined, D)).toMatchObject({ state: 'user_confirmed_sent', review: 'none' });
    expect(eventsOf(w, a.id).at(-1)).toMatchObject({ type: 'confirmed_sent', from: 'ready_for_handoff', to: 'user_confirmed_sent' });
    expect(eventsOf(w, a.id).at(-1)!.detail).toEqual({ note: 'Pasted and sent', previousState: 'ready_for_handoff', partsCopied: 0, partCount: 0 });
  });

  it('says how many parts were marked copied when the person confirms', async () => {
    const w = world({ settings: { review: { maxPartChars: 2000 } } });
    const d = w.captured({ body: bigBody(9000) });
    await w.svc.copy(d.id, 1, D);
    await w.svc.copy(d.id, 2, D);
    w.svc.confirmSent(d.id, undefined, D);
    const detail = eventsOf(w, d.id).at(-1)!.detail;
    expect(detail).toMatchObject({ partsCopied: 2 });
    expect(detail.partCount as number).toBeGreaterThan(2);
  });

  it('markUncertain sends the review back to none, and confirming again asks for it again', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.handoff(d.id, undefined, D);
    w.svc.confirmSent(d.id, undefined, D);
    w.svc.setReview(d.id, 'received', null, D);
    const unsure = w.svc.markUncertain(d.id, 'Maybe the paste failed', D);
    expect(unsure).toMatchObject({ state: 'delivery_uncertain', review: 'none' });
    expect(eventsOf(w, d.id).at(-1)!.detail).toEqual({ note: 'Maybe the paste failed', previousState: 'user_confirmed_sent', previousReview: 'received' });
    expect(w.svc.confirmSent(d.id, undefined, D)).toMatchObject({ state: 'user_confirmed_sent', review: 'requested' });
  });

  it('reopen recomputes the state from the conversation as it is now, counts an attempt, clears the error and the copy marks', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.copy(d.id, undefined, D);
    w.native.openImpl = () => okOpen('x', { ok: false, opened: false, verified: null, note: 'Offline.' });
    await w.svc.open(d.id, D);
    w.svc.markUncertain(d.id, undefined, D);
    const before = w.svc.get(d.id)!;
    expect(before).toMatchObject({ attempts: 1, lastError: 'Offline.' });
    const reopened = w.svc.reopen(d.id, 'second try', D);
    expect(reopened).toMatchObject({ state: 'ready_for_handoff', attempts: 2, lastError: null });
    expect(reopened.parts.every((p) => p.copiedAt === null)).toBe(true);
    expect(eventsOf(w, d.id).at(-1)).toMatchObject({ type: 'reopened', from: 'delivery_uncertain', to: 'ready_for_handoff' });
    expect(eventsOf(w, d.id).at(-1)!.detail).toEqual({ note: 'second try', previousState: 'delivery_uncertain' });

    w.svc.discard(d.id, undefined, D);
    w.projects.editConversation('cnv_gm', { verification: 'mismatch' });
    expect(w.svc.reopen(d.id, undefined, D)).toMatchObject({ state: 'destination_unverified', attempts: 3 });
  });

  it('reopen trusts a newer verification only for the address that was frozen', () => {
    const unverifiedAtFreeze = () => {
      const w = world();
      w.projects.editConversation('cnv_gm', { verification: 'unverified' });
      const d = w.captured();
      expect(d.state).toBe('destination_unverified');
      w.svc.discard(d.id, undefined, D);
      return { w, d };
    };
    // verified since, same address: the person can go ahead
    const same = unverifiedAtFreeze();
    same.w.projects.editConversation('cnv_gm', { verification: 'verified' });
    expect(same.w.svc.reopen(same.d.id, undefined, D).state).toBe('ready_for_handoff');
    // verified since, but the conversation now has another address: that says nothing about the frozen one
    const moved = unverifiedAtFreeze();
    moved.w.projects.editConversation('cnv_gm', { verification: 'verified', url: 'https://chatgpt.com/c/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    expect(moved.w.svc.reopen(moved.d.id, undefined, D).state).toBe('destination_unverified');
    // the conversation was deleted: fall back to what was known when it was frozen
    const gone = unverifiedAtFreeze();
    gone.w.projects.removeConversation('cnv_gm');
    expect(gone.w.svc.reopen(gone.d.id, undefined, D).state).toBe('destination_unverified');
  });

  it('reopening a delivery that never had a destination keeps saying so', () => {
    const w = world();
    const d = w.svc.onReportCaptured(w.reports.add({ projectId: null, projectName: null }));
    w.svc.discard(d.id, undefined, D);
    expect(w.svc.reopen(d.id, undefined, D)).toMatchObject({ state: 'destination_missing', attempts: 1 });
  });

  it('only moves the state-changed time when the state changes', async () => {
    const w = world();
    const d = w.captured();
    w.env.clock.advance(60_000);
    const copied = await w.svc.copy(d.id, undefined, D);
    expect(copied.delivery).toMatchObject({ stateChangedAt: '2026-10-30T10:01:00.000Z', updatedAt: '2026-10-30T10:01:00.000Z' });
    w.env.clock.advance(60_000);
    const again = await w.svc.copy(d.id, undefined, D);
    expect(again.delivery).toMatchObject({ stateChangedAt: '2026-10-30T10:01:00.000Z', updatedAt: '2026-10-30T10:02:00.000Z' });
  });
});

describe('deliveries: the review, which is only ever the person\'s statement', () => {
  type Review = ReviewState;
  const DRAFT = 'Please also cover the logout path.';
  const REVIEWS: Review[] = ['none', 'requested', 'received', 'follow_up_drafted', 'follow_up_sent', 'closed'];
  // Written by hand: what a person may state, from what.
  const ALLOWED: Record<Review, Review[]> = {
    none: ['closed'],
    requested: ['received', 'follow_up_drafted', 'closed'],
    received: ['follow_up_drafted', 'closed'],
    follow_up_drafted: ['follow_up_drafted', 'closed'],
    follow_up_sent: ['closed'],
    closed: ['received', 'closed'],
  };

  const inReview = (w: World, review: Review): string => {
    const d = w.captured();
    if (review === 'none') return d.id;
    w.svc.confirmSent(d.id, undefined, D);
    if (review === 'requested') return d.id;
    if (review === 'closed') { w.svc.setReview(d.id, 'closed', null, D); return d.id; }
    if (review === 'received') { w.svc.setReview(d.id, 'received', null, D); return d.id; }
    w.svc.setReview(d.id, 'follow_up_drafted', DRAFT, D);
    if (review === 'follow_up_sent') w.svc.markFollowUpSent(d.id, 'act_1');
    return d.id;
  };

  for (const from of REVIEWS) {
    it.each(REVIEWS)(`from ${from} to %s`, async (to) => {
      const w = world();
      const id = inReview(w, from);
      expect(w.svc.get(id)!.review).toBe(from);
      const before = snapshot(w, id);
      w.env.clearEvents();
      if (ALLOWED[from].includes(to)) {
        const after = w.svc.setReview(id, to, to === 'follow_up_drafted' ? DRAFT : null, D);
        expect(after.review).toBe(to);
        expect(after.state).toBe(before.row.state);
        if (from === 'closed' && to === 'closed') {
          expect(snapshot(w, id)).toEqual(before); // already closed: nothing to record
          expect(w.env.events).toEqual([]);
        } else {
          const event = eventsOf(w, id).at(-1)!;
          expect(event.type).toBe(to === 'follow_up_drafted' ? 'follow_up_drafted' : 'review_changed');
          expect(event.detail).toMatchObject({ from, to });
          expect(event.actor).toEqual(D);
          expect(w.env.of('delivery.upserted')).toHaveLength(1);
        }
      } else {
        const err = await failure(() => w.svc.setReview(id, to, to === 'follow_up_drafted' ? DRAFT : null, D));
        expect(err).toMatchObject({ status: 409, code: 'invalid_review_transition' });
        expect(hasEmDash(err.message)).toBe(false);
        expect(snapshot(w, id)).toEqual(before);
        expect(w.env.events).toEqual([]);
      }
    });
  }

  it('explains why a review cannot be requested or marked as sent by hand', async () => {
    const w = world();
    const id = inReview(w, 'none');
    expect((await failure(() => w.svc.setReview(id, 'requested', null, D))).message).toMatch(/when you confirm the message was sent/);
    const drafted = inReview(w, 'follow_up_drafted');
    expect((await failure(() => w.svc.setReview(drafted, 'follow_up_sent', null, D))).message).toMatch(/typed into Claude from Mini-Summa/);
  });

  it('needs real text for a follow-up draft, and stores it verbatim', async () => {
    const w = world();
    const id = inReview(w, 'received');
    for (const draft of [null, undefined, '', '   \n']) {
      expect(await failure(() => w.svc.setReview(id, 'follow_up_drafted', draft, D))).toMatchObject({ status: 400, code: 'follow_up_draft_required' });
    }
    expect(w.svc.get(id)).toMatchObject({ review: 'received', followUpDraft: null });
    const text = '  Do this:\n\n  1. add tests\r\n2. fix lint  ';
    expect(w.svc.setReview(id, 'follow_up_drafted', text, D)).toMatchObject({ review: 'follow_up_drafted', followUpDraft: text });
    expect(eventsOf(w, id).at(-1)!.detail).toEqual({ from: 'received', to: 'follow_up_drafted', chars: text.length, sha256: sha256(text) });
    const edited = w.svc.setReview(id, 'follow_up_drafted', 'Shorter.', D);
    expect(edited.followUpDraft).toBe('Shorter.');
  });

  it('markFollowUpSent turns a drafted follow-up into a sent one, once', () => {
    const w = world();
    const id = inReview(w, 'follow_up_drafted');
    const sent = w.svc.markFollowUpSent(id, 'act_77')!;
    expect(sent).toMatchObject({ review: 'follow_up_sent', followUpDraft: DRAFT });
    expect(eventsOf(w, id).at(-1)).toMatchObject({ type: 'review_changed', actor: { kind: 'system' } });
    expect(eventsOf(w, id).at(-1)!.detail).toEqual({ from: 'follow_up_drafted', to: 'follow_up_sent', actionId: 'act_77' });
    w.env.clearEvents();
    expect(w.svc.markFollowUpSent(id, 'act_78')).toEqual(sent);
    expect(w.env.events).toEqual([]);
  });

  it('markFollowUpSent does not invent a sent follow-up when none was drafted: it only notes the prompt', () => {
    const w = world();
    const id = inReview(w, 'received');
    const result = w.svc.markFollowUpSent(id, 'act_9')!;
    expect(result.review).toBe('received');
    expect(eventsOf(w, id).at(-1)).toMatchObject({ type: 'note' });
    expect(eventsOf(w, id).at(-1)!.detail).toMatchObject({ action: 'prompt_typed', actionId: 'act_9', review: 'received' });
  });
});

describe('deliveries: save to file', () => {
  it('saves the message under a readable name and records where', async () => {
    const w = world();
    const d = w.captured({ taskTitle: 'Fix the Login: redirect (v2)!' });
    const { delivery, path } = await w.svc.saveFile(d.id, D);
    const message = w.svc.prepare(d.id, D).message;
    expect(w.native.saved).toEqual([{ suggestedName: `report-fix-the-login-redirect-v2-${d.reportId.slice(0, 8)}.md`, text: message }]);
    expect(path).toBe(`/saved/report-fix-the-login-redirect-v2-${d.reportId.slice(0, 8)}.md`);
    expect(delivery.state).toBe('ready_for_handoff');
    expect(eventsOf(w, d.id).at(-1)).toMatchObject({ type: 'note', actor: D });
    expect(eventsOf(w, d.id).at(-1)!.detail).toEqual({ action: 'saved_file', path });
  });

  it('falls back to "report" for a title with nothing usable in it, and keeps names short and safe', async () => {
    const w = world();
    await w.svc.saveFile(w.captured({ taskTitle: '… 漢字 !!!' }).id, D);
    expect(w.native.saved[0].suggestedName).toMatch(/^report-report-[A-Za-z0-9_-]{8}\.md$/);
    await w.svc.saveFile(w.captured({ taskTitle: `${'long '.repeat(40)}` }).id, D);
    expect(w.native.saved[1].suggestedName.length).toBeLessThanOrEqual('report-'.length + 40 + 1 + 8 + '.md'.length);
    expect(w.native.saved[1].suggestedName).not.toMatch(/--|-\./);
  });

  it('returns null and records nothing when the person cancels, and 502 when the host cannot write', async () => {
    const w = world();
    const d = w.captured();
    w.native.saveImpl = () => ({ path: null });
    const before = typesOf(w, d.id).length;
    expect((await w.svc.saveFile(d.id, D)).path).toBeNull();
    expect(typesOf(w, d.id).slice(before)).toEqual(['prepared'].filter(() => typesOf(w, d.id).length > before));
    expect(typesOf(w, d.id)).not.toContain('note');
    w.native.saveImpl = () => { throw new Error('disk full'); };
    expect(await failure(() => w.svc.saveFile(d.id, D))).toMatchObject({ status: 502, code: 'save_failed' });
  });

  it('also works for a closed delivery without rewriting its record', async () => {
    const w = world();
    const id = await MAKERS.user_discarded(w);
    const before = snapshot(w, id);
    const { path } = await w.svc.saveFile(id, D);
    expect(path).toMatch(/\/saved\/report-/);
    expect(w.native.saved[0].text).toContain('Project: GitManager');
    expect(rowOf(w, id).message).toBeNull();
    expect(snapshot(w, id).row.message_sha256).toBe(before.row.message_sha256);
  });
});

describe('deliveries: restart, persistence and honesty', () => {
  it('after a restart nothing advances: copied and awaiting deliveries only get a note', async () => {
    const w = world();
    const copied = await MAKERS.copied(w);
    const awaiting = await MAKERS.awaiting_user_send(w);
    const ready = await MAKERS.ready_for_handoff(w);
    const sent = await MAKERS.user_confirmed_sent(w);
    const uncertain = await MAKERS.delivery_uncertain(w);
    const ids = [copied, awaiting, ready, sent, uncertain];
    const before = ids.map((id) => w.svc.get(id)!);
    w.env.clock.advance(3 * 24 * 3600_000);
    w.env.clearEvents();
    createDeliveriesService(w.deps).recoverAfterRestart();
    const after = ids.map((id) => w.svc.get(id)!);
    for (let i = 0; i < ids.length; i++) {
      const { events: eventsBefore, ...rowBefore } = before[i];
      const { events: eventsAfter, ...rowAfter } = after[i];
      expect(rowAfter).toEqual(rowBefore); // state, timestamps, parts, attempts: all as the person left them
      const added = eventsAfter.slice(eventsBefore.length);
      if (ids[i] === copied || ids[i] === awaiting) {
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ type: 'note', from: rowBefore.state, to: rowBefore.state, actor: { kind: 'system' } });
        expect(added[0].detail).toEqual({ note: 'Mini-Summa restarted while this was waiting' });
        expect(added[0].at).toBe('2026-11-02T10:00:00.000Z');
      } else {
        expect(added).toEqual([]);
      }
    }
    expect(w.env.events).toEqual([]);
  });

  it('a second service instance on the same database sees and continues everything', async () => {
    const w = world({ settings: { review: { maxPartChars: 2000 } } });
    const d = w.captured({ body: bigBody(9000) });
    await w.svc.copy(d.id, 2, D);
    const other = createDeliveriesService(w.deps);
    expect(other.get(d.id)).toEqual(w.svc.get(d.id));
    expect(other.list({})).toEqual(w.svc.list({}));
    expect(other.part(d.id, 2)).toEqual(w.svc.part(d.id, 2));
    expect(other.onReportCaptured(w.reports.require(d.reportId)).id).toBe(d.id);
    const next = await other.copy(d.id, undefined, D);
    expect(next.part).toBe(1); // part 2 was already marked by the first instance
    expect(w.svc.get(d.id)!.parts.slice(0, 2).every((p) => p.copiedAt !== null)).toBe(true);
    other.confirmSent(d.id, 'sent', D);
    expect(w.svc.get(d.id)).toMatchObject({ state: 'user_confirmed_sent', review: 'requested' });
    expect(w.svc.get(d.id)!.destination).toEqual(d.destination);
  });

  it('moves nothing by itself: no timers, and days passing change no state and add no event', async () => {
    vi.useFakeTimers();
    const w = world();
    const ids = [await MAKERS.ready_for_handoff(w), await MAKERS.copied(w), await MAKERS.awaiting_user_send(w), await MAKERS.delivery_uncertain(w), await MAKERS.user_confirmed_sent(w)];
    expect(vi.getTimerCount()).toBe(0);
    const before = ids.map((id) => snapshot(w, id));
    w.env.clock.advance(90 * 24 * 3600_000);
    await vi.advanceTimersByTimeAsync(90 * 24 * 3600_000);
    await vi.runAllTimersAsync();
    w.env.clearEvents();
    expect(ids.map((id) => snapshot(w, id))).toEqual(before);
    expect(w.env.events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('only ever asks the host to copy and to open: it cannot submit anything to ChatGPT', async () => {
    const w = world();
    const d = w.captured();
    await w.svc.handoff(d.id, undefined, D);
    w.svc.confirmSent(d.id, undefined, D);
    await w.svc.open(d.id, D);
    await w.svc.saveFile(d.id, D);
    const used = new Set(w.native.calls);
    expect([...used].sort()).toEqual(['chatgpt.open', 'clipboard.writeText', 'saveTextFile']);
    expect(Object.keys(w.native.chatgpt).sort()).toEqual(['open', 'state', 'verify']);
  });

  it('writes a complete audit trail of a whole handoff, in order, with who did what', async () => {
    const w = world();
    const d = w.captured();
    w.env.clock.advance(1000);
    await w.svc.handoff(d.id, undefined, D);
    w.env.clock.advance(1000);
    w.svc.markUncertain(d.id, 'not sure', PHONE);
    w.env.clock.advance(1000);
    w.svc.reopen(d.id, undefined, D);
    w.env.clock.advance(1000);
    w.svc.confirmSent(d.id, 'done', D);
    const events = eventsOf(w, d.id);
    expect(events.map((e) => [e.type, e.from, e.to, e.actor.kind])).toEqual([
      ['created', null, 'report_captured', 'system'],
      ['destination_resolved', 'report_captured', 'ready_for_handoff', 'system'],
      ['prepared', 'ready_for_handoff', 'ready_for_handoff', 'desktop'],
      ['part_copied', 'ready_for_handoff', 'copied', 'desktop'],
      ['destination_opened', 'copied', 'awaiting_user_send', 'desktop'],
      ['destination_verified', 'awaiting_user_send', 'awaiting_user_send', 'desktop'],
      ['marked_uncertain', 'awaiting_user_send', 'delivery_uncertain', 'device'],
      ['reopened', 'delivery_uncertain', 'ready_for_handoff', 'desktop'],
      ['confirmed_sent', 'ready_for_handoff', 'user_confirmed_sent', 'desktop'],
    ]);
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
    expect(events[6].actor).toEqual(PHONE);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(events.every((e) => e.deliveryId === d.id)).toBe(true);
  });
});

describe('deliveries: list, get and prune', () => {
  it('lists oldest first (the last one is the latest) and filters by project, report and openness', async () => {
    const w = world();
    const other = w.projects.addProject({ id: 'prj_o', name: 'Other' });
    w.projects.addConversation(other.id, { verification: 'verified' });
    const reportA = w.report();
    const a1 = w.svc.onReportCaptured(reportA);
    w.env.clock.advance(1000);
    const b = w.captured();
    w.env.clock.advance(1000);
    const a2 = w.svc.create(reportA.id, {}, D);
    w.env.clock.advance(1000);
    const o = w.svc.onReportCaptured(w.reports.add({ projectId: other.id, projectName: 'Other', sessionKey: KEY_B }));
    w.svc.confirmSent(b.id, undefined, D);
    w.svc.discard(a1.id, undefined, D);
    expect(w.svc.list({}).map((x) => x.id)).toEqual([a1.id, b.id, a2.id, o.id]);
    expect(w.svc.list({ reportId: reportA.id }).map((x) => x.id)).toEqual([a1.id, a2.id]);
    expect(w.svc.list({ projectId: other.id }).map((x) => x.id)).toEqual([o.id]);
    expect(w.svc.list({ open: true }).map((x) => x.id)).toEqual([a2.id, o.id]);
    expect(w.svc.list({ open: false }).map((x) => x.id)).toEqual([a1.id, b.id]);
    expect(w.svc.list({ projectId: 'prj_gm', open: true }).map((x) => x.id)).toEqual([a2.id]);
  });

  it('get returns the delivery with its events oldest first, and nothing for an unknown id', () => {
    const w = world();
    const d = w.captured();
    const detail = w.svc.get(d.id)!;
    expect(detail).toMatchObject({ ...d, events: [{ type: 'created' }, { type: 'destination_resolved' }] });
    expect(w.svc.get('nope')).toBeNull();
  });

  it('prune removes closed deliveries not touched since the cutoff, with their events, and keeps everything else', async () => {
    const w = world();
    const oldSent = await MAKERS.user_confirmed_sent(w);
    const oldOpen = await MAKERS.copied(w);
    w.env.clock.set('2026-12-01T00:00:00.000Z');
    const recentSent = await MAKERS.user_confirmed_sent(w);
    const oldDiscarded = oldSent; // keep names honest below
    expect(w.svc.prune('2026-11-01T00:00:00.000Z')).toBe(1);
    expect(w.svc.get(oldDiscarded)).toBeNull();
    expect(w.env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM delivery_events WHERE delivery_id = ?', [oldSent])!.n).toBe(0);
    expect(w.svc.get(oldOpen)).not.toBeNull();
    expect(w.svc.get(recentSent)).not.toBeNull();
    expect(w.svc.prune('2026-11-01T00:00:00.000Z')).toBe(0);
  });
});

describe('deliveries: strings a person reads', () => {
  it('contain no em dash anywhere in what the service writes', async () => {
    const w = world();
    const all: unknown[] = [];
    for (const state of STATES) {
      const id = await MAKERS[state](w);
      all.push(w.svc.get(id));
    }
    expect(hasEmDash(all)).toBe(false);
    expect(hasEmDash(w.svc.prepare(w.captured().id, D).message)).toBe(false);
  });
});
