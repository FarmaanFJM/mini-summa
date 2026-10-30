// What the window remembers between runs, as plain functions: which remembered facts changed, what to send to the core, and what
// to show when the core remembers something. No React, no stores, no timers: uiSync.ts wires these to them, and the tests call
// them directly.
//
// The core keeps the memory (Settings.ui) because the window's own storage belongs to the page origin, and the origin changes
// when the core has to take another port. localStorage stays as the fast local copy; when both have a value, the core wins.
import { checkUiPatch, UI_LIMITS } from '@minisumma/shared';
import type { Project, SessionKey, UiPrefs, UiPrefsPatch } from '@minisumma/shared';
import type { ViewId } from './route';

/** The facts of the route that are remembered. */
export interface RouteMemory {
  view: ViewId;
  projectId: string | null;
  sessionByProject: Record<string, SessionKey>;
  conversationByProject: Record<string, string>;
  /** The last page of Claude Code on the web each project's Cloud tab was on. */
  cloudUrlByProject: Record<string, string>;
}

export interface SetupMemory {
  dismissed: boolean;
  seenEmpty: boolean;
}

export interface Memory {
  route: RouteMemory;
  setup: SetupMemory;
}

/**
 * One remembered fact, named by what it is about: `route`, `session:<project id>`, `conversation:<project id>`,
 * `cloud:<project id>` (the page of Claude Code on the web), `setup:dismissed`, `setup:seenEmpty`, or `forget:<project id>`
 * (the project was removed). A change to a fact marks it dirty until the core has it.
 */
export type FactKey = string;

const SESSION = 'session:';
const CONVERSATION = 'conversation:';
const CLOUD = 'cloud:';
const FORGET = 'forget:';
export const sessionFact = (projectId: string): FactKey => `${SESSION}${projectId}`;
export const conversationFact = (projectId: string): FactKey => `${CONVERSATION}${projectId}`;
export const cloudFact = (projectId: string): FactKey => `${CLOUD}${projectId}`;
export const forgetFact = (projectId: string): FactKey => `${FORGET}${projectId}`;

/** The route as the store holds it: the remembered facts, and the in-memory choice of which tab of a project's Claude pane is shown. */
export type RouteSource = RouteMemory & { cloudShown?: Readonly<Record<string, unknown>> };

/**
 * What the window tells the core about the route, which is what is on screen. A project whose Cloud tab is shown shows no local
 * session, so none is remembered for it (the core reads this to know whether the person is looking at a session; a session that
 * finishes in the background must not be taken for the one in front of them). The store keeps the last local choice, so
 * leaving the Cloud tab remembers it again.
 */
export function routeMemory(s: RouteSource): RouteMemory {
  let sessionByProject = s.sessionByProject;
  for (const id of Object.keys(s.cloudShown ?? {})) {
    if (!(id in sessionByProject)) continue;
    if (sessionByProject === s.sessionByProject) sessionByProject = { ...s.sessionByProject };
    delete sessionByProject[id];
  }
  return { view: s.view, projectId: s.projectId, sessionByProject, conversationByProject: s.conversationByProject, cloudUrlByProject: s.cloudUrlByProject };
}

/** The route exactly as the store holds it, the last local session of a project included whatever tab shows. */
export const storedRouteMemory = (s: RouteMemory): RouteMemory => ({
  view: s.view, projectId: s.projectId, sessionByProject: s.sessionByProject, conversationByProject: s.conversationByProject, cloudUrlByProject: s.cloudUrlByProject,
});

const ids = (a: object, b: object): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])];

/** Which remembered facts differ between two states of the route. */
export function changedRouteFacts(prev: RouteMemory, next: RouteMemory): FactKey[] {
  const out: FactKey[] = [];
  if (prev.view !== next.view || prev.projectId !== next.projectId) out.push('route');
  if (prev.sessionByProject !== next.sessionByProject) {
    for (const id of ids(prev.sessionByProject, next.sessionByProject)) if (prev.sessionByProject[id] !== next.sessionByProject[id]) out.push(sessionFact(id));
  }
  if (prev.conversationByProject !== next.conversationByProject) {
    for (const id of ids(prev.conversationByProject, next.conversationByProject)) if (prev.conversationByProject[id] !== next.conversationByProject[id]) out.push(conversationFact(id));
  }
  if (prev.cloudUrlByProject !== next.cloudUrlByProject) {
    for (const id of ids(prev.cloudUrlByProject, next.cloudUrlByProject)) if (prev.cloudUrlByProject[id] !== next.cloudUrlByProject[id]) out.push(cloudFact(id));
  }
  return out;
}

export function changedSetupFacts(prev: SetupMemory, next: SetupMemory): FactKey[] {
  const out: FactKey[] = [];
  if (prev.dismissed !== next.dismissed) out.push('setup:dismissed');
  if (prev.seenEmpty !== next.seenEmpty) out.push('setup:seenEmpty');
  return out;
}

export interface BuiltPatch {
  patch: UiPrefsPatch;
  /** The facts that went into the patch (or could never be sent). The rest wait for the next one. */
  included: Set<FactKey>;
}

/**
 * The change that tells the core about these facts, with the values they have now. Only what the core accepts is in it: a value
 * that could never be accepted (an id that is too long) is left out rather than sent, so one bad value cannot hold up the rest.
 * At most UI_LIMITS.projects projects go in one change; the facts of the others stay for the next one.
 */
export function buildPatch(facts: Iterable<FactKey>, now: Memory): BuiltPatch {
  const raw: UiPrefsPatch = {};
  const included = new Set<FactKey>();
  type Entry = { sessionKey?: SessionKey | null; conversationId?: string | null; cloudUrl?: string | null };
  const projects = new Map<string, Entry | null>();
  const projectEntry = (id: string): Entry | null | undefined => {
    if (!projects.has(id) && projects.size >= UI_LIMITS.projects) return undefined; // no room: next time
    const current = projects.get(id);
    if (current === null) return null;
    if (current) return current;
    const fresh = {};
    projects.set(id, fresh);
    return fresh;
  };
  for (const fact of facts) {
    if (fact === 'route') raw.route = { projectId: now.route.projectId, view: now.route.view };
    else if (fact === 'setup:dismissed') raw.setup = { ...raw.setup, dismissed: now.setup.dismissed };
    else if (fact === 'setup:seenEmpty') raw.setup = { ...raw.setup, seenEmpty: now.setup.seenEmpty };
    else if (fact.startsWith(SESSION)) {
      const id = fact.slice(SESSION.length);
      const e = projectEntry(id);
      if (e === undefined) continue;
      if (e) e.sessionKey = now.route.sessionByProject[id] ?? null;
    } else if (fact.startsWith(CONVERSATION)) {
      const id = fact.slice(CONVERSATION.length);
      const e = projectEntry(id);
      if (e === undefined) continue;
      if (e) e.conversationId = now.route.conversationByProject[id] ?? null;
    } else if (fact.startsWith(CLOUD)) {
      const id = fact.slice(CLOUD.length);
      const e = projectEntry(id);
      if (e === undefined) continue;
      if (e) e.cloudUrl = now.route.cloudUrlByProject[id] ?? null;
    } else if (fact.startsWith(FORGET)) {
      const id = fact.slice(FORGET.length);
      if (!projects.has(id) && projects.size >= UI_LIMITS.projects) continue;
      projects.set(id, null);
    } else continue; // not a fact this build knows
    included.add(fact);
  }
  if (projects.size > 0) raw.perProject = Object.fromEntries(projects);
  // Whatever the core would refuse is dropped here: this is the same check the core makes.
  return { patch: checkUiPatch(raw).patch, included };
}

export interface Reconciled {
  /** What to set on the route store. Empty when the window already agrees with the core. */
  route: Partial<RouteMemory>;
  setup: Partial<SetupMemory>;
  /** Facts this window has and the core does not: send them, so the core becomes the durable copy (an upgrade, or a core that lost them). */
  seed: FactKey[];
}

const sameMap = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = ids(a, b);
  return keys.every((k) => a[k] === b[k]);
};

/**
 * Decides what the window shows after the core's snapshot arrived. The rules:
 *  - a value the core has wins over the window's own copy, except for a fact the person already changed in this run;
 *  - the project is used only if it still exists (and is not archived); otherwise the window's own choice if that one exists, else
 *    none, which shows the first project;
 *  - a value only the window has is sent to the core;
 *  - session keys and conversation ids are taken as they are: a key or id that is gone is handled where it is used (the newest
 *    session tab, the preferred conversation), because it can come back (a session resumes, a conversation is added again);
 *  - the same goes for the page of Claude Code on the web: it is an address on claude.ai/code and nothing more, and opening it
 *    is the Cloud tab's business.
 */
export function reconcile(local: Memory, remembered: UiPrefs | undefined, ctx: { projects: readonly Project[]; touched: ReadonlySet<FactKey> }): Reconciled {
  const result: Reconciled = { route: {}, setup: {}, seed: [] };
  const existing = new Set(ctx.projects.filter((p) => p.archivedAt === null).map((p) => p.id));
  const known = new Set(ctx.projects.map((p) => p.id));
  const usable = (id: string | null): id is string => id !== null && existing.has(id);

  if (!ctx.touched.has('route')) {
    if (remembered?.route) {
      const wanted = remembered.route.projectId;
      const projectId = usable(wanted) ? wanted : usable(local.route.projectId) ? local.route.projectId : null;
      if (remembered.route.view !== local.route.view) result.route.view = remembered.route.view;
      if (projectId !== local.route.projectId) result.route.projectId = projectId;
      if (wanted !== null && projectId !== wanted && projectId !== null) result.seed.push('route'); // the core named a project that is gone: tell it where the window really is
    } else if (local.route.projectId !== null || local.route.view !== 'workspace') {
      result.seed.push('route');
    }
  }

  const sessions = { ...local.route.sessionByProject };
  const conversations = { ...local.route.conversationByProject };
  const cloudUrls = { ...local.route.cloudUrlByProject };
  for (const [id, entry] of Object.entries(remembered?.perProject ?? {})) {
    if (entry.sessionKey && !ctx.touched.has(sessionFact(id))) sessions[id] = entry.sessionKey;
    if (entry.conversationId && !ctx.touched.has(conversationFact(id))) conversations[id] = entry.conversationId;
    if (entry.cloudUrl && !ctx.touched.has(cloudFact(id))) cloudUrls[id] = entry.cloudUrl;
  }
  if (!sameMap(sessions, local.route.sessionByProject)) result.route.sessionByProject = sessions;
  if (!sameMap(conversations, local.route.conversationByProject)) result.route.conversationByProject = conversations;
  if (!sameMap(cloudUrls, local.route.cloudUrlByProject)) result.route.cloudUrlByProject = cloudUrls;

  // Choices only this window has, for projects that exist: the core should have them too.
  const seeded: FactKey[] = [];
  for (const [id, key] of Object.entries(local.route.sessionByProject)) {
    if (known.has(id) && key && !remembered?.perProject?.[id]?.sessionKey && !ctx.touched.has(sessionFact(id))) seeded.push(sessionFact(id));
  }
  for (const [id, conversationId] of Object.entries(local.route.conversationByProject)) {
    if (known.has(id) && conversationId && !remembered?.perProject?.[id]?.conversationId && !ctx.touched.has(conversationFact(id))) seeded.push(conversationFact(id));
  }
  for (const [id, url] of Object.entries(local.route.cloudUrlByProject)) {
    if (known.has(id) && url && !remembered?.perProject?.[id]?.cloudUrl && !ctx.touched.has(cloudFact(id))) seeded.push(cloudFact(id));
  }
  result.seed.push(...seeded.slice(0, UI_LIMITS.projects * 3));

  for (const flag of ['dismissed', 'seenEmpty'] as const) {
    const fact = `setup:${flag}`;
    if (ctx.touched.has(fact)) continue;
    const value = remembered?.setup?.[flag];
    if (value !== undefined) {
      if (value !== local.setup[flag]) result.setup[flag] = value;
    } else if (local.setup[flag]) result.seed.push(fact);
  }
  return result;
}
