import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Plain-text description shown as the tooltip and used as the accessible name when the label is not text. */
  title?: string;
  /** Shown before the label (a status dot, an icon). */
  leading?: ReactNode;
  closable?: boolean;
  closeLabel?: string;
  onClose?: () => void;
}

export interface TabsProps {
  items: TabItem[];
  value: string | null;
  onChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Prefix for the tab ids ("<prefix>-tab-<id>"); the panel should use `tabPanelProps`. */
  idPrefix: string;
  /** Rendered after the last tab inside the scrolling row, for example the "+" menu. */
  trailing?: ReactNode;
  className?: string;
}

export const tabDomId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const panelDomId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

/** Attributes for the element that shows the selected tab's content. */
export function tabPanelProps(prefix: string, id: string): { id: string; role: 'tabpanel'; 'aria-labelledby': string; tabIndex: number } {
  return { id: panelDomId(prefix, id), role: 'tabpanel', 'aria-labelledby': tabDomId(prefix, id), tabIndex: -1 };
}

/**
 * Tab strip: roving tabindex, arrows move and select, Home/End jump, Delete closes a closable tab. The selected tab is a
 * quiet fill, not an underline or an accent (P15).
 */
export function Tabs({ items, value, onChange, label, idPrefix, trailing, className }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);

  // Keep the selected tab in view when the strip scrolls.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [value, items.length]);

  const focusTab = (id: string) => {
    list.current?.querySelector<HTMLElement>(`[id="${tabDomId(idPrefix, id)}"]`)?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, index: number) => {
    const last = items.length - 1;
    let next = -1;
    if (e.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Delete' && items[index].closable) { e.preventDefault(); items[index].onClose?.(); return; }
    if (next < 0) return;
    e.preventDefault();
    const target = items[next];
    onChange(target.id);
    focusTab(target.id);
  };

  return (
    <div className={cx('ms-tabs', className)} role="tablist" aria-label={label} ref={list}>
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <div key={item.id} role="presentation" className="ms-tab" data-selected={selected || undefined}>
            <button
              type="button"
              role="tab"
              id={tabDomId(idPrefix, item.id)}
              aria-selected={selected}
              aria-controls={panelDomId(idPrefix, item.id)}
              aria-label={item.title}
              title={item.title}
              tabIndex={selected || (value === null && index === 0) ? 0 : -1}
              className="ms-tab__main"
              onClick={() => onChange(item.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {item.leading}
              <span className="ms-tab__label">{item.label}</span>
            </button>
            {item.closable ? (
              <button
                type="button"
                className="ms-tab__close"
                tabIndex={-1}
                aria-label={item.closeLabel ?? 'Close tab'}
                title={item.closeLabel ?? 'Close tab'}
                onClick={(e) => { e.stopPropagation(); item.onClose?.(); }}
              >
                <Icon name="x" size={14} />
              </button>
            ) : null}
          </div>
        );
      })}
      {trailing}
    </div>
  );
}
