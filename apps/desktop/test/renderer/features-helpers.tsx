// Test harness for the reports, activity, settings and onboarding views: the real renderer on the demo core, with the
// feature scenes added (a long report, code fences, unmarked messages, a phone prompt, sessions in every state).
import type { NavigationTarget } from '@minisumma/shared';
import { render, waitFor } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { RuntimeProvider } from '../../src/renderer/src/app/runtime';
import type { ViewId } from '../../src/renderer/src/app/route';
import OnboardingGate from '../../src/renderer/src/features/onboarding';
import { Shell } from '../../src/renderer/src/features/shell/Shell';
import { Toaster } from '../../src/renderer/src/ui';
import { featureState } from '../../src/renderer/src/dev/demo/features-handlers';
import type { FeatureDemoState } from '../../src/renderer/src/dev/demo/features-handlers';
import { createFeatureSeed } from '../../src/renderer/src/dev/demo/features-seed';
import type { DemoServer } from '../../src/renderer/src/dev/demo/server';
import { createHarness } from './helpers';
import type { Harness, HarnessOptions } from './helpers';

export interface FeatureOptions extends HarnessOptions {
  /** The view to open. Default: reports. */
  view?: ViewId;
  /** More of the route (a report, a delivery, a settings section). */
  route?: Partial<NavigationTarget>;
  /** Wrap the shell in the onboarding gate, as the real app does. Default false. */
  gate?: boolean;
}

export interface FeatureApp extends Harness, RenderResult {
  server: DemoServer;
  /** The knobs of the demo core that only the feature routes use (clipboard path, failures, tailscale state, ...). */
  demoState: FeatureDemoState;
}

export async function renderFeature(options: FeatureOptions = {}): Promise<FeatureApp> {
  const { view = 'reports', route, gate = false, ...rest } = options;
  const harness = createHarness({ seed: createFeatureSeed(), ...rest });
  harness.runtime.route.getState().go({ view, ...route });
  document.getElementById('root')?.remove();
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  const body = gate ? <OnboardingGate><Shell /></OnboardingGate> : <Shell />;
  const rendered = render(<RuntimeProvider runtime={harness.runtime}>{body}<Toaster /></RuntimeProvider>, { container });
  if (options.startLoader !== false && (options.scenario ?? 'normal') === 'normal') {
    await waitFor(() => {
      const s = harness.runtime.store.getState();
      if (s.connection !== 'live' || Object.values(s.listStatus).some((v) => v === 'loading' || v === 'idle')) throw new Error('still loading');
    });
  }
  const server = harness.demo.demo.server;
  return { ...harness, ...rendered, server, demoState: featureState(server.data) };
}

/** Reads the text of a node the way a person sees it: collapsed whitespace, no markup. */
export const textOf = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The routes a test spied on, by name, with their input. */
export function callsTo(spy: { mock: { calls: unknown[][] } }, name: string): unknown[] {
  return spy.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
}

/** The terms and descriptions of a definition list, as { term: description } in the text a person reads. */
export function factsOf(list: Element | null): Record<string, string> {
  const out: Record<string, string> = {};
  list?.querySelectorAll('dt').forEach((dt) => {
    const dd = dt.nextElementSibling;
    if (dd) out[textOf(dt)] = textOf(dd);
  });
  return out;
}
