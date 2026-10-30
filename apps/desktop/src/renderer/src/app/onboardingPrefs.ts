// The only thing remembered about setup is whether the person wants the checklist on screen. Which steps are done is never
// stored: it is read from the core every time (features/onboarding/model.ts).
//
// This file has no React in it, so the runtime can keep the two flags in step with the core (uiSync.ts) without importing a feature.
import { createStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { readJson, writeJson } from './storage';
import type { KeyValueStorage } from './storage';

const KEY = 'minisumma.onboarding.v1';

export interface OnboardingPrefs {
  /** The application was empty when it was opened: the checklist is for this installation. */
  seenEmpty: boolean;
  /** The person hid it. */
  dismissed: boolean;
}

export interface OnboardingActions {
  markSeenEmpty(): void;
  dismiss(): void;
  /** Bring the checklist back, whatever state the application is in. */
  reopen(): void;
}

export type OnboardingStore = StoreApi<OnboardingPrefs & OnboardingActions>;

function validate(raw: unknown): OnboardingPrefs | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return { seenEmpty: r.seenEmpty === true, dismissed: r.dismissed === true };
}

/** One store per storage, so a window and the settings page agree, and a test gets its own. */
const stores = new WeakMap<KeyValueStorage, OnboardingStore>();

export function onboardingStore(storage: KeyValueStorage): OnboardingStore {
  let store = stores.get(storage);
  if (!store) {
    const saved = readJson(storage, KEY, validate);
    const created = createStore<OnboardingPrefs & OnboardingActions>((set, get) => ({
      seenEmpty: saved?.seenEmpty ?? false,
      dismissed: saved?.dismissed ?? false,
      markSeenEmpty() { if (!get().seenEmpty) set({ seenEmpty: true }); },
      dismiss() { if (!get().dismissed) set({ dismissed: true }); },
      reopen() { set({ seenEmpty: true, dismissed: false }); },
    }));
    created.subscribe((s) => writeJson(storage, KEY, { seenEmpty: s.seenEmpty, dismissed: s.dismissed }));
    stores.set(storage, created);
    store = created;
  }
  return store;
}
