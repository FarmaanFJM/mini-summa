import { createContext, useContext, useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

interface FieldContextValue { id: string; describedBy: string | undefined; invalid: boolean; required: boolean }
const FieldContext = createContext<FieldContextValue | null>(null);

/** Props every form control takes from the surrounding Field (id for the label, hint/error for assistive technology). */
export function useFieldControl(): { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-required'?: true } {
  const ctx = useContext(FieldContext);
  if (!ctx) return {};
  return {
    id: ctx.id,
    'aria-describedby': ctx.describedBy,
    'aria-invalid': ctx.invalid ? true : undefined,
    'aria-required': ctx.required ? true : undefined,
  };
}

export interface FieldProps {
  label: ReactNode;
  /** Only when it prevents a real mistake or states a format that cannot be guessed. */
  hint?: ReactNode;
  /** Replaces the hint. Say what is wrong and how to fix it. */
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
  /** Content aligned with the label on the right (for example a "Browse" link). */
  aside?: ReactNode;
}

/** Label, one control, optional hint or error. The control picks up its id and aria attributes through context. */
export function Field({ label, hint, error, required, children, className, aside }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const showError = error !== undefined && error !== null && error !== false && error !== '';
  const showHint = !showError && hint !== undefined && hint !== null && hint !== false && hint !== '';
  const ctx: FieldContextValue = { id, describedBy: showError || showHint ? noteId : undefined, invalid: showError, required: Boolean(required) };
  return (
    <div className={cx('ms-field', className)}>
      <div className="ms-field__head">
        <label htmlFor={id} className="ms-field__label">{label}</label>
        {aside ? <span className="ms-field__aside">{aside}</span> : null}
      </div>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {showError ? <p id={noteId} className="ms-field__error" role="alert">{error}</p> : null}
      {showHint ? <p id={noteId} className="ms-field__hint">{hint}</p> : null}
    </div>
  );
}

export type TextInputProps = ComponentPropsWithRef<'input'>;

export function TextInput({ className, ...rest }: TextInputProps) {
  const field = useFieldControl();
  return <input type="text" className={cx('sm-input', className)} {...field} {...rest} />;
}

export type TextAreaProps = ComponentPropsWithRef<'textarea'>;

export function TextArea({ className, rows = 3, ...rest }: TextAreaProps) {
  const field = useFieldControl();
  return <textarea rows={rows} className={cx('sm-input ms-textarea', className)} {...field} {...rest} />;
}

// ---------------------------------------------------------------------------------------------------------------

export interface SwitchProps extends Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'role' | 'children'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible text beside the switch. Without it, give the surrounding Field a label or pass aria-label. */
  label?: ReactNode;
}

/** On/off setting that applies at once. The on state is a light track, never emerald (P15). */
export function Switch({ checked, onChange, label, className, disabled, ...rest }: SwitchProps) {
  const field = useFieldControl();
  return (
    <span className={cx('ms-switch', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className="ms-switch__track"
        onClick={() => onChange(!checked)}
        {...field}
        {...rest}
      >
        <span className="ms-switch__thumb" />
      </button>
      {label ? <span className="ms-switch__label">{label}</span> : null}
    </span>
  );
}

interface ChoiceProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'onChange' | 'children'> {
  label?: ReactNode;
  onChange?: (checked: boolean) => void;
}

/** Checkbox with a visible boundary (the one control allowed an outline of its own). */
export function Checkbox({ label, className, onChange, ...rest }: ChoiceProps) {
  const field = useFieldControl();
  return (
    <label className={cx('ms-choice', className)}>
      <input type="checkbox" className="ms-choice__input" onChange={(e) => onChange?.(e.target.checked)} {...field} {...rest} />
      <span className="sm-check ms-choice__box" aria-hidden="true"><Icon name="check" size={14} style={{ strokeWidth: 3 }} /></span>
      {label ? <span className="ms-choice__label">{label}</span> : null}
    </label>
  );
}

/** A radio button for a group where exactly one option applies. */
export function Radio({ label, className, onChange, ...rest }: ChoiceProps) {
  return (
    <label className={cx('ms-choice ms-choice--radio', className)}>
      <input type="radio" className="ms-choice__input" onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      <span className="sm-check ms-choice__box" aria-hidden="true"><span className="ms-choice__dot" /></span>
      {label ? <span className="ms-choice__label">{label}</span> : null}
    </label>
  );
}
