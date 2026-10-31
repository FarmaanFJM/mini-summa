import { Toaster } from '../ui';
import OnboardingGate from '../features/onboarding';
import { Shell } from '../features/shell/Shell';
import { RuntimeProvider } from './runtime';
import type { Runtime } from './runtime';

export function App({ runtime }: { runtime: Runtime }) {
  return (
    <RuntimeProvider runtime={runtime}>
      <OnboardingGate>
        <Shell />
      </OnboardingGate>
      <Toaster />
    </RuntimeProvider>
  );
}
