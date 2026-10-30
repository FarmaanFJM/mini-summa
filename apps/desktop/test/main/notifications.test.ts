// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createNotifier } from '../../src/main/notifications.ts';
import type { NotificationOptions } from '../../src/main/notifications.ts';

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

function setup(opts: { supported?: boolean; confirmMs?: number; autoShow?: boolean } = {}) {
  FakeNotification.created = [];
  const onClick = vi.fn();
  const notifier = createNotifier({
    create: (o) => {
      const n = new FakeNotification(o);
      if (opts.autoShow !== false) queueMicrotask(() => n.emit('show'));
      return n;
    },
    isSupported: () => opts.supported ?? true,
    onClick,
    confirmMs: opts.confirmMs ?? 200,
    log: log(),
  });
  return { notifier, onClick };
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
