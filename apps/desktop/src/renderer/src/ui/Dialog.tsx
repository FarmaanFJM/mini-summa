import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { cx } from './cx';
import { Field, TextInput } from './Field';
import { useNativeOverlay } from './nativeOverlay';

// ---------------------------------------------------------------------------------------------------------------
// Stack of open dialogs: only the top one reacts to Esc and Tab, the ones below it are inert.

const stack: string[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const topId = () => stack[stack.length - 1] ?? null;

function setAppInert(on: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('root');
  if (!root) return;
  if (on) root.setAttribute('inert', ''); else root.removeAttribute('inert');
}

function useIsTop(id: string, open: boolean): boolean {
  const top = useSyncExternalStore(subscribe, topId, topId);
  return open && top === id;
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => !el.closest('[hidden], [inert]') && el.getAttribute('aria-hidden') !== 'true');
}

export interface DialogProps {
  open: boolean;
  /** Called for Esc, a click on the backdrop (unless disabled) and the Cancel path of wrappers. */
  onClose: () => void;
  /** The accessible name. Always visible: a dialog without a title is not allowed. */
  title: string;
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** alertdialog for destructive questions that must be answered. */
  role?: 'dialog' | 'alertdialog';
  /** Default true for dialog, false for alertdialog. */
  dismissOnBackdrop?: boolean;
  /** Where focus lands on open. Default: the first control in the body, then the footer. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** While true Esc and the backdrop do nothing (a save is running). */
  busy?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Modal dialog. Focus is trapped and restored, Esc closes the topmost one, the page behind is inert, and the native
 * ChatGPT view is hidden so the dialog is never drawn underneath it.
 */
export function Dialog({ open, onClose, title, description, size = 'md', role = 'dialog', dismissOnBackdrop, initialFocus, busy, children, footer, className }: DialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const surface = useRef<HTMLDivElement>(null);
  const isTop = useIsTop(id, open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useNativeOverlay(open);

  // Register on the stack, make the app inert, and put focus inside. Restore focus when the dialog goes away.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(id);
    if (stack.length === 1) setAppInert(true);
    emit();
    const el = surface.current;
    const target = initialFocus?.current
      ?? (el ? (tabbables(el.querySelector('.sm-dialog__body') as HTMLElement ?? el)[0] ?? tabbables(el)[0] ?? el) : null);
    target?.focus({ preventScroll: true });
    return () => {
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) setAppInert(false);
      emit();
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // initialFocus is read once on open on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id]);

  useEffect(() => {
    if (!open || !isTop) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isTop]);

  const onSurfaceKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !surface.current) return;
    const list = tabbables(surface.current);
    if (list.length === 0) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !surface.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !surface.current.contains(active))) { e.preventDefault(); first.focus(); }
  }, []);

  if (!open || typeof document === 'undefined') return null;
  const dismissible = dismissOnBackdrop ?? role === 'dialog';

  return createPortal(
    <div
      className="sm-backdrop"
      data-ms-layer="dialog"
      inert={!isTop}
      onMouseDown={(e) => { if (e.target === e.currentTarget && dismissible && !busy) onClose(); }}
    >
      <div
        ref={surface}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx('sm-dialog', `ms-dialog--${size}`, className)}
        onKeyDown={onSurfaceKeyDown}
      >
        <h2 id={titleId} className="sm-dialog__title">{title}</h2>
        {description ? <p id={descId} className="ms-dialog__desc">{description}</p> : null}
        <div className="sm-dialog__body ms-dialog__body">{children}</div>
        {footer ? <div className="sm-dialog__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  /** A verb that names the action: "Delete project", never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Solid destructive button, alertdialog role, focus starts on Cancel. */
  destructive?: boolean;
  /** Type-to-confirm: the confirm button stays disabled until this exact text is typed. */
  requireText?: string;
  busy?: boolean;
  /** An error from the last attempt, shown inside the dialog so it can be retried. */
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Extra content under the description, for example the list of what will be removed. */
  children?: ReactNode;
}

/** One decision, a clear verb, Cancel. Use it for hard-to-undo actions only; undoable ones get a toast with Undo. */
export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = 'Cancel', destructive, requireText, busy, error, onConfirm, onCancel, children }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!open) setTyped(''); }, [open]);
  const ready = !requireText || typed === requireText;
  const initialFocus = requireText ? inputRef : destructive ? cancelRef : confirmRef;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      role={destructive ? 'alertdialog' : 'dialog'}
      initialFocus={initialFocus}
      busy={busy}
      footer={(
        <>
          <Button ref={cancelRef} onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'primary'}
            icon={destructive ? 'trash' : undefined}
            loading={busy}
            disabled={!ready}
            onClick={() => { void onConfirm(); }}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {children}
      {requireText ? (
        <Field label={<>Type <strong className="ms-mono">{requireText}</strong> to confirm</>}>
          <TextInput
            ref={inputRef}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) { e.preventDefault(); void onConfirm(); } }}
          />
        </Field>
      ) : null}
      {error ? <p className="ms-dialog__error" role="alert">{error}</p> : null}
    </Dialog>
  );
}
