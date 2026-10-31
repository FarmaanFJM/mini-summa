// What the window remembers, as plain functions: which facts changed, what is sent to the core, what is shown when the core
// remembers something, and the fallbacks for choices that no longer lead anywhere.
import type { Project, SessionKey, SessionView, UiPrefs } from '@minisumma/shared';
import { UI_LIMITS } from '@minisumma/shared';
import { describe, expect, it } from 'vitest';
import { buildPatch, changedRouteFacts, changedSetupFacts, cloudFact, conversationFact, forgetFact, reconcile, routeMemory, sessionFact, storedRouteMemory } from '../../src/renderer/src/app/uiState';
import type { Memory, RouteMemory } from '../../src/renderer/src/app/uiState';
import { pickConversation } from '../../src/renderer/src/features/workspace/ChatGptPane';
import { newestSession, pickSelectedTab } from '../../src/renderer/src/features/workspace/tabs';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';

const KEY_A = 'win|a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617' as SessionKey;
const KEY_B = 'win|b7c8d9e0-1f2a-4b3c-9d4e-5f6a7b8c9d0e' as SessionKey;
const GONE = 'win|ffffffff-0000-4000-8000-000000000000' as SessionKey;

// A page of Claude Code on the web, built from its parts: the publish guard refuses a literal session address, and these are made up.
const page = (segment: string, tail = ''): string => `https://claude.ai/code/${segment}${tail}`;
const SESSION_PAGE = page('session_abc123');
const OTHER_PAGE = page('session_xyz789');

const route = (over: Partial<RouteMemory> = {}): RouteMemory => ({ view: 'workspace', projectId: null, sessionByProject: {}, conversationByProject: {}, cloudUrlByProject: {}, ...over });
const memory = (r: Partial<RouteMemory> = {}, setup: Partial<Memory['setup']> = {}): Memory => ({ route: route(r), setup: { dismissed: false, seenEmpty: false, ...setup } });
const project = (id: string, over: Partial<Project> = {}): Project => ({ ...createSeed().projects[0], id, name: id, archivedAt: null, ...over });
const projects = [project('prj_a'), project('prj_b'), project('prj_archived', { archivedAt: '2026-01-01T00:00:00.000Z' })];
const noneTouched = new Set<string>();

describe('which remembered facts changed', () => {
  it('names the route when the view or the project changes, and each project\'s own choice', () => {
    const before = route({ projectId: 'prj_a', sessionByProject: { prj_a: KEY_A }, conversationByProject: { prj_a: 'cnv_1' } });
    expect(changedRouteFacts(before, before)).toEqual([]);
    expect(changedRouteFacts(before, { ...before, view: 'reports' })).toEqual(['route']);
    expect(changedRouteFacts(before, { ...before, projectId: 'prj_b' })).toEqual(['route']);
    expect(changedRouteFacts(before, { ...before, sessionByProject: { prj_a: KEY_B } })).toEqual([sessionFact('prj_a')]);
    expect(changedRouteFacts(before, { ...before, sessionByProject: { prj_a: KEY_A, prj_b: KEY_B } })).toEqual([sessionFact('prj_b')]);
    expect(changedRouteFacts(before, { ...before, conversationByProject: {} })).toEqual([conversationFact('prj_a')]);
    expect(changedRouteFacts(before, { ...before, sessionByProject: {}, conversationByProject: { prj_a: 'cnv_1', prj_b: 'cnv_2' } })).toEqual([sessionFact('prj_a'), conversationFact('prj_b')]);
  });

  it('names the project whose page of Claude Code on the web changed', () => {
    const before = route({ cloudUrlByProject: { prj_a: SESSION_PAGE } });
    expect(changedRouteFacts(before, before)).toEqual([]);
    expect(changedRouteFacts(before, { ...before, cloudUrlByProject: { prj_a: OTHER_PAGE } })).toEqual([cloudFact('prj_a')]);
    expect(changedRouteFacts(before, { ...before, cloudUrlByProject: { prj_a: SESSION_PAGE, prj_b: OTHER_PAGE } })).toEqual([cloudFact('prj_b')]);
    expect(changedRouteFacts(before, { ...before, cloudUrlByProject: {} })).toEqual([cloudFact('prj_a')]);
  });

  it('names the setup flags that changed', () => {
    expect(changedSetupFacts({ dismissed: false, seenEmpty: false }, { dismissed: false, seenEmpty: false })).toEqual([]);
    expect(changedSetupFacts({ dismissed: false, seenEmpty: false }, { dismissed: true, seenEmpty: true })).toEqual(['setup:dismissed', 'setup:seenEmpty']);
    expect(changedSetupFacts({ dismissed: true, seenEmpty: true }, { dismissed: false, seenEmpty: true })).toEqual(['setup:dismissed']);
  });
});

describe('what the window tells the core it is showing', () => {
  const stored = route({ projectId: 'prj_a', sessionByProject: { prj_a: KEY_A, prj_b: KEY_B }, cloudUrlByProject: { prj_a: SESSION_PAGE } });

  it('names no session for a project whose Cloud tab is shown, and keeps the others', () => {
    const memoryOf = routeMemory({ ...stored, cloudShown: { prj_a: true } });
    expect(memoryOf.sessionByProject).toEqual({ prj_b: KEY_B });
    expect(memoryOf.cloudUrlByProject).toEqual({ prj_a: SESSION_PAGE }); // the page is a fact of its own
    expect(stored.sessionByProject).toEqual({ prj_a: KEY_A, prj_b: KEY_B }); // what the store holds is not touched
  });

  it('is the store\'s own copy when no Cloud tab is shown, or when it is shown for a project with no session', () => {
    expect(routeMemory({ ...stored, cloudShown: {} }).sessionByProject).toBe(stored.sessionByProject);
    expect(routeMemory(stored).sessionByProject).toBe(stored.sessionByProject);
    expect(routeMemory({ ...stored, cloudShown: { prj_other: true } }).sessionByProject).toBe(stored.sessionByProject);
  });

  it('still has the stored copy for the window itself', () => {
    expect(storedRouteMemory({ ...stored, cloudShown: { prj_a: true } } as RouteMemory).sessionByProject).toEqual({ prj_a: KEY_A, prj_b: KEY_B });
  });

  it('turns showing the Cloud tab into a change of that project\'s session, and going back into the change back', () => {
    const local = routeMemory({ ...stored, cloudShown: {} });
    const cloud = routeMemory({ ...stored, cloudShown: { prj_a: true } });
    expect(changedRouteFacts(local, cloud)).toEqual([sessionFact('prj_a')]);
    expect(buildPatch([sessionFact('prj_a')], { route: cloud, setup: { dismissed: false, seenEmpty: false } }).patch).toEqual({ perProject: { prj_a: { sessionKey: null } } });
    expect(changedRouteFacts(cloud, local)).toEqual([sessionFact('prj_a')]);
    expect(buildPatch([sessionFact('prj_a')], { route: local, setup: { dismissed: false, seenEmpty: false } }).patch).toEqual({ perProject: { prj_a: { sessionKey: KEY_A } } });
  });

  it('says nothing for a Cloud tab that is shown for a project that had no session to forget', () => {
    const before = routeMemory({ ...stored, cloudShown: {} });
    const after = routeMemory({ ...stored, cloudShown: { prj_without: true } });
    expect(changedRouteFacts(before, after)).toEqual([]);
  });
});

describe('what is sent to the core', () => {
  it('names only the facts that changed, with the values they have now', () => {
    const now = memory({ view: 'reports', projectId: 'prj_b', sessionByProject: { prj_a: KEY_A, prj_b: KEY_B }, conversationByProject: { prj_a: 'cnv_1' } }, { dismissed: true });
    expect(buildPatch(['route'], now).patch).toEqual({ route: { projectId: 'prj_b', view: 'reports' } });
    expect(buildPatch([sessionFact('prj_b')], now).patch).toEqual({ perProject: { prj_b: { sessionKey: KEY_B } } });
    expect(buildPatch([sessionFact('prj_a'), conversationFact('prj_a'), 'setup:dismissed'], now).patch)
      .toEqual({ perProject: { prj_a: { sessionKey: KEY_A, conversationId: 'cnv_1' } }, setup: { dismissed: true } });
  });

  it('sends the page of Claude Code on the web with the project\'s other choices, and null when it was forgotten', () => {
    const now = memory({ sessionByProject: { prj_a: KEY_A }, cloudUrlByProject: { prj_a: SESSION_PAGE } });
    expect(buildPatch([cloudFact('prj_a')], now).patch).toEqual({ perProject: { prj_a: { cloudUrl: SESSION_PAGE } } });
    expect(buildPatch([sessionFact('prj_a'), cloudFact('prj_a')], now).patch).toEqual({ perProject: { prj_a: { sessionKey: KEY_A, cloudUrl: SESSION_PAGE } } });
    expect(buildPatch([cloudFact('prj_b')], now).patch).toEqual({ perProject: { prj_b: { cloudUrl: null } } });
  });

  it('leaves out an address that is not a page of Claude Code on the web, instead of sending what the core would refuse', () => {
    const now = memory({ cloudUrlByProject: { prj_a: 'https://example.com/code/session_x', prj_b: page('a'.repeat(UI_LIMITS.urlChars)), prj_c: SESSION_PAGE } });
    const built = buildPatch([cloudFact('prj_a'), cloudFact('prj_b'), cloudFact('prj_c')], now);
    expect(built.patch.perProject?.prj_c).toEqual({ cloudUrl: SESSION_PAGE });
    expect(built.patch.perProject?.prj_a?.cloudUrl).toBeUndefined();
    expect(built.patch.perProject?.prj_b?.cloudUrl).toBeUndefined();
    expect(built.included.size).toBe(3); // the two that can never be accepted do not wait for ever
  });

  it('says null for a choice that was cleared, and forgets a removed project whole', () => {
    const now = memory({ sessionByProject: { prj_a: KEY_A } });
    expect(buildPatch([sessionFact('prj_b'), conversationFact('prj_a')], now).patch).toEqual({ perProject: { prj_b: { sessionKey: null }, prj_a: { conversationId: null } } });
    expect(buildPatch([forgetFact('prj_gone')], now).patch).toEqual({ perProject: { prj_gone: null } });
    // Forgetting wins over a choice named for the same project in the same change.
    expect(buildPatch([forgetFact('prj_a'), sessionFact('prj_a')], now).patch).toEqual({ perProject: { prj_a: null } });
  });

  it('leaves out what the core would refuse, so one bad value cannot hold up the rest', () => {
    const longId = 'p'.repeat(UI_LIMITS.idChars + 1);
    const now = memory({ view: 'settings', projectId: 'prj_a', conversationByProject: { [longId]: 'cnv_1', prj_a: 'c'.repeat(UI_LIMITS.idChars + 1) }, sessionByProject: { prj_a: KEY_A } });
    const built = buildPatch(['route', conversationFact(longId), conversationFact('prj_a'), sessionFact('prj_a')], now);
    expect(built.patch).toEqual({ route: { projectId: 'prj_a', view: 'settings' }, perProject: { prj_a: { sessionKey: KEY_A } } });
    expect([...built.included].sort()).toEqual([conversationFact('prj_a'), conversationFact(longId), 'route', sessionFact('prj_a')].sort()); // none of them waits for ever
  });

  it('never names more projects than the core keeps in one change; the rest wait', () => {
    const ids = Array.from({ length: UI_LIMITS.projects + 5 }, (_, i) => `prj_${i}`);
    const now = memory({ sessionByProject: Object.fromEntries(ids.map((id) => [id, KEY_A])) });
    const built = buildPatch(ids.map(sessionFact), now);
    expect(Object.keys(built.patch.perProject ?? {})).toHaveLength(UI_LIMITS.projects);
    expect(built.included.size).toBe(UI_LIMITS.projects);
    expect(built.included.has(sessionFact(ids.at(-1)!))).toBe(false);
  });

  it('ignores a fact this build does not know', () => {
    const built = buildPatch(['mystery:1', 'route'], memory({ projectId: 'prj_a' }));
    expect([...built.included]).toEqual(['route']);
  });
});

describe('what is shown when the core remembers something', () => {
  const remembered: UiPrefs = {
    route: { projectId: 'prj_b', view: 'reports' },
    perProject: { prj_a: { sessionKey: KEY_A, conversationId: 'cnv_1' }, prj_b: { conversationId: 'cnv_2' } },
    setup: { dismissed: true, seenEmpty: true },
  };

  it('uses the core\'s copy when the window has none (the origin changed)', () => {
    const result = reconcile(memory(), remembered, { projects, touched: noneTouched });
    expect(result.route).toEqual({
      view: 'reports', projectId: 'prj_b',
      sessionByProject: { prj_a: KEY_A }, conversationByProject: { prj_a: 'cnv_1', prj_b: 'cnv_2' },
    });
    expect(result.setup).toEqual({ dismissed: true, seenEmpty: true });
    expect(result.seed).toEqual([]);
  });

  it('lets the core win when both have a value, field by field', () => {
    const local = memory({ view: 'workspace', projectId: 'prj_a', sessionByProject: { prj_a: KEY_B }, conversationByProject: { prj_a: 'cnv_local' } }, { dismissed: false, seenEmpty: true });
    const result = reconcile(local, remembered, { projects, touched: noneTouched });
    expect(result.route.projectId).toBe('prj_b');
    expect(result.route.sessionByProject).toEqual({ prj_a: KEY_A });
    expect(result.route.conversationByProject).toEqual({ prj_a: 'cnv_1', prj_b: 'cnv_2' });
    expect(result.setup).toEqual({ dismissed: true }); // seenEmpty already agrees
  });

  it('keeps what the person changed in this run, even though the core says otherwise', () => {
    const local = memory({ view: 'activity', projectId: 'prj_a', sessionByProject: { prj_a: KEY_B } });
    const result = reconcile(local, remembered, { projects, touched: new Set(['route', sessionFact('prj_a'), 'setup:dismissed']) });
    expect(result.route.view).toBeUndefined();
    expect(result.route.projectId).toBeUndefined();
    expect(result.route.sessionByProject).toBeUndefined();
    expect(result.route.conversationByProject).toEqual({ prj_a: 'cnv_1', prj_b: 'cnv_2' });
    expect(result.setup).toEqual({ seenEmpty: true });
  });

  it('falls back when the remembered project is gone or archived: the window\'s own project if that exists, else none (the first project)', () => {
    const goneInCore: UiPrefs = { route: { projectId: 'prj_deleted', view: 'workspace' } };
    expect(reconcile(memory(), goneInCore, { projects, touched: noneTouched }).route.projectId).toBeUndefined(); // already none: nothing to set
    const withLocal = reconcile(memory({ projectId: 'prj_a' }), goneInCore, { projects, touched: noneTouched });
    expect(withLocal.route.projectId).toBeUndefined(); // the window's own valid project is kept
    expect(withLocal.seed).toEqual(['route']); // and the core is told where the window really is
    const archived = reconcile(memory({ projectId: 'prj_b' }), { route: { projectId: 'prj_archived', view: 'workspace' } }, { projects, touched: noneTouched });
    expect(archived.route.projectId).toBeUndefined();
    const nowhere = reconcile(memory({ projectId: 'prj_deleted_too' }), goneInCore, { projects, touched: noneTouched });
    expect(nowhere.route.projectId).toBeNull();
  });

  it('sends the window\'s own copy when the core has none (an upgrade), for projects that exist', () => {
    const local = memory({ view: 'reports', projectId: 'prj_a', sessionByProject: { prj_a: KEY_A, prj_deleted: KEY_B }, conversationByProject: { prj_b: 'cnv_2' } }, { dismissed: true, seenEmpty: true });
    const result = reconcile(local, undefined, { projects, touched: noneTouched });
    expect(result.route).toEqual({});
    expect(result.setup).toEqual({});
    expect(result.seed.sort()).toEqual(['route', conversationFact('prj_b'), sessionFact('prj_a'), 'setup:dismissed', 'setup:seenEmpty'].sort());
    expect(result.seed).not.toContain(sessionFact('prj_deleted'));
  });

  it('does nothing on a first run with nothing stored anywhere', () => {
    expect(reconcile(memory(), undefined, { projects, touched: noneTouched })).toEqual({ route: {}, setup: {}, seed: [] });
    expect(reconcile(memory(), {}, { projects: [], touched: noneTouched })).toEqual({ route: {}, setup: {}, seed: [] });
  });

  it('does not seed what the core already has, or a flag that is false', () => {
    const local = memory({ projectId: 'prj_a', sessionByProject: { prj_a: KEY_A } }, { dismissed: false, seenEmpty: false });
    const result = reconcile(local, { route: { projectId: 'prj_a', view: 'workspace' }, perProject: { prj_a: { sessionKey: KEY_A } } }, { projects, touched: noneTouched });
    expect(result).toEqual({ route: {}, setup: {}, seed: [] });
  });

  it('shows the page of Claude Code on the web the core remembers, and keeps the one the person went to in this run', () => {
    const asked: UiPrefs = { perProject: { prj_a: { cloudUrl: SESSION_PAGE }, prj_b: { cloudUrl: OTHER_PAGE } } };
    expect(reconcile(memory(), asked, { projects, touched: noneTouched }).route.cloudUrlByProject).toEqual({ prj_a: SESSION_PAGE, prj_b: OTHER_PAGE });
    const local = memory({ cloudUrlByProject: { prj_a: OTHER_PAGE } });
    expect(reconcile(local, asked, { projects, touched: noneTouched }).route.cloudUrlByProject).toEqual({ prj_a: SESSION_PAGE, prj_b: OTHER_PAGE }); // the core wins
    expect(reconcile(local, asked, { projects, touched: new Set([cloudFact('prj_a')]) }).route.cloudUrlByProject).toEqual({ prj_a: OTHER_PAGE, prj_b: OTHER_PAGE }); // this run wins
    expect(reconcile(memory({ cloudUrlByProject: { prj_a: SESSION_PAGE, prj_b: OTHER_PAGE } }), asked, { projects, touched: noneTouched }).route.cloudUrlByProject).toBeUndefined(); // already agrees
  });

  it('sends the page of Claude Code on the web only the window has, for projects that exist', () => {
    const local = memory({ cloudUrlByProject: { prj_a: SESSION_PAGE, prj_deleted: OTHER_PAGE } });
    expect(reconcile(local, undefined, { projects, touched: noneTouched }).seed).toEqual([cloudFact('prj_a')]);
    expect(reconcile(local, { perProject: { prj_a: { cloudUrl: SESSION_PAGE } } }, { projects, touched: noneTouched }).seed).toEqual([]);
    expect(reconcile(local, undefined, { projects, touched: new Set([cloudFact('prj_a')]) }).seed).toEqual([]);
  });

  it('takes a session key or a conversation id that is gone as it is; the places that use them fall back (below)', () => {
    const result = reconcile(memory(), { perProject: { prj_a: { sessionKey: GONE, conversationId: 'cnv_gone' } } }, { projects, touched: noneTouched });
    expect(result.route.sessionByProject).toEqual({ prj_a: GONE });
    expect(result.route.conversationByProject).toEqual({ prj_a: 'cnv_gone' });
  });
});

describe('a session tab or a conversation that is gone', () => {
  const seed = createSeed();
  const gm = seed.sessions.filter((s) => s.projectId === IDS.gitManager && s.origin === 'managed' && s.availability === 'live');
  const withStart = (s: SessionView, startedAt: string): SessionView => ({ ...s, startedAt });

  it('shows the chosen session when its tab is there', () => {
    expect(pickSelectedTab(gm, gm[1].key, seed.sessions)?.key).toBe(gm[1].key);
  });

  it('shows the newest session when the chosen one no longer exists anywhere', () => {
    const older = withStart(gm[0], '2026-10-30T10:00:00.000Z');
    const newer = withStart(gm[1], '2026-10-30T12:00:00.000Z');
    expect(pickSelectedTab([older, newer], GONE, seed.sessions)?.key).toBe(newer.key);
    expect(pickSelectedTab([newer, older], GONE, seed.sessions)?.key).toBe(newer.key);
    expect(newestSession([older, newer])?.key).toBe(newer.key);
    expect(newestSession([])).toBeUndefined();
  });

  it('shows the first tab, as always, when nothing was chosen, or when the chosen session exists but has no tab yet', () => {
    expect(pickSelectedTab(gm, undefined, seed.sessions)?.key).toBe(gm[0].key);
    const hidden = seed.sessions.find((s) => s.projectId === IDS.gitManager && s.origin === 'external')!;
    expect(pickSelectedTab(gm, hidden.key, seed.sessions)?.key).toBe(gm[0].key);
    expect(pickSelectedTab([], GONE, seed.sessions)).toBeNull();
  });

  it('shows the preferred conversation when the remembered one was removed', () => {
    const data = createSeed();
    const gmProject = data.projects.find((p) => p.id === IDS.gitManager)!;
    const list = data.conversations.filter((c) => c.projectId === IDS.gitManager);
    expect(pickConversation(list, gmProject, 'cnv_removed')?.id).toBe(IDS.c.gmRelease);
    expect(pickConversation(list, gmProject, IDS.c.gmReview)?.id).toBe(IDS.c.gmReview);
    expect(pickConversation(list, { preferredConversationId: null }, 'cnv_removed')?.id).toBe(list[0].id);
    expect(pickConversation([], gmProject, 'cnv_removed')).toBeNull();
  });
});
