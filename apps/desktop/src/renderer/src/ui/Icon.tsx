import { createElement } from 'react';
import type { SVGProps } from 'react';
import { ICONS } from './icons.generated';
import type { IconName } from './icons.generated';
import { cx } from './cx';

export type { IconName } from './icons.generated';
export type IconSize = 14 | 16 | 18 | 20;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'ref'> {
  name: IconName;
  /** 14, 16 (default), 18 or 20, as the icon rules allow. */
  size?: IconSize;
}

/** Curated Lucide icon at the shared stroke weight. Decorative by default; pass `aria-label` for a meaningful one. */
export function Icon({ name, size = 16, className, ...rest }: IconProps) {
  const shapes = ICONS[name];
  const labelled = rest['aria-label'] !== undefined;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cx('sm-icon', className)}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {shapes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
