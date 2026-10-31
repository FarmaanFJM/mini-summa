import { describe, expect, it } from 'vitest';
import { checkUiPatch, classifyClaudeNavigation, claudeCodeUrl, mergeUi, parseClaudeCodeUrl, teleportCommand } from '../src/index.ts';

// The address of one page of Claude Code on the web, built from its last segment (made-up ids only).
const page = (segment: string, tail = ''): string => `https://claude.ai/code/${segment}${tail}`;

describe('the page that starts a cloud session', () => {
  it('prefills the repository the way Anthropic documents it, and nothing else unless a prompt is given', () => {
    expect(claudeCodeUrl({ repo: 'acme/webapp' })).toBe('https://claude.ai/code?repositories=acme/webapp');
    expect(claudeCodeUrl()).toBe('https://claude.ai/code');
    expect(claudeCodeUrl({ repo: null })).toBe('https://claude.ai/code');
  });

  it('normalises a pasted repository and ignores one that is not a repository', () => {
    expect(claudeCodeUrl({ repo: 'https://github.com/acme/webapp.git' })).toBe('https://claude.ai/code?repositories=acme/webapp');
    expect(claudeCodeUrl({ repo: 'not a repo' })).toBe('https://claude.ai/code');
  });

  it('encodes a prompt and places it after the repository; an empty prompt is left out', () => {
    expect(claudeCodeUrl({ repo: 'acme/webapp', prompt: 'Fix the login bug & add a test' })).toBe('https://claude.ai/code?repositories=acme/webapp&prompt=Fix%20the%20login%20bug%20%26%20add%20a%20test');
    expect(claudeCodeUrl({ repo: 'acme/webapp', prompt: '   ' })).toBe('https://claude.ai/code?repositories=acme/webapp');
  });

  it('keeps a name that needs encoding encoded', () => {
    expect(claudeCodeUrl({ repo: 'acme/web.app-2' })).toBe('https://claude.ai/code?repositories=acme/web.app-2');
  });
});

describe('reading an address on claude.ai/code', () => {
  it('tells the home page, the new session page and a session apart, without query or fragment', () => {
    expect(parseClaudeCodeUrl('https://claude.ai/code')).toEqual({ ok: true, info: { url: 'https://claude.ai/code', kind: 'home', sessionId: null } });
    expect(parseClaudeCodeUrl('claude.ai/code/new?x=1')).toEqual({ ok: true, info: { url: 'https://claude.ai/code/new', kind: 'new', sessionId: null } });
    expect(parseClaudeCodeUrl(page('session_abc123', '?from=cli&m=0#x'))).toEqual({
      ok: true, info: { url: page('session_abc123'), kind: 'session', sessionId: 'session_abc123' },
    });
    expect(parseClaudeCodeUrl(page('something-else'))).toMatchObject({ ok: true, info: { kind: 'other', sessionId: null } });
  });

  it('refuses other sites, other schemes, credentials and other parts of claude.ai', () => {
    expect(parseClaudeCodeUrl('https://example.com/code')).toMatchObject({ ok: false, message: 'Only claude.ai addresses are accepted.' });
    expect(parseClaudeCodeUrl('http://claude.ai/code')).toMatchObject({ ok: false, message: 'Only https addresses are accepted.' });
    expect(parseClaudeCodeUrl('https://user:pw@claude.ai/code')).toMatchObject({ ok: false });
    expect(parseClaudeCodeUrl('https://claude.ai/chat/abc')).toMatchObject({ ok: false, message: expect.stringMatching(/not a page of Claude Code on the web/) });
    expect(parseClaudeCodeUrl('')).toMatchObject({ ok: false });
    expect(parseClaudeCodeUrl('javascript:alert(1)')).toMatchObject({ ok: false });
  });

  it('gives the documented command that continues a session in a terminal', () => {
    expect(teleportCommand('session_abc123')).toBe('claude --teleport session_abc123');
  });
});

describe('where the embedded Claude view may go', () => {
  it('stays on Claude, lets the sign-in providers and GitHub through, and sends everything else to the browser', () => {
    expect(classifyClaudeNavigation('https://claude.ai/code?repositories=a/b')).toBe('claude');
    expect(classifyClaudeNavigation('https://api.claude.ai/x')).toBe('claude');
    expect(classifyClaudeNavigation('https://accounts.google.com/o/oauth2/auth')).toBe('auth');
    expect(classifyClaudeNavigation('https://github.com/login/oauth/authorize')).toBe('auth');
    expect(classifyClaudeNavigation('https://example.com/')).toBe('external');
    expect(classifyClaudeNavigation('https://evil-claude.ai.example.com/')).toBe('external');
  });

  it('lets GitHub in only for signing in, authorising Claude and installing its GitHub App; every other GitHub page goes to the browser', () => {
    for (const path of ['/login', '/login/oauth/authorize?client_id=x', '/sessions/two-factor', '/session', '/apps/claude/installations/new', '/settings/installations/123', '/organizations/acme/settings/installations/9']) {
      expect(classifyClaudeNavigation(`https://github.com${path}`), path).toBe('auth');
    }
    for (const path of ['/', '/acme/webapp', '/acme/webapp/pull/12', '/acme/webapp/commit/abc123', '/acme/login', '/loginx', '/apps/other-app', '/settings/profile']) {
      expect(classifyClaudeNavigation(`https://github.com${path}`), path).toBe('external');
    }
    expect(classifyClaudeNavigation('https://gist.github.com/login')).toBe('external');
    expect(classifyClaudeNavigation('https://github.com.evil.example/login')).toBe('external');
  });

  it('refuses anything that could be read two ways, other schemes and nothing', () => {
    expect(classifyClaudeNavigation('https://evil.example\\@claude.ai/')).toBe('blocked');
    expect(classifyClaudeNavigation('http://claude.ai/')).toBe('blocked');
    expect(classifyClaudeNavigation('javascript:alert(1)')).toBe('blocked');
    expect(classifyClaudeNavigation('file:///etc/passwd')).toBe('blocked');
    expect(classifyClaudeNavigation('about:blank')).toBe('claude');
    expect(classifyClaudeNavigation('')).toBe('blocked');
  });
});

describe('the window remembers the Claude page of each project', () => {
  const key = 'prj_1';
  it('accepts an address on claude.ai/code, stores it without its query, and forgets it on null', () => {
    const checked = checkUiPatch({ perProject: { [key]: { cloudUrl: page('session_abc123', '?from=cli') } } });
    expect(checked.problems).toEqual([]);
    const stored = mergeUi(undefined, checked.patch);
    expect(stored.perProject?.[key]).toEqual({ cloudUrl: page('session_abc123') });
    const kept = mergeUi(stored, checkUiPatch({ perProject: { [key]: { conversationId: 'cnv_1' } } }).patch);
    expect(kept.perProject?.[key]).toEqual({ cloudUrl: page('session_abc123'), conversationId: 'cnv_1' });
    const gone = mergeUi(kept, checkUiPatch({ perProject: { [key]: { cloudUrl: null } } }).patch);
    expect(gone.perProject?.[key]).toEqual({ conversationId: 'cnv_1' });
  });

  it('refuses an address that is not on claude.ai/code, so nothing else is ever opened from the memory', () => {
    const r = checkUiPatch({ perProject: { [key]: { cloudUrl: 'https://example.com/code/session_abc123' } } });
    expect(r.problems.map((p) => p.field)).toEqual([`ui.perProject.${key}.cloudUrl`]);
    expect(checkUiPatch({ perProject: { [key]: { cloudUrl: 'x'.repeat(700) } } }).problems).toHaveLength(1);
    expect(checkUiPatch({ perProject: { [key]: { cloudUrl: 5 } } }).problems).toHaveLength(1);
  });
});
