// ChatGPT URL handling. Pure string logic: it runs in Node, the browser, the extension service worker and React Native.
//
// Mini-Summa never discovers a conversation by looking at a focused tab. The user maps conversations explicitly, so
// this module only validates and normalizes what the user pasted, and decides whether two URLs name the same page.
import type { ChatGptUrlKind } from './entities.ts';

export interface ChatGptUrlInfo {
  /** Canonical form: https, host chatgpt.com, no query, no fragment, no trailing slash. */
  url: string;
  originalUrl: string;
  kind: ChatGptUrlKind;
  /** The conversation uuid, lowercase, when the path names one. */
  chatgptConversationId: string | null;
  /** `g-p-...` segment for project chats, `g-...` for custom GPT chats. */
  scopeId: string | null;
  host: 'chatgpt.com';
  legacyHost: boolean;
  warnings: string[];
}

export type ChatGptUrlResult =
  | { ok: true; info: ChatGptUrlInfo }
  | { ok: false; reason: 'empty' | 'not_https' | 'host_not_allowed' | 'unparsable'; message: string };

const HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RE_CHAT = new RegExp(`^/c/(${UUID})$`);
const RE_PROJECT_CHAT = new RegExp(`^/g/(g-p-[A-Za-z0-9-]+)/c/(${UUID})$`);
const RE_PROJECT = /^\/g\/(g-p-[A-Za-z0-9-]+)\/project$/;
const RE_GPT_CHAT = new RegExp(`^/g/(g-[A-Za-z0-9-]+)/c/(${UUID})$`);

const URL_RE = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)(?:\?[^#\s]*)?(?:#\S*)?$/i;

export function parseChatGptUrl(input: string): ChatGptUrlResult {
  const originalUrl = (input ?? '').trim();
  if (originalUrl === '') return { ok: false, reason: 'empty', message: 'Paste the address of a ChatGPT conversation.' };
  // "host:port/path" has a colon but no scheme; "javascript:..." and "file:///..." do have one and are never acceptable.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(originalUrl)?.[1]?.toLowerCase()
    ?? (/^(javascript|data|file|vbscript|blob|about|mailto):/i.exec(originalUrl)?.[1]?.toLowerCase());
  if (scheme && scheme !== 'https') return { ok: false, reason: 'not_https', message: 'Only https addresses are accepted.' };
  const candidate = scheme ? originalUrl : `https://${originalUrl}`;
  const m = URL_RE.exec(candidate);
  if (!m) return { ok: false, reason: 'unparsable', message: 'That does not look like a web address.' };
  // Strip a port or credentials: a host with either is not the ChatGPT site.
  const hostRaw = m[2].toLowerCase();
  if (!HOSTS.has(hostRaw)) {
    return { ok: false, reason: 'host_not_allowed', message: 'Only chatgpt.com conversation addresses are accepted.' };
  }
  const legacyHost = hostRaw === 'chat.openai.com';
  const path = (m[3] || '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  const warnings: string[] = [];
  let kind: ChatGptUrlKind = 'other';
  let chatgptConversationId: string | null = null;
  let scopeId: string | null = null;
  let hit: RegExpExecArray | null;
  if ((hit = RE_CHAT.exec(path))) { kind = 'chat'; chatgptConversationId = hit[1].toLowerCase(); }
  else if ((hit = RE_PROJECT_CHAT.exec(path))) { kind = 'project_chat'; scopeId = hit[1]; chatgptConversationId = hit[2].toLowerCase(); }
  else if ((hit = RE_PROJECT.exec(path))) { kind = 'project'; scopeId = hit[1]; warnings.push('This is a project page, not one conversation. Handoffs will open the project page.'); }
  else if ((hit = RE_GPT_CHAT.exec(path))) { kind = 'gpt_chat'; scopeId = hit[1]; chatgptConversationId = hit[2].toLowerCase(); }
  else warnings.push('This address does not look like a specific conversation. Open the conversation in ChatGPT and copy its address from there.');
  if (legacyHost) warnings.push('chat.openai.com redirects to chatgpt.com, so the address was updated.');
  const url = `https://chatgpt.com${kind === 'chat' ? `/c/${chatgptConversationId}`
    : kind === 'project_chat' ? `/g/${scopeId}/c/${chatgptConversationId}`
      : kind === 'gpt_chat' ? `/g/${scopeId}/c/${chatgptConversationId}`
        : path === '/' ? '' : path}`;
  return { ok: true, info: { url: url === 'https://chatgpt.com' ? 'https://chatgpt.com/' : url, originalUrl, kind, chatgptConversationId, scopeId, host: 'chatgpt.com', legacyHost, warnings } };
}

/** True when the URL names one specific conversation (as opposed to a project page or the landing page). */
export const isSpecificConversation = (info: Pick<ChatGptUrlInfo, 'chatgptConversationId'>): boolean => info.chatgptConversationId !== null;

/** Two stored URLs name the same page if they normalize to the same address. */
export function sameChatGptPage(a: string, b: string): boolean {
  const x = parseChatGptUrl(a); const y = parseChatGptUrl(b);
  return x.ok && y.ok && x.info.url === y.info.url;
}

// ---------------------------------------------------------------------------------------------------------------
// Linking an existing ChatGPT Project. OpenAI offers no way to list a person's ChatGPT Projects and does not document the form of
// their addresses, so a project is linked by an address that the person copies from their own signed-in ChatGPT. The form used today
// (https://chatgpt.com/g/g-p-<id>-<words>/project, and /c/<uuid> after it for a conversation inside the project) is only observed.
// It is recognised to give the link a title and to turn a pasted conversation into the project's page, never relied on: an address
// of another form on chatgpt.com is accepted as pasted and opened as it is, so a change on OpenAI's side cannot make linking fail.

export interface ChatGptProjectLinkInfo {
  /** The project page (https://chatgpt.com/g/<scopeId>/project) for a recognised address; otherwise the address as pasted, without query or fragment. */
  url: string;
  /** The `g-p-...` segment, or null when the address is of a form that is not recognised. */
  scopeId: string | null;
  title: string;
  /** The person pasted a conversation inside the project; the project page was derived from it. */
  derivedFromConversation: boolean;
}

export type ChatGptProjectLinkResult = { ok: true; link: ChatGptProjectLinkInfo } | { ok: false; message: string };

/** The page of a ChatGPT Project, from its `g-p-...` segment. */
export const chatGptProjectUrl = (scopeId: string): string => `https://chatgpt.com/g/${scopeId}/project`;

/**
 * Words from the end of a project's address segment (`g-p-<id>-<words>`), capitalised, or null when the address carries none.
 * "g-p-0123456789abcdef0123456789abcdef-caissa-trainer" gives "Caissa trainer".
 */
export function titleFromProjectScope(scopeId: string): string | null {
  const rest = scopeId.replace(/^g-p-/i, '');
  const words = rest.split('-').slice(1).filter(Boolean).join(' ').trim();
  return words === '' ? null : words.charAt(0).toUpperCase() + words.slice(1);
}

export function parseChatGptProjectLink(input: string): ChatGptProjectLinkResult {
  const r = parseChatGptUrl(input);
  if (!r.ok) {
    const message = r.reason === 'empty' ? 'Paste the address of the ChatGPT Project.'
      : r.reason === 'host_not_allowed' ? 'Only chatgpt.com addresses are accepted.'
        : r.message;
    return { ok: false, message };
  }
  const { info } = r;
  if ((info.kind === 'project' || info.kind === 'project_chat') && info.scopeId) {
    return {
      ok: true,
      link: { url: chatGptProjectUrl(info.scopeId), scopeId: info.scopeId, title: titleFromProjectScope(info.scopeId) ?? 'ChatGPT Project', derivedFromConversation: info.kind === 'project_chat' },
    };
  }
  if (info.kind === 'gpt_chat') return { ok: false, message: 'That is a conversation with a custom GPT, not a ChatGPT Project.' };
  if (info.kind === 'chat') return { ok: false, message: 'That is a single conversation outside any project. Open the project in ChatGPT and copy the address of its project page.' };
  const path = new URL(info.url).pathname;
  if (path === '/') return { ok: false, message: 'That is the ChatGPT home page. Open the project in ChatGPT and copy its address.' };
  // A share link is a snapshot of one chat or an invitation to join something: not a project address, and not something to keep.
  if (/^\/(share|s)(\/|$)/i.test(path)) return { ok: false, message: 'That is a share link. Open the project in ChatGPT and copy the address of the project itself.' };
  return { ok: true, link: { url: info.url, scopeId: null, title: 'ChatGPT Project', derivedFromConversation: false } };
}

export function suggestConversationTitle(info: Pick<ChatGptUrlInfo, 'kind' | 'chatgptConversationId'>): string {
  const id = info.chatgptConversationId ? info.chatgptConversationId.slice(0, 8) : '';
  if (info.kind === 'project') return 'ChatGPT project';
  if (info.kind === 'other') return 'ChatGPT';
  return `ChatGPT conversation ${id}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Navigation policy for the embedded ChatGPT view. The view is an isolated browser tab, not a general browser.

export type NavigationClass = 'chatgpt' | 'auth' | 'external' | 'blocked';

const CHATGPT_HOST = /(^|\.)(chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com)$/;
// Identity providers ChatGPT offers for sign-in. Google often refuses embedded browsers; that is reported, not bypassed.
const AUTH_HOSTS = [
  /(^|\.)accounts\.google\.com$/, /(^|\.)login\.microsoftonline\.com$/, /(^|\.)login\.live.com$/,
  /(^|\.)appleid\.apple\.com$/, /(^|\.)challenges\.cloudflare\.com$/,
];

export function classifyNavigation(url: string): NavigationClass {
  // Browsers treat a backslash as a slash and drop tabs and newlines, so `https://evil.example\@chatgpt.com/` has the host
  // evil.example while a plain string split sees chatgpt.com. Anything that could be read two ways is refused outright.
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(url.trim())) return 'blocked';
  const m = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?/i.exec(url.trim());
  if (!m) return 'blocked';
  const scheme = m[1].toLowerCase();
  if (scheme === 'about' && url.trim().toLowerCase() === 'about:blank') return 'chatgpt';
  if (scheme !== 'https') return 'blocked';
  const host = (m[2] ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^.*@/, '');
  if (!host) return 'blocked';
  if (CHATGPT_HOST.test(host)) return 'chatgpt';
  if (AUTH_HOSTS.some((re) => re.test(host))) return 'auth';
  return 'external';
}
