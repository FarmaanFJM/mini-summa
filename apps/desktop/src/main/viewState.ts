// What the ChatGPT view looks like from the outside, as a status the renderer can show.
//
// These are HEURISTICS. Mini-Summa never reads the page (no script injection, no DOM access), so the only evidence is
// the address, the page title, whether a load is running and why a load failed. Every note says so in plain words.
import type { ChatGptViewState, ChatGptViewStatus } from '@minisumma/shared';

export interface ViewObservation {
  url: string | null;
  title: string | null;
  loading: boolean;
  /** Set by did-fail-load for the main frame. It stays until a new page actually commits (did-navigate), because a cancelled or failed retry leaves the error page on screen. */
  failure: { code: number; description: string } | null;
}

export interface NavigationFlags { canGoBack: boolean; canGoForward: boolean }

export const EMPTY_VIEW_STATE: ChatGptViewState = Object.freeze({
  mode: 'embedded', status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null,
}) as ChatGptViewState;

const ERR_ABORTED = -3;
// Chromium net errors that mean "a policy refused this", as opposed to "the network failed".
const POLICY_ERROR_CODES = new Set([-20, -22, -27, -30, -301, -311, -312, -383]);

export type FailureKind = 'aborted' | 'blocked' | 'error';

export function classifyFailure(code: number, description: string): FailureKind {
  if (code === ERR_ABORTED || /ERR_ABORTED/i.test(description)) return 'aborted';
  if (POLICY_ERROR_CODES.has(code) || /BLOCKED_BY|DISALLOWED_URL_SCHEME|UNSAFE_(PORT|REDIRECT)/i.test(description)) return 'blocked';
  return 'error';
}

const parse = (url: string | null): URL | null => {
  if (!url) return null;
  try { return new URL(url); } catch { return null; }
};

const LOGIN_HOSTS = new Set(['auth.openai.com', 'auth0.openai.com']);
const IDENTITY_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com)$/;
const CHALLENGE_TITLE = /^\s*(just a moment|attention required|checking your browser|one more step|verify you are human)/i;

export function looksLikeChallenge(url: string | null, title: string | null): boolean {
  const u = parse(url);
  if (u && (/\/cdn-cgi\/challenge-platform/i.test(u.pathname) || /(^|[?&])__cf_chl/i.test(u.search) || u.hostname === 'challenges.cloudflare.com')) return true;
  return !!title && CHALLENGE_TITLE.test(title);
}

export function looksLikeLogin(url: string | null): boolean {
  const u = parse(url);
  if (!u) return false;
  const path = u.pathname.toLowerCase();
  return LOGIN_HOSTS.has(u.hostname.toLowerCase()) || path.includes('/auth/') || path.includes('/log-in') || IDENTITY_HOSTS.test(u.hostname.toLowerCase());
}

/** Google's pages that say an embedded browser is not allowed. A guess from the address; nothing is read from the page. */
export function looksLikeGoogleRefusal(url: string | null): boolean {
  const u = parse(url);
  if (!u || !/(^|\.)accounts\.google\.com$/i.test(u.hostname)) return false;
  return /\/signin\/(rejected|oauth\/error)|\/v3\/signin\/rejected/i.test(u.pathname) || /disallowed_useragent/i.test(u.search);
}

const SETTINGS_HINT = 'External browser mode is available in Settings.';

const NOTES = {
  login: `The address looks like a sign-in page (Mini-Summa cannot read the page, so this is a guess from the address). Sign in here. Google sign-in is often refused in embedded browsers; if it is, use external browser mode in Settings.`,
  challenge: `ChatGPT seems to be showing a security check (a guess from the address or title). Complete it in this pane; Mini-Summa does not solve or skip checks. If it keeps coming back, use external browser mode in Settings.`,
  googleRefused: `Google refused to sign in inside an embedded browser. That is Google's decision and Mini-Summa does not work around it. Use another sign-in method here, or switch to external browser mode in Settings.`,
  blocked: (description: string) => `The page was blocked (${description || 'refused by a policy'}). Some sites refuse embedded browsers. ${SETTINGS_HINT}`,
  error: (description: string) => `The page could not be loaded (${description || 'unknown error'}). Check your connection and use reload. ${SETTINGS_HINT}`,
} as const;

export function deriveViewState(obs: ViewObservation, nav: NavigationFlags): ChatGptViewState {
  const base = { mode: 'embedded' as const, url: obs.url, title: obs.title, canGoBack: nav.canGoBack, canGoForward: nav.canGoForward };
  const make = (status: ChatGptViewStatus, note: string | null): ChatGptViewState => ({ ...base, status, note });

  // A retry in progress is "loading" even if the last attempt failed.
  if (obs.loading) return make('loading', null);
  if (obs.failure) {
    const kind = classifyFailure(obs.failure.code, obs.failure.description);
    if (kind === 'blocked') return make('blocked', NOTES.blocked(obs.failure.description));
    if (kind === 'error') return make('error', NOTES.error(obs.failure.description));
    // aborted: the navigation was cancelled or replaced, which says nothing about the page itself
  }
  if (!obs.url || obs.url === 'about:blank') return make('idle', null);
  if (looksLikeGoogleRefusal(obs.url)) return make('blocked', NOTES.googleRefused);
  if (looksLikeChallenge(obs.url, obs.title)) return make('challenge', NOTES.challenge);
  if (looksLikeLogin(obs.url)) return make('login_required', NOTES.login);
  return make('ready', null);
}
