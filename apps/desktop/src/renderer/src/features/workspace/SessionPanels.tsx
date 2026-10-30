import { envLabel } from '@minisumma/shared';
import type { Project, SessionView } from '@minisumma/shared';
import { useEffect, useMemo, useReducer } from 'react';
import { activeProjects } from '../../app/selectors';
import { useApi, useApp, useUi } from '../../app/runtime';
import { Button, Icon, Menu, toast } from '../../ui';
import { formatRelative, isStartingUp, noticeFor, OBSERVED_WHY, RESOLUTION_TEXT, STARTING_HINT, STARTING_HINT_AFTER_MS } from './sessionModel';
import type { Notice } from './sessionModel';
import { StateDot } from './sessionParts';

export interface ResumeProps { onResume: () => void; resuming: boolean }

/** True once more than `ms` have passed since `since` (a timestamp; null means never). It re-renders its component at that moment. */
function useElapsed(since: number | null, ms: number): boolean {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const elapsed = since !== null && Date.now() - since > ms;
  useEffect(() => {
    if (since === null || elapsed) return undefined;
    const id = window.setTimeout(tick, Math.max(0, since + ms - Date.now()) + 1);
    return () => window.clearTimeout(id);
  }, [since, ms, elapsed]);
  return elapsed;
}

/**
 * A calm line under the banner: what Claude is waiting for, or what happened to a session that is no longer running. A
 * terminal that has stayed in "Starting" for a few seconds gets the hint that Claude may be asking something in it.
 */
export function SessionNotice({ session, onResume, resuming }: { session: SessionView } & ResumeProps) {
  const actions = useApp((s) => s.actions);
  const startingSince = useUi((s) => s.startingSince[session.key]?.since ?? null);
  const hintDue = useElapsed(isStartingUp(session) ? startingSince : null, STARTING_HINT_AFTER_MS);
  const starting: Notice | null = hintDue ? { tone: 'info', text: STARTING_HINT, canResume: false } : null;
  const notice = noticeFor(session, actions) ?? starting;
  if (!notice) return null;
  return (
    <div className="ms-notice" data-tone={notice.tone} role="status">
      <Icon name={notice.tone === 'info' ? 'info' : notice.tone === 'error' ? 'circle-alert' : 'warning'} />
      <span className="ms-notice__text">{notice.text}</span>
      {notice.canResume ? (
        <span className="ms-notice__actions"><Button size="sm" variant="primary" icon="history" loading={resuming} onClick={onResume}>Resume session</Button></span>
      ) : null}
    </div>
  );
}

/** Read-only view of a session Mini-Summa observes but did not start: what it is doing, why it cannot be typed into. */
export function ObservedPanel({ session, onResume, resuming }: { session: SessionView } & ResumeProps) {
  const api = useApi();
  const projects = useApp((s) => s.projects);
  const live = useApp((s) => s.connection === 'live');
  const choices = useMemo(() => activeProjects(projects), [projects]);

  const assign = async (project: Project | null) => {
    try { await api.call('sessions.bind', { params: { key: session.key }, body: { projectId: project?.id ?? null } }); }
    catch (err) { toast({ title: 'Could not assign the session', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };

  const kind = session.origin === 'background' ? 'background' : 'external';
  const canResume = session.resumable && session.availability !== 'live';
  const hint = session.remoteControl.state === 'enabled'
    ? 'Remote Control is enabled for this session.'
    : session.remoteControl.hint || 'Type /remote-control in that session to continue it from the Claude app or the web.';

  return (
    <div className="ms-observed">
      <h2 className="ms-observed__title">Observed session</h2>
      <dl className="ms-facts">
        <dt>State</dt>
        <dd><StateDot session={session} /> <span className="ms-live">{live ? session.stateLabel : `Last known: ${session.stateLabel}`}</span></dd>
        <dt>Project</dt>
        <dd>
          <span>{session.projectName ?? 'Not assigned to a project'}</span>
          <span className="ms-facts__note"> ({RESOLUTION_TEXT[session.projectResolution]})</span>
        </dd>
        {session.cwd ? (<><dt>Folder</dt><dd className="ms-mono ms-break">{session.cwd}</dd></>) : null}
        <dt>Environment</dt>
        <dd>{envLabel(session.env)}</dd>
        {session.lastActivityAt ? (<><dt>Last activity</dt><dd>{formatRelative(session.lastActivityAt)}</dd></>) : null}
      </dl>

      <div className="ms-observed__block">
        <h3 className="ms-observed__label">Why you cannot type here</h3>
        <p>{OBSERVED_WHY[kind]}</p>
      </div>
      <div className="ms-observed__block">
        <h3 className="ms-observed__label">Remote Control</h3>
        <p>{hint}</p>
      </div>

      <div className="ms-observed__actions">
        {canResume ? <Button variant="primary" icon="history" loading={resuming} onClick={onResume}>Resume in Mini-Summa</Button> : null}
        {session.availability === 'live' && session.resumable ? <p className="ms-observed__note">It is still running elsewhere. Close it there first to resume it here.</p> : null}
        <Menu
          label="Assign to project"
          trigger={(props) => (
            <Button ref={props.ref as (el: HTMLButtonElement | null) => void} icon="folder" iconEnd="chevron-down" aria-haspopup="menu" aria-expanded={props['aria-expanded']} onClick={props.onClick} onKeyDown={props.onKeyDown}>
              {session.projectId ? 'Move to another project' : 'Assign to project'}
            </Button>
          )}
          items={[
            ...choices.map((p) => ({ label: p.name, checked: p.id === session.projectId, radio: true, onSelect: () => { void assign(p); } })),
            ...(session.projectId ? [{ type: 'separator' as const }, { label: 'Remove from project', onSelect: () => { void assign(null); } }] : []),
          ]}
        />
      </div>
    </div>
  );
}
