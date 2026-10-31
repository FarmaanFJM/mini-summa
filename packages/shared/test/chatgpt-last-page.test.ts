// The remembered last page of ChatGPT per project: what is rememberable, how a change is read and merged.
import { describe, expect, it } from 'vitest';
import { checkUiPatch, mergeUi, rememberableChatGptUrl, sanitizeStoredUi, UI_LIMITS } from '../src/index.ts';

const SCOPE = 'g-p-0123456789abcdef0123456789abcdef-caissa-trainer';
const UUID = '5c4b3a29-1807-4f6e-8d5c-4b3a29180716';
const CONVERSATION = `https://chatgpt.com/g/${SCOPE}/c/${UUID}`;

describe('rememberableChatGptUrl', () => {
  it('accepts conversations (plain, inside a ChatGPT Project, with a custom GPT) and the page of a ChatGPT Project, in their plain form', () => {
    expect(rememberableChatGptUrl(`https://chatgpt.com/c/${UUID}`)).toBe(`https://chatgpt.com/c/${UUID}`);
    expect(rememberableChatGptUrl(`${CONVERSATION}?x=1#y`)).toBe(CONVERSATION);
    expect(rememberableChatGptUrl(`https://chatgpt.com/g/${SCOPE}/project`)).toBe(`https://chatgpt.com/g/${SCOPE}/project`);
    expect(rememberableChatGptUrl(`https://chatgpt.com/g/g-abc123/c/${UUID}`)).toBe(`https://chatgpt.com/g/g-abc123/c/${UUID}`);
    expect(rememberableChatGptUrl(`https://chat.openai.com/c/${UUID}`)).toBe(`https://chatgpt.com/c/${UUID}`);
  });

  it('refuses the home page, settings, sign-in, share links, other sites, other schemes, long and non-string values', () => {
    for (const value of ['https://chatgpt.com/', 'https://chatgpt.com/settings', 'https://chatgpt.com/share/abc', 'https://auth.openai.com/log-in', `https://evil.example/c/${UUID}`, `http://chatgpt.com/c/${UUID}`, `ftp://chatgpt.com/c/${UUID}`, `https://chatgpt.com/c/${UUID}/${'x'.repeat(UI_LIMITS.urlChars)}`, '', 7, null, undefined]) {
      expect(rememberableChatGptUrl(value), String(value).slice(0, 50)).toBeNull();
    }
  });
});

describe('the patch and the merge', () => {
  it('reads chatgptUrl next to the other per-project choices and normalises it', () => {
    const checked = checkUiPatch({ perProject: { prj_a: { chatgptUrl: `${CONVERSATION}?q=1`, conversationId: 'cnv_1' } } });
    expect(checked.problems).toEqual([]);
    expect(checked.patch.perProject?.prj_a).toEqual({ chatgptUrl: CONVERSATION, conversationId: 'cnv_1' });
  });

  it('reports a page that cannot be remembered, with the field named', () => {
    const r = checkUiPatch({ perProject: { prj_a: { chatgptUrl: 'https://chatgpt.com/' } } });
    expect(r.problems.map((p) => p.field)).toEqual(['ui.perProject.prj_a.chatgptUrl']);
  });

  it('merges per field, forgets with null and drops an entry that has nothing left', () => {
    const one = mergeUi(undefined, checkUiPatch({ perProject: { prj_a: { chatgptUrl: CONVERSATION } } }).patch);
    expect(one.perProject?.prj_a).toEqual({ chatgptUrl: CONVERSATION });
    const two = mergeUi(one, checkUiPatch({ perProject: { prj_a: { conversationId: 'cnv_1' } } }).patch);
    expect(two.perProject?.prj_a).toEqual({ conversationId: 'cnv_1', chatgptUrl: CONVERSATION });
    const three = mergeUi(two, checkUiPatch({ perProject: { prj_a: { chatgptUrl: null, conversationId: null } } }).patch);
    expect(three.perProject).toBeUndefined();
  });

  it('a change that changes nothing leaves the stored blob identical', () => {
    const one = mergeUi(undefined, checkUiPatch({ perProject: { prj_a: { chatgptUrl: CONVERSATION }, prj_b: { chatgptUrl: CONVERSATION } } }).patch);
    const again = mergeUi(one, checkUiPatch({ perProject: { prj_a: { chatgptUrl: CONVERSATION } } }).patch);
    expect(JSON.stringify(again)).toBe(JSON.stringify(one));
  });

  it('repairs what was stored: a stored page that is no longer rememberable is dropped, the rest is kept', () => {
    const stored = sanitizeStoredUi({ perProject: { prj_a: { conversationId: 'cnv_1' } } });
    expect(stored?.perProject?.prj_a).toEqual({ conversationId: 'cnv_1' });
  });
});
