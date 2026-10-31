// SettingsService: the one JSON document under kv key 'settings'.
//
// Load  = defaultSettings() merged with whatever is stored, field by field. A key the build does not know is dropped,
//         a key the stored value lacks is defaulted, a stored value of the wrong type falls back to the default. So a
//         database written by an older or a newer build always loads.
// Update = validate and clamp the patch (settings-schema.ts), merge with the shared mergeSettings, persist, then emit
//         `settings.changed` and call the listeners. Nothing is emitted for a patch that changes nothing.
// No secrets live here. The Firebase service account is a separate 0600 file (push.ts).
//
// `ui` is what the desktop window remembers between runs (selected project and view, each project's session tab and conversation,
// the setup checklist's flags). It lives here because the window's own storage belongs to the page origin, and the origin changes
// when the core takes another port. It is optional (absent until the window stores something), bounded, and strict: an update that
// names a key it does not know is a 400 (settings-schema.ts, checkUiPatch in @minisumma/shared). Its patches merge by key, so two
// windows writing different choices do not overwrite each other (mergeUi in @minisumma/shared).
import { defaultSettings, mergeSettings } from '@minisumma/shared';
import type { Settings, SettingsPatch } from '@minisumma/shared';
import { fromJson, toJson } from '@minisumma/storage';
import type { CoreBase, SettingsService } from '../contracts.ts';
import { lenientPartial, strictPatch } from './settings-schema.ts';

export interface SettingsDeps {
  base: Pick<CoreBase, 'db' | 'bus' | 'clock' | 'log'>;
}

const KEY = 'settings';

export function createSettingsService(deps: SettingsDeps): SettingsService {
  const { db, bus, clock, log } = deps.base;
  const listeners = new Set<(next: Settings, prev: Settings) => void>();

  function load(): Settings {
    const row = db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', [KEY]);
    const stored = fromJson<unknown>(row?.value_json, null);
    return mergeSettings(defaultSettings(), lenientPartial(stored) as SettingsPatch);
  }

  let current = load();

  return {
    get: () => structuredClone(current),

    update(patch: SettingsPatch): Settings {
      const prev = current;
      const next = mergeSettings(prev, strictPatch(patch) as SettingsPatch);
      if (toJson(next) === toJson(prev)) return structuredClone(prev);

      db.run(
        `INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [KEY, toJson(next), clock.now().toISOString()],
      );
      current = next;

      // After the commit: the event first so clients see the change, then in-process listeners. A listener that throws
      // must not undo or hide a change that is already saved.
      bus.emit({ type: 'settings.changed', settings: structuredClone(next) });
      for (const fn of [...listeners]) {
        try { fn(structuredClone(next), structuredClone(prev)); } catch (err) {
          log.warn('A settings listener failed.', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return structuredClone(next);
    },

    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
