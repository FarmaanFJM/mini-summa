import type { Project } from '@minisumma/shared';
import { Button, EmptyState } from '../../ui';
import { claudeStart } from './claudeCloud';

export interface ClaudeEmptyProps {
  project: Pick<Project, 'name' | 'roots' | 'githubRepo'>;
  /** A local session is being started. */
  starting: boolean;
  /** Another main button is on screen (a report waits for its handoff), so none here is the emphasised one. */
  quiet: boolean;
  onLocal: () => void;
  onCloud: () => void;
  /** Open the project settings, where a folder or a repository is added. */
  onFix: () => void;
}

/**
 * A Claude pane with no session tab: the two ways to start one, local on this computer and cloud on GitHub. At most one of them is
 * the main button (Local when there is a folder, else Cloud when there is a repository). One that cannot start says why in words,
 * with the way to fix it beside the reason; the other is never started in its place.
 */
export function ClaudeEmpty({ project, starting, quiet, onLocal, onCloud, onFix }: ClaudeEmptyProps) {
  const choices = claudeStart(project);
  if (choices.primary === null) {
    return (
      <div className="ms-claude__body ms-claude__empty">
        <EmptyState center action={<Button variant={quiet ? 'secondary' : 'primary'} icon="settings" onClick={onFix}>{choices.fix}</Button>}>
          Local sessions need a folder on this computer, cloud sessions a GitHub repository.
        </EmptyState>
      </div>
    );
  }
  const variant = (which: 'local' | 'cloud') => (choices.primary === which && !quiet ? 'primary' : 'secondary');
  const missing = !choices.local.available ? choices.local.reason : !choices.cloud.available ? choices.cloud.reason : null;
  return (
    <div className="ms-claude__body ms-claude__empty">
      <EmptyState
        center
        action={(
          <>
            <div className="ms-ws-starts">
              <Button variant={variant('local')} icon="terminal" loading={starting} disabled={!choices.local.available} onClick={onLocal}>New local session</Button>
              <Button variant={variant('cloud')} icon="cloud" disabled={!choices.cloud.available} onClick={onCloud}>New cloud session</Button>
            </div>
            {missing ? (
              <p className="ms-claude__why">
                {missing}{' '}
                <button type="button" className="ms-ws-link" onClick={onFix}>{choices.fix}</button>
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
