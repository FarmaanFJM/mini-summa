import type { SessionKey } from '@minisumma/shared';
import { describe, expect, it } from 'vitest';
import { chooseClient } from '../../src/renderer/src/app/clientChoice';
import { createRouteStore } from '../../src/renderer/src/app/route';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import type { KeyValueStorage } from '../../src/renderer/src/app/storage';

const KEY = 'win|a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617' as SessionKey;
const OTHER_KEY = 'win|b7c8d9e0-1f2a-4b3c-9d4e-5f6a7b8c9d0e' as SessionKey;
// Pages of Claude Code on the web, built from their parts and made up: the publish guard refuses a literal session address.
const page = (segment: string, tail = ''): string => `https://claude.ai/code/${segment}${tail}`;
const SESSION_PAGE = page('session_abc123');

describe('choosing a client', () => {
  const loc = (over: Partial<{ hash: string; search: string; origin: string }> = {}) => ({ hash: '', search: '', origin: 'http://127.0.0.1:4100', ...over });

  it('uses the desktop shell whenever window.miniSumma exists', () => {
    expect(chooseClient({ hasDesktopShell: true, location: loc({ search: '?demo=1' }) })).toEqual({ kind: 'electron' });
  });

  it('uses the demo for ?demo=1, with an optional scenario', () => {
    expect(chooseClient({ hasDesktopShell: false, location: loc({ search: '?demo=1' }) })).toEqual({ kind: 'demo', scenario: 'normal', simulateNative: true });
    expect(chooseClient({ hasDesktopShell: false, location: loc({ search: '?demo=1&scenario=offline&native=none' }) })).toEqual({ kind: 'demo', scenario: 'offline', simulateNative: false });
    expect(chooseClient({ hasDesktopShell: false, location: loc({ search: '?demo=1&scenario=bogus' }) })).toMatchObject({ scenario: 'normal' });
  });

  it('reads the core address and token from the URL hash', () => {
    expect(chooseClient({ hasDesktopShell: false, location: loc({ hash: '#base=http://127.0.0.1:5000/&token=abc' }) }))
      .toEqual({ kind: 'remote', baseUrl: 'http://127.0.0.1:5000', token: 'abc' });
  });

  it('defaults the address to the page origin, as when the core serves the UI itself', () => {
    expect(chooseClient({ hasDesktopShell: false, location: loc({ hash: '#token=abc' }) })).toEqual({ kind: 'remote', baseUrl: 'http://127.0.0.1:4100', token: 'abc' });
  });

  it('refuses a base that is not a web address, and says what to do when nothing is configured', () => {
    const bad = chooseClient({ hasDesktopShell: false, location: loc({ hash: '#base=javascript:alert(1)&token=abc' }) });
    expect(bad.kind).toBe('unconfigured');
    const none = chooseClient({ hasDesktopShell: false, location: loc() });
    expect(none).toMatchObject({ kind: 'unconfigured' });
    if (none.kind === 'unconfigured') expect(none.reason).toContain('desktop app');
  });
});

describe('route store', () => {
  it('starts on the workspace with nothing selected', () => {
    const route = createRouteStore();
    expect(route.getState()).toMatchObject({ view: 'workspace', projectId: null, reportId: null });
  });

  it('selecting a project returns to the workspace and keeps each project\'s own session choice', () => {
    const route = createRouteStore();
    route.getState().setView('settings');
    route.getState().selectProject('prj_a');
    expect(route.getState()).toMatchObject({ view: 'workspace', projectId: 'prj_a' });
    route.getState().selectSession('prj_a', KEY);
    route.getState().selectProject('prj_b');
    route.getState().selectProject('prj_a');
    expect(route.getState().sessionByProject.prj_a).toBe(KEY);
    expect(route.getState().sessionByProject.prj_b).toBeUndefined();
  });

  it('applies a navigation target: view, project, session, report', () => {
    const route = createRouteStore({ resolveSessionProject: (k) => (k === KEY ? 'prj_gm' : null) });
    route.getState().go({ view: 'workspace', sessionKey: KEY });
    expect(route.getState()).toMatchObject({ view: 'workspace', projectId: 'prj_gm' });
    expect(route.getState().sessionByProject.prj_gm).toBe(KEY);
    route.getState().go({ view: 'reports', reportId: 'rpt_1', deliveryId: 'dlv_1' });
    expect(route.getState()).toMatchObject({ view: 'reports', reportId: 'rpt_1', deliveryId: 'dlv_1', projectId: 'prj_gm' });
    route.getState().go({ view: 'settings', section: 'Phone' });
    expect(route.getState()).toMatchObject({ view: 'settings', section: 'Phone', reportId: null });
  });

  it('back returns to the view before, and to the workspace when there is none', () => {
    const route = createRouteStore();
    route.getState().setView('activity');
    route.getState().setView('settings');
    route.getState().back();
    expect(route.getState().view).toBe('activity');
    route.getState().back();
    expect(route.getState().view).toBe('workspace');
    route.getState().back();
    expect(route.getState().view).toBe('workspace');
  });

  it('remembers the last selection and restores it', () => {
    const storage = createMemoryStorage();
    const first = createRouteStore({ storage });
    first.getState().selectProject('prj_a');
    first.getState().selectSession('prj_a', KEY);
    first.getState().selectConversation('prj_a', 'cnv_2');
    first.getState().setView('reports');
    const second = createRouteStore({ storage });
    expect(second.getState()).toMatchObject({ view: 'reports', projectId: 'prj_a', sessionByProject: { prj_a: KEY }, conversationByProject: { prj_a: 'cnv_2' } });
  });

  it('survives storage that throws, is full, or holds rubbish', () => {
    const throwing: KeyValueStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('full'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const route = createRouteStore({ storage: throwing });
    expect(() => route.getState().selectProject('prj_a')).not.toThrow();
    const rubbish = createMemoryStorage({ 'minisumma.route.v1': '{"view":"nowhere","projectId":7,"sessionByProject":{"p":"not-a-key"}}' });
    const restored = createRouteStore({ storage: rubbish });
    expect(restored.getState()).toMatchObject({ view: 'workspace', projectId: null, sessionByProject: {} });
    const notJson = createRouteStore({ storage: createMemoryStorage({ 'minisumma.route.v1': '{{{' }) });
    expect(notJson.getState().view).toBe('workspace');
  });
});

describe('the page of Claude Code on the web, per project', () => {
  it('remembers an address on claude.ai/code in its plain form, one per project', () => {
    const route = createRouteStore();
    route.getState().selectCloudUrl('prj_a', page('session_abc123', '?utm=1#top'));
    route.getState().selectCloudUrl('prj_b', 'claude.ai/code');
    expect(route.getState().cloudUrlByProject).toEqual({ prj_a: SESSION_PAGE, prj_b: 'https://claude.ai/code' });
  });

  it('refuses what is not a page of Claude Code on the web, and keeps what it had', () => {
    const route = createRouteStore();
    route.getState().selectCloudUrl('prj_a', SESSION_PAGE);
    for (const bad of ['https://example.com/code/session_abc123', 'https://claude.ai/login', 'http://claude.ai/code', 'https://x@claude.ai/code', '', 'nonsense']) {
      route.getState().selectCloudUrl('prj_a', bad);
      expect(route.getState().cloudUrlByProject).toEqual({ prj_a: SESSION_PAGE });
    }
  });

  it('forgets a page with null, and does not change the state when nothing changes', () => {
    const route = createRouteStore();
    route.getState().selectCloudUrl('prj_a', SESSION_PAGE);
    const before = route.getState().cloudUrlByProject;
    route.getState().selectCloudUrl('prj_a', SESSION_PAGE);
    expect(route.getState().cloudUrlByProject).toBe(before);
    route.getState().selectCloudUrl('prj_a', null);
    expect(route.getState().cloudUrlByProject).toEqual({});
    const empty = route.getState().cloudUrlByProject;
    route.getState().selectCloudUrl('prj_a', null);
    expect(route.getState().cloudUrlByProject).toBe(empty);
  });

  it('is kept by the window and restored, and what is stored that is not such a page is dropped', () => {
    const storage = createMemoryStorage();
    const first = createRouteStore({ storage });
    first.getState().selectCloudUrl('prj_a', SESSION_PAGE);
    expect(createRouteStore({ storage }).getState().cloudUrlByProject).toEqual({ prj_a: SESSION_PAGE });
    const rubbish = createMemoryStorage({ 'minisumma.route.v1': JSON.stringify({ cloudUrlByProject: { prj_a: SESSION_PAGE, prj_b: 'https://example.com/code', prj_c: 7, prj_d: `${page('x')}${'y'.repeat(700)}` } }) });
    expect(createRouteStore({ storage: rubbish }).getState().cloudUrlByProject).toEqual({ prj_a: SESSION_PAGE });
  });
});

describe('which tab of the Claude pane a project shows, in memory only', () => {
  it('shows the Cloud tab for the project it was chosen for, and only that one', () => {
    const route = createRouteStore();
    route.getState().showCloud('prj_a');
    expect(route.getState().cloudShown).toEqual({ prj_a: true });
    route.getState().selectProject('prj_b');
    expect(route.getState().cloudShown).toEqual({ prj_a: true }); // choosing another project changes nothing here
    route.getState().hideCloud('prj_a');
    expect(route.getState().cloudShown).toEqual({});
  });

  it('asks for the start page of a new session once: it stays until the tab has opened it', () => {
    const route = createRouteStore();
    route.getState().showCloud('prj_a');
    expect(route.getState().cloudStart).toEqual({});
    route.getState().showCloud('prj_a', { start: true });
    expect(route.getState().cloudStart).toEqual({ prj_a: true });
    route.getState().finishCloudStart('prj_a');
    expect(route.getState().cloudStart).toEqual({});
    route.getState().finishCloudStart('prj_a');
    expect(route.getState().cloudStart).toEqual({});
  });

  it('goes back to the sessions when a session is chosen for the project, and keeps the last local choice for it', () => {
    const route = createRouteStore();
    route.getState().selectSession('prj_a', KEY);
    route.getState().showCloud('prj_a');
    route.getState().showCloud('prj_b');
    expect(route.getState().sessionByProject.prj_a).toBe(KEY); // showing the Cloud tab forgets nothing
    route.getState().selectSession('prj_a', OTHER_KEY);
    expect(route.getState().cloudShown).toEqual({ prj_b: true });
    route.getState().showCloud('prj_a');
    route.getState().selectSession('prj_a', null); // the last tab was closed: that does not choose a session
    expect(route.getState().cloudShown).toEqual({ prj_a: true, prj_b: true });
  });

  it('goes back to the sessions for the session a navigation target names, found from the session when it names no project', () => {
    const route = createRouteStore({ resolveSessionProject: (k) => (k === KEY ? 'prj_a' : null) });
    route.getState().showCloud('prj_a');
    route.getState().showCloud('prj_b');
    route.getState().go({ view: 'reports', reportId: 'rpt_1' }); // not a session
    expect(route.getState().cloudShown).toEqual({ prj_a: true, prj_b: true });
    route.getState().go({ view: 'workspace', sessionKey: KEY });
    expect(route.getState().cloudShown).toEqual({ prj_b: true });
    route.getState().showCloud('prj_a');
    route.getState().go({ view: 'workspace', projectId: 'prj_b', sessionKey: OTHER_KEY });
    expect(route.getState().cloudShown).toEqual({ prj_a: true });
  });

  it('is not written to the window\'s storage, so a restart shows the last local session again', () => {
    const storage = createMemoryStorage();
    const first = createRouteStore({ storage });
    first.getState().selectSession('prj_a', KEY);
    first.getState().showCloud('prj_a', { start: true });
    expect(JSON.parse(storage.getItem('minisumma.route.v1') ?? '{}')).not.toHaveProperty('cloudShown');
    expect(JSON.parse(storage.getItem('minisumma.route.v1') ?? '{}')).not.toHaveProperty('cloudStart');
    const second = createRouteStore({ storage });
    expect(second.getState()).toMatchObject({ sessionByProject: { prj_a: KEY }, cloudShown: {}, cloudStart: {} });
  });
});
