// `conversations.open` and `conversations.verify`.
//
// contracts.ts has no service for these two routes, so they are built here from the host (NativeBridge), the extension
// bridge and the settings. Nothing here submits anything to ChatGPT or reads its answers: it opens a page, and it
// reports what the host could observe about it, no more.
import type { ChatGptOpenResult, ChatGptViewState, Conversation, ConversationVerification, NativeBridge } from '@minisumma/shared';
import type { ExtensionBridge, SettingsService } from '../contracts.ts';
import { unavailable } from '../errors.ts';

export interface ConversationActions {
  open(conversation: Conversation): Promise<ChatGptOpenResult>;
  verify(conversation: Conversation): Promise<{ verification: ConversationVerification; title: string | null }>;
}

const none = (note: string): ChatGptOpenResult =>
  ({ ok: false, mode: 'none', opened: false, focused: false, verified: null, finalUrl: null, title: null, note });

export function verificationOf(result: ChatGptOpenResult, view: Pick<ChatGptViewState, 'status'>): ConversationVerification {
  if (view.status === 'login_required') return 'login_required';
  if (!result.ok || view.status === 'challenge' || view.status === 'blocked' || view.status === 'error') return 'unreachable';
  if (result.verified === true) return 'verified';
  if (result.verified === false) return 'mismatch';
  return 'unverified';
}

export function createConversationActions(deps: { native: NativeBridge | undefined; settings: SettingsService; bridge: ExtensionBridge }): ConversationActions {
  return {
    async open(conversation) {
      const { native } = deps;
      const caps = native?.capabilities();
      const mode = deps.settings.get().chatgpt;
      if (native && caps?.chatgptEmbedded && mode.mode === 'embedded') {
        return native.chatgpt.open(conversation.url, { focus: true, reason: 'user' });
      }
      let extensionNote: string | null = null;
      if (mode.mode === 'external' && mode.externalBrowser === 'extension' && deps.bridge.connected()) {
        const viaExtension = await deps.bridge.openOrFocus(conversation.url);
        if (viaExtension.ok) return viaExtension;
        extensionNote = viaExtension.note;
      }
      if (native && caps?.openExternal) {
        await native.openExternal(conversation.url);
        const note = [extensionNote, 'Opened in your default browser. Mini-Summa cannot see which page is showing.'].filter(Boolean).join(' ');
        return { ok: true, mode: 'external', opened: true, focused: false, verified: null, finalUrl: null, title: null, note };
      }
      return none([extensionNote, 'This copy of Mini-Summa cannot open a browser. Open the conversation yourself.'].filter(Boolean).join(' '));
    },

    async verify(conversation) {
      const { native } = deps;
      if (!native || !native.capabilities().chatgptEmbedded) {
        throw unavailable('Checking a conversation needs the ChatGPT view inside the Mini-Summa desktop app, which is not available here. Open the conversation yourself and check its title.', 'verify_unavailable');
      }
      const result = await native.chatgpt.verify(conversation.url);
      return { verification: verificationOf(result, native.chatgpt.state()), title: result.title };
    },
  };
}
