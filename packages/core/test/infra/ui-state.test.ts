// The window's memory lives in the core (Settings.ui): over the real HTTP API, across a real core restart, with the scopes
// that the route table promises (a phone may read it, only the desktop may write it) and with the validation that keeps it small.
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, MiniSummaClient, UI_LIMITS } from '@minisumma/shared';
import type { SessionKey } from '@minisumma/shared';
import { cleanup, startHarness } from '../integration/harness.ts';
import type { Harness } from '../integration/harness.ts';

const KEY = 'posix|a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617' as SessionKey;
const open: Harness[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  while (closers.length) closers.pop()!();
  while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); }
});
const boot = async (): Promise<Harness> => { const h = await startHarness(); open.push(h); return h; };
const status = (p: Promise<unknown>): Promise<number> => p.then(() => 200, (e: unknown) => (e instanceof ApiError ? e.status : -1));

async function pairReadOnly(h: Harness): Promise<MiniSummaClient> {
  const offer = await h.client.call('pairing.createOffer', { body: { scopes: ['read'] } });
  const anon = new MiniSummaClient({ baseUrl: h.core.baseUrl, token: '' });
  const res = await anon.call('pairing.redeem', { body: { offerId: offer.id, code: offer.code, deviceName: 'Pixel', platform: 'android' } });
  const phone = new MiniSummaClient({ baseUrl: h.core.baseUrl, token: res.token, clientName: 'Pixel', WebSocket: WebSocket as never });
  closers.push(() => phone.close());
  return phone;
}

describe('the window state in the real core', () => {
  it('survives a restart of the core, with what was written by more than one window merged', async () => {
    const first = await boot();
    const { project, conversations } = await first.project('GitManager', { conversations: ['https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'] });
    expect((await first.client.call('settings.get')).ui).toBeUndefined(); // a first run stores nothing

    // Window one chooses a project, a session tab and a conversation; window two (another token user) only forgets the session tab.
    await first.client.call('settings.update', { body: { ui: { route: { projectId: project.id, view: 'reports' }, perProject: { [project.id]: { sessionKey: KEY, conversationId: conversations[0].id } }, setup: { dismissed: true, seenEmpty: true } } } });
    await first.client.call('settings.update', { body: { ui: { perProject: { [project.id]: { sessionKey: null } } } } });
    const expected = { route: { projectId: project.id, view: 'reports' }, perProject: { [project.id]: { conversationId: conversations[0].id } }, setup: { dismissed: true, seenEmpty: true } };
    expect((await first.client.call('settings.get')).ui).toEqual(expected);

    const again = await first.restart();
    open.push(again);
    expect((await again.client.call('settings.get')).ui).toEqual(expected);
    expect((await again.client.call('system.state')).settings.ui).toEqual(expected); // the snapshot a window loads on start
    // ...and a second restart does not change it either.
    const third = await again.restart();
    open.push(third);
    expect((await third.client.call('settings.get')).ui).toEqual(expected);
  });

  it('is announced to the desktop as an ordinary settings change, and a change that changes nothing is not', async () => {
    const h = await boot();
    const seen: unknown[] = [];
    await h.waitFor('the event stream to open', () => h.client.events.status === 'open');
    h.client.events.onEvent((_seq, event) => { if (event.type === 'settings.changed') seen.push(event.settings.ui); });
    await h.client.call('settings.update', { body: { ui: { setup: { dismissed: true } } } });
    await h.waitFor('the settings.changed event', () => seen.length === 1);
    await h.client.call('settings.update', { body: { ui: { setup: { dismissed: true } } } });
    await h.client.call('settings.update', { body: { ui: {} } });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([{ setup: { dismissed: true } }]);
  });

  it('can be read with the read scope and written only with the desktop scope', async () => {
    const h = await boot();
    await h.client.call('settings.update', { body: { ui: { route: { projectId: null, view: 'activity' } } } });
    const phone = await pairReadOnly(h);
    expect((await phone.call('settings.get')).ui).toEqual({ route: { projectId: null, view: 'activity' } });
    expect((await phone.call('system.state')).settings.ui).toEqual({ route: { projectId: null, view: 'activity' } });
    expect(await status(phone.call('settings.update', { body: { ui: { route: null } } }))).toBe(403);
    expect((await h.client.call('settings.get')).ui).toEqual({ route: { projectId: null, view: 'activity' } }); // untouched
  });

  it('rejects what is unknown, malformed or too big with a 400 and stores nothing of it', async () => {
    const h = await boot();
    const attempts: unknown[] = [
      { theme: 'dark' },
      { route: { projectId: null, view: 'workspace', zoom: 2 } },
      { route: { projectId: 'prj_a', view: 'moon' } },
      { perProject: { prj_a: { sessionKey: 'not-a-key' } } },
      { perProject: { prj_a: { sessionKey: KEY, scroll: 3 } } },
      { perProject: { prj_a: { conversationId: 'c'.repeat(UI_LIMITS.idChars + 1) } } },
      { perProject: Object.fromEntries(Array.from({ length: UI_LIMITS.projects + 1 }, (_, i) => [`prj_${i}`, { conversationId: 'cnv_1' }])) },
      { setup: { dismissed: 'yes' } },
    ];
    for (const ui of attempts) expect(await status(h.client.call('settings.update', { body: { layout: { sidebarWidth: 321 }, ui } as never })), JSON.stringify(ui).slice(0, 80)).toBe(400);
    const settings = await h.client.call('settings.get');
    expect(settings.ui).toBeUndefined();
    expect(settings.layout.sidebarWidth).toBe(260); // a refused patch applies none of its parts
  });

  it('keeps the other settings intact when it is written, and is not touched when they are', async () => {
    const h = await boot();
    await h.client.call('settings.update', { body: { ui: { setup: { seenEmpty: true } }, review: { maxPartChars: 5000 } } });
    await h.client.call('settings.update', { body: { layout: { landscapeRatio: 0.6 } } });
    const settings = await h.client.call('settings.get');
    expect(settings.ui).toEqual({ setup: { seenEmpty: true } });
    expect(settings.review.maxPartChars).toBe(5000);
    expect(settings.layout.landscapeRatio).toBe(0.6);
  });
});
