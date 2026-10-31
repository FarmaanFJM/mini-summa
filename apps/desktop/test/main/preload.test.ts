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

  // Intentional change (live views per project): the surface gained `liveViews` (a plain flag) and `onNotice`; every other member is as it was.
  it('keeps the ChatGPT surface, plus liveViews and onNotice', () => {
    expect(Object.keys(api.chatgpt).sort()).toEqual(['back', 'focus', 'forward', 'getState', 'liveViews', 'navigate', 'onNotice', 'onState', 'reload', 'setBounds', 'setOverlayActive']);
  });

  it('passes the project key as the LAST argument, and only when there is one: without a key the calls are exactly what they were', async () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const url = 'https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const calls: [() => Promise<unknown>, string, unknown[]][] = [
      [() => api.chatgpt.setBounds(rect), CH.chatgptSetBounds, [rect]],
      [() => api.chatgpt.setBounds(rect, 'prj_a'), CH.chatgptSetBounds, [rect, 'prj_a']],
      [() => api.chatgpt.setBounds(null, 'prj_a'), CH.chatgptSetBounds, [null, 'prj_a']],
      [() => api.chatgpt.navigate(url), CH.chatgptNavigate, [url]],
      [() => api.chatgpt.navigate(url, 'prj_a'), CH.chatgptNavigate, [url, 'prj_a']],
      [() => api.chatgpt.reload('prj_a'), CH.chatgptReload, ['prj_a']],
      [() => api.chatgpt.back('prj_a'), CH.chatgptBack, ['prj_a']],
      [() => api.chatgpt.forward('prj_a'), CH.chatgptForward, ['prj_a']],
      [() => api.chatgpt.focus('prj_a'), CH.chatgptFocus, ['prj_a']],
      [() => api.chatgpt.getState('prj_a'), CH.chatgptGetState, ['prj_a']],
      [() => api.chatgpt.getState(), CH.chatgptGetState, []],
      [() => api.chatgpt.setOverlayActive(true), CH.chatgptSetOverlayActive, [true]], // one switch for every view: never keyed
    ];
    for (const [call, channel, args] of calls) {
      invoke.mockClear();
      await call();
      expect(invoke).toHaveBeenCalledWith(channel, ...args);
      expect(invoke.mock.calls[0]).toHaveLength(1 + args.length);
    }
  });

  it('listens to the keyed channel for a project\'s state and only passes on that project\'s, and to the old channel without a key', () => {
    expect(api.chatgpt.liveViews).toBe(true);
    const state = { mode: 'embedded', status: 'ready', url: 'https://chatgpt.com/', title: null, canGoBack: false, canGoForward: false, note: null } as const;
    on.mockClear();
    const keyedListener = vi.fn();
    const off = api.chatgpt.onState(keyedListener, 'prj_a');
    expect(on.mock.calls[0][0]).toBe(CH.chatgptKeyedState);
    const handler = on.mock.calls[0][1] as (event: unknown, payload: unknown) => void;
    handler({}, { key: 'prj_b', state });
    expect(keyedListener).not.toHaveBeenCalled();
    handler({}, { key: 'prj_a', state });
    expect(keyedListener).toHaveBeenCalledWith(state);
    off();
    expect(removeListener).toHaveBeenCalledWith(CH.chatgptKeyedState, handler);
    on.mockClear();
    api.chatgpt.onState(vi.fn());
    expect(on.mock.calls[0][0]).toBe(CH.chatgptState);
    on.mockClear();
    api.chatgpt.onNotice?.(vi.fn());
    expect(on.mock.calls[0][0]).toBe(CH.chatgptNotice);
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
    expect(seen.sort()).toEqual(['miniSumma.appVersion', 'miniSumma.chatgpt.liveViews', 'miniSumma.kind', 'miniSumma.platform']); // liveViews: a plain flag
  });
});
