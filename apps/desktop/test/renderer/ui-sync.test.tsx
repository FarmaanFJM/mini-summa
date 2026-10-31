// What the window remembers lives in the core (Settings.ui), so that it survives a change of the page origin (the core takes another
// port when 47811 is busy, and localStorage belongs to the origin). The window restores itself from the core, writes changes back
// after a quiet moment, keeps working when a write fails, and never lets a stale choice lead nowhere.
import { ApiError, EventStream, TerminalClient } from '@minisumma/shared';
import type { SessionKey, UiPrefs } from '@minisumma/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/renderer/src/app/api';
import { onboardingStore } from '../../src/renderer/src/app/onboardingPrefs';
import { createRuntime } from '../../src/renderer/src/app/runtime';
import type { Runtime } from '../../src/renderer/src/app/runtime';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import { createEmptySeed, createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';
import { adapterFactory, createFakeNative, renderApp } from './helpers';
import { renderFeature } from './features-helpers';

const FAST = { delayMs: 20, retry: { firstMs: 40, maxMs: 80 } } as const;
const GM_REVIEW_URL = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33/c/0b9c8d7e-6f5a-4b4c-9d3e-2f1a0b9c8d7e';
const GONE_KEY = 'win|ffffffff-0000-4000-8000-000000000000' as SessionKey;
const seedWith = (ui: UiPrefs | undefined) => { const seed = createSeed(); if (ui) seed.settings.ui = ui; return seed; };

type Spy = ReturnType<typeof vi.spyOn>;
/** The bodies of the settings.update calls that carry the window's memory. */
const uiWrites = (spy: Spy): unknown[] => (spy.mock.calls as unknown[][]).filter((c) => c[0] === 'settings.update').map((c) => (c[1] as { body: { ui?: unknown } }).body).filter((b) => b.ui !== undefined).map((b) => b.ui);
const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
const stored = (storage: { getItem(k: string): string | null }) => JSON.parse(storage.getItem('minisumma.route.v1') ?? 'null') as Record<string, unknown> | null;

describe('opening on what the core remembers', () => {
  const remembered: UiPrefs = {
    route: { projectId: IDS.atlas, view: 'workspace' },
    perProject: {
      [IDS.gitManager]: { sessionKey: IDS.s.gmPermission as SessionKey, conversationId: IDS.c.gmReview },
      [IDS.atlas]: { conversationId: IDS.c.atlasMain },
    },
  };

  it('shows the remembered project when the window\'s own storage is empty, as after a change of origin', async () => {
    const storage = createMemoryStorage();
    const app = await renderApp({ seed: seedWith(remembered), storage });
    await waitFor(() => expect(heading()).toBe('Atlas API'));
    expect(app.runtime.route.getState().projectId).toBe(IDS.atlas);
    // The window's own copy now holds it too: it is the fast copy.
    expect(stored(storage)).toMatchObject({ projectId: IDS.atlas, view: 'workspace' });
  });

  it('restores each project\'s own session tab and conversation', async () => {
    const user = userEvent.setup();
    await renderApp({ seed: seedWith(remembered), storage: createMemoryStorage() });
    await waitFor(() => expect(heading()).toBe('Atlas API'));
    await user.click(screen.getByRole('button', { name: /^GitManager(,|$)/ }));
    await waitFor(() => expect(heading()).toBe('GitManager'));
    const tab = await screen.findByRole('tab', { name: /b7c8d9e0/ });
    expect(tab.getAttribute('aria-selected')).toBe('true'); // not the first tab, which is a1b2c3d4
    expect(screen.getByRole('button', { name: 'Conversation' }).textContent).toContain('Code review notes');
  });

  it('never shows the first project on the way: the ChatGPT view is only ever asked for the remembered project\'s conversation', async () => {
    const fake = createFakeNative();
    await renderApp({ seed: seedWith(remembered), storage: createMemoryStorage(), native: fake });
    await waitFor(() => expect(heading()).toBe('Atlas API'));
    await waitFor(() => expect(fake.native.chatgpt.navigate).toHaveBeenCalled());
    const asked = (fake.native.chatgpt.navigate as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(asked.every((url) => url.includes('3a4b5c6d-7e8f-4091-a2b3-c4d5e6f70819'))).toBe(true); // Atlas API's conversation only
  });

  it('prefers the core to the window\'s own copy when both exist', async () => {
    const storage = createMemoryStorage({ 'minisumma.route.v1': JSON.stringify({ view: 'workspace', projectId: IDS.docs, sessionByProject: {}, conversationByProject: {} }) });
    const app = await renderApp({ seed: seedWith(remembered), storage });
    await waitFor(() => expect(heading()).toBe('Atlas API'));
    expect(app.runtime.route.getState().projectId).toBe(IDS.atlas);
  });

  it('keeps a checklist the person hid out of the way, although the window\'s own storage forgot it', async () => {
    const app = await renderFeature({ seed: (() => { const s = createEmptySeed(); s.settings.ui = { setup: { dismissed: true, seenEmpty: true } }; return s; })(), view: 'workspace', gate: true, storage: createMemoryStorage() });
    expect(onboardingStore(app.storage).getState()).toMatchObject({ dismissed: true, seenEmpty: true });
    expect(screen.queryByRole('region', { name: 'Set up Mini-Summa' })).toBeNull();
    expect(document.querySelector('.ms-onb-layer')).toBeNull();
  });
});

describe('choices that lead nowhere any more', () => {
  it('shows the first project when the remembered one no longer exists', async () => {
    const app = await renderApp({ seed: seedWith({ route: { projectId: 'prj_deleted', view: 'workspace' } }), storage: createMemoryStorage() });
    expect(heading()).toBe('GitManager');
    expect(app.runtime.route.getState().projectId).toBeNull();
  });

  it('shows the first project when the remembered one was archived', async () => {
    const seed = seedWith({ route: { projectId: IDS.docs, view: 'workspace' } });
    seed.projects.find((p) => p.id === IDS.docs)!.archivedAt = '2026-10-01T00:00:00.000Z';
    await renderApp({ seed, storage: createMemoryStorage() });
    expect(heading()).toBe('GitManager');
  });

  it('shows the newest session when the remembered session tab is gone', async () => {
    await renderApp({ seed: seedWith({ route: { projectId: IDS.gitManager, view: 'workspace' }, perProject: { [IDS.gitManager]: { sessionKey: GONE_KEY } } }), storage: createMemoryStorage() });
    // GitManager has two live managed sessions: a1b2c3d4 (started 95 minutes ago) and b7c8d9e0 (40 minutes ago).
    const tab = await screen.findByRole('tab', { name: /b7c8d9e0/ });
    await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
  });

  it('shows the first session, as always, when nothing was remembered', async () => {
    await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage() });
    const tab = await screen.findByRole('tab', { name: /a1b2c3d4/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });

  it('shows the preferred conversation when the remembered one was removed', async () => {
    await renderApp({ seed: seedWith({ route: { projectId: IDS.gitManager, view: 'workspace' }, perProject: { [IDS.gitManager]: { conversationId: 'cnv_removed' } } }), storage: createMemoryStorage() });
    expect((await screen.findByRole('button', { name: 'Conversation' })).textContent).toContain('Release planning');
  });
});

describe('writing back', () => {
  it('stores nothing about a route nobody changed: a first run with nothing stored writes no route', async () => {
    const app = await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: FAST });
    const spy = vi.spyOn(app.demo, 'call');
    await app.runtime.uiSync.flush();
    await new Promise((r) => setTimeout(r, 80));
    expect(uiWrites(spy).filter((ui) => (ui as { route?: unknown }).route !== undefined)).toEqual([]);
    expect(app.runtime.store.getState().settings?.ui?.route).toBeUndefined();
  });

  it('sends one patch after a quiet moment, naming only what changed', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: FAST });
    await app.runtime.uiSync.flush(); // what the first screen remembered by itself (the displayed session tab)
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    await user.click(screen.getByRole('button', { name: /^Docs site(,|$)/ }));
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    await waitFor(() => expect(uiWrites(spy).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 80));
    const writes = uiWrites(spy) as { route?: unknown; perProject?: Record<string, unknown> }[];
    expect(writes[0]).toMatchObject({ route: { projectId: IDS.atlas, view: 'workspace' } }); // three clicks, one route: the last one
    expect(Object.keys(writes[0]).filter((k) => k !== 'perProject')).toEqual(['route']);
    expect(app.runtime.store.getState().settings?.ui?.route).toEqual({ projectId: IDS.atlas, view: 'workspace' });
  });

  it('sends the choice of a session tab and of a conversation, for the project they belong to', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: FAST });
    await app.runtime.uiSync.flush();
    const tab = await screen.findByRole('tab', { name: /b7c8d9e0/ });
    await user.click(tab);
    await user.click(screen.getByRole('button', { name: 'Conversation' }));
    await user.click(await screen.findByRole('option', { name: /Code review notes/ }));
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]).toEqual({ sessionKey: IDS.s.gmPermission, conversationId: IDS.c.gmReview }));
    expect(app.runtime.uiSync.pending()).toEqual([]);
  });

  it('sends the window\'s own copy when the core has none, so the core becomes the durable home', async () => {
    const storage = createMemoryStorage({
      'minisumma.route.v1': JSON.stringify({ view: 'workspace', projectId: IDS.atlas, sessionByProject: { [IDS.gitManager]: IDS.s.gmPermission }, conversationByProject: { [IDS.gitManager]: IDS.c.gmReview } }),
      'minisumma.onboarding.v1': JSON.stringify({ seenEmpty: true, dismissed: true }),
    });
    const app = await renderApp({ seed: seedWith(undefined), storage, uiSync: FAST });
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]).toEqual({ sessionKey: IDS.s.gmPermission, conversationId: IDS.c.gmReview }));
    const ui = app.runtime.store.getState().settings?.ui;
    expect(ui?.route).toEqual({ projectId: IDS.atlas, view: 'workspace' });
    expect(ui?.setup).toEqual({ dismissed: true, seenEmpty: true });
    // ...and the window shows what it had
    expect(heading()).toBe('Atlas API');
  });

  it('remembers that the checklist was hidden', async () => {
    const user = userEvent.setup();
    const app = await renderFeature({ seed: createEmptySeed(), view: 'workspace', gate: true, storage: createMemoryStorage(), uiSync: FAST });
    await user.click(await screen.findByRole('button', { name: 'Hide the checklist' }));
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.setup).toEqual({ dismissed: true, seenEmpty: true }));
  });

  it('forgets the choices of a project that was removed', async () => {
    const app = await renderApp({ seed: seedWith({ perProject: { [IDS.docs]: { conversationId: 'cnv_x' }, [IDS.atlas]: { conversationId: IDS.c.atlasMain } } }), storage: createMemoryStorage(), uiSync: FAST });
    await app.demo.call('projects.remove', { params: { id: IDS.docs }, query: { mode: 'delete' } });
    await waitFor(() => expect(Object.keys(app.runtime.store.getState().settings?.ui?.perProject ?? {})).not.toContain(IDS.docs));
    expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.atlas]).toEqual({ conversationId: IDS.c.atlasMain });
    expect(app.runtime.route.getState().conversationByProject[IDS.docs]).toBeUndefined();
  });

  it('sends what is waiting as the page closes, with a request that outlives the page', async () => {
    const user = userEvent.setup();
    const sendOnClose = vi.fn();
    await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: { delayMs: 60_000, retry: FAST.retry }, sendOnClose });
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(sendOnClose).toHaveBeenCalledTimes(1);
    expect(sendOnClose.mock.calls[0][0].ui).toMatchObject({ route: { projectId: IDS.atlas, view: 'workspace' } });
  });
});

describe('when a write fails', () => {
  const offline = (app: Awaited<ReturnType<typeof renderApp>>, state: { failing: boolean; status: number }) => {
    const original = app.demo.call.bind(app.demo);
    return vi.spyOn(app.demo, 'call').mockImplementation(((name: string, input?: unknown) => {
      if (name === 'settings.update' && state.failing) return Promise.reject(new ApiError(state.status, state.status === 0 ? 'network' : 'validation_failed', 'The core did not take it.'));
      return (original as (n: string, i?: unknown) => Promise<unknown>)(name, input);
    }) as never);
  };

  it('keeps working, shows nothing, and tries again later with the same facts until the core has them', async () => {
    const user = userEvent.setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: FAST });
    await app.runtime.uiSync.flush();
    const state = { failing: true, status: 0 };
    const spy = offline(app, state);
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    await waitFor(() => expect(uiWrites(spy).length).toBeGreaterThanOrEqual(2)); // tried, and tried again
    expect(heading()).toBe('Atlas API'); // the window works
    expect(app.runtime.uiSync.pending()).toContain('route'); // still waiting for the core
    expect(screen.queryByRole('alert')).toBeNull(); // nothing on screen
    expect(document.querySelector('.sm-toast, [data-toast]')).toBeNull();
    expect(app.runtime.store.getState().settings?.ui?.route).toBeUndefined();
    state.failing = false;
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.route).toEqual({ projectId: IDS.atlas, view: 'workspace' }));
    expect(app.runtime.uiSync.pending()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('pauses longer between tries, and tries at once when the connection is live again', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: { delayMs: 10, retry: { firstMs: 5_000, maxMs: 5_000 } } });
    await app.runtime.uiSync.flush();
    const state = { failing: true, status: 0 };
    const spy = offline(app, state);
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    await waitFor(() => expect(uiWrites(spy)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 150));
    expect(uiWrites(spy)).toHaveLength(1); // waiting for the pause, not hammering the core
    state.failing = false;
    act(() => { app.runtime.store.setState({ connection: 'reconnecting' }); });
    act(() => { app.runtime.store.setState({ connection: 'live' }); });
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.route).toEqual({ projectId: IDS.atlas, view: 'workspace' }));
  });

  it('gives up on a change the core refuses for good, instead of asking for ever', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: FAST });
    await app.runtime.uiSync.flush();
    const spy = offline(app, { failing: true, status: 400 });
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    await waitFor(() => expect(uiWrites(spy)).toHaveLength(1));
    await waitFor(() => expect(app.runtime.uiSync.pending()).toEqual([]));
    await new Promise((r) => setTimeout(r, 200));
    expect(uiWrites(spy)).toHaveLength(1);
  });

  it('keeps the window\'s own copy meanwhile', async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const app = await renderApp({ seed: seedWith(undefined), storage, uiSync: FAST });
    offline(app, { failing: true, status: 0 });
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    expect(stored(storage)).toMatchObject({ projectId: IDS.atlas });
  });
});

describe('a change made just before the window closed', () => {
  const gmKey = IDS.s.gmWorking as SessionKey;
  const chooseSecondTab = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(await screen.findByRole('tab', { name: /b7c8d9e0/ })); };

  it('is newer than the core\'s copy: after a restart it wins over an older value there, and is then sent', async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    // The core remembers the first tab (written earlier). The person chooses the second one, and the window closes before the quiet period is over.
    const seed = seedWith({ route: { projectId: IDS.gitManager, view: 'workspace' }, perProject: { [IDS.gitManager]: { sessionKey: gmKey } } });
    const first = await renderApp({ seed, storage, uiSync: { delayMs: 60_000, retry: FAST.retry } });
    await chooseSecondTab(user);
    expect(first.runtime.uiSync.pending()).toContain(`session:${IDS.gitManager}`);
    expect(JSON.parse(storage.getItem('minisumma.uisync.pending.v1') ?? '[]')).toContain(`session:${IDS.gitManager}`); // kept for the next start
    first.runtime.dispose();
    first.unmount();

    // The next start, on the same window storage: the core still says "first tab", the window knows better.
    const second = await renderApp({ seed, storage, uiSync: FAST });
    const tab = await screen.findByRole('tab', { name: /b7c8d9e0/ });
    await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
    expect(second.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(IDS.s.gmPermission);
    await waitFor(() => expect(second.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBe(IDS.s.gmPermission));
    await waitFor(() => expect(second.runtime.uiSync.pending()).toEqual([]));
    expect(JSON.parse(storage.getItem('minisumma.uisync.pending.v1') ?? '[]')).toEqual([]); // acknowledged: nothing waits any more
  });

  it('is still sent when the core could not be reached before the window closed', async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const seed = seedWith(undefined);
    const first = await renderApp({ seed, storage, uiSync: FAST });
    await first.runtime.uiSync.flush();
    const original = first.demo.call.bind(first.demo);
    vi.spyOn(first.demo, 'call').mockImplementation(((name: string, input?: unknown) => (name === 'settings.update' ? Promise.reject(new ApiError(0, 'network', 'down')) : (original as (n: string, i?: unknown) => Promise<unknown>)(name, input))) as never);
    await user.click(screen.getByRole('button', { name: /^Atlas API(,|$)/ }));
    await waitFor(() => expect(first.runtime.uiSync.pending()).toContain('route'));
    first.runtime.dispose();
    first.unmount();

    const second = await renderApp({ seed, storage, uiSync: FAST });
    await waitFor(() => expect(second.runtime.store.getState().settings?.ui?.route).toEqual({ projectId: IDS.atlas, view: 'workspace' }));
    expect(heading()).toBe('Atlas API');
  });

  it('is not needed when nothing was waiting: the core\'s copy wins, as before', async () => {
    const storage = createMemoryStorage({ 'minisumma.uisync.pending.v1': '[]', 'minisumma.route.v1': JSON.stringify({ view: 'workspace', projectId: IDS.docs, sessionByProject: {}, conversationByProject: {} }) });
    const app = await renderApp({ seed: seedWith({ route: { projectId: IDS.atlas, view: 'workspace' } }), storage, uiSync: FAST });
    await waitFor(() => expect(heading()).toBe('Atlas API'));
    expect(app.runtime.route.getState().projectId).toBe(IDS.atlas);
  });

  it('ignores a pending list that is damaged', async () => {
    for (const bad of ['not json', '{"route":true}', '[1,{"a":2},null]']) {
      const storage = createMemoryStorage({ 'minisumma.uisync.pending.v1': bad });
      const app = await renderApp({ seed: seedWith(undefined), storage, uiSync: FAST });
      expect(app.runtime.uiSync.pending().filter((f) => f !== `session:${IDS.gitManager}`)).toEqual([]);
      app.runtime.dispose();
      app.unmount();
    }
  });
});

describe('two windows on one core', () => {
  /** Another window: its own runtime, its own storage, the same core. */
  function otherWindow(first: Awaited<ReturnType<typeof renderApp>>, storage = createMemoryStorage()): Runtime {
    const server = first.demo.demo.server;
    const events = new EventStream({ baseUrl: 'http://demo.invalid', token: 'demo-token', clientName: 'second window', WebSocket: server.transport.WebSocket });
    const api: ApiClient = { call: server.call, events, terminal: new TerminalClient(events) };
    return createRuntime({ api, native: createFakeNative().native, mode: 'demo', adapterFactory: adapterFactory().factory, storage, schedule: (fn) => { fn(); return 0; }, uiSync: FAST });
  }
  const loaded = (r: Runtime) => waitFor(() => { if (!r.store.getState().loaded) throw new Error('not loaded'); });

  it('merges what each writes, and a window never writes back a choice it did not make', async () => {
    const first = await renderApp({ seed: seedWith(undefined), storage: createMemoryStorage(), uiSync: FAST });
    const second = otherWindow(first);
    await loaded(second);
    await first.runtime.uiSync.flush();
    // The first window chooses a session tab; the second, a conversation of the same project and a project of its own.
    first.runtime.route.getState().selectSession(IDS.gitManager, IDS.s.gmPermission as SessionKey);
    second.route.getState().selectConversation(IDS.gitManager, IDS.c.gmReview);
    second.route.getState().selectProject(IDS.atlas);
    await first.runtime.uiSync.flush();
    await second.uiSync.flush();
    const ui = first.runtime.store.getState().settings?.ui;
    expect(ui?.perProject?.[IDS.gitManager]).toEqual({ sessionKey: IDS.s.gmPermission, conversationId: IDS.c.gmReview });
    expect(ui?.route).toEqual({ projectId: IDS.atlas, view: 'workspace' });
    // The first window still shows its own project: the second one's choice does not move it.
    expect(first.runtime.route.getState().projectId).toBeNull();
    // A third window opens where the others left off.
    const third = otherWindow(first);
    await loaded(third);
    expect(third.route.getState()).toMatchObject({ projectId: IDS.atlas, sessionByProject: { [IDS.gitManager]: IDS.s.gmPermission }, conversationByProject: { [IDS.gitManager]: IDS.c.gmReview } });
    for (const r of [second, third]) r.dispose();
  });

  it('does not undo another window\'s choice when it writes something else', async () => {
    const first = await renderApp({ seed: seedWith({ perProject: { [IDS.gitManager]: { conversationId: IDS.c.gmRelease } } }), storage: createMemoryStorage(), uiSync: FAST });
    const second = otherWindow(first);
    await loaded(second);
    // The second window chose another conversation; the first window (which still remembers the old one) changes its session tab.
    second.route.getState().selectConversation(IDS.gitManager, IDS.c.gmReview);
    await second.uiSync.flush();
    first.runtime.route.getState().selectSession(IDS.gitManager, IDS.s.gmPermission as SessionKey);
    await first.runtime.uiSync.flush();
    expect(first.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]).toEqual({ conversationId: IDS.c.gmReview, sessionKey: IDS.s.gmPermission });
    second.dispose();
  });
});

describe('what the core is told about the Claude pane', () => {
  const gmFirst = IDS.s.gmWorking as SessionKey;
  const gmSecond = IDS.s.gmPermission as SessionKey;
  const gmWrites = (spy: Spy) => writesFor(spy, IDS.gitManager);
  const tabOf = (id: RegExp) => screen.findByRole('tab', { name: id });

  it('remembers no local session for a project while its Cloud tab is the one shown, and the last one again when a local tab is', async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const seed = seedWith({ route: { projectId: IDS.gitManager, view: 'workspace' }, perProject: { [IDS.gitManager]: { sessionKey: gmSecond } } });
    const app = await renderApp({ seed, storage, uiSync: FAST });
    await tabOf(/b7c8d9e0/);
    await app.runtime.uiSync.flush();
    const spy = vi.spyOn(app.demo, 'call');
    expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBe(gmSecond); // the session on screen is the one remembered

    // The Cloud tab is shown: the core is told there is no session on screen.
    await user.click(await tabOf(/^Cloud/));
    await waitFor(() => expect(gmWrites(spy)).toContainEqual({ sessionKey: null }));
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBeUndefined());
    // Only the core's copy is cleared. The window keeps the last local choice, in memory and in its own storage, to go back to.
    expect(app.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(gmSecond);
    expect(stored(storage)).toMatchObject({ sessionByProject: { [IDS.gitManager]: gmSecond } });

    // A local tab is shown again: the core is told which one.
    await user.click(await tabOf(/a1b2c3d4/));
    await waitFor(() => expect(gmWrites(spy).at(-1)).toEqual({ sessionKey: gmFirst }));
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBe(gmFirst));
    expect(app.runtime.uiSync.pending()).toEqual([]);
  });

  it('says the same session again when the person goes back to the one that was chosen before the Cloud tab', async () => {
    const user = userEvent.setup();
    const seed = seedWith({ route: { projectId: IDS.gitManager, view: 'workspace' }, perProject: { [IDS.gitManager]: { sessionKey: gmSecond } } });
    const app = await renderApp({ seed, storage: createMemoryStorage(), uiSync: FAST });
    await tabOf(/b7c8d9e0/);
    await app.runtime.uiSync.flush();
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(await tabOf(/^Cloud/));
    await waitFor(() => expect(gmWrites(spy)).toContainEqual({ sessionKey: null }));
    await user.click(await tabOf(/b7c8d9e0/)); // the very tab that was remembered
    await waitFor(() => expect(gmWrites(spy).at(-1)).toEqual({ sessionKey: gmSecond }));
    expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBe(gmSecond);
  });

  // The quiet period is 2 s, not 150 ms: two clicks took longer than 150 ms on a slow Windows runner and the test then saw the intermediate write.
  it('sends the last state only when the person goes to the Cloud tab and back within the quiet period', async () => {
    const user = userEvent.setup();
    const seed = seedWith({ route: { projectId: IDS.gitManager, view: 'workspace' }, perProject: { [IDS.gitManager]: { sessionKey: gmSecond } } });
    const app = await renderApp({ seed, storage: createMemoryStorage(), uiSync: { delayMs: 2000, retry: FAST.retry } });
    await tabOf(/b7c8d9e0/);
    await app.runtime.uiSync.flush();
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(await tabOf(/^Cloud/));
    await user.click(await tabOf(/b7c8d9e0/));
    await new Promise((r) => setTimeout(r, 2600));
    expect(gmWrites(spy).filter((w) => (w as { sessionKey?: unknown }).sessionKey === null)).toEqual([]); // the core never heard of a Cloud tab that was not there for long
    expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBe(gmSecond);
  });

  it('does the same for any project: Atlas API\'s only session is forgotten while its Cloud tab shows, and remembered when the tab goes', async () => {
    const user = userEvent.setup();
    const app = await renderApp({ seed: seedWith({ route: { projectId: IDS.atlas, view: 'workspace' } }), storage: createMemoryStorage(), uiSync: FAST });
    await tabOf(/e1f2a3b4/);
    await app.runtime.uiSync.flush();
    expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.atlas]?.sessionKey).toBe(IDS.s.atlasIdle); // the session on screen is remembered
    const spy = vi.spyOn(app.demo, 'call');
    await user.click(await tabOf(/^Cloud/));
    await waitFor(() => expect(writesFor(spy, IDS.atlas)).toContainEqual({ sessionKey: null }));
    await user.click(await tabOf(/e1f2a3b4/));
    await waitFor(() => expect(writesFor(spy, IDS.atlas).at(-1)).toEqual({ sessionKey: IDS.s.atlasIdle }));
  });
});

/** The change to one project's remembered choices in each write that carried one, oldest first. */
function writesFor(spy: Spy, id: string) {
  return (uiWrites(spy) as { perProject?: Record<string, unknown> }[]).map((ui) => ui.perProject?.[id]).filter((v) => v !== undefined);
}
