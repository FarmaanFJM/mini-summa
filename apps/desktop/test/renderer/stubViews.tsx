// The shell shows the activity, reports and settings views for their routes. Those views belong to the feature worker, so the
// tests of the shell replace them with stand-ins: what is tested here is that the shell shows the right one at the right time,
// not what is inside it. A test file opts in with three hoisted mocks (vi.mock has to sit in the test file to be hoisted):
//
//   vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
//   vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
//   vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

export const ActivityStandIn = () => <section aria-label="Activity" />;
export const ReportsStandIn = () => <section aria-label="Reports" />;
export const SettingsStandIn = () => <section aria-label="Settings" />;
