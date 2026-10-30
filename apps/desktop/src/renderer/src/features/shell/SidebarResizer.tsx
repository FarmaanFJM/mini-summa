import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useNativeOverlay } from '../../ui/nativeOverlay';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 520;
export const SIDEBAR_DEFAULT = 260;

export const clampSidebar = (width: number): number => (Number.isFinite(width) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width))) : SIDEBAR_DEFAULT);

interface Props { width: number; onChange: (width: number) => void }

/** The edge between the sidebar and the workspace: drag it, or focus it and use the arrow keys. Double click resets. */
export function SidebarResizer({ width, onChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);
  useNativeOverlay(dragging); // a drag across the native ChatGPT view would lose its pointer events

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    active.current = true;
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    onChange(clampSidebar(e.clientX - left));
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    active.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === 'ArrowLeft') onChange(clampSidebar(width - step));
    else if (e.key === 'ArrowRight') onChange(clampSidebar(width + step));
    else if (e.key === 'Home') onChange(SIDEBAR_MIN);
    else if (e.key === 'End') onChange(SIDEBAR_MAX);
    else if (e.key === 'Enter') onChange(SIDEBAR_DEFAULT);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className={`ms-sidebar-resizer${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onChange(SIDEBAR_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
}
