// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyFailure, deriveViewState, looksLikeChallenge, looksLikeGoogleRefusal, looksLikeLogin } from '../../src/main/viewState.ts';
import type { ViewObservation } from '../../src/main/viewState.ts';

const nav = { canGoBack: false, canGoForward: false };
const obs = (over: Partial<ViewObservation> = {}): ViewObservation => ({ url: 'https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', title: 'Release notes', loading: false, failure: null, ...over });

describe('deriveViewState: status table', () => {
  const rows: { name: string; o: Partial<ViewObservation>; status: string; note: RegExp | null }[] = [
    { name: 'nothing loaded', o: { url: null, title: null }, status: 'idle', note: null },
    { name: 'blank page', o: { url: 'about:blank', title: '' }, status: 'idle', note: null },
    { name: 'loading wins over the old address', o: { loading: true }, status: 'loading', note: null },
    { name: 'a conversation', o: {}, status: 'ready', note: null },
    { name: 'the home page', o: { url: 'https://chatgpt.com/', title: 'ChatGPT' }, status: 'ready', note: null },
    { name: 'auth host', o: { url: 'https://auth.openai.com/log-in', title: 'Log in' }, status: 'login_required', note: /sign-in page.*guess/s },
    { name: 'auth path on the site', o: { url: 'https://chatgpt.com/auth/login', title: 'ChatGPT' }, status: 'login_required', note: /Google sign-in is often refused/ },
    { name: 'log-in path', o: { url: 'https://chatgpt.com/log-in/password', title: 'x' }, status: 'login_required', note: /external browser mode/ },
    { name: 'identity provider page', o: { url: 'https://login.microsoftonline.com/common/oauth2/authorize', title: 'Sign in' }, status: 'login_required', note: null },
    { name: 'challenge by title', o: { title: 'Just a moment...' }, status: 'challenge', note: /security check.*does not solve or skip/s },
    { name: 'challenge by title, other wording', o: { title: 'Attention Required! | Cloudflare' }, status: 'challenge', note: null },
    { name: 'challenge by path', o: { url: 'https://chatgpt.com/cdn-cgi/challenge-platform/h/b/orchestrate', title: '' }, status: 'challenge', note: null },
    { name: 'challenge by query', o: { url: 'https://chatgpt.com/?__cf_chl_rt_tk=abc', title: 'x' }, status: 'challenge', note: null },
    { name: 'challenge beats login when both look true', o: { url: 'https://auth.openai.com/log-in', title: 'Just a moment...' }, status: 'challenge', note: null },
    { name: 'google refusal', o: { url: 'https://accounts.google.com/v3/signin/rejected?x=1', title: 'Sign in' }, status: 'blocked', note: /Google refused/ },
    { name: 'google sign-in itself is a login', o: { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', title: 'Sign in' }, status: 'login_required', note: null },
    { name: 'failed load: network', o: { failure: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } }, status: 'error', note: /ERR_NAME_NOT_RESOLVED.*reload/s },
    { name: 'failed load: blocked by response', o: { failure: { code: -27, description: 'ERR_BLOCKED_BY_RESPONSE' } }, status: 'blocked', note: /Some sites refuse embedded browsers/ },
    { name: 'failed load: blocked by client', o: { failure: { code: -20, description: 'ERR_BLOCKED_BY_CLIENT' } }, status: 'blocked', note: null },
    { name: 'failure beats a stale address', o: { failure: { code: -2, description: 'ERR_FAILED' } }, status: 'error', note: null },
    { name: 'aborted load says nothing about the page', o: { failure: { code: -3, description: 'ERR_ABORTED' } }, status: 'ready', note: null },
    { name: 'loading beats aborted', o: { loading: true, failure: { code: -3, description: 'ERR_ABORTED' } }, status: 'loading', note: null },
  ];
  it.each(rows)('$name -> $status', ({ o, status, note }) => {
    const state = deriveViewState(obs(o), nav);
    expect(state.status).toBe(status);
    expect(state.mode).toBe('embedded');
    if (note) expect(state.note ?? '').toMatch(note);
    if (status === 'ready' || status === 'idle' || status === 'loading') expect(state.note).toBeNull();
  });

  it('carries the address, title and history flags through', () => {
    const state = deriveViewState(obs(), { canGoBack: true, canGoForward: false });
    expect(state.url).toBe('https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    expect(state.title).toBe('Release notes');
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(false);
  });

  it('never writes an em dash in a user-visible note', () => {
    const notes = rows.map((r) => deriveViewState(obs(r.o), nav).note ?? '');
    for (const n of notes) expect(n).not.toMatch(/—/);
  });
});

describe('failure classification', () => {
  it('separates aborted, policy and network failures', () => {
    expect(classifyFailure(-3, 'ERR_ABORTED')).toBe('aborted');
    expect(classifyFailure(-27, 'ERR_BLOCKED_BY_RESPONSE')).toBe('blocked');
    expect(classifyFailure(-30, 'ERR_BLOCKED_BY_CSP')).toBe('blocked');
    expect(classifyFailure(-301, 'ERR_DISALLOWED_URL_SCHEME')).toBe('blocked');
    expect(classifyFailure(-312, 'ERR_UNSAFE_PORT')).toBe('blocked');
    expect(classifyFailure(-999, 'ERR_BLOCKED_BY_SOMETHING_NEW')).toBe('blocked');
    expect(classifyFailure(-105, 'ERR_NAME_NOT_RESOLVED')).toBe('error');
    expect(classifyFailure(-106, 'ERR_INTERNET_DISCONNECTED')).toBe('error');
    expect(classifyFailure(-200, 'ERR_CERT_COMMON_NAME_INVALID')).toBe('error');
  });
});

describe('address and title heuristics', () => {
  it('login', () => {
    expect(looksLikeLogin('https://auth.openai.com/authorize?x=1')).toBe(true);
    expect(looksLikeLogin('https://chatgpt.com/auth/login')).toBe(true);
    expect(looksLikeLogin('https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toBe(false);
    expect(looksLikeLogin('https://chatgpt.com/g/g-p-abc/project')).toBe(false);
    expect(looksLikeLogin(null)).toBe(false);
    expect(looksLikeLogin('not a url')).toBe(false);
  });
  it('challenge', () => {
    expect(looksLikeChallenge('https://chatgpt.com/', 'Just a moment...')).toBe(true);
    expect(looksLikeChallenge('https://chatgpt.com/', 'A moment of calm')).toBe(false);
    expect(looksLikeChallenge('https://challenges.cloudflare.com/cdn-cgi/x', null)).toBe(true);
    expect(looksLikeChallenge(null, null)).toBe(false);
  });
  it('google refusal needs a google address, not just a word', () => {
    expect(looksLikeGoogleRefusal('https://accounts.google.com/signin/oauth/error?authError=x')).toBe(true);
    expect(looksLikeGoogleRefusal('https://accounts.google.com/x?error=disallowed_useragent')).toBe(true);
    expect(looksLikeGoogleRefusal('https://example.org/signin/rejected')).toBe(false);
    expect(looksLikeGoogleRefusal('https://accounts.google.com/o/oauth2/auth')).toBe(false);
  });
});
