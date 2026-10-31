// The last page of ChatGPT a project was on (`ui.perProject[id].chatgptUrl`), in the real core: stored per project, validated, surviving a
// restart, forgotten with null. The renderer decides WHEN to remember a page; this is only the memory.
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, UI_LIMITS } from '@minisumma/shared';
import { cleanup, startHarness } from '../integration/harness.ts';
import type { Harness } from '../integration/harness.ts';

const SCOPE = 'g-p-0123456789abcdef0123456789abcdef-caissa-trainer';
const CONVERSATION = `https://chatgpt.com/g/${SCOPE}/c/5c4b3a29-1807-4f6e-8d5c-4b3a29180716`;
const PROJECT_PAGE = `https://chatgpt.com/g/${SCOPE}/project`;
const PLAIN = 'https://chatgpt.com/c/99999999-9999-4999-8999-999999999999';

const open: Harness[] = [];
afterEach(async () => { while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); } });
const boot = async (): Promise<Harness> => { const h = await startHarness(); open.push(h); return h; };
const status = (p: Promise<unknown>): Promise<number> => p.then(() => 200, (e: unknown) => (e instanceof ApiError ? e.status : -1));

describe('the remembered ChatGPT page of a project, in the real core', () => {
  it('is kept per project, drops the query and the fragment, merges with the other choices and survives a restart', async () => {
    const first = await boot();
    await first.client.call('settings.update', { body: { ui: { perProject: { prj_a: { conversationId: 'cnv_1', chatgptUrl: `${CONVERSATION}?model=x#top` }, prj_b: { chatgptUrl: PLAIN } } } } });
    await first.client.call('settings.update', { body: { ui: { perProject: { prj_b: { chatgptUrl: PROJECT_PAGE } } } } });
    const expected = { perProject: { prj_a: { conversationId: 'cnv_1', chatgptUrl: CONVERSATION }, prj_b: { chatgptUrl: PROJECT_PAGE } } };
    expect((await first.client.call('settings.get')).ui).toEqual(expected);
    const again = await first.restart();
    open.push(again);
    expect((await again.client.call('settings.get')).ui).toEqual(expected);
    expect((await again.client.call('system.state')).settings.ui).toEqual(expected);
  });

  it('is forgotten with null, and an entry with nothing left disappears', async () => {
    const h = await boot();
    await h.client.call('settings.update', { body: { ui: { perProject: { prj_a: { chatgptUrl: PLAIN } } } } });
    await h.client.call('settings.update', { body: { ui: { perProject: { prj_a: { chatgptUrl: null } } } } });
    expect((await h.client.call('settings.get')).ui).toBeUndefined();
  });

  it('refuses anything that is not a conversation or project page on chatgpt.com, and stores nothing of the refused change', async () => {
    const h = await boot();
    const refused: unknown[] = [
      'https://chatgpt.com/', // the home page
      'https://chatgpt.com/settings',
      'https://chatgpt.com/share/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', // a share link
      'https://auth.openai.com/log-in',
      'https://example.com/c/99999999-9999-4999-8999-999999999999',
      'http://chatgpt.com/c/99999999-9999-4999-8999-999999999999',
      'javascript:alert(1)',
      `${PLAIN}/${'x'.repeat(UI_LIMITS.urlChars)}`,
      5,
    ];
    for (const value of refused) {
      expect(await status(h.client.call('settings.update', { body: { layout: { sidebarWidth: 321 }, ui: { perProject: { prj_a: { chatgptUrl: value } } } } as never })), String(value).slice(0, 60)).toBe(400);
    }
    const settings = await h.client.call('settings.get');
    expect(settings.ui).toBeUndefined();
    expect(settings.layout.sidebarWidth).toBe(260);
  });
});
