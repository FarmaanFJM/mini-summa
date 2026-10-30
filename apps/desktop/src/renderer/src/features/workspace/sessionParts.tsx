// Small pieces every session view shares: the state dot, and the banner that says where typing goes.
import type { ReactNode } from 'react';
import type { SessionView } from '@minisumma/shared';
import { useApp } from '../../app/runtime';
import { cx, Icon } from '../../ui';
import { describeInputTarget, dotTone } from './sessionModel';

/** A status dot. The words always sit beside it; colour is never the only carrier of meaning. */
export function StateDot({ session, className }: { session: Pick<SessionView, 'state' | 'availability'>; className?: string }) {
  return <span className={cx('ms-dot', 'ms-live', className)} data-tone={dotTone(session)} aria-hidden="true" />;
}

export interface InputBannerProps {
  session: SessionView;
  projectName: string | null;
  /** Controls at the right end (the session menu). */
  actions?: ReactNode;
}

/**
 * The persistent line above the terminal. It names the project, the session and how the session was started, so it is
 * never unclear which session a keystroke will reach, and it says plainly when none will.
 */
export function InputBanner({ session, projectName, actions }: InputBannerProps) {
  const live = useApp((s) => s.connection === 'live');
  const target = describeInputTarget(session, projectName, live);
  const lead = target.kind === 'managed' ? 'Input goes to:' : null;
  const rest = lead ? target.text.slice(lead.length).trimStart() : target.text;
  return (
    <div className="ms-input" data-kind={target.kind}>
      <p className="ms-input__text" title={target.text}>
        {target.kind !== 'managed' ? <><Icon name="ban" size={14} className="ms-input__icon" />{' '}</> : null}
        {lead ? <><span className="ms-input__lead">{lead}</span>{' '}</> : null}
        <span className="ms-input__target">{rest}</span>
      </p>
      <span className="ms-input__state">
        <StateDot session={session} />
        <span className="ms-input__label ms-live">{live ? session.stateLabel : `Last known: ${session.stateLabel}`}</span>
      </span>
      {actions}
    </div>
  );
}
