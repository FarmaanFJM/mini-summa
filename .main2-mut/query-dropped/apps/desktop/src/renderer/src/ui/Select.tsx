import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cx } from './cx';
import { useFieldControl } from './Field';
import { Icon } from './Icon';
import { Popover } from './Popover';
import type { PopoverDismissReason } from './Popover';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Secondary text under the label, for example a path. */
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T | null;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  /** Default: a search field appears above 7 options, as the dropdown preset says. */
  searchable?: boolean;
  disabled?: boolean;
  /** Plain text button without a filled background. */
  quiet?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

const SEARCH_THRESHOLD = 7;

/** A dropdown that stores a value (a menu runs commands). Same surface and keyboard model as Menu. */
export function Select<T extends string = string>({
  value, onChange, options, placeholder = 'Select', searchable, disabled, quiet, className, id: idProp, ...aria
}: SelectProps<T>) {
  const field = useFieldControl();
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const buffer = useRef({ text: '', timer: 0 as unknown as ReturnType<typeof setTimeout> });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const withSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const selected = options.find((o) => o.value === value) ?? null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.description ?? '').toLowerCase().includes(q)) : options;
  }, [options, query]);

  const items = () => Array.from(surface.current?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? []);
  const focusAt = (i: number) => {
    const list = items();
    if (list.length) list[(i + list.length) % list.length].focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    if (withSearch) { surface.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); return; }
    const current = surface.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    (current ?? items()[0])?.focus({ preventScroll: true });
    // Focus is chosen once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  const pick = (o: SelectOption<T>) => {
    if (o.disabled) return;
    onChange(o.value);
    close(true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const inSearch = (e.target as HTMLElement).tagName === 'INPUT';
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(inSearch ? 0 : index + 1); return;
      case 'ArrowUp': e.preventDefault(); focusAt(inSearch || index <= 0 ? -1 : index - 1); return;
      case 'Home': if (!inSearch) { e.preventDefault(); focusAt(0); } return;
      case 'End': if (!inSearch) { e.preventDefault(); focusAt(-1); } return;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); return;
      case 'Tab': close(false); return;
      case 'Enter':
        if (inSearch) { e.preventDefault(); const first = shown.find((o) => !o.disabled); if (first) pick(first); }
        return;
      default:
    }
    if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const b = buffer.current;
      b.text += e.key.toLowerCase();
      clearTimeout(b.timer);
      b.timer = setTimeout(() => { b.text = ''; }, 600);
      const hit = list.findIndex((el) => (el.textContent ?? '').trim().toLowerCase().startsWith(b.text));
      if (hit >= 0) focusAt(hit);
    }
  };

  const dismiss = (reason: PopoverDismissReason) => close(reason === 'escape');

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={idProp ?? field.id}
        className={cx('sm-select', quiet && 'sm-select--quiet', className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); setOpen(true); } }}
        {...aria}
      >
        <span className={cx('sm-select__value', !selected && 'sm-faint')}>{selected?.label ?? placeholder}</span>
        <Icon name="chevron-down" />
      </button>
      <Popover
        open={open}
        anchor={trigger.current}
        placement="bottom-start"
        matchAnchorWidth
        onDismiss={dismiss}
        surfaceRef={surface}
        id={listId}
        role="listbox"
        aria-label={aria['aria-label']}
        onKeyDown={onKeyDown}
      >
        {withSearch ? (
          <div className="sm-menu__search">
            <input
              className="sm-input"
              type="text"
              autoComplete="off"
              aria-label="Search options"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : null}
        <div className="sm-menu__list">
          {shown.length === 0 ? <div className="sm-menu__empty">No matches</div> : shown.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              disabled={o.disabled}
              className="sm-menu__item ms-option"
              onClick={() => pick(o)}
            >
              <span className="ms-option__text">
                <span className="sm-menu__label">{o.label}</span>
                {o.description ? <span className="ms-option__desc">{o.description}</span> : null}
              </span>
              {o.value === value ? <Icon name="check" className="sm-menu__check" /> : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
