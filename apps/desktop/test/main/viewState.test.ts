// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyFailure, deriveClaudeViewState, deriveViewState, EMPTY_CLAUDE_VIEW_STATE, looksLikeChallenge, looksLikeClaudeLogin, looksLikeGoogleRefusal, looksLikeLogin } from '../../src/main/viewState.ts';
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
    { name: 'a retry in progress is loading even after a failure', o: { loading: true, failure: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } }, status: 'loading', note: null },
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

// ---------------------------------------------------------------------------------------------------------------
// Claude Code on the web

// The address of one page of Claude Code on the web, built from its last segment (made-up id: nothing in this repository may look like a real session address).
const claudePage = (segment: string): string => `https://claude.ai/code/${segment}`;

describe('deriveClaudeViewState: status table', () => {
  const claudeObs = (over: Partial<ViewObservation> = {}): ViewObservation => ({ url: 'https://claude.ai/code?repositories=acme/webapp', title: 'Claude Code', loading: false, failure: null, ...over });
  const rows: { name: string; o: Partial<ViewObservation>; status: string; note: RegExp | null }[] = [
    { name: 'nothing loaded', o: { url: null, title: null }, status: 'idle', note: null },
    { name: 'blank page', o: { url: 'about:blank', title: '' }, status: 'idle', note: null },
    { name: 'loading wins over the old address', o: { loading: true }, status: 'loading', note: null },
    { name: 'the new session page', o: {}, status: 'ready', note: null },
    { name: 'a session page', o: { url: claudePage('session_abc123'), title: 'Fix the login bug' }, status: 'ready', note: null },
    { name: 'another page of the site', o: { url: 'https://claude.ai/settings', title: 'Settings' }, status: 'ready', note: null },
    { name: 'the sign-in page', o: { url: 'https://claude.ai/login', title: 'Claude' }, status: 'login_required', note: /sign-in page.*guess/s },
    { name: 'the sign-in page with a return address', o: { url: 'https://claude.ai/login?returnTo=%2Fcode%3Frepositories%3Dacme%2Fwebapp', title: 'x' }, status: 'login_required', note: /guess from the address/ },
    { name: 'a step of the sign-in page', o: { url: 'https://claude.ai/login/verify?token=1', title: 'x' }, status: 'login_required', note: null },
    { name: 'the sign-in page on the www host', o: { url: 'https://www.claude.ai/login', title: 'x' }, status: 'login_required', note: null },
    { name: 'a provider page while signing in is still just a page', o: { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', title: 'Sign in' }, status: 'ready', note: null },
    { name: 'GitHub authorisation is just a page', o: { url: 'https://github.com/login/oauth/authorize?client_id=x', title: 'Authorize' }, status: 'ready', note: null },
    { name: 'google refusal', o: { url: 'https://accounts.google.com/v3/signin/rejected?x=1', title: 'Sign in' }, status: 'blocked', note: /Google refused.*does not work around it/s },
    { name: 'google refusal by the user agent error', o: { url: 'https://accounts.google.com/x?error=disallowed_useragent', title: 'Error' }, status: 'blocked', note: /Google refused/ },
    { name: 'failed load: network', o: { failure: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } }, status: 'error', note: /ERR_NAME_NOT_RESOLVED/ },
    { name: 'failed load: certificate', o: { failure: { code: -200, description: 'ERR_CERT_COMMON_NAME_INVALID' } }, status: 'error', note: /ERR_CERT_COMMON_NAME_INVALID/ },
    { name: 'failed load: blocked by response', o: { failure: { code: -27, description: 'ERR_BLOCKED_BY_RESPONSE' } }, status: 'blocked', note: /Some sites refuse embedded browsers/ },
    { name: 'failed load: blocked by client', o: { failure: { code: -20, description: 'ERR_BLOCKED_BY_CLIENT' } }, status: 'blocked', note: null },
    { name: 'failure beats a stale address', o: { failure: { code: -2, description: 'ERR_FAILED' } }, status: 'error', note: null },
    { name: 'failure on the sign-in page is still a failure', o: { url: 'https://claude.ai/login', failure: { code: -2, description: 'ERR_FAILED' } }, status: 'error', note: null },
    { name: 'aborted load says nothing about the page', o: { failure: { code: -3, description: 'ERR_ABORTED' } }, status: 'ready', note: null },
    { name: 'loading beats aborted', o: { loading: true, failure: { code: -3, description: 'ERR_ABORTED' } }, status: 'loading', note: null },
    { name: 'a retry in progress is loading even after a failure', o: { loading: true, failure: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } }, status: 'loading', note: null },
  ];
  it.each(rows)('$name -> $status', ({ o, status, note }) => {
    const state = deriveClaudeViewState(claudeObs(o), nav);
    expect(state.status).toBe(status);
    expect(state).not.toHaveProperty('mode');
    expect(Object.keys(state).sort()).toEqual(['canGoBack', 'canGoForward', 'note', 'status', 'title', 'url']);
    if (note) expect(state.note ?? '').toMatch(note);
    if (status === 'ready' || status === 'idle' || status === 'loading') expect(state.note).toBeNull();
    if (status === 'login_required' || status === 'blocked' || status === 'error') expect(state.note).not.toBeNull();
  });

  it('carries the address, title and history flags through', () => {
    const state = deriveClaudeViewState(claudeObs(), { canGoBack: true, canGoForward: false });
    expect(state).toEqual({ status: 'ready', url: 'https://claude.ai/code?repositories=acme/webapp', title: 'Claude Code', canGoBack: true, canGoForward: false, note: null });
  });

  it('starts from an idle state that has nothing in it', () => {
    expect(EMPTY_CLAUDE_VIEW_STATE).toEqual({ status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null });
    expect(Object.isFrozen(EMPTY_CLAUDE_VIEW_STATE)).toBe(true);
    expect(deriveClaudeViewState({ url: null, title: null, loading: false, failure: null }, nav)).toEqual(EMPTY_CLAUDE_VIEW_STATE);
  });

  it('never has a challenge status: a security check on the page is just a page the person completes', () => {
    const state = deriveClaudeViewState(claudeObs({ title: 'Just a moment...' }), nav);
    expect(state.status).toBe('ready');
  });

  it('gives the reason only: what to do about it is the Cloud tab\'s to say, so no note carries advice that would appear twice', () => {
    const notes = rows.map((r) => deriveClaudeViewState(claudeObs(r.o), nav).note ?? '').filter((n) => n !== '');
    expect(notes.length).toBeGreaterThan(8);
    for (const n of notes) expect(n).not.toMatch(/Open in your browser|reload|Check your connection|Sign in here|Sign in with/i);
    for (const n of notes) expect(n).toMatch(/[.]$/); // whole sentences, so the tab can put its own after them
  });

  it('never writes an em dash in a user-visible note', () => {
    const emDash = String.fromCharCode(0x2014); // built from its code so this file holds no dash itself
    const notes = rows.map((r) => deriveClaudeViewState(claudeObs(r.o), nav).note ?? '');
    expect(notes.filter((n) => n !== '').length).toBeGreaterThan(8);
    for (const n of notes) expect(n).not.toContain(emDash);
  });
});

describe('the Claude sign-in heuristic', () => {
  it('is the sign-in path of claude.ai and the sites that belong to it, and nothing else', () => {
    expect(looksLikeClaudeLogin('https://claude.ai/login')).toBe(true);
    expect(looksLikeClaudeLogin('https://claude.ai/login?returnTo=%2Fcode')).toBe(true);
    expect(looksLikeClaudeLogin('https://claude.ai/Login')).toBe(true);
    expect(looksLikeClaudeLogin('https://claude.ai/login/sso')).toBe(true);
    expect(looksLikeClaudeLogin('https://console.anthropic.com/login')).toBe(true);
    expect(looksLikeClaudeLogin('https://claude.com/login')).toBe(true);
    expect(looksLikeClaudeLogin('https://claude.ai/code')).toBe(false);
    expect(looksLikeClaudeLogin(claudePage('session_abc123'))).toBe(false);
    expect(looksLikeClaudeLogin('https://claude.ai/logout')).toBe(false);
    expect(looksLikeClaudeLogin('https://claude.ai/')).toBe(false);
    expect(looksLikeClaudeLogin('https://example.org/login')).toBe(false);
    expect(looksLikeClaudeLogin('https://claude.ai.example.org/login')).toBe(false);
    expect(looksLikeClaudeLogin('http://claude.ai/login')).toBe(false);
    expect(looksLikeClaudeLogin('https://chatgpt.com/auth/login')).toBe(false);
    expect(looksLikeClaudeLogin(null)).toBe(false);
    expect(looksLikeClaudeLogin('not a url')).toBe(false);
  });

  it('looks at the address only: a title that says "sign in" changes nothing', () => {
    const state = deriveClaudeViewState({ url: 'https://claude.ai/code', title: 'Sign in to Claude', loading: false, failure: null }, nav);
    expect(state.status).toBe('ready');
  });
});
