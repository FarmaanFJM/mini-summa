// Field rules for Settings. One table drives both directions:
//   strict   (update): a wrong type, a bad enum value or a malformed time is a 400 the user can act on; numbers are clamped.
//   lenient  (load):   whatever was stored by another build is repaired field by field (wrong types fall back to the
//                      default, numbers are clamped, unknown keys are dropped), so an old or newer database never breaks start.
//
// The numeric ranges mirror `settingsPatchSchema` in @minisumma/shared/routes.ts, which validates the HTTP body. The
// service clamps instead of rejecting because a slider that overshoots by one pixel should not be an error. A test
// keeps this table and that schema from drifting apart.
//
// `Settings.ui` (what the desktop window remembers) is not a fixed shape: its keys are project ids. It is therefore not in
// the table; `checkUiPatch` in @minisumma/shared validates it, strictly on update (an unknown key is a 400) and leniently
// on load (what is valid is kept).
import { checkUiPatch } from '@minisumma/shared';
import type { Settings } from '@minisumma/shared';
import { badRequest } from '../errors.ts';

export type Leaf =
  | { t: 'bool' }
  | { t: 'enum'; values: readonly string[]; nullable?: boolean }
  | { t: 'num'; min: number; max: number; int?: boolean }
  | { t: 'str'; max: number; nullable?: boolean }
  /** 24-hour `HH:MM`. */
  | { t: 'time' }
  /** Nullable ISO timestamp. */
  | { t: 'instant' };

type Primitive = string | number | boolean;
/** Same shape as Settings with a rule at every leaf. A missing or extra key is a compile error. */
export type SettingsSpec<T> = { [K in keyof T]-?: NonNullable<T[K]> extends Primitive ? Leaf : SettingsSpec<NonNullable<T[K]>> };

const bool: Leaf = { t: 'bool' };
const num = (min: number, max: number): Leaf => ({ t: 'num', min, max });
const int = (min: number, max: number): Leaf => ({ t: 'num', min, max, int: true });
const oneOf = (...values: string[]): Leaf => ({ t: 'enum', values });

export const SETTINGS_SPEC: SettingsSpec<Omit<Settings, 'ui'>> = {
  chatgpt: { mode: oneOf('embedded', 'external'), externalBrowser: oneOf('default', 'extension'), pageScale: oneOf('auto', '100', '90', '80', '70') },
  layout: {
    orientation: oneOf('auto', 'landscape', 'portrait'),
    landscapeRatio: num(0.15, 0.85),
    portraitRatio: num(0.15, 0.85),
    maximized: { t: 'enum', values: ['chatgpt', 'claude'], nullable: true },
    sidebarWidth: num(180, 520),
    sidebarCollapsed: bool,
  },
  notifications: {
    native: bool,
    quiet: {
      enabled: bool,
      until: { t: 'instant' },
      schedule: { enabled: bool, from: { t: 'time' }, to: { t: 'time' } },
    },
    defaults: { enabled: bool, permission: bool, input: bool, error: bool, report: bool, turnEnded: bool, sessionEnded: bool, presenceLost: bool, push: bool },
  },
  review: { requestTemplate: { t: 'str', max: 4000 }, includeSessionRef: bool, maxPartChars: int(2000, 100_000) },
  sessions: { discoveryIntervalSec: int(5, 600), remoteControlByDefault: bool, claudeCommand: { t: 'str', max: 512, nullable: true } },
  mobile: {
    remoteAccess: oneOf('off', 'tailscale'),
    // Not part of the HTTP patch schema: only the push provider changes it, through SettingsService.update.
    push: { provider: oneOf('none', 'fcm'), configured: bool },
    promptActionTtlMinutes: int(1, 1440),
  },
  retention: { rawEventsDays: int(0, 3650), activityDays: int(0, 3650), notificationsDays: int(0, 3650), reportsDays: int(0, 3650) },
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type Checked = { ok: true; value: unknown } | { ok: false; message: string };

function checkLeaf(leaf: Leaf, v: unknown, path: string): Checked {
  switch (leaf.t) {
    case 'bool':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, message: `The setting "${path}" must be true or false. Send true or false.` };
    case 'enum': {
      if (v === null && leaf.nullable) return { ok: true, value: null };
      if (typeof v === 'string' && leaf.values.includes(v)) return { ok: true, value: v };
      return { ok: false, message: `The setting "${path}" must be one of: ${leaf.values.join(', ')}${leaf.nullable ? ', or empty' : ''}. Pick one of these values.` };
    }
    case 'num': {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false, message: `The setting "${path}" must be a number between ${leaf.min} and ${leaf.max}. Enter a number and save again.` };
      }
      const n = leaf.int ? Math.round(v) : v;
      return { ok: true, value: Math.min(leaf.max, Math.max(leaf.min, n)) };
    }
    case 'str': {
      if (v === null && leaf.nullable) return { ok: true, value: null };
      if (typeof v !== 'string') return { ok: false, message: `The setting "${path}" must be text${leaf.nullable ? ' or empty' : ''}. Enter text and save again.` };
      if (v.length > leaf.max) return { ok: false, message: `The setting "${path}" is too long (${v.length} characters, at most ${leaf.max}). Shorten it and save again.` };
      return { ok: true, value: leaf.nullable && v.trim() === '' ? null : v };
    }
    case 'time':
      return typeof v === 'string' && TIME_RE.test(v)
        ? { ok: true, value: v }
        : { ok: false, message: `The setting "${path}" must be a 24-hour time like 22:00 or 08:30. Fix the time and save again.` };
    case 'instant': {
      if (v === null) return { ok: true, value: null };
      const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN;
      return Number.isFinite(ms)
        ? { ok: true, value: new Date(ms).toISOString() }
        : { ok: false, message: `The setting "${path}" must be a date and time like 2026-01-31T08:00:00Z, or empty. Fix the value and save again.` };
    }
  }
}

const isLeaf = (node: unknown): node is Leaf => typeof (node as { t?: unknown }).t === 'string';
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function walk(spec: object, input: unknown, strict: boolean, path: string): Record<string, unknown> {
  if (!isPlainObject(input)) {
    if (strict) {
      throw badRequest(path === '' ? 'Settings changes must be an object such as {"layout":{"sidebarWidth":300}}.' : `The setting group "${path}" must be an object. Send its fields inside braces.`, { field: path }, 'invalid_setting');
    }
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(spec)) {
    const value = input[key];
    if (value === undefined) continue;
    const here = path === '' ? key : `${path}.${key}`;
    if (isLeaf(node)) {
      const r = checkLeaf(node, value, here);
      if (r.ok) out[key] = r.value;
      else if (strict) throw badRequest(r.message, { field: here }, 'invalid_setting');
    } else {
      const sub = walk(node, value, strict, here);
      if (Object.keys(sub).length > 0) out[key] = sub;
    }
  }
  return out;
}

/** A clean patch from user input: unknown keys dropped, numbers clamped, anything malformed a 400. The `ui` part is strict: an unknown key in it is refused. */
export function strictPatch(input: unknown): Record<string, unknown> {
  const out = walk(SETTINGS_SPEC, input, true, '');
  if (isPlainObject(input) && input.ui !== undefined) {
    const { patch, problems } = checkUiPatch(input.ui);
    if (problems.length > 0) throw badRequest(problems[0].message, { field: problems[0].field }, 'invalid_setting');
    out.ui = patch;
  }
  return out;
}

/** A clean partial from stored data: invalid fields are skipped (the default applies), unknown keys are dropped. */
export function lenientPartial(input: unknown): Record<string, unknown> {
  const out = walk(SETTINGS_SPEC, input, false, '');
  if (isPlainObject(input) && input.ui !== undefined) out.ui = checkUiPatch(input.ui).patch;
  return out;
}

/** Dotted paths of every numeric field with its range. Used by the drift test against settingsPatchSchema. */
export function numericFields(spec: object = SETTINGS_SPEC, prefix = ''): { path: string; min: number; max: number; int: boolean }[] {
  const out: { path: string; min: number; max: number; int: boolean }[] = [];
  for (const [key, node] of Object.entries(spec)) {
    const here = prefix === '' ? key : `${prefix}.${key}`;
    if (isLeaf(node)) {
      if (node.t === 'num') out.push({ path: here, min: node.min, max: node.max, int: node.int === true });
    } else out.push(...numericFields(node, here));
  }
  return out;
}
