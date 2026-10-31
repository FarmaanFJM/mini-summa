// The last ChatGPT page of each project in the window's memory: the route store, the facts that go to the core, and the core's copy
// coming back (a restart).
import { describe, expect, it } from 'vitest';
import type { Project } from '@minisumma/shared';
import { createRouteStore } from '../../src/renderer/src/app/route';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import { buildPatch, changedRouteFacts, chatgptFact, reconcile, routeMemory } from '../../src/renderer/src/app/uiState';
import type { Memory, RouteMemory } from '../../src/renderer/src/app/uiState';
import { createSeed } from '../../src/renderer/src/dev/demo/seed';

const A = 'https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-alpha/c/11111111-1111-4111-8111-111111111111';
const B = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const route = (over: Partial<RouteMemory> = {}): RouteMemory => ({ view: 'workspace', projectId: null, sessionByProject: {}, conversationByProject: {}, cloudUrlByProject: {}, chatgptUrlByProject: {}, ...over });
const memory = (r: Partial<RouteMemory> = {}): Memory => ({ route: route(r), setup: { dismissed: false, seenEmpty: false } });
const project = (id: string): Project => ({ ...createSeed().projects[0], id, name: id, archivedAt: null });

describe('the route store', () => {
  it('keeps a page per project, in its plain form, and forgets it with null', () => {
    const store = createRouteStore();
    store.getState().selectChatGptUrl('prj_a', `${A}?x=1#y`);
    store.getState().selectChatGptUrl('prj_b', B);
    expect(store.getState().chatgptUrlByProject).toEqual({ prj_a: A, prj_b: B });
    store.getState().selectChatGptUrl('prj_a', null);
    expect(store.getState().chatgptUrlByProject).toEqual({ prj_b: B });
  });

  it('ignores a page that is not a conversation or a project page, and a repeat', () => {
    const store = createRouteStore();
    store.getState().selectChatGptUrl('prj_a', A);
    const before = store.getState().chatgptUrlByProject;
    for (const bad of ['https://chatgpt.com/', 'https://example.com/c/22222222-2222-4222-8222-222222222222', 'javascript:1', '']) store.getState().selectChatGptUrl('prj_a', bad);
    store.getState().selectChatGptUrl('prj_a', A);
    expect(store.getState().chatgptUrlByProject).toBe(before);
  });

  it('is stored locally and read back, and what is stored that is no longer a page to remember is dropped', () => {
    const storage = createMemoryStorage();
    createRouteStore({ storage }).getState().selectChatGptUrl('prj_a', A);
    expect(createRouteStore({ storage }).getState().chatgptUrlByProject).toEqual({ prj_a: A });
    storage.setItem('minisumma.route.v1', JSON.stringify({ chatgptUrlByProject: { prj_a: A, prj_b: 'https://chatgpt.com/', prj_c: 5 } }));
    expect(createRouteStore({ storage }).getState().chatgptUrlByProject).toEqual({ prj_a: A });
  });
});

describe('what goes to the core', () => {
  it('names the project whose page changed, and sends its address with the same patch shape as the other choices', () => {
    const before = route();
    const after = route({ chatgptUrlByProject: { prj_a: A } });
    expect(changedRouteFacts(before, after)).toEqual([chatgptFact('prj_a')]);
    expect(changedRouteFacts(after, route({ chatgptUrlByProject: {} }))).toEqual([chatgptFact('prj_a')]);
    expect(buildPatch([chatgptFact('prj_a')], memory({ chatgptUrlByProject: { prj_a: A } })).patch).toEqual({ perProject: { prj_a: { chatgptUrl: A } } });
    expect(buildPatch([chatgptFact('prj_a')], memory()).patch).toEqual({ perProject: { prj_a: { chatgptUrl: null } } });
  });

  it('is part of the route the window tells the core about', () => {
    expect(routeMemory({ ...route({ chatgptUrlByProject: { prj_a: A } }) }).chatgptUrlByProject).toEqual({ prj_a: A });
  });
});

describe('the core\'s copy coming back', () => {
  it('restores the page of each project, keeps a page changed in this run, and seeds the core with a page only the window has', () => {
    const projects = [project('prj_a'), project('prj_b')];
    const restored = reconcile(memory(), { perProject: { prj_a: { chatgptUrl: A }, prj_b: { chatgptUrl: B } } }, { projects, touched: new Set() });
    expect(restored.route.chatgptUrlByProject).toEqual({ prj_a: A, prj_b: B });
    const touched = reconcile(memory({ chatgptUrlByProject: { prj_a: B } }), { perProject: { prj_a: { chatgptUrl: A } } }, { projects, touched: new Set([chatgptFact('prj_a')]) });
    expect(touched.route.chatgptUrlByProject).toBeUndefined();
    const seeded = reconcile(memory({ chatgptUrlByProject: { prj_a: A } }), undefined, { projects, touched: new Set() });
    expect(seeded.seed).toContain(chatgptFact('prj_a'));
  });
});
