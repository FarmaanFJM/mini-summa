// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NativeApi } from '@minisumma/shared';
import { CH } from '../../src/main/channels.ts';

// The preload is run for real against a recorder in place of Electron's contextBridge and ipcRenderer: this is the object the renderer gets
// as window.miniSumma, and the channels it talks to.
const exposed: { name: string; api: NativeApi }[] = [];
const invoke = vi.fn(async (..._args: unknown[]) => undefined);
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: NativeApi) => { exposed.push({ name, api }); } },
  ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args), on: (...args: unknown[]) => on(...args), removeListener: (...args: unknown[]) => removeListener(...args) },
}));

let api: NativeApi;
beforeAll(async () => {
  await import('../../src/preload/index.ts');
  expect(exposed).toHaveLength(1);
  expect(exposed[0].name).toBe('miniSumma');
  api = exposed[0].api;
});

/** Typed on purpose: when the contract in packages/shared gains or loses a member of claudeWeb, this stops compiling until the preload and this list agree. */
const CLAUDE_WEB_MEMBERS: Record<keyof NonNullable<NativeApi['claudeWeb']>, true> = {
  setBounds: true, navigate: true, reload: true, back: true, forward: true, focus: true, getState: true, onState: true,
};

describe('window.miniSumma.claudeWeb', () => {
  it('has exactly the shape of NativeApi.claudeWeb: setBounds, navigate, reload, back, forward, focus, getState, onState', () => {
    expect(Object.keys(api.claudeWeb ?? {}).sort()).toEqual(Object.keys(CLAUDE_WEB_MEMBERS).sort());
    for (const member of Object.values(api.claudeWeb ?? {})) expect(typeof member).toBe('function');
  });

  it('has no overlay switch of its own: the ChatGPT one covers both native views', () => {
    expect(api.claudeWeb).not.toHaveProperty('setOverlayActive');
    expect(typeof api.chatgpt.setOverlayActive).toBe('function');
  });

  it('sends each call to its own channel with the arguments it was given, and returns what the main process answered', async () => {
    const claude = api.claudeWeb!;
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const calls: [() => Promise<unknown>, string, unknown[]][] = [
      [() => claude.setBounds(rect), CH.claudeWebSetBounds, [rect]],
      [() => claude.setBounds(null), CH.claudeWebSetBounds, [null]],
      [() => claude.navigate('https://claude.ai/code?repositories=acme/webapp'), CH.claudeWebNavigate, ['https://claude.ai/code?repositories=acme/webapp']],
      [() => claude.reload(), CH.claudeWebReload, []],
      [() => claude.back(), CH.claudeWebBack, []],
      [() => claude.forward(), CH.claudeWebForward, []],
      [() => claude.focus(), CH.claudeWebFocus, []],
      [() => claude.getState(), CH.claudeWebGetState, []],
    ];
    for (const [call, channel, args] of calls) {
      invoke.mockClear();
      await call();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(channel, ...args);
    }
    invoke.mockResolvedValueOnce({ status: 'ready' } as never);
    expect(await claude.getState()).toEqual({ status: 'ready' });
  });

  it('none of the Claude channels is a ChatGPT channel, and all of them are in the ms:claudeWeb namespace', () => {
    const claudeChannels = Object.entries(CH).filter(([name]) => name.startsWith('claudeWeb')).map(([, channel]) => channel);
    expect(claudeChannels).toHaveLength(8);
    for (const channel of claudeChannels) expect(channel).toMatch(/^ms:claudeWeb:/);
    const chatgptChannels = Object.entries(CH).filter(([name]) => name.startsWith('chatgpt')).map(([, channel]) => channel);
    expect(claudeChannels.filter((channel) => chatgptChannels.includes(channel))).toEqual([]);
  });

  it('onState hands the listener the state and not the event, and the function it returns stops it', () => {
    on.mockClear();
    removeListener.mockClear();
    const listener = vi.fn();
    const off = api.claudeWeb!.onState(listener);
    expect(on).toHaveBeenCalledTimes(1);
    const [channel, handler] = on.mock.calls[0] as [string, (event: unknown, state: unknown) => void];
    expect(channel).toBe(CH.claudeWebState);
    expect(channel).not.toBe(CH.chatgptState);
    const state = { status: 'ready', url: 'https://claude.ai/code', title: 'Claude Code', canGoBack: false, canGoForward: false, note: null };
    handler({ sender: 'event' }, state);
    expect(listener).toHaveBeenCalledWith(state);
    off();
    expect(removeListener).toHaveBeenCalledWith(CH.claudeWebState, handler);
  });

  it('leaves the ChatGPT surface as it was', () => {
    expect(Object.keys(api.chatgpt).sort()).toEqual(['back', 'focus', 'forward', 'getState', 'navigate', 'onState', 'reload', 'setBounds', 'setOverlayActive']);
  });

  it('exposes functions and plain values only: no ipcRenderer, no event emitter, nothing the page could use to reach the main process by itself', () => {
    const seen: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'function') return;
      if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
        return;
      }
      seen.push(path);
    };
    walk(api, 'miniSumma');
    expect(Object.keys(api)).not.toContain('ipcRenderer');
    expect(seen.sort()).toEqual(['miniSumma.appVersion', 'miniSumma.kind', 'miniSumma.platform']);
  });
});
