// Extension point: the second UI worker replaces this with the first-run flow (hooks consent, folder and conversation
// setup). The shell wraps itself in this component, so it may render its own screens instead of `children` until the
// person has finished onboarding.
import type { ReactNode } from 'react';

export default function OnboardingGate({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
