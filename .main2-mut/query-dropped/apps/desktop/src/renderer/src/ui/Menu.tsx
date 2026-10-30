import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { Popover } from './Popover';
import type { PopoverDismissReason } from './Popover';
import type { Placement } from './popover';

export interface MenuItem {
  id?: string;
  label: string;
  icon?: IconName;
  /** A quiet second line under the label, for example why the item is disabled. Read as the item's description, not as part of its name. */
  description?: string;
  shortcut?: string;
  disabled?: boolean;
  /** Danger-coloured text plus icon, placed last after a separator (P19). */
  danger?: boolean;
  /** Present for check items (menuitemcheckbox); the check mark shows when true. */
  checked?: boolean;
  /** With `checked`: one of several exclusive choices (menuitemradio). */
  radio?: boolean;
  onSelect: () => void;
}
export interface MenuSeparator { type: 'separator' }
export interface MenuHeading { type: 'heading'; label: string }
export type MenuEntry = MenuItem | MenuSeparator | MenuHeading;

const isSeparator = (e: MenuEntry): e is MenuSeparator => 'type' in e && e.type === 'separator';
const isHeading = (e: MenuEntry): e is MenuHeading => 'type' in e && e.type === 'heading';

export interface MenuTriggerProps {
  ref: (el: HTMLElement | null) => void;
  onClick: (e: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
}

export interface MenuProps {
  /** Accessible name of the menu, for example "Project actions". */
  label: string;
  items: MenuEntry[];
  /** Renders the control that opens the menu. Omit for a context menu opened at `anchorPoint`. */
  trigger?: (props: MenuTriggerProps) => ReactNode;
  placement?: Placement;
  /** Controlled mode. Leave undefined to let the menu manage itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where a context menu opens. */
  anchorPoint?: { x: number; y: number } | null;
}

const ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)';

/**
 * Menu with the keyboard behaviour people already know: arrows, Home/End, type-ahead, Enter, Esc to close and return,
 * Tab to leave. Every action must also be reachable some other way than a right click (P16).
 */
export function Menu({ label, items, trigger, placement = 'bottom-start', open: controlledOpen, onOpenChange, anchorPoint }: MenuProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const menuId = useId();
  const triggerEl = useRef<HTMLElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const buffer = useRef({ text: '', timer: 0 as unknown as ReturnType<typeof setTimeout> });

  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);

  // Remember where focus was when the menu opened so it can go back there (context menus have no trigger).
  useEffect(() => {
    if (!open) return;
    returnTo.current = triggerEl.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, [open]);

  // Put focus on the first enabled item once the surface exists.
  useEffect(() => {
    if (!open) return;
    const first = surface.current?.querySelector<HTMLElement>(ITEM_SELECTOR);
    (first ?? surface.current)?.focus({ preventScroll: true });
  }, [open]);

  const restoreFocus = useCallback(() => {
    const el = returnTo.current;
    if (el && el.isConnected) el.focus({ preventScroll: true });
  }, []);

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) restoreFocus();
  }, [restoreFocus, setOpen]);

  const onDismiss = useCallback((reason: PopoverDismissReason) => close(reason === 'escape'), [close]);

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    // Focus goes back first so a dialog opened by the action remembers the right element to return to.
    close(true);
    item.onSelect();
  };

  const enabledItems = (): HTMLElement[] => Array.from(surface.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
  const focusAt = (index: number) => {
    const list = enabledItems();
    if (list.length === 0) return;
    list[(index + list.length) % list.length].focus({ preventScroll: true });
  };

  const onSurfaceKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = enabledItems();
    const index = list.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(index + 1); return;
      case 'ArrowUp': e.preventDefault(); focusAt(index < 0 ? -1 : index - 1); return;
      case 'Home': e.preventDefault(); focusAt(0); return;
      case 'End': e.preventDefault(); focusAt(-1); return;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); return;
      case 'Tab': close(false); return;
      default:
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const b = buffer.current;
      b.text += e.key.toLowerCase();
      clearTimeout(b.timer);
      b.timer = setTimeout(() => { b.text = ''; }, 600);
      const hit = list.findIndex((el) => (el.textContent ?? '').trim().toLowerCase().startsWith(b.text));
      if (hit >= 0) focusAt(hit);
    }
  };

  const triggerProps: MenuTriggerProps = {
    ref: (el) => { triggerEl.current = el; },
    onClick: () => setOpen(!open),
    onKeyDown: (e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); setOpen(true); } },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  };

  return (
    <>
      {trigger ? trigger(triggerProps) : null}
      <Popover
        open={open}
        anchor={anchorPoint ?? triggerEl.current}
        placement={placement}
        onDismiss={onDismiss}
        surfaceRef={surface}
        id={menuId}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onSurfaceKeyDown}
      >
        {items.map((entry, i) => {
          if (isSeparator(entry)) return <hr key={`sep-${i}`} className="sm-menu__sep" />;
          if (isHeading(entry)) return <div key={`head-${i}`} className="sm-menu__heading" role="presentation">{entry.label}</div>;
          const check = entry.checked !== undefined;
          const descriptionId = entry.description ? `${menuId}-description-${i}` : undefined;
          return (
            <button
              key={entry.id ?? `${entry.label}-${i}`}
              type="button"
              role={check ? (entry.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem'}
              aria-checked={check ? entry.checked : undefined}
              aria-describedby={descriptionId}
              tabIndex={-1}
              disabled={entry.disabled}
              className={cx('sm-menu__item', entry.description && 'ms-option', entry.danger && 'sm-menu__item--danger')}
              onClick={() => select(entry)}
            >
              {entry.icon ? <Icon name={entry.icon} /> : null}
              {entry.description ? (
                <span className="ms-option__text">
                  <span className="sm-menu__label">{entry.label}</span>
                  <span id={descriptionId} className="ms-option__desc" aria-hidden="true">{entry.description}</span>
                </span>
              ) : <span className="sm-menu__label">{entry.label}</span>}
              {entry.shortcut ? <span className="sm-menu__shortcut">{entry.shortcut}</span> : null}
              {entry.checked ? <Icon name="check" className="sm-menu__check" /> : null}
            </button>
          );
        })}
      </Popover>
    </>
  );
}
