import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Tooltip } from '../../ui';
import type { PaneName } from './layout';

export type WorkspaceView = 'split' | PaneName;

interface Option { id: WorkspaceView; label: string; tip: string }

/** The shortcuts are the ones the workspace has always had: Ctrl+Shift+Left (or Up) for ChatGPT, Ctrl+Shift+Right (or Down) for Claude. */
export const VIEW_OPTIONS: readonly Option[] = [
  { id: 'split', label: 'Split', tip: 'Both panes (press the same shortcut again)' },
  { id: 'chatgpt', label: 'ChatGPT', tip: 'Only ChatGPT (Ctrl+Shift+Left)' },
  { id: 'claude', label: 'Claude', tip: 'Only Claude (Ctrl+Shift+Right)' },
];

export const viewOf = (maximized: PaneName | null): WorkspaceView => maximized ?? 'split';
export const maximizedOf = (view: WorkspaceView): PaneName | null => (view === 'split' ? null : view);

export interface ViewSwitchProps {
  value: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}

/**
 * Which of the two panes the workspace shows: both, or one at the full size of the area. A choice among exclusive views that
 * are all visible at once, so a segmented control (a radio group: arrows move and choose). Choosing never closes or reloads
 * anything: the pane that is not shown stays where it is.
 */
export function ViewSwitch({ value, onChange }: ViewSwitchProps) {
  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = VIEW_OPTIONS.findIndex((o) => o.id === value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % VIEW_OPTIONS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + VIEW_OPTIONS.length) % VIEW_OPTIONS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = VIEW_OPTIONS.length - 1;
    if (next < 0 || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    onChange(VIEW_OPTIONS[next].id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className="ms-viewswitch" role="radiogroup" aria-label="Workspace view" onKeyDown={move}>
      {VIEW_OPTIONS.map((o) => {
        const checked = o.id === value;
        return (
          <Tooltip key={o.id} content={o.tip}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="ms-viewswitch__option"
              onClick={() => onChange(o.id)}
            >
              {o.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
