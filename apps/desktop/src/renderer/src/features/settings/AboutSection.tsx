import { useApp } from '../../app/runtime';
import { useNative } from '../../app/native';
import { SetupChecklist } from '../onboarding/Checklist';
import { formatRelative } from '../workspace/sessionModel';
import { Group } from './controls';
import { platformWords } from './model';

/** Which version of what is running, and the setup checklist, which is always here for anyone who hid it. */
export function AboutSection() {
  const system = useApp((s) => s.system);
  const native = useNative();

  return (
    <div className="ms-set-page">
      <Group title="Setup" note="What Mini-Summa needs before it is useful. Each tick is read from your PC as it is now.">
        <SetupChecklist />
      </Group>

      <Group title="Mini-Summa">
        {system ? (
          <dl className="ms-x-kv" aria-label="About Mini-Summa">
            <dt>Version</dt><dd>{system.version}</dd>
            <dt>Running as</dt><dd>{system.mode === 'embedded' ? 'The desktop app, with its own core' : 'A core without a window (headless)'}</dd>
            <dt>Computer</dt><dd>{platformWords(system.platform)}</dd>
            <dt>Started</dt><dd>{formatRelative(system.startedAt) || 'just now'}</dd>
            <dt>This window</dt><dd>{native.kind === 'electron' ? `The desktop app, version ${native.appVersion}` : 'A web browser pointed at the core'}</dd>
            <dt>API version</dt><dd>{system.apiVersion}</dd>
          </dl>
        ) : (
          <p className="ms-x-note">Mini-Summa has not reported its version yet.</p>
        )}
      </Group>
    </div>
  );
}
