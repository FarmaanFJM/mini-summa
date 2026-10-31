import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { cx } from './cx';
import { useNativeOverlay } from './nativeOverlay';
import { clampRatio, DEFAULT_RATIO, MAX_RATIO, MIN_RATIO, ratioAfterKey, ratioFromPointer } from './splitMath';

const DIVIDER_PX = 9;

export interface SplitPaneProps {
  /** horizontal: panes side by side. vertical: first above second. */
  direction: 'horizontal' | 'vertical';
  /** Share of the space given to the first pane, 0.15 to 0.85. */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** Once per finished drag, key press or reset: the moment to persist. */
  onRatioCommit?: (ratio: number) => void;
  defaultRatio?: number;
  first: ReactNode;
  second: ReactNode;
  /** Show only this pane, at full size, and hide the divider. The other pane stays mounted, just not displayed. */
  only?: 'first' | 'second' | null;
  /** Accessible name of the divider. */
  label: string;
  /** Names used in the divider's spoken value, for example ["ChatGPT", "Claude"]. */
  names?: [string, string];
  className?: string;
}

/** Two panes and a divider that can be dragged, moved with the arrow keys and reset with a double click. */
export function SplitPane({ direction, ratio, onRatioChange, onRatioCommit, defaultRatio = DEFAULT_RATIO, first, second, only = null, label, names = ['First', 'Second'], className }: SplitPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // The ref answers "is a drag running" synchronously; the state only drives rendering.
  const dragRef = useRef(false);
  const latest = useRef(ratio);
  latest.current = clampRatio(ratio);

  // A drag over the native ChatGPT view would lose its pointer events to that view, so the view is hidden meanwhile.
  useNativeOverlay(dragging);

  const r = clampRatio(ratio);
  const template = only ? 'minmax(0, 1fr)' : `minmax(0, ${r}fr) ${DIVIDER_PX}px minmax(0, ${1 - r}fr)`;
  const style: CSSProperties = direction === 'horizontal' ? { gridTemplateColumns: template } : { gridTemplateRows: template };

  const set = (next: number, commit: boolean) => {
    const value = clampRatio(next);
    latest.current = value;
    onRatioChange(value);
    if (commit) onRatioCommit?.(value);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    dragRef.current = true;
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !container.current) return;
    const rect = container.current.getBoundingClientRect();
    const horizontal = direction === 'horizontal';
    set(ratioFromPointer(horizontal ? e.clientX - rect.left : e.clientY - rect.top, horizontal ? rect.width : rect.height, DIVIDER_PX), false);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
    onRatioCommit?.(latest.current);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); set(defaultRatio, true); return; }
    const next = ratioAfterKey(e.key, latest.current, direction, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    set(next, true);
  };

  const percent = Math.round(r * 100);
  return (
    <div ref={container} className={cx('ms-split', `ms-split--${direction}`, className)} style={style}>
      <div className="ms-split__pane" hidden={only === 'second'}>{first}</div>
      {only ? null : (
        <div
          role="separator"
          aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
          aria-label={label}
          aria-valuemin={Math.round(MIN_RATIO * 100)}
          aria-valuemax={Math.round(MAX_RATIO * 100)}
          aria-valuenow={percent}
          aria-valuetext={`${names[0]} ${percent} percent, ${names[1]} ${100 - percent} percent`}
          tabIndex={0}
          className={cx('ms-split__divider', dragging && 'is-dragging')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => set(defaultRatio, true)}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="ms-split__pane" hidden={only === 'first'}>{second}</div>
    </div>
  );
}
