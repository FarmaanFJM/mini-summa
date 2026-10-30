// Infrastructure services, part 1: settings, projects, devices, remote access, push, data retention.
// (Hooks, the extension bridge and the HTTP server are exported by their own modules.)
export { createSettingsService } from './settings.ts';
export type { SettingsDeps } from './settings.ts';
export { createProjectsService } from './projects.ts';
export type { ProjectsDeps } from './projects.ts';
export { createDevicesService, OFFER_TTL_MS, MAX_CODE_ATTEMPTS, LAST_SEEN_INTERVAL_MS } from './devices.ts';
export type { DevicesDeps } from './devices.ts';
export { createTailscaleService } from './tailscale.ts';
export type { TailscaleDeps, TailscaleServiceImpl } from './tailscale.ts';
export { createFcmProvider } from './push.ts';
export type { FcmDeps } from './push.ts';
export { createDataService } from './data.ts';
export type { DataDeps, PruneTarget } from './data.ts';
