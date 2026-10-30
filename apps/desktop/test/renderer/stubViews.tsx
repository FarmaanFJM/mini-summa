// The shell renders the activity, reports and settings views for their routes. Those views belong to the feature worker, so
// tests of the shell stub them: what is tested here is that the shell shows the right one, not what is inside it.
import { vi } from 'vitest';

export function stubFeatureViews(): void {
  vi.doMock('../../src/renderer/src/features/activity', () => ({ default: () => <section aria-label="Activity" /> }));
  vi.doMock('../../src/renderer/src/features/reports', () => ({ default: () => <section aria-label="Reports" /> }));
  vi.doMock('../../src/renderer/src/features/settings', () => ({ default: () => <section aria-label="Settings" /> }));
}
