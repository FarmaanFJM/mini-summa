import type { ReactNode } from 'react';
import { IconButton } from '../../ui';
import { useLayout } from '../shell/LayoutContext';
import { SidebarContent } from '../shell/SidebarSlot';

export interface SideNavigatorProps {
  title: string;
  onBack: () => void;
  /** Width of the column when the sidebar is only a narrow rail and the navigation has to live in the view itself. */
  width?: number;
  children?: ReactNode;
}

/**
 * The navigation of a view that takes over the sidebar (principle 14). It goes where the sidebar is, with the back chevron.
 *
 * When the sidebar is collapsed to its narrow rail there is no room for it there, so the same content becomes a column at the
 * left edge of the view, beside the rail. Nothing else changes: same items, same back button, still one list of places.
 */
export function SideNavigator({ title, onBack, width = 300, children }: SideNavigatorProps) {
  const { layout } = useLayout();
  if (!layout.sidebarCollapsed) return <SidebarContent title={title} onBack={onBack}>{children}</SidebarContent>;
  return (
    <aside className="ms-x-navcol" aria-label={title} style={{ width }}>
      <header className="ms-x-navcol__head">
        <IconButton label="Back" icon="chevron-left" size="sm" onClick={onBack} />
        <h2 className="ms-x-navcol__title">{title}</h2>
      </header>
      <div className="ms-x-navcol__body">{children}</div>
    </aside>
  );
}
