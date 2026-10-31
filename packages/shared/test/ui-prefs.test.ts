// What the desktop window remembers between runs (`Settings.ui`): how a change is read, how it is applied, and what bounds it.
import { describe, expect, it } from 'vitest';
import {
  checkUiPatch, defaultSettings, isEmptyUi, mergeSettings, mergeUi, sanitizeStoredUi, settingsPatchSchema, UI_LIMITS, UI_VIEWS,
} from '../src/index.ts';
import type { SessionKey, UiPrefs, UiPrefsPatch } from '../src/index.ts';

const KEY_A = 'win|a1b2c3d4-5e6f-4a70-8b91-c2d3e4f50617' as SessionKey;
const KEY_B = 'wsl:Ubuntu|e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7' as SessionKey;

describe('reading a change (checkUiPatch)', () => {
  it('accepts every part, and null to forget one', () => {
    const input = {
      route: { projectId: 'prj_a', view: 'reports' },
      perProject: { prj_a: { sessionKey: KEY_A, conversationId: 'cnv_1' }, prj_b: { sessionKey: null }, prj_gone: null },
      setup: { dismissed: true, seenEmpty: null },
    };
    expect(checkUiPatch(input)).toEqual({ patch: input, problems: [] });
    expect(checkUiPatch({ route: null }).patch).toEqual({ route: null });
    expect(checkUiPatch({ route: { projectId: null, view: 'workspace' } }).problems).toEqual([]);
  });

  it('refuses a key it does not know, at every level, and says which', () => {
    const problems = (input: unknown) => checkUiPatch(input).problems.map((p) => p.field);
    expect(problems({ theme: 'dark' })).toEqual(['ui.theme']);
    expect(problems({ route: { projectId: null, view: 'workspace', zoom: 2 } })).toEqual(['ui.route.zoom']);
    expect(problems({ perProject: { prj_a: { sessionKey: KEY_A, scroll: 3 } } })).toEqual(['ui.perProject.prj_a.scroll']);
    expect(problems({ setup: { dismissed: true, mood: 'good' } })).toEqual(['ui.setup.mood']);
  });

  it('refuses values of the wrong kind, with a sentence that says what to send', () => {
    const cases: [unknown, string][] = [
      ['route', 'ui'], // not an object at all
      [{ route: 'workspace' }, 'ui.route'],
      [{ route: { projectId: 7, view: 'workspace' } }, 'ui.route.projectId'],
      [{ route: { projectId: 'p'.repeat(UI_LIMITS.idChars + 1), view: 'workspace' } }, 'ui.route.projectId'],
      [{ route: { projectId: 'prj_a', view: 'elsewhere' } }, 'ui.route.view'],
      [{ route: { projectId: 'prj_a' } }, 'ui.route.view'],
      [{ perProject: [] }, 'ui.perProject'],
      [{ perProject: { prj_a: 'win|x' } }, 'ui.perProject.prj_a'],
      [{ perProject: { prj_a: { sessionKey: 'not-a-key' } } }, 'ui.perProject.prj_a.sessionKey'],
      [{ perProject: { prj_a: { sessionKey: `win|${'x'.repeat(UI_LIMITS.keyChars)}` } } }, 'ui.perProject.prj_a.sessionKey'],
      [{ perProject: { prj_a: { conversationId: '' } } }, 'ui.perProject.prj_a.conversationId'],
      [{ setup: { dismissed: 'yes' } }, 'ui.setup.dismissed'],
      [{ setup: 'done' }, 'ui.setup'],
    ];
    for (const [input, field] of cases) {
      const { problems } = checkUiPatch(input);
      expect(problems.map((p) => p.field), JSON.stringify(input)).toContain(field);
      expect(problems[0].message.length).toBeGreaterThan(20);
      expect(problems[0].message).not.toMatch(/[–—]/); // plain text: no em or en dashes
    }
  });

  it('refuses ids that would change the object they become a key of', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      const input = JSON.parse(`{"perProject":{"${id}":{"conversationId":"cnv_1"}}}`) as unknown;
      expect(checkUiPatch(input).problems.length, id).toBeGreaterThan(0);
      expect(mergeUi(undefined, checkUiPatch(input).patch).perProject).toBeUndefined();
    }
  });

  it('is bounded: more projects than it keeps is refused, not cut', () => {
    const many = Object.fromEntries(Array.from({ length: UI_LIMITS.projects + 1 }, (_, i) => [`prj_${i}`, { conversationId: 'cnv_1' }]));
    const { problems } = checkUiPatch({ perProject: many });
    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe('ui.perProject');
    const exactly = Object.fromEntries(Array.from({ length: UI_LIMITS.projects }, (_, i) => [`prj_${i}`, { conversationId: 'cnv_1' }]));
    expect(checkUiPatch({ perProject: exactly }).problems).toEqual([]);
  });

  it('keeps the valid part of a patch that also has problems (loading what was stored uses this)', () => {
    const { patch, problems } = checkUiPatch({ route: { projectId: 'prj_a', view: 'nowhere' }, perProject: { prj_a: { sessionKey: KEY_A, conversationId: 7 } }, setup: { seenEmpty: true }, extra: 1 });
    expect(problems.map((p) => p.field).sort()).toEqual(['ui.extra', 'ui.perProject.prj_a.conversationId', 'ui.route.view']);
    expect(patch).toEqual({ perProject: { prj_a: { sessionKey: KEY_A } }, setup: { seenEmpty: true } });
  });
});

describe('applying a change (mergeUi)', () => {
  const base: UiPrefs = {
    route: { projectId: 'prj_a', view: 'workspace' },
    perProject: { prj_a: { sessionKey: KEY_A, conversationId: 'cnv_1' }, prj_b: { conversationId: 'cnv_2' } },
    setup: { seenEmpty: true },
  };

  it('starts from nothing and stores only what was said', () => {
    expect(mergeUi(undefined, {})).toEqual({});
    expect(mergeUi(undefined, { setup: { dismissed: true } })).toEqual({ setup: { dismissed: true } });
    expect(isEmptyUi(mergeUi(undefined, {}))).toBe(true);
    expect(isEmptyUi(undefined)).toBe(true);
    expect(isEmptyUi(base)).toBe(false);
  });

  it('replaces the route as a unit, and forgets it on null', () => {
    expect(mergeUi(base, { route: { projectId: null, view: 'reports' } }).route).toEqual({ projectId: null, view: 'reports' });
    expect(mergeUi(base, { route: null }).route).toBeUndefined();
    expect(mergeUi(base, {}).route).toEqual(base.route);
  });

  it('changes only the fields a project patch names, so two writers do not overwrite each other', () => {
    const first = mergeUi(base, { perProject: { prj_a: { sessionKey: KEY_B } } });
    expect(first.perProject?.prj_a).toEqual({ sessionKey: KEY_B, conversationId: 'cnv_1' });
    const second = mergeUi(first, { perProject: { prj_a: { conversationId: 'cnv_9' }, prj_c: { sessionKey: KEY_A } } });
    expect(second.perProject).toEqual({ prj_b: { conversationId: 'cnv_2' }, prj_a: { sessionKey: KEY_B, conversationId: 'cnv_9' }, prj_c: { sessionKey: KEY_A } });
  });

  it('forgets a field on null and an entry that has nothing left, and a whole project on null', () => {
    expect(mergeUi(base, { perProject: { prj_a: { sessionKey: null } } }).perProject?.prj_a).toEqual({ conversationId: 'cnv_1' });
    expect(mergeUi(base, { perProject: { prj_b: { conversationId: null } } }).perProject).toEqual({ prj_a: base.perProject!.prj_a });
    expect(mergeUi(base, { perProject: { prj_a: null, prj_b: null } }).perProject).toBeUndefined();
    expect(mergeUi(base, { perProject: { prj_none: null } })).toEqual(base);
  });

  it('merges the setup flags one by one', () => {
    expect(mergeUi(base, { setup: { dismissed: true } }).setup).toEqual({ dismissed: true, seenEmpty: true });
    expect(mergeUi(base, { setup: { seenEmpty: null } }).setup).toBeUndefined();
  });

  it('never edits its arguments', () => {
    const frozen = structuredClone(base);
    const patch: UiPrefsPatch = { route: null, perProject: { prj_a: null, prj_z: { conversationId: 'cnv_z' } }, setup: { dismissed: false } };
    const patchCopy = structuredClone(patch);
    mergeUi(frozen, patch);
    expect(frozen).toEqual(base);
    expect(patch).toEqual(patchCopy);
  });

  it('leaves the serialised blob identical when nothing changes, so the core can tell and write nothing', () => {
    const once = mergeUi(base, {});
    expect(JSON.stringify(once)).toBe(JSON.stringify(base));
    const same = mergeUi(base, { route: base.route, perProject: { prj_a: { sessionKey: KEY_A }, prj_b: { conversationId: 'cnv_2' } }, setup: { seenEmpty: true } });
    expect(JSON.stringify(same)).toBe(JSON.stringify(base));
  });

  it('stays bounded: past the limit the project whose choices changed longest ago is forgotten', () => {
    let ui: UiPrefs = {};
    for (let i = 0; i < UI_LIMITS.projects; i += 1) ui = mergeUi(ui, { perProject: { [`prj_${i}`]: { conversationId: `cnv_${i}` } } });
    expect(Object.keys(ui.perProject!)).toHaveLength(UI_LIMITS.projects);
    ui = mergeUi(ui, { perProject: { prj_0: { conversationId: 'cnv_fresh' } } }); // prj_0 is the most recent now
    ui = mergeUi(ui, { perProject: { prj_new: { sessionKey: KEY_A } } });
    const ids = Object.keys(ui.perProject!);
    expect(ids).toHaveLength(UI_LIMITS.projects);
    expect(ids).toContain('prj_0');
    expect(ids).toContain('prj_new');
    expect(ids).not.toContain('prj_1'); // the least recently changed
    expect(JSON.stringify(ui).length).toBeLessThan(40_000);
  });
});

describe('what was stored (sanitizeStoredUi)', () => {
  it('keeps what is valid, drops the rest, and says nothing when nothing is left', () => {
    expect(sanitizeStoredUi(undefined)).toBeUndefined();
    expect(sanitizeStoredUi('garbage')).toBeUndefined();
    expect(sanitizeStoredUi({ future: { x: 1 } })).toBeUndefined();
    expect(sanitizeStoredUi({ route: { projectId: 'prj_a', view: 'settings' }, perProject: { prj_a: { sessionKey: 'nope', conversationId: 'cnv_1' } }, setup: { dismissed: 'no' }, other: 1 }))
      .toEqual({ route: { projectId: 'prj_a', view: 'settings' }, perProject: { prj_a: { conversationId: 'cnv_1' } } });
  });
});

describe('settings with a window state', () => {
  it('has none by default, and a first change creates it', () => {
    const base = defaultSettings();
    expect(base).not.toHaveProperty('ui');
    const next = mergeSettings(base, { ui: { setup: { dismissed: true } }, layout: { sidebarWidth: 300 } });
    expect(next.ui).toEqual({ setup: { dismissed: true } });
    expect(next.layout.sidebarWidth).toBe(300);
    expect(base).not.toHaveProperty('ui'); // the argument is not edited
  });

  it('removes the part again when everything in it was forgotten', () => {
    const withUi = mergeSettings(defaultSettings(), { ui: { route: { projectId: null, view: 'activity' } } });
    expect(mergeSettings(withUi, { ui: { route: null } })).not.toHaveProperty('ui');
  });

  it('does not let a bad window state reach the settings (mergeSettings is lenient, validation is the caller\'s)', () => {
    const next = mergeSettings(defaultSettings(), { ui: { route: { projectId: 'prj_a', view: 'moon' }, setup: { dismissed: true } } as never });
    expect(next.ui).toEqual({ setup: { dismissed: true } });
  });
});

describe('the HTTP body (settingsPatchSchema)', () => {
  const parse = (body: unknown) => settingsPatchSchema.safeParse(body);

  it('accepts a window state next to other settings', () => {
    const body = { layout: { sidebarWidth: 300 }, ui: { route: { projectId: 'prj_a', view: 'reports' }, perProject: { prj_a: { sessionKey: KEY_A, conversationId: 'cnv_1' }, prj_old: null }, setup: { dismissed: true } } };
    const result = parse(body);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(body);
    expect(parse({ ui: { route: null } }).success).toBe(true);
    expect(parse({ ui: {} }).success).toBe(true);
  });

  it('rejects a key it does not know inside ui (unlike the other sections, which drop it)', () => {
    expect(parse({ ui: { theme: 'dark' } }).success).toBe(false);
    expect(parse({ ui: { route: { projectId: null, view: 'workspace', zoom: 1 } } }).success).toBe(false);
    expect(parse({ ui: { perProject: { prj_a: { sessionKey: KEY_A, scroll: 3 } } } }).success).toBe(false);
    expect(parse({ ui: { setup: { mood: 'good' } } }).success).toBe(false);
    expect(parse({ unknownSection: 1, layout: {} }).success).toBe(true); // the old behaviour is unchanged
  });

  it('rejects values of the wrong kind and values over the bounds', () => {
    expect(parse({ ui: { route: { projectId: 'prj_a', view: 'moon' } } }).success).toBe(false);
    expect(parse({ ui: { route: { projectId: 'p'.repeat(UI_LIMITS.idChars + 1), view: 'workspace' } } }).success).toBe(false);
    expect(parse({ ui: { perProject: { prj_a: { sessionKey: 'not-a-key' } } } }).success).toBe(false);
    expect(parse({ ui: { perProject: { prj_a: { sessionKey: `win|${'x'.repeat(UI_LIMITS.keyChars)}` } } } }).success).toBe(false);
    expect(parse({ ui: { setup: { dismissed: 'yes' } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: UI_LIMITS.projects + 1 }, (_, i) => [`prj_${i}`, null]));
    expect(parse({ ui: { perProject: many } }).success).toBe(false);
    // zod drops a "__proto__" key from a record instead of using it: nothing reaches Object.prototype
    const proto = parse(JSON.parse('{"ui":{"perProject":{"__proto__":{"conversationId":"x"},"prj_ok":null}}}'));
    expect(Object.keys(proto.data?.ui?.perProject ?? {})).toEqual(['prj_ok']);
    expect(({} as { conversationId?: string }).conversationId).toBeUndefined();
  });

  it('names the same views as the window does', () => {
    for (const view of UI_VIEWS) expect(parse({ ui: { route: { projectId: null, view } } }).success, view).toBe(true);
    expect(parse({ ui: { route: { projectId: null, view: 'help' } } }).success).toBe(false);
  });
});
