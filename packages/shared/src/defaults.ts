import { isSessionKey } from './env.ts';
import type { SessionKey } from './env.ts';
import { DEFAULT_REVIEW_REQUEST } from './report-message.ts';
import type { ProjectNotificationPrefs, Settings, SettingsPatch, UiPrefs, UiPrefsPatch, UiProjectPrefs, UiViewId } from './entities.ts';

export function defaultNotificationPrefs(): ProjectNotificationPrefs {
  return { enabled: true, permission: true, input: true, error: true, report: true, sessionEnded: false, presenceLost: true, push: true };
}

export function defaultSettings(): Settings {
  return {
    chatgpt: { mode: 'embedded', externalBrowser: 'default' },
    layout: { orientation: 'auto', landscapeRatio: 0.5, portraitRatio: 0.5, maximized: null, sidebarWidth: 260, sidebarCollapsed: false },
    notifications: {
      native: true,
      quiet: { enabled: false, until: null, schedule: { enabled: false, from: '22:00', to: '08:00' } },
      defaults: defaultNotificationPrefs(),
    },
    review: { requestTemplate: DEFAULT_REVIEW_REQUEST, includeSessionRef: true, maxPartChars: 12000 },
    sessions: { discoveryIntervalSec: 15, remoteControlByDefault: false, claudeCommand: null },
    mobile: { remoteAccess: 'off', push: { provider: 'none', configured: false }, promptActionTtlMinutes: 60 },
    retention: { rawEventsDays: 90, activityDays: 180, notificationsDays: 90, reportsDays: 0 },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The window's own memory (`Settings.ui`): validation, bounds and merging. Shared so that the core (which keeps it), the
// demo core and the window agree on what a patch means.

/** How big the window's memory can get. A first run stores nothing; a heavy user stores a few kilobytes. */
export const UI_LIMITS = {
  /** Projects with remembered choices. Past this the least recently changed ones are forgotten. */
  projects: 100,
  /** Project ids and conversation ids. */
  idChars: 100,
  /** A session key: `<env>|<session id>`. */
  keyChars: 200,
} as const;

export const UI_VIEWS: readonly UiViewId[] = ['workspace', 'activity', 'reports', 'settings'];
const UI_PARTS = ['route', 'perProject', 'setup'] as const;
/** Ids become object keys; these would change the object itself. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export interface UiProblem { field: string; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isUiId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= UI_LIMITS.idChars && !FORBIDDEN_KEYS.has(v);
const isUiSessionKey = (v: unknown): v is SessionKey => typeof v === 'string' && v.length <= UI_LIMITS.keyChars && isSessionKey(v);

/**
 * Reads a change to the window's memory. Everything valid ends up in `patch`; everything else is listed in `problems`.
 * The core's update refuses a patch that has any problem (unknown keys included); loading what was stored only skips it.
 */
export function checkUiPatch(input: unknown): { patch: UiPrefsPatch; problems: UiProblem[] } {
  const problems: UiProblem[] = [];
  const patch: UiPrefsPatch = {};
  const bad = (field: string, message: string): void => { problems.push({ field, message }); };
  if (!isRecord(input)) {
    bad('ui', 'The window state "ui" must be an object such as {"route":{"projectId":"prj_1","view":"workspace"}}. Send an object.');
    return { patch, problems };
  }
  for (const key of Object.keys(input)) {
    if (!(UI_PARTS as readonly string[]).includes(key)) bad(`ui.${key}`, `"ui.${key}" is not part of the window state. The parts are ${UI_PARTS.join(', ')}. Remove "${key}".`);
  }

  const route = input.route;
  if (route === null) patch.route = null;
  else if (route !== undefined) {
    if (!isRecord(route)) bad('ui.route', 'The setting "ui.route" must be an object like {"projectId":"prj_1","view":"workspace"}, or null. Send an object.');
    else {
      for (const key of Object.keys(route)) if (key !== 'projectId' && key !== 'view') bad(`ui.route.${key}`, `"ui.route.${key}" is not part of the route. The route has projectId and view. Remove "${key}".`);
      const { projectId, view } = route;
      const idOk = projectId === null || isUiId(projectId);
      const viewOk = typeof view === 'string' && (UI_VIEWS as readonly string[]).includes(view);
      if (!idOk) bad('ui.route.projectId', `The setting "ui.route.projectId" must be a project id of 1 to ${UI_LIMITS.idChars} characters, or null. Send the id.`);
      if (!viewOk) bad('ui.route.view', `The setting "ui.route.view" must be one of: ${UI_VIEWS.join(', ')}. Pick one of these values.`);
      if (idOk && viewOk) patch.route = { projectId: projectId as string | null, view: view as UiViewId };
    }
  }

  const perProject = input.perProject;
  if (perProject !== undefined) {
    if (!isRecord(perProject)) bad('ui.perProject', 'The setting "ui.perProject" must be an object keyed by project id, like {"prj_1":{"sessionKey":"win|..."}}. Send an object.');
    else {
      const ids = Object.keys(perProject);
      if (ids.length > UI_LIMITS.projects) bad('ui.perProject', `The setting "ui.perProject" names ${ids.length} projects, at most ${UI_LIMITS.projects} are kept. Send fewer.`);
      else {
        const out: NonNullable<UiPrefsPatch['perProject']> = {};
        for (const id of ids) {
          const here = `ui.perProject.${id}`;
          const entry = perProject[id];
          if (!isUiId(id)) { bad(here, `A project id in "ui.perProject" must have 1 to ${UI_LIMITS.idChars} characters. Use the project's id.`); continue; }
          if (entry === null) { out[id] = null; continue; }
          if (!isRecord(entry)) { bad(here, `The setting "${here}" must be an object like {"sessionKey":"win|..."}, or null to forget the project. Send an object.`); continue; }
          const change: { sessionKey?: SessionKey | null; conversationId?: string | null } = {};
          for (const key of Object.keys(entry)) {
            const value = entry[key];
            if (key === 'sessionKey') {
              if (value === null || isUiSessionKey(value)) change.sessionKey = value;
              else bad(`${here}.sessionKey`, `The setting "${here}.sessionKey" must be a session key like win|<id>, or null. Send the key from the session list.`);
            } else if (key === 'conversationId') {
              if (value === null || isUiId(value)) change.conversationId = value;
              else bad(`${here}.conversationId`, `The setting "${here}.conversationId" must be a conversation id of 1 to ${UI_LIMITS.idChars} characters, or null. Send the id.`);
            } else bad(`${here}.${key}`, `"${here}.${key}" is not remembered. A project keeps sessionKey and conversationId. Remove "${key}".`);
          }
          out[id] = change;
        }
        patch.perProject = out;
      }
    }
  }

  const setup = input.setup;
  if (setup !== undefined) {
    if (!isRecord(setup)) bad('ui.setup', 'The setting "ui.setup" must be an object like {"dismissed":true}. Send an object.');
    else {
      const out: NonNullable<UiPrefsPatch['setup']> = {};
      for (const key of Object.keys(setup)) {
        const value = setup[key];
        if (key === 'dismissed' || key === 'seenEmpty') {
          if (value === null || typeof value === 'boolean') out[key] = value;
          else bad(`ui.setup.${key}`, `The setting "ui.setup.${key}" must be true or false, or null. Send true or false.`);
        } else bad(`ui.setup.${key}`, `"ui.setup.${key}" is not remembered. The setup keeps dismissed and seenEmpty. Remove "${key}".`);
      }
      patch.setup = out;
    }
  }
  return { patch, problems };
}

export const isEmptyUi = (ui: UiPrefs | undefined): boolean => ui === undefined || (ui.route === undefined && ui.perProject === undefined && ui.setup === undefined);

const sameProjectPrefs = (a: UiProjectPrefs, b: UiProjectPrefs): boolean => a.sessionKey === b.sessionKey && a.conversationId === b.conversationId;

/**
 * Applies a (checked) change. Never edits its arguments. An entry that does not change keeps its place, so a patch that changes
 * nothing leaves the serialised blob identical; an entry that changes moves to the end, which makes the front the least recently
 * changed project, the one forgotten when the limit is passed.
 */
export function mergeUi(base: UiPrefs | undefined, patch: UiPrefsPatch): UiPrefs {
  const out: UiPrefs = {};

  const route = patch.route === undefined ? base?.route : patch.route ?? undefined;
  if (route) out.route = { projectId: route.projectId, view: route.view };

  const entries = new Map<string, UiProjectPrefs>(Object.entries(base?.perProject ?? {}));
  for (const [id, change] of Object.entries(patch.perProject ?? {})) {
    if (change === null) { entries.delete(id); continue; }
    const before = entries.get(id);
    const next: UiProjectPrefs = {};
    const sessionKey = change.sessionKey === undefined ? before?.sessionKey : change.sessionKey ?? undefined;
    const conversationId = change.conversationId === undefined ? before?.conversationId : change.conversationId ?? undefined;
    if (sessionKey !== undefined) next.sessionKey = sessionKey;
    if (conversationId !== undefined) next.conversationId = conversationId;
    if (next.sessionKey === undefined && next.conversationId === undefined) { entries.delete(id); continue; }
    if (before && sameProjectPrefs(before, next)) continue;
    entries.delete(id);
    entries.set(id, next);
  }
  while (entries.size > UI_LIMITS.projects) entries.delete(entries.keys().next().value as string);
  if (entries.size > 0) out.perProject = Object.fromEntries(entries);

  const dismissed = patch.setup?.dismissed === undefined ? base?.setup?.dismissed : patch.setup.dismissed ?? undefined;
  const seenEmpty = patch.setup?.seenEmpty === undefined ? base?.setup?.seenEmpty : patch.setup.seenEmpty ?? undefined;
  if (dismissed !== undefined || seenEmpty !== undefined) {
    out.setup = {};
    if (dismissed !== undefined) out.setup.dismissed = dismissed;
    if (seenEmpty !== undefined) out.setup.seenEmpty = seenEmpty;
  }
  return out;
}

/** What was stored, repaired: whatever is valid is kept, whatever is not (or not known to this build) is dropped. */
export function sanitizeStoredUi(input: unknown): UiPrefs | undefined {
  if (input === undefined) return undefined;
  const merged = mergeUi(undefined, checkUiPatch(input).patch);
  return isEmptyUi(merged) ? undefined : merged;
}

/** Merge a patch into settings, section by section, returning a new object. Unknown keys are ignored. */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const out = structuredClone(base) as Settings;
  const merge = (target: Record<string, unknown>, p: Record<string, unknown> | undefined) => {
    if (!p) return;
    for (const [k, v] of Object.entries(p)) {
      if (!(k in target) || v === undefined) continue;
      const cur = target[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
        merge(cur as Record<string, unknown>, v as Record<string, unknown>);
      } else target[k] = v;
    }
  };
  const { ui, ...sections } = patch;
  merge(out as unknown as Record<string, unknown>, sections as Record<string, unknown>);
  // The window's memory is not a fixed shape, so it has its own merge. It is absent until something is stored.
  if (ui !== undefined) {
    const merged = mergeUi(out.ui, checkUiPatch(ui).patch);
    if (isEmptyUi(merged)) delete out.ui; else out.ui = merged;
  }
  return out;
}
