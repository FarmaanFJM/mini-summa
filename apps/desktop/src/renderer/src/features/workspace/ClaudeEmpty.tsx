import type { Project } from '@minisumma/shared';
import { Button, EmptyState } from '../../ui';
import { MODE_LABEL, modesFix, primaryMode, sessionModes } from './sessionModes';
import type { SessionMode } from './sessionModes';

export interface ClaudeEmptyProps {
  project: Pick<Project, 'name' | 'roots' | 'githubRepo'>;
  /** A local session is being started. */
  starting: boolean;
  /** Another main button is on screen (a report waits for its handoff), so none here is the emphasised one. */
  quiet: boolean;
  onChoose: (mode: SessionMode) => void;
  /** Open the project settings, where a folder or a repository is added. */
  onFix: () => void;
}

const ICON = { cloud: 'cloud', temporary: 'download', existing: 'terminal' } as const;

/**
 * A Claude pane with no session tab: the three ways to start one. At most one is the main button (the existing folder when there is one,
 * else the cloud). One that cannot start says why in words, with the way to fix it beside the reason; another is never started in its place.
 */
export function ClaudeEmpty({ project, starting, quiet, onChoose, onFix }: ClaudeEmptyProps) {
  const primary = primaryMode(project);
  const modes = sessionModes(project);
  const fix = modesFix(project);
  if (primary === null) {
    return (
      <div className="ms-claude__body ms-claude__empty">
        <EmptyState center action={<Button variant={quiet ? 'secondary' : 'primary'} icon="settings" onClick={onFix}>{fix}</Button>}>
          Existing sessions need a folder on this computer. Cloud and temporary sessions need a GitHub repository.
        </EmptyState>
      </div>
    );
  }
  const variant = (m: SessionMode) => (primary === m && !quiet ? 'primary' : 'secondary');
  const missing = (['existing', 'cloud'] as const).map((m) => modes[m].reason).find((r) => r !== null) ?? null;
  return (
    <div className="ms-claude__body ms-claude__empty">
      <EmptyState
        center
        action={(
          <>
            <div className="ms-ws-starts">
              {(['existing', 'cloud', 'temporary'] as const).map((m) => (
                <Button key={m} variant={variant(m)} icon={ICON[m]} loading={starting && m === 'existing'} disabled={!modes[m].available} onClick={() => onChoose(m)}>{MODE_LABEL[m]}</Button>
              ))}
            </div>
            {missing ? (
              <p className="ms-claude__why">
                {missing}{' '}
                <button type="button" className="ms-ws-link" onClick={onFix}>{fix}</button>
              </p>
            ) : null}
          </>
        )}
      >
        No Claude session is open.
      </EmptyState>
    </div>
  );
}
