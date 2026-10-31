// The embedded view's status in plain words. The host's own note wins when it has one, because it knows why.
import type { ChatGptViewState } from '@minisumma/shared';

export interface StatusLine { tone: 'busy' | 'attention' | 'error'; text: string }

const DEFAULTS: Record<'login_required' | 'challenge' | 'blocked' | 'error', string> = {
  login_required: 'ChatGPT needs you to sign in. Sign in here, in this pane.',
  challenge: 'ChatGPT is showing a security check. Complete it in this pane; Mini-Summa does not solve or skip checks.',
  blocked: 'ChatGPT refused to open in this view. External browser mode is available in Settings.',
  error: 'ChatGPT could not be loaded. Check your connection and reload.',
};

/** null when there is nothing worth saying (ready, or nothing loaded yet). */
export function describeStatus(state: ChatGptViewState | null): StatusLine | null {
  if (!state) return null;
  switch (state.status) {
    case 'loading': return { tone: 'busy', text: 'Loading ChatGPT.' };
    case 'login_required': return { tone: 'attention', text: state.note ?? DEFAULTS.login_required };
    case 'challenge': return { tone: 'attention', text: state.note ?? DEFAULTS.challenge };
    case 'blocked': return { tone: 'error', text: state.note ?? DEFAULTS.blocked };
    case 'error': return { tone: 'error', text: state.note ?? DEFAULTS.error };
    default: return null;
  }
}
