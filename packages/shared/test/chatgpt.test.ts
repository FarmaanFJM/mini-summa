import { describe, expect, it } from 'vitest';
import { classifyNavigation, parseChatGptUrl, sameChatGptPage } from '../src/index.ts';

const ID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('parseChatGptUrl', () => {
  it('normalizes a plain conversation', () => {
    const r = parseChatGptUrl(`https://chatgpt.com/c/${ID.toUpperCase()}?model=gpt-5#frag`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.url).toBe(`https://chatgpt.com/c/${ID}`);
      expect(r.info.kind).toBe('chat');
      expect(r.info.chatgptConversationId).toBe(ID);
      expect(r.info.warnings).toEqual([]);
    }
  });

  it('accepts the legacy host and says it was updated', () => {
    const r = parseChatGptUrl(`https://chat.openai.com/c/${ID}`);
    expect(r.ok && r.info.url).toBe(`https://chatgpt.com/c/${ID}`);
    expect(r.ok && r.info.legacyHost).toBe(true);
    expect(r.ok && r.info.warnings.join(' ')).toMatch(/redirects/);
  });

  it('accepts an address pasted without a scheme', () => {
    const r = parseChatGptUrl(`chatgpt.com/c/${ID}/`);
    expect(r.ok && r.info.url).toBe(`https://chatgpt.com/c/${ID}`);
  });

  it('recognizes project chats, project pages and custom GPT chats', () => {
    const pc = parseChatGptUrl(`https://chatgpt.com/g/g-p-abc123-my-project/c/${ID}`);
    expect(pc.ok && pc.info.kind).toBe('project_chat');
    expect(pc.ok && pc.info.scopeId).toBe('g-p-abc123-my-project');
    const pp = parseChatGptUrl('https://chatgpt.com/g/g-p-abc123-my-project/project');
    expect(pp.ok && pp.info.kind).toBe('project');
    expect(pp.ok && pp.info.chatgptConversationId).toBeNull();
    expect(pp.ok && pp.info.warnings.length).toBe(1);
    const g = parseChatGptUrl(`https://chatgpt.com/g/g-Xyz789-helper/c/${ID}`);
    expect(g.ok && g.info.kind).toBe('gpt_chat');
  });

  it('warns about non-conversation pages instead of pretending', () => {
    const r = parseChatGptUrl('https://chatgpt.com/');
    expect(r.ok && r.info.kind).toBe('other');
    expect(r.ok && r.info.chatgptConversationId).toBeNull();
    expect(r.ok && r.info.warnings[0]).toMatch(/specific conversation/);
  });

  it.each([
    ['', 'empty'],
    ['http://chatgpt.com/c/' + ID, 'not_https'],
    ['https://evil.example/c/' + ID, 'host_not_allowed'],
    ['https://chatgpt.com.evil.example/c/' + ID, 'host_not_allowed'],
    ['https://user:pw@chatgpt.com/c/' + ID, 'host_not_allowed'],
    ['https://chatgpt.com:8443/c/' + ID, 'host_not_allowed'],
    ['javascript:alert(1)', 'not_https'],
    ['file:///etc/passwd', 'not_https'],
  ])('rejects %s', (input, reason) => {
    const r = parseChatGptUrl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('compares pages by normalized address', () => {
    expect(sameChatGptPage(`https://chatgpt.com/c/${ID}?x=1`, `https://chat.openai.com/c/${ID}`)).toBe(true);
    expect(sameChatGptPage(`https://chatgpt.com/c/${ID}`, 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('classifyNavigation', () => {
  it.each([
    ['https://chatgpt.com/c/x', 'chatgpt'],
    ['https://auth.openai.com/log-in', 'chatgpt'],
    ['https://cdn.oaistatic.com/x.js', 'chatgpt'],
    ['https://accounts.google.com/o/oauth2/v2/auth', 'auth'],
    ['https://login.microsoftonline.com/common', 'auth'],
    ['https://example.com/', 'external'],
    ['http://chatgpt.com/', 'blocked'],
    ['file:///C:/x', 'blocked'],
    ['javascript:alert(1)', 'blocked'],
    ['minisumma://pair', 'blocked'],
    ['about:blank', 'chatgpt'],
    ['https://chatgpt.com.evil.example/', 'external'],
    ['https://evilchatgpt.com/', 'external'],
  ])('%s is %s', (url, cls) => {
    expect(classifyNavigation(url)).toBe(cls);
  });
});
