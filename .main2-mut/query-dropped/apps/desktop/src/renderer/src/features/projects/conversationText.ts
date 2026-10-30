// The words used about ChatGPT conversations in the project settings.
import type { ChatGptUrlKind, ConversationVerification } from '@minisumma/shared';

export const KIND_LABEL: Record<ChatGptUrlKind, string> = {
  chat: 'Conversation',
  project_chat: 'Conversation in a ChatGPT project',
  gpt_chat: 'Conversation with a custom GPT',
  project: 'ChatGPT project page',
  other: 'ChatGPT page',
};

/** The verification state in plain words. "Verified" only ever means a page title matched; nothing is read from the page. */
export function verificationText(state: ConversationVerification, title: string | null): string {
  switch (state) {
    case 'unverified': return 'Not verified yet';
    case 'verified': return title ? `Verified: ${title}` : 'Verified';
    case 'mismatch': return 'The page that opened did not match this conversation';
    case 'unreachable': return 'ChatGPT could not be reached';
    case 'login_required': return 'Sign in to ChatGPT, then verify again';
  }
}
