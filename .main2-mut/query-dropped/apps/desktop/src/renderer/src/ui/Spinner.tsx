import { cx } from './cx';

export interface SpinnerProps {
  className?: string;
  /** Spoken label. Omit when the surrounding control already says it is busy. */
  label?: string;
}

/** Inline spinner for short actions. Use skeleton rows for content whose shape is known. */
export function Spinner({ className, label }: SpinnerProps) {
  return (
    <span className={cx('sm-spinner', className)} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
  );
}
