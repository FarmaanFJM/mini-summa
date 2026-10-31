import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';
import type { IconName, IconSize } from './Icon';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';
import type { Placement } from './popoverPosition';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'destructive-quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** primary is the single main action of a view (emerald). destructive is solid and needs a verb label. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps the label, replaces the icon with a spinner and ignores presses. */
  loading?: boolean;
  icon?: IconName;
  iconEnd?: IconName;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string | false> = {
  primary: 'sm-btn--primary',
  secondary: false,
  ghost: 'sm-btn--ghost',
  destructive: 'sm-btn--danger',
  'destructive-quiet': 'sm-btn--danger-quiet',
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, iconEnd, children, className, disabled, type = 'button', onClick, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('sm-btn', VARIANT_CLASS[variant], size === 'lg' && 'sm-btn--lg', size === 'sm' && 'ms-btn--sm', className)}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? undefined : onClick}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children != null && children !== false ? <span className="ms-btn__label">{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> {
  /** Required: the accessible name, also shown as the tooltip. */
  label: string;
  icon: IconName;
  size?: 'sm' | 'md';
  iconSize?: IconSize;
  /** Toggle buttons: sets aria-pressed. */
  pressed?: boolean;
  tooltip?: boolean;
  tooltipPlacement?: Placement;
}

export function IconButton({ label, icon, size = 'md', iconSize, pressed, tooltip = true, tooltipPlacement, className, type = 'button', ...rest }: IconButtonProps) {
  const button = (
    <button
      type={type}
      className={cx('sm-icon-btn', size === 'sm' && 'sm-icon-btn--sm', className)}
      aria-label={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
  return tooltip ? <Tooltip content={label} placement={tooltipPlacement}>{button}</Tooltip> : button;
}
