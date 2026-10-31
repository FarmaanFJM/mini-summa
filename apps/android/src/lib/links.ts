// Opening web addresses. Only two destinations exist: a ChatGPT conversation the user mapped, and claude.ai/code.
// Anything else the desktop sends is refused here, because Linking.openURL would hand it to whatever app claims it.
import { Linking } from 'react-native';
import { parseChatGptUrl } from '@minisumma/shared';

export const CLAUDE_CODE_URL = 'https://claude.ai/code';

export type OpenResult = { ok: true } | { ok: false; message: string };

const COULD_NOT_OPEN = 'Could not open the link. Check that a browser or the ChatGPT app is installed.';

export async function openChatGpt(url: string): Promise<OpenResult> {
  const parsed = parseChatGptUrl(url);
  if (!parsed.ok) return { ok: false, message: 'That is not a ChatGPT address, so it was not opened.' };
  try {
    await Linking.openURL(parsed.info.url);
    return { ok: true };
  } catch {
    return { ok: false, message: COULD_NOT_OPEN };
  }
}

export async function openClaudeCode(): Promise<OpenResult> {
  try {
    await Linking.openURL(CLAUDE_CODE_URL);
    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not open claude.ai/code. Check that a browser is installed.' };
  }
}
