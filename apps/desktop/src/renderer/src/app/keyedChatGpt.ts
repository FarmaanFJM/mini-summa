// The ChatGPT calls of the native shell for ONE project's view. With live views the key (the project's id) goes last; a host with one view
// is called exactly as it always was, without a key at all.
import type { ChatGptViewState } from '@minisumma/shared';
import type { RendererNative } from './native';

export interface KeyedChatGpt {
  getState(): Promise<ChatGptViewState>;
  onState(listener: (state: ChatGptViewState) => void): () => void;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
}

export function keyedChatGpt(native: RendererNative, key: string | undefined): KeyedChatGpt {
  const c = native.chatgpt;
  return key === undefined
    ? { getState: () => c.getState(), onState: (l) => c.onState(l), navigate: (u) => c.navigate(u), back: () => c.back(), forward: () => c.forward(), reload: () => c.reload() }
    : { getState: () => c.getState(key), onState: (l) => c.onState(l, key), navigate: (u) => c.navigate(u, key), back: () => c.back(key), forward: () => c.forward(key), reload: () => c.reload(key) };
}
