// Small presentational pieces: Tag, EmptyState, Section, Kbd.
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface TagProps {
  children: ReactNode;
  icon?: IconName;
  /** Renders a button. Tags exist only where people filter, group or act on a category or state (P04). */
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}

/** One background, no border, short text. Not for decoration. */
export function Tag({ children, icon, onClick, selected, className }: TagProps) {
  const body = (<>{icon ? <Icon name={icon} size={14} /> : null}<span>{children}</span></>);
  if (onClick) {
    return <button type="button" className={cx('ms-tag', 'ms-tag--action', className)} aria-pressed={selected} onClick={onClick}>{body}</button>;
  }
  return <span className={cx('ms-tag', className)}>{body}</span>;
}

export interface EmptyStateProps {
  /** One statement of why the region is empty. */
  children: ReactNode;
  /** At most one action, the one most people want. */
  action?: ReactNode;
  /** Use role=alert for load errors. */
  tone?: 'neutral' | 'error';
  center?: boolean;
  className?: string;
}

/** Words, not illustrations: why it is empty and, if there is a sensible next step, exactly one action. */
export function EmptyState({ children, action, tone = 'neutral', center, className }: EmptyStateProps) {
  return (
    <div className={cx('sm-empty', center && 'sm-empty--center', className)} role={tone === 'error' ? 'alert' : undefined}>
      <p className="sm-empty__text">{children}</p>
      {action}
    </div>
  );
}

export interface SectionProps {
  title: string;
  /** Controls aligned with the heading. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Heading level, default 2. */
  level?: 2 | 3;
}

/** A heading with content that starts at the same left edge (the rectangle rule, P11). */
export function Section({ title, actions, children, className, level = 2 }: SectionProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className={cx('ms-section', className)}>
      <div className="ms-section__head">
        <Heading className="ms-section__title">{title}</Heading>
        {actions ? <div className="ms-section__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A keyboard key, for hints like "Ctrl K". */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx('ms-kbd', className)}>{children}</kbd>;
}
