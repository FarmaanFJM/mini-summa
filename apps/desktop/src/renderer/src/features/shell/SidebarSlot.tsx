// A view can take over the sidebar instead of opening a second one beside it (P14): it renders <SidebarContent> and the
// shell swaps its project list for that content, with a back chevron at the top.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../../ui';

export interface SidebarSlotValue {
  /** The element the replacement content is portaled into. Null until the sidebar has mounted. */
  slot: HTMLElement | null;
  /** Called by a view that wants to replace the sidebar. Returns the function that gives it back. */
  claim(): () => void;
}

export const SidebarSlotContext = createContext<SidebarSlotValue | null>(null);

/**
 * The shell's side of the slot: it owns the element, counts how many views have claimed it, and says whether the project
 * list should step aside. `<Sidebar replaced={host.replaced} slotRef={host.setSlot} />` plus a provider with `host.value`.
 */
export function useSidebarSlotHost(): { value: SidebarSlotValue; replaced: boolean; setSlot: (el: HTMLElement | null) => void } {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => { setClaims((n) => n + 1); return () => setClaims((n) => n - 1); }, []);
  const value = useMemo(() => ({ slot, claim }), [slot, claim]);
  return { value, replaced: claims > 0, setSlot };
}

export interface SidebarContentProps {
  /** Heading shown beside the back chevron, for example "Settings". */
  title: string;
  /** Called by the back chevron. Typically `route.back()`. */
  onBack: () => void;
  backLabel?: string;
  children?: ReactNode;
}

/**
 * Replaces the sidebar's content while it is mounted. Render it from any view:
 *
 *   <SidebarContent title="Settings" onBack={() => route.back()}>...section list...</SidebarContent>
 */
export function SidebarContent({ title, onBack, backLabel = 'Back', children }: SidebarContentProps) {
  const ctx = useContext(SidebarSlotContext);
  const claim = ctx?.claim;
  useEffect(() => (claim ? claim() : undefined), [claim]);
  if (!ctx?.slot) return null;
  return createPortal(
    <div className="ms-sidebar__replacement">
      <header className="ms-sidebar__replacement-head">
        <IconButton label={backLabel} icon="chevron-left" size="sm" onClick={onBack} />
        <h2 className="ms-sidebar__replacement-title">{title}</h2>
      </header>
      <div className="ms-sidebar__replacement-body">{children}</div>
    </div>,
    ctx.slot,
  );
}
