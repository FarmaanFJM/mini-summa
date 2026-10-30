// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { countRunningTerminals, createQuitFlow, quitDialogText } from '../../src/main/quit.ts';

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function setup(over: Partial<Parameters<typeof createQuitFlow>[0]> = {}) {
  const calls: string[] = [];
  const deps = {
    countTerminals: vi.fn(() => 0),
    confirm: vi.fn(async () => true),
    stopCore: vi.fn(async () => { calls.push('stopCore'); }),
    flushStorage: vi.fn(async () => { calls.push('flush'); }),
    exit: vi.fn((code: number) => { calls.push(`exit:${code}`); }),
    log: log(),
    ...over,
  };
  return { flow: createQuitFlow(deps), deps, calls };
}

describe('quit flow', () => {
  it('quits without asking when no terminal is running, stopping the core before exiting', async () => {
    const { flow, deps, calls } = setup();
    await flow.request();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(['stopCore', 'flush', 'exit:0']);
    expect(flow.quitting).toBe(true);
  });

  it('asks first when terminals are running, and passes the count', async () => {
    const { flow, deps } = setup({ countTerminals: vi.fn(() => 3) });
    await flow.request();
    expect(deps.confirm).toHaveBeenCalledWith(3);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('does nothing when the user says no, and can be asked again later', async () => {
    let answer = false;
    const { flow, deps, calls } = setup({ countTerminals: vi.fn(() => 2), confirm: vi.fn(async () => answer) });
    await flow.request();
    expect(deps.stopCore).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(flow.quitting).toBe(false);
    answer = true;
    await flow.request();
    expect(calls).toEqual(['stopCore', 'flush', 'exit:0']);
  });

  it('shows only one dialog when quit is requested twice while it is open', async () => {
    let release!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const { flow, deps } = setup({ countTerminals: vi.fn(() => 1), confirm });
    const first = flow.request();
    const second = flow.request();
    await second;
    expect(confirm).toHaveBeenCalledTimes(1);
    release(true);
    await first;
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('is idempotent once quitting', async () => {
    const { flow, deps } = setup();
    await flow.request();
    await flow.request();
    expect(deps.stopCore).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('still exits when the core fails to stop', async () => {
    const { flow, deps } = setup({ stopCore: vi.fn(async () => { throw new Error('db busy'); }) });
    await flow.request();
    expect(deps.log.error).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('still exits when the core hangs, after the timeout', async () => {
    const { flow, deps } = setup({ stopCore: vi.fn(() => new Promise<void>(() => undefined)), stopTimeoutMs: 30 });
    await flow.request();
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('still exits when flushing storage fails', async () => {
    const { flow, deps } = setup({ flushStorage: vi.fn(async () => { throw new Error('disk'); }) });
    await flow.request();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});

describe('the window while the app leaves', () => {
  // Defect found in the Windows audit: closing the window kept it on screen, unresponsive and soon showing a lost connection,
  // for as long as the core took to stop (seconds with terminals to end). It is hidden as soon as the decision is final.
  it('hides the window after the answer and before the slow work, so closing looks like closing', async () => {
    const { flow, calls } = setup({ countTerminals: vi.fn(() => 2), hideWindow: vi.fn(() => { calls.push('hide'); }) });
    await flow.request();
    expect(calls).toEqual(['hide', 'stopCore', 'flush', 'exit:0']);
  });

  it('keeps the window while the question is open and when the answer is no', async () => {
    const hideWindow = vi.fn();
    let release!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const { flow, deps } = setup({ countTerminals: vi.fn(() => 1), confirm, hideWindow });
    const pending = flow.request();
    await Promise.resolve();
    expect(hideWindow).not.toHaveBeenCalled();
    release(false);
    await pending;
    expect(hideWindow).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it('still quits when hiding the window throws', async () => {
    const { flow, deps } = setup({ hideWindow: vi.fn(() => { throw new Error('destroyed'); }) });
    await flow.request();
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});

describe('the system ending the session (Windows shutdown, log-off, installer)', () => {
  // SIMULATED: nothing here ran on Windows. Electron emits `session-end` on Windows and no `before-quit`, so this is the only
  // path that runs; it must never ask, because nobody can answer while the system is going down.
  it('stops and exits without asking, even with terminals running', async () => {
    const { flow, deps, calls } = setup({ countTerminals: vi.fn(() => 3), hideWindow: vi.fn(() => { calls.push('hide'); }) });
    await flow.endSession();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(['hide', 'stopCore', 'flush', 'exit:0']);
    expect(flow.quitting).toBe(true);
  });

  it('gives the core at most three seconds, whatever the normal limit is', async () => {
    vi.useFakeTimers();
    try {
      const { flow, deps } = setup({ stopCore: vi.fn(() => new Promise<void>(() => undefined)), stopTimeoutMs: 60_000 });
      const done = flow.endSession();
      await vi.advanceTimersByTimeAsync(2999);
      expect(deps.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(deps.exit).toHaveBeenCalledWith(0);
    } finally { vi.useRealTimers(); }
  });

  it('is idempotent and takes over a quit that is waiting for an answer', async () => {
    let release!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const { flow, deps } = setup({ countTerminals: vi.fn(() => 1), confirm });
    const asking = flow.request();
    await Promise.resolve();
    await flow.endSession();
    await flow.endSession();
    expect(deps.stopCore).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    release(true); // the person answers a dialog that is already gone
    await asking;
    expect(deps.stopCore).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('makes a later window close or before-quit go straight through instead of opening the dialog', async () => {
    const { flow, deps } = setup({ countTerminals: vi.fn(() => 2) });
    await flow.endSession();
    // index.ts lets close and before-quit pass when `quitting` is true
    expect(flow.quitting).toBe(true);
    await flow.request();
    expect(deps.confirm).not.toHaveBeenCalled();
  });
});

describe('quitDialogText', () => {
  it('says plainly that terminals end and can be resumed, never that they survive', () => {
    const many = quitDialogText(3);
    expect(many.detail).toBe('Closing Mini-Summa ends 3 running Claude terminals. They can be resumed later.');
    const one = quitDialogText(1);
    expect(one.detail).toBe('Closing Mini-Summa ends 1 running Claude terminal. It can be resumed later.');
    for (const t of [many, one]) {
      expect(`${t.message} ${t.detail} ${t.confirm} ${t.cancel}`).not.toMatch(/—|survive|keep running|continue running/i);
      expect(t.confirm).toMatch(/^Quit/);
      expect(t.cancel).toBe('Cancel');
    }
  });
});

describe('countRunningTerminals', () => {
  const s = (origin: string, availability: string, terminal: { exited: boolean } | null) => ({ origin, availability, terminal });
  it('counts only managed, live terminals that have not exited', () => {
    expect(countRunningTerminals([
      s('managed', 'live', { exited: false }),
      s('managed', 'live', { exited: true }),
      s('managed', 'resumable', { exited: true }),
      s('managed', 'disconnected', { exited: false }),
      s('external', 'live', null),
      s('background', 'live', null),
      s('managed', 'live', null),
      s('managed', 'live', { exited: false }),
    ])).toBe(2);
    expect(countRunningTerminals([])).toBe(0);
  });
});
