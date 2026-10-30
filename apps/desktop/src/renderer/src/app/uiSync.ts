// Keeps what the window remembers (the selected project and view, each project's session tab and conversation, the setup
// checklist's flags) in the core, which is the durable home: the window's own localStorage belongs to the page origin, and the
// origin changes when the core has to take another port.
//
//   start      After the first snapshot of the core arrives, the core's copy is applied to the window (it wins over localStorage,
//              except for a fact the person changed in this run), and what only the window has is sent to the core.
//   afterwards A change to a remembered fact is noted and sent to the core after a short quiet period, as ONE patch that names
//              only the facts that changed (so two windows never overwrite each other's choices).
//   failure    A write that fails is kept and tried again later, with growing pauses and as soon as the connection is live
//              again. Nothing is shown and nothing is logged: the window works on its localStorage copy meanwhile. A refusal
//              that retrying cannot fix (a 4xx) drops the change.
//   closing    When the page goes away, whatever is waiting is sent with a request that outlives the page.
//   restart    A change that the core has not acknowledged yet is also written to localStorage (a list of fact names). On the next
//              start it counts as newer than the core's copy, so it wins and is sent, instead of an older value of the core's
//              overriding what the person did just before closing the window.
//
// localStorage stays the fast local copy: the route store and the onboarding store keep writing it as they always did.
import { ApiError } from '@minisumma/shared';
import type { ServerEvent, UiPrefsPatch } from '@minisumma/shared';
import type { ApiClient } from './api';
import type { OnboardingStore } from './onboardingPrefs';
import type { RouteStore } from './route';
import { readJson, writeJson } from './storage';
import type { KeyValueStorage } from './storage';
import type { AppState, AppStore } from './store';
import { buildPatch, changedRouteFacts, changedSetupFacts, forgetFact, reconcile, routeMemory, sessionFact, conversationFact } from './uiState';
import type { FactKey, Memory } from './uiState';

export interface UiSyncOptions {
  api: Pick<ApiClient, 'call'> & { events: { onEvent(handler: (seq: number, event: ServerEvent) => void): () => void } };
  store: AppStore;
  route: RouteStore;
  onboarding: OnboardingStore;
  /** Where the names of the changes the core has not acknowledged yet are kept, so that they survive a restart. Optional. */
  storage?: KeyValueStorage;
  /** The quiet period before changes are sent. Default 600 ms. */
  delayMs?: number;
  /** Pauses between tries after a failed write. Defaults: 2 s, doubling up to 60 s. */
  retry?: { firstMs: number; maxMs: number };
  /** Sends a change as the page closes (a request that outlives the page). Without it nothing extra happens on close. */
  sendOnClose?: (body: { ui: UiPrefsPatch }) => void;
}

export interface UiSync {
  /** Send what is waiting, now. Resolves true when nothing is waiting any more. */
  flush(): Promise<boolean>;
  /** The facts that have not reached the core yet. */
  pending(): FactKey[];
  dispose(): void;
}

const PENDING_KEY = 'minisumma.uisync.pending.v1';
const MAX_PENDING = 500;

/** The names of the changes that were waiting for the core when the window last closed; anything else in the value is ignored. */
function validatePending(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length < 300).slice(0, MAX_PENDING);
}

/** A refusal that sending the same thing again cannot fix. */
export const isPermanentRefusal = (error: unknown): boolean =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);

export function createUiSync(options: UiSyncOptions): UiSync {
  const { api, store, route, onboarding, storage } = options;
  const delayMs = options.delayMs ?? 600;
  const retry = options.retry ?? { firstMs: 2000, maxMs: 60_000 };

  /** fact -> the version of the change that made it dirty. A fact changed again while a write is in flight keeps waiting. */
  const dirty = new Map<FactKey, number>();
  let version = 0;
  // Changes the core never acknowledged before the window last closed are still waiting: they are newer than anything it has.
  for (const fact of (storage ? readJson(storage, PENDING_KEY, validatePending) : null) ?? []) dirty.set(fact, ++version);
  const remember = (): void => { if (storage) writeJson(storage, PENDING_KEY, [...dirty.keys()].slice(0, MAX_PENDING)); };
  let hydrated = false;
  let applying = false;
  let disposed = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pause = retry.firstMs;
  let chain: Promise<boolean> = Promise.resolve(true);

  const memory = (): Memory => {
    const o = onboarding.getState();
    return { route: routeMemory(route.getState()), setup: { dismissed: o.dismissed, seenEmpty: o.seenEmpty } };
  };

  const clearQuiet = (): void => { if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; } };
  const clearRetry = (): void => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };

  function schedule(ms: number): void {
    if (!hydrated || disposed || dirty.size === 0 || retryTimer) return; // a pending retry will carry everything
    clearQuiet();
    quietTimer = setTimeout(() => { quietTimer = null; void flush(); }, ms);
  }

  function mark(facts: readonly FactKey[]): void {
    if (facts.length === 0) return;
    for (const fact of facts) dirty.set(fact, ++version);
    remember();
    schedule(delayMs);
  }

  async function send(): Promise<boolean> {
    clearQuiet();
    if (!hydrated || disposed) return dirty.size === 0;
    if (dirty.size === 0) return true;
    const waiting = new Map(dirty);
    const { patch, included } = buildPatch(waiting.keys(), memory());
    const settle = (): void => { for (const fact of included) if (dirty.get(fact) === waiting.get(fact)) dirty.delete(fact); remember(); };
    if (included.size === 0) { for (const fact of waiting.keys()) dirty.delete(fact); remember(); return true; } // nothing here this build can send
    if (Object.keys(patch).length === 0) { settle(); if (dirty.size > 0) schedule(delayMs); return dirty.size === 0; } // nothing here the core would accept
    try {
      await api.call('settings.update', { body: { ui: patch } });
    } catch (error) {
      if (isPermanentRefusal(error)) { settle(); return dirty.size === 0; }
      if (!disposed && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, pause);
        pause = Math.min(pause * 2, retry.maxMs);
      }
      return false;
    }
    pause = retry.firstMs;
    settle();
    if (dirty.size > 0) schedule(delayMs);
    return dirty.size === 0;
  }

  const flush = (): Promise<boolean> => (chain = chain.then(send, send));

  // ------------------------------------------------------------------------------------------ local changes

  const offRoute = route.subscribe((state, prev) => {
    if (applying) return;
    mark(changedRouteFacts(routeMemory(prev), routeMemory(state)));
  });
  const offOnboarding = onboarding.subscribe((state, prev) => {
    if (applying) return;
    mark(changedSetupFacts({ dismissed: prev.dismissed, seenEmpty: prev.seenEmpty }, { dismissed: state.dismissed, seenEmpty: state.seenEmpty }));
  });

  // A removed project takes its remembered choices with it.
  const offEvents = api.events.onEvent((_seq, event) => {
    if (event.type !== 'project.removed') return;
    const id = event.id;
    dirty.delete(sessionFact(id));
    dirty.delete(conversationFact(id));
    remember();
    applying = true;
    try {
      const { selectSession, selectConversation } = route.getState();
      selectSession(id, null);
      selectConversation(id, null);
    } finally { applying = false; }
    mark([forgetFact(id)]);
  });

  // ------------------------------------------------------------------------------------------ the core's copy

  function hydrate(state: AppState): void {
    hydrated = true;
    const local = memory();
    const result = reconcile(local, state.settings?.ui, { projects: state.projects, touched: new Set(dirty.keys()) });
    applying = true;
    try {
      if (Object.keys(result.route).length > 0) route.setState(result.route);
      if (Object.keys(result.setup).length > 0) onboarding.setState(result.setup);
    } finally { applying = false; }
    for (const fact of result.seed) if (!dirty.has(fact)) dirty.set(fact, ++version);
    remember();
    schedule(delayMs);
  }

  // Applied the moment the snapshot lands, before the screens that read it render, so the window opens where it was left
  // instead of showing the first project for a moment.
  const offStore = store.subscribe((state, prev) => {
    if (!hydrated && state.loaded) hydrate(state);
    if (state.connection === 'live' && prev.connection !== 'live' && dirty.size > 0) {
      clearRetry();
      pause = retry.firstMs;
      schedule(0);
    }
  });
  if (store.getState().loaded) hydrate(store.getState());

  const onPageHide = (): void => {
    if (!hydrated || dirty.size === 0 || !options.sendOnClose) return;
    const { patch } = buildPatch(dirty.keys(), memory());
    if (Object.keys(patch).length > 0) options.sendOnClose({ ui: patch });
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return {
    flush,
    pending: () => [...dirty.keys()],
    dispose() {
      disposed = true;
      clearQuiet();
      clearRetry();
      offRoute();
      offOnboarding();
      offEvents();
      offStore();
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    },
  };
}
