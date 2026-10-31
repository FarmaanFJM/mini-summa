// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ChatGptView } from '../../src/main/chatgptView.ts';
import type { ViewContents, ViewHandle } from '../../src/main/chatgptView.ts';
import { CH } from '../../src/main/channels.ts';
import { ClaudeWebView } from '../../src/main/claudeView.ts';
import type { ClaudeViewHandle } from '../../src/main/claudeView.ts';
import { registerIpc } from '../../src/main/ipc.ts';
import type { InvokeEventLike } from '../../src/main/ipc.ts';

// The real controllers of both native views, wired to the real IPC layer, with recorders in place of the two native views. What is checked
// is what the person sees: which view is drawn when a menu, dialog or toast of the renderer is open, and which comes back after it.

const CORE = 'http://127.0.0.1:40555';
const CONV = 'https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CLAUDE = 'https://claude.ai/code?repositories=acme/webapp';
const CHATGPT_RECT = { x: 0, y: 50, width: 700, height: 800 };
const CLAUDE_RECT = { x: 700, y: 50, width: 700, height: 800 };

/** Enough of a web contents for both controllers. Nothing ever loads: only the native view's visibility is under test. */
class StubContents extends EventEmitter implements ViewContents {
  getURL() { return ''; }
  getTitle() { return ''; }
  isLoading() { return false; }
  isFocused() { return false; }
  isDestroyed() { return false; }
  loadURL() { return Promise.resolve(); }
  reload() { /* not used here */ }
  stop() { /* not used here */ }
  canGoBack() { return false; }
  canGoForward() { return false; }
  goBack() { /* not used here */ }
  goForward() { /* not used here */ }
  focus() { /* not used here */ }
  getZoomFactor() { return 1; }
  setZoomFactor() { /* not used here */ }
  setWindowOpenHandler() { /* not used here */ }
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function setup() {
  const chatgptHandle = { contents: new StubContents(), setBounds: vi.fn(), setVisible: vi.fn() } satisfies ViewHandle;
  const claudeHandle = { contents: new StubContents(), setBounds: vi.fn(), setVisible: vi.fn() } satisfies ClaudeViewHandle;
  const content = () => ({ width: 1600, height: 900, zoomFactor: 1 });
  const chatgpt = new ChatGptView({ createView: vi.fn(() => chatgptHandle), content, requestWorkspace: vi.fn(), revealWindow: vi.fn(), openExternal: vi.fn(), log: log() });
  const claudeWeb = new ClaudeWebView({ createView: vi.fn(() => claudeHandle), content, openExternal: vi.fn(), log: log() });

  const handlers = new Map<string, (event: InvokeEventLike, ...args: unknown[]) => unknown>();
  registerIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: (channel) => { handlers.delete(channel); } },
    coreOrigin: CORE,
    mainContentsId: () => 3,
    connection: () => ({ baseUrl: CORE, token: 't' }),
    chatgpt,
    claudeWeb,
    writeClipboard: async () => undefined,
    openExternal: async () => undefined,
    selectDirectory: async () => null,
    showItemInFolder: () => undefined,
    setBadgeCount: () => undefined,
    paths: () => ({ dataDir: '/d', logsDir: '/l' }),
    log: log(),
  });
  const event: InvokeEventLike = { sender: { id: 3 }, senderFrame: { url: `${CORE}/ui/`, parent: null } };
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  /** What the person sees now: true while the native view is drawn. */
  const drawn = (handle: { setVisible: ReturnType<typeof vi.fn> }): boolean => handle.setVisible.mock.calls.at(-1)?.[0] === true;
  const everShown = (handle: { setVisible: ReturnType<typeof vi.fn> }): boolean => handle.setVisible.mock.calls.some((c) => c[0] === true);
  return { chatgpt, claudeWeb, chatgptHandle, claudeHandle, call, drawn, everShown };
}

describe('the overlay switch covers both native views', () => {
  it('hides both while a dialog is open and puts both back when it closes', async () => {
    const s = setup();
    await s.call(CH.chatgptNavigate, CONV);
    await s.call(CH.claudeWebNavigate, CLAUDE);
    await s.call(CH.chatgptSetBounds, CHATGPT_RECT);
    await s.call(CH.claudeWebSetBounds, CLAUDE_RECT);
    expect(s.drawn(s.chatgptHandle)).toBe(true);
    expect(s.drawn(s.claudeHandle)).toBe(true);

    await s.call(CH.chatgptSetOverlayActive, true);
    expect(s.drawn(s.chatgptHandle)).toBe(false);
    expect(s.drawn(s.claudeHandle)).toBe(false);
    expect(s.chatgpt.showing).toBe(false);
    expect(s.claudeWeb.showing).toBe(false);

    await s.call(CH.chatgptSetOverlayActive, false);
    expect(s.drawn(s.chatgptHandle)).toBe(true);
    expect(s.drawn(s.claudeHandle)).toBe(true);
  });

  it('puts back only the views that were showing: a hidden Claude view stays hidden, and so does a hidden ChatGPT view', async () => {
    const s = setup();
    await s.call(CH.chatgptNavigate, CONV);
    await s.call(CH.claudeWebNavigate, CLAUDE);
    await s.call(CH.chatgptSetBounds, CHATGPT_RECT);
    await s.call(CH.claudeWebSetBounds, null); // the Cloud tab is not the one on screen
    expect(s.drawn(s.chatgptHandle)).toBe(true);
    expect(s.drawn(s.claudeHandle)).toBe(false);
    s.claudeHandle.setVisible.mockClear();

    await s.call(CH.chatgptSetOverlayActive, true);
    await s.call(CH.chatgptSetOverlayActive, true);
    expect(s.drawn(s.chatgptHandle)).toBe(false);
    await s.call(CH.chatgptSetOverlayActive, false);
    expect(s.drawn(s.chatgptHandle)).toBe(true);
    expect(s.everShown(s.claudeHandle)).toBe(false);
    expect(s.claudeWeb.showing).toBe(false);

    // and the other way round: ChatGPT hidden (maximized Claude pane), Claude showing
    await s.call(CH.chatgptSetBounds, null);
    await s.call(CH.claudeWebSetBounds, CLAUDE_RECT);
    s.chatgptHandle.setVisible.mockClear();
    await s.call(CH.chatgptSetOverlayActive, true);
    await s.call(CH.chatgptSetOverlayActive, false);
    expect(s.drawn(s.claudeHandle)).toBe(true);
    expect(s.everShown(s.chatgptHandle)).toBe(false);
  });

  it('a rectangle that arrives while the dialog is open shows its view only after the dialog closes', async () => {
    const s = setup();
    await s.call(CH.chatgptNavigate, CONV);
    await s.call(CH.claudeWebNavigate, CLAUDE);
    await s.call(CH.chatgptSetOverlayActive, true);
    await s.call(CH.chatgptSetBounds, CHATGPT_RECT);
    await s.call(CH.claudeWebSetBounds, CLAUDE_RECT);
    expect(s.everShown(s.chatgptHandle)).toBe(false);
    expect(s.everShown(s.claudeHandle)).toBe(false);
    await s.call(CH.chatgptSetOverlayActive, false);
    expect(s.drawn(s.chatgptHandle)).toBe(true);
    expect(s.drawn(s.claudeHandle)).toBe(true);
  });

  it('a view created while a dialog is open starts hidden', async () => {
    const s = setup();
    await s.call(CH.claudeWebSetBounds, CLAUDE_RECT);
    await s.call(CH.chatgptSetOverlayActive, true);
    await s.call(CH.claudeWebNavigate, CLAUDE);
    expect(s.everShown(s.claudeHandle)).toBe(false);
    await s.call(CH.chatgptSetOverlayActive, false);
    expect(s.drawn(s.claudeHandle)).toBe(true);
  });

  it('is harmless while neither view exists yet, and creates neither', async () => {
    const s = setup();
    await s.call(CH.chatgptSetOverlayActive, true);
    await s.call(CH.chatgptSetOverlayActive, false);
    expect(s.chatgptHandle.setVisible).not.toHaveBeenCalled();
    expect(s.claudeHandle.setVisible).not.toHaveBeenCalled();
    expect(s.chatgpt.showing).toBe(false);
    expect(s.claudeWeb.showing).toBe(false);
  });
});
