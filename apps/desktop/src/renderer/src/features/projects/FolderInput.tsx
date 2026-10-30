// A folder typed or chosen: the reading of the path as it is typed, and the one question a Linux path on Windows needs answered
// (which WSL distribution it is in). Used by the new project dialog and by the folders of the project settings.
import { envLabel } from '@minisumma/shared';
import type { EnvId, EnvironmentInfo } from '@minisumma/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp } from '../../app/runtime';
import { Select } from '../../ui';
import { isHostPlatform } from './readings';
import type { FolderReading, HostPlatform } from './readings';

/** The platform of the computer that runs Mini-Summa: what the core says, else what the window knows. */
export function useHostPlatform(): HostPlatform {
  const native = useNative();
  const reported = useApp((s) => s.system?.platform);
  return isHostPlatform(reported) ? reported : native.platform;
}

/** The WSL distributions of this computer, asked for once and only when a path needs one. */
function useDistros(needed: boolean): { distros: EnvironmentInfo[]; loading: boolean } {
  const api = useApi();
  const [environments, setEnvironments] = useState<EnvironmentInfo[] | null>(null);
  useEffect(() => {
    if (!needed || environments !== null) return undefined;
    let cancelled = false;
    api.call('environments.list').then((list) => { if (!cancelled) setEnvironments(list); }, () => { if (!cancelled) setEnvironments([]); });
    return () => { cancelled = true; };
  }, [needed, environments, api]);
  const distros = useMemo(() => (environments ?? []).filter((e) => e.id.startsWith('wsl:')), [environments]);
  return { distros, loading: environments === null };
}

export interface FolderReadingViewProps {
  reading: FolderReading;
  distro: EnvId | null;
  onDistro(distro: EnvId): void;
}

/** Under the path field: where the folder is (Windows or a WSL distribution), the cleaned path, and the question when it is needed. */
export function FolderReadingView({ reading, distro, onDistro }: FolderReadingViewProps) {
  const needsDistro = reading.kind === 'needs-distro';
  const { distros, loading } = useDistros(needsDistro);
  return (
    <div className="ms-pj-reading" aria-live="polite">
      {reading.kind === 'ok' ? (
        <>
          <p><span className="ms-pj-reading__label">{envLabel(reading.env)}</span> <span className="ms-mono">{reading.path}</span></p>
          {reading.note ? <p className="ms-pj-reading__note">{reading.note}</p> : null}
        </>
      ) : null}
      {reading.kind === 'needs-distro' ? (
        <div className="ms-pj-question">
          <p className="ms-pj-reading__note">{reading.message}</p>
          {distros.length > 0 ? (
            <Select
              aria-label="WSL distribution"
              placeholder="Which WSL distribution is this path in?"
              value={distro}
              onChange={onDistro}
              options={distros.map((d) => ({ value: d.id, label: d.label, description: d.available ? undefined : 'Not available' }))}
            />
          ) : (
            <p className="ms-pj-reading__note">{loading ? 'Looking for WSL distributions.' : 'No WSL distribution was found on this PC.'}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
