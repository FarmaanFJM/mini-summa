import type { SessionKey } from '@minisumma/shared';
import { describe, expect, it } from 'vitest';
import { chooseClient } from '../../src/renderer/src/app/clientChoice';
import { createRouteStore } from '../../src/renderer/src/app/route';
import { createMemoryStorage } from '../../src/renderer/src/app/storage';
import type { KeyValueStorage } from '../../src/renderer/src/app/storage';

const KEY = 'win|a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617' as SessionKey;

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
