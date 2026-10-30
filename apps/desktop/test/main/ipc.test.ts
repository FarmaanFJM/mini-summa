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
  const deps = {
    ipcMain: {
      handle: (channel: string, listener: (event: InvokeEventLike, ...args: unknown[]) => unknown) => { handlers.set(channel, listener); },
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
    },
    coreOrigin: CORE,
    mainContentsId: () => MAIN_ID as number | null,
    connection: vi.fn(() => ({ baseUrl: CORE, token: TOKEN })),
    chatgpt,
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
  return { handlers, deps, chatgpt, log, dispose, good, call };
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

  describe('sender checks (every channel)', () => {
    const argsFor: Record<string, unknown[]> = {
      [CH.chatgptSetBounds]: [null],
      [CH.chatgptSetOverlayActive]: [true],
      [CH.chatgptNavigate]: ['https://chatgpt.com/'],
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
