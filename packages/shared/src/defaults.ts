import { DEFAULT_REVIEW_REQUEST } from './report-message.ts';
import type { ProjectNotificationPrefs, Settings } from './entities.ts';

export function defaultNotificationPrefs(): ProjectNotificationPrefs {
  return { enabled: true, permission: true, input: true, error: true, report: true, sessionEnded: false, presenceLost: true, push: true };
}

export function defaultSettings(): Settings {
  return {
    chatgpt: { mode: 'embedded', externalBrowser: 'default', pasteAssist: false },
    layout: { orientation: 'auto', landscapeRatio: 0.5, portraitRatio: 0.5, maximized: null, sidebarWidth: 260, sidebarCollapsed: false },
    notifications: {
      native: true,
      quiet: { enabled: false, until: null, schedule: { enabled: false, from: '22:00', to: '08:00' } },
      defaults: defaultNotificationPrefs(),
    },
    review: { requestTemplate: DEFAULT_REVIEW_REQUEST, includeSessionRef: true, maxPartChars: 12000 },
    sessions: { discoveryIntervalSec: 15, remoteControlByDefault: false, claudeCommand: null },
    mobile: { remoteAccess: 'off', push: { provider: 'none', configured: false }, promptActionTtlMinutes: 60 },
    retention: { rawEventsDays: 90, activityDays: 180, notificationsDays: 90, reportsDays: 0 },
  };
}

/** Merge a patch into settings, section by section, returning a new object. Unknown keys are ignored. */
export function mergeSettings(base: Settings, patch: import('./entities.ts').SettingsPatch): Settings {
  const out = structuredClone(base) as Settings;
  const merge = (target: Record<string, unknown>, p: Record<string, unknown> | undefined) => {
    if (!p) return;
    for (const [k, v] of Object.entries(p)) {
      if (!(k in target) || v === undefined) continue;
      const cur = target[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
        merge(cur as Record<string, unknown>, v as Record<string, unknown>);
      } else target[k] = v;
    }
  };
  merge(out as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  return out;
}
