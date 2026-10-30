import type { ReactNode } from 'react';
import { Icon, Spinner, Switch } from '../../ui';
import type { SaveState } from './useSettings';

/** Saving, saved, or why it failed. Quiet when nothing is happening. */
export function SaveStatus({ status }: { status: SaveState }) {
  if (status.state === 'idle') return <span className="ms-x-saving" aria-live="polite" />;
  if (status.state === 'saving') return <span className="ms-x-saving" role="status"><Spinner />Saving</span>;
  if (status.state === 'saved') return <span className="ms-x-saving" role="status"><Icon name="check" size={14} />Saved</span>;
  return <span className="ms-x-saving" data-state="failed" role="alert"><Icon name="circle-alert" size={14} />Could not save: {status.error}</span>;
}

export interface SwitchRowProps {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A label with what it does on the left and the switch on the right. */
export function SwitchRow({ label, hint, checked, onChange, disabled }: SwitchRowProps) {
  return (
    <div className="ms-x-row">
      <div className="ms-x-row__text">
        <span className="ms-x-row__label">{label}</span>
        {hint ? <span className="ms-x-row__hint">{hint}</span> : null}
      </div>
      <div className="ms-x-row__control"><Switch aria-label={label} checked={checked} onChange={onChange} disabled={disabled} /></div>
    </div>
  );
}

/** A titled group of settings. The title is the only heading level the page needs besides its own. */
export function Group({ title, note, children, actions }: { title: string; note?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="ms-set-group" aria-label={title}>
      <div className="ms-set-group__head">
        <h2 className="ms-set-group__title">{title}</h2>
        {actions}
      </div>
      {note ? <p className="ms-x-note ms-set-group__note">{note}</p> : null}
      <div className="ms-set-group__body">{children}</div>
    </section>
  );
}
