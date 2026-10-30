import { defaultSettings, settingsPatchSchema } from '@minisumma/shared';
import type { Settings, SettingsPatch } from '@minisumma/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsService } from '../../src/infra/settings.ts';
import { SETTINGS_SPEC, numericFields } from '../../src/infra/settings-schema.ts';
import type { Leaf } from '../../src/infra/settings-schema.ts';
import { expectPlainText, failure, makeBase } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';

let base: TestBase;
afterEach(() => base?.close());

const make = () => { base = makeBase(); return createSettingsService({ base }); };
const storedJson = (): unknown => {
  const row = base.db.get<{ value_json: string }>("SELECT value_json FROM kv WHERE key = 'settings'");
  return row ? JSON.parse(row.value_json) : undefined;
};
const seed = (value: unknown): void => {
  base.db.run("INSERT OR REPLACE INTO kv (key, value_json, updated_at) VALUES ('settings', ?, 'x')", [typeof value === 'string' ? value : JSON.stringify(value)]);
};

describe('loading', () => {
  it('starts from the defaults and writes nothing until something changes', () => {
    const s = make();
    expect(s.get()).toEqual(defaultSettings());
    expect(storedJson()).toBeUndefined();
  });

  it('fills keys the stored value lacks (an older build) with the defaults', () => {
    base = makeBase();
    seed({ layout: { sidebarWidth: 321 }, retention: { activityDays: 7 } });
    const got = createSettingsService({ base }).get();
    const want = defaultSettings();
    want.layout.sidebarWidth = 321;
    want.retention.activityDays = 7;
    expect(got).toEqual(want);
  });

  it('drops keys this build does not know (a newer build) and does not store them again', () => {
    base = makeBase();
    seed({ futureSection: { x: 1 }, layout: { sidebarWidth: 300, hologram: true }, chatgpt: { mode: 'external', pasteAssist: true } });
    const s = createSettingsService({ base });
    expect(s.get()).not.toHaveProperty('futureSection');
    expect(s.get().layout).not.toHaveProperty('hologram');
    expect(s.get().chatgpt).toEqual({ mode: 'external', externalBrowser: 'default' });
    s.update({ layout: { sidebarWidth: 301 } });
    expect(Object.keys(storedJson() as object).sort()).toEqual(Object.keys(defaultSettings()).sort());
    expect(JSON.stringify(storedJson())).not.toContain('hologram');
  });

  it('repairs fields of the wrong type or out of range instead of failing to start', () => {
    base = makeBase();
    seed({
      chatgpt: { mode: 'sideways', externalBrowser: 7 },
      layout: { sidebarWidth: 'wide', landscapeRatio: 9, maximized: 'nope' },
      notifications: 'loud',
      review: { maxPartChars: 5 },
      mobile: { remoteAccess: 'tailscale', push: 'yes' },
      retention: { rawEventsDays: -4, reportsDays: 99999 },
    });
    const got = createSettingsService({ base }).get();
    const def = defaultSettings();
    expect(got.chatgpt).toEqual(def.chatgpt);
    expect(got.layout.sidebarWidth).toBe(def.layout.sidebarWidth);
    expect(got.layout.landscapeRatio).toBe(0.85);
    expect(got.layout.maximized).toBeNull();
    expect(got.notifications).toEqual(def.notifications);
    expect(got.review.maxPartChars).toBe(2000);
    expect(got.mobile).toEqual({ ...def.mobile, remoteAccess: 'tailscale' });
    expect(got.retention.rawEventsDays).toBe(0);
    expect(got.retention.reportsDays).toBe(3650);
  });

  it('survives a stored value that is not JSON or not an object', () => {
    for (const bad of ['{not json', '42', 'null', '"text"', '[1,2]']) {
      base = makeBase();
      seed(bad);
      expect(createSettingsService({ base }).get()).toEqual(defaultSettings());
      base.close();
    }
  });

  it('shows what the previous process saved', () => {
    base = makeBase();
    const first = createSettingsService({ base });
    first.update({ chatgpt: { mode: 'external' }, notifications: { quiet: { schedule: { from: '21:30' } } } });
    const second = createSettingsService({ base });
    expect(second.get().chatgpt.mode).toBe('external');
    expect(second.get().notifications.quiet.schedule).toEqual({ enabled: false, from: '21:30', to: '08:00' });
  });
});

describe('update', () => {
  it('merges a nested patch, persists it under kv "settings" and returns the new settings', () => {
    const s = make();
    const next = s.update({ notifications: { quiet: { enabled: true, schedule: { to: '07:15' } } }, mobile: { remoteAccess: 'tailscale' } });
    expect(next.notifications.quiet.enabled).toBe(true);
    expect(next.notifications.quiet.schedule).toEqual({ enabled: false, from: '22:00', to: '07:15' });
    expect(next.mobile.remoteAccess).toBe('tailscale');
    expect(next.layout).toEqual(defaultSettings().layout);
    expect(s.get()).toEqual(next);
    expect(storedJson()).toEqual(next);
  });

  it('ignores unknown keys in a patch', () => {
    const s = make();
    const next = s.update({ nope: 1, layout: { sidebarWidth: 300, wat: 'x' } } as unknown as SettingsPatch);
    expect(next.layout.sidebarWidth).toBe(300);
    expect(next).not.toHaveProperty('nope');
    expect(next.layout).not.toHaveProperty('wat');
  });

  it('accepts null where the setting is nullable and treats an empty command as none', () => {
    const s = make();
    s.update({ layout: { maximized: 'claude' }, sessions: { claudeCommand: 'C:\\tools\\claude.cmd' } });
    expect(s.get().layout.maximized).toBe('claude');
    const next = s.update({ layout: { maximized: null }, sessions: { claudeCommand: '  ' } });
    expect(next.layout.maximized).toBeNull();
    expect(next.sessions.claudeCommand).toBeNull();
  });

  it('lets the push provider record its state although the HTTP patch schema has no such field', () => {
    const s = make();
    s.update({ mobile: { push: { provider: 'fcm', configured: true } } });
    expect(s.get().mobile.push).toEqual({ provider: 'fcm', configured: true });
    expect(settingsPatchSchema.safeParse({ mobile: { push: { provider: 'fcm', configured: true } } }).data?.mobile).not.toHaveProperty('push');
  });

  it('returns copies, so a caller cannot change the stored state by editing the result', () => {
    const s = make();
    const a = s.get();
    a.layout.sidebarWidth = 999;
    a.notifications.defaults.enabled = false;
    expect(s.get().layout.sidebarWidth).toBe(260);
    const b = s.update({ layout: { sidebarWidth: 300 } });
    b.layout.sidebarWidth = 1;
    expect(s.get().layout.sidebarWidth).toBe(300);
  });

  describe('validation', () => {
    const cases: [string, SettingsPatch][] = [
      ['an enum with an unknown value', { chatgpt: { mode: 'sideways' as never } }],
      ['a boolean that is not one', { layout: { sidebarCollapsed: 'yes' as never } }],
      ['a number that is text', { layout: { sidebarWidth: '300' as never } }],
      ['a number that is not finite', { layout: { sidebarWidth: Number.NaN } }],
      ['an infinite number', { retention: { rawEventsDays: Number.POSITIVE_INFINITY } }],
      ['text that is a number', { review: { requestTemplate: 5 as never } }],
      ['a template over 4000 characters', { review: { requestTemplate: 'x'.repeat(4001) } }],
      ['a command over 512 characters', { sessions: { claudeCommand: 'x'.repeat(513) } }],
      ['a group that is not an object', { layout: 'big' as never }],
      ['a date that is not a date', { notifications: { quiet: { until: 'tomorrow-ish' } } }],
    ];
    for (const [name, patch] of cases) {
      it(`rejects ${name} with a plain 400 and changes nothing`, () => {
        const s = make();
        const err = failure(() => s.update(patch));
        expect(err.status).toBe(400);
        expect(err.code).toBe('invalid_setting');
        expect(err.message.length).toBeGreaterThan(20);
        expectPlainText(err.message);
        expect(s.get()).toEqual(defaultSettings());
        expect(storedJson()).toBeUndefined();
        expect(base.events).toHaveLength(0);
      });
    }

    it('rejects a patch that is not an object', () => {
      const s = make();
      for (const bad of [null, 'x', 5, ['layout']]) expect(failure(() => s.update(bad as never)).status).toBe(400);
    });

    it('validates HH:MM for the quiet-hours window', () => {
      const s = make();
      for (const bad of ['25:00', '24:00', '9:30', '12:60', '12-30', '', 'noon', '12:5']) {
        const err = failure(() => s.update({ notifications: { quiet: { schedule: { from: bad } } } }));
        expect(err.status).toBe(400);
        expect(err.message).toMatch(/24-hour time/);
        expect(err.details).toEqual({ field: 'notifications.quiet.schedule.from' });
      }
      for (const good of ['00:00', '23:59', '08:05']) {
        expect(s.update({ notifications: { quiet: { schedule: { to: good } } } }).notifications.quiet.schedule.to).toBe(good);
      }
    });

    it('reports the field that is wrong, not just that something is', () => {
      const s = make();
      const err = failure(() => s.update({ chatgpt: { externalBrowser: 'safari' as never } }));
      expect(err.details).toEqual({ field: 'chatgpt.externalBrowser' });
      expect(err.message).toContain('chatgpt.externalBrowser');
      expect(err.message).toContain('default, extension');
    });

    it('is all or nothing: one bad field means no field of the patch is applied', () => {
      const s = make();
      expect(() => s.update({ layout: { sidebarWidth: 300 }, retention: { rawEventsDays: 'many' as never } })).toThrow();
      expect(s.get().layout.sidebarWidth).toBe(260);
    });

    it('normalises a "quiet until" time to an ISO instant', () => {
      const s = make();
      expect(s.update({ notifications: { quiet: { until: '2026-03-01T14:00:00+02:00' } } }).notifications.quiet.until).toBe('2026-03-01T12:00:00.000Z');
      expect(s.update({ notifications: { quiet: { until: null } } }).notifications.quiet.until).toBeNull();
    });
  });

  describe('clamping', () => {
    it('clamps every number to the range of settingsPatchSchema instead of rejecting it', () => {
      const s = make();
      for (const f of numericFields()) {
        const set = (value: number): Settings => {
          const patch: Record<string, unknown> = {};
          let cursor = patch;
          const parts = f.path.split('.');
          parts.slice(0, -1).forEach((p) => { cursor[p] = {}; cursor = cursor[p] as Record<string, unknown>; });
          cursor[parts[parts.length - 1]] = value;
          return s.update(patch as SettingsPatch);
        };
        const read = (v: Settings): number => f.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], v) as number;
        const middle = f.int ? Math.round((f.min + f.max) / 2) : (f.min + f.max) / 2;
        expect(read(set(f.max + 12345)), `${f.path} above max`).toBe(f.max);
        expect(read(set(f.min - 12345)), `${f.path} below min`).toBe(f.min);
        expect(read(set(middle)), `${f.path} inside the range`).toBe(middle);
      }
    });

    it('rounds whole-number settings to a whole number before clamping', () => {
      const s = make();
      expect(s.update({ review: { maxPartChars: 12000.6 } }).review.maxPartChars).toBe(12001);
      expect(s.update({ sessions: { discoveryIntervalSec: 4.2 } }).sessions.discoveryIntervalSec).toBe(5);
      expect(s.update({ layout: { landscapeRatio: 0.333333 } }).layout.landscapeRatio).toBe(0.333333);
    });

    it('keeps its table identical to settingsPatchSchema (leaf kinds, enum values, ranges)', () => {
      // Walk the zod schema that validates the HTTP body and compare every leaf with the rule table in the service.
      type Zod = { def?: { type?: string; innerType?: Zod; entries?: Record<string, string> }; shape?: Record<string, Zod>; minValue?: number | null; maxValue?: number | null; isInt?: boolean };
      const unwrap = (z: Zod): Zod => { let s = z; for (let i = 0; i < 8 && s.def?.innerType; i++) s = s.def.innerType; return s; };
      const zodLeaves = new Map<string, Zod>();
      const walkZod = (z: Zod, prefix: string): void => {
        const s = unwrap(z);
        if (s.def?.type === 'object' && s.shape) for (const [k, v] of Object.entries(s.shape)) walkZod(v, prefix ? `${prefix}.${k}` : k);
        else zodLeaves.set(prefix, s);
      };
      walkZod(settingsPatchSchema as unknown as Zod, '');

      const ourLeaves = new Map<string, Leaf>();
      const walkOurs = (node: object, prefix: string): void => {
        for (const [k, v] of Object.entries(node)) {
          const here = prefix ? `${prefix}.${k}` : k;
          if (typeof (v as { t?: unknown }).t === 'string') ourLeaves.set(here, v as Leaf); else walkOurs(v as object, here);
        }
      };
      walkOurs(SETTINGS_SPEC, '');

      // Only the push provider's own state is allowed to be missing from the HTTP schema.
      const internalOnly = new Set(['mobile.push.provider', 'mobile.push.configured']);
      expect([...zodLeaves.keys()].filter((k) => !ourLeaves.has(k))).toEqual([]);
      expect([...ourLeaves.keys()].filter((k) => !zodLeaves.has(k) && !internalOnly.has(k))).toEqual([]);

      for (const [path, z] of zodLeaves) {
        const leaf = ourLeaves.get(path) as Leaf;
        const zodType = z.def?.type;
        const kind: Record<Leaf['t'], string> = { bool: 'boolean', enum: 'enum', num: 'number', str: 'string', time: 'string', instant: 'string' };
        expect(zodType, `${path}: kind`).toBe(kind[leaf.t]);
        if (leaf.t === 'enum') expect(Object.values(z.def?.entries ?? {}).sort(), `${path}: enum values`).toEqual([...leaf.values].sort());
        if (leaf.t === 'num') {
          expect(z.minValue, `${path}: min`).toBe(leaf.min);
          expect(z.maxValue, `${path}: max`).toBe(leaf.max);
          expect(z.isInt === true, `${path}: integer`).toBe(leaf.int === true);
        }
      }
    });
  });
});

describe('after the change', () => {
  it('emits settings.changed once, with the new settings, after the value was saved', () => {
    const s = make();
    let seenInDb: unknown;
    base.bus.subscribe((_seq, event) => { if (event.type === 'settings.changed') seenInDb = storedJson(); });
    const next = s.update({ mobile: { promptActionTtlMinutes: 15 } });
    const events = base.eventsOf('settings.changed');
    expect(events).toHaveLength(1);
    expect(events[0].settings).toEqual(next);
    expect(seenInDb).toEqual(next);
  });

  it('calls listeners with (next, prev), in order, and lets them unsubscribe', () => {
    const s = make();
    const calls: string[] = [];
    const off = s.onChange((next, prev) => calls.push(`a:${prev.layout.sidebarWidth}->${next.layout.sidebarWidth}`));
    s.onChange((next) => calls.push(`b:${next.layout.sidebarWidth}`));
    s.update({ layout: { sidebarWidth: 300 } });
    off();
    s.update({ layout: { sidebarWidth: 310 } });
    expect(calls).toEqual(['a:260->300', 'b:300', 'b:310']);
  });

  it('does not let a failing listener undo the change or stop the others', () => {
    const s = make();
    const later: number[] = [];
    s.onChange(() => { throw new Error('boom'); });
    s.onChange((next) => later.push(next.layout.sidebarWidth));
    expect(s.update({ layout: { sidebarWidth: 300 } }).layout.sidebarWidth).toBe(300);
    expect(later).toEqual([300]);
    expect((storedJson() as Settings).layout.sidebarWidth).toBe(300);
    expect(base.log.lines.some((l) => l.level === 'warn' && /listener failed/.test(l.msg))).toBe(true);
  });

  it('hands listeners and events copies, so one cannot corrupt the stored state', () => {
    const s = make();
    s.onChange((next) => { next.layout.sidebarWidth = 1; });
    s.update({ layout: { sidebarWidth: 300 } });
    expect(s.get().layout.sidebarWidth).toBe(300);
    expect(base.eventsOf('settings.changed')[0].settings.layout.sidebarWidth).toBe(300);
  });

  it('does nothing for a patch that changes nothing: no write, no event, no listener', () => {
    const s = make();
    s.update({ layout: { sidebarWidth: 300 } });
    const stamp = base.db.get<{ updated_at: string }>("SELECT updated_at FROM kv WHERE key='settings'")?.updated_at;
    let called = 0;
    s.onChange(() => { called += 1; });
    base.clock.advance(60_000);
    s.update({ layout: { sidebarWidth: 300 } });
    s.update({});
    s.update({ layout: { sidebarWidth: 300.0 }, nothing: 1 } as unknown as SettingsPatch);
    expect(called).toBe(0);
    expect(base.eventsOf('settings.changed')).toHaveLength(1);
    expect(base.db.get<{ updated_at: string }>("SELECT updated_at FROM kv WHERE key='settings'")?.updated_at).toBe(stamp);
  });

  it('stamps the saved document with the injected clock', () => {
    const s = make();
    base.clock.set('2027-01-02T03:04:05.000Z');
    s.update({ layout: { sidebarWidth: 300 } });
    expect(base.db.get<{ updated_at: string }>("SELECT updated_at FROM kv WHERE key='settings'")?.updated_at).toBe('2027-01-02T03:04:05.000Z');
  });

  it('stores nothing but settings: the saved keys are exactly the known ones (no secrets live here)', () => {
    const s = make();
    s.update({ mobile: { push: { provider: 'fcm', configured: true } } });
    const keys = (obj: unknown, prefix = ''): string[] =>
      Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    expect(keys(storedJson()).sort()).toEqual(keys(defaultSettings()).sort());
  });
});
