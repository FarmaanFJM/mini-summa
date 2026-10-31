// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CH, INVOKE_CHANNELS } from '../../src/main/channels.ts';
import { registerIpc, UntrustedSenderError } from '../../src/main/ipc.ts';
import type { InvokeEventLike, IpcDeps } from '../../src/main/ipc.ts';

const CORE = 'http://127.0.0.1:40555';
const TOKEN = 'tok_secret_value_123';
const MAIN_ID = 3;

function setup() {
  const handlers = new Map<string, (event: InvokeEventLike, ...args: unknown[]) => unknown>();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const chatgpt = {
    setBounds: vi.fn(), setOverlayActive: vi.fn(), navigate: vi.fn(async () => undefined), reload: vi.fn(), back: vi.fn(), forward: vi.fn(), focus: vi.fn(),
    getState: vi.fn(() => ({ mode: 'embedded' as const, status: 'idle' as const, url: null, title: null, canGoBack: false, canGoForward: false, note: null })),
  };
  const claudeWeb = {
    setBounds: vi.fn(), setOverlayActive: vi.fn(), navigate: vi.fn(async () => undefined), reload: vi.fn(), back: vi.fn(), forward: vi.fn(), focus: vi.fn(),
    getState: vi.fn(() => ({ status: 'idle' as const, url: null, title: null, canGoBack: false, canGoForward: false, note: null })),
  };
  const deps = {
    ipcMain: {
      handle: (channel: string, listener: (event: InvokeEventLike, ...args: unknown[]) => unknown) => { handlers.set(channel, listener); },
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
    },
    coreOrigin: CORE,
    mainContentsId: () => MAIN_ID as number | null,
    connection: vi.fn(() => ({ baseUrl: CORE, token: TOKEN })),
    chatgpt,
    claudeWeb,
    writeClipboard: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    selectDirectory: vi.fn(async () => '/picked'),
    showItemInFolder: vi.fn(),
    setBadgeCount: vi.fn(),
    paths: vi.fn(() => ({ dataDir: '/d', logsDir: '/l' })),
    log,
  } satisfies IpcDeps;
  const dispose = registerIpc(deps);
  const good = (): InvokeEventLike => ({ sender: { id: MAIN_ID }, senderFrame: { url: `${CORE}/ui/`, parent: null } });
  const call = async (channel: string, event: InvokeEventLike, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { handlers, deps, chatgpt, claudeWeb, log, dispose, good, call };
}

describe('registerIpc', () => {
  it('registers exactly the invoke channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('removes them again on dispose', () => {
    const { handlers, dispose } = setup();
    dispose();
    expect(handlers.size).toBe(0);
  });

  describe('the project key of the ChatGPT views', () => {
    const rect = { x: 1, y: 2, width: 30, height: 40 };
    const url = 'https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

    it('is passed on as the last argument when given, and the surface is called exactly as before when not', async () => {
      const s = setup();
      await s.call(CH.chatgptSetBounds, s.good(), rect, 'prj_a');
      expect(s.chatgpt.setBounds).toHaveBeenLastCalledWith(rect, 'prj_a');
      await s.call(CH.chatgptSetBounds, s.good(), null, 'prj_a');
      expect(s.chatgpt.setBounds).toHaveBeenLastCalledWith(null, 'prj_a');
      await s.call(CH.chatgptSetBounds, s.good(), rect);
      expect(s.chatgpt.setBounds).toHaveBeenLastCalledWith(rect);
      await s.call(CH.chatgptSetBounds, s.good(), rect, null);
      expect(s.chatgpt.setBounds).toHaveBeenLastCalledWith(rect);
      await s.call(CH.chatgptNavigate, s.good(), `${url}?x=1`, 'prj_a');
      expect(s.chatgpt.navigate).toHaveBeenLastCalledWith(url, 'prj_a');
      await s.call(CH.chatgptNavigate, s.good(), url);
      expect(s.chatgpt.navigate).toHaveBeenLastCalledWith(url);
      for (const [channel, fn] of [[CH.chatgptReload, s.chatgpt.reload], [CH.chatgptBack, s.chatgpt.back], [CH.chatgptForward, s.chatgpt.forward], [CH.chatgptFocus, s.chatgpt.focus], [CH.chatgptGetState, s.chatgpt.getState]] as const) {
        await s.call(channel, s.good(), 'prj_a');
        expect(fn).toHaveBeenLastCalledWith('prj_a');
        await s.call(channel, s.good());
        expect(fn).toHaveBeenLastCalledWith();
      }
    });

    it('is refused when it is not a short key of plain characters, and nothing is done', async () => {
      const s = setup();
      for (const junk of ['', 'a b', '../x', 'x'.repeat(101), 'prj/a', 7, {}, ['prj_a']]) {
        await expect(s.call(CH.chatgptSetBounds, s.good(), rect, junk), String(junk)).rejects.toThrow(/Invalid view key/);
        await expect(s.call(CH.chatgptNavigate, s.good(), url, junk)).rejects.toThrow(/Invalid view key/);
        await expect(s.call(CH.chatgptGetState, s.good(), junk)).rejects.toThrow(/Invalid view key/);
      }
      expect(s.chatgpt.setBounds).not.toHaveBeenCalled();
      expect(s.chatgpt.navigate).not.toHaveBeenCalled();
    });

    it('the overlay switch takes no key: it covers every view', async () => {
      const s = setup();
      await s.call(CH.chatgptSetOverlayActive, s.good(), true, 'prj_a');
      expect(s.chatgpt.setOverlayActive).toHaveBeenLastCalledWith(true);
    });
  });

  describe('sender checks (every channel)', () => {
    const argsFor: Record<string, unknown[]> = {
      [CH.chatgptSetBounds]: [null],
      [CH.chatgptSetOverlayActive]: [true],
      [CH.chatgptNavigate]: ['https://chatgpt.com/'],
      [CH.claudeWebSetBounds]: [null],
      [CH.claudeWebNavigate]: ['https://claude.ai/code'],
      [CH.clipboardWriteText]: ['x'],
      [CH.openExternal]: ['https://example.org/'],
      [CH.showItemInFolder]: ['/tmp/x'],
      [CH.setBadgeCount]: [1],
    };
    const bad: [string, (e: InvokeEventLike) => InvokeEventLike][] = [
      ['another web contents', (e) => ({ ...e, sender: { id: 99 } })],
      ['a different origin', (e) => ({ ...e, senderFrame: { url: 'https://chatgpt.com/', parent: null } })],
      ['a subframe', (e) => ({ ...e, senderFrame: { url: `${CORE}/ui/`, parent: {} } })],
      ['a destroyed frame', (e) => ({ ...e, senderFrame: null })],
    ];
    for (const channel of INVOKE_CHANNELS) {
      for (const [name, mutate] of bad) {
        it(`${channel} refuses ${name}`, async () => {
          const s = setup();
          await expect(s.call(channel, mutate(s.good()), ...(argsFor[channel] ?? []))).rejects.toBeInstanceOf(UntrustedSenderError);
          expect(s.deps.connection).not.toHaveBeenCalled();
          expect(s.deps.writeClipboard).not.toHaveBeenCalled();
          expect(s.deps.openExternal).not.toHaveBeenCalled();
          expect(s.deps.selectDirectory).not.toHaveBeenCalled();
          expect(s.deps.showItemInFolder).not.toHaveBeenCalled();
          expect(s.chatgpt.navigate).not.toHaveBeenCalled();
          for (const fn of Object.values(s.claudeWeb)) expect(fn).not.toHaveBeenCalled();
        });
      }
    }

    it('refuses everything while there is no main window', async () => {
      const s = setup();
      s.deps.mainContentsId = () => null;
      const handlers2 = new Map<string, (event: InvokeEventLike, ...args: unknown[]) => unknown>();
      registerIpc({ ...s.deps, mainContentsId: () => null, ipcMain: { handle: (c, l) => { handlers2.set(c, l); }, removeHandler: () => undefined } });
      await expect(Promise.resolve().then(() => handlers2.get(CH.connection)!(s.good()))).rejects.toBeInstanceOf(UntrustedSenderError);
    });

    it('logs a rejection without logging arguments or the token', async () => {
      const s = setup();
      await expect(s.call(CH.connection, { sender: { id: 1 }, senderFrame: { url: 'https://evil.example/path?secret=1', parent: null } })).rejects.toThrow();
      const logged = JSON.stringify(s.log.warn.mock.calls);
      expect(logged).toContain('ipc rejected');
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain('secret=1');
    });
  });

  describe('connection', () => {
    it('hands the address and token to the trusted renderer', async () => {
      const s = setup();
      expect(await s.call(CH.connection, s.good())).toEqual({ baseUrl: CORE, token: TOKEN });
    });
  });

  describe('argument validation', () => {
    it('setBounds passes a clean rectangle or null and refuses junk', async () => {
      const s = setup();
      await s.call(CH.chatgptSetBounds, s.good(), { x: 1, y: 2, width: 30, height: 40, evil: true });
      expect(s.chatgpt.setBounds).toHaveBeenLastCalledWith({ x: 1, y: 2, width: 30, height: 40 });
      await s.call(CH.chatgptSetBounds, s.good(), null);
      expect(s.chatgpt.setBounds).toHaveBeenLastCalledWith(null);
      s.chatgpt.setBounds.mockClear();
      for (const junk of [undefined, 'x', { x: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
        await expect(s.call(CH.chatgptSetBounds, s.good(), junk)).rejects.toThrow(/Invalid bounds/);
      }
      expect(s.chatgpt.setBounds).not.toHaveBeenCalled();
    });

    it('navigate accepts only chatgpt.com addresses and passes the normalized one', async () => {
      const s = setup();
      const id = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
      await s.call(CH.chatgptNavigate, s.good(), `https://chatgpt.com/c/${id}?x=1`);
      expect(s.chatgpt.navigate).toHaveBeenCalledWith(`https://chatgpt.com/c/${id}`);
      s.chatgpt.navigate.mockClear();
      for (const junk of ['https://example.org/', 'http://chatgpt.com/', 'javascript:1', 7, undefined]) {
        await expect(s.call(CH.chatgptNavigate, s.good(), junk)).rejects.toThrow(/Invalid ChatGPT address/);
      }
      expect(s.chatgpt.navigate).not.toHaveBeenCalled();
    });

    it('overlay flag must be a boolean', async () => {
      const s = setup();
      await s.call(CH.chatgptSetOverlayActive, s.good(), true);
      expect(s.chatgpt.setOverlayActive).toHaveBeenCalledWith(true);
      await expect(s.call(CH.chatgptSetOverlayActive, s.good(), 'yes')).rejects.toThrow(/Invalid overlay flag/);
    });

    it('openExternal accepts https only', async () => {
      const s = setup();
      await s.call(CH.openExternal, s.good(), 'https://example.org/docs');
      expect(s.deps.openExternal).toHaveBeenCalledWith('https://example.org/docs');
      for (const junk of ['http://example.org/', 'file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 5]) {
        await expect(s.call(CH.openExternal, s.good(), junk)).rejects.toThrow(/Invalid link/);
      }
      expect(s.deps.openExternal).toHaveBeenCalledTimes(1);
    });

    it('showItemInFolder needs an absolute path', async () => {
      const s = setup();
      await s.call(CH.showItemInFolder, s.good(), '/tmp/report.md');
      expect(s.deps.showItemInFolder).toHaveBeenCalledWith('/tmp/report.md');
      await expect(s.call(CH.showItemInFolder, s.good(), 'report.md')).rejects.toThrow(/Invalid path/);
      await expect(s.call(CH.showItemInFolder, s.good(), '/tmp/a\0b')).rejects.toThrow(/Invalid path/);
    });

    it('clipboard text must be a string', async () => {
      const s = setup();
      await s.call(CH.clipboardWriteText, s.good(), 'hello');
      expect(s.deps.writeClipboard).toHaveBeenCalledWith('hello');
      await expect(s.call(CH.clipboardWriteText, s.good(), { text: 'x' })).rejects.toThrow(/Invalid clipboard text/);
    });

    it('selectDirectory strips unknown options', async () => {
      const s = setup();
      expect(await s.call(CH.selectDirectory, s.good(), { title: 'Choose', properties: ['openFile', 'multiSelections'] })).toBe('/picked');
      expect(s.deps.selectDirectory).toHaveBeenCalledWith({ title: 'Choose' });
      expect(await s.call(CH.selectDirectory, s.good())).toBe('/picked');
      expect(s.deps.selectDirectory).toHaveBeenLastCalledWith({});
    });

    it('badge count must be a small non-negative integer', async () => {
      const s = setup();
      await s.call(CH.setBadgeCount, s.good(), 4);
      expect(s.deps.setBadgeCount).toHaveBeenCalledWith(4);
      await expect(s.call(CH.setBadgeCount, s.good(), -1)).rejects.toThrow(/Invalid badge count/);
    });

    it('navigation commands and state need no arguments', async () => {
      const s = setup();
      await s.call(CH.chatgptReload, s.good());
      await s.call(CH.chatgptBack, s.good());
      await s.call(CH.chatgptForward, s.good());
      await s.call(CH.chatgptFocus, s.good());
      expect(s.chatgpt.reload).toHaveBeenCalled();
      expect(s.chatgpt.back).toHaveBeenCalled();
      expect(s.chatgpt.forward).toHaveBeenCalled();
      expect(s.chatgpt.focus).toHaveBeenCalled();
      expect(await s.call(CH.chatgptGetState, s.good())).toMatchObject({ mode: 'embedded', status: 'idle' });
      expect(await s.call(CH.getPaths, s.good())).toEqual({ dataDir: '/d', logsDir: '/l' });
    });
  });
});

describe('registerIpc: Claude Code on the web', () => {
  it('has seven channels of its own and no overlay channel: the one for ChatGPT switches both native views', () => {
    const claudeChannels = Object.entries(CH).filter(([name]) => name.startsWith('claudeWeb')).map(([, channel]) => channel).sort();
    expect(claudeChannels).toEqual([
      'ms:claudeWeb:back', 'ms:claudeWeb:focus', 'ms:claudeWeb:forward', 'ms:claudeWeb:getState', 'ms:claudeWeb:navigate', 'ms:claudeWeb:reload',
      'ms:claudeWeb:setBounds', 'ms:claudeWeb:state',
    ]);
    // 'ms:claudeWeb:state' is main -> renderer only; the other seven can be invoked.
    const invokable = claudeChannels.filter((channel) => (INVOKE_CHANNELS as readonly string[]).includes(channel));
    expect(invokable).toHaveLength(7);
    expect(invokable).not.toContain(CH.claudeWebState);
    expect(claudeChannels.some((channel) => /overlay/i.test(channel))).toBe(false);
  });

  it('setBounds passes a clean rectangle or null to the Claude view and refuses junk', async () => {
    const s = setup();
    await s.call(CH.claudeWebSetBounds, s.good(), { x: 1, y: 2, width: 30, height: 40, evil: true });
    expect(s.claudeWeb.setBounds).toHaveBeenLastCalledWith({ x: 1, y: 2, width: 30, height: 40 });
    await s.call(CH.claudeWebSetBounds, s.good(), null);
    expect(s.claudeWeb.setBounds).toHaveBeenLastCalledWith(null);
    s.claudeWeb.setBounds.mockClear();
    for (const junk of [undefined, 'x', { x: 1 }, { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: -1, height: 1 }, { x: 0, y: 0, width: 1e9, height: 1 }]) {
      await expect(s.call(CH.claudeWebSetBounds, s.good(), junk)).rejects.toThrow(/Invalid bounds/);
    }
    expect(s.claudeWeb.setBounds).not.toHaveBeenCalled();
    expect(s.chatgpt.setBounds).not.toHaveBeenCalled();
  });

  it('navigate accepts only https addresses on claude.ai/code, keeps the query and passes the normalized address', async () => {
    const s = setup();
    await s.call(CH.claudeWebNavigate, s.good(), 'https://claude.ai/code?repositories=acme/webapp#x');
    expect(s.claudeWeb.navigate).toHaveBeenLastCalledWith('https://claude.ai/code?repositories=acme/webapp');
    // Built from parts: nothing in this repository may look like a real session address (made-up id).
    const sessionPage = (host: string, tail = ''): string => `https://${host}/code/session_abc123${tail}`;
    await s.call(CH.claudeWebNavigate, s.good(), sessionPage('www.claude.ai', '/'));
    expect(s.claudeWeb.navigate).toHaveBeenLastCalledWith(sessionPage('claude.ai'));
    s.claudeWeb.navigate.mockClear();
    for (const junk of [
      'https://example.org/code', 'http://claude.ai/code', 'claude.ai/code', 'javascript:1', 'file:///etc/passwd', 'https://claude.ai/chat/abc', 'https://claude.ai/login',
      'https://u:p@claude.ai/code', 'https://claude.ai.evil.example/code', 'https://claude.ai\\@evil.example/code', `https://claude.ai/code?x=${'a'.repeat(3000)}`, 7, null, undefined, {},
    ]) {
      await expect(s.call(CH.claudeWebNavigate, s.good(), junk)).rejects.toThrow(/Invalid Claude Code address/);
    }
    expect(s.claudeWeb.navigate).not.toHaveBeenCalled();
    expect(s.chatgpt.navigate).not.toHaveBeenCalled();
  });

  it('the ChatGPT and Claude surfaces do not answer for each other', async () => {
    const s = setup();
    await expect(s.call(CH.chatgptNavigate, s.good(), 'https://claude.ai/code')).rejects.toThrow(/Invalid ChatGPT address/);
    await expect(s.call(CH.claudeWebNavigate, s.good(), 'https://chatgpt.com/')).rejects.toThrow(/Invalid Claude Code address/);
    await s.call(CH.chatgptSetBounds, s.good(), { x: 0, y: 0, width: 10, height: 10 });
    expect(s.claudeWeb.setBounds).not.toHaveBeenCalled();
    await s.call(CH.claudeWebSetBounds, s.good(), { x: 5, y: 5, width: 10, height: 10 });
    expect(s.chatgpt.setBounds).toHaveBeenCalledTimes(1);
  });

  it('navigation commands, focus and state need no arguments and reach the Claude view only', async () => {
    const s = setup();
    await s.call(CH.claudeWebReload, s.good());
    await s.call(CH.claudeWebBack, s.good());
    await s.call(CH.claudeWebForward, s.good());
    await s.call(CH.claudeWebFocus, s.good());
    expect(s.claudeWeb.reload).toHaveBeenCalled();
    expect(s.claudeWeb.back).toHaveBeenCalled();
    expect(s.claudeWeb.forward).toHaveBeenCalled();
    expect(s.claudeWeb.focus).toHaveBeenCalled();
    for (const fn of [s.chatgpt.reload, s.chatgpt.back, s.chatgpt.forward, s.chatgpt.focus]) expect(fn).not.toHaveBeenCalled();
    expect(await s.call(CH.claudeWebGetState, s.good())).toEqual({ status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null });
  });

  it('the one overlay switch reaches both native views, with the same flag', async () => {
    const s = setup();
    await s.call(CH.chatgptSetOverlayActive, s.good(), true);
    expect(s.chatgpt.setOverlayActive).toHaveBeenCalledTimes(1);
    expect(s.chatgpt.setOverlayActive).toHaveBeenLastCalledWith(true);
    expect(s.claudeWeb.setOverlayActive).toHaveBeenCalledTimes(1);
    expect(s.claudeWeb.setOverlayActive).toHaveBeenLastCalledWith(true);
    await s.call(CH.chatgptSetOverlayActive, s.good(), false);
    expect(s.chatgpt.setOverlayActive).toHaveBeenLastCalledWith(false);
    expect(s.claudeWeb.setOverlayActive).toHaveBeenLastCalledWith(false);
  });

  it('a bad overlay flag reaches neither view', async () => {
    const s = setup();
    for (const junk of ['yes', 1, null, undefined]) await expect(s.call(CH.chatgptSetOverlayActive, s.good(), junk)).rejects.toThrow(/Invalid overlay flag/);
    expect(s.chatgpt.setOverlayActive).not.toHaveBeenCalled();
    expect(s.claudeWeb.setOverlayActive).not.toHaveBeenCalled();
  });

  it('one view failing to switch does not leave the other drawn over the dialog, and is logged', async () => {
    const s = setup();
    s.chatgpt.setOverlayActive.mockImplementation(() => { throw new Error('the ChatGPT view is gone'); });
    await s.call(CH.chatgptSetOverlayActive, s.good(), true);
    expect(s.claudeWeb.setOverlayActive).toHaveBeenCalledWith(true);
    expect(s.log.warn).toHaveBeenCalledWith('overlay switch failed', expect.objectContaining({ view: 'chatgpt' }));

    const t = setup();
    t.claudeWeb.setOverlayActive.mockImplementation(() => { throw new Error('the Claude view is gone'); });
    await t.call(CH.chatgptSetOverlayActive, t.good(), true);
    expect(t.chatgpt.setOverlayActive).toHaveBeenCalledWith(true);
    expect(t.log.warn).toHaveBeenCalledWith('overlay switch failed', expect.objectContaining({ view: 'claudeWeb' }));
  });
});
