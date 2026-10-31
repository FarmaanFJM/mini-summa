// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AWAY_AFTER_SECONDS, createNotifier, isPersonViewing } from '../../src/main/notifications.ts';
import type { NotificationOptions, ViewingFacts } from '../../src/main/notifications.ts';

class FakeNotification extends EventEmitter {
  static created: FakeNotification[] = [];
  closed = false;
  shown = false;
  constructor(readonly options: NotificationOptions) { super(); FakeNotification.created.push(this); }
  show(): void { this.shown = true; }
  close(): void { this.closed = true; this.emit('close'); }
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const target = { view: 'reports', reportId: 'rep_1' } as const;
const note = (over: Partial<Parameters<ReturnType<typeof createNotifier>['notify']>[0]> = {}) => ({
  title: 'Report ready: refactor', body: 'Claude finished in api-server', tag: 'report:rep_1', target, urgency: 'normal' as const, silent: false, ...over,
});

function setup(opts: { supported?: boolean; confirmMs?: number; autoShow?: boolean; viewing?: () => ViewingFacts } = {}) {
  FakeNotification.created = [];
  const onClick = vi.fn();
  const logger = log();
  const notifier = createNotifier({
    create: (o) => {
      const n = new FakeNotification(o);
      if (opts.autoShow !== false) queueMicrotask(() => n.emit('show'));
      return n;
    },
    isSupported: () => opts.supported ?? true,
    onClick,
    ...(opts.viewing ? { viewing: opts.viewing } : {}),
    confirmMs: opts.confirmMs ?? 200,
    log: logger,
  });
  return { notifier, onClick, logger };
}

describe('createNotifier', () => {
  it('reports unsupported systems instead of pretending', async () => {
    const { notifier } = setup({ supported: false });
    const r = await notifier.notify(note());
    expect(r.shown).toBe(false);
    expect(r.reason).toMatch(/not supported/);
    expect(FakeNotification.created).toHaveLength(0);
  });

  it('shows a notification and reports it once the system confirms', async () => {
    const { notifier } = setup();
    expect(await notifier.notify(note())).toEqual({ shown: true });
    expect(FakeNotification.created).toHaveLength(1);
    expect(FakeNotification.created[0].shown).toBe(true);
    expect(FakeNotification.created[0].options).toMatchObject({ title: 'Report ready: refactor', body: 'Claude finished in api-server', silent: false, urgency: 'normal', timeoutType: 'default' });
  });

  it('keeps a critical notification on screen until it is seen', async () => {
    const { notifier } = setup();
    await notifier.notify(note({ urgency: 'critical', silent: false }));
    expect(FakeNotification.created[0].options).toMatchObject({ urgency: 'critical', timeoutType: 'never' });
  });

  it('passes silent through', async () => {
    const { notifier } = setup();
    await notifier.notify(note({ silent: true }));
    expect(FakeNotification.created[0].options.silent).toBe(true);
  });

  it('closes the previous notification with the same tag before showing the new one', async () => {
    const { notifier } = setup();
    await notifier.notify(note({ title: 'first' }));
    await notifier.notify(note({ title: 'second' }));
    const [first, second] = FakeNotification.created;
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it('leaves notifications with other tags alone', async () => {
    const { notifier } = setup();
    await notifier.notify(note({ tag: 'a' }));
    await notifier.notify(note({ tag: 'b' }));
    expect(FakeNotification.created.map((n) => n.closed)).toEqual([false, false]);
  });

  it('after a notification was dismissed, the same tag does not try to close it again', async () => {
    const { notifier } = setup();
    await notifier.notify(note());
    const first = FakeNotification.created[0];
    first.close();
    first.closed = false;
    await notifier.notify(note());
    expect(first.closed).toBe(false);
  });

  it('a click asks the host to bring the app forward and navigate to the target', async () => {
    const { notifier, onClick } = setup();
    await notifier.notify(note());
    FakeNotification.created[0].emit('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(target);
  });

  it('a click on a replaced notification is not possible (it is closed), but the live one still works', async () => {
    const { notifier, onClick } = setup();
    await notifier.notify(note({ target: { view: 'activity' } }));
    await notifier.notify(note({ target: { view: 'settings', section: 'hooks' } }));
    FakeNotification.created[1].emit('click');
    expect(onClick).toHaveBeenLastCalledWith({ view: 'settings', section: 'hooks' });
  });

  it('says so when the system reports a failure', async () => {
    const { notifier } = setup({ autoShow: false });
    const pending = notifier.notify(note());
    queueMicrotask(() => FakeNotification.created[0].emit('failed', {}, 'Toast notifications are disabled'));
    expect(await pending).toEqual({ shown: false, reason: 'Toast notifications are disabled' });
  });

  it('says so when the system never confirms', async () => {
    const { notifier } = setup({ autoShow: false, confirmMs: 20 });
    const r = await notifier.notify(note());
    expect(r.shown).toBe(false);
    expect(r.reason).toMatch(/did not confirm/);
  });

  it('survives a create() that throws', async () => {
    const notifier = createNotifier({ create: () => { throw new Error('no daemon'); }, isSupported: () => true, onClick: vi.fn(), log: log() });
    const r = await notifier.notify(note());
    expect(r.shown).toBe(false);
  });

  it('shortens oversize text', async () => {
    const { notifier } = setup();
    await notifier.notify(note({ title: 't'.repeat(500), body: 'b'.repeat(5000) }));
    const o = FakeNotification.created[0].options;
    expect(o.title.length).toBeLessThanOrEqual(200);
    expect(o.body.length).toBeLessThanOrEqual(1000);
  });

  it('closeAll closes what is live', async () => {
    const { notifier } = setup();
    await notifier.notify(note({ tag: 'a' }));
    await notifier.notify(note({ tag: 'b' }));
    notifier.closeAll();
    expect(FakeNotification.created.every((n) => n.closed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// "Claude finished" is not shown for the session the person is looking at

const P1 = 'prj_alpha';
const P2 = 'prj_beta';
const K1 = 'win|11111111-1111-4111-8111-111111111111' as const;
const K2 = 'win|22222222-2222-4222-8222-222222222222' as const;
const session = { view: 'workspace', projectId: P1, sessionKey: K1 } as const;

/** The person is at the PC, the window is in front, showing project Alpha with session 1 selected. */
const looking = (over: Partial<ViewingFacts> = {}): ViewingFacts => ({
  windowFocused: true,
  idleSeconds: 4,
  ui: { route: { projectId: P1, view: 'workspace' }, perProject: { [P1]: { sessionKey: K1 }, [P2]: { sessionKey: K2 } } },
  layout: { maximized: null },
  ...over,
});

describe('isPersonViewing', () => {
  it('is true when the window is in front, the person is at the PC, and the workspace shows that very session', () => {
    expect(isPersonViewing(session, looking())).toBe(true);
  });

  it('is false when the Mini-Summa window is not the one in front (another program, minimized, hidden)', () => {
    expect(isPersonViewing(session, looking({ windowFocused: false }))).toBe(false);
  });

  it('is false when another project is selected, even if this project remembers the session', () => {
    expect(isPersonViewing(session, looking({ ui: { route: { projectId: P2, view: 'workspace' }, perProject: { [P1]: { sessionKey: K1 } } } }))).toBe(false);
  });

  it('is false when the selected project shows another of its sessions', () => {
    expect(isPersonViewing(session, looking({ ui: { route: { projectId: P1, view: 'workspace' }, perProject: { [P1]: { sessionKey: K2 } } } }))).toBe(false);
  });

  it.each(['activity', 'reports', 'settings'] as const)('is false while the window shows %s instead of the workspace', (view) => {
    expect(isPersonViewing(session, looking({ ui: { route: { projectId: P1, view }, perProject: { [P1]: { sessionKey: K1 } } } }))).toBe(false);
  });

  it.each([
    ['nothing remembered yet', undefined],
    ['no route', { perProject: { [P1]: { sessionKey: K1 } } }],
    ['no session tab for the project', { route: { projectId: P1, view: 'workspace' as const } }],
    ['a project with only a conversation', { route: { projectId: P1, view: 'workspace' as const }, perProject: { [P1]: { conversationId: 'cnv_1' } } }],
  ])('is false when the core has %s: not knowing means show it', (_name, ui) => {
    expect(isPersonViewing(session, looking({ ui }))).toBe(false);
  });

  it('is false with ChatGPT maximized, because the Claude pane is not on screen then', () => {
    expect(isPersonViewing(session, looking({ layout: { maximized: 'chatgpt' } }))).toBe(false);
    expect(isPersonViewing(session, looking({ layout: { maximized: 'claude' } }))).toBe(true);
    expect(isPersonViewing(session, looking({ layout: undefined }))).toBe(true);
  });

  it('is false once the person has been away for two minutes, even if the window was left in front', () => {
    expect(AWAY_AFTER_SECONDS).toBe(120);
    expect(isPersonViewing(session, looking({ idleSeconds: AWAY_AFTER_SECONDS - 1 }))).toBe(true);
    expect(isPersonViewing(session, looking({ idleSeconds: AWAY_AFTER_SECONDS }))).toBe(false);
    expect(isPersonViewing(session, looking({ idleSeconds: 3600 }))).toBe(false);
  });

  it('is false when the system cannot say how long the person has been away', () => {
    expect(isPersonViewing(session, looking({ idleSeconds: null }))).toBe(false);
    expect(isPersonViewing(session, looking({ idleSeconds: Number.NaN }))).toBe(false);
  });

  it.each([
    ['a report', { view: 'reports', projectId: P1, reportId: 'rep_1' }],
    ['the activity feed', { view: 'activity', projectId: P1 }],
    ['settings', { view: 'settings', section: 'hooks' }],
    ['a project without a session', { view: 'workspace', projectId: P1 }],
    ['a session without a project', { view: 'workspace', sessionKey: K1 }],
    ['nothing in particular', { view: 'workspace' }],
  ] as const)('is false for a notification about %s: only a session on screen counts', (_name, target) => {
    expect(isPersonViewing(target, looking())).toBe(false);
  });
});

describe('createNotifier: notifications that ask to be skipped when the person is looking', () => {
  it('does not show one, says why (not a failure), and creates nothing on the system', async () => {
    const { notifier, onClick } = setup({ viewing: () => looking() });
    const r = await notifier.notify(note({ target: session, suppressIfViewing: true }));
    expect(r).toEqual({ shown: false, suppressed: 'viewing', reason: expect.stringMatching(/in front on this session/) });
    expect(FakeNotification.created).toHaveLength(0);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows it when the window is somewhere else', async () => {
    const { notifier } = setup({ viewing: () => looking({ windowFocused: false }) });
    expect(await notifier.notify(note({ target: session, suppressIfViewing: true }))).toEqual({ shown: true });
    expect(FakeNotification.created).toHaveLength(1);
  });

  it('shows it for a session of another project than the selected one, and a click leads to that project and session', async () => {
    const other = { view: 'workspace', projectId: P2, sessionKey: K2 } as const;
    const facts = looking({ ui: { route: { projectId: P1, view: 'workspace' }, perProject: { [P1]: { sessionKey: K1 }, [P2]: { sessionKey: K2 } } } });
    const { notifier, onClick } = setup({ viewing: () => facts });
    expect(await notifier.notify(note({ target: other, suppressIfViewing: true }))).toEqual({ shown: true });
    FakeNotification.created[0].emit('click');
    expect(onClick).toHaveBeenCalledWith(other);
  });

  it('shows every notification that did not ask for it, even if the person is looking: a permission request is worth interrupting for', async () => {
    const viewing = vi.fn(() => looking());
    const { notifier } = setup({ viewing });
    expect(await notifier.notify(note({ target: session, urgency: 'critical' }))).toEqual({ shown: true });
    expect(FakeNotification.created).toHaveLength(1);
    expect(viewing).not.toHaveBeenCalled(); // not even asked
  });

  it('shows it when the facts cannot be read, and logs it', async () => {
    const { notifier, logger } = setup({ viewing: () => { throw new Error('the window is gone'); } });
    expect(await notifier.notify(note({ target: session, suppressIfViewing: true }))).toEqual({ shown: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('shows it when this notifier was given no way to look', async () => {
    const { notifier } = setup();
    expect(await notifier.notify(note({ target: session, suppressIfViewing: true }))).toEqual({ shown: true });
  });

  it('on a system that cannot show notifications, a person who is looking is still reported as looking, not as unsupported', async () => {
    const { notifier } = setup({ supported: false, viewing: () => looking() });
    expect(await notifier.notify(note({ target: session, suppressIfViewing: true }))).toMatchObject({ shown: false, suppressed: 'viewing' });
    expect(await setup({ supported: false, viewing: () => looking({ windowFocused: false }) }).notifier.notify(note({ target: session, suppressIfViewing: true })))
      .toEqual({ shown: false, reason: expect.stringMatching(/not supported/) });
  });

  it('does not close or replace a notification already on screen for the same tag', async () => {
    let facts = looking({ windowFocused: false });
    const { notifier } = setup({ viewing: () => facts });
    await notifier.notify(note({ tag: 'drv_1', target: session, suppressIfViewing: true }));
    facts = looking();
    await notifier.notify(note({ tag: 'drv_1', target: session, suppressIfViewing: true }));
    expect(FakeNotification.created).toHaveLength(1);
    expect(FakeNotification.created[0].closed).toBe(false);
  });
});
