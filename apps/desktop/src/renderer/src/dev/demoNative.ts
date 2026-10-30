// A stand-in for window.miniSumma in demo mode. It draws a plain rectangle where the native ChatGPT view would be, above
// all web content just like the real one, so the bounds reporting and the overlay guard can be seen working in a browser.
import type { ChatGptViewState, Rect } from '@minisumma/shared';
import { createBrowserNative } from '../app/native';
import type { RendererNative } from '../app/native';

export interface DemoNativeOptions {
  /** Titles by address, so the simulated page can say which conversation it shows. */
  titleFor?: (url: string) => string | null;
  /** The folder the pretend picker returns. */
  pickedFolder?: string;
}

const STYLE = [
  'position:fixed', 'z-index:2147483000', 'display:none', 'box-sizing:border-box', 'overflow:hidden', 'background:#212121', 'color:#c9c9c9',
  'font:14px/1.5 Inter,system-ui,sans-serif', 'pointer-events:auto',
].join(';');

export function createDemoNative(options: DemoNativeOptions = {}): RendererNative & { destroy(): void } {
  const base = createBrowserNative();
  const view = document.createElement('div');
  view.setAttribute('data-demo-native-view', '');
  view.style.cssText = STYLE;
  document.body.appendChild(view);

  let bounds: Rect | null = null;
  let overlay = false;
  let state: ChatGptViewState = { mode: 'embedded', status: 'ready', url: null, title: null, canGoBack: false, canGoForward: false, note: null };
  const listeners = new Set<(s: ChatGptViewState) => void>();

  const paint = () => {
    if (!bounds || overlay || bounds.width < 1 || bounds.height < 1) { view.style.display = 'none'; return; }
    view.style.display = 'block';
    view.style.left = `${bounds.x}px`;
    view.style.top = `${bounds.y}px`;
    view.style.width = `${bounds.width}px`;
    view.style.height = `${bounds.height}px`;
  };
  const content = () => {
    const title = state.title ?? 'New chat';
    view.innerHTML = '';
    const frame = document.createElement('div');
    frame.style.cssText = 'height:100%;display:flex;flex-direction:column;padding:18px 22px;gap:14px';
    const label = document.createElement('div');
    label.textContent = 'Embedded ChatGPT view (simulated in the demo)';
    label.style.cssText = 'font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#8a8a8a';
    const head = document.createElement('div');
    head.textContent = title;
    head.style.cssText = 'font-size:16px;font-weight:600;color:#ececec';
    const bubble = (text: string, mine: boolean) => {
      const b = document.createElement('div');
      b.textContent = text;
      b.style.cssText = `max-width:78%;padding:10px 14px;border-radius:16px;background:${mine ? '#303030' : 'transparent'};align-self:${mine ? 'flex-end' : 'flex-start'};color:${mine ? '#ececec' : '#c9c9c9'}`;
      return b;
    };
    const composer = document.createElement('div');
    composer.textContent = 'Message';
    composer.style.cssText = 'margin-top:auto;padding:12px 16px;border-radius:24px;background:#303030;color:#8a8a8a';
    frame.append(label, head,
      bubble('Here is the report from Claude Code for the retry test fix.', true),
      bubble('Looks reasonable. Check that the fake clock is also used in the second backoff test, and ask Claude to run the suite on Linux as well.', false),
      composer);
    view.appendChild(frame);
  };
  const emit = () => { for (const l of listeners) l(state); };
  const setState = (next: Partial<ChatGptViewState>) => { state = { ...state, ...next }; content(); emit(); };
  content();

  const native: RendererNative & { destroy(): void } = {
    ...base,
    platform: 'win32',
    hasEmbeddedChatGpt: true,
    hasFolderPicker: true,
    chatgpt: {
      setBounds: async (rect) => { bounds = rect; paint(); },
      setOverlayActive: async (active) => { overlay = active; view.dataset.overlay = String(active); paint(); },
      navigate: async (url) => {
        setState({ url, title: options.titleFor?.(url) ?? 'ChatGPT', status: 'loading' });
        setTimeout(() => setState({ status: 'ready' }), 250);
      },
      reload: async () => { setState({ status: 'loading' }); setTimeout(() => setState({ status: 'ready' }), 250); },
      back: async () => {}, forward: async () => {}, focus: async () => {},
      getState: async () => state,
      onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    dialogs: { selectDirectory: async () => options.pickedFolder ?? 'C:\\Dev\\PickedFolder' },
    destroy() { view.remove(); },
  };
  return native;
}
