import { describe, expect, it } from 'vitest';
import { chatGptProjectUrl, githubRepoUrl, normalizeGithubRepo, parseChatGptProjectLink, titleFromProjectScope } from '../src/index.ts';

const SCOPE = 'g-p-0123456789abcdef0123456789abcdef-caissa-trainer';
const CHAT = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('linking an existing ChatGPT Project', () => {
  it('takes the project page and titles it from the words in the address', () => {
    const r = parseChatGptProjectLink(`https://chatgpt.com/g/${SCOPE}/project`);
    expect(r).toEqual({ ok: true, link: { url: `https://chatgpt.com/g/${SCOPE}/project`, scopeId: SCOPE, title: 'Caissa trainer', derivedFromConversation: false } });
  });

  it('turns a conversation inside the project into the project page', () => {
    const r = parseChatGptProjectLink(`https://chatgpt.com/g/${SCOPE}/c/${CHAT}?model=x#y`);
    expect(r).toMatchObject({ ok: true, link: { url: chatGptProjectUrl(SCOPE), scopeId: SCOPE, derivedFromConversation: true } });
  });

  it('works without a scheme, and with the legacy host', () => {
    expect(parseChatGptProjectLink(`chatgpt.com/g/${SCOPE}/project`)).toMatchObject({ ok: true, link: { scopeId: SCOPE } });
    expect(parseChatGptProjectLink(`https://chat.openai.com/g/${SCOPE}/project`)).toMatchObject({ ok: true, link: { url: chatGptProjectUrl(SCOPE) } });
  });

  it('uses a plain title when the address carries no words', () => {
    expect(titleFromProjectScope('g-p-0123456789abcdef0123456789abcdef')).toBeNull();
    const r = parseChatGptProjectLink('https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project');
    expect(r.ok && r.link.title).toBe('ChatGPT Project');
  });

  it('keeps an address of a form it does not recognise, as pasted and without query or fragment, because ChatGPT does not document its addresses', () => {
    const r = parseChatGptProjectLink('https://chatgpt.com/spaces/caissa-trainer?tab=files#top');
    expect(r).toEqual({ ok: true, link: { url: 'https://chatgpt.com/spaces/caissa-trainer', scopeId: null, title: 'ChatGPT Project', derivedFromConversation: false } });
  });

  it('refuses what is certainly not a project, and says what to copy instead', () => {
    expect(parseChatGptProjectLink(`https://chatgpt.com/c/${CHAT}`)).toMatchObject({ ok: false, message: expect.stringMatching(/single conversation outside any project/) });
    expect(parseChatGptProjectLink(`https://chatgpt.com/g/g-abc123-some-gpt/c/${CHAT}`)).toMatchObject({ ok: false, message: expect.stringMatching(/custom GPT/) });
    expect(parseChatGptProjectLink('https://chatgpt.com/')).toMatchObject({ ok: false, message: expect.stringMatching(/home page/) });
    expect(parseChatGptProjectLink('https://chatgpt.com/share/abc-def')).toMatchObject({ ok: false, message: expect.stringMatching(/share link/) });
    expect(parseChatGptProjectLink('https://chatgpt.com/s/abc-def')).toMatchObject({ ok: false, message: expect.stringMatching(/share link/) });
  });

  it('refuses another site, another scheme and nothing', () => {
    expect(parseChatGptProjectLink('https://evil.example/g/g-p-1/project')).toMatchObject({ ok: false, message: 'Only chatgpt.com addresses are accepted.' });
    expect(parseChatGptProjectLink('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(parseChatGptProjectLink('http://chatgpt.com/g/g-p-1/project')).toMatchObject({ ok: false, message: 'Only https addresses are accepted.' });
    expect(parseChatGptProjectLink('   ')).toMatchObject({ ok: false, message: 'Paste the address of the ChatGPT Project.' });
  });

  it('never keeps a query string, so an invitation token pasted with the address is dropped', () => {
    const r = parseChatGptProjectLink(`https://chatgpt.com/g/${SCOPE}/project?invite=SECRET-TOKEN`);
    expect(r.ok && JSON.stringify(r.link)).not.toContain('SECRET');
  });
});

describe('GitHub repositories', () => {
  it('reads the usual ways of pasting one', () => {
    for (const raw of ['acme/git-manager', 'https://github.com/acme/git-manager', 'github.com/acme/git-manager.git', 'git@github.com:acme/git-manager.git', 'https://github.com/acme/git-manager/pull/3?x=1#y']) {
      expect(normalizeGithubRepo(raw)).toMatchObject({ ok: true, value: 'acme/git-manager' });
    }
    expect(normalizeGithubRepo('')).toEqual({ ok: true, value: null, changed: false });
    expect(normalizeGithubRepo('not a repo')).toMatchObject({ ok: false });
  });

  it('builds the address of the repository page', () => {
    expect(githubRepoUrl('acme/git-manager')).toBe('https://github.com/acme/git-manager');
  });
});
