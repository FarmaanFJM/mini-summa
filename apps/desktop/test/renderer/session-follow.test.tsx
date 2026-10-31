// A managed terminal can go on as another Claude session (/clear or /resume inside it): the core keeps the terminal managed under a new
// session key and the old session becomes ended history that names its successor (`replacedBy`). The window follows: the old tab
// becomes the new one in the same place, the remembered choice moves with it, and the old session stays reachable as history.
// While the new session is not known, a running terminal says so in words and nothing offers to type into it for the person.
import type { SessionKey, SessionView } from '@minisumma/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { needsAttention } from '../../src/renderer/src/app/selectors';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';
import { targetEligibility } from '../../src/renderer/src/features/reports/model';
import { canOfferTyping, describeInputTarget, isReplacedUnidentified, noticeFor } from '../../src/renderer/src/features/workspace/sessionModel';
import { replacementMoves, successorOf, withAutoTabs } from '../../src/renderer/src/features/workspace/tabs';
import { renderApp } from './helpers';

const FAST = { delayMs: 20, retry: { firstMs: 40, maxMs: 80 } } as const;
const OLD = IDS.s.gmWorking as SessionKey; // a1b2c3d4, managed, live
const OTHER = IDS.s.gmPermission as SessionKey; // b7c8d9e0, managed, live
const NEW_ID = 'ee11ee11-0000-4000-8000-0000000000e1';
const NEW = `win|${NEW_ID}` as SessionKey;
const NEWER_ID = 'ff22ff22-0000-4000-8000-0000000000f2';
const NEWER = `win|${NEWER_ID}` as SessionKey;
const ATLAS_SESSION = IDS.s.atlasIdle as SessionKey; // wsl:Ubuntu|..., managed, live
const ATLAS_NEW = `wsl:Ubuntu|${NEW_ID}` as SessionKey;

type App = Awaited<ReturnType<typeof renderApp>>;
const server = (app: App) => app.demo.demo.server;
// The session tabs of the Claude pane. GitManager also has the Cloud tab (it has a GitHub repository), which is not a session.
const sessionTabs = () => screen.getAllByRole('tab', { name: /^Session / });
const tabs = () => sessionTabs().map((t) => (/Session ([0-9a-f]{8})/.exec(t.getAttribute('aria-label') ?? t.getAttribute('title') ?? t.textContent ?? '') ?? [])[1]);
const selectedTab = () => (/[0-9a-f]{8}/.exec(sessionTabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? '') ?? [])[0];
const claudePane = () => screen.getByRole('region', { name: 'Claude' });
const stateOf = (app: App, key: SessionKey) => app.runtime.store.getState().sessions.find((s) => s.key === key);

async function openGitManager(options: Parameters<typeof renderApp>[0] = {}): Promise<App> {
  const app = await renderApp({ seed: createSeed(), storage: createMemoryStorage(), uiSync: FAST, ...options });
  await screen.findByRole('heading', { level: 1, name: 'GitManager' });
  await waitFor(() => expect(tabs()).toEqual(['a1b2c3d4', 'b7c8d9e0']));
  await waitFor(() => expect(app.runtime.terminals.has(OLD)).toBe(true));
  return app;
}

describe('the tab follows the terminal', () => {
  it('replaces the old session\'s tab by the new one, in the same place, and selects it', async () => {
    const app = await openGitManager();
    expect(selectedTab()).toBe('a1b2c3d4');
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(tabs()).toEqual(['ee11ee11', 'b7c8d9e0'])); // the second tab did not move, the first is the new session
    expect(selectedTab()).toBe('ee11ee11');
    expect(app.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(NEW);
    expect(app.runtime.ui.getState().openTabs[IDS.gitManager]).toEqual([NEW, OTHER]);
    // The new tab is a running managed terminal: no "ended" notice, input goes there, the terminal attached and drew the scrollback.
    expect(within(claudePane()).queryByText(/This session ended/)).toBeNull();
    expect(within(claudePane()).getByText(/Input goes to:/).closest('.ms-input')?.textContent).toContain('Session ee11ee11');
    await waitFor(() => expect(app.runtime.terminals.info(NEW)?.status).toBe('attached'));
    expect(app.runtime.terminals.info(NEW)?.hasOutput).toBe(true);
    expect(app.runtime.terminals.has(OLD)).toBe(false); // the old key's terminal view was let go: the terminal is shown under the new key
  });

  it('moves what the window remembers, in the core too, so that a restart opens on the new session', async () => {
    const app = await openGitManager();
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBe(NEW));
    expect(app.runtime.uiSync.pending()).not.toContain(`session:${IDS.gitManager}`);
  });

  it('ends on one tab for the terminal whichever of the two sessions the window hears about first', async () => {
    for (const order of ['old-first', 'new-first'] as const) {
      const app = await openGitManager();
      act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID, order }); });
      await waitFor(() => expect(tabs()).toEqual(['ee11ee11', 'b7c8d9e0']));
      expect(selectedTab(), order).toBe('ee11ee11');
      expect(app.runtime.ui.getState().openTabs[IDS.gitManager], order).toEqual([NEW, OTHER]);
      expect(app.runtime.route.getState().sessionByProject[IDS.gitManager], order).toBe(NEW);
      app.runtime.dispose();
      app.unmount();
    }
  });

  it('keeps the person on the tab they were on when another tab\'s terminal is replaced', async () => {
    const user = userEvent.setup();
    const app = await openGitManager();
    await user.click(screen.getByRole('tab', { name: /b7c8d9e0/ }));
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(tabs()).toEqual(['ee11ee11', 'b7c8d9e0']));
    expect(selectedTab()).toBe('b7c8d9e0'); // not taken away from what they were reading
    expect(app.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(OTHER);
  });

  it('follows a second replacement from the new session on to the next', async () => {
    const app = await openGitManager();
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(selectedTab()).toBe('ee11ee11'));
    act(() => { server(app).replaceConversation(NEW, { newSessionId: NEWER_ID, cause: 'resume' }); });
    await waitFor(() => expect(tabs()).toEqual(['ff22ff22', 'b7c8d9e0']));
    expect(selectedTab()).toBe('ff22ff22');
    expect(app.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(NEWER);
    expect(app.runtime.ui.getState().openTabs[IDS.gitManager]).toEqual([NEWER, OTHER]);
  });

  it('moves the tab and the remembered choice of a project that is not on screen', async () => {
    const app = await openGitManager();
    act(() => { app.runtime.route.getState().selectSession(IDS.atlas, ATLAS_SESSION); app.runtime.ui.getState().openTab(IDS.atlas, ATLAS_SESSION); });
    act(() => { server(app).replaceConversation(ATLAS_SESSION, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(app.runtime.ui.getState().openTabs[IDS.atlas]).toEqual([ATLAS_NEW]));
    expect(app.runtime.route.getState().sessionByProject[IDS.atlas]).toBe(ATLAS_NEW);
    expect(app.runtime.route.getState().projectId ?? IDS.gitManager).toBe(IDS.gitManager); // the selected project did not change
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.atlas]?.sessionKey).toBe(ATLAS_NEW));
  });

  it('opens on the new session when what was remembered is a session whose terminal went on (the window was not there to see it)', async () => {
    const seed = createSeed();
    const k = seed.sessions.find((s) => s.key === OLD)!;
    const successor: SessionView = { ...structuredClone(k), key: NEW, sessionId: NEW_ID, startedAt: new Date().toISOString() };
    Object.assign(k, { availability: 'resumable', resumable: true, state: 'ended', stateLabel: 'Session ended', replacedBy: NEW, pid: null, terminal: { ...k.terminal!, exited: true } });
    seed.sessions.push(successor);
    const storage = createMemoryStorage({ 'minisumma.route.v1': JSON.stringify({ view: 'workspace', projectId: IDS.gitManager, sessionByProject: { [IDS.gitManager]: OLD }, conversationByProject: {} }) });
    const app = await renderApp({ seed, storage, uiSync: FAST });
    await waitFor(() => expect(selectedTab()).toBe('ee11ee11'));
    expect(tabs()).not.toContain('a1b2c3d4');
    expect(app.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(NEW);
    await waitFor(() => expect(app.runtime.store.getState().settings?.ui?.perProject?.[IDS.gitManager]?.sessionKey).toBe(NEW));
  });

  it('stays where it is when the session at the end is not running: nothing is guessed', async () => {
    const app = await openGitManager();
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID, successorLive: false }); });
    await waitFor(() => expect(stateOf(app, OLD)?.replacedBy).toBe(NEW));
    expect([...tabs()].sort()).toEqual(['a1b2c3d4', 'b7c8d9e0']); // still its own tab (a session that is not running sorts after the live ones), no new tab
    expect(selectedTab()).toBe('a1b2c3d4');
    expect(app.runtime.route.getState().sessionByProject[IDS.gitManager]).toBe(OLD);
    expect(within(claudePane()).getByText(/This session ended: .*went on as session ee11ee11/)).toBeTruthy();
  });

  it('gives the keyboard to the new terminal when the person was typing in the old one', async () => {
    const app = await openGitManager();
    const host = app.runtime.terminals.hostOf(OLD)!;
    const field = document.createElement('textarea'); // stands for xterm's input
    host.appendChild(field);
    field.focus();
    expect(host.contains(document.activeElement)).toBe(true);
    const before = app.runtime.ui.getState().terminalFocus?.nonce ?? 0;
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(app.runtime.ui.getState().terminalFocus).toMatchObject({ key: NEW }));
    expect(app.runtime.ui.getState().terminalFocus!.nonce).toBeGreaterThan(before);
  });

  it('does not ask for the person\'s attention for a session that only went on as another one', async () => {
    const app = await openGitManager();
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(stateOf(app, OLD)?.replacedBy).toBe(NEW));
    const old = { ...stateOf(app, OLD)!, attention: { kind: 'abnormal_end' as const, since: null } }; // a /clear in the middle of a turn looks like an abnormal end
    expect(needsAttention(old)).toBe(false);
    expect(needsAttention({ ...old, replacedBy: undefined })).toBe(true);
  });
});

describe('the old session as history', () => {
  it('stays in the Sessions menu as ended, and opens as history that does not move on again', async () => {
    const user = userEvent.setup();
    const app = await openGitManager();
    act(() => { server(app).replaceConversation(OLD, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(selectedTab()).toBe('ee11ee11'));
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    const item = await screen.findByRole('menuitem', { name: 'a1b2c3d4, managed, Session ended, went on as ee11ee11' });
    await user.click(item);
    // The person asked for it: its tab is there and selected, with the reason it ended, and it is not replaced again by its successor.
    await waitFor(() => expect(selectedTab()).toBe('a1b2c3d4'));
    expect(tabs()).toContain('ee11ee11');
    expect(within(claudePane()).getByText(/This session ended: The conversation was cleared with \/clear\. The same terminal went on as session ee11ee11/)).toBeTruthy();
    await act(async () => { server(app).data.sessions.find((s) => s.key === NEW)!.lastActivityAt = new Date().toISOString(); server(app).transport.emit({ type: 'session.upserted', session: structuredClone(server(app).data.sessions.find((s) => s.key === NEW)!) }); await new Promise((r) => setTimeout(r, 50)); });
    expect(selectedTab()).toBe('a1b2c3d4');
    expect(app.runtime.ui.getState().history).toContain(OLD);
  });

  it('is not listed for a project it does not belong to, and the menu has no such group before anything was replaced', async () => {
    const user = userEvent.setup();
    const app = await openGitManager();
    await user.click(screen.getByRole('button', { name: 'Sessions' })); // GitManager has an observed session, so the menu exists
    expect(screen.queryByRole('menuitem', { name: /went on as/ })).toBeNull();
    await user.keyboard('{Escape}');
    act(() => { server(app).replaceConversation(ATLAS_SESSION, { newSessionId: NEW_ID }); });
    await waitFor(() => expect(stateOf(app, ATLAS_SESSION)?.replacedBy).toBe(ATLAS_NEW));
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.queryByRole('menuitem', { name: /went on as/ })).toBeNull(); // that one is Atlas API's
  });
});

describe('a terminal whose conversation was replaced and whose new session is not known', () => {
  const NOT_LEARNED = 'The conversation in this terminal was replaced (/clear or /resume), but Claude Code has not told Mini-Summa which session the terminal runs now. Typing from Mini-Summa is paused here; the terminal itself still works.';
  const unresolved = (): SessionView => ({
    ...createSeed().sessions.find((s) => s.key === OLD)!, state: 'ended', stateLabel: 'Conversation replaced, new session not identified',
    termination: { kind: 'observed', reason: NOT_LEARNED, at: null }, attention: null,
  });

  it('says why, as a notice that needs the person\'s attention, in the core\'s own words', () => {
    const s = unresolved();
    expect(isReplacedUnidentified(s)).toBe(true);
    expect(noticeFor(s, [])).toEqual({ tone: 'attention', text: NOT_LEARNED, canResume: false });
    // Every other running terminal is untouched by this.
    expect(isReplacedUnidentified({ ...s, termination: null })).toBe(false);
    expect(noticeFor({ ...s, state: 'waiting_for_you', stateLabel: 'Waiting for you', termination: null }, [])).toBeNull();
    // An ended session keeps saying that it ended.
    expect(noticeFor({ ...s, availability: 'resumable' }, [])?.text).toContain('This session ended:');
  });

  it('offers no typing from Mini-Summa, while the person can still type in the terminal itself', () => {
    const s = unresolved();
    expect(canOfferTyping(s)).toBe(false);
    expect(canOfferTyping({ ...s, state: 'waiting_for_you', termination: null })).toBe(true);
    // even if some state said otherwise, the termination alone keeps it closed
    expect(canOfferTyping({ ...s, state: 'waiting_for_you' })).toBe(false);
    const eligibility = targetEligibility({ ...s, state: 'waiting_for_you' });
    expect(eligibility).toMatchObject({ ok: false, kind: 'not_ready' });
    expect((eligibility as { reason: string }).reason).toBe(`Not ready: ${NOT_LEARNED}`);
    const banner = describeInputTarget(s, 'GitManager', true);
    expect(banner.kind).toBe('replaced');
    expect(banner.text).toContain('Input goes to: the terminal of GitManager.');
    expect(banner.text).toContain('Mini-Summa will not type into it for you');
  });

  it('shows the notice and the banner in the Claude pane, and the follow-up form refuses it', async () => {
    const seed = createSeed();
    Object.assign(seed.sessions.find((s) => s.key === OLD)!, unresolved());
    await renderApp({ seed, storage: createMemoryStorage(), uiSync: FAST });
    await screen.findByRole('heading', { level: 1, name: 'GitManager' });
    const notice = await within(claudePane()).findByText(NOT_LEARNED);
    expect(notice.closest('[role="status"]')?.getAttribute('data-tone')).toBe('attention');
    expect(within(claudePane()).getByText(/Input goes to:/).closest('.ms-input')?.getAttribute('data-kind')).toBe('replaced');
    expect(within(claudePane()).queryByRole('button', { name: 'Resume session' })).toBeNull();
  });
});

describe('which tabs move (pure)', () => {
  const live = (key: SessionKey, over: Partial<SessionView> = {}): SessionView => ({ ...createSeed().sessions.find((s) => s.key === OLD)!, key, sessionId: key.split('|')[1], ...over });
  const replaced = (key: SessionKey, by: SessionKey): SessionView => live(key, { availability: 'resumable', state: 'ended', replacedBy: by });
  const model = (tabsOf: SessionKey[]) => ({ openTabs: { [IDS.gitManager]: tabsOf }, dismissed: [] as SessionKey[] });

  it('names the live session at the end of the chain, and nothing when it is not there, not live, not managed, or loops', () => {
    const a = replaced(OLD, NEW);
    const b = live(NEW);
    expect(successorOf(OLD, [a, b])?.key).toBe(NEW);
    expect(successorOf(OLD, [a])).toBeNull(); // the new one has not reached the window yet
    expect(successorOf(OLD, [a, live(NEW, { availability: 'resumable', state: 'ended' })])).toBeNull();
    expect(successorOf(OLD, [a, live(NEW, { origin: 'external' })])).toBeNull();
    expect(successorOf(OLD, [a, replaced(NEW, NEWER), live(NEWER)])?.key).toBe(NEWER);
    expect(successorOf(OLD, [a, replaced(NEW, OLD)])).toBeNull(); // a loop is nobody's successor
    expect(successorOf(OTHER, [a, b])).toBeNull(); // not replaced
  });

  it('moves open tabs and remembered choices, once each, and leaves what the person opened as history', () => {
    const sessions = [replaced(OLD, NEW), live(NEW), live(OTHER)];
    expect(replacementMoves(model([OLD, OTHER]), { [IDS.gitManager]: OLD }, sessions)).toEqual([{ projectId: IDS.gitManager, from: OLD, to: NEW }]);
    expect(replacementMoves(model([OTHER]), { [IDS.gitManager]: OLD }, sessions)).toEqual([{ projectId: IDS.gitManager, from: OLD, to: NEW }]); // a remembered choice without a tab
    expect(replacementMoves(model([OLD]), {}, sessions, [OLD])).toEqual([]);
    expect(replacementMoves(model([OTHER]), {}, sessions)).toEqual([]);
    // a session someone assigned to another project in the meantime is not this project's to move to
    expect(replacementMoves(model([OLD]), {}, [replaced(OLD, NEW), live(NEW, { projectId: IDS.atlas })])).toEqual([]);
  });

  it('does not open a tab of its own for a session that went on as another one, even if it ended badly', () => {
    const old = { ...replaced(OLD, NEW), attention: { kind: 'abnormal_end' as const, since: null } };
    expect(withAutoTabs({ openTabs: {}, dismissed: [] }, [old]).openTabs).toEqual({});
    expect(withAutoTabs({ openTabs: {}, dismissed: [] }, [{ ...old, replacedBy: undefined }]).openTabs).toEqual({ [IDS.gitManager]: [OLD] });
  });
});
