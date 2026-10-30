// A stand-in for window.miniSumma in demo mode. It draws a plain rectangle where each native view would be (the ChatGPT page, and
// Claude Code on the web), above all web content just like the real ones, so the bounds reporting and the overlay guard can be seen
// working in a browser.
//
// The Claude Code page can be asked for in other states with `&claude=` in the address: `ready` (default), `login` (asks to sign
// in), `blocked`, `error`, or `none` (the host cannot embed it, as a browser cannot).
import type { ChatGptViewState, ClaudeWebViewState, Rect } from '@minisumma/shared';
import { createBrowserNative } from '../app/native';
import type { RendererNative } from '../app/native';

export type DemoClaudeMode = 'ready' | 'login' | 'blocked' | 'error' | 'none';

export interface DemoNativeOptions {
  /** Titles by address, so the simulated page can say which conversation it shows. */
  titleFor?: (url: string) => string | null;
  /** The folder the pretend picker returns. */
  pickedFolder?: string;
  /** How the pretend Claude Code page behaves. Default: what `&claude=` in the address says, else `ready`. */
  claude?: DemoClaudeMode;
}

const STYLE = [
  'position:fixed', 'z-index:2147483000', 'display:none', 'box-sizing:border-box', 'overflow:hidden', 'color:#c9c9c9',
  'font:14px/1.5 Inter,system-ui,sans-serif', 'pointer-events:auto',
].join(';');

/** A rectangle that stands where a native view would be: placed by bounds, hidden by an overlay. */
function surface(name: string, background: string) {
  const el = document.createElement('div');
  el.setAttribute('data-demo-native-view', name);
  el.style.cssText = `${STYLE};background:${background}`;
  document.body.appendChild(el);
  let bounds: Rect | null = null;
  let overlay = false;
  const paint = () => {
    if (!bounds || overlay || bounds.width < 1 || bounds.height < 1) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = `${bounds.x}px`;
    el.style.top = `${bounds.y}px`;
    el.style.width = `${bounds.width}px`;
    el.style.height = `${bounds.height}px`;
  };
  return {
    el,
    setBounds(rect: Rect | null) { bounds = rect; paint(); },
    setOverlay(active: boolean) { overlay = active; el.dataset.overlay = String(active); paint(); },
    destroy() { el.remove(); },
  };
}

const text = (value: string, css: string): HTMLDivElement => {
  const d = document.createElement('div');
  d.textContent = value;
  d.style.cssText = css;
  return d;
};

function claudeModeFromAddress(): DemoClaudeMode {
  const asked = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('claude') : null;
  return asked === 'login' || asked === 'blocked' || asked === 'error' || asked === 'none' ? asked : 'ready';
}

export function createDemoNative(options: DemoNativeOptions = {}): RendererNative & { destroy(): void } {
  const base = createBrowserNative();

  // ------------------------------------------------------------------------------------------ ChatGPT
  const chat = surface('chatgpt', '#212121');
  let state: ChatGptViewState = { mode: 'embedded', status: 'ready', url: null, title: null, canGoBack: false, canGoForward: false, note: null };
  const listeners = new Set<(s: ChatGptViewState) => void>();
  const content = () => {
    const title = state.title ?? 'New chat';
    chat.el.innerHTML = '';
    const frame = document.createElement('div');
    frame.style.cssText = 'height:100%;display:flex;flex-direction:column;padding:18px 22px;gap:14px';
    const label = text('Embedded ChatGPT view (simulated in the demo)', 'font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#8a8a8a');
    const head = text(title, 'font-size:16px;font-weight:600;color:#ececec');
    const bubble = (words: string, mine: boolean) => text(words, `max-width:78%;padding:10px 14px;border-radius:16px;background:${mine ? '#303030' : 'transparent'};align-self:${mine ? 'flex-end' : 'flex-start'};color:${mine ? '#ececec' : '#c9c9c9'}`);
    const composer = text('Message', 'margin-top:auto;padding:12px 16px;border-radius:24px;background:#303030;color:#8a8a8a');
    frame.append(label, head,
      bubble('Here is the report from Claude Code for the retry test fix.', true),
      bubble('Looks reasonable. Check that the fake clock is also used in the second backoff test, and ask Claude to run the suite on Linux as well.', false),
      composer);
    chat.el.appendChild(frame);
  };
  const emit = () => { for (const l of listeners) l(state); };
  const setState = (next: Partial<ChatGptViewState>) => { state = { ...state, ...next }; content(); emit(); };
  content();

  // ------------------------------------------------------------------------------------------ Claude Code on the web
  const mode = options.claude ?? claudeModeFromAddress();
  const claude = surface('claude-web', '#262624');
  const claudeListeners = new Set<(s: ClaudeWebViewState) => void>();
  const history: string[] = [];
  let at = -1;
  const idleClaude: ClaudeWebViewState = { status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null };
  let claudeState: ClaudeWebViewState = idleClaude;
  const claudePage = () => {
    claude.el.innerHTML = '';
    const frame = document.createElement('div');
    frame.style.cssText = 'height:100%;display:flex;flex-direction:column;padding:18px 22px;gap:14px';
    frame.appendChild(text('Embedded Claude Code view (simulated in the demo)', 'font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#8a8a8a'));
    const url = claudeState.url ?? '';
    if (claudeState.status === 'login_required') {
      frame.append(text('Sign in to Claude', 'font-size:16px;font-weight:600;color:#ececec'), text('Continue with Google', 'padding:10px 14px;border-radius:10px;background:#303030;color:#ececec;align-self:flex-start'));
    } else if (/\/code\/session_/.test(url)) {
      frame.append(
        text('Fix the flaky retry test', 'font-size:16px;font-weight:600;color:#ececec'),
        text('I looked at the retry test and replaced the real sleep with the fake clock. The suite passes on Linux.', 'max-width:78%;padding:10px 14px;border-radius:16px;background:#303030;color:#ececec;align-self:flex-end'),
        text('Done. I opened a pull request with the change.', 'max-width:78%;color:#c9c9c9'),
      );
    } else {
      const repos = new URL(url || 'https://claude.ai/code').searchParams.get('repositories');
      frame.append(
        text('Claude Code', 'font-size:16px;font-weight:600;color:#ececec'),
        text(repos ? `Repository: ${repos}` : 'Choose a repository', 'color:#c9c9c9'),
        text('Describe a task', 'margin-top:auto;padding:12px 16px;border-radius:16px;background:#303030;color:#8a8a8a'),
      );
    }
    claude.el.appendChild(frame);
  };
  const emitClaude = () => { for (const l of claudeListeners) l(claudeState); };
  const setClaude = (next: Partial<ClaudeWebViewState>) => {
    claudeState = { ...claudeState, ...next, canGoBack: at > 0, canGoForward: at < history.length - 1 };
    claudePage();
    emitClaude();
  };
  const settle = (): Partial<ClaudeWebViewState> => {
    if (mode === 'login') return { status: 'login_required', note: null };
    if (mode === 'blocked') return { status: 'blocked', note: null };
    if (mode === 'error') return { status: 'error', note: null };
    return { status: 'ready', note: null };
  };
  const load = (url: string) => {
    setClaude({ url, title: 'Claude Code', status: 'loading', note: null });
    setTimeout(() => setClaude(settle()), 250);
  };
  const claudeWeb: NonNullable<RendererNative['claudeWeb']> = {
    setBounds: async (rect) => { claude.setBounds(rect); },
    navigate: async (url) => { history.splice(at + 1); history.push(url); at = history.length - 1; load(url); },
    reload: async () => { if (claudeState.url) load(claudeState.url); },
    back: async () => { if (at > 0) { at -= 1; load(history[at]); } },
    forward: async () => { if (at < history.length - 1) { at += 1; load(history[at]); } },
    focus: async () => {},
    getState: async () => claudeState,
    onState: (listener) => { claudeListeners.add(listener); return () => { claudeListeners.delete(listener); }; },
  };
  claudePage();

  const native: RendererNative & { destroy(): void } = {
    ...base,
    platform: 'win32',
    hasEmbeddedChatGpt: true,
    hasFolderPicker: true,
    chatgpt: {
      setBounds: async (rect) => { chat.setBounds(rect); },
      setOverlayActive: async (active) => { chat.setOverlay(active); claude.setOverlay(active); },
      navigate: async (url) => {
        setState({ url, title: options.titleFor?.(url) ?? 'ChatGPT', status: 'loading' });
        setTimeout(() => setState({ status: 'ready' }), 250);
      },
      reload: async () => { setState({ status: 'loading' }); setTimeout(() => setState({ status: 'ready' }), 250); },
      back: async () => {}, forward: async () => {}, focus: async () => {},
      getState: async () => state,
      onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    ...(mode === 'none' ? {} : { claudeWeb }),
    dialogs: { selectDirectory: async () => options.pickedFolder ?? 'C:\\Dev\\PickedFolder' },
    destroy() { chat.destroy(); claude.destroy(); },
  };
  // Reachable from a screenshot script or the console, to drive a page the way the real one would move.
  (window as unknown as { __minisummaNative?: unknown }).__minisummaNative = native;
  return native;
}
