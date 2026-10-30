// Claude Code on the web (https://claude.ai/code), as Mini-Summa reaches it. Pure string logic: it runs in Node, the browser and React Native.
//
// What Anthropic documents (https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions, checked 2026-10-30) and nothing more:
//   * https://claude.ai/code opens Claude Code on the web. The address accepts query parameters that PREFILL a new session:
//     `prompt` (alias `q`), `prompt_url`, `repositories` (alias `repo`, a comma separated list of owner/repo) and `environment`.
//     The person still presses Enter on the page: nothing is submitted by opening the address.
//   * A session has an address on claude.ai/code whose last segment is the session id, `session_` followed by letters and digits (the form the CLI prints
//     after `claude --cloud`).
//   * There is no documented API to list a person's cloud sessions or to watch one finish, and no documented event stream. Mini-Summa
//     therefore only SHOWS the web page; it cannot see or control the session behind it.
// The form of a session address is read from what the CLI prints in the documentation, and is tolerated rather than relied on.
import { githubRepoUrl, normalizeGithubRepo } from './github.ts';

export const CLAUDE_CODE_URL = 'https://claude.ai/code';

/** The page that starts a new cloud session, with the repository preselected (and a prompt prefilled, never submitted). */
export function claudeCodeUrl(opts: { repo?: string | null; prompt?: string | null } = {}): string {
  const params: string[] = [];
  const repo = opts.repo ? normalizeGithubRepo(opts.repo) : null;
  // The documented example keeps the slash of owner/repo as it is; everything else is encoded.
  if (repo?.ok && repo.value) params.push(`repositories=${encodeURIComponent(repo.value).replace(/%2F/gi, '/')}`);
  const prompt = (opts.prompt ?? '').trim();
  if (prompt) params.push(`prompt=${encodeURIComponent(prompt)}`);
  return params.length > 0 ? `${CLAUDE_CODE_URL}?${params.join('&')}` : CLAUDE_CODE_URL;
}

export type ClaudeCodeUrlKind = 'home' | 'new' | 'session' | 'other';

export interface ClaudeCodeUrlInfo {
  /** https, host claude.ai, without query or fragment. */
  url: string;
  kind: ClaudeCodeUrlKind;
  /** `session_...` (or `cse_...`) when the address names a session. */
  sessionId: string | null;
}

export type ClaudeCodeUrlResult = { ok: true; info: ClaudeCodeUrlInfo } | { ok: false; message: string };

const SESSION_SEGMENT = /^(session_[A-Za-z0-9]+|cse_[A-Za-z0-9]+)$/;

/** Reads an address on claude.ai/code. Anything on claude.ai under /code is accepted; the kind says what it looks like. */
export function parseClaudeCodeUrl(input: string): ClaudeCodeUrlResult {
  const raw = (input ?? '').trim();
  if (raw === '') return { ok: false, message: 'Paste an address from Claude Code on the web.' };
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, message: 'That does not look like a web address.' }; }
  if (u.protocol !== 'https:') return { ok: false, message: 'Only https addresses are accepted.' };
  if (u.username || u.password || u.port) return { ok: false, message: 'Only claude.ai addresses are accepted.' };
  if (u.hostname.toLowerCase() !== 'claude.ai' && u.hostname.toLowerCase() !== 'www.claude.ai') return { ok: false, message: 'Only claude.ai addresses are accepted.' };
  const path = u.pathname.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'code') return { ok: false, message: 'That is not a page of Claude Code on the web (claude.ai/code).' };
  let kind: ClaudeCodeUrlKind = 'other';
  let sessionId: string | null = null;
  if (parts.length === 1) kind = 'home';
  else if (parts.length === 2 && parts[1] === 'new') kind = 'new';
  else if (parts.length === 2 && SESSION_SEGMENT.test(parts[1])) { kind = 'session'; sessionId = parts[1]; }
  return { ok: true, info: { url: `https://claude.ai${path}`, kind, sessionId } };
}

/** The command that continues a cloud session in a local terminal, from a checkout of the same repository (documented: `claude --teleport <id>`). */
export const teleportCommand = (sessionId: string): string => `claude --teleport ${sessionId}`;

/** Where a cloud session's repository is on GitHub (for the "open on GitHub" action beside it). */
export const cloudRepoPage = (repo: string): string => githubRepoUrl(repo);

// ---------------------------------------------------------------------------------------------------------------
// Navigation policy of the embedded Claude view. An isolated browser tab for Claude, not a general browser.

export type ClaudeNavigationClass = 'claude' | 'auth' | 'external' | 'blocked';

const CLAUDE_HOST = /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i;
// Sign-in providers and the places a person connects GitHub. Google refuses embedded browsers: that is reported, not worked around.
const CLAUDE_AUTH_HOSTS = [
  /(^|\.)accounts\.google\.com$/i, /(^|\.)login\.microsoftonline\.com$/i, /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)challenges\.cloudflare\.com$/i, /^github\.com$/i,
];

export function classifyClaudeNavigation(url: string): ClaudeNavigationClass {
  // The same refusal as for ChatGPT: an address that could be read two ways is refused outright.
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(url.trim())) return 'blocked';
  const m = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?/i.exec(url.trim());
  if (!m) return 'blocked';
  const scheme = m[1].toLowerCase();
  if (scheme === 'about' && url.trim().toLowerCase() === 'about:blank') return 'claude';
  if (scheme !== 'https') return 'blocked';
  const host = (m[2] ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^.*@/, '');
  if (!host) return 'blocked';
  if (CLAUDE_HOST.test(host)) return 'claude';
  if (CLAUDE_AUTH_HOSTS.some((re) => re.test(host))) return 'auth';
  return 'external';
}
