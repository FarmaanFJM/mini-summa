// The only thing remembered about setup is whether the person wants the checklist on screen. Which steps are done is never
// stored: it is read from the core every time (model.ts). The store itself lives in app/onboardingPrefs.ts, because the runtime
// also keeps it in step with the core (app/uiSync.ts).
import { useStore } from 'zustand';
import { useRuntime } from '../../app/runtime';
import { onboardingStore } from '../../app/onboardingPrefs';
import type { OnboardingActions, OnboardingPrefs } from '../../app/onboardingPrefs';

export { onboardingStore } from '../../app/onboardingPrefs';
export type { OnboardingActions, OnboardingPrefs, OnboardingStore } from '../../app/onboardingPrefs';

export function useOnboarding(): OnboardingPrefs & OnboardingActions {
  return useStore(onboardingStore(useRuntime().storage));
}
