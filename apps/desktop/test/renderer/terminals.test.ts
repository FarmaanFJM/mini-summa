import type { SessionKey, TerminalHandle, TerminalHandlers } from '@minisumma/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalRegistry } from '../../src/renderer/src/terminals/terminals';
import { FakeAdapter } from './helpers';

const A = 'win|aaaaaaaa-0000-4000-8000-000000000001' as SessionKey;
const B = 'win|bbbbbbbb-0000-4000-8000-000000000002' as SessionKey;

interface Attached { key: SessionKey; size: { cols: number; rows: number }; handlers: TerminalHandlers; handle: TerminalHandle & { inputs: string[]; resizes: { cols: number; rows: number }[]; detached: number } }

function setup(opts: { unmeasurable?: boolean } = {}) {
  const attached: Attached[] = [];
  const terminal = {
    attach: vi.fn((key: SessionKey, size: { cols: number; rows: number }, handlers: TerminalHandlers) => {
      const handle = {
        key, inputs: [] as string[], resizes: [] as { cols: number; rows: number }[], detached: 0,
        input(data: string) { this.inputs.push(data); return true; },
        resize(cols: number, rows: number) { this.resizes.push({ cols, rows }); },
        detach() { this.detached += 1; },
      };
      attached.push({ key, size, handlers, handle });
      return handle;
    }),
  };
  const adapters = new Map<SessionKey, FakeAdapter>();
  let created = 0;
  const registry = new TerminalRegistry({
    terminal: terminal as never,
    createAdapter: (key) => { created += 1; const a = new FakeAdapter(key); if (opts.unmeasurable) a.proposed = null; adapters.set(key, a); return a; },
    schedule: (fn) => { fn(); return 0; },
  });
  const slot = () => { const el = document.createElement('div'); document.body.appendChild(el); return el; };
  const lastOf = (key: SessionKey) => attached.filter((a) => a.key === key).at(-1)!;
  /** Make the server answer the attach: the terminal is now usable. */
  const attachReply = (key: SessionKey, replay = '', cols = 100, rows = 30) => lastOf(key).handlers.onAttached({ replay, seq: 1, cols, rows });
  return { registry, attached, terminal, adapters, created: () => created, slot, lastOf, attachReply };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('one terminal per session, never recreated', () => {
  it('creates the emulator once and opens it once, however often it is shown', () => {
    const t = setup();
    const first = t.slot();
    const unmount = t.registry.mount(A, first);
    const adapter = t.adapters.get(A)!;
    expect(adapter.openCount).toBe(1);
    expect(first.contains(t.registry.hostOf(A))).toBe(true);

    unmount();
    const second = t.slot();
    t.registry.mount(A, second);
    expect(t.created()).toBe(1);
    expect(t.adapters.get(A)).toBe(adapter);
    expect(adapter.openCount).toBe(1);
    expect(second.contains(t.registry.hostOf(A))).toBe(true);
    expect(first.contains(t.registry.hostOf(A))).toBe(false);
  });

  it('moves the same host element between slots (a layout change) and repaints it', () => {
    const t = setup();
    const landscape = t.slot();
    const portrait = t.slot();
    t.registry.mount(A, landscape);
    const host = t.registry.hostOf(A)!;
    const refreshes = t.adapters.get(A)!.refreshes;
    t.registry.mount(A, portrait); // the new slot takes over without the old one letting go first
    expect(t.registry.hostOf(A)).toBe(host);
    expect(host.parentElement).toBe(portrait);
    expect(t.adapters.get(A)!.refreshes).toBeGreaterThan(refreshes);
    expect(t.adapters.get(A)!.openCount).toBe(1);
  });

  it('lets the old slot let go late without taking the host away from the new one', () => {
    const t = setup();
    const oldSlot = t.slot();
    const newSlot = t.slot();
    const unmountOld = t.registry.mount(A, oldSlot);
    t.registry.mount(A, newSlot);
    unmountOld();
    expect(t.registry.hostOf(A)!.parentElement).toBe(newSlot);
    expect(t.registry.isMounted(A)).toBe(true);
  });

  it('parks the host out of sight when its slot goes away, keeping the emulator alive', () => {
    const t = setup();
    const unmount = t.registry.mount(A, t.slot());
    unmount();
    expect(t.registry.isMounted(A)).toBe(false);
    expect(t.registry.has(A)).toBe(true);
    expect(t.adapters.get(A)!.disposed).toBe(false);
    expect(t.registry.hostOf(A)!.parentElement?.className).toBe('ms-term-parking');
  });

  it('keeps both terminals alive when the person switches project and back', () => {
    const t = setup();
    const unmountA = t.registry.mount(A, t.slot());
    t.registry.setActive(A);
    unmountA();
    t.registry.setActive(null);
    t.registry.mount(B, t.slot());
    t.registry.setActive(B);
    expect(t.registry.keys()).toEqual([A, B]);
    expect(t.adapters.get(A)!.disposed).toBe(false);
    expect(t.adapters.get(B)!.disposed).toBe(false);
    // Back to A: the same emulator, not a new one.
    t.registry.mount(A, t.slot());
    expect(t.created()).toBe(2);
    expect(t.adapters.get(A)!.openCount).toBe(1);
  });

  it('disposes a terminal only when it is released, and detaches it from the server', () => {
    const t = setup();
    t.registry.mount(A, t.slot());
    const host = t.registry.hostOf(A)!;
    t.registry.release(A);
    expect(t.adapters.get(A)!.disposed).toBe(true);
    expect(t.lastOf(A).handle.detached).toBe(1);
    expect(t.registry.has(A)).toBe(false);
    expect(host.isConnected).toBe(false);
    t.registry.release(A); // releasing twice is harmless
  });
});

describe('talking to the server', () => {
  it('attaches once, with the size that fits, and not again after a remount', () => {
    const t = setup();
    const unmount = t.registry.mount(A, t.slot());
    expect(t.terminal.attach).toHaveBeenCalledTimes(1);
    expect(t.attached[0].size).toEqual({ cols: 100, rows: 30 });
    unmount();
    t.registry.mount(A, t.slot());
    expect(t.terminal.attach).toHaveBeenCalledTimes(1);
  });

  it('waits for a size before attaching a terminal that cannot be measured yet', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
    const t = setup({ unmeasurable: true });
    t.registry.mount(A, t.slot());
    expect(t.terminal.attach).not.toHaveBeenCalled();
    t.adapters.get(A)!.proposed = { cols: 90, rows: 20 };
    observers.at(-1)!();
    expect(t.terminal.attach).toHaveBeenCalledTimes(1);
    expect(t.attached[0].size).toEqual({ cols: 90, rows: 20 });
  });

  it('answers an attach by resetting the screen and writing the replay, at the size the server has', () => {
    const t = setup();
    t.registry.mount(A, t.slot());
    const adapter = t.adapters.get(A)!;
    adapter.writes.push('old contents');
    adapter.ops.length = 0;
    t.attachReply(A, 'REPLAY', 90, 28);
    expect(adapter.resets).toBe(1);
    expect(adapter.text).toBe('REPLAY');
    // Cleared, drawn at the server's size, then fitted back to the pane.
    expect(adapter.ops).toEqual(['reset', 'resize:90x28', 'write', 'resize:100x30']);
    expect(t.registry.info(A)).toMatchObject({ status: 'attached', hasOutput: true });
  });

  it('resets and replays again after a reconnect (the client attaches again by itself)', () => {
    const t = setup();
    t.registry.mount(A, t.slot());
    t.attachReply(A, 'FIRST');
    t.attachReply(A, 'SECOND');
    expect(t.adapters.get(A)!.resets).toBe(2);
    expect(t.adapters.get(A)!.text).toBe('SECOND');
  });

  it('writes live output', () => {
    const t = setup();
    t.registry.mount(A, t.slot());
    t.attachReply(A, '');
    t.lastOf(A).handlers.onData('hello');
    expect(t.adapters.get(A)!.text).toBe('hello');
    expect(t.registry.info(A)?.hasOutput).toBe(true);
  });

  it('tells the server when the pane changes size, once per real change, and never for an unmeasurable pane', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
    const t = setup();
    t.registry.mount(A, t.slot());
    t.attachReply(A, '', 100, 30);
    const adapter = t.adapters.get(A)!;
    const handle = t.lastOf(A).handle;

    adapter.proposed = { cols: 120, rows: 40 };
    observers.at(-1)!();
    expect(handle.resizes).toEqual([{ cols: 120, rows: 40 }]);
    observers.at(-1)!(); // same size again: nothing to say
    expect(handle.resizes).toHaveLength(1);

    adapter.proposed = null; // hidden: do not shrink the server's terminal to nothing
    observers.at(-1)!();
    expect(handle.resizes).toHaveLength(1);
  });

  it('remembers what the visible terminal measured as the size for the next new session', () => {
    const t = setup();
    expect(t.registry.suggestedSize()).toEqual({ cols: 120, rows: 32 });
    t.registry.mount(A, t.slot());
    expect(t.registry.suggestedSize()).toEqual({ cols: 100, rows: 30 });
  });

  it('shows an exit and an error without throwing the terminal away', () => {
    const t = setup();
    t.registry.mount(A, t.slot());
    t.attachReply(A, 'x');
    t.lastOf(A).handlers.onExit({ code: 1, signal: null, at: 'now', reason: 'exited' });
    expect(t.registry.info(A)).toMatchObject({ status: 'exited', exit: { code: 1 } });
    expect(t.adapters.get(A)!.readOnly).toBe(true);
    t.lastOf(A).handlers.onError('no_terminal', 'The terminal of this session is not connected.');
    expect(t.registry.info(A)).toMatchObject({ status: 'error', error: { code: 'no_terminal' } });
    expect(t.adapters.get(A)!.disposed).toBe(false);
  });
});

describe('input only ever comes from the active, visible terminal', () => {
  function ready() {
    const t = setup();
    t.registry.mount(A, t.slot());
    t.attachReply(A);
    return t;
  }

  it('forwards typing from the active terminal', () => {
    const t = ready();
    t.registry.setActive(A);
    t.adapters.get(A)!.type('ls\r');
    expect(t.lastOf(A).handle.inputs).toEqual(['ls\r']);
    expect(t.registry.canType(A)).toBe(true);
  });

  it('never forwards from a terminal that is not the active one', () => {
    const t = ready();
    t.adapters.get(A)!.type('x');
    expect(t.lastOf(A).handle.inputs).toEqual([]);
    t.registry.setActive(B);
    t.adapters.get(A)!.type('y');
    expect(t.lastOf(A).handle.inputs).toEqual([]);
  });

  it('only the named terminal forwards when two are mounted', () => {
    const t = setup();
    t.registry.mount(A, t.slot());
    t.registry.mount(B, t.slot());
    t.attachReply(A);
    t.attachReply(B);
    t.registry.setActive(B);
    t.adapters.get(A)!.type('to A?');
    t.adapters.get(B)!.type('to B');
    expect(t.lastOf(A).handle.inputs).toEqual([]);
    expect(t.lastOf(B).handle.inputs).toEqual(['to B']);
    t.registry.setActive(A);
    t.adapters.get(B)!.type('B again');
    t.adapters.get(A)!.type('A now');
    expect(t.lastOf(B).handle.inputs).toEqual(['to B']);
    expect(t.lastOf(A).handle.inputs).toEqual(['A now']);
  });

  it('never forwards from a terminal that is not on screen, even if it is the active one', () => {
    const t = setup();
    const unmount = t.registry.mount(A, t.slot());
    t.attachReply(A);
    t.registry.setActive(A);
    unmount();
    t.adapters.get(A)!.type('hidden');
    expect(t.lastOf(A).handle.inputs).toEqual([]);
  });

  it('never forwards while the connection is down', () => {
    const t = ready();
    t.registry.setActive(A);
    t.registry.setConnected(false);
    t.adapters.get(A)!.type('lost');
    expect(t.lastOf(A).handle.inputs).toEqual([]);
    t.registry.setConnected(true);
    t.adapters.get(A)!.type('back');
    expect(t.lastOf(A).handle.inputs).toEqual(['back']);
  });

  it('never forwards before the server has attached the terminal, or after it exited', () => {
    const t = setup();
    t.registry.mount(A, t.slot());
    t.registry.setActive(A);
    t.adapters.get(A)!.type('too early');
    expect(t.lastOf(A).handle.inputs).toEqual([]);
    t.attachReply(A);
    t.lastOf(A).handlers.onExit({ code: 0, signal: null, at: 'now', reason: 'done' });
    t.adapters.get(A)!.type('too late');
    expect(t.lastOf(A).handle.inputs).toEqual([]);
  });

  it('stops being active when released', () => {
    const t = ready();
    t.registry.setActive(A);
    t.registry.release(A);
    expect(t.registry.active).toBeNull();
  });

  it('puts the cursor in a terminal only when it is the active, visible one', () => {
    const t = ready();
    t.registry.focus(A);
    expect(t.adapters.get(A)!.focusCount).toBe(0);
    t.registry.setActive(A);
    t.registry.focus(A);
    expect(t.adapters.get(A)!.focusCount).toBe(1);
  });
});
